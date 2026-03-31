/**
 * Transaction Pipeline
 *
 * The ONLY path for transactions to reach the Solana network.
 *
 * Steps (strict order):
 *   1. Receive base64 transaction from API (co-signed)
 *   2. Deserialize into VersionedTransaction
 *   3. Validate instruction program IDs against whitelist
 *   4. Freeze instructions (prevent mutation after validation)
 *   5. Sign with local keypair
 *   6. Simulate transaction (preflight check)
 *   7. Send via RPC (sendRawTransaction)
 *   8. Confirm with polling + periodic resend
 *   9. Return signature
 *
 * Safety:
 *   - Program whitelist prevents signing malicious transactions
 *   - Simulation catches on-chain errors before broadcast
 *   - Dedup cache prevents double-sends
 *   - Trade mutex prevents concurrent transactions
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
  SendTransactionError,
} from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import type { FlashXConfig } from '../types/index.js';

// ─── Program Whitelist ──────────────────────────────────────────────────────

const SYSTEM_PROGRAMS = new Set([
  '11111111111111111111111111111111',            // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token Program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
  'ComputeBudget111111111111111111111111111111',   // Compute Budget
  'Ed25519SigVerify111111111111111111111111111',    // Ed25519 (backup oracle)
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
  'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn',  // Flash Trade (mainnet)
  'FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4',  // Flash Trade (devnet)
]);

function validatePrograms(tx: VersionedTransaction): void {
  const accountKeys = tx.message.staticAccountKeys;
  const ixs = tx.message.compiledInstructions;

  for (const ix of ixs) {
    const programId = accountKeys[ix.programIdIndex].toBase58();
    if (!SYSTEM_PROGRAMS.has(programId)) {
      throw new Error(
        `BLOCKED: Unknown program ${programId.slice(0, 8)}... in transaction. ` +
        `Only whitelisted Flash Trade and Solana system programs are allowed.`
      );
    }
  }
}

// ─── Signature Dedup Cache ──────────────────────────────────────────────────

interface DedupEntry {
  signature: string;
  timestamp: number;
}

class SignatureCache {
  private cache = new Map<string, DedupEntry>();
  private ttlMs = 60_000; // 60s — matches blockhash lifetime

  check(key: string): DedupEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  store(key: string, signature: string): void {
    // Bound cache size
    if (this.cache.size >= 100) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { signature, timestamp: Date.now() });
  }
}

// ─── Trade Mutex ────────────────────────────────────────────────────────────

class TradeMutex {
  private locks = new Set<string>();

  async acquire(key: string): Promise<void> {
    if (this.locks.has(key)) {
      throw new Error(`Trade already in progress: ${key}`);
    }
    this.locks.add(key);
  }

  release(key: string): void {
    this.locks.delete(key);
  }
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

export interface TxPipelineResult {
  success: boolean;
  signature?: string;
  error?: string;
}

export class TxPipeline {
  private dedup = new SignatureCache();
  private mutex = new TradeMutex();
  private connection: Connection;

  constructor(
    connection: Connection,
    config: FlashXConfig,
  ) {
    this.connection = connection;
    // Config will be used for compute budget, retry tuning in later phases
    void config;
  }

  /**
   * Execute the full transaction pipeline:
   *   base64 → deserialize → validate → sign → simulate → send → confirm
   */
  async execute(
    txBase64: string,
    keypair: Keypair,
    tradeKey: string,
  ): Promise<TxPipelineResult> {
    const log = getLogger();

    // 1. Check dedup cache
    const cached = this.dedup.check(tradeKey);
    if (cached) {
      log.warn('TX', `Dedup hit for ${tradeKey} — returning cached signature`);
      return { success: true, signature: cached.signature };
    }

    // 2. Acquire trade mutex
    await this.mutex.acquire(tradeKey);

    try {
      // 3. Deserialize
      log.info('TX', 'Deserializing transaction...');
      const txBuffer = Buffer.from(txBase64, 'base64');
      const tx = VersionedTransaction.deserialize(txBuffer);

      // 4. Validate programs
      log.info('TX', 'Validating instruction programs...');
      validatePrograms(tx);

      // 5. Freeze message (prevent mutation after validation)
      Object.freeze(tx.message);

      // 6. Sign
      log.info('TX', 'Signing transaction...');
      tx.sign([keypair]);

      // 7. Simulate
      log.info('TX', 'Simulating transaction...');
      const simResult = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
      });

      if (simResult.value.err) {
        const errStr = JSON.stringify(simResult.value.err);
        log.error('TX', `Simulation failed: ${errStr}`);

        // Extract logs for debugging
        const logs = simResult.value.logs?.slice(-5).join('\n  ') ?? 'No logs';
        return {
          success: false,
          error: `Transaction simulation failed: ${errStr}\n  ${logs}`,
        };
      }
      log.success('TX', `Simulation passed (${simResult.value.unitsConsumed ?? '?'} CU)`);

      // 8. Send
      log.info('TX', 'Sending transaction...');
      const signature = await this.connection.sendRawTransaction(
        tx.serialize(),
        {
          skipPreflight: true, // we already simulated
          maxRetries: 3,
          preflightCommitment: 'confirmed',
        },
      );

      log.info('TX', `Sent: ${signature.slice(0, 16)}...`);
      this.dedup.store(tradeKey, signature);

      // 9. Confirm
      log.info('TX', 'Confirming...');
      const confirmed = await this.confirmWithRetry(signature, tx);

      if (!confirmed) {
        log.warn('TX', 'Confirmation timeout — checking status...');
        // Check if it landed despite timeout
        const status = await this.checkSignatureStatus(signature);
        if (status) {
          log.success('TX', `Confirmed (delayed): ${signature.slice(0, 16)}...`);
          return { success: true, signature };
        }
        return {
          success: false,
          signature,
          error: 'Transaction sent but not confirmed within timeout. Signature: ' + signature,
        };
      }

      log.success('TX', `Confirmed: ${signature.slice(0, 16)}...`);
      return { success: true, signature };

    } catch (error) {
      const msg = error instanceof SendTransactionError
        ? `Send failed: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
      log.error('TX', msg);
      return { success: false, error: msg };

    } finally {
      this.mutex.release(tradeKey);
    }
  }

  // ─── Confirmation ─────────────────────────────────────────────────────

  private async confirmWithRetry(
    signature: string,
    tx: VersionedTransaction,
    timeoutMs = 45_000,
    resendIntervalMs = 10_000,
  ): Promise<boolean> {
    const log = getLogger();
    const start = Date.now();
    let lastResend = start;

    while (Date.now() - start < timeoutMs) {
      // Check status
      const status = await this.checkSignatureStatus(signature);
      if (status) return true;

      // Periodic resend
      if (Date.now() - lastResend > resendIntervalMs) {
        log.debug('TX', 'Resending transaction...');
        try {
          await this.connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 1,
          });
        } catch {
          // Ignore resend errors
        }
        lastResend = Date.now();
      }

      // Poll interval
      await new Promise(r => setTimeout(r, 2_000));
    }

    return false;
  }

  private async checkSignatureStatus(signature: string): Promise<boolean> {
    try {
      const statuses = await this.connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];
      if (status && status.confirmationStatus) {
        if (status.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        }
        return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('failed on-chain')) throw e;
      // Ignore transient RPC errors during polling
    }
    return false;
  }
}

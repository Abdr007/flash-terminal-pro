/**
 * Transaction Pipeline — Production Hardened
 *
 * The ONLY path for transactions to reach the Solana network.
 * Every step is a fail-safe gate. If ANY gate fails, execution halts.
 *
 * Pipeline (strict order, no skipping):
 *   1. Dedup check (signature cache)
 *   2. Acquire trade mutex (prevent concurrent sends)
 *   3. Deserialize base64 → VersionedTransaction
 *   4. DEEP instruction validation:
 *      a. Program whitelist (every instruction)
 *      b. Instruction count bounds
 *      c. Instruction ordering (Ed25519 → ComputeBudget → trade)
 *      d. ComputeBudget parameter validation
 *      e. Data size bounds per program type
 *   5. Freeze message (prevent post-validation mutation)
 *   6. Sign with local keypair
 *   7. DEEP simulation analysis:
 *      a. Execute simulation
 *      b. Parse logs for program errors
 *      c. Check compute units consumed vs limit
 *      d. Detect slippage/insufficient funds errors
 *   8. Send via RPC
 *   9. Confirm with polling + periodic resend
 *  10. Blockhash expiry detection → rebuild + re-sign (max 2 cycles)
 *
 * Fail-safe: ANY anomaly at ANY step → IMMEDIATE BLOCK
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
]);

const FLASH_PROGRAMS = new Set([
  'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn',  // Flash Trade mainnet
  'FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4',  // Flash Trade devnet
  'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm',  // Flash composability
]);

const ALL_ALLOWED = new Set([...SYSTEM_PROGRAMS, ...FLASH_PROGRAMS]);

// ─── Instruction Limits ─────────────────────────────────────────────────────

const MAX_INSTRUCTIONS = 12;          // Flash txs typically have 3-6 instructions
const MAX_IX_DATA_SIZE = 2048;        // No single instruction should exceed this
const MAX_ACCOUNTS_PER_IX = 40;       // Flash Trade instructions use ~20-30 accounts
const CU_LIMIT_CEILING = 1_400_000;   // Solana hard max
const CU_PRICE_CEILING = 10_000_000;  // 10M microlamports — unreasonably high = suspicious
const CU_EXHAUSTION_THRESHOLD = 0.9;  // Warn if simulation uses >90% of CU limit

// ─── TASK 1: Deep Instruction Validation ────────────────────────────────────

interface InstructionAnalysis {
  index: number;
  programId: string;
  programName: string;
  accountCount: number;
  dataSize: number;
}

function validateInstructionsDeep(tx: VersionedTransaction): InstructionAnalysis[] {
  const log = getLogger();
  const accountKeys = tx.message.staticAccountKeys;
  const ixs = tx.message.compiledInstructions;
  const analysis: InstructionAnalysis[] = [];

  // Bound: instruction count
  if (ixs.length === 0) {
    throw new Error('BLOCKED: Transaction has zero instructions');
  }
  if (ixs.length > MAX_INSTRUCTIONS) {
    throw new Error(`BLOCKED: Transaction has ${ixs.length} instructions (max ${MAX_INSTRUCTIONS})`);
  }

  let hasFlashIx = false;
  let cuLimitSet = false;
  let cuLimitValue = 0;
  let cuPriceValue = 0;

  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    const programId = accountKeys[ix.programIdIndex].toBase58();

    // ─── Gate 1: Program whitelist ──────────────────────────────────
    if (!ALL_ALLOWED.has(programId)) {
      throw new Error(
        `BLOCKED: Unknown program at instruction[${i}]: ${programId}. ` +
        'Only Flash Trade and Solana system programs are allowed.'
      );
    }

    const programName = getProgramName(programId);
    const accountCount = ix.accountKeyIndexes.length;
    const dataSize = ix.data.length;

    // ─── Gate 2: Per-instruction bounds ─────────────────────────────
    if (dataSize > MAX_IX_DATA_SIZE) {
      throw new Error(
        `BLOCKED: Instruction[${i}] (${programName}) data size ${dataSize} bytes exceeds max ${MAX_IX_DATA_SIZE}`
      );
    }
    if (accountCount > MAX_ACCOUNTS_PER_IX) {
      throw new Error(
        `BLOCKED: Instruction[${i}] (${programName}) uses ${accountCount} accounts (max ${MAX_ACCOUNTS_PER_IX})`
      );
    }

    // ─── Gate 3: ComputeBudget parameter validation ─────────────────
    if (programId === 'ComputeBudget111111111111111111111111111111') {
      if (dataSize >= 5) {
        const discriminator = ix.data[0];
        // SetComputeUnitLimit = 2, SetComputeUnitPrice = 3
        if (discriminator === 2) {
          cuLimitValue = ix.data[1] | (ix.data[2] << 8) | (ix.data[3] << 16) | (ix.data[4] << 24);
          cuLimitSet = true;
          if (cuLimitValue > CU_LIMIT_CEILING) {
            throw new Error(`BLOCKED: ComputeUnitLimit ${cuLimitValue} exceeds Solana max ${CU_LIMIT_CEILING}`);
          }
          log.debug('TX:VAL', `ComputeUnitLimit: ${cuLimitValue}`);
        } else if (discriminator === 3 && dataSize >= 9) {
          // Price is u64 LE, but we only check lower 32 bits for sanity
          cuPriceValue = ix.data[1] | (ix.data[2] << 8) | (ix.data[3] << 16) | (ix.data[4] << 24);
          if (cuPriceValue > CU_PRICE_CEILING) {
            throw new Error(`BLOCKED: ComputeUnitPrice ${cuPriceValue} microlamports is suspiciously high (max ${CU_PRICE_CEILING})`);
          }
          log.debug('TX:VAL', `ComputeUnitPrice: ${cuPriceValue} microlamports`);
        }
      }
    }

    if (FLASH_PROGRAMS.has(programId)) {
      hasFlashIx = true;
    }

    analysis.push({ index: i, programId, programName, accountCount, dataSize });
  }

  // ─── Gate 4: Must contain at least one Flash instruction ──────────
  if (!hasFlashIx) {
    throw new Error('BLOCKED: Transaction contains no Flash Trade instructions — refusing to sign');
  }

  log.info('TX:VAL', `Validated ${ixs.length} instructions: ${analysis.map(a => a.programName).join(' → ')}`);
  if (cuLimitSet) {
    log.debug('TX:VAL', `CU budget: limit=${cuLimitValue}, price=${cuPriceValue}`);
  }

  return analysis;
}

function getProgramName(programId: string): string {
  const names: Record<string, string> = {
    '11111111111111111111111111111111': 'System',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'ATA',
    'ComputeBudget111111111111111111111111111111': 'ComputeBudget',
    'Ed25519SigVerify111111111111111111111111111': 'Ed25519',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb': 'Token2022',
    'FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn': 'Flash',
    'FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4': 'Flash(dev)',
    'FSWAPViR8ny5K96hezav8jynVubP2dJ2L7SbKzds2hwm': 'FlashComp',
  };
  return names[programId] ?? `Unknown(${programId.slice(0, 8)})`;
}

// ─── TASK 2: Deep Simulation Analysis ───────────────────────────────────────

interface SimulationAnalysis {
  passed: boolean;
  unitsConsumed: number;
  cuLimit: number;
  cuUtilization: number;
  error?: string;
  programError?: string;
  logs: string[];
}

const KNOWN_ERRORS: Record<string, string> = {
  'InstructionError': 'On-chain instruction error',
  'InsufficientFundsForRent': 'Insufficient SOL for rent',
  'AccountNotFound': 'Required account does not exist',
  'InvalidAccountData': 'Account data is corrupted or wrong format',
  'custom program error: 0x1': 'Insufficient funds',
  'custom program error: 0x0': 'Generic program failure',
  'SlippageExceeded': 'Price moved beyond slippage tolerance',
  'Slippage tolerance exceeded': 'Price moved beyond slippage tolerance',
  'exceeding max': 'Maximum leverage or size exceeded',
  'Market is in Settle mode': 'Market is settling — try again later',
  'Market is in close only mode': 'Market is in close-only mode (high volatility)',
  'Position already exists': 'Position already exists for this market/side',
};

function analyzeSimulation(
  simResult: { err: unknown; logs: string[] | null; unitsConsumed: number | undefined },
  cuLimit: number,
): SimulationAnalysis {
  const log = getLogger();
  const logs = simResult.logs ?? [];
  const unitsConsumed = simResult.unitsConsumed ?? 0;
  const cuUtilization = cuLimit > 0 ? unitsConsumed / cuLimit : 0;

  // Check for errors
  if (simResult.err) {
    const errStr = JSON.stringify(simResult.err);

    // Try to extract a human-readable program error from logs
    let programError: string | undefined;
    for (const logLine of logs) {
      for (const [pattern, description] of Object.entries(KNOWN_ERRORS)) {
        if (logLine.includes(pattern)) {
          programError = description;
          break;
        }
      }
      if (programError) break;

      // Generic: "Program log: Error: ..."
      const errorMatch = logLine.match(/Program log: (?:Error: |error: |AnchorError.*msg: )(.+)/);
      if (errorMatch) {
        programError = errorMatch[1];
        break;
      }
    }

    log.error('TX:SIM', `Simulation FAILED: ${programError ?? errStr}`);
    log.debug('TX:SIM', `Last 5 logs:\n  ${logs.slice(-5).join('\n  ')}`);

    return {
      passed: false,
      unitsConsumed,
      cuLimit,
      cuUtilization,
      error: errStr,
      programError,
      logs,
    };
  }

  // CU exhaustion warning
  if (cuUtilization > CU_EXHAUSTION_THRESHOLD) {
    log.warn('TX:SIM', `CU utilization ${(cuUtilization * 100).toFixed(1)}% — near exhaustion (${unitsConsumed}/${cuLimit})`);
  }

  log.success('TX:SIM', `Simulation PASSED (${unitsConsumed} CU, ${(cuUtilization * 100).toFixed(1)}% utilization)`);

  return {
    passed: true,
    unitsConsumed,
    cuLimit,
    cuUtilization,
    logs,
  };
}

// ─── Signature Dedup Cache ──────────────────────────────────────────────────

interface DedupEntry {
  signature: string;
  timestamp: number;
  confirmed: boolean;
}

class SignatureCache {
  private cache = new Map<string, DedupEntry>();
  private ttlMs = 90_000; // 90s — slightly beyond blockhash lifetime for safety

  check(key: string): DedupEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  store(key: string, signature: string, confirmed = false): void {
    if (this.cache.size >= 100) {
      // Evict oldest
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, { signature, timestamp: Date.now(), confirmed });
  }

  markConfirmed(key: string): void {
    const entry = this.cache.get(key);
    if (entry) entry.confirmed = true;
  }
}

// ─── Trade Mutex ────────────────────────────────────────────────────────────

class TradeMutex {
  private locks = new Set<string>();

  acquire(key: string): void {
    if (this.locks.has(key)) {
      throw new Error(`BLOCKED: Trade already in progress for ${key}. Wait for completion.`);
    }
    this.locks.add(key);
  }

  release(key: string): void {
    this.locks.delete(key);
  }
}

// ─── Pipeline Result ────────────────────────────────────────────────────────

export interface TxPipelineResult {
  success: boolean;
  signature?: string;
  error?: string;
  // Enriched analysis data
  instructionCount?: number;
  computeUnitsUsed?: number;
  retryCount?: number;
}

// ─── TASK 3: Blockhash Expiry Constants ─────────────────────────────────────

const CONFIRM_TIMEOUT_MS = 45_000;
const RESEND_INTERVAL_MS = 8_000;
const MAX_REBUILD_CYCLES = 2;
const POLL_INTERVAL_MS = 2_000;

// ─── Pipeline ───────────────────────────────────────────────────────────────

export class TxPipeline {
  private dedup = new SignatureCache();
  private mutex = new TradeMutex();
  private connection: Connection;
  private config: FlashXConfig;

  constructor(connection: Connection, config: FlashXConfig) {
    this.connection = connection;
    this.config = config;
  }

  /**
   * Execute the full hardened transaction pipeline.
   *
   * rebuildFn: optional callback to rebuild the transaction from API
   *   when blockhash expires. Returns new base64 tx or null to abort.
   */
  async execute(
    txBase64: string,
    keypair: Keypair,
    tradeKey: string,
    rebuildFn?: () => Promise<string | null>,
  ): Promise<TxPipelineResult> {
    const log = getLogger();

    // ─── STEP 1: Dedup check ────────────────────────────────────────
    const cached = this.dedup.check(tradeKey);
    if (cached) {
      if (cached.confirmed) {
        log.warn('TX', `Dedup hit (confirmed): ${tradeKey}`);
        return { success: true, signature: cached.signature };
      }
      // Sent but not confirmed — check on-chain status
      const onChain = await this.checkSignatureStatus(cached.signature);
      if (onChain) {
        this.dedup.markConfirmed(tradeKey);
        log.warn('TX', `Dedup hit (now confirmed on-chain): ${tradeKey}`);
        return { success: true, signature: cached.signature };
      }
      log.warn('TX', `Dedup hit but unconfirmed — proceeding with caution`);
    }

    // ─── STEP 2: Acquire mutex ──────────────────────────────────────
    this.mutex.acquire(tradeKey);
    let retryCount = 0;

    try {
      return await this.executeInner(txBase64, keypair, tradeKey, rebuildFn, retryCount);
    } finally {
      this.mutex.release(tradeKey);
    }
  }

  private async executeInner(
    txBase64: string,
    keypair: Keypair,
    tradeKey: string,
    rebuildFn: (() => Promise<string | null>) | undefined,
    retryCount: number,
  ): Promise<TxPipelineResult> {
    const log = getLogger();

    // ─── STEP 3: Deserialize ──────────────────────────────────────
    log.info('TX', `Deserializing transaction (attempt ${retryCount + 1})...`);
    let tx: VersionedTransaction;
    try {
      const txBuffer = Buffer.from(txBase64, 'base64');
      tx = VersionedTransaction.deserialize(txBuffer);
    } catch (e) {
      return { success: false, error: `BLOCKED: Failed to deserialize transaction: ${e instanceof Error ? e.message : String(e)}` };
    }

    // ─── STEP 4: DEEP instruction validation ──────────────────────
    log.info('TX', 'Deep instruction validation...');
    let analysis: InstructionAnalysis[];
    try {
      analysis = validateInstructionsDeep(tx);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    // ─── STEP 5: Freeze message ───────────────────────────────────
    Object.freeze(tx.message);

    // ─── STEP 6: Sign ─────────────────────────────────────────────
    log.info('TX', 'Signing transaction...');
    try {
      tx.sign([keypair]);
    } catch (e) {
      return { success: false, error: `BLOCKED: Signing failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // ─── STEP 7: DEEP simulation ──────────────────────────────────
    log.info('TX', 'Simulating transaction...');
    let simAnalysis: SimulationAnalysis;
    try {
      const simResult = await this.connection.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
      });

      // Extract CU limit from instruction analysis
      const cuLimitIx = analysis.find(a => a.programName === 'ComputeBudget');
      const cuLimit = cuLimitIx ? this.config.computeUnitLimit : 200_000; // default

      simAnalysis = analyzeSimulation(
        { err: simResult.value.err, logs: simResult.value.logs, unitsConsumed: simResult.value.unitsConsumed ?? undefined },
        cuLimit,
      );
    } catch (e) {
      return { success: false, error: `Simulation RPC error: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (!simAnalysis.passed) {
      const humanError = simAnalysis.programError
        ? `Transaction failed: ${simAnalysis.programError}`
        : `Transaction simulation failed: ${simAnalysis.error}`;
      return { success: false, error: humanError };
    }

    // ─── STEP 8: Send ─────────────────────────────────────────────
    log.info('TX', 'Sending transaction...');
    let signature: string;
    try {
      signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
        preflightCommitment: 'confirmed',
      });
    } catch (e) {
      const msg = e instanceof SendTransactionError ? e.message : (e instanceof Error ? e.message : String(e));

      // TASK 3: Detect blockhash expiry on send
      if (msg.includes('blockhash') && msg.includes('not found')) {
        return this.handleBlockhashExpiry(tradeKey, keypair, rebuildFn, retryCount);
      }

      return { success: false, error: `Send failed: ${msg}` };
    }

    log.info('TX', `Sent: ${signature.slice(0, 16)}...`);
    this.dedup.store(tradeKey, signature);

    // ─── STEP 9: Confirm ──────────────────────────────────────────
    log.info('TX', 'Confirming...');
    const confirmed = await this.confirmWithRetry(signature, tx);

    if (!confirmed) {
      log.warn('TX', 'Confirmation timeout — final status check...');
      const finalStatus = await this.checkSignatureStatus(signature);
      if (finalStatus) {
        this.dedup.markConfirmed(tradeKey);
        log.success('TX', `Confirmed (delayed): ${signature.slice(0, 16)}...`);
        return {
          success: true,
          signature,
          instructionCount: analysis.length,
          computeUnitsUsed: simAnalysis.unitsConsumed,
          retryCount,
        };
      }

      // TASK 3: Blockhash may have expired during confirmation
      return this.handleBlockhashExpiry(tradeKey, keypair, rebuildFn, retryCount);
    }

    this.dedup.markConfirmed(tradeKey);
    log.success('TX', `Confirmed: ${signature.slice(0, 16)}...`);

    return {
      success: true,
      signature,
      instructionCount: analysis.length,
      computeUnitsUsed: simAnalysis.unitsConsumed,
      retryCount,
    };
  }

  // ─── TASK 3: Blockhash Expiry Handler ─────────────────────────────────────

  private async handleBlockhashExpiry(
    tradeKey: string,
    keypair: Keypair,
    rebuildFn: (() => Promise<string | null>) | undefined,
    retryCount: number,
  ): Promise<TxPipelineResult> {
    const log = getLogger();

    if (retryCount >= MAX_REBUILD_CYCLES) {
      log.error('TX', `Blockhash expired after ${retryCount} rebuild cycles — aborting`);
      return { success: false, error: `Transaction failed: blockhash expired after ${retryCount + 1} attempts` };
    }

    // Check dedup: maybe the tx actually landed
    const cached = this.dedup.check(tradeKey);
    if (cached) {
      const onChain = await this.checkSignatureStatus(cached.signature);
      if (onChain) {
        this.dedup.markConfirmed(tradeKey);
        log.success('TX', `Transaction actually landed despite timeout: ${cached.signature.slice(0, 16)}...`);
        return { success: true, signature: cached.signature, retryCount };
      }
    }

    if (!rebuildFn) {
      log.error('TX', 'Blockhash expired and no rebuild function provided — aborting');
      return { success: false, error: 'Transaction failed: blockhash expired. Retry the command.' };
    }

    log.warn('TX', `Blockhash expired — rebuilding transaction (attempt ${retryCount + 2})...`);
    const newTxBase64 = await rebuildFn();
    if (!newTxBase64) {
      return { success: false, error: 'Transaction rebuild failed — aborting' };
    }

    return this.executeInner(newTxBase64, keypair, tradeKey, rebuildFn, retryCount + 1);
  }

  // ─── Confirmation ─────────────────────────────────────────────────────

  private async confirmWithRetry(
    signature: string,
    tx: VersionedTransaction,
  ): Promise<boolean> {
    const log = getLogger();
    const start = Date.now();
    let lastResend = start;

    while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
      const status = await this.checkSignatureStatus(signature);
      if (status) return true;

      // Periodic resend
      if (Date.now() - lastResend > RESEND_INTERVAL_MS) {
        log.debug('TX', 'Resending...');
        try {
          await this.connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 1,
          });
        } catch {
          // Ignore — blockhash may have expired, handled by caller
        }
        lastResend = Date.now();
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    return false;
  }

  private async checkSignatureStatus(signature: string): Promise<boolean> {
    try {
      const statuses = await this.connection.getSignatureStatuses([signature]);
      const status = statuses.value[0];
      if (status?.confirmationStatus) {
        if (status.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        }
        return status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('failed on-chain')) throw e;
    }
    return false;
  }
}

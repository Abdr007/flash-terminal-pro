/**
 * Wallet Manager
 *
 * Loads keypair from file or env, provides signing capability,
 * fetches SOL and token balances via RPC.
 *
 * Security:
 *   - Path validated (no symlinks, size limits)
 *   - Keypair integrity verified after load
 *   - Secret key never logged
 */

import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { readFileSync, lstatSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import nacl from 'tweetnacl';
import { getLogger } from '../utils/logger.js';
import type { FlashXConfig } from '../types/index.js';

// Known SPL token mints on mainnet
const TOKEN_MINTS: Record<string, string> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

const MAX_KEYFILE_SIZE = 1024;

export class WalletManager {
  private _keypair: Keypair | null = null;
  private _connection: Connection | null = null;
  private _config: FlashXConfig;

  constructor(config: FlashXConfig) {
    this._config = config;
  }

  get isConnected(): boolean {
    return this._keypair !== null;
  }

  get publicKey(): PublicKey | null {
    return this._keypair?.publicKey ?? null;
  }

  get keypair(): Keypair | null {
    return this._keypair;
  }

  get connection(): Connection {
    if (!this._connection) {
      this._connection = new Connection(this._config.rpcUrl, {
        commitment: 'confirmed',
        fetch: (url: string | URL | Request, init?: RequestInit) =>
          fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }),
      });
    }
    return this._connection;
  }

  /**
   * Load keypair from file path.
   * Validates: no symlink, size limit, 64-byte JSON array, sign/verify integrity.
   */
  loadFromFile(filePath?: string): void {
    const log = getLogger();
    const path = filePath ?? this._config.keypairPath;

    if (!path) {
      throw new Error('No keypair path configured. Set KEYPAIR_PATH env var.');
    }

    const resolved = path.startsWith('~/')
      ? resolve(homedir(), path.slice(2))
      : resolve(path);

    log.info('WALLET', `Loading keypair from ${resolved.replace(homedir(), '~')}`);

    // Security: no symlinks
    const lstat = lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      throw new Error('Keypair path must not be a symlink');
    }

    // Security: size limit
    const stat = statSync(resolved);
    if (stat.size > MAX_KEYFILE_SIZE) {
      throw new Error(`Keypair file too large: ${stat.size} bytes (max ${MAX_KEYFILE_SIZE})`);
    }

    const raw = readFileSync(resolved, 'utf-8');
    let keyBytes: Uint8Array;

    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 64) {
        throw new Error('Expected JSON array of 64 bytes');
      }
      keyBytes = new Uint8Array(parsed as number[]);
    } catch (e) {
      throw new Error(`Invalid keypair file: ${e instanceof Error ? e.message : String(e)}`);
    }

    // NOTE: Keypair.fromSecretKey holds a REFERENCE to the buffer.
    // DO NOT zero keyBytes — it would corrupt the keypair.
    this._keypair = Keypair.fromSecretKey(keyBytes);

    // Integrity check: sign and verify a test message
    this.verifyIntegrity();

    log.success('WALLET', `Loaded: ${this._keypair.publicKey.toBase58().slice(0, 8)}...`);
  }

  /**
   * Verify keypair integrity: sign a test message and verify the signature.
   * Throws if the keypair is corrupted.
   */
  verifyIntegrity(): void {
    if (!this._keypair) throw new Error('No keypair loaded');

    const testMsg = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    const sig = nacl.sign.detached(testMsg, this._keypair.secretKey);
    const valid = nacl.sign.detached.verify(testMsg, sig, this._keypair.publicKey.toBytes());

    if (!valid) {
      this._keypair = null;
      throw new Error('Keypair integrity check FAILED — signature did not verify');
    }
  }

  /**
   * Disconnect and zero secret key.
   */
  disconnect(): void {
    if (this._keypair) {
      // Solana Keypair holds a reference — zeroing may be ineffective
      // but we do it as defense in depth
      try { this._keypair.secretKey.fill(0); } catch { /* noop */ }
      this._keypair = null;
    }
    getLogger().info('WALLET', 'Disconnected');
  }

  /**
   * Clear cached balances to force fresh fetch on next query.
   * Called after successful transactions (matching flash-terminal).
   */
  clearBalanceCache(): void {
    // Balances are fetched fresh each call — no cache to clear currently.
    // This method exists for API compatibility with flash-terminal.
  }

  // ─── Balance ──────────────────────────────────────────────────────────

  async getSolBalance(): Promise<number> {
    if (!this._keypair) return 0;
    try {
      const lamports = await this.connection.getBalance(this._keypair.publicKey);
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      getLogger().warn('WALLET', 'Failed to fetch SOL balance');
      return 0;
    }
  }

  async getTokenBalance(tokenSymbol: string): Promise<number> {
    if (!this._keypair) return 0;
    const mintStr = TOKEN_MINTS[tokenSymbol.toUpperCase()];
    if (!mintStr) return 0;

    try {
      const mint = new PublicKey(mintStr);
      const ata = await getAssociatedTokenAddress(mint, this._keypair.publicKey);
      const account = await getAccount(this.connection, ata);
      const decimals = 6; // USDC and USDT both use 6
      return Number(account.amount) / Math.pow(10, decimals);
    } catch {
      return 0; // ATA doesn't exist = 0 balance
    }
  }

  async getBalance(token?: string): Promise<number> {
    if (!token || token.toUpperCase() === 'SOL') {
      return this.getSolBalance();
    }
    return this.getTokenBalance(token);
  }

  get shortAddress(): string {
    if (!this._keypair) return 'Not connected';
    const addr = this._keypair.publicKey.toBase58();
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }
}

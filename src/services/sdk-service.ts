/**
 * SDK Service — Isolated Flash SDK Wrapper
 *
 * ONLY used for operations that the API does NOT support:
 *   - FAF staking / unstake / claim
 *   - LP deposit / withdraw
 *
 * Architecture:
 *   - SDK is lazy-initialized only when needed
 *   - All instruction outputs go through TxPipeline
 *   - No SDK types leak into the rest of the system
 *   - ExecutionEngine calls SdkService, NOT flash-sdk directly
 *
 * ISOLATION: This is the ONLY file that imports flash-sdk.
 */

import {
  PerpetualsClient,
  PoolConfig,
  uiDecimalsToNative,
  BN_ZERO,
} from 'flash-sdk';
import {
  Connection,
  Keypair,
  TransactionInstruction,
  Signer,
  VersionedTransaction,
  MessageV0,
  ComputeBudgetProgram,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getLogger } from '../utils/logger.js';
import type { FlashXConfig } from '../types/index.js';

const POOL_NAMES = ['Crypto.1', 'Virtual.1', 'Governance.1', 'Community.1', 'Community.2', 'Trump.1', 'Ore.1', 'Equity.1'];

// ─── Result Types (SDK-free — these are what the rest of the system sees) ───

export interface SdkTxResult {
  transactionBase64: string;
}

// ─── SDK Service ────────────────────────────────────────────────────────────

export class SdkService {
  private client: PerpetualsClient | null = null;
  private poolConfigs: Map<string, PoolConfig> = new Map();
  private connection: Connection | null = null;
  private initialized = false;

  constructor(private config: FlashXConfig) {}

  /**
   * Initialize SDK with real wallet keypair.
   * Lazy — only called when FAF/LP operations are requested.
   */
  init(keypair: Keypair): void {
    if (this.initialized) return;
    const log = getLogger();

    try {
      this.connection = new Connection(this.config.rpcUrl, { commitment: 'confirmed' });
      const provider = new AnchorProvider(this.connection, new Wallet(keypair), { commitment: 'confirmed' });

      for (const name of POOL_NAMES) {
        try {
          const pc = PoolConfig.fromIdsByName(name, this.config.network);
          this.poolConfigs.set(name, pc);
        } catch { /* pool not available */ }
      }

      const firstPool = this.poolConfigs.values().next().value;
      if (firstPool) {
        this.client = new PerpetualsClient(
          provider,
          firstPool.programId,
          firstPool.perpComposibilityProgramId,
          firstPool.fbNftRewardProgramId,
          firstPool.rewardDistributionProgram.programId,
          { prioritizationFee: this.config.computeUnitPrice },
        );
        log.info('SDK', `Initialized: ${this.poolConfigs.size} pools`);
      }

      this.initialized = true;
    } catch (e) {
      log.warn('SDK', `Init failed: ${e instanceof Error ? e.message : String(e)}`);
      this.initialized = true;
    }
  }

  get isReady(): boolean {
    return this.client !== null && this.connection !== null;
  }

  get perpClient(): import('flash-sdk').PerpetualsClient | null {
    return this.client;
  }

  getPoolConfig(name: string): import('flash-sdk').PoolConfig | null {
    return this.poolConfigs.get(name) ?? null;
  }

  // ─── FAF Staking ──────────────────────────────────────────────────────

  /**
   * Build FAF stake transaction.
   * Returns base64 tx ready for TxPipeline.
   */
  async buildFafStake(
    keypair: Keypair,
    amount: number,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) { log.error('SDK', `Pool ${poolName} not found`); return null; }

    try {
      log.info('SDK', `Building FAF stake: ${amount}`);
      const nativeAmount = uiDecimalsToNative(amount.toString(), 6); // FAF has 6 decimals
      const result = await this.client.depositTokenStake(
        keypair.publicKey,
        keypair.publicKey,
        nativeAmount,
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `FAF stake build failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build FAF unstake request transaction.
   */
  async buildFafUnstake(
    keypair: Keypair,
    amount: number,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', `Building FAF unstake: ${amount}`);
      const nativeAmount = uiDecimalsToNative(amount.toString(), 6);
      const result = await this.client.unstakeTokenRequest(
        keypair.publicKey,
        nativeAmount,
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `FAF unstake failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build FAF reward claim transaction.
   */
  async buildFafClaim(
    keypair: Keypair,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', 'Building FAF claim');
      const result = await this.client.collectTokenReward(keypair.publicKey, pc);
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `FAF claim failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build FAF claim USDC revenue transaction.
   * Flash-terminal calls collectRevenue separately from collectTokenReward.
   */
  async buildFafClaimRevenue(
    keypair: Keypair,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', 'Building FAF revenue claim');
      const result = await this.client.collectRevenue(keypair.publicKey, 'USDC', pc);
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.warn('SDK', `FAF revenue claim: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build FAF referral rebate claim transaction.
   */
  async buildFafClaimRebate(
    keypair: Keypair,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', 'Building FAF rebate claim');
      const result = await this.client.collectRebate(keypair.publicKey, 'USDC', pc);
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.warn('SDK', `FAF rebate claim: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build FAF cancel unstake request transaction.
   */
  async buildFafCancel(
    keypair: Keypair,
    requestIndex: number,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', `Building FAF cancel unstake: request #${requestIndex}`);
      const result = await this.client.cancelUnstakeTokenRequest(
        keypair.publicKey,
        requestIndex,
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `FAF cancel failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ─── Earn Operations (matching flash-terminal's exact SDK methods) ────

  /**
   * Build earn deposit (compounding liquidity) — USDC → FLP
   * Flash-terminal uses addCompoundingLiquidity
   */
  async buildEarnDeposit(
    keypair: Keypair,
    amount: number,
    poolName: string,
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) { log.error('SDK', `Pool ${poolName} not found`); return null; }

    try {
      log.info('SDK', `Building earn deposit: ${amount} USDC → ${poolName}`);
      const nativeAmount = uiDecimalsToNative(amount.toString(), 6); // USDC = 6 decimals
      const rewardTokenMint = pc.compoundingTokenMint;
      const result = await this.client.addCompoundingLiquidity(
        nativeAmount,
        BN_ZERO, // minCompoundingAmountOut
        'USDC',
        rewardTokenMint,
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `Earn deposit failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build earn claim rewards (sFLP staking rewards)
   * Flash-terminal uses collectStakeFees
   */
  async buildEarnClaim(
    keypair: Keypair,
    poolName = 'Crypto.1',
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    try {
      log.info('SDK', `Building earn claim: ${poolName}`);
      const result = await this.client.collectStakeFees('USDC', pc);
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `Earn claim failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ─── LP Operations ────────────────────────────────────────────────────

  /**
   * Build LP add liquidity + stake transaction.
   */
  async buildLpDeposit(
    keypair: Keypair,
    tokenSymbol: string,
    amount: number,
    poolName: string,
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) { log.error('SDK', `Pool ${poolName} not found`); return null; }

    const token = pc.tokens.find(t => t.symbol === tokenSymbol);
    if (!token) { log.error('SDK', `Token ${tokenSymbol} not in ${poolName}`); return null; }

    try {
      log.info('SDK', `Building LP deposit: ${amount} ${tokenSymbol} → ${poolName}`);

      // First: setLpTokenPrice (required prerequisite)
      const priceIxs = await this.client.setLpTokenPrice(pc);
      await this.sendPrerequisiteTx(priceIxs.instructions, keypair, pc);

      // Then: add liquidity + stake
      const nativeAmount = uiDecimalsToNative(amount.toString(), token.decimals);
      const result = await this.client.addLiquidityAndStake(
        tokenSymbol,
        nativeAmount,
        BN_ZERO, // minLpAmountOut
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `LP deposit failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Build LP remove liquidity transaction.
   */
  async buildLpWithdraw(
    keypair: Keypair,
    tokenSymbol: string,
    amount: number,
    poolName: string,
  ): Promise<SdkTxResult | null> {
    this.init(keypair);
    if (!this.client || !this.connection) return null;

    const log = getLogger();
    const pc = this.poolConfigs.get(poolName);
    if (!pc) return null;

    const token = pc.tokens.find(t => t.symbol === tokenSymbol);
    if (!token) return null;

    try {
      log.info('SDK', `Building LP withdraw: ${amount} from ${poolName}`);
      const nativeAmount = uiDecimalsToNative(amount.toString(), 6); // LP token decimals
      const result = await this.client.removeLiquidity(
        tokenSymbol,
        nativeAmount,
        BN_ZERO,
        pc,
      );
      return this.buildTx(result.instructions, result.additionalSigners, keypair, pc);
    } catch (e) {
      log.error('SDK', `LP withdraw failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  // ─── ALT Resolution (matching flash-terminal's alt-resolver.ts) ────────

  /** ALT cache: poolName → { tables, fetchedAt } */
  private altCache = new Map<string, { tables: AddressLookupTableAccount[]; fetchedAt: number }>();
  private static ALT_CACHE_TTL = 5 * 60_000; // 5 minutes

  /**
   * Resolve ALTs using SDK's built-in getOrLoadAddressLookupTable.
   * Matches flash-terminal's resolveALTs() exactly:
   *   1. Check cache (5min TTL)
   *   2. Call perpClient.getOrLoadAddressLookupTable(poolConfig)
   *   3. Validate tables contain addresses
   *   4. Fallback to perpClient.addressLookupTables
   *   5. Graceful degradation → empty array
   */
  private async resolveALTs(poolConfig: PoolConfig): Promise<AddressLookupTableAccount[]> {
    const log = getLogger();
    const cacheKey = poolConfig.poolName;

    // Check cache
    const cached = this.altCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SdkService.ALT_CACHE_TTL) {
      return cached.tables;
    }

    try {
      const { addressLookupTables } = await this.client!.getOrLoadAddressLookupTable(poolConfig);

      // Validate ALT content — tables without addresses are useless
      const validTables = addressLookupTables.filter(
        (t: AddressLookupTableAccount) => t?.state?.addresses?.length > 0,
      );

      if (validTables.length > 0) {
        const totalAddrs = validTables.reduce((sum: number, t: AddressLookupTableAccount) => sum + t.state.addresses.length, 0);
        log.info('ALT', `${cacheKey}: ${validTables.length} table(s), ${totalAddrs} addresses`);
      } else if (addressLookupTables.length > 0) {
        log.info('ALT', `${cacheKey}: ${addressLookupTables.length} table(s) loaded but none contain addresses`);
      }

      this.altCache.set(cacheKey, { tables: addressLookupTables, fetchedAt: Date.now() });
      return addressLookupTables;
    } catch (err) {
      log.info('ALT', `Failed to load ALTs for ${cacheKey}: ${err}`);

      // Fallback: check if SDK has previously loaded tables
      const clientAny = this.client as unknown as { addressLookupTables?: AddressLookupTableAccount[] };
      if (clientAny.addressLookupTables?.length) {
        log.info('ALT', `Using perpClient.addressLookupTables fallback (${clientAny.addressLookupTables.length} tables)`);
        this.altCache.set(cacheKey, { tables: clientAny.addressLookupTables, fetchedAt: Date.now() });
        return clientAny.addressLookupTables;
      }

      return [];
    }
  }

  // ─── Transaction Building ─────────────────────────────────────────────

  private async buildTx(
    instructions: TransactionInstruction[],
    additionalSigners: Signer[],
    keypair: Keypair,
    poolConfig: PoolConfig,
  ): Promise<SdkTxResult | null> {
    if (!this.connection || !this.client) return null;

    try {
      const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.computeUnitLimit });
      const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });
      const allIxs = [cuLimit, cuPrice, ...instructions];

      // Resolve ALTs via SDK (matching flash-terminal)
      const alts = await this.resolveALTs(poolConfig);

      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      const message = MessageV0.compile({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: allIxs,
        addressLookupTableAccounts: alts,
      });

      const tx = new VersionedTransaction(message);
      tx.sign([keypair, ...additionalSigners]);

      const serialized = Buffer.from(tx.serialize()).toString('base64');
      return { transactionBase64: serialized };
    } catch (e) {
      getLogger().error('SDK', `Tx build failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private async sendPrerequisiteTx(
    instructions: TransactionInstruction[],
    keypair: Keypair,
    poolConfig: PoolConfig,
  ): Promise<void> {
    if (!this.connection || !this.client) return;
    const log = getLogger();

    try {
      const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
      const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.computeUnitPrice });

      // Resolve ALTs via SDK (matching flash-terminal)
      const alts = await this.resolveALTs(poolConfig);

      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      const message = MessageV0.compile({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions: [cuLimit, cuPrice, ...instructions],
        addressLookupTableAccounts: alts,
      });

      const tx = new VersionedTransaction(message);
      tx.sign([keypair]);

      const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      log.info('SDK', `Prerequisite tx sent: ${sig.slice(0, 16)}...`);

      // Wait for confirmation
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const st = await this.connection.getSignatureStatuses([sig]);
        if (st.value[0]?.confirmationStatus) break;
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      log.warn('SDK', `Prerequisite tx failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

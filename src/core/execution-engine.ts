/**
 * ExecutionEngine
 *
 * Orchestrates the full lifecycle of every command:
 *   ParsedCommand → validate → risk check → preview → confirm → execute → verify
 *
 * This is the ONLY path from user intent to protocol interaction.
 * No component may bypass this engine.
 *
 * Phase 1: Routes commands and displays results. Trading is mocked.
 * Phase 2: Connects to real API/SDK/RPC for live execution.
 */

import chalk from 'chalk';
import {
  Action,
  type ParsedCommand,
  type TradeIntent,
  type SwapIntent,
  type Position,
  type TxResult,
  type LocalQuote,
  type IExecutionEngine,
  type FlashXConfig,
} from '../types/index.js';
import { RiskEngine } from './risk-engine.js';
import { StateEngine } from './state-engine.js';
import { getLogger } from '../utils/logger.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { FlashSdkClient } from '../services/sdk-client.js';
import { crossValidateQuotes } from '../services/sdk-client.js';
import type { WalletManager } from '../wallet/manager.js';
import type { TxPipeline } from '../tx/pipeline.js';
import type { RpcManager } from '../services/rpc-manager.js';
import { resolvePool, resolveSwapPool } from '../services/pool-resolver.js';
import { PostVerifier } from '../tx/post-verify.js';
import { checkQuoteFreshness, checkPriceDrift, type TimedQuote } from '../tx/quote-guard.js';
import { getAuditLog, type AuditRecord } from '../security/audit-log.js';
import { StateConsistency } from './state-consistency.js';
import { getMetrics } from './metrics.js';
import { ErrorCode } from '../types/errors.js';
import {
  formatUsd,
  formatPrice,
  colorPnl,
  colorSide,
  colorPercent,
  accentBold,
  dim,
  warn,
  err,
  ok,
  pad,
} from '../utils/format.js';

// ─── Fee estimation constants (from Flash protocol docs) ────────────────────
// These are the standard open/close fee rates per pool/asset
const FEE_RATES: Record<string, number> = {
  SOL: 0.00051,  BTC: 0.00051,  ETH: 0.00051,   // Crypto: 0.051%
  ZEC: 0.002,    BNB: 0.001,                      // Crypto alt
  EUR: 0.0003,   GBP: 0.0003,   USDJPY: 0.0003, USDCNH: 0.0003, // FX: 0.03%
  XAU: 0.001,    XAG: 0.001,    CRUDEOIL: 0.0015, NATGAS: 0.0015, // Commodities
  JUP: 0.0011,   JTO: 0.0011,   RAY: 0.0011, PYTH: 0.0011, // Governance: 0.11%
  KMNO: 0.002,   MET: 0.002,    HYPE: 0.002,
  BONK: 0.0012,  WIF: 0.0012,   PENGU: 0.0012, PUMP: 0.0012, FARTCOIN: 0.0012, // Meme
  SPY: 0.001,    NVDA: 0.001,   TSLA: 0.001, AAPL: 0.001, AMD: 0.001, AMZN: 0.001, // Equity
  ORE: 0.002,
};

function estimateFee(market: string, sizeUsd: number): number {
  const rate = FEE_RATES[market] ?? 0.001; // default 0.1%
  return sizeUsd * rate;
}

// ─── ExecutionEngine ────────────────────────────────────────────────────────

export class ExecutionEngine implements IExecutionEngine {
  private risk: RiskEngine;
  private state: StateEngine;
  private api: FlashApiClient;
  private sdk: FlashSdkClient;
  private wallet: WalletManager;
  txPipeline: TxPipeline;
  private rpcManager: RpcManager | null = null;

  constructor(
    private config: FlashXConfig,
    state: StateEngine,
    api: FlashApiClient,
    sdk: FlashSdkClient,
    wallet: WalletManager,
    txPipeline: TxPipeline,
    rpcManager?: RpcManager,
  ) {
    this.state = state;
    this.api = api;
    this.sdk = sdk;
    this.wallet = wallet;
    this.txPipeline = txPipeline;
    this.rpcManager = rpcManager ?? null;
    this.risk = new RiskEngine(config, state);
  }

  /**
   * Main entry point — routes a parsed command to the appropriate handler.
   */
  async execute(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    log.debug('ENGINE', `Routing: ${command.action} [${command.source}, conf=${command.confidence}]`);

    // If low confidence, show what we understood and ask for confirmation
    if (command.confidence < 0.8 && command.action !== Action.Unknown) {
      log.warn('ENGINE', `Low confidence parse (${(command.confidence * 100).toFixed(0)}%) — suggesting`);
      return {
        success: false,
        error: this.formatSuggestion(command),
      };
    }

    switch (command.action) {
      // ─── Trading ────────────────────────────────────────────────────
      case Action.OpenPosition:
        return this.handleOpen(command);
      case Action.ClosePosition:
        return this.handleClose(command);
      case Action.ReversePosition:
        return this.handleReverse(command);
      case Action.AddCollateral:
      case Action.RemoveCollateral:
        return this.handleCollateral(command);

      // ─── Orders ─────────────────────────────────────────────────────
      case Action.LimitOrder:
      case Action.TakeProfit:
      case Action.StopLoss:
      case Action.CancelOrder:
      case Action.CancelAllOrders:
        return this.handleOrder(command);

      // ─── Swap ───────────────────────────────────────────────────────
      case Action.Swap:
        return this.handleSwap(command);

      // ─── LP ─────────────────────────────────────────────────────────
      case Action.AddLiquidity:
      case Action.RemoveLiquidity:
      case Action.CollectFees:
        return this.handleLp(command);

      // ─── Views ──────────────────────────────────────────────────────
      case Action.ViewPositions:
        return this.handleViewPositions();
      case Action.ViewPortfolio:
        return this.handleViewPortfolio();
      case Action.ViewMarkets:
        return this.handleViewMarkets();
      case Action.ViewMarket:
        return this.handleViewMarket(command);
      case Action.ViewPrices:
        return this.handleViewPrices(command);
      case Action.ViewPools:
        return this.handleViewPools();
      case Action.ViewBalance:
        return this.handleViewBalance();
      case Action.ViewTrades:
        return this.handleTradeHistory();
      case Action.ViewStats:
        return this.handleStats();
      case Action.ViewOrders:
      case Action.ViewFunding:
      case Action.ViewOI:
      case Action.ViewFees:
      case Action.ViewHours:
        return { success: true, error: dim('  Coming in Phase 2') };

      // ─── Wallet ─────────────────────────────────────────────────────
      case Action.WalletCreate:
      case Action.WalletImport:
      case Action.WalletList:
      case Action.WalletUse:
        return { success: true, error: dim('  Wallet management coming in Phase 2') };

      // ─── System ─────────────────────────────────────────────────────
      case Action.Health:
        return this.handleHealth();
      case Action.Help:
        return this.handleHelp();
      case Action.Config:
        return this.handleConfig(command);

      // ─── Unknown ────────────────────────────────────────────────────
      case Action.Unknown:
        return {
          success: false,
          error: this.formatUnknown(command.raw),
        };

      default:
        return { success: false, error: err(`  Unhandled action: ${command.action}`) };
    }
  }

  async preview(command: ParsedCommand): Promise<LocalQuote | null> {
    const { market, side, leverage, collateral } = command.params;
    if (!market || !side || !leverage || !collateral) return null;
    const pool = resolvePool(market) ?? 'Crypto.1';
    return this.sdk.getOpenQuote({ market, side, leverage, collateral, pool });
  }

  /**
   * Cross-validate an API quote against a local SDK quote.
   * Returns divergences if any field is off by more than tolerance.
   */
  validateApiQuote(apiQuote: { entryFee: number; newLeverage: number }, sdkQuote: LocalQuote) {
    return crossValidateQuotes(apiQuote, sdkQuote);
  }

  // ─── Trade Handlers ─────────────────────────────────────────────────────

  private async handleOpen(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const metrics = getMetrics();
    const { market, side, leverage, collateral, takeProfit, stopLoss, degen, collateralToken } = command.params;

    if (!market || !side || !leverage || !collateral) {
      return { success: false, error: err(`  [${ErrorCode.MISSING_PARAMS}] Missing parameters. Usage: long SOL 10x $100`) };
    }

    metrics.recordTradeAttempt();
    log.info('ENGINE', `Open: ${market} ${side} ${leverage}x $${collateral}`);

    // Resolve pool
    const pool = resolvePool(market) ?? 'Crypto.1';

    // Flash API always accepts USDC as input — it auto-swaps to the
    // correct collateral token (SOL for longs, USDC for shorts).
    // The user pays in USDC regardless of side.
    const paymentToken = collateralToken ?? 'USDC';

    // Build trade intent
    const intent: TradeIntent = {
      action: Action.OpenPosition,
      market,
      side,
      leverage,
      collateral,
      collateralToken: paymentToken,
      sizeUsd: collateral * leverage,
      takeProfit,
      stopLoss,
      degen: degen ?? false,
      pool,
    };

    // Risk check
    const risk = await this.risk.evaluate(intent);

    if (!risk.allowed) {
      log.warn('ENGINE', `Trade blocked: ${risk.summary}`);
      metrics.recordTradeBlocked();
      audit.log({
        timestamp: new Date().toISOString(), action: 'open_position', command: command.raw,
        market, side, leverage, collateral, sizeUsd: collateral * leverage,
        pool, status: 'blocked', error: risk.summary,
      });
      const lines = [
        '',
        `  ${err('TRADE BLOCKED')}`,
        '',
        ...risk.checks
          .filter(c => c.status !== 'SAFE')
          .map(c => `  ${c.status === 'BLOCKED' ? chalk.red('✗') : chalk.yellow('⚠')} ${c.message}`),
        '',
      ];
      return { success: false, error: lines.join('\n') };
    }

    // ─── SDK LOCAL QUOTE ──────────────────────────────────────────────────
    const sdkQuote = this.sdk.getOpenQuote({
      market, side, leverage, collateral, pool,
    });
    log.debug('ENGINE', `SDK quote: fee=$${sdkQuote.openFee.toFixed(4)}, size=$${sdkQuote.sizeUsd.toFixed(0)}`);

    // Use SDK fee if available, fallback to static estimate
    const estFee = sdkQuote.openFee > 0 ? sdkQuote.openFee : estimateFee(market, intent.sizeUsd);

    const lines = [
      '',
      `  ${accentBold('TRADE PREVIEW')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Action:')}      ${chalk.bold('OPEN POSITION')}`,
      `  ${dim('Market:')}      ${chalk.white.bold(market)}-${colorSide(side)}`,
      `  ${dim('Leverage:')}    ${chalk.white.bold(leverage + 'x')}`,
      `  ${dim('Collateral:')}  ${chalk.white.bold(formatUsd(collateral))} ${dim(`(${intent.collateralToken})`)}`,
      `  ${dim('Size:')}        ${chalk.white.bold(formatUsd(intent.sizeUsd))}`,
      `  ${dim('Est. Fee:')}    ${chalk.yellow(formatUsd(estFee))} ${dim(`(${((FEE_RATES[market] ?? 0.001) * 100).toFixed(3)}%)`)}`,
    ];

    if (takeProfit) lines.push(`  ${dim('Take Profit:')} ${chalk.green(formatPrice(takeProfit))}`);
    if (stopLoss) lines.push(`  ${dim('Stop Loss:')}   ${chalk.red(formatPrice(stopLoss))}`);
    if (degen) lines.push(`  ${dim('Mode:')}        ${chalk.magenta.bold('DEGEN')}`);

    lines.push(`  ${dim('─'.repeat(48))}`);

    // Risk warnings
    if (risk.mustConfirm) {
      for (const c of risk.checks.filter(c => c.status === 'WARNING')) {
        lines.push(`  ${chalk.yellow('⚠')} ${c.message}`);
      }
      lines.push('');
    }

    // ─── SIMULATION: stop at preview ───────────────────────────────────
    if (this.config.simulationMode) {
      if (this.config.devMode) {
        lines.push(`  ${chalk.magenta.bold('DEV MODE')} — pipeline testing active`);
      }
      lines.push(`  ${dim('[SIMULATION MODE — no real transaction]')}`);
      lines.push('');
      audit.log({
        timestamp: new Date().toISOString(), action: 'open_position', command: command.raw,
        market, side, leverage, collateral, sizeUsd: intent.sizeUsd,
        fees: estFee, pool, slippageBps: this.config.defaultSlippageBps, status: 'preview',
      });
      log.success('ENGINE', `Preview displayed: ${market} ${side} ${leverage}x ${formatUsd(collateral)}`);
      return { success: true, error: lines.join('\n') };
    }

    // ─── LIVE MODE: full execution ──────────────────────────────────────

    if (!this.wallet.isConnected || !this.wallet.keypair) {
      lines.push('', `  ${err('Wallet not connected — cannot execute trade')}`, '');
      return { success: false, error: lines.join('\n') };
    }

    // Build transaction via API
    log.info('ENGINE', 'Building open position transaction...');
    const startMs = Date.now();
    let txBase64: string;
    try {
      // Flash API always takes USDC as input, market token as output.
      // tradeType determines direction (LONG/SHORT).
      // inputAmountUi is the USD collateral amount.
      const buildResult = await this.api.buildOpenPosition({
        inputTokenSymbol: 'USDC',
        outputTokenSymbol: intent.market,
        inputAmountUi: String(collateral),
        leverage,
        tradeType: intent.side === 'LONG' ? 'LONG' : 'SHORT',
        owner: this.wallet.publicKey!.toBase58(),
        slippageBps: this.config.defaultSlippageBps,
        takeProfitPrice: takeProfit,
        stopLossPrice: stopLoss,
      });

      if (buildResult.err) {
        audit.log({ timestamp: new Date().toISOString(), action: 'open_position', command: command.raw, market, side, leverage, collateral, status: 'failed', error: buildResult.err });
        return { success: false, error: err(`  Trade build failed: ${buildResult.err}`) };
      }
      if (!buildResult.transactionBase64) {
        return { success: false, error: err('  API returned no transaction') };
      }

      // Cross-validate API quote vs SDK quote (when both have valid numbers)
      const apiFee = Number(buildResult.entryFee);
      const apiLev = Number(buildResult.newLeverage);
      if (sdkQuote.openFee > 0 && Number.isFinite(apiFee) && apiFee > 0) {
        const validation = this.validateApiQuote(
          { entryFee: apiFee, newLeverage: Number.isFinite(apiLev) ? apiLev : 0 },
          sdkQuote,
        );
        if (!validation.valid) {
          log.warn('ENGINE', `Cross-validation: ${validation.divergences.join('; ')}`);
          lines.push(`  ${chalk.yellow('⚠')} Quote divergence: ${validation.divergences.join('; ')}`);
        }
      }

      txBase64 = buildResult.transactionBase64;
    } catch (e) {
      return { success: false, error: err(`  Trade build failed: ${e instanceof Error ? e.message : String(e)}`) };
    }

    // Pre-execution state snapshot
    const consistency = new StateConsistency(this.state);
    const preSnapshot = await consistency.snapshot([intent.collateralToken]);

    // Execute through the hardened pipeline
    const tradeKey = `open:${market}:${side}:${collateral}`;
    const intentParams = { action: 'open', market, side, leverage, collateral, ts: Math.floor(Date.now() / 1000) };
    const rebuildFn = async (): Promise<string | null> => {
      try {
        const rebuild = await this.api.buildOpenPosition({
          inputTokenSymbol: 'USDC',
          outputTokenSymbol: intent.market,
          inputAmountUi: String(collateral),
          leverage,
          tradeType: intent.side === 'LONG' ? 'LONG' : 'SHORT',
          owner: this.wallet.publicKey!.toBase58(),
          slippageBps: this.config.defaultSlippageBps,
        });
        return rebuild.transactionBase64 ?? null;
      } catch { return null; }
    };

    log.info('ENGINE', 'Executing through transaction pipeline...');
    const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, tradeKey, intentParams, rebuildFn);
    const durationMs = Date.now() - startMs;

    if (!txResult.success) {
      lines.push('', `  ${err('Execution failed:')} ${txResult.error}`, '');
      metrics.recordTradeFailed();
      audit.log({
        timestamp: new Date().toISOString(), action: 'open_position', command: command.raw,
        market, side, leverage, collateral, sizeUsd: intent.sizeUsd,
        txHash: txResult.signature, status: 'failed', error: txResult.error, durationMs, pool,
      });
      return { success: false, error: lines.join('\n'), signature: txResult.signature };
    }

    // Post-execution verification
    const { PostVerifier } = await import('../tx/post-verify.js');
    const verifier = new PostVerifier(this.state);
    const verification = await verifier.verifyOpenPosition(market, side, intent.sizeUsd);

    // State consistency check
    const consistencyResult = await consistency.verifyAfterTrade(preSnapshot, [
      { type: 'balance_decrease', token: intent.collateralToken },
      { type: 'position_opened', token: intent.collateralToken, market, side },
    ]);

    const auditStatus = consistencyResult.consistent ? 'confirmed' : 'inconsistent';

    lines.push('');
    lines.push(`  ${chalk.green('✓')} Trade executed: ${txResult.signature?.slice(0, 16)}...`);
    lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);

    if (verification.verified) {
      lines.push(`  ${dim(verification.details)}`);
    } else {
      lines.push(`  ${chalk.yellow('⚠')} ${verification.details}`);
    }

    if (!consistencyResult.consistent) {
      lines.push(`  ${chalk.red('⚠ STATE INCONSISTENCY DETECTED')}`);
    }
    lines.push('');

    metrics.recordTradeSuccess(durationMs);
    audit.log({
      timestamp: new Date().toISOString(), action: 'open_position', command: command.raw,
      market, side, leverage, collateral, sizeUsd: intent.sizeUsd,
      fees: estFee, txHash: txResult.signature, status: auditStatus,
      durationMs, pool, slippageBps: this.config.defaultSlippageBps, retryCount: txResult.retryCount,
    });

    log.success('ENGINE', `Trade complete: ${txResult.signature?.slice(0, 16)}... (${durationMs}ms)`);
    return { success: true, signature: txResult.signature, fees: estFee, error: lines.join('\n') };
  }

  private async handleClose(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const { market, side } = command.params;
    if (!market) return { success: false, error: err('  Missing market. Usage: close SOL') };

    const pct = command.params.percent;
    log.info('ENGINE', `Close: ${market}${side ? ' ' + side : ''}${pct ? ' ' + pct + '%' : ''}`);

    // Find existing position
    const position = await this.state.getPosition(market, side);
    if (!position) {
      // Try without side — auto-detect
      const anyPos = await this.state.getPosition(market);
      if (!anyPos) {
        return { success: false, error: err(`  No open ${market} position found`) };
      }
      // Use the found position's side
      return this.executeClose(command, anyPos);
    }

    return this.executeClose(command, position);
  }

  private async executeClose(command: ParsedCommand, position: Position): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const metrics = getMetrics();
    const { percent, amount } = command.params;
    const market = position.market;
    const side = position.side;

    const closePercent = percent ?? 100;
    const closeUsd = amount ?? position.sizeUsd;

    const lines = [
      '',
      `  ${accentBold('CLOSE PREVIEW')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Action:')}  ${chalk.bold('CLOSE POSITION')}`,
      `  ${dim('Market:')}  ${chalk.white.bold(market)} ${colorSide(side)}`,
      `  ${dim('Size:')}    ${formatUsd(position.sizeUsd)}`,
      `  ${dim('Entry:')}   ${formatPrice(position.entryPrice)}`,
      `  ${dim('PnL:')}     ${colorPnl(position.pnl)} ${dim(`(${position.pnlPercent.toFixed(2)}%)`)}`,
      `  ${dim('Close:')}   ${chalk.white.bold(closePercent + '%')}`,
      `  ${dim('─'.repeat(48))}`,
    ];

    // Simulation mode: stop at preview
    if (this.config.simulationMode) {
      lines.push(`  ${dim('[SIMULATION MODE — no real transaction]')}`, '');
      audit.log({ timestamp: new Date().toISOString(), action: 'close_position', command: command.raw, market, side, sizeUsd: position.sizeUsd, status: 'preview' });
      return { success: true, error: lines.join('\n') };
    }

    if (!this.wallet.isConnected || !this.wallet.keypair) {
      lines.push(`  ${err('Wallet not connected')}`, '');
      return { success: false, error: lines.join('\n') };
    }

    // Build close transaction via API
    log.info('ENGINE', 'Building close position transaction...');
    const startMs = Date.now();
    let txBase64: string;
    try {
      const buildResult = await this.api.buildClosePosition({
        positionKey: position.pubkey,
        inputUsdUi: String(closeUsd),
        withdrawTokenSymbol: 'USDC',
        owner: this.wallet.publicKey!.toBase58(),
      }) as Record<string, unknown>;

      if (buildResult['err']) {
        return { success: false, error: err(`  Close build failed: ${buildResult['err']}`) };
      }
      const tx64 = buildResult['transactionBase64'] as string | undefined;
      if (!tx64) {
        return { success: false, error: err('  API returned no transaction') };
      }
      txBase64 = tx64;
    } catch (e) {
      return { success: false, error: err(`  Close build failed: ${e instanceof Error ? e.message : String(e)}`) };
    }

    // Execute through pipeline
    const tradeKey = `close:${market}:${side}`;
    const intentParams = { action: 'close', market, side, closePercent, ts: Math.floor(Date.now() / 1000) };
    const rebuildFn = async (): Promise<string | null> => {
      try {
        const rebuild = await this.api.buildClosePosition({
          positionKey: position.pubkey,
          inputUsdUi: String(closeUsd),
          withdrawTokenSymbol: 'USDC',
          owner: this.wallet.publicKey!.toBase58(),
        }) as Record<string, unknown>;
        return (rebuild['transactionBase64'] as string) ?? null;
      } catch { return null; }
    };

    log.info('ENGINE', 'Executing close through pipeline...');
    const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, tradeKey, intentParams, rebuildFn);
    const durationMs = Date.now() - startMs;

    if (!txResult.success) {
      lines.push('', `  ${err('Close failed:')} ${txResult.error}`, '');
      metrics.recordTradeFailed();
      audit.log({ timestamp: new Date().toISOString(), action: 'close_position', command: command.raw, market, side, sizeUsd: position.sizeUsd, txHash: txResult.signature, status: 'failed', error: txResult.error, durationMs });
      return { success: false, error: lines.join('\n'), signature: txResult.signature };
    }

    lines.push('');
    lines.push(`  ${chalk.green('✓')} Position closed: ${txResult.signature?.slice(0, 16)}...`);
    lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);
    lines.push('');

    metrics.recordTradeSuccess(durationMs);
    audit.log({ timestamp: new Date().toISOString(), action: 'close_position', command: command.raw, market, side, sizeUsd: position.sizeUsd, txHash: txResult.signature, status: 'confirmed', durationMs });

    log.success('ENGINE', `Close complete: ${txResult.signature?.slice(0, 16)}... (${durationMs}ms)`);
    return { success: true, signature: txResult.signature, error: lines.join('\n') };
  }

  private async handleReverse(command: ParsedCommand): Promise<TxResult> {
    void command;
    return { success: true, error: dim('  Reverse position — Phase 2') };
  }

  private async handleCollateral(command: ParsedCommand): Promise<TxResult> {
    const isAdd = command.action === Action.AddCollateral;
    const { market, collateral, amount, side } = command.params;
    const value = collateral ?? amount;
    if (!market || !value) {
      return { success: false, error: err(`  Usage: ${isAdd ? 'add' : 'remove'} $50 ${isAdd ? 'to' : 'from'} SOL`) };
    }

    return {
      success: true,
      error: [
        '',
        `  ${accentBold(isAdd ? 'ADD COLLATERAL' : 'REMOVE COLLATERAL')}`,
        '',
        `  ${dim('Market:')}  ${market}${side ? ' ' + colorSide(side) : ''}`,
        `  ${dim('Amount:')}  ${formatUsd(value)}`,
        '',
        `  ${dim('[Phase 2]')}`,
        '',
      ].join('\n'),
    };
  }

  // ─── Order Handlers ─────────────────────────────────────────────────────

  private async handleOrder(command: ParsedCommand): Promise<TxResult> {
    return { success: true, error: dim(`  Order (${command.action}) — Phase 2`) };
  }

  // ─── Swap Handler (FULL PIPELINE) ──────────────────────────────────────

  private async handleSwap(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const metrics = getMetrics();
    const { inputToken, outputToken, amount } = command.params;

    if (!inputToken || !outputToken || !amount) {
      return { success: false, error: err('  Usage: swap 50 USDC to SOL') };
    }

    metrics.recordSwapAttempt();
    log.info('ENGINE', `Swap: ${amount} ${inputToken} → ${outputToken}`);

    // ─── STEP 1: Resolve swap pool ────────────────────────────────────
    const pool = resolveSwapPool(inputToken, outputToken);
    if (!pool) {
      return {
        success: false,
        error: err(`  No pool found with both ${inputToken} and ${outputToken}. Swap not supported.`),
      };
    }

    // ─── STEP 2: Build swap intent ────────────────────────────────────
    const intent: SwapIntent = {
      action: Action.Swap,
      inputToken,
      outputToken,
      amountIn: amount,
      slippageBps: this.config.defaultSlippageBps,
      pool,
    };

    // ─── STEP 3: Risk evaluation ──────────────────────────────────────
    const risk = await this.risk.evaluateSwap(intent);

    if (!risk.allowed) {
      log.warn('ENGINE', `Swap blocked: ${risk.summary}`);
      const lines = [
        '',
        `  ${err('SWAP BLOCKED')}`,
        '',
        ...risk.checks
          .filter(c => c.status !== 'SAFE')
          .map(c => `  ${c.status === 'BLOCKED' ? chalk.red('✗') : chalk.yellow('⚠')} ${c.message}`),
        '',
      ];
      return { success: false, error: lines.join('\n') };
    }

    // ─── STEP 4: Get API quote (timed for freshness) ────────────────────
    const startMs = Date.now();
    let timedQuote: TimedQuote | null = null;
    let quoteOutput = '?';
    let quoteFee = 0;
    let quotePayUsd = '';
    let quoteReceiveUsd = '';

    try {
      const quote = await this.api.getSwapQuote({
        inputTokenSymbol: inputToken,
        outputTokenSymbol: outputToken,
        inputAmountUi: String(amount),
      });

      if (quote.err) {
        audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, status: 'failed', error: quote.err });
        return { success: false, error: err(`  Swap quote failed: ${quote.err}`) };
      }

      quoteOutput = quote.outputAmountUi ?? quote.outputAmount ?? '?';
      quoteFee = quote.entryFee ?? 0;
      quotePayUsd = quote.youPayUsdUi ?? '';
      quoteReceiveUsd = quote.youReceiveUsdUi ?? '';

      const outputNum = parseFloat(quoteOutput);
      if (Number.isFinite(outputNum) && outputNum > 0) {
        timedQuote = {
          timestamp: Date.now(),
          outputAmount: outputNum,
          outputUsd: parseFloat(quoteReceiveUsd) || 0,
          fee: quoteFee,
          inputAmount: amount,
          inputToken,
          outputToken,
        };
      }

      log.debug('ENGINE', `Swap quote: ${amount} ${inputToken} → ${quoteOutput} ${outputToken}, fee=$${quoteFee}`);
    } catch (e) {
      if (!this.config.simulationMode && !this.config.devMode) {
        return { success: false, error: err(`  Swap quote failed: ${e instanceof Error ? e.message : String(e)}`) };
      }
    }

    // ─── STEP 5: Enhanced preview ───────────────────────────────────────
    const estFee = quoteFee > 0 ? quoteFee : amount * 0.0007;
    const quoteOutputNum = parseFloat(quoteOutput);

    // Calculate rate for display
    const rate = Number.isFinite(quoteOutputNum) && quoteOutputNum > 0
      ? (quoteOutputNum / amount).toFixed(6)
      : '—';
    const slippagePct = (this.config.defaultSlippageBps / 100).toFixed(2);
    const driftTolerance = '1.00'; // matches PRICE_DRIFT_THRESHOLD in quote-guard.ts

    const lines = [
      '',
      `  ${accentBold('SWAP PREVIEW')}`,
      `  ${dim('─'.repeat(52))}`,
      '',
      `  ${dim('Action:')}     ${chalk.bold('SWAP')}`,
      `  ${dim('From:')}       ${chalk.white.bold(String(amount))} ${chalk.white.bold(inputToken)}`,
      `  ${dim('To:')}         ${chalk.white.bold(quoteOutput)} ${chalk.white.bold(outputToken)}`,
      `  ${dim('Rate:')}       ${dim(`1 ${inputToken} = ${rate} ${outputToken}`)}`,
      `  ${dim('Pool:')}       ${dim(pool)}`,
      `  ${dim('Est. Fee:')}   ${chalk.yellow(formatUsd(estFee))} ${dim(`(${((estFee / amount) * 100).toFixed(3)}%)`)}`,
    ];

    if (quotePayUsd) lines.push(`  ${dim('You Pay:')}    ${dim('$' + quotePayUsd)}`);
    if (quoteReceiveUsd) lines.push(`  ${dim('You Get:')}    ${dim('$' + quoteReceiveUsd)}`);
    lines.push(
      `  ${dim('Slippage:')}   ${dim(`${slippagePct}%`)} ${dim(`(${this.config.defaultSlippageBps} bps)`)}`,
      `  ${dim('Max Drift:')}  ${dim(`${driftTolerance}%`)}`,
    );
    lines.push(`  ${dim('─'.repeat(52))}`);

    if (risk.mustConfirm) {
      for (const c of risk.checks.filter(c => c.status === 'WARNING')) {
        lines.push(`  ${chalk.yellow('⚠')} ${c.message}`);
      }
    }

    // ─── STEP 6: Execute (if not simulation mode) ─────────────────────
    if (this.config.simulationMode) {
      lines.push('', `  ${dim('[SIMULATION MODE — no real transaction]')}`, '');
      audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, outputAmount: timedQuote?.outputAmount, fees: estFee, status: 'preview', pool, slippageBps: this.config.defaultSlippageBps });
      log.success('ENGINE', `Swap preview: ${amount} ${inputToken} → ${quoteOutput} ${outputToken}`);
      return { success: true, error: lines.join('\n') };
    }

    if (!this.wallet.isConnected || !this.wallet.keypair) {
      lines.push('', `  ${err('Wallet not connected — cannot execute swap')}`, '');
      return { success: false, error: lines.join('\n') };
    }

    // ─── QUOTE FRESHNESS CHECK (TASK 2) ──────────────────────────────
    if (timedQuote) {
      const freshness = checkQuoteFreshness(timedQuote);
      if (!freshness.fresh) {
        audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, status: 'blocked', error: freshness.reason });
        return { success: false, error: err(`  ${freshness.reason}`) };
      }
    }

    // ─── BUILD TRANSACTION ────────────────────────────────────────────
    log.info('ENGINE', 'Building swap transaction...');
    let txBase64: string;
    try {
      const buildResult = await this.api.buildSwap({
        inputTokenSymbol: inputToken,
        outputTokenSymbol: outputToken,
        inputAmountUi: String(amount),
        owner: this.wallet.publicKey!.toBase58(),
        slippageBps: this.config.defaultSlippageBps,
      });

      if (buildResult.err) {
        audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, status: 'failed', error: buildResult.err });
        return { success: false, error: err(`  Swap build failed: ${buildResult.err}`) };
      }
      if (!buildResult.transactionBase64) {
        return { success: false, error: err('  API returned no transaction — cannot execute') };
      }

      // ─── PRICE DRIFT CHECK (TASK 1) ────────────────────────────────
      if (timedQuote) {
        const buildOutputNum = parseFloat(buildResult.outputAmountUi ?? '0');
        const drift = checkPriceDrift(timedQuote.outputAmount, buildOutputNum);
        if (!drift.acceptable) {
          audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, status: 'blocked', error: drift.reason });
          return { success: false, error: err(`  BLOCKED: ${drift.reason}`) };
        }
      }

      // ─── TX-LEVEL SLIPPAGE (TASK 3) ─────────────────────────────────
      // Flash API embeds slippageBps into the on-chain instruction as
      // `priceWithSlippage`. The program checks execution_price <= priceWithSlippage.
      // We already pass slippageBps to the API. The on-chain enforcement is
      // handled by the Flash program — the transaction will fail on-chain if
      // price moves beyond the slippage. This is verified by simulation.
      log.debug('ENGINE', `TX-level slippage: ${this.config.defaultSlippageBps}bps embedded by API`);

      txBase64 = buildResult.transactionBase64;
    } catch (e) {
      return { success: false, error: err(`  Swap build failed: ${e instanceof Error ? e.message : String(e)}`) };
    }

    // ─── PRE-EXECUTION STATE SNAPSHOT ─────────────────────────────────
    const consistency = new StateConsistency(this.state);
    const preSnapshot = await consistency.snapshot([inputToken, outputToken]);

    // ─── EXECUTE THROUGH PIPELINE ─────────────────────────────────────
    const tradeKey = `swap:${inputToken}:${outputToken}:${amount}`;
    const intentParams = { action: 'swap', inputToken, outputToken, amount, ts: Math.floor(Date.now() / 1000) };
    const rebuildFn = async (): Promise<string | null> => {
      try {
        const rebuild = await this.api.buildSwap({
          inputTokenSymbol: inputToken,
          outputTokenSymbol: outputToken,
          inputAmountUi: String(amount),
          owner: this.wallet.publicKey!.toBase58(),
          slippageBps: this.config.defaultSlippageBps,
        });
        return rebuild.transactionBase64 ?? null;
      } catch { return null; }
    };

    log.info('ENGINE', 'Executing swap through transaction pipeline...');
    const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, tradeKey, intentParams, rebuildFn);
    const durationMs = Date.now() - startMs;

    if (!txResult.success) {
      lines.push('', `  ${err('Swap execution failed:')} ${txResult.error}`, '');
      audit.log({ timestamp: new Date().toISOString(), action: 'swap', inputToken, outputToken, inputAmount: amount, txHash: txResult.signature, status: 'failed', error: txResult.error, durationMs, pool });
      return { success: false, error: lines.join('\n'), signature: txResult.signature };
    }

    // ─── POST-EXECUTION VERIFICATION ──────────────────────────────────
    const verifier = new PostVerifier(this.state);
    const verification = await verifier.verifyBalanceChange(outputToken, preSnapshot.balances.get(outputToken) ?? 0, 'increase');

    // ─── STATE CONSISTENCY CHECK (TASK 6) ─────────────────────────────
    const consistencyResult = await consistency.verifyAfterTrade(preSnapshot, [
      { type: 'balance_decrease', token: inputToken },
      { type: 'balance_increase', token: outputToken },
    ]);

    const auditStatus: AuditRecord['status'] = consistencyResult.consistent ? 'confirmed' : 'inconsistent';

    lines.push('');
    lines.push(`  ${chalk.green('✓')} Swap executed: ${txResult.signature?.slice(0, 16)}...`);

    if (verification.verified) {
      lines.push(`  ${dim(verification.details)}`);
    } else {
      lines.push(`  ${chalk.yellow('⚠')} ${verification.details}`);
      for (const w of verification.warnings) lines.push(`  ${dim(w)}`);
    }

    if (!consistencyResult.consistent) {
      lines.push(`  ${chalk.red('⚠ STATE INCONSISTENCY DETECTED')}`);
      for (const issue of consistencyResult.issues) lines.push(`  ${chalk.red('  ' + issue)}`);
    }
    lines.push('');

    // ─── AUDIT LOG ────────────────────────────────────────────────────
    audit.log({
      timestamp: new Date().toISOString(),
      action: 'swap',
      inputToken,
      outputToken,
      inputAmount: amount,
      outputAmount: timedQuote?.outputAmount,
      fees: estFee,
      txHash: txResult.signature,
      status: auditStatus,
      durationMs,
      pool,
      slippageBps: this.config.defaultSlippageBps,
      retryCount: txResult.retryCount,
    });

    metrics.recordSwapSuccess(durationMs);
    log.success('ENGINE', `Swap complete: ${txResult.signature?.slice(0, 16)}... (${durationMs}ms)`);

    return {
      success: true,
      signature: txResult.signature,
      fees: estFee,
      error: lines.join('\n'),
    };
  }

  // ─── LP Handler ───────────────────────────────────────────────────────

  private async handleLp(command: ParsedCommand): Promise<TxResult> {
    return { success: true, error: dim(`  LP (${command.action}) — Phase 4`) };
  }

  // ─── View Handlers ────────────────────────────────────────────────────

  private async handleViewPositions(): Promise<TxResult> {
    const positions = await this.state.getPositions();
    if (positions.length === 0) {
      return { success: true, error: dim('  No open positions') };
    }

    const header = `  ${pad('Market', 10)} ${pad('Side', 6)} ${pad('Lev', 6)} ${pad('Size', 12)} ${pad('Entry', 12)} ${pad('Mark', 12)} ${pad('PnL', 12)}`;
    const lines = [
      '',
      `  ${accentBold('POSITIONS')}`,
      '',
      dim(header),
      dim('  ' + '─'.repeat(70)),
    ];

    for (const p of positions) {
      lines.push(`  ${pad(p.market, 10)} ${pad(colorSide(p.side), 6)} ${pad(p.leverage + 'x', 6)} ${pad(formatUsd(p.sizeUsd), 12)} ${pad(formatPrice(p.entryPrice), 12)} ${pad(formatPrice(p.markPrice), 12)} ${pad(colorPnl(p.pnl), 12)}`);
    }

    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewPortfolio(): Promise<TxResult> {
    const positions = await this.state.getPositions();
    const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const totalSize = positions.reduce((sum, p) => sum + p.sizeUsd, 0);

    return {
      success: true,
      error: [
        '',
        `  ${accentBold('PORTFOLIO')}`,
        '',
        `  ${dim('Positions:')}   ${positions.length}`,
        `  ${dim('Total Size:')}  ${formatUsd(totalSize)}`,
        `  ${dim('Total PnL:')}   ${colorPnl(totalPnl)}`,
        '',
      ].join('\n'),
    };
  }

  private async handleViewMarkets(): Promise<TxResult> {
    const markets = await this.state.getMarkets();

    const lines = [
      '',
      `  ${accentBold('MARKETS')}  ${dim(`(${markets.length} available)`)}`,
      '',
      dim(`  ${pad('Symbol', 10)} ${pad('Pool', 16)} ${pad('Max Lev', 10)} ${pad('Status', 8)}`),
      dim('  ' + '─'.repeat(50)),
    ];

    for (const m of markets) {
      const status = m.isOpen ? ok('OPEN') : err('CLOSED');
      lines.push(`  ${pad(m.symbol, 10)} ${pad(m.pool, 16)} ${pad(m.maxLeverage + 'x', 10)} ${status}`);
    }

    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewMarket(command: ParsedCommand): Promise<TxResult> {
    const symbol = command.params.symbol;
    if (!symbol) return { success: false, error: err('  Usage: market SOL') };

    const market = await this.state.getMarket(symbol);
    if (!market) return { success: false, error: err(`  Market not found: ${symbol}`) };

    return {
      success: true,
      error: [
        '',
        `  ${accentBold(market.symbol)}  ${dim(market.pool)}`,
        '',
        `  ${dim('Price:')}         ${formatPrice(market.price)}`,
        `  ${dim('24h Change:')}    ${colorPercent(market.change24h)}`,
        `  ${dim('Max Leverage:')}  ${market.maxLeverage}x`,
        `  ${dim('OI Long:')}       ${formatUsd(market.oiLong)}`,
        `  ${dim('OI Short:')}      ${formatUsd(market.oiShort)}`,
        `  ${dim('Funding:')}       ${market.fundingRate.toFixed(4)}%/hr`,
        `  ${dim('Status:')}        ${market.isOpen ? ok('OPEN') : err('CLOSED')}`,
        '',
      ].join('\n'),
    };
  }

  private async handleViewPrices(command: ParsedCommand): Promise<TxResult> {
    if (command.params.symbol) {
      const price = await this.state.getPrice(command.params.symbol);
      return {
        success: true,
        error: `\n  ${command.params.symbol}: ${formatPrice(price)}\n`,
      };
    }

    return { success: true, error: dim('  Price feed — connect API in Phase 2') };
  }

  private async handleViewPools(): Promise<TxResult> {
    const pools = await this.state.getPools();

    const lines = [
      '',
      `  ${accentBold('POOLS')}`,
      '',
      dim(`  ${pad('Name', 16)} ${pad('Assets', 30)} ${pad('Markets', 10)}`),
      dim('  ' + '─'.repeat(60)),
    ];

    for (const p of pools) {
      lines.push(`  ${pad(p.name, 16)} ${pad(p.assets.join(', '), 30)} ${pad(String(p.markets), 10)}`);
    }

    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewBalance(): Promise<TxResult> {
    return { success: true, error: dim('  Wallet balance — connect wallet in Phase 2') };
  }

  // ─── Trade History ────────────────────────────────────────────────────

  private handleTradeHistory(): TxResult {
    const audit = getAuditLog();
    const records = audit.readRecent(20);

    if (records.length === 0) {
      return { success: true, error: dim('  No trade history yet.') };
    }

    const lines = [
      '',
      `  ${accentBold('TRADE HISTORY')}  ${dim(`(last ${records.length})`)}`,
      '',
      dim(`  ${pad('Time', 12)} ${pad('Action', 8)} ${pad('Market', 10)} ${pad('Amount', 12)} ${pad('Status', 12)} ${pad('Tx', 16)}`),
      dim('  ' + '─'.repeat(74)),
    ];

    for (const r of records.reverse()) {
      const time = r.timestamp.slice(11, 19); // HH:mm:ss
      const action = (r.action ?? '').slice(0, 7);
      const market = r.market ?? r.inputToken ?? '';
      const amount = r.inputAmount != null ? formatUsd(r.inputAmount) : '—';
      const statusColor = r.status === 'confirmed' ? ok(r.status)
        : r.status === 'failed' || r.status === 'blocked' ? err(r.status)
        : r.status === 'inconsistent' ? chalk.red(r.status)
        : dim(r.status);
      const tx = r.txHash ? r.txHash.slice(0, 12) + '...' : dim('—');

      lines.push(`  ${dim(time)} ${pad(action, 8)} ${pad(market, 10)} ${pad(amount, 12)} ${pad(statusColor, 12)} ${tx}`);
    }

    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  // ─── Stats Command ────────────────────────────────────────────────────

  private handleStats(): TxResult {
    const m = getMetrics().snapshot();
    const totalAttempted = m.tradesAttempted + m.swapsAttempted;
    const totalSucceeded = m.tradesSucceeded + m.swapsSucceeded;
    const successRate = totalAttempted > 0
      ? ((totalSucceeded / totalAttempted) * 100).toFixed(1)
      : '—';
    const failRate = totalAttempted > 0
      ? (((m.tradesFailed + (m.swapsAttempted - m.swapsSucceeded)) / totalAttempted) * 100).toFixed(1)
      : '—';
    const uptimeMin = Math.floor(m.uptimeMs / 60_000);
    const uptimeHr = Math.floor(uptimeMin / 60);

    const lines = [
      '',
      `  ${accentBold('EXECUTION STATS')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Perp Trades')}`,
      `    ${dim('Attempted:')}  ${m.tradesAttempted}`,
      `    ${dim('Succeeded:')}  ${ok(String(m.tradesSucceeded))}`,
      `    ${dim('Failed:')}     ${m.tradesFailed > 0 ? err(String(m.tradesFailed)) : dim('0')}`,
      `    ${dim('Blocked:')}    ${m.tradesBlocked > 0 ? warn(String(m.tradesBlocked)) : dim('0')}`,
      '',
      `  ${dim('Swaps')}`,
      `    ${dim('Attempted:')}  ${m.swapsAttempted}`,
      `    ${dim('Succeeded:')}  ${ok(String(m.swapsSucceeded))}`,
      '',
      `  ${dim('Overall')}`,
      `    ${dim('Success Rate:')} ${totalSucceeded > 0 ? ok(successRate + '%') : dim(successRate)}`,
      `    ${dim('Fail Rate:')}    ${failRate !== '—' && parseFloat(failRate) > 0 ? err(failRate + '%') : dim(failRate)}`,
      `    ${dim('Avg Exec:')}     ${m.avgExecutionMs > 0 ? `${m.avgExecutionMs}ms` : dim('—')}`,
      `    ${dim('Last Trade:')}   ${m.lastTradeAt ? dim(m.lastTradeAt) : dim('None')}`,
      `    ${dim('Uptime:')}       ${uptimeHr > 0 ? `${uptimeHr}h ${uptimeMin % 60}m` : `${uptimeMin}m`}`,
      `  ${dim('─'.repeat(48))}`,
      '',
    ];

    return { success: true, error: lines.join('\n') };
  }

  // ─── System Handlers ──────────────────────────────────────────────────

  private async handleHealth(): Promise<TxResult> {
    const log = getLogger();
    const lines = [
      '',
      `  ${accentBold('SYSTEM HEALTH')}`,
      '',
      `  ${dim('Mode:')}       ${this.config.simulationMode ? warn('SIMULATION') : ok('LIVE')}`,
    ];
    if (this.config.devMode) {
      lines.push(`  ${dim('Dev Mode:')}   ${chalk.magenta.bold('ACTIVE')}`);
    }
    lines.push(
      `  ${dim('Network:')}    ${this.config.network}`,
      `  ${dim('API:')}        ${this.config.flashApiUrl}`,
      `  ${dim('Wallet:')}     ${this.wallet.isConnected ? ok(this.wallet.shortAddress) : warn('Not connected')}`,
      `  ${dim('Max Lev:')}    ${this.config.maxLeverage}x`,
      `  ${dim('Max Size:')}   ${formatUsd(this.config.maxPositionSize)}`,
    );

    // Try real API health check
    try {
      const health = await this.api.health();
      lines.push(`  ${dim('API Status:')} ${ok(String(health.status ?? 'OK'))}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`  ${dim('API Status:')} ${err('UNREACHABLE')} ${dim(msg.substring(0, 40))}`);
      log.warn('HEALTH', `API unreachable: ${msg}`);
    }

    // RPC endpoint health
    if (this.rpcManager) {
      lines.push('');
      lines.push(`  ${accentBold('RPC ENDPOINTS')}`);
      const rpcHealth = this.rpcManager.getHealthSummary();
      for (const ep of rpcHealth) {
        const status = ep.healthy ? ok('OK') : err('DOWN');
        const active = ep.active ? chalk.cyan(' ◀') : '';
        const latStr = ep.latencyMs > 0 ? `${ep.latencyMs}ms` : '—';
        lines.push(`  ${dim('  ')}${pad(ep.url, 32)} ${status} ${dim(`lat=${latStr}`)} ${dim(`lag=${ep.lag}`)}${active}`);
      }
    }

    // Execution metrics
    const m = getMetrics().snapshot();
    if (m.tradesAttempted > 0 || m.swapsAttempted > 0) {
      lines.push('');
      lines.push(`  ${accentBold('METRICS')}`);
      lines.push(`  ${dim('Trades:')}     ${m.tradesSucceeded}/${m.tradesAttempted} succeeded, ${m.tradesBlocked} blocked`);
      lines.push(`  ${dim('Swaps:')}      ${m.swapsSucceeded}/${m.swapsAttempted} succeeded`);
      if (m.avgExecutionMs > 0) lines.push(`  ${dim('Avg Exec:')}   ${m.avgExecutionMs}ms`);
      if (m.lastTradeAt) lines.push(`  ${dim('Last Trade:')} ${m.lastTradeAt}`);
      const uptimeMin = Math.floor(m.uptimeMs / 60_000);
      lines.push(`  ${dim('Uptime:')}     ${uptimeMin}m`);
    }

    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  private handleHelp(): TxResult {
    const lines = [
      '',
      `  ${accentBold('flash')} — Flash Trade Protocol CLI`,
      '',
      `  ${chalk.cyan('TRADING')}`,
      `    long SOL 10x $100          Open long position`,
      `    short ETH 5x $50           Open short position`,
      `    close SOL                  Close position`,
      `    close SOL 50%              Partial close`,
      `    add $50 to SOL             Add collateral`,
      `    remove $50 from SOL        Remove collateral`,
      `    reverse SOL                Flip position`,
      '',
      `  ${chalk.cyan('ORDERS')}`,
      `    set tp SOL 200             Set take profit`,
      `    set sl SOL 170             Set stop loss`,
      `    limit long SOL 10x $100 at $180`,
      '',
      `  ${chalk.cyan('SWAP')}`,
      `    swap 50 USDC to SOL        Spot swap`,
      '',
      `  ${chalk.cyan('LP / EARN')}`,
      `    deposit 500 USDC into Crypto.1`,
      `    withdraw 100 USDC from Crypto.1`,
      `    collect Crypto.1           Collect LP fees`,
      '',
      `  ${chalk.cyan('VIEW')}`,
      `    positions / pos            View positions`,
      `    portfolio / pf             Portfolio overview`,
      `    markets                    All markets`,
      `    market SOL                 Market detail`,
      `    prices                     Price feed`,
      `    pools                      Pool overview`,
      `    balance                    Wallet balance`,
      `    trades / history           Trade history`,
      `    stats                      Execution statistics`,
      '',
      `  ${chalk.cyan('SYSTEM')}`,
      `    health                     System status`,
      `    wallet create|import|list|use`,
      `    config <key> <value>       Set config`,
      '',
      `  ${chalk.cyan('FLAGS')}`,
      `    --tp <price>               Take profit`,
      `    --sl <price>               Stop loss`,
      `    --degen                    Degen mode (up to 500x)`,
      `    --dry-run                  Simulate without executing`,
      `    --json                     JSON output`,
      '',
    ];
    return { success: true, error: lines.join('\n') };
  }

  private handleConfig(command: ParsedCommand): TxResult {
    const { key, value } = command.params;
    if (!key) {
      return {
        success: true,
        error: [
          '',
          `  ${accentBold('CONFIG')}`,
          '',
          `  ${dim('Simulation:')}  ${this.config.simulationMode}`,
          `  ${dim('Network:')}     ${this.config.network}`,
          `  ${dim('Max Lev:')}     ${this.config.maxLeverage}x`,
          `  ${dim('Max Collateral:')} ${formatUsd(this.config.maxCollateralPerTrade)}`,
          `  ${dim('Max Size:')}    ${formatUsd(this.config.maxPositionSize)}`,
          `  ${dim('Slippage:')}    ${this.config.defaultSlippageBps} bps`,
          '',
        ].join('\n'),
      };
    }
    return { success: true, error: dim(`  Config set: ${key} = ${value}`) };
  }

  // ─── Formatting ───────────────────────────────────────────────────────

  private formatSuggestion(command: ParsedCommand): string {
    const { action, params } = command;
    const parts: string[] = [];

    switch (action) {
      case Action.OpenPosition:
        parts.push(`${params.side?.toLowerCase() ?? 'long'} ${params.market ?? '?'} ${params.leverage ?? 2}x $${params.collateral ?? '?'}`);
        break;
      case Action.ClosePosition:
        parts.push(`close ${params.market ?? '?'}`);
        break;
      case Action.Swap:
        parts.push(`swap ${params.amount ?? '?'} ${params.inputToken ?? '?'} to ${params.outputToken ?? '?'}`);
        break;
      default:
        parts.push(action);
    }

    return [
      '',
      `  ${warn('Did you mean:')} ${chalk.white(parts.join(' '))}`,
      `  ${dim(`(confidence: ${(command.confidence * 100).toFixed(0)}% via ${command.source})`)}`,
      `  ${dim('Type the command above to execute, or rephrase.')}`,
      '',
    ].join('\n');
  }

  private formatUnknown(raw: string): string {
    return [
      '',
      `  ${err('Unknown command:')} ${raw}`,
      `  ${dim('Type "help" for available commands.')}`,
      '',
    ].join('\n');
  }
}

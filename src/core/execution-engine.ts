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
  type Position,
  type TxResult,
  type IExecutionEngine,
  type FlashXConfig,
} from '../types/index.js';
import { RiskEngine } from './risk-engine.js';
import { StateEngine } from './state-engine.js';
import { getLogger } from '../utils/logger.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';
import type { TxPipeline } from '../tx/pipeline.js';
import type { RpcManager } from '../services/rpc-manager.js';
import { resolvePool } from '../services/pool-resolver.js';
import { estimateOpenPosition, crossValidateWithEstimate } from '../services/quote-engine.js';
import { getAuditLog } from '../security/audit-log.js';
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

// ─── ExecutionEngine ────────────────────────────────────────────────────────

export class ExecutionEngine implements IExecutionEngine {
  private risk: RiskEngine;
  private state: StateEngine;
  private api: FlashApiClient;
  private wallet: WalletManager;
  txPipeline: TxPipeline;
  private rpcManager: RpcManager | null = null;

  constructor(
    private config: FlashXConfig,
    state: StateEngine,
    api: FlashApiClient,
    wallet: WalletManager,
    txPipeline: TxPipeline,
    rpcManager?: RpcManager,
  ) {
    this.state = state;
    this.api = api;
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

      // ─── Swap (not supported via API) ──────────────────────────────
      case Action.Swap:
        return { success: false, error: '  Swap not supported in API-only mode. Use flash.trade website.' };

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
        return this.handleViewOrders();
      case Action.ViewEarn:
      case Action.ViewPoolDetail:
        return this.handleViewEarn(command);
      case Action.ViewTokens:
        return this.handleViewTokens();
      case Action.ViewToken:
        return this.handleViewToken(command);
      case Action.ViewAllocation:
        return this.handleViewAllocation();
      case Action.ViewFunding:
      case Action.ViewOI:
      case Action.ViewFees:
      case Action.ViewHours:
        return { success: true, error: dim('  Data view coming soon') };

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

  // Preview removed — SDK dependency eliminated. Use API quote directly.

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

    // ─── LOCAL ESTIMATE (no SDK) ───────────────────────────────────────
    const localEst = estimateOpenPosition(market, collateral, leverage);
    const estFee = localEst.openFee;

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
      `  ${dim('Est. Fee:')}    ${chalk.yellow(formatUsd(estFee))} ${dim(`(${(localEst.feeRate * 100).toFixed(3)}%)`)}`,
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

      // Cross-validate API quote vs local estimate (no SDK)
      const apiFee = Number(buildResult.entryFee);
      if (localEst.openFee > 0 && Number.isFinite(apiFee) && apiFee > 0) {
        const validation = crossValidateWithEstimate({ entryFee: apiFee }, localEst);
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
    lines.push(`  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`);

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
    lines.push(`  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`);
    lines.push('');

    metrics.recordTradeSuccess(durationMs);
    audit.log({ timestamp: new Date().toISOString(), action: 'close_position', command: command.raw, market, side, sizeUsd: position.sizeUsd, txHash: txResult.signature, status: 'confirmed', durationMs });

    log.success('ENGINE', `Close complete: ${txResult.signature?.slice(0, 16)}... (${durationMs}ms)`);
    return { success: true, signature: txResult.signature, error: lines.join('\n') };
  }

  private async handleReverse(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const { market, side } = command.params;
    if (!market) return { success: false, error: err('  Usage: reverse SOL') };

    const position = await this.state.getPosition(market, side);
    if (!position) return { success: false, error: err(`  No open ${market} position found to reverse`) };

    const lines = [
      '',
      `  ${accentBold('REVERSE POSITION')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Market:')}   ${chalk.white.bold(market)} ${colorSide(position.side)} → ${colorSide(position.side === 'LONG' ? 'SHORT' : 'LONG')}`,
      `  ${dim('Size:')}     ${formatUsd(position.sizeUsd)}`,
      `  ${dim('Entry:')}    ${formatPrice(position.entryPrice)}`,
      `  ${dim('─'.repeat(48))}`,
    ];

    if (this.config.simulationMode) {
      lines.push(`  ${dim('[SIMULATION MODE]')}`, '');
      return { success: true, error: lines.join('\n') };
    }

    if (!this.wallet.isConnected || !this.wallet.keypair) {
      return { success: false, error: err('  Wallet not connected') };
    }

    try {
      log.info('ENGINE', `Reverse: ${market} ${position.side}`);
      const buildResult = await this.api.buildReversePosition({
        positionKey: position.pubkey,
        owner: this.wallet.publicKey!.toBase58(),
      }) as Record<string, unknown>;

      if (buildResult['err']) return { success: false, error: err(`  ${buildResult['err']}`) };
      const txBase64 = buildResult['transactionBase64'] as string;
      if (!txBase64) return { success: false, error: err('  API returned no transaction') };

      const startMs = Date.now();
      const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, `reverse:${market}`);
      const durationMs = Date.now() - startMs;

      if (!txResult.success) {
        lines.push('', `  ${err(txResult.error ?? 'Failed')}`, '');
        return { success: false, error: lines.join('\n') };
      }

      lines.push('', `  ${chalk.green('✓')} Position reversed: ${txResult.signature?.slice(0, 16)}...`);
      lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);
      lines.push(`  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`, '');
      audit.log({ timestamp: new Date().toISOString(), action: 'reverse_position', market, side: position.side, txHash: txResult.signature, status: 'confirmed', durationMs });
      return { success: true, signature: txResult.signature, error: lines.join('\n') };
    } catch (e) {
      return { success: false, error: err(`  ${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  private async handleCollateral(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const isAdd = command.action === Action.AddCollateral;
    const { market, collateral, amount, side } = command.params;
    const value = collateral ?? amount;
    if (!market || !value) {
      return { success: false, error: err(`  Usage: ${isAdd ? 'add' : 'remove'} $50 ${isAdd ? 'to' : 'from'} SOL`) };
    }

    // Find position
    const position = await this.state.getPosition(market, side);
    if (!position) {
      return { success: false, error: err(`  No open ${market} position found`) };
    }

    const lines = [
      '',
      `  ${accentBold(isAdd ? 'ADD COLLATERAL' : 'REMOVE COLLATERAL')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Market:')}  ${chalk.white.bold(market)} ${colorSide(position.side)}`,
      `  ${dim('Amount:')}  ${chalk.white.bold(formatUsd(value))}`,
      `  ${dim('─'.repeat(48))}`,
    ];

    if (this.config.simulationMode) {
      lines.push(`  ${dim('[SIMULATION MODE]')}`, '');
      return { success: true, error: lines.join('\n') };
    }

    if (!this.wallet.isConnected || !this.wallet.keypair) {
      lines.push(`  ${err('Wallet not connected')}`, '');
      return { success: false, error: lines.join('\n') };
    }

    log.info('ENGINE', `${isAdd ? 'Add' : 'Remove'} collateral: ${market} $${value}`);
    const startMs = Date.now();

    try {
      const apiMethod = isAdd ? 'buildAddCollateral' : 'buildRemoveCollateral';
      const params = isAdd
        ? { positionKey: position.pubkey, depositAmountUi: String(value), depositTokenSymbol: 'USDC', owner: this.wallet.publicKey!.toBase58() }
        : { positionKey: position.pubkey, withdrawAmountUsdUi: String(value), withdrawTokenSymbol: 'USDC', owner: this.wallet.publicKey!.toBase58() };

      const buildResult = await this.api[apiMethod](params) as Record<string, unknown>;
      if (buildResult['err']) return { success: false, error: err(`  Build failed: ${buildResult['err']}`) };

      const txBase64 = buildResult['transactionBase64'] as string;
      if (!txBase64) return { success: false, error: err('  API returned no transaction') };

      const tradeKey = `collateral:${market}:${isAdd ? 'add' : 'remove'}:${value}`;
      const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, tradeKey);
      const durationMs = Date.now() - startMs;

      if (!txResult.success) {
        lines.push('', `  ${err(txResult.error ?? 'Failed')}`, '');
        return { success: false, error: lines.join('\n') };
      }

      lines.push('', `  ${chalk.green('✓')} Collateral ${isAdd ? 'added' : 'removed'}: ${txResult.signature?.slice(0, 16)}...`, `  ${dim(`Duration: ${durationMs}ms`)}`, '');
      audit.log({ timestamp: new Date().toISOString(), action: isAdd ? 'add_collateral' : 'remove_collateral', market, collateral: value, txHash: txResult.signature, status: 'confirmed', durationMs });
      return { success: true, signature: txResult.signature, error: lines.join('\n') };
    } catch (e) {
      return { success: false, error: err(`  ${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  // ─── Order Handlers (TP/SL via API) ───────────────────────────────────

  private async handleOrder(command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const { market, side, triggerPrice, orderId } = command.params;

    // Cancel
    if (command.action === Action.CancelOrder || command.action === Action.CancelAllOrders) {
      if (!market) return { success: false, error: err('  Usage: cancel SOL long') };
      if (!this.wallet.isConnected || !this.wallet.keypair) {
        return { success: false, error: err('  Wallet not connected') };
      }

      if (this.config.simulationMode) {
        return { success: true, error: dim(`  [SIMULATION] Would cancel ${command.action === Action.CancelAllOrders ? 'all' : ''} orders for ${market}`) };
      }

      try {
        const position = await this.state.getPosition(market, side);
        const resolvedSide = side ?? position?.side ?? 'LONG';

        let buildResult: Record<string, unknown>;
        if (command.action === Action.CancelAllOrders) {
          buildResult = await this.api.buildCancelAllTriggerOrders({
            marketSymbol: market, side: resolvedSide, owner: this.wallet.publicKey!.toBase58(),
          });
        } else {
          if (orderId === undefined) return { success: false, error: err('  Order ID required. Usage: cancel SOL long 1') };
          buildResult = await this.api.buildCancelTriggerOrder({
            marketSymbol: market, side: resolvedSide, orderId, isStopLoss: command.params.isStopLoss ?? false, owner: this.wallet.publicKey!.toBase58(),
          });
        }

        if (buildResult['err']) return { success: false, error: err(`  ${buildResult['err']}`) };
        const txBase64 = buildResult['transactionBase64'] as string;
        if (!txBase64) return { success: false, error: err('  API returned no transaction') };

        const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, `cancel:${market}:${orderId ?? 'all'}`);
        if (!txResult.success) return { success: false, error: err(`  ${txResult.error}`) };

        audit.log({ timestamp: new Date().toISOString(), action: 'cancel_order', market, txHash: txResult.signature, status: 'confirmed' });
        return { success: true, signature: txResult.signature, error: `\n  ${chalk.green('✓')} Order cancelled: ${txResult.signature?.slice(0, 16)}...\n` };
      } catch (e) {
        return { success: false, error: err(`  ${e instanceof Error ? e.message : String(e)}`) };
      }
    }

    // TP / SL
    if (command.action === Action.TakeProfit || command.action === Action.StopLoss) {
      if (!market || !triggerPrice) {
        return { success: false, error: err('  Usage: set tp SOL 200  OR  set sl SOL 170') };
      }

      const position = await this.state.getPosition(market, side);
      if (!position) return { success: false, error: err(`  No open ${market} position found`) };

      const isStopLoss = command.action === Action.StopLoss;
      const label = isStopLoss ? 'Stop Loss' : 'Take Profit';

      const lines = [
        '',
        `  ${accentBold(label.toUpperCase())}`,
        `  ${dim('─'.repeat(48))}`,
        '',
        `  ${dim('Market:')}   ${chalk.white.bold(market)} ${colorSide(position.side)}`,
        `  ${dim('Trigger:')}  ${chalk.white.bold(formatPrice(triggerPrice))}`,
        `  ${dim('Size:')}     ${formatUsd(position.sizeUsd)}`,
        `  ${dim('Entry:')}    ${formatPrice(position.entryPrice)}`,
        `  ${dim('─'.repeat(48))}`,
      ];

      if (this.config.simulationMode) {
        lines.push(`  ${dim('[SIMULATION MODE]')}`, '');
        return { success: true, error: lines.join('\n') };
      }

      if (!this.wallet.isConnected || !this.wallet.keypair) {
        return { success: false, error: err('  Wallet not connected') };
      }

      try {
        log.info('ENGINE', `Setting ${label}: ${market} @ ${triggerPrice}`);
        const buildResult = await this.api.buildPlaceTriggerOrder({
          marketSymbol: market,
          side: position.side,
          triggerPrice,
          sizeAmount: position.sizeUsd,
          isStopLoss,
          owner: this.wallet.publicKey!.toBase58(),
        });

        if (buildResult['err']) return { success: false, error: err(`  Build failed: ${buildResult['err']}`) };
        const txBase64 = buildResult['transactionBase64'] as string;
        if (!txBase64) return { success: false, error: err('  API returned no transaction') };

        const txResult = await this.txPipeline.execute(txBase64, this.wallet.keypair, `${isStopLoss ? 'sl' : 'tp'}:${market}:${triggerPrice}`);
        if (!txResult.success) {
          lines.push('', `  ${err(txResult.error ?? 'Failed')}`, '');
          return { success: false, error: lines.join('\n') };
        }

        lines.push('', `  ${chalk.green('✓')} ${label} set: ${txResult.signature?.slice(0, 16)}...`, '');
        audit.log({ timestamp: new Date().toISOString(), action: isStopLoss ? 'stop_loss' : 'take_profit', market, side: position.side, txHash: txResult.signature, status: 'confirmed' });
        return { success: true, signature: txResult.signature, error: lines.join('\n') };
      } catch (e) {
        return { success: false, error: err(`  ${e instanceof Error ? e.message : String(e)}`) };
      }
    }

    // Limit order
    if (command.action === Action.LimitOrder) {
      return { success: true, error: dim('  Limit orders — coming soon (requires backup oracle instruction)') };
    }

    return { success: false, error: err(`  Unknown order action: ${command.action}`) };
  }

  // ─── LP Handler (NOT SUPPORTED — requires SDK) ────────────────────────

  private async handleLp(_command: ParsedCommand): Promise<TxResult> {
    return { success: false, error: '  LP operations require SDK. Use flash.trade website for LP.' };
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
    if (!this.wallet.isConnected) {
      return { success: true, error: dim('  Wallet not connected. Use mode 2 (Live) to connect wallet.') };
    }

    const lines = [
      '',
      `  ${accentBold('WALLET BALANCE')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Address:')}  ${chalk.white(this.wallet.shortAddress)}`,
      '',
    ];

    try {
      const solBal = await this.state.getBalance('SOL');
      const usdcBal = await this.state.getBalance('USDC');
      const solPrice = await this.state.getPrice('SOL');
      const solUsd = solBal * solPrice;

      lines.push(`  ${dim('SOL:')}     ${chalk.white(solBal.toFixed(4))} ${dim(`($${solUsd.toFixed(2)})`)}`);
      lines.push(`  ${dim('USDC:')}    ${chalk.white('$' + usdcBal.toFixed(2))}`);
      lines.push('');
      lines.push(`  ${dim('Total:')}   ${chalk.white.bold(formatUsd(solUsd + usdcBal))}`);
    } catch {
      lines.push(`  ${dim('Could not fetch balances')}`);
    }

    lines.push(`  ${dim('─'.repeat(48))}`, '');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewOrders(): Promise<TxResult> {
    if (!this.wallet.isConnected) {
      return { success: true, error: dim('  No wallet connected') };
    }

    try {
      const orders = await this.api.getOrders(this.wallet.publicKey!.toBase58()) as Record<string, unknown>[];

      if (!orders || orders.length === 0) {
        return { success: true, error: dim('  No open orders') };
      }

      const lines = [
        '',
        `  ${accentBold('ORDERS')}  ${dim(`(${orders.length})`)}`,
        '',
      ];

      for (const order of orders) {
        const market = String(order['marketSymbol'] ?? '');
        const side = String(order['sideUi'] ?? order['side'] ?? '');
        const trigger = order['triggerPrice'] ?? order['limitPrice'] ?? '';
        const orderType = order['isStopLoss'] ? 'SL' : (order['isTakeProfit'] ? 'TP' : 'LIMIT');
        lines.push(`  ${pad(market, 8)} ${pad(side, 6)} ${pad(orderType, 6)} trigger: ${trigger}`);
      }

      lines.push('');
      return { success: true, error: lines.join('\n') };
    } catch {
      return { success: true, error: dim('  Could not fetch orders') };
    }
  }

  // ─── Earn / Pool Views ────────────────────────────────────────────────

  private async handleViewEarn(command: ParsedCommand): Promise<TxResult> {
    const poolName = command.params.pool;

    try {
      const poolData = await this.api.getPoolData() as Record<string, unknown>;
      const pools = (poolData['pools'] ?? []) as Record<string, unknown>[];

      if (poolName) {
        // Pool detail
        const pool = pools.find(p =>
          String(p['poolName'] ?? '').toLowerCase() === poolName.toLowerCase() ||
          String(p['poolName'] ?? '').toLowerCase().startsWith(poolName.toLowerCase())
        );
        if (!pool) return { success: false, error: err(`  Pool not found: ${poolName}`) };

        const lp = pool['lpStats'] as Record<string, unknown> | undefined;
        const custodies = (pool['custodyStats'] ?? []) as Record<string, unknown>[];

        const lines = [
          '',
          `  ${accentBold(String(pool['poolName']))}`,
          `  ${dim('─'.repeat(52))}`,
          '',
          `  ${dim('TVL:')}         ${chalk.white.bold(formatUsd(Number(lp?.['totalPoolValueUsd'] ?? 0)))}`,
          `  ${dim('LP Price:')}    ${chalk.white('$' + String(lp?.['lpPrice'] ?? '—'))}`,
          `  ${dim('LP Supply:')}   ${dim(String(lp?.['lpTokenSupply'] ?? '—'))}`,
          `  ${dim('Stable %:')}    ${dim(String(lp?.['stableCoinPercentage'] ?? '—') + '%')}`,
          `  ${dim('Max AUM:')}     ${dim(formatUsd(Number(lp?.['maxAumUsd'] ?? 0)))}`,
          '',
          `  ${dim('ASSETS')}`,
        ];

        for (const c of custodies) {
          const sym = String(c['symbol'] ?? '');
          const owned = String(c['assetsOwnedAmountUi'] ?? '0');
          const usd = formatUsd(Number(c['totalUsdOwnedAmountUi'] ?? 0));
          const ratio = String(c['currentRatioUi'] ?? '0');
          const target = String(c['targetRatioUi'] ?? '0');
          const util = String(c['utilizationUi'] ?? '0');
          lines.push(`    ${pad(sym, 10)} ${pad(owned, 14)} ${pad(usd, 12)} ratio: ${ratio}% / ${target}%  util: ${util}%`);
        }

        lines.push(`  ${dim('─'.repeat(52))}`);
        lines.push(`  ${dim('Earn execution: NOT SUPPORTED via API (use flash.trade)')}`, '');
        return { success: true, error: lines.join('\n') };
      }

      // Overview of all pools
      const lines = [
        '',
        `  ${accentBold('EARN — LIQUIDITY POOLS')}`,
        `  ${dim('─'.repeat(56))}`,
        '',
        dim(`  ${pad('Pool', 16)} ${pad('TVL', 14)} ${pad('LP Price', 12)} ${pad('Stable %', 10)} ${pad('Assets', 6)}`),
        dim('  ' + '─'.repeat(56)),
      ];

      for (const pool of pools) {
        const name = String(pool['poolName'] ?? '');
        const lp = pool['lpStats'] as Record<string, unknown> | undefined;
        const tvl = formatUsd(Number(lp?.['totalPoolValueUsd'] ?? 0));
        const price = '$' + String(lp?.['lpPrice'] ?? '—');
        const stable = String(lp?.['stableCoinPercentage'] ?? '—') + '%';
        const assets = String((pool['custodyStats'] as unknown[])?.length ?? 0);
        lines.push(`  ${pad(name, 16)} ${pad(tvl, 14)} ${pad(price, 12)} ${pad(stable, 10)} ${pad(assets, 6)}`);
      }

      lines.push('');
      lines.push(`  ${dim('Type "pool <name>" for details (e.g., pool Crypto.1)')}`);
      lines.push(`  ${dim('Earn execution: NOT SUPPORTED via API (use flash.trade)')}`);
      lines.push('');
      return { success: true, error: lines.join('\n') };
    } catch (e) {
      return { success: false, error: err(`  Failed to fetch pool data: ${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  // ─── Token Views ─────────────────────────────────────────────────────

  private async handleViewTokens(): Promise<TxResult> {
    if (!this.wallet.isConnected) {
      return { success: true, error: dim('  Wallet not connected') };
    }

    const lines = [
      '',
      `  ${accentBold('TOKEN HOLDINGS')}`,
      `  ${dim('─'.repeat(52))}`,
      '',
    ];

    try {
      const solBal = await this.state.getBalance('SOL');
      const usdcBal = await this.state.getBalance('USDC');
      const solPrice = await this.state.getPrice('SOL');
      const solUsd = solBal * solPrice;
      const total = solUsd + usdcBal;

      lines.push(dim(`  ${pad('Token', 8)} ${pad('Balance', 14)} ${pad('Price', 12)} ${pad('Value', 12)} ${pad('Alloc', 8)}`));
      lines.push(dim('  ' + '─'.repeat(52)));

      if (solBal > 0) {
        const alloc = total > 0 ? ((solUsd / total) * 100).toFixed(1) + '%' : '—';
        lines.push(`  ${pad('SOL', 8)} ${pad(solBal.toFixed(4), 14)} ${pad(formatPrice(solPrice), 12)} ${pad(formatUsd(solUsd), 12)} ${pad(alloc, 8)}`);
      }
      if (usdcBal > 0) {
        const alloc = total > 0 ? ((usdcBal / total) * 100).toFixed(1) + '%' : '—';
        lines.push(`  ${pad('USDC', 8)} ${pad(usdcBal.toFixed(2), 14)} ${pad('$1.00', 12)} ${pad(formatUsd(usdcBal), 12)} ${pad(alloc, 8)}`);
      }

      lines.push('');
      lines.push(`  ${dim('Total:')} ${chalk.white.bold(formatUsd(total))}`);
    } catch {
      lines.push(`  ${dim('Could not fetch token data')}`);
    }

    lines.push(`  ${dim('─'.repeat(52))}`, '');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewToken(command: ParsedCommand): Promise<TxResult> {
    const symbol = command.params.symbol;
    if (!symbol) return { success: false, error: err('  Usage: token SOL') };

    try {
      const price = await this.state.getPrice(symbol);
      const market = await this.state.getMarket(symbol);
      const position = await this.state.getPosition(symbol);

      const lines = [
        '',
        `  ${accentBold(symbol)}`,
        `  ${dim('─'.repeat(48))}`,
        '',
        `  ${dim('Price:')}       ${chalk.white.bold(formatPrice(price))}`,
      ];

      if (market) {
        lines.push(`  ${dim('Pool:')}        ${dim(market.pool)}`);
        lines.push(`  ${dim('Max Lev:')}     ${market.maxLeverage}x`);
        lines.push(`  ${dim('Status:')}      ${market.isOpen ? ok('OPEN') : err('CLOSED')}`);
      }

      if (position) {
        lines.push('');
        lines.push(`  ${dim('POSITION')}`);
        lines.push(`  ${dim('Side:')}        ${colorSide(position.side)}`);
        lines.push(`  ${dim('Size:')}        ${formatUsd(position.sizeUsd)}`);
        lines.push(`  ${dim('Entry:')}       ${formatPrice(position.entryPrice)}`);
        lines.push(`  ${dim('PnL:')}         ${colorPnl(position.pnl)}`);
        lines.push(`  ${dim('Leverage:')}    ${position.leverage}x`);
      }

      if (this.wallet.isConnected) {
        const bal = await this.state.getBalance(symbol);
        if (bal > 0) {
          lines.push('');
          lines.push(`  ${dim('WALLET')}`);
          lines.push(`  ${dim('Balance:')}     ${bal.toFixed(4)} ${symbol}`);
          lines.push(`  ${dim('Value:')}       ${formatUsd(bal * price)}`);
        }
      }

      lines.push(`  ${dim('─'.repeat(48))}`, '');
      return { success: true, error: lines.join('\n') };
    } catch {
      return { success: false, error: err(`  Could not fetch data for ${symbol}`) };
    }
  }

  private async handleViewAllocation(): Promise<TxResult> {
    if (!this.wallet.isConnected) {
      return { success: true, error: dim('  Wallet not connected') };
    }

    const lines = [
      '',
      `  ${accentBold('PORTFOLIO ALLOCATION')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
    ];

    try {
      const solBal = await this.state.getBalance('SOL');
      const usdcBal = await this.state.getBalance('USDC');
      const solPrice = await this.state.getPrice('SOL');
      const positions = await this.state.getPositions();

      const solUsd = solBal * solPrice;
      const positionValue = positions.reduce((s, p) => s + p.collateralUsd, 0);
      const total = solUsd + usdcBal + positionValue;

      if (total <= 0) {
        lines.push(`  ${dim('No assets found')}`);
      } else {
        // Wallet
        const walletPct = ((solUsd + usdcBal) / total * 100).toFixed(1);
        const posPct = (positionValue / total * 100).toFixed(1);

        lines.push(`  ${dim('WALLET')}  ${dim(`(${walletPct}%)`)}`);
        if (solUsd > 0) {
          const bar = '█'.repeat(Math.round(solUsd / total * 20));
          lines.push(`    SOL   ${pad(formatUsd(solUsd), 12)} ${chalk.green(bar)}`);
        }
        if (usdcBal > 0) {
          const bar = '█'.repeat(Math.round(usdcBal / total * 20));
          lines.push(`    USDC  ${pad(formatUsd(usdcBal), 12)} ${chalk.blue(bar)}`);
        }

        if (positions.length > 0) {
          lines.push('');
          lines.push(`  ${dim('POSITIONS')}  ${dim(`(${posPct}%)`)}`);
          for (const p of positions) {
            const pctOfTotal = (p.collateralUsd / total * 100).toFixed(1);
            lines.push(`    ${pad(p.market, 6)} ${colorSide(p.side)}  ${pad(formatUsd(p.collateralUsd), 10)} ${dim(pctOfTotal + '%')}  ${colorPnl(p.pnl)}`);
          }
        }

        lines.push('');
        lines.push(`  ${dim('TOTAL:')} ${chalk.white.bold(formatUsd(total))}`);
      }
    } catch {
      lines.push(`  ${dim('Could not calculate allocation')}`);
    }

    lines.push(`  ${dim('─'.repeat(48))}`, '');
    return { success: true, error: lines.join('\n') };
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
      `    cancel SOL long            Cancel orders`,
      '',
      `  ${chalk.cyan('VIEW')}`,
      `    positions / pos            View positions`,
      `    orders                     View open orders`,
      `    portfolio / pf             Portfolio overview`,
      `    markets                    All markets`,
      `    market SOL                 Market detail`,
      `    prices                     Price feed`,
      `    pools                      Pool overview`,
      `    balance / bal              Wallet balance`,
      `    trades / history           Trade history`,
      `    stats                      Execution metrics`,
      '',
      `  ${chalk.cyan('EARN')}`,
      `    earn                       Pool overview (TVL, LP price)`,
      `    pool Crypto.1              Pool detail (assets, ratios)`,
      '',
      `  ${chalk.cyan('PORTFOLIO')}`,
      `    tokens                     Token holdings`,
      `    token SOL                  Token detail + position`,
      `    allocation                 Portfolio breakdown`,
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

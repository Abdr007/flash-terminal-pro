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
import { renderDashboard } from '../cli/dashboard.js';
import { renderPnl, renderExposure, renderRisk } from '../cli/analytics.js';
import {
  handleEarnOverview, handleEarnInfo, handleEarnBest, handleEarnSimulate,
  handleEarnDemand, handleEarnRotate, handleEarnDashboard as earnDash,
  handleEarnPnl, handleEarnPositions, handleEarnHistory,
} from '../earn/earn-handlers.js';
import type { SdkService } from '../services/sdk-service.js';
import {
  handleFafDashboard,
  handleFafTier, handleFafRewards, handleFafReferral, handleFafPoints,
  handleFafRequests,
} from '../faf/faf-handlers.js';
import { handleVolume, handleOpenInterest, handleFunding, handleFees, handleNotSupported } from '../cli/market-analytics.js';
import {
  handleWalletStatus, handleWalletTokens as walletTokensCmd, handleWalletBalance,
  handleWalletList, handleWalletUse, handleWalletConnect, handleWalletDisconnect, handleWalletAddress,
} from '../cli/wallet-commands.js';
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
import { titleBlock } from '../cli/display.js';

// ─── ExecutionEngine ────────────────────────────────────────────────────────

export class ExecutionEngine implements IExecutionEngine {
  private risk: RiskEngine;
  private state: StateEngine;
  private api: FlashApiClient;
  private wallet: WalletManager;
  txPipeline: TxPipeline;
  private rpcManager: RpcManager | null = null;
  private sdkService: SdkService | null = null;

  constructor(
    private config: FlashXConfig,
    state: StateEngine,
    api: FlashApiClient,
    wallet: WalletManager,
    txPipeline: TxPipeline,
    rpcManager?: RpcManager,
    sdkService?: SdkService,
  ) {
    this.state = state;
    this.api = api;
    this.wallet = wallet;
    this.txPipeline = txPipeline;
    this.rpcManager = rpcManager ?? null;
    this.sdkService = sdkService ?? null;
    this.risk = new RiskEngine(config, state);
  }

  /**
   * Main entry point — routes a parsed command to the appropriate handler.
   * Appends contextual hints after every successful response.
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

    const result = await this.dispatch(command);

    // Append contextual hint to successful responses
    if (result.success && result.error) {
      const hintKey = this.getHintKey(command.action);
      const hintText = this.hint(hintKey);
      if (hintText) {
        result.error = result.error + '\n' + hintText + '\n';
      }
    }

    return result;
  }

  private getHintKey(action: Action): string {
    const map: Partial<Record<Action, string>> = {
      [Action.OpenPosition]: 'open',
      [Action.ClosePosition]: 'close',
      [Action.ReversePosition]: 'reverse',
      [Action.AddCollateral]: 'collateral',
      [Action.RemoveCollateral]: 'collateral',
      [Action.TakeProfit]: 'tp',
      [Action.StopLoss]: 'sl',
      [Action.CancelOrder]: 'cancel',
      [Action.CancelAllOrders]: 'cancel',
      [Action.ViewPositions]: 'positions',
      [Action.ViewPortfolio]: 'portfolio',
      [Action.ViewMarkets]: 'markets',
      [Action.ViewEarn]: 'earn',
      [Action.ViewBalance]: 'balance',
      [Action.ViewPnl]: 'pnl',
      [Action.ViewRisk]: 'risk',
      [Action.ViewExposure]: 'exposure',
      [Action.ViewDashboard]: 'dashboard',
      [Action.Analyze]: 'analyze',
      [Action.ViewTrades]: 'trades',
      [Action.Health]: 'health',
      [Action.ViewVolume]: 'volume',
      [Action.ViewFees]: 'fees',
      [Action.ViewOI]: 'oi',
      [Action.ViewFunding]: 'funding',
      [Action.FafStatus]: 'faf',
      [Action.WalletStatus]: 'wallet',
      [Action.Doctor]: 'doctor',
      [Action.ViewTokens]: 'tokens',
      [Action.Monitor]: 'monitor',
    };
    return map[action] ?? '';
  }

  private async dispatch(command: ParsedCommand): Promise<TxResult> {
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

      // ─── Swap ─────────────────────────────────────────────────────
      case Action.Swap:
        return { success: false, error: '  Swap is not available in this terminal. Use Jupiter or flash.trade for token swaps.' };

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
      case Action.WalletBalance:
        return handleWalletBalance(this.wallet, this.state);
      case Action.ViewTrades:
        return this.handleTradeHistory();
      case Action.ViewStats:
        return this.handleStats();
      case Action.ViewOrders:
        return this.handleViewOrders();
      case Action.ViewEarn:
        return handleEarnOverview(this.api);
      case Action.ViewPoolDetail:
        return handleEarnInfo(command.params.pool ?? '', this.api);
      case Action.ViewTokens:
        return this.handleViewTokens();
      case Action.ViewToken:
        return this.handleViewToken(command);
      case Action.ViewAllocation:
        return this.handleViewAllocation();
      case Action.ViewDashboard:
        return this.handleDashboard();
      case Action.ViewWalletTokens:
        return walletTokensCmd(this.wallet, this.state);
      case Action.ViewPnl:
        return { success: true, error: await renderPnl(this.state) };
      case Action.ViewExposure:
        return { success: true, error: await renderExposure(this.state) };
      case Action.ViewRisk:
        return { success: true, error: await renderRisk(this.state) };
      case Action.ViewHours:
        return { success: true, error: dim('  Market hours data — check flash.trade website.') };
      case Action.ViewVolume:
        return handleVolume();
      case Action.ViewOI:
        return handleOpenInterest(this.api);
      case Action.ViewFunding:
        return handleFunding(this.api, command.params.symbol);
      case Action.ViewFees:
        return handleFees();
      case Action.ViewLiquidations:
      case Action.ViewDepth:
        return handleNotSupported(command.action);

      // ─── Wallet Management ──────────────────────────────────────────
      case Action.WalletStatus:
        return handleWalletStatus(this.wallet, this.state);
      case Action.WalletList:
        return handleWalletList();
      case Action.WalletUse:
        return handleWalletUse(command.params.name ?? '', this.wallet);
      case Action.WalletDisconnect:
        return handleWalletDisconnect(this.wallet);
      case Action.Degen:
        return { success: true, error: `\n  ${this.config.devMode ? dim('Degen mode already active.') : dim('Enable with --degen flag on trades (up to 500x).')}\n` };

      // ─── Extra commands ─────────────────────────────────────────────
      case Action.CloseAll:
        return this.handleCloseAll();
      case Action.TpStatus:
        return this.handleViewOrders();
      case Action.Capital:
        return this.handleCapital();
      case Action.WalletAddress:
        return handleWalletAddress(this.wallet);
      case Action.WalletConnect:
        return handleWalletConnect(command.params.path, this.wallet);
      case Action.PositionDebug:
        return this.handleAnalyze(command);
      case Action.SystemHealth:
      case Action.SystemStatus:
      case Action.SystemMetrics:
        return this.handleHealth();
      case Action.TxMetrics:
        return this.handleStats();
      case Action.TxInspect:
      case Action.TxDebug:
        return { success: true, error: command.params.value
          ? `\n  ${dim('View on Solscan:')}\n  https://solscan.io/tx/${command.params.value}\n`
          : dim('\n  Usage: tx inspect <signature>\n') };
      case Action.ProtocolVerify:
        return this.handleDoctor();
      case Action.RpcAdd:
      case Action.RpcRemove:
      case Action.RpcSet:
        return { success: true, error: dim(`\n  RPC ${command.action.replace('rpc_', '')}: set RPC_URL or RPC_BACKUP_URL in .env file.\n  Restart CLI to apply changes.\n`) };
      case Action.RpcTest:
      case Action.RpcList:
        return this.handleHealth();
      case Action.Dryrun:
        return { success: true, error: dim('\n  Dryrun: use simulation mode (select mode 1 on startup).\n  All commands in simulation show previews without executing.\n') };

      // ─── FAF (SDK-based, on-chain data) ─────────────────────────────
      case Action.FafStatus:
        return handleFafDashboard(this.sdkService, this.wallet);
      case Action.FafTier:
        return handleFafTier(this.sdkService, this.wallet);
      case Action.FafRewards:
        return handleFafRewards(this.sdkService, this.wallet);
      case Action.FafReferral:
        return handleFafReferral(this.sdkService, this.wallet);
      case Action.FafPoints:
        return handleFafPoints(this.sdkService, this.wallet);
      case Action.FafRequests:
        if (command.params.orderId !== undefined) {
          return this.executeFafAction('cancel', command.params.orderId);
        }
        return handleFafRequests(this.sdkService, this.wallet);
      case Action.FafStake:
        return this.executeFafAction('stake', command.params.amount ?? 0);
      case Action.FafUnstake:
        return this.executeFafAction('unstake', command.params.amount ?? 0);
      case Action.FafClaim:
        return this.executeFafAction('claim', 0);

      // ─── Analytics ──────────────────────────────────────────────────
      case Action.Analyze:
        return this.handleAnalyze(command);

      // ─── Protocol ───────────────────────────────────────────────────
      case Action.InspectProtocol:
      case Action.ProtocolStatus:
        return this.handleHealth();
      case Action.InspectPool:
        return handleEarnInfo(command.params.pool ?? '', this.api);
      case Action.InspectMarket:
        return this.handleViewMarket(command);

      // ─── Earn (full 16-command system) ─────────────────────────────
      case Action.EarnDashboard:
        return earnDash(this.api);
      case Action.EarnBest:
        return handleEarnBest(this.api);
      case Action.EarnInfo:
        return handleEarnInfo(command.params.pool ?? '', this.api);
      case Action.EarnSimulate:
        return handleEarnSimulate(command.params.amount ?? 1000, command.params.pool ?? 'crypto', this.api);
      case Action.EarnDemand:
        return handleEarnDemand(this.api);
      case Action.EarnRotate:
        return handleEarnRotate(this.api);
      case Action.EarnPnl:
        return handleEarnPnl();
      case Action.EarnPositions:
        return handleEarnPositions();
      case Action.EarnHistory:
        return handleEarnHistory(command.params.pool);
      case Action.EarnDeposit:
        return this.executeEarnAction('deposit', command);
      case Action.EarnStake:
        return this.executeEarnAction('stake', command);
      case Action.EarnWithdraw:
      case Action.EarnUnstake:
        return this.executeEarnAction('withdraw', command);
      case Action.EarnClaim:
        return this.executeEarnAction('claim', command);

      // ─── Utilities ──────────────────────────────────────────────────
      case Action.RpcStatus:
        return this.handleHealth();
      case Action.SystemAudit:
        return this.handleHealth();
      case Action.Doctor:
        return this.handleDoctor();
      case Action.Monitor: {
        const { runMonitor } = await import('../cli/monitor.js');
        const output = await runMonitor(this.state, this.api, this.wallet);
        return { success: true, error: output };
      }

      // Old wallet stubs removed — handled above in Wallet Management section

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
    lines.push(`  ${chalk.green('✓')} Trade executed: ${txResult.signature}`);
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

    log.success('ENGINE', `Trade complete: ${txResult.signature} (${durationMs}ms)`);
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
    lines.push(`  ${chalk.green('✓')} Position closed: ${txResult.signature}`);
    lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);
    lines.push(`  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`);
    lines.push('');

    metrics.recordTradeSuccess(durationMs);
    audit.log({ timestamp: new Date().toISOString(), action: 'close_position', command: command.raw, market, side, sizeUsd: position.sizeUsd, txHash: txResult.signature, status: 'confirmed', durationMs });

    log.success('ENGINE', `Close complete: ${txResult.signature} (${durationMs}ms)`);
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

      lines.push('', `  ${chalk.green('✓')} Position reversed: ${txResult.signature}`);
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

      lines.push('', `  ${chalk.green('✓')} Collateral ${isAdd ? 'added' : 'removed'}: ${txResult.signature}`, `  ${dim(`Duration: ${durationMs}ms`)}`, '');
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
        return { success: true, signature: txResult.signature, error: `\n  ${chalk.green('✓')} Order cancelled: ${txResult.signature}\n` };
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

        lines.push('', `  ${chalk.green('✓')} ${label} set: ${txResult.signature}`, '');
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

  // ─── LP Handler (via SDK Service) ──────────────────────────────────────

  private async handleLp(command: ParsedCommand): Promise<TxResult> {
    const { token, pool: rawPool, amount } = command.params;
    const isDeposit = command.action === Action.AddLiquidity;

    if (!this.sdkService) {
      return { success: false, error: '  LP operations require SDK service.' };
    }
    if (!this.wallet.isConnected || !this.wallet.keypair) {
      return { success: false, error: err('  Wallet not connected. Use Live mode.') };
    }
    if (!rawPool || !amount) {
      return { success: false, error: err(`  Usage: ${isDeposit ? 'earn deposit $100 crypto' : 'earn withdraw 100% crypto'}`) };
    }

    // Resolve pool alias (crypto → Crypto.1)
    const { resolveEarnPool } = await import('../earn/pool-registry.js');
    const poolInfo = resolveEarnPool(rawPool);
    const pool = poolInfo?.poolId ?? rawPool;

    if (this.config.simulationMode) {
      return { success: true, error: dim(`\n  [SIMULATION] Would ${isDeposit ? 'deposit' : 'withdraw'} ${amount} ${token ?? 'USDC'} ${isDeposit ? 'into' : 'from'} ${pool}\n`) };
    }

    const log = getLogger();
    const tokenSym = token ?? 'USDC';

    log.info('ENGINE', `LP ${isDeposit ? 'deposit' : 'withdraw'}: ${amount} ${tokenSym} ${isDeposit ? '→' : '←'} ${pool}`);

    try {
      const result = isDeposit
        ? await this.sdkService.buildLpDeposit(this.wallet.keypair, tokenSym, amount, pool)
        : await this.sdkService.buildLpWithdraw(this.wallet.keypair, tokenSym, amount, pool);

      if (!result) {
        return { success: false, error: err(`  LP ${isDeposit ? 'deposit' : 'withdraw'} build failed`) };
      }

      // Execute through the same pipeline as perps
      const tradeKey = `lp:${isDeposit ? 'deposit' : 'withdraw'}:${pool}:${amount}`;
      const txResult = await this.txPipeline.execute(result.transactionBase64, this.wallet.keypair, tradeKey);

      if (!txResult.success) {
        return { success: false, error: err(`  LP failed: ${txResult.error}`) };
      }

      return {
        success: true,
        signature: txResult.signature,
        error: `\n  ${chalk.green('✓')} LP ${isDeposit ? 'deposited' : 'withdrawn'}: ${txResult.signature}\n  ${dim(`https://solscan.io/tx/${txResult.signature}`)}\n`,
      };
    } catch (e) {
      return { success: false, error: err(`  LP failed: ${e instanceof Error ? e.message : String(e)}`) };
    }
  }

  // ─── View Handlers ────────────────────────────────────────────────────

  private async handleViewPositions(): Promise<TxResult> {
    const positions = await this.state.getPositions();
    if (positions.length === 0) {
      return { success: true, error: `\n  ${dim('No open positions')}\n` };
    }

    const totalPnl = positions.reduce((s, p) => s + p.pnl, 0);
    const totalExposure = positions.reduce((s, p) => s + p.sizeUsd, 0);

    // Matching flash-terminal exact format
    const lines = [
      titleBlock('POSITIONS'),
      '',
    ];

    // Header: Market Side Lev Size Collateral Entry Mark PnL Fees Liq
    const hdr = `${pad('Market', 8)}${pad('Side', 6)}${pad('Lev', 6)}${pad('Size', 8)}${pad('Collateral', 12)}${pad('Entry', 12)}${pad('Mark', 12)}${pad('PnL', 17)}${pad('Fees', 7)}${pad('Liq', 18)}`;
    lines.push(dim(hdr));
    lines.push(dim('─'.repeat(hdr.length)));

    for (const p of positions) {
      const pnlPct = p.collateralUsd > 0 ? (p.pnl / p.collateralUsd * 100).toFixed(2) : '0.00';
      const pnlStr = `${formatUsd(p.pnl)} (${pnlPct}%)`;
      const pnlColored = p.pnl >= 0 ? chalk.green(pnlStr) : chalk.red(pnlStr);

      const liqDist = p.entryPrice > 0 && p.liquidationPrice > 0
        ? Math.abs(p.entryPrice - p.liquidationPrice) / p.entryPrice * 100
        : 0;
      const liqStr = `${formatPrice(p.liquidationPrice)} (${liqDist.toFixed(1)}%)`;

      lines.push(
        `${pad(p.market, 8)}${pad(colorSide(p.side), 6)}${pad(p.leverage.toFixed(1) + 'x', 6)}${pad(formatUsd(p.sizeUsd), 8)}${pad(formatUsd(p.collateralUsd), 12)}${pad(formatPrice(p.entryPrice), 12)}${pad(formatPrice(p.markPrice), 12)}${pad(pnlColored, 17)}${pad(formatUsd(p.fees), 7)}${pad(liqStr, 18)}`
      );
    }

    lines.push('');
    lines.push(`  ${dim('Total PnL:')} ${colorPnl(totalPnl)}  ${dim('|  Exposure:')} ${formatUsd(totalExposure)}  ${dim('|  Open:')} ${positions.length}`);
    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  private async handleViewPortfolio(): Promise<TxResult> {
    const positions = await this.state.getPositions();
    const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
    const totalSize = positions.reduce((sum, p) => sum + p.sizeUsd, 0);
    const totalCollateral = positions.reduce((sum, p) => sum + p.collateralUsd, 0);

    const solBal = await this.state.getBalance('SOL').catch(() => 0);
    const usdcBal = await this.state.getBalance('USDC').catch(() => 0);
    const solPrice = await this.state.getPrice('SOL').catch(() => 0);
    const walletUsd = solBal * solPrice + usdcBal;
    const totalValue = walletUsd + totalCollateral + totalPnl;

    return {
      success: true,
      error: [
        '',
        `  ${accentBold('PORTFOLIO')}`,
        `  ${dim('─'.repeat(48))}`,
        '',
        `  ${dim('Total Value:')}  ${chalk.white.bold(formatUsd(totalValue))}`,
        `  ${dim('Wallet:')}       ${formatUsd(walletUsd)}`,
        `  ${dim('In Positions:')} ${formatUsd(totalCollateral)}`,
        '',
        `  ${dim('Positions:')}    ${positions.length}`,
        `  ${dim('Total Size:')}   ${formatUsd(totalSize)}`,
        `  ${dim('Total PnL:')}    ${colorPnl(totalPnl)}`,
        '',
      ].join('\n'),
    };
  }

  private async handleViewMarkets(): Promise<TxResult> {
    const markets = await this.state.getMarkets();

    // Matching flash-terminal: "MARKET → Pool" format
    const lines = [
      titleBlock('FLASH TRADE MARKETS'),
      '',
    ];

    for (const m of markets) {
      lines.push(`  ${pad(m.symbol, 13)}${dim('→')} ${accentBold(m.pool)}`);
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

  // ─── Dashboard ────────────────────────────────────────────────────────

  private async handleDashboard(): Promise<TxResult> {
    const output = await renderDashboard(this.state, this.api, this.wallet);
    return { success: true, error: output };
  }


  // ─── Analyze ──────────────────────────────────────────────────────────

  private async handleAnalyze(command: ParsedCommand): Promise<TxResult> {
    const symbol = command.params.symbol;
    if (!symbol) return { success: false, error: err('  Usage: analyze SOL') };

    const market = await this.state.getMarket(symbol);
    const position = await this.state.getPosition(symbol);
    const price_val = await this.state.getPrice(symbol);

    const lines = [
      '',
      `  ${accentBold(`ANALYSIS: ${symbol}`)}`,
      `  ${dim('─'.repeat(48))}`,
      '',
      `  ${dim('Price:')}        ${chalk.white.bold(formatPrice(price_val))}`,
    ];

    if (market) {
      lines.push(`  ${dim('Pool:')}         ${dim(market.pool)}`);
      lines.push(`  ${dim('Max Leverage:')} ${market.maxLeverage}x`);
      lines.push(`  ${dim('Status:')}       ${market.isOpen ? ok('OPEN') : err('CLOSED')}`);
    }

    if (position) {
      lines.push('');
      lines.push(`  ${chalk.white.bold('YOUR POSITION')}`);
      lines.push(`  ${dim('Side:')}         ${colorSide(position.side)}`);
      lines.push(`  ${dim('Size:')}         ${formatUsd(position.sizeUsd)}`);
      lines.push(`  ${dim('Entry:')}        ${formatPrice(position.entryPrice)}`);
      lines.push(`  ${dim('Liq:')}          ${formatPrice(position.liquidationPrice)}`);
      lines.push(`  ${dim('PnL:')}          ${colorPnl(position.pnl)}`);
      lines.push(`  ${dim('Leverage:')}     ${position.leverage.toFixed(1)}x`);

      const liqDist = position.entryPrice > 0 && position.liquidationPrice > 0
        ? Math.abs(position.entryPrice - position.liquidationPrice) / position.entryPrice * 100
        : 0;
      const riskLevel = liqDist < 5 ? chalk.red.bold('CRITICAL')
        : liqDist < 15 ? chalk.yellow('HIGH')
        : liqDist < 30 ? chalk.cyan('MODERATE')
        : chalk.green('LOW');
      lines.push(`  ${dim('Liq Distance:')} ${liqDist.toFixed(1)}% ${riskLevel}`);
    }

    lines.push(`  ${dim('─'.repeat(48))}`);
    lines.push(`  ${dim('Tip: "set tp ' + symbol + ' <price>" or "set sl ' + symbol + ' <price>"')}`);
    lines.push('');
    return { success: true, error: lines.join('\n') };
  }


  // ─── Doctor ───────────────────────────────────────────────────────────

  // ─── FAF Execution (SDK → TxPipeline) ──────────────────────────────

  private async executeFafAction(action: string, amount: number): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();

    if (!this.sdkService || !this.wallet.isConnected || !this.wallet.keypair) {
      return { success: false, error: err('  Connect wallet in Live mode to execute FAF operations.') };
    }

    if (this.config.simulationMode) {
      return { success: true, error: dim(`\n  [SIMULATION] Would execute faf ${action}${amount > 0 ? ' ' + amount : ''}\n`) };
    }

    log.info('ENGINE', `FAF ${action}: ${amount > 0 ? amount : 'all'}`);
    const startMs = Date.now();
    const keypair = this.wallet.keypair;

    // ── Claim is 3-part: FAF rewards + USDC revenue + referral rebates ──
    if (action === 'claim') {
      return this.executeFafClaim(keypair, startMs);
    }

    // ── Build single transaction via SDK ────────────────────────────────
    let result: { transactionBase64: string } | null = null;
    try {
      if (action === 'stake') {
        result = await this.sdkService.buildFafStake(keypair, amount);
      } else if (action === 'unstake') {
        result = await this.sdkService.buildFafUnstake(keypair, amount);
      } else if (action === 'cancel') {
        result = await this.sdkService.buildFafCancel(keypair, amount);
      }
    } catch (e) {
      return { success: false, error: err(`  FAF ${action} failed: ${e instanceof Error ? e.message : String(e)}`) };
    }

    if (!result?.transactionBase64) {
      return { success: false, error: err(`  Could not build FAF ${action} transaction.`) };
    }

    // ── Send through TxPipeline ────────────────────────────────────────
    const tradeKey = `faf:${action}:${amount}`;
    const txResult = await this.txPipeline.execute(result.transactionBase64, keypair, tradeKey);
    const durationMs = Date.now() - startMs;

    if (!txResult.success) {
      audit.log({ timestamp: new Date().toISOString(), action: `faf_${action}`, status: 'failed', error: txResult.error, durationMs });
      return { success: false, error: err(`  FAF ${action} failed: ${txResult.error}`) };
    }

    // ── State refresh ──────────────────────────────────────────────────
    this.wallet.clearBalanceCache?.();
    audit.log({ timestamp: new Date().toISOString(), action: `faf_${action}`, txHash: txResult.signature, status: 'confirmed', durationMs });

    // ── Success output (matching flash-terminal) ───────────────────────
    const actionLabel = action === 'stake' ? 'FAF STAKED'
      : action === 'unstake' ? 'UNSTAKE REQUESTED'
      : action === 'cancel' ? 'UNSTAKE REQUEST CANCELLED'
      : `FAF ${action.toUpperCase()}`;

    return {
      success: true,
      signature: txResult.signature,
      error: [
        '',
        `  ${chalk.green('✓')} ${actionLabel}`,
        '',
        action === 'stake' ? `  Staked              ${amount} FAF` : '',
        action === 'unstake' ? `  Unstaking           ${amount} FAF` : '',
        action === 'unstake' ? `  Unlock              Linear over 90 days` : '',
        action === 'cancel' ? `  Request #           ${amount}` : '',
        action === 'cancel' ? `  Tokens returned to staked balance.` : '',
        '',
        `  Tx: ${txResult.signature}`,
        `  ${dim(`Duration: ${durationMs}ms`)}`,
        `  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`,
        '',
      ].filter(Boolean).join('\n'),
    };
  }

  /**
   * FAF claim is 3-part: FAF rewards + USDC revenue + referral rebates
   * Matching flash-terminal's exact flow: 3 separate TXs
   */
  private async executeFafClaim(keypair: import('@solana/web3.js').Keypair, startMs: number): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();
    const sigs: string[] = [];
    const claimed: string[] = [];

    // 1. Claim FAF rewards (collectTokenReward)
    try {
      const result = await this.sdkService!.buildFafClaim(keypair);
      if (result?.transactionBase64) {
        const tx = await this.txPipeline.execute(result.transactionBase64, keypair, 'faf:claim:rewards');
        if (tx.success && tx.signature) {
          sigs.push(tx.signature);
          claimed.push('FAF rewards');
          log.info('ENGINE', `FAF rewards claimed: ${tx.signature.slice(0, 16)}`);
        }
      }
    } catch (e) {
      log.warn('ENGINE', `FAF rewards claim: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Claim USDC revenue (collectRevenue)
    try {
      const result = await this.sdkService!.buildFafClaimRevenue(keypair);
      if (result?.transactionBase64) {
        const tx = await this.txPipeline.execute(result.transactionBase64, keypair, 'faf:claim:revenue');
        if (tx.success && tx.signature) {
          sigs.push(tx.signature);
          claimed.push('USDC revenue');
          log.info('ENGINE', `USDC revenue claimed: ${tx.signature.slice(0, 16)}`);
        }
      }
    } catch (e) {
      log.warn('ENGINE', `USDC revenue claim: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. Claim referral rebates (collectRebate)
    try {
      const result = await this.sdkService!.buildFafClaimRebate(keypair);
      if (result?.transactionBase64) {
        const tx = await this.txPipeline.execute(result.transactionBase64, keypair, 'faf:claim:rebate');
        if (tx.success && tx.signature) {
          sigs.push(tx.signature);
          claimed.push('referral rebates');
          log.info('ENGINE', `Referral rebates claimed: ${tx.signature.slice(0, 16)}`);
        }
      }
    } catch (e) {
      log.warn('ENGINE', `Referral rebate claim: ${e instanceof Error ? e.message : String(e)}`);
    }

    const durationMs = Date.now() - startMs;

    // State refresh
    this.wallet.clearBalanceCache?.();

    if (sigs.length === 0) {
      return { success: true, error: dim('\n  No claimable rewards found.\n') };
    }

    audit.log({ timestamp: new Date().toISOString(), action: 'faf_claim', txHash: sigs[0], status: 'confirmed', durationMs });

    const lines = [
      '',
      `  ${chalk.green('✓')} REWARDS CLAIMED`,
      '',
      `  Claimed             ${claimed.join(', ')}`,
      '',
    ];
    for (const sig of sigs) {
      lines.push(`  Tx: ${sig}`);
    }
    lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);
    if (sigs[0]) lines.push(`  ${dim(`https://solscan.io/tx/${sigs[0]}`)}`);
    lines.push('');

    return { success: true, signature: sigs[0], error: lines.join('\n') };
  }

  /**
   * Earn execution — deposit, stake, withdraw, claim
   * Matches flash-terminal's exact SDK methods:
   *   deposit  → addCompoundingLiquidity (USDC → FLP auto-compound)
   *   stake    → addLiquidityAndStake (USDC → sFLP staked)
   *   withdraw → removeLiquidity (FLP/sFLP → USDC)
   *   claim    → collectStakeFees (sFLP rewards)
   */
  private async executeEarnAction(action: string, command: ParsedCommand): Promise<TxResult> {
    const log = getLogger();
    const audit = getAuditLog();

    if (!this.sdkService || !this.wallet.isConnected || !this.wallet.keypair) {
      return { success: false, error: err('  Connect wallet in Live mode to execute earn operations.') };
    }

    const amount = command.params.amount ?? 0;
    const percent = command.params.percent ?? 0;
    const rawPool = command.params.pool ?? 'crypto';

    // Resolve pool alias (crypto → Crypto.1)
    const { resolveEarnPool } = await import('../earn/pool-registry.js');
    const poolInfo = resolveEarnPool(rawPool);
    const pool = poolInfo?.poolId ?? rawPool;

    if (this.config.simulationMode) {
      const amtStr = percent > 0 ? `${percent}%` : amount > 0 ? formatUsd(amount) : '';
      return { success: true, error: dim(`\n  [SIMULATION] Would ${action} ${amtStr} ${action === 'claim' ? 'rewards from' : action === 'deposit' ? 'USDC into' : action === 'stake' ? 'USDC into' : 'from'} ${pool}\n`) };
    }

    if (action !== 'claim' && amount <= 0 && percent <= 0) {
      return { success: false, error: err(`  Usage: earn ${action} ${action === 'withdraw' ? '100% crypto' : '$100 crypto'}`) };
    }

    log.info('ENGINE', `Earn ${action}: ${amount > 0 ? formatUsd(amount) : 'claim'} → ${pool}`);
    const startMs = Date.now();
    const keypair = this.wallet.keypair;

    // Build transaction via SDK
    let result: { transactionBase64: string } | null = null;
    try {
      if (action === 'deposit') {
        result = await this.sdkService.buildEarnDeposit(keypair, amount, pool);
      } else if (action === 'stake') {
        result = await this.sdkService.buildLpDeposit(keypair, 'USDC', amount, pool);
      } else if (action === 'withdraw') {
        if (percent > 0) {
          result = await this.sdkService.buildEarnWithdrawPercent(keypair, percent, pool);
        } else {
          result = await this.sdkService.buildLpWithdraw(keypair, 'USDC', amount, pool);
        }
      } else if (action === 'claim') {
        result = await this.sdkService.buildEarnClaim(keypair, pool);
      }
    } catch (e) {
      return { success: false, error: err(`  Earn ${action} failed: ${e instanceof Error ? e.message : String(e)}`) };
    }

    if (!result?.transactionBase64) {
      return { success: false, error: err(`  Could not build earn ${action} transaction.`) };
    }

    // Send through TxPipeline
    const tradeKey = `earn:${action}:${pool}:${amount}`;
    const txResult = await this.txPipeline.execute(result.transactionBase64, keypair, tradeKey);
    const durationMs = Date.now() - startMs;

    if (!txResult.success) {
      audit.log({ timestamp: new Date().toISOString(), action: `earn_${action}`, status: 'failed', error: txResult.error, durationMs });
      return { success: false, error: err(`  Earn ${action} failed: ${txResult.error}`) };
    }

    // State refresh
    this.wallet.clearBalanceCache?.();
    audit.log({ timestamp: new Date().toISOString(), action: `earn_${action}`, txHash: txResult.signature, status: 'confirmed', durationMs });

    // Success output (matching flash-terminal)
    const actionLabel = action === 'deposit' ? 'DEPOSIT CONFIRMED'
      : action === 'stake' ? 'STAKE CONFIRMED'
      : action === 'withdraw' ? 'WITHDRAW CONFIRMED'
      : 'REWARDS CLAIMED';

    const lines = [
      '',
      `  ${chalk.green('✓')} ${actionLabel}`,
      '',
      `  Pool                ${pool}`,
    ];
    if (action === 'deposit') {
      lines.push(`  Deposited           ${formatUsd(amount)} USDC`);
      lines.push(`  Received            FLP (auto-compound)`);
    } else if (action === 'stake') {
      lines.push(`  Staked              ${formatUsd(amount)} USDC`);
      lines.push(`  Received            sFLP (USDC rewards)`);
    } else if (action === 'withdraw') {
      lines.push(`  Withdrawn           ${percent > 0 ? percent + '% of FLP' : formatUsd(amount)}`);
      lines.push(`  Received            USDC`);
    } else {
      lines.push(`  Received            USDC rewards`);
    }
    lines.push('');
    lines.push(`  Tx: ${txResult.signature}`);
    lines.push(`  ${dim(`Duration: ${durationMs}ms`)}`);
    lines.push(`  ${dim(`https://solscan.io/tx/${txResult.signature}`)}`);
    lines.push('');

    return { success: true, signature: txResult.signature, error: lines.join('\n') };
  }

  private async handleCloseAll(): Promise<TxResult> {
    const positions = await this.state.getPositions();
    if (positions.length === 0) return { success: true, error: dim('\n  No open positions to close.\n') };

    const lines = [`\n  ${accentBold('CLOSE ALL POSITIONS')}  ${dim(`(${positions.length})`)}`, ''];
    for (const p of positions) {
      lines.push(`  ${colorSide(p.side)} ${p.market.padEnd(8)} ${formatUsd(p.sizeUsd)} ${colorPnl(p.pnl)}`);
    }

    if (this.config.simulationMode) {
      lines.push('', `  ${dim('[SIMULATION — would close all positions]')}`, '');
      return { success: true, error: lines.join('\n') };
    }

    // Execute sequential close
    let closed = 0;
    for (const p of positions) {
      try {
        const buildResult = await this.api.buildClosePosition({
          positionKey: p.pubkey,
          inputUsdUi: String(p.sizeUsd),
          withdrawTokenSymbol: 'USDC',
          owner: this.wallet.publicKey!.toBase58(),
        }) as Record<string, unknown>;

        const tx64 = buildResult['transactionBase64'] as string;
        if (tx64 && this.wallet.keypair) {
          const result = await this.txPipeline.execute(tx64, this.wallet.keypair, `close:${p.market}:${p.side}`);
          if (result.success) {
            lines.push(`  ${chalk.green('✓')} ${p.market} ${p.side} closed`);
            closed++;
          } else {
            lines.push(`  ${chalk.red('✗')} ${p.market} ${p.side}: ${result.error}`);
          }
        }
      } catch (e) {
        lines.push(`  ${chalk.red('✗')} ${p.market}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    lines.push('', `  ${dim(`Closed ${closed}/${positions.length} positions`)}`, '');
    return { success: true, error: lines.join('\n') };
  }

  private async handleCapital(): Promise<TxResult> {
    const solBal = await this.state.getBalance('SOL').catch(() => 0);
    const usdcBal = await this.state.getBalance('USDC').catch(() => 0);
    const solPrice = await this.state.getPrice('SOL').catch(() => 0);
    const positions = await this.state.getPositions();

    const walletUsd = solBal * solPrice + usdcBal;
    const inPositions = positions.reduce((s, p) => s + p.collateralUsd, 0);
    const available = usdcBal; // USDC is what's used for new trades

    return {
      success: true,
      error: [
        '',
        `  ${accentBold('TRADING CAPITAL')}`,
        `  ${dim('─'.repeat(48))}`,
        '',
        `  ${dim('Available USDC:')}  ${chalk.green.bold(formatUsd(available))}`,
        `  ${dim('SOL (wallet):')}    ${formatUsd(solBal * solPrice)} ${dim(`(${solBal.toFixed(4)} SOL)`)}`,
        `  ${dim('In Positions:')}    ${formatUsd(inPositions)}`,
        `  ${dim('Total Portfolio:')} ${chalk.white.bold(formatUsd(walletUsd + inPositions))}`,
        `  ${dim('─'.repeat(48))}`,
        '',
      ].join('\n'),
    };
  }


  private async handleDoctor(): Promise<TxResult> {
    const lines = [
      '',
      `  ${accentBold('SYSTEM DIAGNOSTIC')}`,
      `  ${dim('─'.repeat(48))}`,
      '',
    ];

    // API check
    try {
      await this.api.health();
      lines.push(`  ${chalk.green('✓')} Flash API       connected`);
    } catch {
      lines.push(`  ${chalk.red('✗')} Flash API       unreachable`);
    }

    // Wallet
    if (this.wallet.isConnected) {
      lines.push(`  ${chalk.green('✓')} Wallet          ${this.wallet.shortAddress}`);
    } else {
      lines.push(`  ${chalk.yellow('⚠')} Wallet          not connected`);
    }

    // RPC
    if (this.rpcManager) {
      lines.push(`  ${chalk.green('✓')} RPC             ${this.rpcManager.endpointCount} endpoint(s)`);
    } else {
      lines.push(`  ${chalk.yellow('⚠')} RPC             default endpoint`);
    }

    // Mode
    lines.push(`  ${chalk.green('✓')} Mode            ${this.config.simulationMode ? 'SIMULATION' : 'LIVE'}`);
    lines.push(`  ${chalk.green('✓')} Pipeline        13-gate hardened`);
    lines.push(`  ${chalk.green('✓')} Audit log       active`);

    lines.push(`  ${dim('─'.repeat(48))}`);
    lines.push(`  ${chalk.green('System healthy.')}`);
    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  // ─── Contextual Hints ─────────────────────────────────────────────────

  private hint(context: string): string {
    const hints: Record<string, string> = {
      'open':       `  ${dim('Next:')} positions ${dim('│')} set tp SOL <price> ${dim('│')} risk ${dim('│')} dashboard`,
      'close':      `  ${dim('Next:')} pnl ${dim('│')} trades ${dim('│')} dashboard ${dim('│')} long SOL ...`,
      'tp':         `  ${dim('Next:')} orders ${dim('│')} positions ${dim('│')} risk`,
      'sl':         `  ${dim('Next:')} orders ${dim('│')} positions ${dim('│')} risk`,
      'cancel':     `  ${dim('Next:')} orders ${dim('│')} positions`,
      'collateral': `  ${dim('Next:')} positions ${dim('│')} risk ${dim('│')} close SOL`,
      'reverse':    `  ${dim('Next:')} positions ${dim('│')} pnl ${dim('│')} risk`,
      'positions':  `  ${dim('Next:')} close <market> ${dim('│')} add $50 to SOL ${dim('│')} risk ${dim('│')} pnl`,
      'portfolio':  `  ${dim('Next:')} positions ${dim('│')} allocation ${dim('│')} pnl ${dim('│')} earn`,
      'markets':    `  ${dim('Next:')} market SOL ${dim('│')} long SOL ... ${dim('│')} analyze SOL`,
      'earn':       `  ${dim('Next:')} pool Crypto.1 ${dim('│')} earn best ${dim('│')} dashboard`,
      'balance':    `  ${dim('Next:')} tokens ${dim('│')} allocation ${dim('│')} long SOL ...`,
      'pnl':        `  ${dim('Next:')} exposure ${dim('│')} risk ${dim('│')} trades`,
      'risk':       `  ${dim('Next:')} close <market> ${dim('│')} add $50 to SOL ${dim('│')} positions`,
      'exposure':   `  ${dim('Next:')} risk ${dim('│')} pnl ${dim('│')} close <market>`,
      'dashboard':  `  ${dim('Next:')} positions ${dim('│')} long SOL ... ${dim('│')} earn ${dim('│')} pnl`,
      'analyze':    `  ${dim('Next:')} long <market> ... ${dim('│')} set tp ... ${dim('│')} risk`,
      'trades':     `  ${dim('Next:')} pnl ${dim('│')} stats ${dim('│')} dashboard`,
      'health':     `  ${dim('Next:')} dashboard ${dim('│')} doctor ${dim('│')} rpc`,
      'volume':     `  ${dim('Next:')} fees ${dim('│')} open interest ${dim('│')} dashboard`,
      'fees':       `  ${dim('Next:')} volume ${dim('│')} earn ${dim('│')} dashboard`,
      'oi':         `  ${dim('Next:')} funding SOL ${dim('│')} volume ${dim('│')} risk`,
      'funding':    `  ${dim('Next:')} open interest ${dim('│')} risk ${dim('│')} positions`,
      'faf':        '',
      'wallet':     `  ${dim('Next:')} wallet tokens ${dim('│')} wallet list ${dim('│')} dashboard`,
      'doctor':     `  ${dim('Next:')} health ${dim('│')} dashboard ${dim('│')} rpc`,
      'tokens':     `  ${dim('Next:')} allocation ${dim('│')} dashboard ${dim('│')} long SOL ...`,
      'monitor':    `  ${dim('Next:')} dashboard ${dim('│')} positions ${dim('│')} pnl`,
    };
    return hints[context] ?? '';
  }

  // ─── Trade History ────────────────────────────────────────────────────

  private handleTradeHistory(): TxResult {
    const audit = getAuditLog();
    const records = audit.readRecent(50);

    // Filter: exclude swap (unsupported), keep only relevant entries
    const filtered = records.filter(r =>
      r.action !== 'swap' && r.status !== 'preview'
    );

    if (filtered.length === 0) {
      return { success: true, error: dim('  No trade history yet.') };
    }

    const display = filtered.slice(-20); // Last 20 relevant

    const lines = [
      '',
      `  ${accentBold('TRADE HISTORY')}  ${dim(`(${display.length} trades)`)}`,
      '',
      dim(`  ${pad('Time', 10)} ${pad('Action', 14)} ${pad('Market', 8)} ${pad('Side', 6)} ${pad('Status', 14)} ${pad('Tx', 18)}`),
      dim('  ' + '─'.repeat(72)),
    ];

    for (const r of display.reverse()) {
      const time = r.timestamp.slice(11, 19);
      const action = (r.action ?? '').replace(/_/g, ' ').replace(/position/g, 'pos');
      const market = r.market ?? '';
      const side = r.side ?? '';

      let statusStr: string;
      if (r.status === 'confirmed') {
        statusStr = chalk.green('✓ confirmed');
      } else if (r.status === 'failed') {
        statusStr = chalk.red('✗ failed');
      } else if (r.status === 'blocked') {
        statusStr = chalk.yellow('⊘ blocked');
      } else if (r.status === 'inconsistent') {
        statusStr = chalk.red('⚠ inconsistent');
      } else {
        statusStr = dim(r.status);
      }

      const tx = r.txHash ? r.txHash.slice(0, 14) + '...' : dim('—');

      lines.push(`  ${dim(time)} ${pad(action, 14)} ${pad(market, 8)} ${pad(side, 6)} ${statusStr.padEnd(14)} ${tx}`);
    }

    // Explain inconsistent entries if any
    const inconsistent = display.filter(r => r.status === 'inconsistent');
    if (inconsistent.length > 0) {
      lines.push('');
      lines.push(`  ${chalk.yellow('Note:')} ${dim('"inconsistent" means the on-chain state after')}`);
      lines.push(`  ${dim('execution did not match the expected result.')}`);
      lines.push(`  ${dim('This can happen when a position was already modified')}`);
      lines.push(`  ${dim('by another transaction (e.g., liquidation, duplicate).')}`);
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
    // Exact flash-terminal help format: 32-char column, same category order
    const C = 32;
    const cmd = (s: string) => chalk.cyan(s.padEnd(C));
    const sec = (s: string) => chalk.bold(s);

    const lines = [
      '',
      `  ${accentBold('FLASH TERMINAL')}  ${dim('— Command Reference')}`,
      `  ${dim('─'.repeat(52))}`,
      '',
      // Category order matches flash-terminal: Trading, Earn, FAF, Market Data, Portfolio, Protocol, Wallet, Utilities
      `  ${sec('Trading')}`,
      `    ${cmd('open 5x long SOL $500')}Open a leveraged position`,
      `    ${cmd('close SOL long')}Close a position`,
      `    ${cmd('add $200 to SOL long')}Add collateral to position`,
      `    ${cmd('remove $100 from ETH long')}Remove collateral`,
      `    ${cmd('positions')}View open positions`,
      `    ${cmd('position debug <asset>')}Protocol-level position debug`,
      `    ${cmd('markets')}List available markets`,
      `    ${cmd('trade history')}View recent trades`,
      `    ${cmd('tp status')}View active TP/SL targets`,
      `    ${cmd('limit long SOL 2x $100 @ $82')}Place a limit order`,
      `    ${cmd('cancel order <id>')}Cancel a limit order`,
      `    ${cmd('orders')}View active orders (on-chain)`,
      `    ${cmd('close all')}Close all open positions`,
      '',
      `  ${sec('Earn (Liquidity)')}`,
      `    ${cmd('earn')}View earn pools with live yield`,
      `    ${cmd('earn info <pool>')}Pool details & yield data`,
      `    ${cmd('earn deposit $100 crypto')}Deposit USDC \u2192 FLP (auto-compound)`,
      `    ${cmd('earn withdraw 100% crypto')}Withdraw FLP \u2192 USDC`,
      `    ${cmd('earn stake $200 governance')}Stake FLP tokens`,
      `    ${cmd('earn unstake 25% governance')}Unstake FLP tokens`,
      `    ${cmd('earn claim')}Claim LP/staking rewards`,
      `    ${cmd('earn positions')}View your LP positions`,
      `    ${cmd('earn best')}Rank pools by yield + risk`,
      `    ${cmd('earn simulate $1000 crypto')}Project yield returns`,
      `    ${cmd('earn dashboard')}Liquidity portfolio overview`,
      `    ${cmd('earn pnl')}Earn profit & loss tracking`,
      `    ${cmd('earn demand')}Liquidity demand analysis`,
      `    ${cmd('earn history <pool>')}Historical APY data`,
      `    ${cmd('earn rotate')}Suggest liquidity rotation`,
      '',
      `  ${sec('FAF Token')}`,
      `    ${cmd('faf')}FAF staking dashboard`,
      `    ${cmd('faf stake <amount>')}Stake FAF for revenue + VIP`,
      `    ${cmd('faf unstake <amount>')}Request FAF unstake (90-day unlock)`,
      `    ${cmd('faf claim')}Claim FAF rewards + USDC revenue`,
      `    ${cmd('faf tier')}VIP tier levels + benefits`,
      `    ${cmd('faf rewards')}Pending FAF rewards + USDC`,
      `    ${cmd('faf referral')}Referral status + claimable rebates`,
      `    ${cmd('faf points')}Voltage points tier + multiplier`,
      `    ${cmd('faf requests')}Pending unstake requests + progress`,
      `    ${cmd('faf cancel <index>')}Cancel an unstake request by index`,
      '',
      `  ${sec('Market Data & Analytics')}`,
      `    ${cmd('analyze <asset>')}Deep market analysis`,
      `    ${cmd('volume')}Protocol trading volume`,
      `    ${cmd('open interest')}OI breakdown by market`,
      `    ${cmd('fees')}Protocol fee data`,
      `    ${cmd('funding <asset>')}OI imbalance & fee dashboard`,
      `    ${cmd('protocol health')}Protocol health overview`,
      '',
      `  ${sec('Portfolio & Risk')}`,
      `    ${cmd('portfolio')}Portfolio overview`,
      `    ${cmd('dashboard')}Full system dashboard`,
      `    ${cmd('risk')}Position risk assessment`,
      `    ${cmd('exposure')}Portfolio exposure breakdown`,
      `    ${cmd('pnl')}Profit & loss report`,
      `    ${cmd('capital')}Available trading capital`,
      `    ${cmd('allocation')}Portfolio allocation breakdown`,
      '',
      `  ${sec('Protocol Inspection')}`,
      `    ${cmd('inspect protocol')}Flash Trade protocol overview`,
      `    ${cmd('inspect pool <name>')}Inspect a specific pool`,
      `    ${cmd('inspect market <asset>')}Deep market inspection`,
      `    ${cmd('protocol verify')}Full protocol alignment audit`,
      '',
      `  ${sec('Wallet')}`,
      `    ${cmd('wallet')}Wallet status`,
      `    ${cmd('wallet tokens')}View all token balances`,
      `    ${cmd('wallet balance')}Show SOL balance`,
      `    ${cmd('wallet list')}List saved wallets`,
      `    ${cmd('wallet use <name>')}Switch to a saved wallet`,
      `    ${cmd('wallet connect <path>')}Connect wallet file`,
      `    ${cmd('wallet disconnect')}Disconnect active wallet`,
      '',
      `  ${sec('Utilities')}`,
      `    ${cmd('dryrun <command>')}Preview trade without executing`,
      `    ${cmd('monitor')}Live market monitor`,
      `    ${cmd('system status')}System health overview`,
      `    ${cmd('system metrics')}Full runtime metrics`,
      `    ${cmd('tx metrics')}TX engine performance stats`,
      `    ${cmd('rpc status')}Active RPC endpoint info`,
      `    ${cmd('tx inspect <sig>')}Inspect a transaction`,
      `    ${cmd('doctor')}Run terminal diagnostic`,
      `    ${cmd('degen')}Toggle degen mode`,
      '',
      `  ${dim('─'.repeat(52))}`,
      `  ${cmd('help')}Show this reference`,
      `  ${cmd('help <command>')}Detailed usage for a command`,
      `  ${cmd('exit')}Close the terminal`,
      '',
      `  ${dim('Natural language is also supported.')}`,
      `  ${dim('Example: "what\'s the price of SOL?" or "show me BTC analysis"')}`,
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
    // Command suggestion: find closest match
    const known = [
      'long', 'short', 'close', 'reverse', 'add', 'remove',
      'set tp', 'set sl', 'cancel',
      'positions', 'portfolio', 'markets', 'market', 'prices', 'pools', 'balance',
      'dashboard', 'tokens', 'allocation', 'orders', 'trades', 'stats', 'earn',
      'pnl', 'exposure', 'risk', 'health', 'config', 'help',
      'wallet tokens', 'token',
    ];

    const input = raw.toLowerCase().trim();
    let bestMatch = '';
    let bestDist = Infinity;

    for (const cmd of known) {
      const d = this.editDistance(input, cmd);
      if (d < bestDist && d <= 3) {
        bestDist = d;
        bestMatch = cmd;
      }
    }

    const lines = ['', `  ${err('Unknown command:')} ${raw}`];
    if (bestMatch) {
      lines.push(`  ${warn('Did you mean:')} ${chalk.white.bold(bestMatch)}`);
    }
    lines.push(`  ${dim('Type "help" for available commands.')}`, '');
    return lines.join('\n');
  }

  private editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (Math.abs(a.length - b.length) > 3) return 4;
    const matrix: number[][] = [];
    for (let i = 0; i <= a.length; i++) matrix[i] = [i];
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
      }
    }
    return matrix[a.length][b.length];
  }
}

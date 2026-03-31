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
  Side,
  type ParsedCommand,
  type TradeIntent,
  type TxResult,
  type LocalQuote,
  type IExecutionEngine,
  type FlashXConfig,
} from '../types/index.js';
import { RiskEngine } from './risk-engine.js';
import { StateEngine } from './state-engine.js';
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

  constructor(
    private config: FlashXConfig,
    state: StateEngine,
  ) {
    this.state = state;
    this.risk = new RiskEngine(config, state);
  }

  /**
   * Main entry point — routes a parsed command to the appropriate handler.
   */
  async execute(command: ParsedCommand): Promise<TxResult> {
    // If low confidence, show what we understood and ask for confirmation
    if (command.confidence < 0.8 && command.action !== Action.Unknown) {
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
    // Phase 2: SDK-based local quote calculation
    void command;
    return null;
  }

  // ─── Trade Handlers ─────────────────────────────────────────────────────

  private async handleOpen(command: ParsedCommand): Promise<TxResult> {
    const { market, side, leverage, collateral, takeProfit, stopLoss, degen, collateralToken } = command.params;

    if (!market || !side || !leverage || !collateral) {
      return { success: false, error: err('  Missing parameters. Usage: long SOL 10x $100') };
    }

    // Build trade intent
    const intent: TradeIntent = {
      action: Action.OpenPosition,
      market,
      side,
      leverage,
      collateral,
      collateralToken: collateralToken ?? (side === Side.Long ? market : 'USDC'),
      sizeUsd: collateral * leverage,
      takeProfit,
      stopLoss,
      degen: degen ?? false,
      pool: 'Crypto.1', // Phase 2: resolve from market
    };

    // Risk check
    const risk = await this.risk.evaluate(intent);

    if (!risk.allowed) {
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

    // Display preview
    const lines = [
      '',
      `  ${accentBold('TRADE PREVIEW')}`,
      '',
      `  ${dim('Market:')}      ${market}-${colorSide(side)}`,
      `  ${dim('Leverage:')}    ${leverage}x`,
      `  ${dim('Collateral:')}  ${formatUsd(collateral)}`,
      `  ${dim('Size:')}        ${formatUsd(intent.sizeUsd)}`,
    ];

    if (takeProfit) lines.push(`  ${dim('Take Profit:')} ${formatPrice(takeProfit)}`);
    if (stopLoss) lines.push(`  ${dim('Stop Loss:')}   ${formatPrice(stopLoss)}`);

    if (risk.mustConfirm) {
      lines.push('');
      for (const c of risk.checks.filter(c => c.status === 'WARNING')) {
        lines.push(`  ${chalk.yellow('⚠')} ${c.message}`);
      }
    }

    lines.push('');
    if (this.config.simulationMode) {
      lines.push(`  ${dim('[SIMULATION MODE — no real transaction]')}`);
    } else {
      lines.push(`  ${warn('Phase 2: will build and send real transaction here')}`);
    }
    lines.push('');

    return { success: true, error: lines.join('\n') };
  }

  private async handleClose(command: ParsedCommand): Promise<TxResult> {
    const { market, side, percent, amount } = command.params;
    if (!market) return { success: false, error: err('  Missing market. Usage: close SOL') };

    const lines = [
      '',
      `  ${accentBold('CLOSE POSITION')}`,
      '',
      `  ${dim('Market:')}  ${market}${side ? ' ' + colorSide(side) : ''}`,
    ];
    if (percent) lines.push(`  ${dim('Close:')}   ${percent}%`);
    if (amount) lines.push(`  ${dim('Amount:')}  ${formatUsd(amount)}`);
    lines.push('', `  ${dim('[Phase 2: will execute close here]')}`, '');

    return { success: true, error: lines.join('\n') };
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

  // ─── Swap Handler ─────────────────────────────────────────────────────

  private async handleSwap(command: ParsedCommand): Promise<TxResult> {
    const { inputToken, outputToken, amount } = command.params;
    if (!inputToken || !outputToken || !amount) {
      return { success: false, error: err('  Usage: swap 50 USDC to SOL') };
    }

    return {
      success: true,
      error: [
        '',
        `  ${accentBold('SWAP PREVIEW')}`,
        '',
        `  ${dim('From:')}    ${amount} ${inputToken}`,
        `  ${dim('To:')}      ${outputToken}`,
        '',
        `  ${dim('[Phase 3: will execute swap here]')}`,
        '',
      ].join('\n'),
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

  // ─── System Handlers ──────────────────────────────────────────────────

  private async handleHealth(): Promise<TxResult> {
    return {
      success: true,
      error: [
        '',
        `  ${accentBold('SYSTEM HEALTH')}`,
        '',
        `  ${dim('Mode:')}       ${this.config.simulationMode ? warn('SIMULATION') : ok('LIVE')}`,
        `  ${dim('Network:')}    ${this.config.network}`,
        `  ${dim('API:')}        ${this.config.flashApiUrl}`,
        `  ${dim('RPC:')}        ${this.config.rpcUrl.substring(0, 40)}...`,
        `  ${dim('Max Lev:')}    ${this.config.maxLeverage}x`,
        `  ${dim('Max Size:')}   ${formatUsd(this.config.maxPositionSize)}`,
        '',
      ].join('\n'),
    };
  }

  private handleHelp(): TxResult {
    const lines = [
      '',
      `  ${accentBold('flash-x')} — Flash Trade Protocol CLI`,
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

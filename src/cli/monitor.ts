/**
 * Monitor Mode — Live Terminal View
 *
 * Refreshes every 5 seconds showing:
 *   - Top market prices
 *   - Open positions with live PnL
 *   - Wallet balance
 *
 * Press Ctrl+C or Enter to exit.
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import type { IStateEngine } from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';

const REFRESH_MS = 5_000;
const CLEAR = '\x1B[2J\x1B[0;0H'; // ANSI clear screen

export async function runMonitor(
  state: IStateEngine,
  api: FlashApiClient,
  wallet: WalletManager,
): Promise<string> {
  let running = true;

  // Set up exit listener
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', () => { running = false; rl.close(); });

  console.log(chalk.dim('  Starting monitor... (press Enter to exit)\n'));

  while (running) {
    try {
      const output = await buildMonitorFrame(state, api, wallet);
      process.stdout.write(CLEAR + output);
    } catch {
      process.stdout.write(chalk.dim('\n  Monitor refresh failed. Retrying...\n'));
    }

    // Wait with early exit check
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, REFRESH_MS);
      if (!running) { clearTimeout(timer); resolve(); }
      const check = setInterval(() => {
        if (!running) { clearTimeout(timer); clearInterval(check); resolve(); }
      }, 200);
    });
  }

  return '\n  Monitor stopped.\n';
}

async function buildMonitorFrame(
  state: IStateEngine,
  _api: FlashApiClient,
  wallet: WalletManager,
): Promise<string> {
  const now = new Date().toLocaleTimeString();
  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${chalk.cyan.bold('FLASH MONITOR')}  ${chalk.dim(now)}  ${chalk.dim('(Enter to exit)')}`);
  lines.push(`  ${chalk.dim('─'.repeat(56))}`);

  // ─── Prices ─────────────────────────────────────────
  const [markets, positions, solBal, usdcBal] = await Promise.allSettled([
    state.getMarkets(),
    state.getPositions(),
    state.getBalance('SOL'),
    state.getBalance('USDC'),
  ]);

  const mkts = markets.status === 'fulfilled' ? markets.value : [];
  const pos = positions.status === 'fulfilled' ? positions.value : [];
  const sol = solBal.status === 'fulfilled' ? solBal.value : 0;
  const usdc = usdcBal.status === 'fulfilled' ? usdcBal.value : 0;

  lines.push('');
  lines.push(`  ${chalk.white.bold('PRICES')}`);

  const topSymbols = ['SOL', 'BTC', 'ETH', 'XAU', 'JUP'];
  for (const sym of topSymbols) {
    const m = mkts.find(mk => mk.symbol === sym);
    if (m && m.price > 0) {
      const p = m.price >= 1000 ? `$${m.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${m.price.toFixed(2)}`;
      const status = m.isOpen ? chalk.green('●') : chalk.red('○');
      lines.push(`  ${status} ${sym.padEnd(6)} ${chalk.white(p)}`);
    }
  }

  // ─── Positions ──────────────────────────────────────
  lines.push('');
  if (pos.length > 0) {
    lines.push(`  ${chalk.white.bold('POSITIONS')}`);
    let totalPnl = 0;
    for (const p of pos) {
      const pnlStr = p.pnl >= 0 ? chalk.green('+$' + Math.abs(p.pnl).toFixed(2)) : chalk.red('-$' + Math.abs(p.pnl).toFixed(2));
      const side = p.side === 'LONG' ? chalk.green('L') : chalk.red('S');
      lines.push(`  ${side} ${p.market.padEnd(8)} ${p.leverage.toFixed(1)}x  $${p.sizeUsd.toFixed(0).padEnd(8)} ${pnlStr}`);
      totalPnl += p.pnl;
    }
    const totalStr = totalPnl >= 0 ? chalk.green('+$' + Math.abs(totalPnl).toFixed(2)) : chalk.red('-$' + Math.abs(totalPnl).toFixed(2));
    lines.push(`  ${chalk.dim('Total PnL:')} ${totalStr}`);
  } else {
    lines.push(`  ${chalk.dim('No open positions')}`);
  }

  // ─── Balance ────────────────────────────────────────
  if (wallet.isConnected) {
    const solPrice = mkts.find(m => m.symbol === 'SOL')?.price ?? 0;
    const total = sol * solPrice + usdc;
    lines.push('');
    lines.push(`  ${chalk.white.bold('WALLET')}  ${chalk.dim(wallet.shortAddress)}`);
    lines.push(`  SOL ${sol.toFixed(4)}  USDC $${usdc.toFixed(2)}  ${chalk.dim('Total:')} $${total.toFixed(2)}`);
  }

  lines.push('');
  lines.push(`  ${chalk.dim('─'.repeat(56))}`);
  lines.push(`  ${chalk.dim('Refreshing every 5s │ Enter to exit')}`);
  lines.push('');

  return lines.join('\n');
}

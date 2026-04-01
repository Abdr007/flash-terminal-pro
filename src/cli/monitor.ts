/**
 * Monitor Mode — Live Market Table (matching flash-terminal exactly)
 *
 * Full-screen market monitor showing:
 *   - All markets with price, 24h change, OI, long/short ratio
 *   - Sorted by OI (most active first)
 *   - Auto-refresh every 5 seconds
 *   - Press q or Enter to exit
 */

import chalk from 'chalk';
import { createInterface } from 'readline';
import type { IStateEngine } from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';

const REFRESH_MS = 5_000;
const CLEAR = '\x1B[2J\x1B[0;0H';

export async function runMonitor(
  state: IStateEngine,
  api: FlashApiClient,
  _wallet: WalletManager,
): Promise<string> {
  let running = true;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    if (line.trim() === 'q' || line.trim() === '') { running = false; rl.close(); }
  });

  while (running) {
    try {
      const output = await buildMonitorFrame(state, api);
      process.stdout.write(CLEAR + output);
    } catch {
      process.stdout.write(chalk.dim('\n  Monitor refresh failed. Retrying...\n'));
    }

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
  api: FlashApiClient,
): Promise<string> {
  const now = new Date().toLocaleTimeString();
  const lines: string[] = [];

  // Header (matching flash-terminal)
  lines.push('');
  lines.push('');
  lines.push(`  ${chalk.cyan.bold('FLASH TERMINAL')} ${chalk.dim('—')} ${chalk.white.bold('MARKET MONITOR')}`);

  // Fetch all market data
  const [marketsResult, pricesResult] = await Promise.allSettled([
    state.getMarkets(),
    api.getPrices().catch(() => ({})),
  ]);

  const markets = marketsResult.status === 'fulfilled' ? marketsResult.value : [];
  const prices = pricesResult.status === 'fulfilled' ? pricesResult.value as Record<string, Record<string, unknown>> : {};

  // Build market rows from state data
  interface MarketRow {
    symbol: string;
    price: number;
    change24h: number;
    oi: number;
    longPct: number;
    shortPct: number;
  }

  const rows: MarketRow[] = [];
  for (const m of markets) {
    const pd = prices[m.symbol];
    const price = Number(pd?.priceUi ?? pd?.price ?? m.price ?? 0);
    const change = Number(pd?.change24h ?? m.change24h ?? 0);
    const totalOi = (m.oiLong ?? 0) + (m.oiShort ?? 0);
    const longPct = totalOi > 0 ? (m.oiLong / totalOi) * 100 : 50;
    const shortPct = totalOi > 0 ? (m.oiShort / totalOi) * 100 : 50;

    rows.push({
      symbol: m.symbol,
      price,
      change24h: change,
      oi: totalOi,
      longPct,
      shortPct,
    });
  }

  // Sort by OI descending (most active first)
  rows.sort((a, b) => b.oi - a.oi);

  lines.push(`  ${chalk.dim(`${now}  |  Press q to exit`)}`);
  lines.push(`  ${chalk.dim('─'.repeat(72))}`);

  // Table header
  lines.push(`  ${chalk.dim('Asset'.padEnd(16))}${chalk.dim('Price'.padEnd(15))}${chalk.dim('24h Change'.padEnd(13))}${chalk.dim('Open Interest'.padEnd(16))}${chalk.dim('Long / Short')}`);
  lines.push(`  ${chalk.dim('─'.repeat(72))}`);

  // Table rows
  for (const r of rows) {
    if (r.price <= 0) continue;

    // Format price
    let priceStr: string;
    if (r.price >= 1000) {
      priceStr = `$${r.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (r.price >= 1) {
      priceStr = `$${r.price.toFixed(4)}`;
    } else {
      priceStr = `$${r.price.toFixed(6)}`;
    }

    // Format 24h change
    const changeStr = r.change24h !== 0
      ? `${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(2)}%`
      : '+0.00%';
    const changeColor = r.change24h >= 0 ? chalk.green(changeStr) : chalk.red(changeStr);

    // Format OI
    let oiStr = '';
    if (r.oi >= 1_000_000) oiStr = `$${(r.oi / 1_000_000).toFixed(2)}M`;
    else if (r.oi >= 1_000) oiStr = `$${r.oi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    else if (r.oi > 0) oiStr = `$${r.oi.toFixed(2)}`;

    // Format long/short
    const lsStr = r.oi > 0 ? `${Math.round(r.longPct)} / ${Math.round(r.shortPct)}` : '';

    lines.push(`  ${r.symbol.padEnd(16)}${priceStr.padEnd(15)}${changeColor.padEnd(13 + (changeColor.length - changeStr.length))}${oiStr.padEnd(16)}${chalk.dim(lsStr)}`);
  }

  return lines.join('\n') + '\n';
}

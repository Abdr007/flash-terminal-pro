/**
 * Market Monitor — matching flash-terminal exactly
 *
 * Data sources (same as flash-terminal):
 *   - Flash API /prices → Pyth oracle prices
 *   - fstats.io /positions/open-interest → OI per market
 *   - Sorted by OI descending
 *   - Refreshes every 5s
 *   - Press q to exit
 */

import chalk from 'chalk';
import type { IStateEngine } from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';

const REFRESH_MS = 5_000;
const FSTATS_BASE = 'https://fstats.io/api/v1';

interface MarketRow {
  symbol: string;
  price: number;
  change24h: number;
  totalOi: number;
  longPct: number;
  shortPct: number;
}

export async function runMonitor(
  _state: IStateEngine,
  api: FlashApiClient,
  _wallet: WalletManager,
): Promise<string> {
  let running = true;

  // Track previous prices for direction detection
  const prevPrices = new Map<string, number>();

  // Set up raw mode for 'q' key exit
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Drain buffered input
  await new Promise<void>(resolve => {
    const drain = () => { /* discard */ };
    process.stdin.on('data', drain);
    setTimeout(() => { process.stdin.removeListener('data', drain); resolve(); }, 50);
  });

  const exitPromise = new Promise<void>(resolve => {
    const onKey = (buf: Buffer) => {
      const key = buf.toString();
      if (key === 'q' || key === 'Q' || key === '\x03') {
        running = false;
        process.stdin.removeListener('data', onKey);
        resolve();
      }
    };
    process.stdin.on('data', onKey);
  });

  // Main loop
  const loop = async () => {
    while (running) {
      try {
        const rows = await fetchData(api, prevPrices);
        if (!running) break;
        const frame = buildFrame(rows);
        // Clear screen and render
        process.stdout.write('\x1B[2J\x1B[0;0H' + frame);
      } catch {
        // Skip failed refresh
      }

      await Promise.race([
        new Promise(r => setTimeout(r, REFRESH_MS)),
        exitPromise,
      ]);
    }
  };

  await Promise.race([loop(), exitPromise]);

  // Restore terminal
  process.stdin.pause();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(wasRaw ?? false);
  }

  return '';
}

async function fetchData(
  api: FlashApiClient,
  prevPrices: Map<string, number>,
): Promise<MarketRow[]> {
  // Fetch prices + OI in parallel
  const [pricesRaw, oiRaw] = await Promise.all([
    api.getPrices().catch(() => ({})),
    fetch(`${FSTATS_BASE}/positions/open-interest`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .catch(() => ({ markets: [] })),
  ]);

  const prices = pricesRaw as Record<string, { priceUi?: number; price?: number }>;
  const oiMarkets = ((oiRaw as { markets?: unknown[] }).markets ?? []) as Array<{
    market?: string;
    long_oi?: number;
    short_oi?: number;
    total_oi?: number;
  }>;

  // Build OI map
  const oiMap = new Map<string, { longOi: number; shortOi: number; totalOi: number }>();
  for (const m of oiMarkets) {
    const sym = (m.market ?? '').toUpperCase();
    if (!sym) continue;
    const existing = oiMap.get(sym);
    const longOi = m.long_oi ?? 0;
    const shortOi = m.short_oi ?? 0;
    if (existing) {
      existing.longOi += longOi;
      existing.shortOi += shortOi;
      existing.totalOi += longOi + shortOi;
    } else {
      oiMap.set(sym, { longOi, shortOi, totalOi: longOi + shortOi });
    }
  }

  const rows: MarketRow[] = [];
  for (const [sym, pd] of Object.entries(prices)) {
    const price = Number(pd.priceUi ?? 0);
    if (price <= 0) continue;

    const oi = oiMap.get(sym.toUpperCase());
    const totalOi = oi?.totalOi ?? 0;
    const longPct = totalOi > 0 ? Math.round((oi!.longOi / totalOi) * 100) : 50;
    const shortPct = totalOi > 0 ? 100 - longPct : 50;

    // Track 24h change from price movement between refreshes
    // (Flash API doesn't provide 24h change, using stored previous)
    prevPrices.set(sym, price);

    rows.push({
      symbol: sym.toUpperCase(),
      price,
      change24h: 0, // Will be populated when we add CoinGecko/Pyth history
      totalOi,
      longPct,
      shortPct,
    });
  }

  // Sort by OI descending
  rows.sort((a, b) => b.totalOi - a.totalOi);
  return rows;
}

function buildFrame(rows: MarketRow[]): string {
  const now = new Date().toLocaleTimeString();
  const dim = chalk.dim;
  const green = chalk.green;
  const red = chalk.red;

  const lines: string[] = [
    '',
    '',
    `  ${chalk.hex('#00FF88').bold('FLASH TERMINAL')} ${dim('—')} ${chalk.hex('#00FF88').bold('MARKET MONITOR')}`,
    dim(`  ${now}  |  Press ${chalk.bold('q')} to exit`),
    `  ${dim('─'.repeat(72))}`,
    `  ${dim('Asset'.padEnd(18))}${dim('Price'.padStart(14))}${dim('24h Change'.padStart(12))}${dim('Open Interest'.padStart(16))}${dim('Long / Short'.padStart(14))}`,
    `  ${dim('─'.repeat(72))}`,
  ];

  for (const r of rows) {
    // Format price
    let priceStr: string;
    if (r.price >= 1000) {
      priceStr = `$${r.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (r.price >= 1) {
      priceStr = `$${r.price.toFixed(4)}`;
    } else {
      priceStr = `$${r.price.toFixed(6)}`;
    }

    // 24h change
    const changeStr = r.change24h !== 0
      ? `${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(2)}%`
      : '+0.00%';
    const changeColored = r.change24h > 0 ? green(changeStr) : r.change24h < 0 ? red(changeStr) : dim(changeStr);

    // OI
    let oiStr = '';
    if (r.totalOi >= 1_000_000) oiStr = `$${(r.totalOi / 1_000_000).toFixed(2)}M`;
    else if (r.totalOi > 0) oiStr = `$${r.totalOi.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // Long/Short ratio
    const ratioStr = r.totalOi > 0 ? `${r.longPct} / ${r.shortPct}` : '';

    lines.push(
      `  ${chalk.bold(r.symbol.padEnd(18))}${priceStr.padStart(14)}${changeColored.padStart(12 + (changeColored.length - changeStr.length))}${oiStr.padStart(16)}${dim(ratioStr.padStart(14))}`,
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * Market Monitor — exact flash-terminal replication
 *
 * Uses alternate screen buffer + line-by-line overwrite (like vim/htop).
 * Data: Pyth prices via Flash API + OI from fstats.io
 * Only shows tradeable markets from state engine.
 * Sorted by OI descending. Press 'q' to exit.
 */

import chalk from 'chalk';
import type { IStateEngine } from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';
import { formatPrice, formatUsd } from '../utils/format.js';

const REFRESH_MS = 5_000;
const FSTATS_OI_URL = 'https://fstats.io/api/v1/positions/open-interest';
const ACCENT = chalk.hex('#00FF88');

// ─── Renderer (matching flash-terminal's renderer.ts) ───────────────────────

class TermRenderer {
  private previousFrame: string[] = [];
  private inAltScreen = false;

  enterAltScreen(): void {
    if (!this.inAltScreen) {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      this.inAltScreen = true;
    }
  }

  leaveAltScreen(): void {
    if (this.inAltScreen) {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      this.inAltScreen = false;
    }
  }

  render(lines: string[]): void {
    const maxRows = (process.stdout.rows || 24) - 1;
    const visible = lines.slice(0, maxRows);
    let buf = '\x1b[?25l\x1b[H';
    for (const line of visible) {
      buf += line + '\x1b[K\n';
    }
    buf += '\x1b[J\x1b[?25h';
    process.stdout.write(buf);
    this.previousFrame = [...visible];
  }

  hasChanged(lines: string[]): boolean {
    const maxRows = (process.stdout.rows || 24) - 1;
    const visible = lines.slice(0, maxRows);
    if (visible.length !== this.previousFrame.length) return true;
    for (let i = 0; i < visible.length; i++) {
      if (visible[i] !== this.previousFrame[i]) return true;
    }
    return false;
  }
}

// ─── Data Types ─────────────────────────────────────────────────────────────

interface MarketRow {
  symbol: string;
  price: number;
  change24h: number;
  totalOi: number;
  longPct: number;
  shortPct: number;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function runMonitor(
  state: IStateEngine,
  api: FlashApiClient,
  _wallet: WalletManager,
): Promise<string> {
  let running = true;
  const renderer = new TermRenderer();

  // Get tradeable market symbols (exclude USDC, WSOL, XAUT, JitoSOL etc.)
  const markets = await state.getMarkets();
  // Use exact symbol casing from API for matching
  const tradeableSymbols = new Set(markets.map(m => m.symbol));

  // Pause readline, enter raw mode for 'q' key
  const wasRaw = process.stdin.isRaw;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  // Drain buffered input
  await new Promise<void>(r => {
    const drain = () => {};
    process.stdin.on('data', drain);
    setTimeout(() => { process.stdin.removeListener('data', drain); r(); }, 50);
  });

  // Enter alternate screen
  renderer.enterAltScreen();

  // Show loading
  renderer.render([
    '',
    `  ${ACCENT.bold('FLASH TERMINAL')} ${chalk.dim('—')} ${ACCENT.bold('MARKET MONITOR')}`,
    '',
    chalk.dim('  Loading market data...'),
  ]);

  // Fetch initial data
  let rows: MarketRow[] = [];
  let oracleMs = 0;
  try {
    const start = performance.now();
    rows = await fetchData(api, tradeableSymbols);
    oracleMs = Math.round(performance.now() - start);
  } catch { /* will show empty */ }

  // Render first frame
  renderer.render(buildFrame(rows, oracleMs));

  // Start refresh loop
  let refreshing = false;
  const interval = setInterval(async () => {
    if (!running || refreshing) return;
    refreshing = true;
    try {
      const start = performance.now();
      rows = await fetchData(api, tradeableSymbols);
      oracleMs = Math.round(performance.now() - start);
      if (!running) return;
      const frame = buildFrame(rows, oracleMs);
      if (renderer.hasChanged(frame)) renderer.render(frame);
    } catch { /* skip */ }
    finally { refreshing = false; }
  }, REFRESH_MS);

  // Wait for 'q' key
  await new Promise<void>(resolve => {
    const onKey = (buf: Buffer) => {
      const key = buf.toString();
      if (key === 'q' || key === 'Q' || key === '\x03') {
        running = false;
        process.stdin.removeListener('data', onKey);
        clearInterval(interval);
        renderer.leaveAltScreen();

        process.stdin.pause();
        if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);

        // Drain remaining input before returning to readline
        const drain2 = () => {};
        process.stdin.resume();
        process.stdin.on('data', drain2);
        setTimeout(() => {
          process.stdin.removeListener('data', drain2);
          process.stdin.pause();
          resolve();
        }, 100);
      }
    };
    process.stdin.on('data', onKey);
  });

  return '';
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchData(
  api: FlashApiClient,
  tradeableSymbols: Set<string>,
): Promise<MarketRow[]> {
  const [pricesRaw, oiRaw] = await Promise.all([
    api.getPrices().catch(() => ({})),
    fetch(FSTATS_OI_URL, { signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .catch(() => ({ markets: [] })),
  ]);

  const prices = pricesRaw as Record<string, { priceUi?: number; price?: number }>;
  const oiMarkets = ((oiRaw as { markets?: unknown[] }).markets ?? []) as Array<{
    market?: string; long_oi?: number; short_oi?: number;
  }>;

  // Build OI map (aggregate across pools for same symbol)
  const oiMap = new Map<string, { longOi: number; shortOi: number }>();
  for (const m of oiMarkets) {
    const sym = (m.market ?? '').toUpperCase();
    if (!sym) continue;
    const existing = oiMap.get(sym);
    if (existing) {
      existing.longOi += m.long_oi ?? 0;
      existing.shortOi += m.short_oi ?? 0;
    } else {
      oiMap.set(sym, { longOi: m.long_oi ?? 0, shortOi: m.short_oi ?? 0 });
    }
  }

  const rows: MarketRow[] = [];
  for (const [sym, pd] of Object.entries(prices)) {
    // Match against tradeable symbols (exact match first, then uppercase)
    if (!tradeableSymbols.has(sym) && !tradeableSymbols.has(sym.toUpperCase())) continue;

    const price = Number(pd.priceUi ?? 0);
    if (price <= 0) continue;

    // Normalize to uppercase for display and OI lookup
    const displaySym = sym.toUpperCase();
    // Skip collateral tokens
    if (displaySym === 'USDC' || displaySym === 'USDT' || displaySym === 'WSOL' || displaySym === 'XAUT') continue;

    const oi = oiMap.get(displaySym);
    const totalOi = oi ? oi.longOi + oi.shortOi : 0;
    const longPct = totalOi > 0 ? Math.round((oi!.longOi / totalOi) * 100) : 50;

    rows.push({
      symbol: displaySym,
      price,
      change24h: 0,
      totalOi,
      longPct,
      shortPct: totalOi > 0 ? 100 - longPct : 50,
    });
  }

  rows.sort((a, b) => b.totalOi - a.totalOi);
  return rows;
}

// ─── Frame Builder ──────────────────────────────────────────────────────────

function buildFrame(rows: MarketRow[], oracleMs: number): string[] {
  const now = new Date().toLocaleTimeString();
  const d = chalk.dim;

  // Telemetry status bar (matching flash-terminal)
  const oracleStr = oracleMs < 3000
    ? chalk.green(`Oracle ${oracleMs}ms`)
    : oracleMs < 5000
      ? chalk.yellow(`Oracle ${oracleMs}ms`)
      : chalk.red(`Oracle ${oracleMs}ms`);

  const lines: string[] = [
    `  ${ACCENT.bold('FLASH TERMINAL')} ${d('—')} ${ACCENT.bold('MARKET MONITOR')}`,
    `  ${oracleStr}  ${d('|')}  ${d('Divergence OK')}`,
    d(`  ${now}  |  Press ${chalk.bold('q')} to exit`),
    `  ${d('─'.repeat(72))}`,
    `  ${d('Asset')}${d('Price'.padStart(21))}${d('24h Change'.padStart(12))}${d('Open Interest'.padStart(16))}${d('Long / Short'.padStart(14))}`,
    `  ${d('─'.repeat(72))}`,
  ];

  for (const r of rows) {
    const priceStr = formatPrice(r.price);
    const changeStr = r.change24h !== 0
      ? `${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(2)}%`
      : '+0.00%';
    const changeColored = r.change24h > 0
      ? chalk.green(changeStr)
      : r.change24h < 0
        ? chalk.red(changeStr)
        : d(changeStr);

    const oiStr = r.totalOi > 0
      ? formatUsd(r.totalOi)
      : r.totalOi === 0 ? '$0.00' : '';

    const ratioStr = `${r.longPct} / ${r.shortPct}`;

    lines.push(
      `  ${chalk.bold(('  ' + r.symbol).padEnd(14))}${priceStr.padStart(14)}${changeColored.padStart(12 + (changeColored.length - changeStr.length))}${oiStr.padStart(16)}${d(ratioStr.padStart(14))}`,
    );
  }

  // Footer (matching flash-terminal)
  lines.push(`  ${d('─'.repeat(72))}`);
  lines.push(d(`  Source: Pyth Hermes (oracle) | fstats (open interest)`));

  return lines;
}

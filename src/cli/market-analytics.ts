/**
 * Market Data & Analytics Commands
 *
 * Data sources:
 *   - Flash API /pool-data → utilization, locked amounts, fee rates
 *   - fstats.io /pools → total volume, fees, trades, LP prices, pool PnL
 *   - fstats.io /volume/daily → daily volume breakdown
 *   - fstats.io /fees/daily → daily fee breakdown
 */

import chalk from 'chalk';
import { header, divider, kv, kvBold, section, usd, dim, tableHeader, tableRow } from './display.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { TxResult } from '../types/index.js';

const FSTATS_BASE = 'https://fstats.io/api/v1';

async function fetchFstats(path: string): Promise<unknown> {
  const resp = await fetch(`${FSTATS_BASE}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`fstats ${resp.status}`);
  return resp.json();
}

// ─── Volume ─────────────────────────────────────────────────────────────────

export async function handleVolume(): Promise<TxResult> {
  const lines: string[] = [header('PROTOCOL VOLUME')];

  try {
    const data = await fetchFstats('/pools') as { pools: { name: string; total_volume_usd: number; total_trades: number; total_fees_usd: number }[] };

    let totalVol = 0;
    let totalTrades = 0;
    let totalFees = 0;

    lines.push(tableHeader([
      { label: 'Pool', width: 14 },
      { label: 'Total Volume', width: 16 },
      { label: 'Trades', width: 12 },
      { label: 'Total Fees', width: 14 },
    ]));

    for (const p of data.pools) {
      totalVol += p.total_volume_usd;
      totalTrades += p.total_trades;
      totalFees += p.total_fees_usd;

      lines.push(tableRow([
        p.name, usd(p.total_volume_usd), p.total_trades.toLocaleString(), usd(p.total_fees_usd),
      ], [14, 16, 12, 14]));
    }

    lines.push(divider());
    lines.push(kvBold('Total Volume', usd(totalVol)));
    lines.push(kv('Total Trades', totalTrades.toLocaleString()));
    lines.push(kv('Total Fees', usd(totalFees)));

    // Daily volume
    try {
      const daily = await fetchFstats('/volume/daily?pool=Crypto.1&days=7') as { data: { date: string; volume_usd: number; trades: number }[] };
      if (daily.data?.length > 0) {
        lines.push(section('CRYPTO.1 — LAST 7 DAYS'));
        for (const d of daily.data.slice(0, 7)) {
          lines.push(`  ${dim(d.date)} ${usd(d.volume_usd).padEnd(14)} ${dim(d.trades + ' trades')}`);
        }
      }
    } catch { /* ok */ }
  } catch {
    lines.push(`  ${dim('Volume data unavailable. Check fstats.io.')}`);
  }

  lines.push('');
  lines.push(`  ${dim('Source: fstats.io')}`);
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── Open Interest ──────────────────────────────────────────────────────────

export async function handleOpenInterest(api: FlashApiClient): Promise<TxResult> {
  const poolData = await api.getPoolData() as Record<string, unknown>;
  const pools = (poolData['pools'] ?? []) as Record<string, unknown>[];

  const lines: string[] = [header('OPEN INTEREST')];

  let totalLocked = 0;

  lines.push(tableHeader([
    { label: 'Pool', width: 14 },
    { label: 'OI (est)', width: 14 },
    { label: 'Utilization', width: 12 },
    { label: 'Capacity', width: 12 },
  ]));

  for (const pool of pools) {
    const name = String(pool['poolName'] ?? '');
    const custodies = (pool['custodyStats'] ?? []) as Record<string, unknown>[];

    let poolLocked = 0;
    let poolTotal = 0;

    for (const c of custodies) {
      const locked = Number(c['lockedAmountUi'] ?? 0) * Number(c['priceUi'] ?? 0);
      const total = Number(c['totalUsdOwnedAmountUi'] ?? 0);
      poolLocked += locked;
      poolTotal += total;
    }

    totalLocked += poolLocked;
    const util = poolTotal > 0 ? (poolLocked / poolTotal * 100) : 0;
    const utilStr = util > 70 ? chalk.red(util.toFixed(1) + '%') : util > 40 ? chalk.yellow(util.toFixed(1) + '%') : chalk.green(util.toFixed(1) + '%');

    lines.push(tableRow([name, usd(poolLocked), utilStr, usd(poolTotal)], [14, 14, 12, 12]));
  }

  lines.push(divider());
  lines.push(kvBold('Total OI (est)', usd(totalLocked)));
  lines.push(`\n  ${dim('OI estimated from locked amounts. Source: Flash API /pool-data')}\n`);
  return { success: true, error: lines.join('\n') };
}

// ─── Funding / Utilization ──────────────────────────────────────────────────

export async function handleFunding(api: FlashApiClient, symbol?: string): Promise<TxResult> {
  const poolData = await api.getPoolData() as Record<string, unknown>;
  const pools = (poolData['pools'] ?? []) as Record<string, unknown>[];

  const lines: string[] = [header(symbol ? `FUNDING — ${symbol}` : 'FUNDING & UTILIZATION')];

  lines.push(tableHeader([
    { label: 'Asset', width: 10 },
    { label: 'Pool', width: 14 },
    { label: 'Util %', width: 10 },
    { label: 'Locked', width: 12 },
    { label: 'Available', width: 12 },
  ]));

  for (const pool of pools) {
    const name = String(pool['poolName'] ?? '');
    const custodies = (pool['custodyStats'] ?? []) as Record<string, unknown>[];

    for (const c of custodies) {
      const sym = String(c['symbol'] ?? '');
      if (symbol && sym.toUpperCase() !== symbol.toUpperCase()) continue;

      const util = Number(c['utilizationUi'] ?? 0);
      const locked = usd(Number(c['lockedAmountUi'] ?? 0) * Number(c['priceUi'] ?? 1));
      const available = usd(Number(c['availableToAddUsdUi'] ?? 0));
      const utilStr = util > 70 ? chalk.red(util.toFixed(1) + '%') : util > 40 ? chalk.yellow(util.toFixed(1) + '%') : chalk.green(util.toFixed(1) + '%');

      lines.push(tableRow([sym, name, utilStr, locked, available], [10, 14, 10, 12, 12]));
    }
  }

  lines.push('');
  lines.push(`  ${dim('Higher utilization = higher borrow fees for traders')}`);
  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── Protocol Fees ──────────────────────────────────────────────────────────

export async function handleFees(): Promise<TxResult> {
  const lines: string[] = [header('PROTOCOL FEES')];

  try {
    const data = await fetchFstats('/pools') as { pools: { name: string; total_fees_usd: number; fee_split: { lp: number; token: number; team: number }; pool_revenue_usd: number; pool_pnl_usd: number }[] };

    let totalFees = 0;
    let totalRevenue = 0;

    lines.push(tableHeader([
      { label: 'Pool', width: 14 },
      { label: 'Total Fees', width: 14 },
      { label: 'LP Share', width: 10 },
      { label: 'Revenue', width: 14 },
      { label: 'Pool PnL', width: 14 },
    ]));

    for (const p of data.pools) {
      totalFees += p.total_fees_usd;
      totalRevenue += p.pool_revenue_usd;

      const pnlColor = p.pool_pnl_usd >= 0 ? chalk.green(usd(p.pool_pnl_usd)) : chalk.red(usd(p.pool_pnl_usd));

      lines.push(tableRow([
        p.name, usd(p.total_fees_usd), p.fee_split.lp + '%', usd(p.pool_revenue_usd), pnlColor,
      ], [14, 14, 10, 14, 14]));
    }

    lines.push(divider());
    lines.push(kvBold('Total Fees', usd(totalFees)));
    lines.push(kv('Total Revenue', usd(totalRevenue)));

    // Daily fees
    try {
      const daily = await fetchFstats('/fees/daily?pool=Crypto.1&days=7') as { data: { date: string; total_fees: number; lp_share: number }[] };
      if (daily.data?.length > 0) {
        lines.push(section('CRYPTO.1 — DAILY FEES'));
        for (const d of daily.data.slice(0, 7)) {
          lines.push(`  ${dim(d.date)} ${usd(d.total_fees).padEnd(12)} LP: ${usd(d.lp_share)}`);
        }
      }
    } catch { /* ok */ }
  } catch {
    lines.push(`  ${dim('Fee data unavailable. Check fstats.io.')}`);
  }

  lines.push('');
  lines.push(`  ${dim('Source: fstats.io')}`);
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── NOT SUPPORTED Commands ─────────────────────────────────────────────────

export function handleNotSupported(command: string): TxResult {
  return {
    success: true,
    error: [
      '',
      `  ${dim(command + ' — data not available via public API.')}`,
      `  ${dim('This data is tracked by Flash Trade\'s internal systems.')}`,
      `  ${dim('Check flash.trade website for this information.')}`,
      '',
    ].join('\n'),
  };
}

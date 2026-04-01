/**
 * Earn Command Handlers
 *
 * All 16 earn commands. Output format matches flash-terminal exactly.
 */

import chalk from 'chalk';
import {
  header, divider, kv, kvBold, section,
  usd, dim, warning,
  tableHeader, tableRow,
} from '../cli/display.js';
import { getPoolRegistry, resolveEarnPool } from './pool-registry.js';
import { getPoolMetrics } from './pool-data.js';
import { rankPools, simulateYield, classifyDemand, classifyRisk } from './yield-analytics.js';
import { calculateEarnPnl, getEarnJournal } from './earn-journal.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { TxResult } from '../types/index.js';

// ─── 1. earn (pool overview) ────────────────────────────────────────────────

export async function handleEarnOverview(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);

  const lines: string[] = [header('FLASH EARN — LIQUIDITY POOLS')];

  lines.push(tableHeader([
    { label: 'Pool', width: 14 },
    { label: 'TVL', width: 12 },
    { label: 'FLP Price', width: 10 },
    { label: 'APY', width: 8 },
    { label: 'Fee %', width: 6 },
    { label: 'Assets', width: 20 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    const tvl = m ? usd(m.tvl) : '—';
    const flp = m ? '$' + m.flpPrice.toFixed(4) : '—';
    const apy = m ? `~${m.apy7d.toFixed(1)}%` : '—';
    const fee = (pool.feeShare * 100).toFixed(0) + '%';
    const assets = pool.assets.join(' ');

    lines.push(tableRow([
      pool.aliases[0], tvl, flp, apy, fee, assets,
    ], [14, 12, 10, 8, 6, 20]));
  }

  lines.push('');
  lines.push(`  ${dim('FLP = auto-compound │ sFLP = USDC hourly rewards')}`);
  lines.push(`  ${dim('Type "earn info <pool>" for details')}`);
  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 2. earn info <pool> ────────────────────────────────────────────────────

export async function handleEarnInfo(poolAlias: string, api: FlashApiClient): Promise<TxResult> {
  const pool = resolveEarnPool(poolAlias);
  if (!pool) return { success: false, error: `  Pool not found: "${poolAlias}". Type "earn" to see all pools.` };

  const metrics = await getPoolMetrics(api);
  const m = metrics.get(pool.poolId);

  const lines: string[] = [header(pool.displayName)];

  lines.push(kv('Pool ID', pool.poolId));
  lines.push(kv('Fee Share', (pool.feeShare * 100).toFixed(0) + '%'));
  lines.push(kv('FLP Token', `${pool.flpSymbol} ${m ? '($' + m.flpPrice.toFixed(4) + ')' : ''}`));
  lines.push(kv('sFLP Token', `${pool.sflpSymbol} ${m ? '($' + m.sflpPrice.toFixed(4) + ')' : ''}`));
  lines.push(kv('TVL', m ? usd(m.tvl) : '—'));
  lines.push(kv('Est. APY', m ? `~${m.apy7d.toFixed(1)}%` : '—'));
  lines.push(kv('Stable %', m ? m.stablePct.toFixed(1) + '%' : '—'));
  lines.push(kv('Assets', pool.assets.join(', ')));

  if (m) {
    const risk = classifyRisk(m.tvl, m.apy7d);
    const riskColor = risk === 'Low' ? chalk.green(risk) : risk === 'Medium' ? chalk.cyan(risk) : risk === 'High' ? chalk.yellow(risk) : chalk.red(risk);
    lines.push(kv('Risk', riskColor));
  }

  lines.push(divider());
  lines.push(`  ${dim('Deposit: "earn deposit $100 ' + pool.aliases[0] + '"')}`);
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 3. earn best ───────────────────────────────────────────────────────────

export async function handleEarnBest(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);
  const ranked = rankPools(registry, metrics);

  const lines: string[] = [header('TOP YIELD POOLS')];

  for (const r of ranked) {
    const riskColor = r.risk === 'Low' ? chalk.green(r.risk) : r.risk === 'Medium' ? chalk.cyan(r.risk) : chalk.yellow(r.risk);
    const medal = r.rank === 1 ? '  1.' : r.rank === 2 ? '  2.' : r.rank === 3 ? '  3.' : `  ${r.rank}.`;

    lines.push(`${chalk.bold(medal)} ${chalk.white.bold(r.pool.displayName)}`);
    lines.push(`     Est. APY: ~${r.metrics.apy7d.toFixed(1)}%   TVL: ${usd(r.metrics.tvl)}   Risk: ${riskColor}`);
    lines.push(`     FLP: $${r.metrics.flpPrice.toFixed(4)}   Fee Share: ${(r.pool.feeShare * 100).toFixed(0)}%   Assets: ${r.pool.assets.join(', ')}`);
    lines.push('');
  }

  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 4. earn simulate ───────────────────────────────────────────────────────

export async function handleEarnSimulate(amount: number, poolAlias: string, api: FlashApiClient): Promise<TxResult> {
  const pool = resolveEarnPool(poolAlias);
  if (!pool) return { success: false, error: `  Pool not found: "${poolAlias}"` };

  const metrics = await getPoolMetrics(api);
  const m = metrics.get(pool.poolId);
  if (!m) return { success: false, error: `  No data for ${pool.displayName}` };

  const proj = simulateYield(amount, m.apy7d);

  const lines: string[] = [header(`${pool.displayName} — Yield Projection`)];

  lines.push(kvBold('Deposit', usd(proj.depositUsd)));
  lines.push(kv('Est. APY', `~${proj.apy.toFixed(2)}%`));
  lines.push(kv('FLP Price', '$' + m.flpPrice.toFixed(4)));
  lines.push(kv('Pool TVL', usd(m.tvl)));

  lines.push(section('ESTIMATED RETURNS'));
  lines.push(kv('Daily', `~+${usd(proj.daily)}`));
  lines.push(kv('Weekly', `~+${usd(proj.weekly)}`));
  lines.push(kv('Monthly', `~+${usd(proj.monthly)}`));
  lines.push(kv('Yearly', `~+${usd(proj.yearly)}`));
  lines.push(kvBold('Projected (1yr)', `~${usd(proj.projectedValue1yr)}`));

  lines.push('');
  lines.push(warning('APY is estimated and may vary. Past performance is not indicative of future results.'));
  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 5. earn demand ─────────────────────────────────────────────────────────

export async function handleEarnDemand(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);

  const lines: string[] = [header('LIQUIDITY DEMAND ANALYSIS')];

  lines.push(tableHeader([
    { label: 'Pool', width: 14 },
    { label: 'APY', width: 8 },
    { label: 'TVL', width: 12 },
    { label: 'Fee Share', width: 10 },
    { label: 'Demand', width: 12 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    if (!m || m.tvl <= 0) continue;

    const demand = classifyDemand(m.apy7d, m.tvl);
    const demandColor = demand === 'Very High' ? chalk.red(demand) : demand === 'High' ? chalk.yellow(demand) : demand === 'Medium' ? chalk.cyan(demand) : dim(demand);

    lines.push(tableRow([
      pool.aliases[0],
      `${m.apy7d.toFixed(1)}%`,
      usd(m.tvl),
      (pool.feeShare * 100).toFixed(0) + '%',
      demandColor,
    ], [14, 8, 12, 10, 12]));
  }

  lines.push('');
  lines.push(`  ${dim('High demand = high APY relative to TVL = opportunity for LPs')}`);
  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 6. earn rotate ─────────────────────────────────────────────────────────

export async function handleEarnRotate(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);
  const ranked = rankPools(registry, metrics);

  const lines: string[] = [header('LIQUIDITY ROTATION ANALYSIS')];

  if (ranked.length === 0) {
    lines.push(`  ${dim('No pool data available')}`);
    return { success: true, error: lines.join('\n') };
  }

  const best = ranked[0];
  lines.push(section('BEST OPPORTUNITY'));
  lines.push(kv('Pool', chalk.white.bold(best.pool.displayName)));
  lines.push(kv('APY', `~${best.metrics.apy7d.toFixed(1)}%`));
  lines.push(kv('TVL', usd(best.metrics.tvl)));
  lines.push(kv('Risk', best.risk));

  lines.push(section('SUGGESTION'));
  lines.push(`  ${dim('If you have positions in lower-APY pools,')}`);
  lines.push(`  ${dim('consider rotating to ' + best.pool.aliases[0] + ' for higher yield.')}`);
  lines.push('');
  lines.push(`  ${dim('To deposit: "earn deposit $<amount> ' + best.pool.aliases[0] + '"')}`);

  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 7. earn dashboard ──────────────────────────────────────────────────────

export async function handleEarnDashboard(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);

  const lines: string[] = [header('FLASH EARN PORTFOLIO')];

  // Summary
  let totalTvl = 0;
  for (const [, m] of metrics) totalTvl += m.tvl;

  lines.push(kv('Total TVL', chalk.white.bold(usd(totalTvl))));
  lines.push(kv('Pools Active', String(metrics.size)));
  lines.push('');

  // Pool table
  lines.push(tableHeader([
    { label: 'Pool', width: 14 },
    { label: 'TVL', width: 12 },
    { label: 'APY', width: 8 },
    { label: 'FLP', width: 10 },
    { label: 'Risk', width: 10 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    if (!m) continue;
    const risk = classifyRisk(m.tvl, m.apy7d);
    const riskColor = risk === 'Low' ? chalk.green(risk) : risk === 'Medium' ? chalk.cyan(risk) : chalk.yellow(risk);
    lines.push(tableRow([
      pool.aliases[0], usd(m.tvl), `~${m.apy7d.toFixed(1)}%`, '$' + m.flpPrice.toFixed(4), riskColor,
    ], [14, 12, 8, 10, 10]));
  }

  lines.push('');
  lines.push(`  ${dim('Earn execution: use "earn deposit $<amt> <pool>" (requires SDK)')}`);
  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 8. earn pnl ────────────────────────────────────────────────────────────

export async function handleEarnPnl(): Promise<TxResult> {
  const pnl = calculateEarnPnl([]);  // No live positions without SDK token scan

  const lines: string[] = [header('EARN PERFORMANCE')];

  lines.push(kv('Total Deposited', usd(pnl.totalDeposited)));
  lines.push(kv('Total Withdrawn', usd(pnl.totalWithdrawn)));
  lines.push(kv('Current Value', usd(pnl.currentValue)));

  const pnlColor = pnl.pnl >= 0 ? chalk.green('+' + usd(pnl.pnl)) : chalk.red(usd(pnl.pnl));
  lines.push(kvBold('PnL', pnlColor));

  if (pnl.totalDeposited === 0 && pnl.totalWithdrawn === 0) {
    lines.push('');
    lines.push(`  ${dim('No earn activity recorded yet.')}`);
    lines.push(`  ${dim('Deposit to start tracking: "earn deposit $100 crypto"')}`);
  }

  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 9. earn positions ──────────────────────────────────────────────────────

export async function handleEarnPositions(): Promise<TxResult> {
  const lines: string[] = [header('YOUR EARN POSITIONS')];

  lines.push(`  ${dim('Earn position tracking requires wallet token scan.')}`);
  lines.push(`  ${dim('Use "wallet tokens" to see all token holdings.')}`);
  lines.push(`  ${dim('FLP/sFLP tokens in your wallet represent earn positions.')}`);

  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 10. earn history <pool> ────────────────────────────────────────────────

export async function handleEarnHistory(poolAlias?: string): Promise<TxResult> {
  const journal = getEarnJournal(poolAlias ? resolveEarnPool(poolAlias)?.poolId : undefined);

  const lines: string[] = [header(poolAlias ? `${poolAlias} — Earn History` : 'EARN HISTORY')];

  if (journal.length === 0) {
    lines.push(`  ${dim('No earn transactions recorded.')}`);
    lines.push(divider());
    lines.push('');
    return { success: true, error: lines.join('\n') };
  }

  lines.push(tableHeader([
    { label: 'Date', width: 12 },
    { label: 'Action', width: 10 },
    { label: 'Pool', width: 14 },
    { label: 'Amount', width: 12 },
  ]));

  for (const entry of journal.slice(-20).reverse()) {
    const date = new Date(entry.timestamp).toISOString().slice(0, 10);
    const action = entry.action === 'deposit' ? chalk.green('deposit') : chalk.red('withdraw');
    lines.push(tableRow([date, action, entry.pool, usd(entry.amountUsd)], [12, 10, 14, 12]));
  }

  lines.push(divider());
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 11-16. Execution commands (deposit/withdraw/stake/unstake/claim) ───────

export function handleEarnExecution(action: string): TxResult {
  return {
    success: false,
    error: [
      '',
      `  ${chalk.yellow('Earn ' + action + ' requires on-chain transaction.')}`,
      `  ${dim('This operation uses the Flash SDK (isolated).')}`,
      `  ${dim('Ensure wallet is connected and SDK service is active.')}`,
      '',
      `  ${dim('Alternatively, use flash.trade website for earn operations.')}`,
      '',
    ].join('\n'),
  };
}

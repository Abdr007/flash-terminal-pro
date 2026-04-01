/**
 * Earn Command Handlers — Premium Terminal Experience
 *
 * All 16 earn commands with rich formatting, risk indicators,
 * flow guidance, and intelligent recommendations.
 */

import chalk from 'chalk';
import {
  header, divider, kv, kvBold, section,
  usd, dim, warning, allocBar,
  tableHeader, tableRow,
} from '../cli/display.js';
import { getPoolRegistry, resolveEarnPool } from './pool-registry.js';
import { getPoolMetrics } from './pool-data.js';
import { rankPools, simulateYield, classifyDemand, classifyRisk } from './yield-analytics.js';
import { calculateEarnPnl, getEarnJournal } from './earn-journal.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { TxResult } from '../types/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function riskBadge(risk: string): string {
  switch (risk) {
    case 'Low': return chalk.green(' LOW ');
    case 'Medium': return chalk.cyan(' MED ');
    case 'High': return chalk.yellow(' HIGH');
    case 'Very High': return chalk.red(' VHIGH');
    default: return dim(' — ');
  }
}

function apyColor(apy: number): string {
  const str = `~${apy.toFixed(1)}%`;
  if (apy > 80) return chalk.green.bold(str);
  if (apy > 40) return chalk.green(str);
  if (apy > 20) return chalk.cyan(str);
  return dim(str);
}

function flowHint(next: string): string {
  return `\n  ${dim('Next:')} ${next}\n`;
}

// ─── 1. earn (pool overview) ────────────────────────────────────────────────

export async function handleEarnOverview(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);

  const lines: string[] = [header('FLASH EARN — LIQUIDITY POOLS')];

  lines.push(tableHeader([
    { label: 'Pool', width: 12 },
    { label: 'TVL', width: 11 },
    { label: 'FLP', width: 9 },
    { label: 'APY', width: 9 },
    { label: 'Risk', width: 7 },
    { label: 'Fee', width: 5 },
    { label: 'Assets', width: 18 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    if (!m) continue;
    const risk = classifyRisk(m.tvl, m.apy7d);

    lines.push(tableRow([
      pool.aliases[0],
      usd(m.tvl),
      '$' + m.flpPrice.toFixed(4),
      apyColor(m.apy7d),
      riskBadge(risk),
      (pool.feeShare * 100).toFixed(0) + '%',
      pool.assets.slice(0, 3).join(' ') + (pool.assets.length > 3 ? '...' : ''),
    ], [12, 11, 9, 9, 7, 5, 18]));
  }

  lines.push('');
  lines.push(`  ${chalk.green('FLP')} = auto-compound  ${chalk.cyan('sFLP')} = USDC hourly rewards`);
  lines.push(divider());
  lines.push(flowHint('earn info <pool> │ earn best │ earn simulate $1000 crypto │ earn dashboard'));
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
  lines.push(kv('Fee Share', chalk.white.bold((pool.feeShare * 100).toFixed(0) + '%') + dim(' of trading fees → LPs')));
  lines.push(kv('FLP Token', `${pool.flpSymbol} ${m ? chalk.green('$' + m.flpPrice.toFixed(4)) : ''} ${dim('(auto-compound)')}`));
  lines.push(kv('sFLP Token', `${pool.sflpSymbol} ${m ? chalk.cyan('$' + m.sflpPrice.toFixed(4)) : ''} ${dim('(USDC rewards)')}`));
  lines.push(kv('TVL', m ? chalk.white.bold(usd(m.tvl)) : '—'));
  lines.push(kv('Est. APY', m ? apyColor(m.apy7d) : '—'));
  lines.push(kv('Stable %', m ? m.stablePct.toFixed(1) + '%' : '—'));
  lines.push(kv('Assets', pool.assets.join(', ')));

  if (m) {
    const risk = classifyRisk(m.tvl, m.apy7d);
    lines.push(kv('Risk Level', riskBadge(risk)));

    // Yield preview for $1000
    const proj = simulateYield(1000, m.apy7d);
    lines.push('');
    lines.push(`  ${dim('$1,000 deposit would earn:')}`);
    lines.push(`  ${dim('  Daily:')} ${chalk.green('+' + usd(proj.daily))}  ${dim('Monthly:')} ${chalk.green('+' + usd(proj.monthly))}  ${dim('Yearly:')} ${chalk.green('+' + usd(proj.yearly))}`);
  }

  lines.push(divider());
  lines.push(flowHint(`earn deposit $100 ${pool.aliases[0]} │ earn simulate $1000 ${pool.aliases[0]} │ earn best`));
  return { success: true, error: lines.join('\n') };
}

// ─── 3. earn best ───────────────────────────────────────────────────────────

export async function handleEarnBest(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);
  const ranked = rankPools(registry, metrics);

  const lines: string[] = [header('TOP YIELD POOLS — RANKED')];

  for (const r of ranked) {
    const medal = r.rank === 1 ? chalk.yellow('  1.') : r.rank === 2 ? chalk.white('  2.') : r.rank === 3 ? chalk.red('  3.') : dim(`  ${r.rank}.`);
    const highlight = r.rank <= 3;

    const name = highlight ? chalk.white.bold(r.pool.displayName) : dim(r.pool.displayName);
    lines.push(`${medal} ${name}  ${riskBadge(r.risk)}`);
    lines.push(`     APY: ${apyColor(r.metrics.apy7d)}   TVL: ${usd(r.metrics.tvl)}   FLP: $${r.metrics.flpPrice.toFixed(4)}`);
    lines.push(`     Fee: ${(r.pool.feeShare * 100).toFixed(0)}%   Assets: ${r.pool.assets.join(', ')}`);

    if (r.rank <= 3) {
      const proj = simulateYield(1000, r.metrics.apy7d);
      lines.push(`     ${dim('$1K → +' + usd(proj.monthly) + '/mo  +' + usd(proj.yearly) + '/yr')}`);
    }
    lines.push('');
  }

  lines.push(divider());
  lines.push(flowHint('earn info <pool> │ earn simulate $<amt> <pool> │ earn deposit $<amt> <pool>'));
  return { success: true, error: lines.join('\n') };
}

// ─── 4. earn simulate (enhanced with compounding) ───────────────────────────

export async function handleEarnSimulate(amount: number, poolAlias: string, api: FlashApiClient): Promise<TxResult> {
  const pool = resolveEarnPool(poolAlias);
  if (!pool) return { success: false, error: `  Pool not found: "${poolAlias}"` };

  const metrics = await getPoolMetrics(api);
  const m = metrics.get(pool.poolId);
  if (!m) return { success: false, error: `  No data for ${pool.displayName}` };

  const proj = simulateYield(amount, m.apy7d);

  // Compounding estimate (FLP auto-compounds)
  const compoundedYearly = amount * (Math.pow(1 + m.apy7d / 100 / 365, 365) - 1);
  const compoundedValue = amount + compoundedYearly;

  // Fee impact estimate (15 bps USDC withdrawal fee)
  const withdrawFee = amount * 0.0015;

  const lines: string[] = [header(`${pool.displayName} — Yield Projection`)];

  lines.push(kvBold('Deposit', usd(proj.depositUsd)));
  lines.push(kv('Est. APY', apyColor(proj.apy)));
  lines.push(kv('FLP Price', '$' + m.flpPrice.toFixed(4)));
  lines.push(kv('Pool TVL', usd(m.tvl)));
  lines.push(kv('Risk', riskBadge(classifyRisk(m.tvl, m.apy7d))));

  lines.push(section('SIMPLE RETURNS'));
  lines.push(`  ${dim('Daily')}     ${chalk.green('+' + usd(proj.daily))}`);
  lines.push(`  ${dim('Weekly')}    ${chalk.green('+' + usd(proj.weekly))}`);
  lines.push(`  ${dim('Monthly')}   ${chalk.green('+' + usd(proj.monthly))}`);
  lines.push(`  ${dim('Yearly')}    ${chalk.green('+' + usd(proj.yearly))}`);

  lines.push(section('WITH COMPOUNDING (FLP)'));
  lines.push(`  ${dim('Yearly')}    ${chalk.green.bold('+' + usd(compoundedYearly))}`);
  lines.push(`  ${dim('Value')}     ${chalk.white.bold(usd(compoundedValue))}`);
  lines.push(`  ${dim('vs Simple')} ${chalk.green('+' + usd(compoundedYearly - proj.yearly) + ' extra')}`);

  lines.push(section('FEE IMPACT'));
  lines.push(`  ${dim('USDC withdraw fee:')} ${usd(withdrawFee)} ${dim('(15 bps)')}`);
  lines.push(`  ${dim('Break-even time:')} ${withdrawFee > 0 && proj.daily > 0 ? Math.ceil(withdrawFee / proj.daily) + ' days' : '—'}`);

  lines.push('');
  lines.push(warning('APY is estimated. Past performance does not guarantee future results.'));
  lines.push(divider());
  lines.push(flowHint(`earn deposit $${amount} ${pool.aliases[0]} │ earn best │ earn info ${pool.aliases[0]}`));
  return { success: true, error: lines.join('\n') };
}

// ─── 5. earn demand ─────────────────────────────────────────────────────────

export async function handleEarnDemand(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);

  const lines: string[] = [header('LIQUIDITY DEMAND ANALYSIS')];

  lines.push(tableHeader([
    { label: 'Pool', width: 12 },
    { label: 'APY', width: 9 },
    { label: 'TVL', width: 11 },
    { label: 'Fee', width: 5 },
    { label: 'Demand', width: 12 },
    { label: 'Opportunity', width: 14 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    if (!m || m.tvl <= 0) continue;

    const demand = classifyDemand(m.apy7d, m.tvl);
    const demandStr = demand === 'Very High' ? chalk.green.bold(demand) : demand === 'High' ? chalk.green(demand) : demand === 'Medium' ? chalk.cyan(demand) : dim(demand);

    // Opportunity: high demand + low TVL = best opportunity for new LPs
    const opportunity = demand === 'Very High' || demand === 'High' ? chalk.green('>>> ENTER') : demand === 'Medium' ? chalk.cyan('> Consider') : dim('Saturated');

    lines.push(tableRow([
      pool.aliases[0], apyColor(m.apy7d), usd(m.tvl), (pool.feeShare * 100).toFixed(0) + '%', demandStr, opportunity,
    ], [12, 9, 11, 5, 12, 14]));
  }

  lines.push('');
  lines.push(`  ${chalk.green('>>> ENTER')} = high APY + low TVL = best LP opportunity`);
  lines.push(divider());
  lines.push(flowHint('earn best │ earn simulate $1000 <pool> │ earn deposit $<amt> <pool>'));
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
  const worst = ranked[ranked.length - 1];

  lines.push(section('BEST OPPORTUNITY'));
  lines.push(kv('Pool', chalk.green.bold(best.pool.displayName)));
  lines.push(kv('APY', apyColor(best.metrics.apy7d)));
  lines.push(kv('TVL', usd(best.metrics.tvl)));
  lines.push(kv('Risk', riskBadge(best.risk)));

  // Show what $1000 would earn
  const bestProj = simulateYield(1000, best.metrics.apy7d);
  const worstProj = simulateYield(1000, worst.metrics.apy7d);
  const extraYearly = bestProj.yearly - worstProj.yearly;

  lines.push(section('ROTATION IMPACT ($1,000)'));
  lines.push(`  ${dim('Best pool:')}  ${chalk.green('+' + usd(bestProj.yearly) + '/yr')} ${dim('(' + best.pool.aliases[0] + ')')}`);
  lines.push(`  ${dim('Worst pool:')} ${dim('+' + usd(worstProj.yearly) + '/yr')} ${dim('(' + worst.pool.aliases[0] + ')')}`);
  lines.push(`  ${dim('Difference:')} ${chalk.green.bold('+' + usd(extraYearly) + '/yr extra')}`);

  lines.push(section('RECOMMENDATION'));
  lines.push(`  ${dim('Rotate to')} ${chalk.white.bold(best.pool.aliases[0])} ${dim('for highest risk-adjusted yield.')}`);
  lines.push(`  ${dim('Command:')} earn deposit $<amount> ${best.pool.aliases[0]}`);

  lines.push(divider());
  lines.push(flowHint(`earn deposit $100 ${best.pool.aliases[0]} │ earn simulate $1000 ${best.pool.aliases[0]} │ earn best`));
  return { success: true, error: lines.join('\n') };
}

// ─── 7. earn dashboard ──────────────────────────────────────────────────────

export async function handleEarnDashboard(api: FlashApiClient): Promise<TxResult> {
  const registry = getPoolRegistry();
  const metrics = await getPoolMetrics(api);
  const ranked = rankPools(registry, metrics);

  let totalTvl = 0;
  for (const [, m] of metrics) totalTvl += m.tvl;

  const lines: string[] = [header('FLASH EARN DASHBOARD')];

  lines.push(kvBold('Total Protocol TVL', usd(totalTvl)));
  lines.push(kv('Active Pools', String(metrics.size)));
  lines.push(kv('Best APY', ranked.length > 0 ? apyColor(ranked[0].metrics.apy7d) + dim(' (' + ranked[0].pool.aliases[0] + ')') : '—'));

  lines.push(section('POOL OVERVIEW'));
  lines.push(tableHeader([
    { label: 'Pool', width: 12 },
    { label: 'TVL', width: 11 },
    { label: 'APY', width: 9 },
    { label: 'FLP', width: 9 },
    { label: 'Risk', width: 7 },
    { label: 'Alloc', width: 18 },
  ]));

  for (const pool of registry) {
    const m = metrics.get(pool.poolId);
    if (!m) continue;
    const risk = classifyRisk(m.tvl, m.apy7d);
    const pct = totalTvl > 0 ? (m.tvl / totalTvl) * 100 : 0;

    lines.push(tableRow([
      pool.aliases[0], usd(m.tvl), apyColor(m.apy7d), '$' + m.flpPrice.toFixed(4), riskBadge(risk), allocBar(pct, 12) + ' ' + pct.toFixed(0) + '%',
    ], [12, 11, 9, 9, 7, 18]));
  }

  lines.push(divider());
  lines.push(flowHint('earn best │ earn simulate $1000 crypto │ earn demand │ earn pnl'));
  return { success: true, error: lines.join('\n') };
}

// ─── 8. earn pnl (enhanced) ─────────────────────────────────────────────────

export async function handleEarnPnl(): Promise<TxResult> {
  const pnl = calculateEarnPnl([]);

  const lines: string[] = [header('EARN PERFORMANCE')];

  lines.push(kv('Total Deposited', usd(pnl.totalDeposited)));
  lines.push(kv('Total Withdrawn', usd(pnl.totalWithdrawn)));
  lines.push(kv('Current Value', usd(pnl.currentValue)));

  const pnlStr = pnl.pnl >= 0 ? chalk.green.bold('+' + usd(pnl.pnl)) : chalk.red.bold(usd(pnl.pnl));
  lines.push(kvBold('PnL', pnlStr));

  if (pnl.totalDeposited > 0) {
    const returnPct = (pnl.pnl / pnl.totalDeposited * 100).toFixed(2);
    lines.push(kv('Return', pnl.pnl >= 0 ? chalk.green(returnPct + '%') : chalk.red(returnPct + '%')));
  }

  // Journal breakdown
  const journal = getEarnJournal();
  if (journal.length > 0) {
    lines.push(section('RECENT ACTIVITY'));
    const recent = journal.slice(-5).reverse();
    for (const entry of recent) {
      const date = new Date(entry.timestamp).toISOString().slice(0, 10);
      const icon = entry.action === 'deposit' ? chalk.green('+') : chalk.red('-');
      lines.push(`  ${icon} ${dim(date)} ${entry.action.padEnd(10)} ${entry.pool.padEnd(14)} ${usd(entry.amountUsd)}`);
    }
  } else {
    lines.push('');
    lines.push(`  ${dim('No earn activity recorded yet.')}`);
    lines.push(`  ${dim('Start earning: "earn deposit $100 crypto"')}`);
  }

  lines.push(divider());
  lines.push(flowHint('earn dashboard │ earn positions │ earn history'));
  return { success: true, error: lines.join('\n') };
}

// ─── 9. earn positions ──────────────────────────────────────────────────────

export async function handleEarnPositions(): Promise<TxResult> {
  const lines: string[] = [header('YOUR EARN POSITIONS')];

  lines.push(`  ${dim('Earn position tracking requires wallet token scan.')}`);
  lines.push(`  ${dim('FLP/sFLP tokens in your wallet represent earn positions:')}`);
  lines.push('');
  lines.push(`  ${chalk.green('FLP')}  = auto-compounding (fees grow token value)`);
  lines.push(`  ${chalk.cyan('sFLP')} = staked (USDC paid hourly)`);
  lines.push('');
  lines.push(`  ${dim('Use "wallet tokens" to see all token holdings.')}`);

  lines.push(divider());
  lines.push(flowHint('wallet tokens │ earn pnl │ earn dashboard'));
  return { success: true, error: lines.join('\n') };
}

// ─── 10. earn history ───────────────────────────────────────────────────────

export async function handleEarnHistory(poolAlias?: string): Promise<TxResult> {
  const pool = poolAlias ? resolveEarnPool(poolAlias) : undefined;
  const journal = getEarnJournal(pool?.poolId);

  const lines: string[] = [header(pool ? `${pool.displayName} — Earn History` : 'EARN HISTORY')];

  if (journal.length === 0) {
    lines.push(`  ${dim('No earn transactions recorded.')}`);
    lines.push(divider());
    lines.push(flowHint('earn deposit $100 crypto │ earn │ dashboard'));
    return { success: true, error: lines.join('\n') };
  }

  lines.push(tableHeader([
    { label: 'Date', width: 12 },
    { label: 'Action', width: 10 },
    { label: 'Pool', width: 14 },
    { label: 'Amount', width: 12 },
    { label: 'Tx', width: 16 },
  ]));

  for (const entry of journal.slice(-20).reverse()) {
    const date = new Date(entry.timestamp).toISOString().slice(0, 10);
    const action = entry.action === 'deposit' ? chalk.green('deposit') : chalk.red('withdraw');
    const tx = entry.txSignature ? entry.txSignature.slice(0, 12) + '...' : dim('—');
    lines.push(tableRow([date, action, entry.pool, usd(entry.amountUsd), tx], [12, 10, 14, 12, 16]));
  }

  lines.push(divider());
  lines.push(flowHint('earn pnl │ earn dashboard │ earn positions'));
  return { success: true, error: lines.join('\n') };
}

// ─── 11-16. Execution commands ──────────────────────────────────────────────

export function handleEarnExecution(action: string): TxResult {
  return {
    success: false,
    error: [
      '',
      `  ${chalk.yellow('Earn ' + action + ' requires on-chain transaction.')}`,
      '',
      `  ${dim('This operation uses the Flash SDK (isolated service).')}`,
      `  ${dim('Ensure wallet is connected in Live mode.')}`,
      '',
      `  ${dim('Alternative: use')} ${chalk.white('flash.trade')} ${dim('website.')}`,
      '',
    ].join('\n'),
  };
}

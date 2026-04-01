/**
 * Analytics Module
 *
 * Portfolio analytics computed from positions + audit log + state.
 * No additional API calls — purely computed from existing data.
 */

import chalk from 'chalk';
import {
  header, divider, kv, kvBold, section,
  usd, pnl, side, allocBar,
  tableHeader, tableRow, dim, warning,
} from './display.js';
import type { IStateEngine } from '../types/index.js';
import { getAuditLog } from '../security/audit-log.js';

// ─── PnL Report ─────────────────────────────────────────────────────────────

export async function renderPnl(state: IStateEngine): Promise<string> {
  const positions = await state.getPositions();
  const audit = getAuditLog();
  const trades = audit.readRecent(50);

  const lines: string[] = [];
  lines.push(header('PnL REPORT'));

  // Unrealized PnL (open positions)
  const unrealizedPnl = positions.reduce((s, p) => s + p.pnl, 0);
  const unrealizedPct = positions.reduce((s, p) => s + p.collateralUsd, 0);

  lines.push(section('UNREALIZED'));
  if (positions.length === 0) {
    lines.push(`  ${dim('No open positions')}`);
  } else {
    for (const p of positions) {
      const pctReturn = p.collateralUsd > 0 ? (p.pnl / p.collateralUsd * 100) : 0;
      lines.push(`  ${p.market.padEnd(8)} ${side(p.side).padEnd(8)} ${pnl(p.pnl).padEnd(14)} ${dim(pctReturn.toFixed(2) + '%')}`);
    }
    lines.push('');
    lines.push(kvBold('Total Unrealized', pnl(unrealizedPnl)));
    if (unrealizedPct > 0) {
      lines.push(kv('Return on Capital', `${(unrealizedPnl / unrealizedPct * 100).toFixed(2)}%`));
    }
  }

  // Realized PnL (from audit log)
  const confirmedTrades = trades.filter(t => t.status === 'confirmed');
  const closeTrades = confirmedTrades.filter(t => t.action === 'close_position');

  lines.push(section('SESSION HISTORY'));
  lines.push(kv('Trades Executed', String(confirmedTrades.length)));
  lines.push(kv('Positions Closed', String(closeTrades.length)));

  const totalFees = confirmedTrades.reduce((s, t) => s + (t.fees ?? 0), 0);
  lines.push(kv('Total Fees Paid', usd(totalFees)));

  lines.push(divider());
  lines.push('');
  return lines.join('\n');
}

// ─── Exposure Report ────────────────────────────────────────────────────────

export async function renderExposure(state: IStateEngine): Promise<string> {
  const positions = await state.getPositions();

  const lines: string[] = [];
  lines.push(header('EXPOSURE REPORT'));

  if (positions.length === 0) {
    lines.push(`  ${dim('No open positions')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Net exposure
  let longExposure = 0;
  let shortExposure = 0;
  const byMarket = new Map<string, { long: number; short: number }>();

  for (const p of positions) {
    if (p.side === 'LONG') {
      longExposure += p.sizeUsd;
    } else {
      shortExposure += p.sizeUsd;
    }
    const existing = byMarket.get(p.market) ?? { long: 0, short: 0 };
    if (p.side === 'LONG') existing.long += p.sizeUsd;
    else existing.short += p.sizeUsd;
    byMarket.set(p.market, existing);
  }

  const netExposure = longExposure - shortExposure;
  const totalExposure = longExposure + shortExposure;

  lines.push(section('SUMMARY'));
  lines.push(kv('Long Exposure', chalk.green(usd(longExposure))));
  lines.push(kv('Short Exposure', chalk.red(usd(shortExposure))));
  lines.push(kvBold('Net Exposure', netExposure >= 0 ? chalk.green(usd(netExposure)) : chalk.red(usd(netExposure))));
  lines.push(kv('Total Exposure', usd(totalExposure)));
  lines.push(kv('Direction', netExposure > 0 ? chalk.green('NET LONG') : netExposure < 0 ? chalk.red('NET SHORT') : dim('NEUTRAL')));

  // By market
  lines.push(section('BY MARKET'));
  for (const [market, exp] of byMarket) {
    const net = exp.long - exp.short;
    const bar = allocBar(Math.abs(net) / Math.max(totalExposure, 1) * 100, 15);
    lines.push(`  ${market.padEnd(8)} ${bar} ${net >= 0 ? chalk.green(usd(net)) : chalk.red(usd(net))}`);
  }

  // Leverage distribution
  lines.push(section('LEVERAGE'));
  for (const p of positions) {
    const bar = allocBar(p.leverage / 100 * 100, 15);
    lines.push(`  ${p.market.padEnd(8)} ${side(p.side).padEnd(8)} ${bar} ${p.leverage.toFixed(1)}x`);
  }

  lines.push(divider());
  lines.push('');
  return lines.join('\n');
}

// ─── Risk Report ────────────────────────────────────────────────────────────

export async function renderRisk(state: IStateEngine): Promise<string> {
  const positions = await state.getPositions();

  const lines: string[] = [];
  lines.push(header('RISK ASSESSMENT'));

  if (positions.length === 0) {
    lines.push(`  ${dim('No open positions — no risk')}`);
    lines.push('');
    return lines.join('\n');
  }

  // Per-position risk
  lines.push(section('POSITION RISK'));
  lines.push(tableHeader([
    { label: 'Market', width: 8 },
    { label: 'Side', width: 6 },
    { label: 'Lev', width: 6 },
    { label: 'Liq Dist', width: 10 },
    { label: 'Risk', width: 12 },
  ]));

  let highRiskCount = 0;

  for (const p of positions) {
    // Liquidation distance
    const liqDist = p.entryPrice > 0 && p.liquidationPrice > 0
      ? Math.abs(p.entryPrice - p.liquidationPrice) / p.entryPrice * 100
      : 0;

    let riskLevel: string;
    if (liqDist < 5) {
      riskLevel = chalk.red.bold('CRITICAL');
      highRiskCount++;
    } else if (liqDist < 15) {
      riskLevel = chalk.yellow('HIGH');
      highRiskCount++;
    } else if (liqDist < 30) {
      riskLevel = chalk.cyan('MODERATE');
    } else {
      riskLevel = chalk.green('LOW');
    }

    lines.push(tableRow([
      p.market,
      side(p.side),
      p.leverage.toFixed(1) + 'x',
      liqDist.toFixed(1) + '%',
      riskLevel,
    ], [8, 6, 6, 10, 12]));
  }

  // Overall risk
  lines.push(section('OVERALL'));
  const avgLeverage = positions.reduce((s, p) => s + p.leverage, 0) / positions.length;
  const maxLeverage = Math.max(...positions.map(p => p.leverage));
  const totalCollateral = positions.reduce((s, p) => s + p.collateralUsd, 0);
  const totalSize = positions.reduce((s, p) => s + p.sizeUsd, 0);

  lines.push(kv('Positions', String(positions.length)));
  lines.push(kv('Avg Leverage', avgLeverage.toFixed(1) + 'x'));
  lines.push(kv('Max Leverage', maxLeverage.toFixed(1) + 'x'));
  lines.push(kv('Total Collateral', usd(totalCollateral)));
  lines.push(kv('Total Size', usd(totalSize)));

  if (highRiskCount > 0) {
    lines.push('');
    lines.push(warning(`${highRiskCount} position(s) at elevated risk`));
  }

  lines.push(divider());
  lines.push('');
  return lines.join('\n');
}

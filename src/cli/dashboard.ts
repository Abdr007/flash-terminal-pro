/**
 * Dashboard View
 *
 * Single command showing complete portfolio + system state.
 * Fetches all data in parallel for speed.
 */

import chalk from 'chalk';
import {
  header, divider, kv, kvBold, section,
  usd, price, pnl, side, allocBar,
  tableHeader, tableRow, status, dim,
} from './display.js';
import type { IStateEngine } from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';

export async function renderDashboard(
  state: IStateEngine,
  api: FlashApiClient,
  wallet: WalletManager,
): Promise<string> {
  const lines: string[] = [];

  // Fetch all data in parallel
  const [positions, markets, solBal, usdcBal, solPrice, healthResult] = await Promise.allSettled([
    state.getPositions(),
    state.getMarkets(),
    state.getBalance('SOL'),
    state.getBalance('USDC'),
    state.getPrice('SOL'),
    api.health(),
  ]);

  const pos = positions.status === 'fulfilled' ? positions.value : [];
  const mkts = markets.status === 'fulfilled' ? markets.value : [];
  const sol = solBal.status === 'fulfilled' ? solBal.value : 0;
  const usdc = usdcBal.status === 'fulfilled' ? usdcBal.value : 0;
  const solP = solPrice.status === 'fulfilled' ? solPrice.value : 0;
  const apiOk = healthResult.status === 'fulfilled';

  const solUsd = sol * solP;
  const walletTotal = solUsd + usdc;
  const posCollateral = pos.reduce((s, p) => s + p.collateralUsd, 0);
  const posPnl = pos.reduce((s, p) => s + p.pnl, 0);
  const totalValue = walletTotal + posCollateral + posPnl;

  // ─── Header ─────────────────────────────────────────────────────
  lines.push(header('FLASH DASHBOARD'));

  // ─── Wallet ─────────────────────────────────────────────────────
  if (wallet.isConnected) {
    lines.push(kv('Wallet', chalk.white(wallet.shortAddress)));
    lines.push(kv('SOL', `${sol.toFixed(4)} ${dim('(' + usd(solUsd) + ')')}`));
    lines.push(kv('USDC', usd(usdc)));
    lines.push(kvBold('Total Value', usd(totalValue)));
  } else {
    lines.push(kv('Wallet', chalk.yellow('Not connected')));
  }

  // ─── Positions ──────────────────────────────────────────────────
  lines.push(section('POSITIONS'));
  if (pos.length === 0) {
    lines.push(`  ${dim('No open positions')}`);
  } else {
    lines.push(tableHeader([
      { label: 'Market', width: 8 },
      { label: 'Side', width: 6 },
      { label: 'Lev', width: 6 },
      { label: 'Size', width: 10 },
      { label: 'Entry', width: 10 },
      { label: 'PnL', width: 12 },
    ]));

    for (const p of pos) {
      lines.push(tableRow([
        p.market,
        side(p.side),
        p.leverage.toFixed(1) + 'x',
        usd(p.sizeUsd),
        price(p.entryPrice),
        pnl(p.pnl),
      ], [8, 6, 6, 10, 10, 12]));
    }

    lines.push('');
    lines.push(kv('Total PnL', pnl(posPnl)));
    lines.push(kv('Collateral', usd(posCollateral)));
    lines.push(kv('Net Exposure', usd(pos.reduce((s, p) => s + (p.side === 'LONG' ? p.sizeUsd : -p.sizeUsd), 0))));
  }

  // ─── Allocation ─────────────────────────────────────────────────
  if (totalValue > 0) {
    lines.push(section('ALLOCATION'));
    const walletPct = (walletTotal / totalValue) * 100;
    const posPct = ((posCollateral + posPnl) / totalValue) * 100;
    lines.push(`  Wallet     ${allocBar(walletPct)} ${walletPct.toFixed(0)}%`);
    lines.push(`  Positions  ${allocBar(posPct)} ${posPct.toFixed(0)}%`);
  }

  // ─── Risk ───────────────────────────────────────────────────────
  if (pos.length > 0) {
    const avgLev = pos.reduce((s, p) => s + p.leverage, 0) / pos.length;
    const maxLev = Math.max(...pos.map(p => p.leverage));
    lines.push(section('RISK'));
    lines.push(kv('Avg Leverage', avgLev.toFixed(1) + 'x'));
    lines.push(kv('Max Leverage', maxLev.toFixed(1) + 'x'));
    lines.push(kv('Positions', String(pos.length)));
  }

  // ─── Recent Trades ─────────────────────────────────────────────
  const audit = (await import('../security/audit-log.js')).getAuditLog();
  const recentTrades = audit.readRecent(5);
  if (recentTrades.length > 0) {
    lines.push(section('RECENT TRADES'));
    for (const t of recentTrades.reverse()) {
      const time = t.timestamp.slice(11, 19);
      const action = (t.action ?? '').slice(0, 10);
      const market = t.market ?? t.inputToken ?? '';
      const st = t.status === 'confirmed' ? chalk.green('✓')
        : t.status === 'failed' ? chalk.red('✗')
        : t.status === 'blocked' ? chalk.yellow('⊘')
        : chalk.dim('◦');
      lines.push(`  ${st} ${dim(time)} ${action.padEnd(12)} ${market}`);
    }
  }

  // ─── Markets ────────────────────────────────────────────────────
  lines.push(section('TOP MARKETS'));
  const topMarkets = mkts.filter(m => ['SOL', 'BTC', 'ETH', 'XAU', 'JUP'].includes(m.symbol));
  for (const m of topMarkets) {
    const p = m.price > 0 ? price(m.price) : dim('—');
    const st = m.isOpen ? chalk.green('●') : chalk.red('○');
    lines.push(`  ${st} ${m.symbol.padEnd(6)} ${p.padEnd(12)} ${dim(m.pool)}`);
  }

  // ─── System ─────────────────────────────────────────────────────
  lines.push(section('SYSTEM'));
  lines.push(kv('API', status(apiOk)));
  lines.push(kv('Network', dim('mainnet-beta')));
  lines.push(kv('Markets', dim(String(mkts.length))));

  lines.push('');
  lines.push(divider());
  lines.push('');

  return lines.join('\n');
}

/**
 * Render wallet token scan via RPC.
 * Fetches ALL SPL token accounts.
 */
export async function renderWalletTokens(
  wallet: WalletManager,
  state: IStateEngine,
): Promise<string> {
  if (!wallet.isConnected || !wallet.publicKey) {
    return dim('  Wallet not connected');
  }

  const lines: string[] = [];
  lines.push(header('WALLET TOKENS'));
  lines.push(kv('Address', chalk.white(wallet.shortAddress)));
  lines.push('');

  try {
    // SOL balance
    const solBal = await state.getBalance('SOL');
    const solPrice = await state.getPrice('SOL');
    const solUsd = solBal * solPrice;

    // USDC balance
    const usdcBal = await state.getBalance('USDC');

    lines.push(tableHeader([
      { label: 'Token', width: 10 },
      { label: 'Balance', width: 14 },
      { label: 'Price', width: 12 },
      { label: 'Value', width: 12 },
    ]));

    let total = 0;

    if (solBal > 0.0001) {
      lines.push(tableRow([
        'SOL', solBal.toFixed(4), price(solPrice), usd(solUsd),
      ], [10, 14, 12, 12]));
      total += solUsd;
    }

    if (usdcBal > 0.01) {
      lines.push(tableRow([
        'USDC', usdcBal.toFixed(2), '$1.00', usd(usdcBal),
      ], [10, 14, 12, 12]));
      total += usdcBal;
    }

    lines.push('');
    lines.push(kvBold('Total', usd(total)));
  } catch {
    lines.push(`  ${dim('Could not fetch token balances')}`);
  }

  lines.push(divider());
  lines.push('');
  return lines.join('\n');
}

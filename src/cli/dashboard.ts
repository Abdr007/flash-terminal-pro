/**
 * Dashboard — Futuristic Trading Screen
 *
 * Single view showing everything a trader needs.
 * Compact, hierarchical, data-dense.
 */

import chalk from 'chalk';
import {
  header, kv, kvBold, section,
  usd, price, pnl, side, allocBar,
  tableHeader, tableRow, dim,
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

  // ─── Header bar ─────────────────────────────────────────
  const mode = wallet.isConnected ? chalk.green('● LIVE') : chalk.yellow('● SIM');
  const addr = wallet.isConnected ? chalk.dim(wallet.shortAddress) : '';
  const apiStatus = apiOk ? chalk.green('●') : chalk.red('○');

  lines.push('');
  lines.push(`  ${chalk.cyan.bold('FX DASHBOARD')}  ${mode}  ${addr}  ${apiStatus} ${dim('API')}  ${dim(mkts.length + ' markets')}`);

  // ─── Portfolio (primary) ────────────────────────────────
  lines.push(section('PORTFOLIO'));
  lines.push(kvBold('Total Value', usd(totalValue)));
  lines.push(kv('Wallet', `${usd(walletTotal)} ${dim('(' + sol.toFixed(2) + ' SOL + ' + usd(usdc) + ' USDC)')}`));
  if (pos.length > 0) {
    lines.push(kv('In Positions', usd(posCollateral)));
    lines.push(kv('PnL', pnl(posPnl)));
  }

  // ─── Positions ──────────────────────────────────────────
  if (pos.length > 0) {
    lines.push(section(`POSITIONS (${pos.length})`));
    lines.push(tableHeader([
      { label: 'Market', width: 8 },
      { label: 'Side', width: 6 },
      { label: 'Lev', width: 5 },
      { label: 'Size', width: 9 },
      { label: 'Entry', width: 9 },
      { label: 'Liq', width: 9 },
      { label: 'PnL', width: 12 },
    ]));

    for (const p of pos) {
      lines.push(tableRow([
        chalk.white(p.market),
        side(p.side),
        dim(p.leverage.toFixed(1) + 'x'),
        usd(p.sizeUsd),
        price(p.entryPrice),
        price(p.liquidationPrice),
        pnl(p.pnl),
      ], [8, 6, 5, 9, 9, 9, 12]));
    }
  } else {
    lines.push(section('POSITIONS'));
    lines.push(`  ${dim('No open positions')}`);
  }

  // ─── Exposure ───────────────────────────────────────────
  if (totalValue > 0 && pos.length > 0) {
    const walletPct = (walletTotal / totalValue) * 100;
    const posPct = ((posCollateral + posPnl) / totalValue) * 100;
    lines.push(section('ALLOCATION'));
    lines.push(`  Wallet    ${allocBar(walletPct)} ${dim(walletPct.toFixed(0) + '%')}`);
    lines.push(`  Trading   ${allocBar(posPct)} ${dim(posPct.toFixed(0) + '%')}`);
  }

  // ─── Recent trades ─────────────────────────────────────
  const audit = (await import('../security/audit-log.js')).getAuditLog();
  const recent = audit.readRecent(3);
  if (recent.length > 0) {
    lines.push(section('RECENT'));
    for (const t of recent.reverse()) {
      const time = t.timestamp.slice(11, 19);
      const st = t.status === 'confirmed' ? chalk.green('●')
        : t.status === 'failed' ? chalk.red('●')
        : t.status === 'blocked' ? chalk.yellow('○')
        : chalk.dim('·');
      const action = (t.action ?? '').replace(/_/g, ' ').replace(/position/g, '').trim();
      lines.push(`  ${st} ${dim(time)} ${action.padEnd(10)} ${t.market ?? ''}`);
    }
  }

  // ─── Markets ────────────────────────────────────────────
  lines.push(section('MARKETS'));
  const topMarkets = mkts.filter(m => ['SOL', 'BTC', 'ETH', 'XAU', 'JUP'].includes(m.symbol));
  const marketLine = topMarkets.map(m => {
    const p = m.price > 0 ? price(m.price) : dim('—');
    return `${chalk.white(m.symbol)} ${p}`;
  }).join(chalk.dim('  │  '));
  lines.push(`  ${marketLine}`);

  lines.push('');
  return lines.join('\n');
}

// ─── Wallet Token Scan ──────────────────────────────────────────────────────

export async function renderWalletTokens(
  wallet: WalletManager,
  state: IStateEngine,
): Promise<string> {
  if (!wallet.isConnected || !wallet.publicKey) {
    return dim('  No wallet connected.');
  }

  const lines: string[] = [];
  lines.push(header('WALLET'));
  lines.push(kv('Address', chalk.dim(wallet.publicKey.toBase58())));
  lines.push('');

  try {
    const solBal = await state.getBalance('SOL');
    const solPrice = await state.getPrice('SOL');
    const usdcBal = await state.getBalance('USDC');
    let total = 0;

    lines.push(tableHeader([
      { label: 'Token', width: 8 },
      { label: 'Balance', width: 12 },
      { label: 'Price', width: 10 },
      { label: 'Value', width: 10 },
    ]));

    if (solBal > 0.0001) {
      const val = solBal * solPrice;
      lines.push(tableRow([chalk.white('SOL'), solBal.toFixed(4), price(solPrice), usd(val)], [8, 12, 10, 10]));
      total += val;
    }
    if (usdcBal > 0.01) {
      lines.push(tableRow([chalk.white('USDC'), usdcBal.toFixed(2), '$1.00', usd(usdcBal)], [8, 12, 10, 10]));
      total += usdcBal;
    }

    lines.push('');
    lines.push(kvBold('Total', usd(total)));
  } catch {
    lines.push(`  ${dim('Could not fetch balances')}`);
  }

  lines.push('');
  return lines.join('\n');
}

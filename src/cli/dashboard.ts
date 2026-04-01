/**
 * Dashboard — Matching flash-terminal layout
 */

import chalk from 'chalk';
import {
  titleBlock, kv, kvBold,
  usd, price, pnl, side, allocBar,
  tableHeader, tableSeparator, tableRow, dim,
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

  // ─── Header ─────────────────────────────────────────────
  lines.push(titleBlock('FLASH TERMINAL', 52));
  lines.push('');
  lines.push(kv('Wallet', wallet.isConnected ? chalk.white(wallet.shortAddress) : chalk.yellow('Not connected')));
  lines.push(kv('Network', dim('mainnet-beta')));
  lines.push(kv('API', apiOk ? chalk.green('Connected') : chalk.red('Unreachable')));
  lines.push(kv('Markets', dim(String(mkts.length))));

  // ─── Portfolio ──────────────────────────────────────────
  lines.push(titleBlock('PORTFOLIO', 52));
  lines.push('');
  lines.push(kvBold('Total Value', usd(totalValue)));
  lines.push(kv('SOL Balance', `${sol.toFixed(4)} SOL ${dim('(' + usd(solUsd) + ')')}`));
  lines.push(kv('USDC Balance', usd(usdc)));
  if (pos.length > 0) {
    lines.push(kv('In Positions', usd(posCollateral)));
    lines.push(kv('Total PnL', pnl(posPnl)));
  }

  // ─── Positions ──────────────────────────────────────────
  lines.push(titleBlock('POSITIONS', 52));
  lines.push('');

  if (pos.length === 0) {
    lines.push(`  ${dim('No open positions')}`);
  } else {
    const cols = [
      { label: 'Market', width: 10 },
      { label: 'Side', width: 6 },
      { label: 'Lev', width: 6 },
      { label: 'Size', width: 10 },
      { label: 'Entry', width: 10 },
      { label: 'Liq', width: 10 },
      { label: 'PnL', width: 12 },
    ];
    lines.push(tableHeader(cols));
    lines.push(tableSeparator(64));

    for (const p of pos) {
      lines.push(tableRow([
        p.market,
        side(p.side),
        p.leverage.toFixed(1) + 'x',
        usd(p.sizeUsd),
        price(p.entryPrice),
        price(p.liquidationPrice),
        pnl(p.pnl),
      ], [10, 6, 6, 10, 10, 10, 12]));
    }

    lines.push('');
    lines.push(`  ${dim('Total PnL:')} ${pnl(posPnl)}  ${dim('|  Exposure:')} ${usd(pos.reduce((s, p) => s + p.sizeUsd, 0))}  ${dim('|  Open:')} ${pos.length}`);
  }

  // ─── Allocation ─────────────────────────────────────────
  if (totalValue > 0) {
    lines.push(titleBlock('ALLOCATION', 52));
    lines.push('');
    const walletPct = (walletTotal / totalValue) * 100;
    const posPct = ((posCollateral + posPnl) / totalValue) * 100;
    lines.push(`  Wallet     ${allocBar(walletPct)} ${walletPct.toFixed(0)}%`);
    lines.push(`  Positions  ${allocBar(posPct)} ${posPct.toFixed(0)}%`);
  }

  // ─── Recent Trades ─────────────────────────────────────
  const audit = (await import('../security/audit-log.js')).getAuditLog();
  const recentTrades = audit.readRecent(5);
  if (recentTrades.length > 0) {
    lines.push(titleBlock('RECENT TRADES', 52));
    lines.push('');
    for (const t of recentTrades.reverse()) {
      const time = t.timestamp.slice(11, 19);
      const st = t.status === 'confirmed' ? chalk.green('✓')
        : t.status === 'failed' ? chalk.red('✗')
        : t.status === 'blocked' ? chalk.yellow('⊘')
        : dim('·');
      const action = (t.action ?? '').replace(/_/g, ' ').replace(/position/g, '').trim();
      lines.push(`  ${st} ${dim(time)} ${action.padEnd(12)} ${t.market ?? ''}`);
    }
  }

  // ─── Markets ────────────────────────────────────────────
  lines.push(titleBlock('TOP MARKETS', 52));
  lines.push('');
  const topMarkets = mkts.filter(m => ['SOL', 'BTC', 'ETH', 'XAU', 'JUP'].includes(m.symbol));
  for (const m of topMarkets) {
    const p = m.price > 0 ? price(m.price) : dim('—');
    const st = m.isOpen ? chalk.green('●') : chalk.red('○');
    lines.push(`  ${st} ${m.symbol.padEnd(6)} ${p.padEnd(12)} ${dim(m.pool)}`);
  }

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
  lines.push(titleBlock('WALLET TOKENS', 52));
  lines.push('');
  lines.push(kv('Address', dim(wallet.publicKey.toBase58())));
  lines.push('');

  try {
    const solBal = await state.getBalance('SOL');
    const solPrice = await state.getPrice('SOL');
    const usdcBal = await state.getBalance('USDC');
    let total = 0;

    const cols = [
      { label: 'Token', width: 8 },
      { label: 'Balance', width: 12 },
      { label: 'Price', width: 10 },
      { label: 'Value', width: 10 },
    ];
    lines.push(tableHeader(cols));
    lines.push(tableSeparator(40));

    if (solBal > 0.0001) {
      const val = solBal * solPrice;
      lines.push(tableRow(['SOL', solBal.toFixed(4), price(solPrice), usd(val)], [8, 12, 10, 10]));
      total += val;
    }
    if (usdcBal > 0.01) {
      lines.push(tableRow(['USDC', usdcBal.toFixed(2), '$1.00', usd(usdcBal)], [8, 12, 10, 10]));
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

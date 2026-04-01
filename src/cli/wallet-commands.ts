/**
 * Wallet Management Commands
 *
 * wallet, wallet list, wallet use, wallet import, wallet disconnect
 */

import chalk from 'chalk';
import { header, divider, kv, kvBold, dim, usd } from './display.js';
import type { WalletManager } from '../wallet/manager.js';
import { WalletStore } from '../wallet/store.js';
import type { IStateEngine } from '../types/index.js';
import type { TxResult } from '../types/index.js';

// ─── wallet (status) ────────────────────────────────────────────────────────

export async function handleWalletStatus(wallet: WalletManager, state: IStateEngine): Promise<TxResult> {
  const lines: string[] = [header('WALLET')];

  if (!wallet.isConnected) {
    lines.push(`  ${dim('No wallet connected.')}`);
    lines.push(`  ${dim('Select Live mode on startup to connect wallet.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  lines.push(kv('Address', chalk.white(wallet.publicKey?.toBase58() ?? '—')));
  lines.push(kv('Short', chalk.white(wallet.shortAddress)));
  lines.push(kv('Status', chalk.green('Connected')));

  try {
    const sol = await state.getBalance('SOL');
    const usdc = await state.getBalance('USDC');
    const solPrice = await state.getPrice('SOL');

    lines.push('');
    lines.push(kv('SOL', `${sol.toFixed(4)} ${dim('(' + usd(sol * solPrice) + ')')}`));
    lines.push(kv('USDC', usd(usdc)));
    lines.push(kvBold('Total', usd(sol * solPrice + usdc)));
  } catch {
    lines.push(`  ${dim('Could not fetch balances')}`);
  }

  lines.push(divider());
  lines.push(`\n  ${dim('Next:')} wallet tokens │ wallet list │ wallet disconnect\n`);
  return { success: true, error: lines.join('\n') };
}

// ─── wallet list ────────────────────────────────────────────────────────────

export function handleWalletList(): TxResult {
  const store = new WalletStore();
  const names = store.list();
  const defaultName = store.getDefault();

  const lines: string[] = [header('SAVED WALLETS')];

  if (names.length === 0) {
    lines.push(`  ${dim('No wallets saved.')}`);
    lines.push(`  ${dim('Import: set KEYPAIR_PATH in .env')}`);
  } else {
    for (const name of names) {
      const entry = store.get(name);
      const isDefault = name === defaultName;
      const addr = entry ? `${entry.address.slice(0, 4)}...${entry.address.slice(-4)}` : '';
      const marker = isDefault ? chalk.green(' (default)') : '';
      lines.push(`  ${isDefault ? chalk.green('●') : dim('○')} ${name.padEnd(14)} ${dim(addr)}${marker}`);
    }
  }

  lines.push(divider());
  lines.push(`\n  ${dim('Next:')} wallet use <name> │ wallet │ wallet tokens\n`);
  return { success: true, error: lines.join('\n') };
}

// ─── wallet use <name> ──────────────────────────────────────────────────────

export function handleWalletUse(name: string, wallet: WalletManager): TxResult {
  const store = new WalletStore();
  const entry = store.get(name);

  if (!entry) {
    return { success: false, error: `  Wallet "${name}" not found. Type "wallet list" to see saved wallets.` };
  }

  try {
    wallet.loadFromFile(entry.path);
    store.setDefault(name);
    return {
      success: true,
      error: `\n  ${chalk.green('✓')} Switched to wallet: ${chalk.white.bold(name)} (${wallet.shortAddress})\n`,
    };
  } catch (e) {
    return { success: false, error: `  Failed to load wallet: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── wallet disconnect ──────────────────────────────────────────────────────

export function handleWalletDisconnect(wallet: WalletManager): TxResult {
  if (!wallet.isConnected) {
    return { success: true, error: dim('  No wallet connected.') };
  }

  wallet.disconnect();
  return { success: true, error: `\n  ${dim('Wallet disconnected.')}\n` };
}

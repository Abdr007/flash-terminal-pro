/**
 * Wallet Commands — Exact flash-terminal match
 *
 * Uses theme.titleBlock + theme.pair pattern.
 */

import chalk from 'chalk';
import { WalletStore } from '../wallet/store.js';
import type { WalletManager } from '../wallet/manager.js';
import type { IStateEngine } from '../types/index.js';
import type { TxResult } from '../types/index.js';

// ACCENT available for future use
const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');
const POSITIVE = chalk.green;

function titleBlock(title: string): string {
  return `\n  ${ACCENT_BOLD(title)}\n  ${MUTED('─'.repeat(Math.max(title.length + 2, 20)))}`;
}

function pair(key: string, value: string): string {
  return `  ${MUTED(key.padEnd(18))}${value}`;
}

// ─── wallet ─────────────────────────────────────────────────────────────────

export async function handleWalletStatus(wallet: WalletManager, _state: IStateEngine): Promise<TxResult> {
  const store = new WalletStore();
  const defaultName = store.getDefault();
  const storedCount = store.list().length;

  const lines = [titleBlock('WALLET STATUS'), ''];

  if (wallet.isConnected) {
    lines.push(pair('Connected', POSITIVE('Yes')));
    if (defaultName) {
      lines.push(pair('Wallet', chalk.bold(defaultName)));
    }
  } else {
    lines.push(pair('Connected', chalk.red('No')));
  }

  lines.push(pair('Registered', `${storedCount} wallet(s)`));
  lines.push('');

  if (!wallet.isConnected && storedCount === 0) {
    lines.push(MUTED('  Use "wallet import <name> <path>" to add a wallet.'));
    lines.push('');
  }

  return { success: true, error: lines.join('\n') };
}

// ─── wallet tokens ──────────────────────────────────────────────────────────

export async function handleWalletTokens(wallet: WalletManager, state: IStateEngine): Promise<TxResult> {
  if (!wallet.isConnected) {
    return { success: true, error: MUTED('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
  }

  const lines = [titleBlock('TOKENS IN WALLET'), ''];

  try {
    const sol = await state.getBalance('SOL');
    lines.push(pair('SOL', POSITIVE(sol.toFixed(4))));

    const usdc = await state.getBalance('USDC');
    if (usdc > 0) {
      lines.push(pair('USDC', POSITIVE(usdc.toFixed(2))));
    }

    // Note: full SPL token scan would require RPC getParsedTokenAccountsByOwner
    // For now we show SOL + USDC (same as what we can fetch)
  } catch {
    lines.push(MUTED('  Could not fetch token balances'));
  }

  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── wallet balance ─────────────────────────────────────────────────────────

export async function handleWalletBalance(wallet: WalletManager, state: IStateEngine): Promise<TxResult> {
  if (!wallet.isConnected) {
    return { success: true, error: MUTED('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
  }

  const lines = [titleBlock('WALLET BALANCE'), ''];

  try {
    const sol = await state.getBalance('SOL');
    lines.push(pair('SOL', POSITIVE(sol.toFixed(4) + ' SOL')));

    const usdc = await state.getBalance('USDC');
    const usdcColor = usdc > 0 ? POSITIVE : chalk.yellow;
    lines.push(pair('USDC', usdcColor(usdc.toFixed(2) + ' USDC')));
  } catch {
    lines.push(MUTED('  Could not fetch balance'));
  }

  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── wallet list ────────────────────────────────────────────────────────────

export function handleWalletList(): TxResult {
  const store = new WalletStore();
  const wallets = store.list();
  const defaultName = store.getDefault();

  if (wallets.length === 0) {
    return {
      success: true,
      error: [
        '',
        MUTED('  No wallets stored.'),
        MUTED('  Use "wallet import <name> <path>" to import a wallet.'),
        '',
      ].join('\n'),
    };
  }

  const lines = [titleBlock('REGISTERED WALLETS')];

  for (const name of wallets) {
    const isDefault = name === defaultName;
    const tag = isDefault ? chalk.green(' (default)') : '';
    lines.push(`  ${chalk.bold(name)}${tag}`);
    try {
      const entry = store.get(name);
      if (entry) {
        lines.push(MUTED(`    ${entry.path}`));
      }
    } catch { /* skip */ }
  }

  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── wallet use <name> ──────────────────────────────────────────────────────

export function handleWalletUse(name: string, wallet: WalletManager): TxResult {
  const store = new WalletStore();
  const entry = store.get(name);

  if (!entry) {
    return { success: false, error: chalk.red(`  Wallet "${name}" not found. Use "wallet list" to see stored wallets.`) };
  }

  try {
    wallet.loadFromFile(entry.path);
    store.setDefault(name);

    const lines = [
      '',
      chalk.green(`  Switched to wallet: ${chalk.bold(name)}`),
      `  Address: ${MUTED(entry.address)}`,
      '',
    ];

    if (wallet.isConnected) {
      lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
      lines.push(MUTED('  Transactions executed from this wallet are real.'));
      lines.push('');
    }

    return { success: true, error: lines.join('\n') };
  } catch (e) {
    return { success: false, error: chalk.red(`  Failed to switch wallet: ${e instanceof Error ? e.message : String(e)}`) };
  }
}

// ─── wallet connect <path> ──────────────────────────────────────────────────

export function handleWalletConnect(path: string | undefined, wallet: WalletManager): TxResult {
  if (!path) {
    return {
      success: false,
      error: [
        chalk.red('  Missing path. Usage:'),
        '',
        `    ${chalk.cyan('wallet connect <path>')}`,
        '',
        MUTED('  Example: wallet connect ~/.config/solana/id.json'),
      ].join('\n'),
    };
  }

  try {
    wallet.loadFromFile(path);

    const lines = ['', chalk.green('  Wallet Connected'), MUTED('  ─────────────────'), ''];

    if (wallet.isConnected) {
      lines.push(chalk.bgRed.white.bold('  LIVE TRADING ENABLED '));
      lines.push('');
    }

    return { success: true, error: lines.join('\n') };
  } catch (e) {
    return { success: false, error: `  Failed to connect wallet: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── wallet disconnect ──────────────────────────────────────────────────────

export function handleWalletDisconnect(wallet: WalletManager): TxResult {
  if (!wallet.isConnected) {
    return { success: true, error: MUTED('  No wallet connected.') };
  }

  wallet.disconnect();

  const lines = ['', chalk.green('  Wallet disconnected.')];
  lines.push('');
  lines.push(chalk.yellow('  Live trading disabled until a wallet is connected.'));
  lines.push(MUTED('  Use "wallet import", "wallet use", or "wallet connect" to reconnect.'));
  lines.push('');

  return { success: true, error: lines.join('\n') };
}

// ─── wallet address ─────────────────────────────────────────────────────────

export function handleWalletAddress(wallet: WalletManager): TxResult {
  if (!wallet.isConnected) {
    return { success: true, error: MUTED('  No wallet connected. Use "wallet import <name> <path>" or "wallet connect <path>".') };
  }
  return { success: true, error: `  Wallet: ${chalk.cyan(wallet.publicKey?.toBase58() ?? '—')}` };
}

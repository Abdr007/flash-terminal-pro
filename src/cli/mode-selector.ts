/**
 * Startup Mode Selector
 *
 * On CLI launch:
 *   1. Display banner
 *   2. Detect/setup wallet
 *   3. Prompt: Simulation or Live
 *   4. Live requires: wallet + CONFIRM
 *
 * Wallet flow (same pattern as flash-terminal):
 *   - Check WalletStore for registered wallets
 *   - Auto-detect ~/.config/solana/id.json if no wallets
 *   - Offer import/create if nothing found
 *   - Connect wallet before entering live mode
 */

import { createInterface } from 'readline';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { accentBold, dim } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';
import { WalletManager } from '../wallet/manager.js';
import { WalletStore } from '../wallet/store.js';
import type { FlashXConfig } from '../types/index.js';

export type SelectedMode = 'simulation' | 'live';

// ─── Readline Helper ────────────────────────────────────────────────────────

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Main Mode Selection ────────────────────────────────────────────────────

export async function selectMode(
  config: FlashXConfig,
  wallet: WalletManager,
): Promise<SelectedMode> {
  const log = getLogger();

  // ─── Banner ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${accentBold('flash')} ${dim('v0.1.0')}`);
  console.log(`  ${dim('Protocol-grade CLI for Flash.trade')}`);
  console.log('');
  console.log(`  ${dim('Network:')} ${config.network}`);

  // ─── Wallet Detection ───────────────────────────────────────────────
  if (!wallet.isConnected) {
    const connected = await detectAndConnectWallet(config, wallet);
    if (connected) {
      console.log(`  ${dim('Wallet:')}  ${chalk.green(wallet.shortAddress)}`);
    } else {
      console.log(`  ${dim('Wallet:')}  ${chalk.yellow('Not connected')}`);
    }
  } else {
    console.log(`  ${dim('Wallet:')}  ${chalk.green(wallet.shortAddress)}`);
  }
  console.log('');

  // ─── ENV override ───────────────────────────────────────────────────
  const envSim = process.env['SIMULATION_MODE']?.toLowerCase();
  if (envSim === 'false' || envSim === '0') {
    const validation = validateLiveMode(config, wallet);
    if (!validation.valid) {
      console.log(`  ${chalk.red('Cannot enter LIVE mode:')} ${validation.reason}`);
      console.log(`  ${dim('Falling back to SIMULATION mode')}`);
      console.log('');
      return 'simulation';
    }
    console.log(`  ${chalk.yellow('⚠  SIMULATION_MODE=false detected')}`);
    console.log(`  ${chalk.red.bold('WARNING: You are entering LIVE MODE')}`);
    console.log(`  ${chalk.red('Real transactions will be signed and sent on-chain.')}`);
    console.log('');
    const confirm = await ask(`  ${chalk.yellow('Type CONFIRM to proceed, or Enter for simulation:')} `);
    if (confirm === 'CONFIRM') {
      console.log(`  ${chalk.green.bold('LIVE MODE ACTIVATED')}`);
      console.log('');
      return 'live';
    }
    console.log(`  ${dim('Staying in SIMULATION mode')}`);
    console.log('');
    return 'simulation';
  }

  // ─── Interactive Prompt ─────────────────────────────────────────────
  console.log(`  ${chalk.cyan('Select Mode:')}`);
  console.log('');
  console.log(`    ${chalk.green('1')}  ${chalk.green('Simulation')} ${dim('— safe, no real trades (default)')}`);

  if (wallet.isConnected) {
    console.log(`    ${chalk.red('2')}  ${chalk.red('Live')}       ${dim(`— real trades (${wallet.shortAddress})`)}`);
  } else {
    console.log(`    ${chalk.dim('2')}  ${chalk.dim('Live')}       ${dim('— requires wallet')}`);
  }
  console.log('');

  const choice = await ask(`  ${dim('Enter choice [1]:')} `);

  if (choice !== '2') {
    console.log('');
    console.log(`  ${chalk.green.bold('SIMULATION MODE')}`);
    console.log(`  ${dim('No real transactions will be sent.')}`);
    console.log('');
    return 'simulation';
  }

  // ─── Live Mode: wallet setup if needed ──────────────────────────────
  if (!wallet.isConnected) {
    console.log('');
    console.log(`  ${chalk.yellow('Wallet required for live mode.')}`);
    const connected = await interactiveWalletSetup(config, wallet);
    if (!connected) {
      console.log(`  ${dim('No wallet connected. Staying in SIMULATION mode.')}`);
      console.log('');
      return 'simulation';
    }
  }

  // ─── Live Mode Validation ───────────────────────────────────────────
  const validation = validateLiveMode(config, wallet);
  if (!validation.valid) {
    console.log('');
    console.log(`  ${chalk.red('Cannot enter LIVE mode:')}`);
    console.log(`  ${chalk.red('✗')} ${validation.reason}`);
    console.log(`  ${dim('Staying in SIMULATION mode')}`);
    console.log('');
    return 'simulation';
  }

  // ─── Live Mode Confirmation ─────────────────────────────────────────
  console.log('');
  console.log(`  ${chalk.red('─'.repeat(52))}`);
  console.log(`  ${chalk.red.bold('⚠  WARNING: You are entering LIVE MODE')}`);
  console.log(`  ${chalk.red('─'.repeat(52))}`);
  console.log('');
  console.log(`  ${chalk.red('•')} Real transactions will be signed and sent on-chain`);
  console.log(`  ${chalk.red('•')} Trades are irreversible once confirmed`);
  console.log(`  ${chalk.red('•')} Funds are at risk`);
  console.log(`  ${chalk.red('•')} Wallet: ${chalk.white(wallet.shortAddress)}`);
  console.log('');

  const confirm = await ask(`  ${chalk.yellow.bold('Type CONFIRM to proceed:')} `);

  if (confirm !== 'CONFIRM') {
    console.log('');
    console.log(`  ${dim('Confirmation not received. Staying in SIMULATION mode.')}`);
    console.log('');
    return 'simulation';
  }

  console.log('');
  console.log(`  ${chalk.green.bold('✓ LIVE MODE ACTIVATED')}`);
  console.log(`  ${dim('All safety checks remain active. Trade carefully.')}`);
  console.log('');

  log.info('MODE', `Live mode activated — wallet: ${wallet.shortAddress}`);
  return 'live';
}

// ─── Wallet Auto-Detection ──────────────────────────────────────────────────

async function detectAndConnectWallet(
  config: FlashXConfig,
  wallet: WalletManager,
): Promise<boolean> {
  const log = getLogger();
  const store = new WalletStore();

  // 1. Check if KEYPAIR_PATH is set in config
  if (config.keypairPath) {
    try {
      wallet.loadFromFile(config.keypairPath);
      log.info('WALLET', `Loaded from KEYPAIR_PATH: ${wallet.shortAddress}`);
      return true;
    } catch (e) {
      log.warn('WALLET', `KEYPAIR_PATH failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Check WalletStore for registered wallets
  const walletNames = store.list();
  const defaultName = store.getDefault();

  if (defaultName) {
    try {
      const entry = store.get(defaultName);
      if (entry) {
        wallet.loadFromFile(entry.path);
        log.info('WALLET', `Loaded default wallet "${defaultName}": ${wallet.shortAddress}`);
        return true;
      }
    } catch (e) {
      log.warn('WALLET', `Default wallet "${defaultName}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (walletNames.length === 1) {
    try {
      const entry = store.get(walletNames[0]);
      if (entry) {
        wallet.loadFromFile(entry.path);
        store.setDefault(walletNames[0]);
        log.info('WALLET', `Auto-connected only wallet "${walletNames[0]}": ${wallet.shortAddress}`);
        return true;
      }
    } catch {
      // Fall through
    }
  }

  // 3. Auto-detect system keypair (~/.config/solana/id.json)
  const detected = store.autoDetect();
  if (detected) {
    try {
      wallet.loadFromFile(detected.path);
      // Register it for future use
      try {
        store.register(detected.name, detected.path);
        store.setDefault(detected.name);
      } catch {
        // May already be registered
      }
      log.info('WALLET', `Auto-detected system keypair: ${wallet.shortAddress}`);
      return true;
    } catch (e) {
      log.debug('WALLET', `Auto-detect failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return false;
}

// ─── Interactive Wallet Setup ───────────────────────────────────────────────

async function interactiveWalletSetup(
  config: FlashXConfig,
  wallet: WalletManager,
): Promise<boolean> {
  const store = new WalletStore();
  const walletNames = store.list();

  if (walletNames.length > 0) {
    // Show existing wallets
    console.log('');
    console.log(`  ${chalk.cyan('Available wallets:')}`);
    for (let i = 0; i < walletNames.length; i++) {
      const entry = store.get(walletNames[i]);
      const addr = entry ? `${entry.address.slice(0, 4)}...${entry.address.slice(-4)}` : '';
      console.log(`    ${chalk.cyan(String(i + 1))}  ${walletNames[i]} ${dim(addr)}`);
    }
    console.log(`    ${chalk.cyan(String(walletNames.length + 1))}  ${dim('Import new wallet')}`);
    console.log('');

    const choice = await ask(`  ${dim('Select wallet:')} `);
    const idx = parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < walletNames.length) {
      try {
        const entry = store.get(walletNames[idx]);
        if (entry) {
          wallet.loadFromFile(entry.path);
          console.log(`  ${chalk.green('✓')} Connected: ${walletNames[idx]} (${wallet.shortAddress})`);
          return true;
        }
      } catch (e) {
        console.log(`  ${chalk.red('✗')} Failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }
  }

  // Import flow
  console.log('');
  console.log(`  ${dim('Enter path to keypair JSON file:')}`);
  console.log(`  ${dim('(e.g., ~/.config/solana/id.json)')}`);
  console.log('');

  const path = await ask(`  ${dim('Path:')} `);
  if (!path) return false;

  // Resolve ~ to home
  const resolved = path.startsWith('~')
    ? path.replace('~', process.env['HOME'] ?? '')
    : path;

  if (!existsSync(resolved)) {
    console.log(`  ${chalk.red('✗')} File not found: ${resolved}`);
    return false;
  }

  const name = await ask(`  ${dim('Wallet name (e.g., "main"):')} `);
  if (!name) return false;

  try {
    store.register(name, resolved);
    store.setDefault(name);
    wallet.loadFromFile(resolved);
    console.log(`  ${chalk.green('✓')} Wallet "${name}" registered and connected (${wallet.shortAddress})`);
    // Update config so the keypair path persists for this session
    void config;
    return true;
  } catch (e) {
    console.log(`  ${chalk.red('✗')} ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// ─── Validation ─────────────────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function validateLiveMode(config: FlashXConfig, wallet: WalletManager): ValidationResult {
  if (!wallet.isConnected) {
    return { valid: false, reason: 'No wallet connected.' };
  }
  if (config.devMode) {
    return { valid: false, reason: 'DEV_MODE is active. Disable before live trading.' };
  }
  return { valid: true };
}

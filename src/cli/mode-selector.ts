/**
 * Startup Mode Selector
 *
 * On CLI launch, prompts the user to choose between:
 *   1. SIMULATION MODE (safe, default)
 *   2. LIVE MODE (real trading)
 *
 * Live mode requires:
 *   - Wallet loaded and connected
 *   - DEV_MODE off
 *   - Explicit "CONFIRM" typed by user
 *
 * Returns the selected mode. Never defaults to live.
 */

import { createInterface } from 'readline';
import chalk from 'chalk';
import { accentBold, dim } from '../utils/format.js';
import type { WalletManager } from '../wallet/manager.js';
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

// ─── Mode Selection ─────────────────────────────────────────────────────────

export async function selectMode(
  config: FlashXConfig,
  wallet: WalletManager,
): Promise<SelectedMode> {

  // ─── Banner ─────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${accentBold('flash')} ${dim('v0.1.0')}`);
  console.log(`  ${dim('Protocol-grade CLI for Flash.trade')}`);
  console.log('');
  console.log(`  ${dim('Network:')} ${config.network}`);
  if (wallet.isConnected) {
    console.log(`  ${dim('Wallet:')}  ${chalk.green(wallet.shortAddress)}`);
  } else {
    console.log(`  ${dim('Wallet:')}  ${chalk.yellow('Not connected')}`);
  }
  console.log('');

  // ─── ENV Override: if SIMULATION_MODE is explicitly set, skip prompt ─
  const envSim = process.env['SIMULATION_MODE']?.toLowerCase();
  if (envSim === 'false' || envSim === '0') {
    // Env says live — still validate
    const validation = validateLiveMode(config, wallet);
    if (!validation.valid) {
      console.log(`  ${chalk.red('Cannot enter LIVE mode:')} ${validation.reason}`);
      console.log(`  ${dim('Falling back to SIMULATION mode')}`);
      console.log('');
      return 'simulation';
    }
    // Env override — require CONFIRM
    console.log(`  ${chalk.yellow('⚠  SIMULATION_MODE=false detected')}`);
    console.log(`  ${chalk.red.bold('WARNING: You are entering LIVE MODE')}`);
    console.log(`  ${chalk.red('Real transactions will be signed and sent on-chain.')}`);
    console.log(`  ${chalk.red('Funds are at risk. This is irreversible.')}`);
    console.log('');

    const confirm = await ask(`  ${chalk.yellow('Type CONFIRM to proceed, or press Enter for simulation:')} `);
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
  console.log(`    ${chalk.red('2')}  ${chalk.red('Live')}       ${dim('— real trades, requires wallet')}`);
  console.log('');

  const choice = await ask(`  ${dim('Enter choice [1]:')} `);

  // ─── SIMULATION (default) ───────────────────────────────────────────
  if (choice !== '2') {
    console.log('');
    console.log(`  ${chalk.green.bold('SIMULATION MODE')}`);
    console.log(`  ${dim('No real transactions will be sent.')}`);
    console.log('');
    return 'simulation';
  }

  // ─── LIVE MODE VALIDATION ───────────────────────────────────────────
  const validation = validateLiveMode(config, wallet);

  if (!validation.valid) {
    console.log('');
    console.log(`  ${chalk.red('Cannot enter LIVE mode:')}`);
    console.log(`  ${chalk.red('✗')} ${validation.reason}`);
    console.log(`  ${dim('Staying in SIMULATION mode')}`);
    console.log('');
    return 'simulation';
  }

  // ─── LIVE MODE CONFIRMATION ─────────────────────────────────────────
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

  return 'live';
}

// ─── Live Mode Validation ───────────────────────────────────────────────────

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

function validateLiveMode(config: FlashXConfig, wallet: WalletManager): ValidationResult {
  // Check 1: Wallet must be loaded
  if (!wallet.isConnected) {
    return {
      valid: false,
      reason: 'No wallet connected. Set KEYPAIR_PATH in your .env file.',
    };
  }

  // Check 2: DEV_MODE must be off
  if (config.devMode) {
    return {
      valid: false,
      reason: 'DEV_MODE is active. Disable DEV_MODE before entering live mode.',
    };
  }

  return { valid: true };
}

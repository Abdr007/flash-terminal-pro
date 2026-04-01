/**
 * Startup Mode Selector — Matching flash-terminal exactly
 */

import { createInterface } from 'readline';
import { existsSync } from 'fs';
import chalk from 'chalk';
import { getLogger } from '../utils/logger.js';
import { WalletManager } from '../wallet/manager.js';
import { WalletStore } from '../wallet/store.js';
import type { FlashXConfig } from '../types/index.js';

export type SelectedMode = 'simulation' | 'live';

const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');
const CMD = chalk.hex('#00FF88');

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
  });
}

export async function selectMode(
  config: FlashXConfig,
  wallet: WalletManager,
): Promise<SelectedMode> {
  void getLogger();

  // ─── Wallet auto-detection ──────────────────────────────────────
  if (!wallet.isConnected) {
    await detectAndConnectWallet(config, wallet);
  }

  // ─── ENV override ───────────────────────────────────────────────
  const envSim = process.env['SIMULATION_MODE']?.toLowerCase();
  if (envSim === 'false' || envSim === '0') {
    const validation = validateLiveMode(config, wallet);
    if (!validation.valid) {
      console.log(`\n  ${chalk.red(validation.reason)}`);
      console.log(`  ${MUTED('Falling back to SIMULATION mode')}\n`);
      return 'simulation';
    }
    console.log(`\n  ${chalk.yellow('⚠  SIMULATION_MODE=false detected')}`);
    console.log(`  ${chalk.red.bold('WARNING: You are entering LIVE MODE')}`);
    console.log(`  ${chalk.red('Real transactions will be signed and sent on-chain.')}\n`);
    const confirm = await ask(`  ${chalk.yellow('Type CONFIRM to proceed, or Enter for simulation:')} `);
    if (confirm === 'CONFIRM') {
      console.log(`  ${chalk.green.bold('LIVE MODE ACTIVATED')}\n`);
      return 'live';
    }
    console.log(`  ${MUTED('Staying in SIMULATION mode')}\n`);
    return 'simulation';
  }

  // ─── Banner (matching flash-terminal) ───────────────────────────
  console.log('');
  console.log(`  ${ACCENT_BOLD('FLASH TERMINAL PRO')}`);
  console.log(`  ${MUTED('─'.repeat(32))}`);
  console.log('');
  console.log(MUTED('  Trading Interface for Flash Trade'));
  console.log('');
  console.log(MUTED('  Real-time market intelligence and trading tools'));
  console.log(MUTED('  powered by live blockchain data.'));
  console.log('');

  // ─── Mode Selection ─────────────────────────────────────────────
  console.log(chalk.bold('  Select Mode'));
  console.log('');
  console.log(`    ${CMD('1)')} ${chalk.bold('LIVE TRADING')}`);
  console.log(MUTED('       Execute real transactions on Flash Trade.'));
  console.log('');
  console.log(`    ${CMD('2)')} ${chalk.bold('SIMULATION')}`);
  console.log(MUTED('       Test strategies using paper trading.'));
  console.log('');
  console.log(`    ${CMD('3)')} ${MUTED('Exit')}`);
  console.log('');

  while (true) {
    const choice = await ask(`  ${chalk.yellow('>')} `);

    switch (choice) {
      case '1': {
        // Live mode — always show wallet picker (matching flash-terminal)
        const connected = await interactiveWalletSetup(config, wallet);
        if (!connected) {
          console.log(MUTED('  No wallet connected. Falling back to simulation.'));
          return showSimBanner(config);
        }
        const validation = validateLiveMode(config, wallet);
        if (!validation.valid) {
          console.log(`\n  ${chalk.red(validation.reason)}`);
          console.log(MUTED('  Staying in SIMULATION mode'));
          return showSimBanner(config);
        }
        // Show live banner
        return showLiveBanner(config, wallet);
      }
      case '2':
        return showSimBanner(config);
      case '3':
        process.exit(0);
      default:
        console.log(MUTED('  Enter 1, 2, or 3.'));
        continue;
    }
  }
}

// ─── Live Banner (matching flash-terminal) ──────────────────────────────────

async function showLiveBanner(config: FlashXConfig, wallet: WalletManager, walletName?: string): Promise<SelectedMode> {
  const store = new WalletStore();
  const displayName = walletName ?? store.getDefault() ?? wallet.shortAddress;

  console.log('');
  console.log(`  ${ACCENT_BOLD('FLASH TERMINAL PRO')}`);
  console.log(`  ${MUTED('─'.repeat(32))}`);
  console.log('');
  console.log(`  ${chalk.bgRed.white.bold(' LIVE TRADING ')}`);
  console.log('');
  console.log(`  ${MUTED('Wallet'.padEnd(18))}${CMD(displayName)}`);
  if (wallet.publicKey) {
    console.log(`  ${MUTED('Address'.padEnd(18))}${MUTED(wallet.publicKey.toBase58())}`);
  }
  console.log(`  ${MUTED('Network'.padEnd(18))}${chalk.white(config.network)}`);
  console.log('');

  // Balances
  try {
    const { Connection, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const conn = new Connection(config.rpcUrl, 'confirmed');
    if (wallet.publicKey) {
      const lamports = await conn.getBalance(wallet.publicKey);
      const solBal = lamports / LAMPORTS_PER_SOL;
      console.log(`  ${MUTED('SOL Balance'.padEnd(18))}${chalk.green(solBal.toFixed(4) + ' SOL')}`);

      // USDC
      try {
        const usdcBal = await wallet.getTokenBalance('USDC');
        const usdcColor = usdcBal > 0 ? chalk.green : chalk.yellow;
        console.log(`  ${MUTED('USDC Balance'.padEnd(18))}${usdcColor(usdcBal.toFixed(2) + ' USDC')}`);
      } catch { /* ok */ }

      // FAF
      try {
        const { getFafStakeInfo, getVoltageInfo } = await import('../faf/faf-data.js');
        const { formatFaf } = await import('../faf/faf-registry.js');

        if (wallet.keypair) {
          const { SdkService } = await import('../services/sdk-service.js');
          const sdk = new SdkService(config);
          sdk.init(wallet.keypair);
          if (sdk.isReady && sdk.perpClient) {
            const pc = sdk.getPoolConfig('Crypto.1');
            if (pc) {
              const stakeInfo = await Promise.race([
                getFafStakeInfo(sdk.perpClient, pc, wallet.publicKey),
                new Promise<null>(r => setTimeout(() => r(null), 3000)),
              ]);
              if (stakeInfo && stakeInfo.stakedAmount > 0) {
                console.log('');
                console.log(`  ${MUTED('FAF Staked'.padEnd(18))}${CMD(formatFaf(stakeInfo.stakedAmount))}`);
                console.log(`  ${MUTED('VIP Tier'.padEnd(18))}Level ${stakeInfo.level} (${stakeInfo.tier.feeDiscount}% fee discount)`);
                if (stakeInfo.pendingRevenue > 0) {
                  console.log(`  ${MUTED('Pending USDC'.padEnd(18))}${chalk.green('$' + stakeInfo.pendingRevenue.toFixed(2))}`);
                }

                const voltageInfo = await Promise.race([
                  getVoltageInfo(sdk.perpClient, pc, wallet.publicKey),
                  new Promise<null>(r => setTimeout(() => r(null), 2000)),
                ]);
                if (voltageInfo) {
                  console.log(`  ${MUTED('Voltage Tier'.padEnd(18))}${voltageInfo.tierName} (${voltageInfo.multiplier}x)`);
                }
              }
            }
          }
        }
      } catch { /* FAF non-critical */ }
    }
  } catch { /* balance non-critical */ }

  console.log('');
  console.log(chalk.yellow('  WARNING'));
  console.log(MUTED('  Transactions executed here are real.'));
  console.log('');

  // Quick Start
  console.log(chalk.bold('  Quick Start'));
  console.log(`    ${CMD('help')}           List all commands`);
  console.log(`    ${CMD('dashboard')}      Protocol & portfolio overview`);
  console.log(`    ${CMD('monitor')}        Live market monitoring`);
  console.log(`    ${CMD('wallet tokens')}  View token balances`);
  console.log(`    ${CMD('markets')}        View available markets`);
  console.log('');
  console.log(MUTED('  Type "exit" to close the terminal.'));
  console.log('');

  getLogger().info('MODE', `Live mode activated — wallet: ${wallet.shortAddress}`);
  return 'live';
}

// ─── Simulation Banner ──────────────────────────────────────────────────────

function showSimBanner(_config: FlashXConfig): SelectedMode {
  console.log('');
  console.log(`  ${ACCENT_BOLD('FLASH TERMINAL PRO')}`);
  console.log(`  ${MUTED('─'.repeat(32))}`);
  console.log('');
  console.log(`  ${chalk.bgYellow.black.bold(' SIMULATION ')}`);
  console.log('');
  console.log(MUTED('  Trades are simulated. No real transactions.'));
  console.log('');
  console.log(chalk.bold('  Quick Start'));
  console.log(`    ${CMD('help')}           List all commands`);
  console.log(`    ${CMD('dashboard')}      Protocol & portfolio overview`);
  console.log(`    ${CMD('markets')}        View available markets`);
  console.log('');
  console.log(MUTED('  Type "exit" to close the terminal.'));
  console.log('');

  return 'simulation';
}

// ─── Wallet Detection ───────────────────────────────────────────────────────

async function detectAndConnectWallet(config: FlashXConfig, wallet: WalletManager): Promise<boolean> {
  const log = getLogger();
  const store = new WalletStore();

  if (config.keypairPath) {
    try { wallet.loadFromFile(config.keypairPath); return true; } catch { /* ok */ }
  }

  const defaultName = store.getDefault();
  if (defaultName) {
    try {
      const entry = store.get(defaultName);
      if (entry) { wallet.loadFromFile(entry.path); log.info('WALLET', `Loaded "${defaultName}"`); return true; }
    } catch { /* ok */ }
  }

  const names = store.list();
  if (names.length === 1) {
    try {
      const entry = store.get(names[0]);
      if (entry) { wallet.loadFromFile(entry.path); store.setDefault(names[0]); return true; }
    } catch { /* ok */ }
  }

  const detected = store.autoDetect();
  if (detected) {
    try {
      wallet.loadFromFile(detected.path);
      try { store.register(detected.name, detected.path); store.setDefault(detected.name); } catch { /* ok */ }
      return true;
    } catch { /* ok */ }
  }

  return false;
}

async function interactiveWalletSetup(config: FlashXConfig, wallet: WalletManager): Promise<boolean> {
  const store = new WalletStore();
  const names = store.list();
  const defaultName = store.getDefault();

  // If wallet already connected (auto-detected), offer to keep it
  if (wallet.isConnected && defaultName) {
    console.log('');
    console.log(chalk.bold('  Saved Wallets'));
    console.log(MUTED('  ────────────'));
    console.log('');
    console.log(`    ${CMD('1)')} Use previous wallet ${MUTED(`(${defaultName})`)}`);
    console.log(`    ${CMD('2)')} Select another saved wallet`);
    console.log(`    ${CMD('3)')} Import new wallet`);
    console.log(`    ${CMD('4)')} Create new wallet`);
    console.log('');

    const choice = await ask(`  ${chalk.yellow('>')} `);

    if (choice === '1') {
      console.log(chalk.green(`\n  Wallet connected: ${defaultName}`));
      return true;
    }
    if (choice === '2' && names.length > 1) {
      return showWalletPicker(names, defaultName, store, wallet);
    }
    if (choice === '3' || choice === '2') {
      return importWalletFlow(config, store, wallet);
    }
    // choice 4 or default — fall through to import
    return importWalletFlow(config, store, wallet);
  }

  // No wallet connected — show picker if wallets exist
  if (names.length > 0) {
    console.log('');
    console.log(chalk.bold('  Saved Wallets'));
    console.log(MUTED('  ────────────'));
    console.log('');
    for (let i = 0; i < names.length; i++) {
      const entry = store.get(names[i]);
      const addr = entry ? `${entry.address.slice(0, 4)}...${entry.address.slice(-4)}` : '';
      console.log(`    ${CMD(String(i + 1) + ')')} Use ${names[i]} ${MUTED(`(${addr})`)}`);
    }
    console.log(`    ${CMD(String(names.length + 1) + ')')} Import new wallet`);
    console.log('');

    const choice = await ask(`  ${chalk.yellow('>')} `);
    const idx = parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < names.length) {
      try {
        const entry = store.get(names[idx]);
        if (entry) {
          wallet.loadFromFile(entry.path);
          store.setDefault(names[idx]);
          console.log(chalk.green(`\n  Wallet connected: ${names[idx]}`));
          return true;
        }
      } catch { return false; }
    }
  }

  return importWalletFlow(config, store, wallet);
}

async function showWalletPicker(names: string[], defaultName: string, store: WalletStore, wallet: WalletManager): Promise<boolean> {
  console.log('');
  for (let i = 0; i < names.length; i++) {
    const entry = store.get(names[i]);
    const addr = entry ? `${entry.address.slice(0, 4)}...${entry.address.slice(-4)}` : '';
    const tag = names[i] === defaultName ? MUTED(' (current)') : '';
    console.log(`    ${CMD(String(i + 1) + ')')} ${names[i]} ${MUTED(`(${addr})`)}${tag}`);
  }
  console.log('');
  const choice = await ask(`  ${chalk.yellow('>')} `);
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < names.length) {
    try {
      const entry = store.get(names[idx]);
      if (entry) {
        wallet.loadFromFile(entry.path);
        store.setDefault(names[idx]);
        console.log(chalk.green(`\n  Wallet connected: ${names[idx]}`));
        return true;
      }
    } catch { /* fall through */ }
  }
  return false;
}

async function importWalletFlow(config: FlashXConfig, store: WalletStore, wallet: WalletManager): Promise<boolean> {
  console.log(MUTED('\n  Enter path to keypair JSON file:'));
  const path = await ask(`  ${MUTED('Path:')} `);
  if (!path) return false;
  const resolved = path.startsWith('~') ? path.replace('~', process.env['HOME'] ?? '') : path;
  if (!existsSync(resolved)) { console.log(chalk.red(`  File not found: ${resolved}`)); return false; }
  const name = await ask(`  ${MUTED('Wallet name:')} `);
  if (!name) return false;
  try {
    store.register(name, resolved);
    store.setDefault(name);
    wallet.loadFromFile(resolved);
    console.log(chalk.green(`  Wallet "${name}" connected (${wallet.shortAddress})`));
    void config;
    return true;
  } catch (e) {
    console.log(chalk.red(`  ${e instanceof Error ? e.message : String(e)}`));
    return false;
  }
}

function validateLiveMode(config: FlashXConfig, wallet: WalletManager): { valid: boolean; reason?: string } {
  if (!wallet.isConnected) return { valid: false, reason: 'No wallet connected.' };
  if (config.devMode) return { valid: false, reason: 'DEV_MODE active. Disable before live trading.' };
  return { valid: true };
}

/**
 * FAF Command Handlers — Complete Staking Terminal
 *
 * 10 commands matching flash-terminal exactly.
 * On-chain data via SDK (isolated), execution via TxPipeline.
 */

import chalk from 'chalk';
import { header, titleBlock, divider, kv, kvBold, section, usd, dim, allocBar, tableHeader, tableRow } from '../cli/display.js';
import { VIP_TIERS, VOLTAGE_TIERS, getNextTier, formatFaf } from './faf-registry.js';
import { getFafStakeInfo, getFafUnstakeRequests, getVoltageInfo, getFafBalance } from './faf-data.js';
import type { SdkService } from '../services/sdk-service.js';
import type { WalletManager } from '../wallet/manager.js';
import type { TxResult } from '../types/index.js';

// ─── SDK Context Helper ─────────────────────────────────────────────────────

async function getStakeContext(sdkService: SdkService | null, wallet: WalletManager) {
  if (!sdkService || !wallet.isConnected || !wallet.keypair) return null;

  // Initialize SDK with real wallet
  sdkService.init(wallet.keypair);
  if (!sdkService.isReady) return null;

  const perpClient = sdkService.perpClient;
  const poolConfig = sdkService.getPoolConfig('Crypto.1');
  if (!perpClient || !poolConfig) return null;

  return { perpClient, poolConfig, publicKey: wallet.publicKey! };
}

// ─── 1. faf (dashboard) ─────────────────────────────────────────────────────

export async function handleFafDashboard(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);

  const lines: string[] = [titleBlock('FAF STAKING DASHBOARD', 50)];

  if (!ctx) {
    lines.push(`  ${dim('Connect wallet in Live mode to view FAF data.')}`);
    lines.push('');
    lines.push(`  ${dim('FAF is the Flash Trade governance token.')}`);
    lines.push(`  ${dim('Stake FAF for fee discounts + USDC revenue share.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  const [info, requests, voltage, walletBalance] = await Promise.allSettled([
    getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey),
    getFafUnstakeRequests(ctx.perpClient, ctx.poolConfig, ctx.publicKey),
    getVoltageInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey),
    getFafBalance(wallet.connection, ctx.publicKey),
  ]);

  const stake = info.status === 'fulfilled' ? info.value : null;
  const reqs = requests.status === 'fulfilled' ? requests.value : [];
  const volt = voltage.status === 'fulfilled' ? voltage.value : null;
  const bal = walletBalance.status === 'fulfilled' ? walletBalance.value : 0;

  // Staking
  lines.push(kvBold('Staked FAF', stake ? chalk.white.bold(formatFaf(stake.stakedAmount)) : dim('0 FAF')));
  lines.push(kv('Wallet FAF', formatFaf(bal)));
  lines.push(kv('Total FAF', formatFaf((stake?.stakedAmount ?? 0) + bal)));
  lines.push(kv('VIP Tier', stake ? tierBadge(stake.tier.level, stake.tier.name) : dim('None')));
  lines.push(kv('Fee Discount', stake ? chalk.green(stake.tier.feeDiscount + '%') : dim('0%')));

  // Progress to next tier
  if (stake) {
    const nextT = getNextTier(stake.tier.level);
    if (nextT) {
      const progress = Math.min((stake.stakedAmount / nextT.fafRequired) * 100, 100);
      const bar = allocBar(progress, 15);
      lines.push(kv('Next Tier', `${tierBadge(nextT.level, nextT.name)} ${bar} ${progress.toFixed(0)}%`));
    } else {
      lines.push(kv('Tier', chalk.green.bold('MAX LEVEL')));
    }
  }

  // Rewards
  if (stake && (stake.pendingRewards > 0 || stake.pendingRevenue > 0)) {
    lines.push(section('REWARDS'));
    if (stake.pendingRewards > 0) lines.push(kv('Pending FAF', chalk.green(formatFaf(stake.pendingRewards))));
    if (stake.pendingRevenue > 0) lines.push(kv('Pending USDC', chalk.green(usd(stake.pendingRevenue))));
  }

  // Unstake requests
  if (reqs.length > 0) {
    lines.push(section('UNSTAKE REQUESTS'));
    for (const r of reqs) {
      const status = r.isUnlocked ? chalk.green('UNLOCKED') : dim(`${r.daysRemaining}d remaining`);
      lines.push(`  #${r.index}  ${formatFaf(r.amount).padEnd(14)} ${status}`);
    }
  }

  // Voltage
  if (volt) {
    lines.push(section('VOLTAGE'));
    lines.push(kv('Tier', volt.tierName));
    lines.push(kv('Multiplier', volt.multiplier + 'x'));
    lines.push(kv('Trades', String(volt.tradeCounter)));
  }

  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// FAF stake/unstake/claim execution is handled by ExecutionEngine.executeFafAction()
// which builds via SdkService and sends through TxPipeline.

// ─── 5. faf tier ────────────────────────────────────────────────────────────

export async function handleFafTier(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);
  const stake = ctx ? await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey) : null;

  const currentTier = stake ? stake.tier : VIP_TIERS[0];
  void getNextTier(currentTier.level); // available if needed

  const lines: string[] = [
    '',
    `  ${chalk.hex('#00FF88').bold('VIP TIER LEVELS')}`,
    `  ${dim('─'.repeat(65))}`,
    '',
  ];

  // Current tier info
  const currentLevel = stake ? stake.level : 0;

  // Tier table header (matching flash-terminal exactly: 6 columns)
  lines.push(`  ${'Level'.padEnd(10)} ${'FAF Required'.padEnd(14)} ${'Fee Disc.'.padEnd(12)} ${'Referral'.padEnd(12)} ${'Spot LO'.padEnd(10)} DCA`);
  lines.push(`  ${dim('─'.repeat(65))}`);

  for (const t of VIP_TIERS) {
    const marker = t.level === currentLevel ? chalk.green(' ←') : '';
    const faf = t.fafRequired === 0 ? '0' : formatFaf(t.fafRequired);
    lines.push(
      `  ${`Level ${t.level}`.padEnd(10)} ${faf.padEnd(14)} ${(t.feeDiscount + '%').padEnd(12)} ${(t.referralRebate + '%').padEnd(12)} ${(t.spotLoDiscount + '%').padEnd(10)} ${t.dcaDiscount}%${marker}`,
    );
  }

  lines.push('');
  lines.push(dim('  Stake FAF to unlock fee discounts and higher referral rebates.'));
  lines.push('');
  return { success: true, error: lines.join('\n') };
}

// ─── 6. faf rewards ─────────────────────────────────────────────────────────

export async function handleFafRewards(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);

  const lines: string[] = [header('FAF REWARDS')];

  if (!ctx) {
    lines.push(`  ${dim('Connect wallet to view rewards.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  const stake = await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey);
  if (!stake) {
    lines.push(`  ${dim('No FAF staked. Stake FAF to earn rewards.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  lines.push(kv('Pending FAF', stake.pendingRewards > 0 ? chalk.green(formatFaf(stake.pendingRewards)) : dim('0 FAF')));
  lines.push(kv('Pending USDC', stake.pendingRevenue > 0 ? chalk.green(usd(stake.pendingRevenue)) : dim('$0.00')));
  lines.push(kv('Staked', formatFaf(stake.stakedAmount)));
  lines.push(kv('VIP Level', tierBadge(stake.tier.level, stake.tier.name)));

  if (stake.pendingRewards > 0 || stake.pendingRevenue > 0) {
    lines.push('');
    lines.push(`  ${dim('Claim:')} faf claim`);
  }

  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// ─── 7. faf referral ────────────────────────────────────────────────────────

export async function handleFafReferral(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);
  const stake = ctx ? await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey) : null;

  const lines: string[] = [header('FAF REFERRAL')];

  lines.push(kv('Rebate Rate', stake ? stake.tier.referralRebate + '%' : '2%'));
  lines.push(kv('VIP Tier', stake ? tierBadge(stake.tier.level, stake.tier.name) : dim('None')));
  lines.push('');
  lines.push(`  ${dim('Referral rebates are credited automatically when')}`);
  lines.push(`  ${dim('referred users trade on Flash Trade.')}`);
  lines.push(`  ${dim('Higher VIP tier = higher rebate percentage.')}`);

  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// ─── 8. faf points ──────────────────────────────────────────────────────────

export async function handleFafPoints(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);

  const lines: string[] = [header('VOLTAGE POINTS')];

  if (!ctx) {
    lines.push(`  ${dim('Connect wallet to view voltage data.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  const volt = await getVoltageInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey);

  if (!volt) {
    lines.push(`  ${dim('No voltage data available.')}`);
  } else {
    lines.push(kv('Tier', chalk.white.bold(volt.tierName)));
    lines.push(kv('Multiplier', chalk.green(volt.multiplier + 'x')));
    lines.push(kv('Trade Counter', String(volt.tradeCounter)));
  }

  lines.push(section('ALL VOLTAGE TIERS'));
  for (const t of VOLTAGE_TIERS) {
    const current = volt && t.name === volt.tierName;
    lines.push(`  ${current ? chalk.green('●') : dim('○')} ${t.name.padEnd(14)} ${t.multiplier}x`);
  }

  lines.push('');
  lines.push(`  ${dim('Voltage points are earned by trading on Flash Trade.')}`);
  lines.push(`  ${dim('Check flash.trade for full points breakdown.')}`);
  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// ─── 9. faf requests ────────────────────────────────────────────────────────

export async function handleFafRequests(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);

  const lines: string[] = [header('UNSTAKE REQUESTS')];

  if (!ctx) {
    lines.push(`  ${dim('Connect wallet to view unstake requests.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  const requests = await getFafUnstakeRequests(ctx.perpClient, ctx.poolConfig, ctx.publicKey);

  if (requests.length === 0) {
    lines.push(`  ${dim('No pending unstake requests.')}`);
    lines.push(divider());
    return { success: true, error: lines.join('\n') };
  }

  lines.push(tableHeader([
    { label: '#', width: 4 },
    { label: 'Amount', width: 14 },
    { label: 'Status', width: 20 },
    { label: 'Time Left', width: 14 },
  ]));

  for (const r of requests) {
    const status = r.isUnlocked
      ? chalk.green('READY TO WITHDRAW')
      : chalk.yellow('LOCKED');
    const timeLeft = r.isUnlocked
      ? chalk.green('Now')
      : dim(`${r.daysRemaining}d ${Math.floor((r.timeRemainingSeconds % 86400) / 3600)}h`);

    lines.push(tableRow([
      String(r.index), formatFaf(r.amount), status, timeLeft,
    ], [4, 14, 20, 14]));
  }

  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// FAF cancel is handled by ExecutionEngine.executeFafAction('cancel', requestIndex)
// which calls SdkService.buildFafCancel() and sends through TxPipeline.

// ─── Helpers ────────────────────────────────────────────────────────────────

function tierBadge(level: number, name: string): string {
  if (level === 0) return dim('None');
  if (level <= 2) return chalk.cyan(name);
  if (level <= 4) return chalk.yellow(name);
  return chalk.green.bold(name);
}


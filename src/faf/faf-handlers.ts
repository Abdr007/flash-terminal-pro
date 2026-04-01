/**
 * FAF Command Handlers — Complete Staking Terminal
 *
 * 10 commands matching flash-terminal exactly.
 * On-chain data via SDK (isolated), execution via TxPipeline.
 */

import chalk from 'chalk';
import { header, divider, kv, kvBold, section, usd, dim, warning, tableHeader, tableRow } from '../cli/display.js';
import { VIP_TIERS, VOLTAGE_TIERS, getNextTier, formatFaf, UNSTAKE_UNLOCK_DAYS } from './faf-registry.js';
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

  const lines: string[] = [header('FAF STAKING DASHBOARD')];

  if (!ctx) {
    lines.push(`  ${dim('Connect wallet in Live mode to view FAF data.')}`);
    lines.push('');
    lines.push(`  ${dim('FAF is the Flash Trade governance token.')}`);
    lines.push(`  ${dim('Stake FAF for fee discounts + USDC revenue share.')}`);
    lines.push(divider());
    lines.push(flowHint('faf tier │ faf rewards │ help'));
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
  lines.push(kv('VIP Tier', stake ? tierBadge(stake.tier.level, stake.tier.name) : dim('None')));
  lines.push(kv('Fee Discount', stake ? chalk.green(stake.tier.feeDiscount + '%') : dim('0%')));

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
  lines.push(flowHint('faf stake <amt> │ faf claim │ faf tier │ faf rewards'));
  return { success: true, error: lines.join('\n') };
}

// ─── 2. faf stake <amount> ──────────────────────────────────────────────────

export async function handleFafStake(amount: number, sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  if (!sdkService || !wallet.isConnected || !wallet.keypair) {
    return { success: false, error: `  ${chalk.yellow('FAF stake requires wallet in Live mode.')}` };
  }

  const lines: string[] = [header('FAF STAKE')];
  lines.push(kv('Amount', chalk.white.bold(formatFaf(amount))));
  lines.push(kv('Lock Period', dim('No lock — staked FAF can be unstaked anytime')));
  lines.push(kv('Benefit', dim('Fee discounts + USDC revenue share')));

  const result = await sdkService.buildFafStake(wallet.keypair, amount);
  if (!result) {
    lines.push('');
    lines.push(`  ${chalk.yellow('Could not build stake transaction.')}`);
    lines.push(`  ${dim('Use flash.trade website for FAF staking.')}`);
    lines.push(divider());
    return { success: false, error: lines.join('\n') };
  }

  lines.push('');
  lines.push(`  ${dim('Transaction built. Submit via "faf stake" in Live mode.')}`);
  lines.push(divider());
  return { success: true, error: lines.join('\n') };
}

// ─── 3. faf unstake <amount> ────────────────────────────────────────────────

export async function handleFafUnstake(amount: number, sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  if (!sdkService || !wallet.isConnected || !wallet.keypair) {
    return { success: false, error: `  ${chalk.yellow('FAF unstake requires wallet in Live mode.')}` };
  }

  const lines: string[] = [header('FAF UNSTAKE REQUEST')];
  lines.push(kv('Amount', chalk.white.bold(formatFaf(amount))));
  lines.push(kv('Unlock Period', chalk.yellow(`${UNSTAKE_UNLOCK_DAYS} days`)));
  lines.push(warning(`Your FAF will be locked for ${UNSTAKE_UNLOCK_DAYS} days before withdrawal.`));

  const result = await sdkService.buildFafUnstake(wallet.keypair, amount);
  if (!result) {
    lines.push('');
    lines.push(`  ${chalk.yellow('Could not build unstake transaction.')}`);
    lines.push(`  ${dim('Use flash.trade website.')}`);
  }

  lines.push(divider());
  lines.push(flowHint('faf requests │ faf │ faf cancel <index>'));
  return { success: true, error: lines.join('\n') };
}

// ─── 4. faf claim ───────────────────────────────────────────────────────────

export async function handleFafClaim(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  if (!sdkService || !wallet.isConnected || !wallet.keypair) {
    return { success: false, error: `  ${chalk.yellow('FAF claim requires wallet in Live mode.')}` };
  }

  const result = await sdkService.buildFafClaim(wallet.keypair);
  if (!result) {
    return { success: false, error: `  ${chalk.yellow('Could not build claim transaction. Use flash.trade.')}` };
  }

  return { success: true, error: `\n  ${chalk.green('Claim transaction ready.')}\n  ${dim('Submit in Live mode.')}\n` };
}

// ─── 5. faf tier ────────────────────────────────────────────────────────────

export async function handleFafTier(sdkService: SdkService | null, wallet: WalletManager): Promise<TxResult> {
  const ctx = await getStakeContext(sdkService, wallet);
  const stake = ctx ? await getFafStakeInfo(ctx.perpClient, ctx.poolConfig, ctx.publicKey) : null;

  const currentTier = stake ? stake.tier : VIP_TIERS[0];
  const nextTier = getNextTier(currentTier.level);

  const lines: string[] = [header('VIP TIER SYSTEM')];

  if (stake) {
    lines.push(kvBold('Your Tier', tierBadge(currentTier.level, currentTier.name)));
    lines.push(kv('Staked', formatFaf(stake.stakedAmount)));
    lines.push(kv('Fee Discount', chalk.green(currentTier.feeDiscount + '%')));
    lines.push(kv('Referral Rebate', currentTier.referralRebate + '%'));

    if (nextTier) {
      const needed = nextTier.fafRequired - stake.stakedAmount;
      lines.push('');
      lines.push(`  ${dim('Next:')} ${tierBadge(nextTier.level, nextTier.name)} ${dim('— need')} ${chalk.yellow(formatFaf(needed))} ${dim('more')}`);
      lines.push(`  ${dim('Benefit: ' + nextTier.feeDiscount + '% fee discount')}`);
    }
  }

  lines.push(section('ALL TIERS'));
  lines.push(tableHeader([
    { label: 'Tier', width: 10 },
    { label: 'FAF Required', width: 14 },
    { label: 'Fee Discount', width: 14 },
    { label: 'Referral', width: 10 },
  ]));

  for (const t of VIP_TIERS) {
    const isCurrent = stake && t.level === currentTier.level;
    const marker = isCurrent ? chalk.green('◀') : ' ';
    lines.push(tableRow([
      `${t.name} ${marker}`, formatFaf(t.fafRequired), t.feeDiscount + '%', t.referralRebate + '%',
    ], [10, 14, 14, 10]));
  }

  lines.push(divider());
  lines.push(flowHint('faf stake <amt> │ faf │ faf rewards'));
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
    lines.push(flowHint('faf stake <amt> │ faf tier'));
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
  lines.push(flowHint('faf claim │ faf │ faf tier'));
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
  lines.push(flowHint('faf tier │ faf rewards │ faf'));
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
  lines.push(flowHint('faf cancel <index> │ faf │ faf claim'));
  return { success: true, error: lines.join('\n') };
}

// ─── 10. faf cancel <index> ─────────────────────────────────────────────────

export async function handleFafCancel(index: number): Promise<TxResult> {
  const lines: string[] = [header('CANCEL UNSTAKE REQUEST')];

  lines.push(kv('Request #', String(index)));
  lines.push('');
  lines.push(`  ${chalk.yellow('Cancel requires on-chain transaction.')}`);
  lines.push(`  ${dim('Cancelled FAF will be returned to your staked balance.')}`);
  lines.push(`  ${dim('Use flash.trade website to cancel unstake requests.')}`);

  lines.push(divider());
  lines.push(flowHint('faf requests │ faf'));
  return { success: true, error: lines.join('\n') };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function tierBadge(level: number, name: string): string {
  if (level === 0) return dim('None');
  if (level <= 2) return chalk.cyan(name);
  if (level <= 4) return chalk.yellow(name);
  return chalk.green.bold(name);
}

function flowHint(next: string): string {
  return `\n  ${dim('Next:')} ${next}\n`;
}

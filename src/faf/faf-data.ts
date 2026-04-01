/**
 * FAF Live Data — reads on-chain staking state via SDK
 *
 * Uses PerpetualsClient.getTokenStakeAccount() to read:
 *   - staked amount
 *   - VIP level
 *   - pending rewards
 *   - pending revenue (USDC)
 *   - unstake requests with time remaining
 *   - voltage/trade counter
 *
 * This file imports flash-sdk — must be isolated.
 */

import { PublicKey, Connection } from '@solana/web3.js';
import { PerpetualsClient, PoolConfig, TokenStakeAccount } from 'flash-sdk';
import BN from 'bn.js';
import { FAF_DECIMALS, getVipTier, VOLTAGE_TIERS, type VipTier } from './faf-registry.js';
import { getLogger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FafStakeInfo {
  stakedAmount: number;
  level: number;
  tier: VipTier;
  pendingRewards: number;
  pendingRevenue: number;
  withdrawRequestCount: number;
}

export interface FafUnstakeRequest {
  index: number;
  amount: number;
  timeRemainingSeconds: number;
  daysRemaining: number;
  isUnlocked: boolean;
}

export interface FafVoltageInfo {
  level: number;
  tierName: string;
  multiplier: number;
  tradeCounter: number;
}

// ─── Read Staking Info ──────────────────────────────────────────────────────

export async function getFafStakeInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafStakeInfo | null> {
  const log = getLogger();

  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return null;
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  const stakedAmount = stakeAccount.activeStakeAmount
    ? new BN(stakeAccount.activeStakeAmount.toString()).toNumber() / Math.pow(10, FAF_DECIMALS)
    : 0;

  const level = stakeAccount.level ?? 0;
  const tier = getVipTier(stakedAmount);

  let pendingRewards = 0;
  try {
    if (stakeAccount.rewardTokens) {
      pendingRewards = new BN(stakeAccount.rewardTokens.toString()).toNumber() / Math.pow(10, FAF_DECIMALS);
    }
  } catch { /* ok */ }

  let pendingRevenue = 0;
  try {
    if (stakeAccount.unclaimedRevenueAmount) {
      pendingRevenue = new BN(stakeAccount.unclaimedRevenueAmount.toString()).toNumber() / Math.pow(10, 6);
    }
  } catch { /* ok */ }

  const withdrawRequestCount = stakeAccount.withdrawRequestCount ?? 0;

  log.debug('FAF', `Stake: ${stakedAmount.toFixed(2)} FAF, level ${level}, rewards ${pendingRewards.toFixed(2)}, revenue $${pendingRevenue.toFixed(2)}`);

  return { stakedAmount, level, tier, pendingRewards, pendingRevenue, withdrawRequestCount };
}

// ─── Read Unstake Requests ──────────────────────────────────────────────────

export async function getFafUnstakeRequests(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafUnstakeRequest[]> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return [];
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return [];

  const requests: FafUnstakeRequest[] = [];
  const count = stakeAccount.withdrawRequestCount ?? 0;
  const list = stakeAccount.withdrawRequest ?? [];

  for (let i = 0; i < Math.min(count, list.length); i++) {
    const req = list[i];
    if (!req) continue;

    const locked = new BN(req.lockedAmount?.toString() ?? '0').toNumber() / Math.pow(10, FAF_DECIMALS);
    const withdrawable = new BN(req.withdrawableAmount?.toString() ?? '0').toNumber() / Math.pow(10, FAF_DECIMALS);
    const totalAmount = locked + withdrawable;
    if (totalAmount <= 0) continue;

    const timeRemainingS = new BN(req.timeRemaining?.toString() ?? '0').toNumber();
    const daysRemaining = Math.max(0, Math.ceil(timeRemainingS / 86400));
    const isUnlocked = timeRemainingS <= 0;

    requests.push({ index: i, amount: totalAmount, timeRemainingSeconds: timeRemainingS, daysRemaining, isUnlocked });
  }

  return requests;
}

// ─── Read Voltage Info ──────────────────────────────────────────────────────

export async function getVoltageInfo(
  perpClient: PerpetualsClient,
  poolConfig: PoolConfig,
  userPublicKey: PublicKey,
): Promise<FafVoltageInfo | null> {
  let stakeAccount: TokenStakeAccount | null;
  try {
    stakeAccount = await perpClient.getTokenStakeAccount(poolConfig, userPublicKey);
  } catch {
    return null;
  }
  if (!stakeAccount || !stakeAccount.isInitialized) return null;

  const tradeCounter = Number(stakeAccount.tradeCounter ?? 0);
  const tier = VOLTAGE_TIERS[0]; // Voltage tier determined by backend, not on-chain

  return { level: 0, tierName: tier.name, multiplier: tier.multiplier, tradeCounter };
}

// ─── Get Wallet FAF Balance ─────────────────────────────────────────────────

const FAF_MINT = new PublicKey('FAFxVxnkzZHMCodkWyoccgUNgVScqMw2mhhQBYDFjFAF');

export async function getFafBalance(connection: Connection, userPublicKey: PublicKey): Promise<number> {
  try {
    const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
    const accounts = await connection.getTokenAccountsByOwner(userPublicKey, {
      mint: FAF_MINT,
      programId: TOKEN_PROGRAM_ID,
    });
    if (accounts.value.length === 0) return 0;
    const data = accounts.value[0].account.data;
    const amount = data.readBigUInt64LE(64);
    return Number(amount) / Math.pow(10, FAF_DECIMALS);
  } catch {
    return 0;
  }
}

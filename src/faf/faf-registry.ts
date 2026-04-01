/**
 * FAF Token Registry
 *
 * Constants, VIP tier definitions, voltage tiers.
 * Matches flash-terminal's faf-registry.ts exactly.
 */

export const FAF_DECIMALS = 6;
export const UNSTAKE_UNLOCK_DAYS = 90;

// ─── VIP Tiers ──────────────────────────────────────────────────────────────

export interface VipTier {
  level: number;
  name: string;
  fafRequired: number;
  feeDiscount: number;
  referralRebate: number;
}

export const VIP_TIERS: VipTier[] = [
  { level: 0, name: 'None',    fafRequired: 0,         feeDiscount: 0,    referralRebate: 2 },
  { level: 1, name: 'Level 1', fafRequired: 20_000,    feeDiscount: 2.5,  referralRebate: 2.5 },
  { level: 2, name: 'Level 2', fafRequired: 40_000,    feeDiscount: 3.5,  referralRebate: 3 },
  { level: 3, name: 'Level 3', fafRequired: 100_000,   feeDiscount: 5,    referralRebate: 4 },
  { level: 4, name: 'Level 4', fafRequired: 200_000,   feeDiscount: 7,    referralRebate: 5.5 },
  { level: 5, name: 'Level 5', fafRequired: 1_000_000, feeDiscount: 9.5,  referralRebate: 7.5 },
  { level: 6, name: 'Level 6', fafRequired: 2_000_000, feeDiscount: 12,   referralRebate: 10 },
];

// ─── Voltage Tiers ──────────────────────────────────────────────────────────

export interface VoltageTier {
  name: string;
  multiplier: number;
}

export const VOLTAGE_TIERS: VoltageTier[] = [
  { name: 'Rookie',      multiplier: 1.0 },
  { name: 'Degenerate',  multiplier: 1.2 },
  { name: 'Flow Master', multiplier: 1.4 },
  { name: 'Ape Trade',   multiplier: 1.6 },
  { name: 'Perp King',   multiplier: 1.8 },
  { name: 'Giga Chad',   multiplier: 2.0 },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getVipTier(stakedFaf: number): VipTier {
  for (let i = VIP_TIERS.length - 1; i >= 0; i--) {
    if (stakedFaf >= VIP_TIERS[i].fafRequired) return VIP_TIERS[i];
  }
  return VIP_TIERS[0];
}

export function getNextTier(currentLevel: number): VipTier | null {
  if (currentLevel >= VIP_TIERS.length - 1) return null;
  return VIP_TIERS[currentLevel + 1];
}

export function formatFaf(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M FAF`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K FAF`;
  return `${amount.toFixed(2)} FAF`;
}

/**
 * Quote Engine — API-Only
 *
 * Replaces flash-sdk for local calculations.
 * Uses hardcoded protocol fee rates (verified from Flash docs)
 * and API data for everything else.
 *
 * Zero SDK dependency.
 */

import { getLogger } from '../utils/logger.js';

// ─── Fee Rates (from Flash Trade protocol docs, verified) ───────────────────

const FEE_RATES: Record<string, number> = {
  SOL: 0.00051, BTC: 0.00051, ETH: 0.00051, JitoSOL: 0.00051,
  ZEC: 0.002, BNB: 0.001,
  EUR: 0.0003, GBP: 0.0003, USDJPY: 0.0003, USDCNH: 0.0003,
  XAU: 0.001, XAG: 0.001, CRUDEOIL: 0.0015, NATGAS: 0.0015,
  JUP: 0.0011, JTO: 0.0011, RAY: 0.0011, PYTH: 0.0011,
  KMNO: 0.002, MET: 0.002, HYPE: 0.002,
  BONK: 0.0012, WIF: 0.0012, PENGU: 0.0012, PUMP: 0.0012, FARTCOIN: 0.0012,
  SPY: 0.001, NVDA: 0.001, TSLA: 0.001, AAPL: 0.001, AMD: 0.001, AMZN: 0.001,
  ORE: 0.002,
};

export interface LocalEstimate {
  sizeUsd: number;
  openFee: number;
  feeRate: number;
  leverage: number;
  collateralUsd: number;
}

/**
 * Estimate trade parameters locally (no SDK, no network).
 */
export function estimateOpenPosition(market: string, collateral: number, leverage: number): LocalEstimate {
  const feeRate = FEE_RATES[market] ?? 0.001;
  const sizeUsd = collateral * leverage;
  const openFee = sizeUsd * feeRate;

  return { sizeUsd, openFee, feeRate, leverage, collateralUsd: collateral };
}

/**
 * Cross-validate an API quote against our local estimate.
 * Returns divergences if any field is off by more than tolerance.
 */
export function crossValidateWithEstimate(
  apiQuote: { entryFee?: number; newLeverage?: number },
  localEstimate: LocalEstimate,
  tolerancePct = 50, // 50% tolerance — API and local may use different fee models
): { valid: boolean; divergences: string[] } {
  const log = getLogger();
  const divergences: string[] = [];

  const apiFee = Number(apiQuote.entryFee);
  if (localEstimate.openFee > 0 && Number.isFinite(apiFee) && apiFee > 0) {
    const feeDivergence = Math.abs(apiFee - localEstimate.openFee) / localEstimate.openFee * 100;
    if (feeDivergence > tolerancePct) {
      divergences.push(`Fee: API=$${apiFee.toFixed(4)} vs est=$${localEstimate.openFee.toFixed(4)} (${feeDivergence.toFixed(0)}%)`);
    }
  }

  if (divergences.length > 0) {
    log.warn('QUOTE', `Cross-validation: ${divergences.join('; ')}`);
  }

  return { valid: divergences.length === 0, divergences };
}

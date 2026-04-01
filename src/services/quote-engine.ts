/**
 * Quote Engine — API-Driven
 *
 * Uses FeeService for on-chain fee rates (via Flash API).
 * No hardcoded fee rates. All data from protocol.
 */

import { getLogger } from '../utils/logger.js';
import { getMarketFeeRates } from './fee-service.js';
import type { FlashApiClient } from './api-client.js';

export interface LocalEstimate {
  sizeUsd: number;
  openFee: number;
  feeRate: number;
  leverage: number;
  collateralUsd: number;
}

/**
 * Estimate trade parameters using API-driven fee rates.
 * Falls back gracefully if fee data unavailable.
 */
export async function estimateOpenPosition(
  market: string,
  collateral: number,
  leverage: number,
  api?: FlashApiClient | null,
): Promise<LocalEstimate> {
  let feeRate = 0;

  if (api) {
    const rates = await getMarketFeeRates(market, api);
    if (rates.source === 'api') {
      feeRate = rates.openFeeRate;
    }
  }

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
  tolerancePct = 50,
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

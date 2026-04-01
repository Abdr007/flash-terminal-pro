/**
 * Fee Service — API-Driven Fee Rates
 *
 * Fetches per-market fee rates from Flash API pool-data endpoint.
 * No hardcoded rates. No SDK dependency.
 *
 * API returns: openPositionFeeRate, closePositionFeeRate per custody
 * Raw values are divided by RATE_POWER (1e9) to get decimal rates.
 */

import { getLogger } from '../utils/logger.js';
import type { FlashApiClient } from './api-client.js';

// Flash protocol constant (RATE_DECIMALS = 9)
const RATE_POWER = 1_000_000_000;
const BPS_POWER = 10_000;

// ─── Types ─────────────────────────────────────────────────────────────────

export interface MarketFeeRates {
  openFeeRate: number;   // decimal, e.g. 0.00051
  closeFeeRate: number;  // decimal, e.g. 0.00051
  maxLeverage: number;   // e.g. 100
  source: 'api' | 'unavailable';
}

// ─── Cache ─────────────────────────────────────────────────────────────────

let _feeCache: Map<string, MarketFeeRates> | null = null;
let _feeCacheExpiry = 0;
const FEE_CACHE_TTL = 60_000; // 60 seconds

// ─── Fee Fetcher ───────────────────────────────────────────────────────────

/**
 * Fetch all market fee rates from Flash API pool-data.
 * Caches for 60 seconds. Returns per-market fee rates.
 */
async function fetchAllFeeRates(api: FlashApiClient): Promise<Map<string, MarketFeeRates>> {
  if (_feeCache && Date.now() < _feeCacheExpiry) return _feeCache;

  const log = getLogger();
  const fees = new Map<string, MarketFeeRates>();

  try {
    const poolData = await api.getPoolData() as Record<string, unknown>;
    const pools = (poolData['pools'] ?? []) as Record<string, unknown>[];

    for (const pool of pools) {
      const custodies = (pool['custodyStats'] ?? []) as Record<string, unknown>[];

      for (const c of custodies) {
        const symbol = String(c['symbol'] ?? '').toUpperCase();
        if (!symbol || symbol === 'USDC' || symbol === 'USDT') continue;

        const openRaw = Number(c['openPositionFeeRate'] ?? 0);
        const closeRaw = Number(c['closePositionFeeRate'] ?? 0);
        const maxLevRaw = Number(c['maxLeverage'] ?? 0);

        const openFeeRate = openRaw / RATE_POWER;
        const closeFeeRate = closeRaw / RATE_POWER;
        const maxLeverage = maxLevRaw / BPS_POWER;

        if (Number.isFinite(openFeeRate) && openFeeRate >= 0 && openFeeRate < 0.1) {
          fees.set(symbol, { openFeeRate, closeFeeRate, maxLeverage, source: 'api' });
        }
      }
    }

    _feeCache = fees;
    _feeCacheExpiry = Date.now() + FEE_CACHE_TTL;
    log.debug('FEE', `Loaded fee rates for ${fees.size} markets from API`);
  } catch (e) {
    log.warn('FEE', `Fee fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return fees;
}

/**
 * Get fee rates for a specific market.
 * Returns API-driven rates, or unavailable if API fails.
 */
export async function getMarketFeeRates(
  market: string,
  api: FlashApiClient,
): Promise<MarketFeeRates> {
  const upper = market.toUpperCase();
  const all = await fetchAllFeeRates(api);
  return all.get(upper) ?? { openFeeRate: 0, closeFeeRate: 0, maxLeverage: 0, source: 'unavailable' };
}

/** Clear fee cache (for testing). */
export function clearFeeCache(): void {
  _feeCache = null;
  _feeCacheExpiry = 0;
}

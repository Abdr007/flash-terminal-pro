/**
 * Pool Data — Live metrics from Flash API
 *
 * Primary: Flash Trade official API (api.prod.flash.trade/earn-page/data)
 * Fallback: Pool data from FlashAPI + estimation
 *
 * Matches flash-terminal's pool-data.ts approach exactly.
 */

import { getLogger } from '../utils/logger.js';
import type { FlashApiClient } from '../services/api-client.js';

const FLASH_EARN_API = 'https://api.prod.flash.trade/earn-page/data';
const MAX_APY = 1000; // Cap at 1000% to prevent unreliable projections

export interface PoolMetrics {
  poolId: string;
  tvl: number;
  flpPrice: number;
  sflpPrice: number;
  stablePct: number;
  assetCount: number;
  apy7d: number;
}

let _cache: { data: Map<string, PoolMetrics>; expiry: number } | null = null;
const CACHE_TTL = 30_000;

// ─── Official Flash Trade Earn API ──────────────────────────────────────────

interface FlashEarnPool {
  poolAddress: string;
  aum: string;
  flpTokenSymbol: string;
  sflpTokenSymbol: string;
  flpDailyApy: number | null;
  flpWeeklyApy: number | null;
  sflpWeeklyApr: number | null;
  sflpDailyApr: number | null;
  flpPrice: string;
  sFlpPrice: string;
}

/** Fetch official earn data from Flash Trade API */
async function fetchOfficialEarnData(): Promise<Map<string, FlashEarnPool> | null> {
  const log = getLogger();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(FLASH_EARN_API, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      log.debug('EARN', `Official API returned ${res.status}`);
      return null;
    }

    const data = await res.json() as { pools?: FlashEarnPool[] };
    if (!data.pools?.length) return null;

    const map = new Map<string, FlashEarnPool>();
    for (const pool of data.pools) {
      if (pool.flpTokenSymbol) {
        map.set(pool.flpTokenSymbol, pool);
      }
    }

    log.debug('EARN', `Official API: ${map.size} pools loaded`);
    return map;
  } catch (e) {
    log.debug('EARN', `Official API failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ─── Pool Name → FLP Symbol Mapping ─────────────────────────────────────────

const POOL_FLP_SYMBOLS: Record<string, string> = {
  'Crypto.1': 'FLP.1',
  'Virtual.1': 'FLP.2',
  'Governance.1': 'FLP.3',
  'Community.1': 'FLP.4',
  'Community.2': 'FLP.5',
  'Trump.1': 'FLP.6',
  'Ore.1': 'FLP.7',
  'Equity.1': 'FLP.8',
  'Remora.1': 'FLP.9',
};

// ─── Main Metrics Fetch ─────────────────────────────────────────────────────

export async function getPoolMetrics(api: FlashApiClient): Promise<Map<string, PoolMetrics>> {
  if (_cache && Date.now() < _cache.expiry) return _cache.data;

  const log = getLogger();
  const metrics = new Map<string, PoolMetrics>();

  // Fetch both sources in parallel
  const [officialData, poolData] = await Promise.all([
    fetchOfficialEarnData(),
    api.getPoolData().catch(() => null) as Promise<Record<string, unknown> | null>,
  ]);

  const hasOfficial = officialData !== null && officialData.size > 0;

  try {
    const pools = ((poolData as Record<string, unknown>)?.['pools'] ?? []) as Record<string, unknown>[];

    for (const pool of pools) {
      const name = String(pool['poolName'] ?? '');
      const lp = pool['lpStats'] as Record<string, unknown> | undefined;
      const custodies = (pool['custodyStats'] ?? []) as unknown[];

      // Get official data for this pool
      const flpSymbol = POOL_FLP_SYMBOLS[name];
      const official = flpSymbol ? officialData?.get(flpSymbol) : undefined;

      // Prices: prefer official, fallback to pool data
      const flpPrice = official ? parseFloat(official.flpPrice) || 0 : Number(lp?.['lpPrice'] ?? 0);
      const sflpPrice = official ? parseFloat(official.sFlpPrice) || 0 : flpPrice;

      // TVL: prefer official AUM, fallback to pool data
      const tvl = official ? parseFloat(official.aum) || 0 : Number(lp?.['totalPoolValueUsd'] ?? 0);

      // APY: prefer official flpWeeklyApy, fallback to estimation
      let apy7d = 0;
      if (official?.flpWeeklyApy != null && Number.isFinite(official.flpWeeklyApy)) {
        apy7d = Math.min(official.flpWeeklyApy, MAX_APY);
      } else {
        apy7d = estimateApy(tvl, flpPrice);
      }

      metrics.set(name, {
        poolId: name,
        tvl,
        flpPrice,
        sflpPrice,
        stablePct: Number(lp?.['stableCoinPercentage'] ?? 0),
        assetCount: custodies.length,
        apy7d: Math.round(apy7d * 100) / 100,
      });
    }

    _cache = { data: metrics, expiry: Date.now() + CACHE_TTL };
    log.debug('EARN', `Metrics: ${metrics.size} pools (${hasOfficial ? 'official APY' : 'estimated APY'})`);
  } catch (e) {
    log.warn('EARN', `Pool data fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  return metrics;
}

/**
 * Fallback APY estimate when official API is unavailable.
 * Based on TVL inverse relationship (smaller pools → higher yield).
 */
function estimateApy(tvl: number, flpPrice: number): number {
  if (tvl <= 0 || flpPrice <= 0) return 0;
  if (tvl > 3_000_000) return 18;
  if (tvl > 1_000_000) return 30;
  if (tvl > 200_000) return 45;
  if (tvl > 50_000) return 65;
  return 90;
}

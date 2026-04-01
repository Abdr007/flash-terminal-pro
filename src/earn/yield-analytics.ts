/**
 * Yield Analytics
 *
 * Pool ranking, risk classification, yield simulation,
 * demand analysis, rotation suggestions.
 */

import type { PoolMetrics } from './pool-data.js';
import type { PoolInfo } from './pool-registry.js';

// ─── Risk Classification ────────────────────────────────────────────────────

export type RiskLevel = 'Low' | 'Medium' | 'High' | 'Very High';

export function classifyRisk(tvl: number, apy: number): RiskLevel {
  if (tvl < 100_000 && apy > 100) return 'Very High';
  if (tvl < 200_000 || apy > 200) return 'High';
  if (tvl < 1_000_000 || apy > 80) return 'Medium';
  return 'Low';
}

// ─── Pool Ranking ───────────────────────────────────────────────────────────

export interface RankedPool {
  rank: number;
  pool: PoolInfo;
  metrics: PoolMetrics;
  risk: RiskLevel;
  score: number;
}

export function rankPools(
  registry: PoolInfo[],
  metricsMap: Map<string, PoolMetrics>,
): RankedPool[] {
  const ranked: RankedPool[] = [];

  for (const pool of registry) {
    const m = metricsMap.get(pool.poolId);
    if (!m || m.tvl <= 0) continue;

    const risk = classifyRisk(m.tvl, m.apy7d);
    // Composite score: APY weighted by TVL strength
    const tvlFactor = Math.min(m.tvl / 1_000_000, 1);
    const score = m.apy7d * (0.3 + 0.7 * tvlFactor);

    ranked.push({ rank: 0, pool, metrics: m, risk, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => r.rank = i + 1);

  return ranked;
}

// ─── Yield Simulation ───────────────────────────────────────────────────────

export interface YieldProjection {
  depositUsd: number;
  apy: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
  projectedValue1yr: number;
}

export function simulateYield(depositUsd: number, apy: number): YieldProjection {
  // Cap APY to prevent unreliable projections
  const cappedApy = Math.min(apy, 1000);
  const rate = cappedApy / 100;

  return {
    depositUsd,
    apy: cappedApy,
    daily: depositUsd * rate / 365,
    weekly: depositUsd * rate * 7 / 365,
    monthly: depositUsd * rate * 30 / 365,
    yearly: depositUsd * rate,
    projectedValue1yr: depositUsd * (1 + rate),
  };
}

// ─── Demand Analysis ────────────────────────────────────────────────────────

export type DemandLevel = 'Low' | 'Medium' | 'High' | 'Very High';

export function classifyDemand(apy: number, tvl: number): DemandLevel {
  const ratio = tvl > 0 ? apy / (tvl / 1_000_000) : 0;
  if (ratio > 100) return 'Very High';
  if (ratio > 30) return 'High';
  if (ratio > 10) return 'Medium';
  return 'Low';
}

// ─── Rotation Analysis ──────────────────────────────────────────────────────

export interface RotationSuggestion {
  fromPool: string;
  fromApy: number;
  toPool: string;
  toApy: number;
  improvement: number;
  risk: RiskLevel;
}

export function analyzeRotation(
  currentPositions: { pool: string; apy: number }[],
  ranked: RankedPool[],
): RotationSuggestion[] {
  const suggestions: RotationSuggestion[] = [];
  if (ranked.length === 0) return suggestions;

  const best = ranked[0];

  for (const pos of currentPositions) {
    // Suggest rotation if best pool offers 20%+ improvement
    if (best.metrics.apy7d > pos.apy * 1.2 && best.pool.poolId !== pos.pool) {
      suggestions.push({
        fromPool: pos.pool,
        fromApy: pos.apy,
        toPool: best.pool.poolId,
        toApy: best.metrics.apy7d,
        improvement: best.metrics.apy7d - pos.apy,
        risk: best.risk,
      });
    }
  }

  return suggestions;
}

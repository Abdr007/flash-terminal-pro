/**
 * Quote Freshness Guard
 *
 * Protects against:
 *   - Stale quotes (price moved since quote was fetched)
 *   - Quote expiry (too much time between quote and execution)
 *   - Price drift (quote output vs build output divergence)
 *
 * TASK 1: Price drift detection — compare quote output vs build output
 * TASK 2: Quote expiry — enforce max age before execution
 */

import { getLogger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const QUOTE_MAX_AGE_MS = 10_000;      // 10 seconds — quotes older than this are stale
const PRICE_DRIFT_THRESHOLD = 0.01;    // 1% — max allowed deviation between quote and build
const CRITICAL_DRIFT_THRESHOLD = 0.05; // 5% — drift this large is always blocked

// ─── Timed Quote ────────────────────────────────────────────────────────────

export interface TimedQuote {
  /** When the quote was fetched from the API */
  timestamp: number;
  /** Quoted output amount (e.g. 0.6174 SOL) */
  outputAmount: number;
  /** Quoted output in USD */
  outputUsd: number;
  /** Fee charged */
  fee: number;
  /** Input amount */
  inputAmount: number;
  /** Input token */
  inputToken: string;
  /** Output token */
  outputToken: string;
}

// ─── Quote Freshness Check ──────────────────────────────────────────────────

export interface FreshnessResult {
  fresh: boolean;
  ageMs: number;
  reason?: string;
}

/**
 * Check if a quote is still fresh enough for execution.
 * Returns { fresh: false } with reason if expired.
 */
export function checkQuoteFreshness(quote: TimedQuote): FreshnessResult {
  const log = getLogger();
  const ageMs = Date.now() - quote.timestamp;

  if (ageMs > QUOTE_MAX_AGE_MS) {
    const reason = `Quote expired: ${(ageMs / 1000).toFixed(1)}s old (max ${QUOTE_MAX_AGE_MS / 1000}s). Fetch a new quote.`;
    log.warn('QUOTE', reason);
    return { fresh: false, ageMs, reason };
  }

  log.debug('QUOTE', `Quote age: ${ageMs}ms (max ${QUOTE_MAX_AGE_MS}ms) — fresh`);
  return { fresh: true, ageMs };
}

// ─── Price Drift Check ──────────────────────────────────────────────────────

export interface DriftResult {
  acceptable: boolean;
  driftPercent: number;
  reason?: string;
}

/**
 * Compare the quoted output against the actual build output.
 * Detects price movement between quote fetch and transaction build.
 *
 * @param quotedOutput  - Output amount from the preview quote
 * @param buildOutput   - Output amount from the build (with owner)
 * @param maxDriftPct   - Maximum acceptable drift (default 1%)
 */
export function checkPriceDrift(
  quotedOutput: number,
  buildOutput: number,
  maxDriftPct = PRICE_DRIFT_THRESHOLD,
): DriftResult {
  const log = getLogger();

  if (!Number.isFinite(quotedOutput) || quotedOutput <= 0) {
    return { acceptable: true, driftPercent: 0 }; // Can't compare — allow
  }
  if (!Number.isFinite(buildOutput) || buildOutput <= 0) {
    log.warn('QUOTE', 'Build returned no output amount — cannot check drift');
    return { acceptable: false, driftPercent: 100, reason: 'Build returned invalid output amount' };
  }

  // Drift = how much worse the build output is compared to the quote
  // Negative drift = build gives LESS than quoted (bad)
  // Positive drift = build gives MORE than quoted (good — price moved in our favor)
  const drift = (buildOutput - quotedOutput) / quotedOutput;
  const driftPercent = drift * 100;

  // Only block on NEGATIVE drift (price moved against us)
  if (drift < -CRITICAL_DRIFT_THRESHOLD) {
    const reason = `CRITICAL price drift: ${driftPercent.toFixed(2)}% (quoted ${quotedOutput}, got ${buildOutput}). Price moved significantly against you.`;
    log.error('QUOTE', reason);
    return { acceptable: false, driftPercent, reason };
  }

  if (drift < -maxDriftPct) {
    const reason = `Price drift ${driftPercent.toFixed(2)}% exceeds ${(maxDriftPct * 100).toFixed(1)}% threshold (quoted ${quotedOutput.toFixed(6)}, build ${buildOutput.toFixed(6)})`;
    log.warn('QUOTE', reason);
    return { acceptable: false, driftPercent, reason };
  }

  if (drift < 0) {
    log.debug('QUOTE', `Minor drift ${driftPercent.toFixed(3)}% — within tolerance`);
  } else {
    log.debug('QUOTE', `Favorable drift +${driftPercent.toFixed(3)}%`);
  }

  return { acceptable: true, driftPercent };
}

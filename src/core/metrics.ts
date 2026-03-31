/**
 * Lightweight Execution Metrics
 *
 * In-memory counters — zero disk I/O, zero performance impact.
 * Exposed via the 'health' command for operational visibility.
 */

export interface MetricsSnapshot {
  tradesAttempted: number;
  tradesSucceeded: number;
  tradesFailed: number;
  tradesBlocked: number;
  swapsAttempted: number;
  swapsSucceeded: number;
  avgExecutionMs: number;
  lastTradeAt: string | null;
  uptimeMs: number;
}

class ExecutionMetrics {
  private _tradesAttempted = 0;
  private _tradesSucceeded = 0;
  private _tradesFailed = 0;
  private _tradesBlocked = 0;
  private _swapsAttempted = 0;
  private _swapsSucceeded = 0;
  private _totalExecMs = 0;
  private _execCount = 0;
  private _lastTradeAt: Date | null = null;
  private _startedAt = Date.now();

  recordTradeAttempt(): void { this._tradesAttempted++; }
  recordTradeSuccess(durationMs: number): void {
    this._tradesSucceeded++;
    this._totalExecMs += durationMs;
    this._execCount++;
    this._lastTradeAt = new Date();
  }
  recordTradeFailed(): void { this._tradesFailed++; }
  recordTradeBlocked(): void { this._tradesBlocked++; }
  recordSwapAttempt(): void { this._swapsAttempted++; }
  recordSwapSuccess(durationMs: number): void {
    this._swapsSucceeded++;
    this._totalExecMs += durationMs;
    this._execCount++;
    this._lastTradeAt = new Date();
  }

  snapshot(): MetricsSnapshot {
    return {
      tradesAttempted: this._tradesAttempted,
      tradesSucceeded: this._tradesSucceeded,
      tradesFailed: this._tradesFailed,
      tradesBlocked: this._tradesBlocked,
      swapsAttempted: this._swapsAttempted,
      swapsSucceeded: this._swapsSucceeded,
      avgExecutionMs: this._execCount > 0 ? Math.round(this._totalExecMs / this._execCount) : 0,
      lastTradeAt: this._lastTradeAt?.toISOString() ?? null,
      uptimeMs: Date.now() - this._startedAt,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _metrics: ExecutionMetrics | null = null;

export function getMetrics(): ExecutionMetrics {
  if (!_metrics) _metrics = new ExecutionMetrics();
  return _metrics;
}

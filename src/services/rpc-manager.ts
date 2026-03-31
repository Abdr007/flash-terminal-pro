/**
 * Multi-RPC Manager — Production Resilience
 *
 * Manages multiple Solana RPC endpoints with:
 *   - Health monitoring (periodic slot checks)
 *   - Slot lag detection (>50 slots = unhealthy)
 *   - Automatic failover on failure
 *   - Cooldown before retrying failed endpoints
 *   - Connection pooling
 *
 * Used by TxPipeline and StateEngine for all RPC operations.
 */

import { Connection } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';
import type { FlashXConfig } from '../types/index.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const SLOT_LAG_THRESHOLD = 50;        // Slots behind = unhealthy
const HEALTH_CHECK_INTERVAL_MS = 30_000; // Check every 30s
const COOLDOWN_MS = 60_000;           // Wait 60s before retrying failed endpoint
const CONNECT_TIMEOUT_MS = 10_000;    // Timeout for slot checks

// ─── Endpoint State ─────────────────────────────────────────────────────────

interface EndpointState {
  url: string;
  connection: Connection;
  healthy: boolean;
  lastSlot: number;
  lastCheckMs: number;
  failedAt: number;       // 0 = never failed
  consecutiveFailures: number;
  latencyMs: number;      // rolling average latency
  latencySamples: number[];  // last N latency samples
}

// ─── RpcManager ─────────────────────────────────────────────────────────────

export class RpcManager {
  private endpoints: EndpointState[] = [];
  private _activeIndex = 0;
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _maxSlot = 0;

  constructor(config: FlashXConfig) {
    const log = getLogger();

    // Build endpoint list from config
    const urls: string[] = [config.rpcUrl];
    if (config.rpcBackupUrl) urls.push(config.rpcBackupUrl);

    // Parse additional RPC URLs from env (comma-separated)
    const extra = process.env['RPC_EXTRA_URLS'];
    if (extra) {
      for (const url of extra.split(',').map(u => u.trim()).filter(Boolean)) {
        if (!urls.includes(url)) urls.push(url);
      }
    }

    for (const url of urls) {
      const connection = new Connection(url, {
        commitment: 'confirmed',
        fetch: (fetchUrl: string | URL | Request, init?: RequestInit) =>
          fetch(fetchUrl, { ...init, signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) }),
      });

      this.endpoints.push({
        url,
        connection,
        healthy: true,
        lastSlot: 0,
        lastCheckMs: 0,
        failedAt: 0,
        consecutiveFailures: 0,
        latencyMs: 0,
        latencySamples: [],
      });
    }

    log.info('RPC', `Initialized with ${this.endpoints.length} endpoint(s)`);
  }

  // ─── Active Connection ────────────────────────────────────────────────

  /** Get the current active (healthiest) connection */
  get connection(): Connection {
    return this.endpoints[this._activeIndex].connection;
  }

  /** Get active endpoint URL (for display, scrubbed) */
  get activeUrl(): string {
    const url = this.endpoints[this._activeIndex].url;
    try { return new URL(url).origin; } catch { return url.slice(0, 40); }
  }

  /** Total endpoint count */
  get endpointCount(): number {
    return this.endpoints.length;
  }

  /** Count of healthy endpoints */
  get healthyCount(): number {
    return this.endpoints.filter(e => e.healthy).length;
  }

  // ─── Health Monitoring ────────────────────────────────────────────────

  /** Start periodic health checks */
  startHealthMonitor(): void {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => void this.checkAllHealth(), HEALTH_CHECK_INTERVAL_MS);
    // Unref so it doesn't prevent process exit
    if (this._healthTimer.unref) this._healthTimer.unref();
  }

  stopHealthMonitor(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  /** Check health of all endpoints */
  async checkAllHealth(): Promise<void> {
    const log = getLogger();
    const now = Date.now();

    for (const ep of this.endpoints) {
      // Skip endpoints in cooldown
      if (ep.failedAt > 0 && now - ep.failedAt < COOLDOWN_MS) continue;

      try {
        const t0 = Date.now();
        const slot = await ep.connection.getSlot('confirmed');
        const latency = Date.now() - t0;

        ep.lastSlot = slot;
        ep.lastCheckMs = now;
        ep.healthy = true;
        ep.consecutiveFailures = 0;
        ep.failedAt = 0;

        // Rolling latency average (keep last 10 samples)
        ep.latencySamples.push(latency);
        if (ep.latencySamples.length > 10) ep.latencySamples.shift();
        ep.latencyMs = Math.round(ep.latencySamples.reduce((a, b) => a + b, 0) / ep.latencySamples.length);

        if (slot > this._maxSlot) this._maxSlot = slot;
      } catch {
        ep.consecutiveFailures++;
        ep.healthy = false;
        ep.failedAt = now;
        log.warn('RPC', `Endpoint ${this.scrubUrl(ep.url)} failed (${ep.consecutiveFailures}x)`);
      }
    }

    // Detect slot lag
    for (const ep of this.endpoints) {
      if (ep.healthy && this._maxSlot > 0 && ep.lastSlot > 0) {
        const lag = this._maxSlot - ep.lastSlot;
        if (lag > SLOT_LAG_THRESHOLD) {
          log.warn('RPC', `Endpoint ${this.scrubUrl(ep.url)} lagging ${lag} slots`);
          ep.healthy = false;
        }
      }
    }

    // Failover to best healthy endpoint
    this.selectBestEndpoint();
  }

  // ─── Failover ─────────────────────────────────────────────────────────

  /** Select the healthiest endpoint (highest slot, then lowest latency) */
  private selectBestEndpoint(): void {
    const log = getLogger();
    let bestIdx = this._activeIndex;
    let bestSlot = 0;
    let bestLatency = Infinity;

    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      if (!ep.healthy) continue;
      // Prefer highest slot; tie-break on lowest latency
      if (ep.lastSlot > bestSlot || (ep.lastSlot === bestSlot && ep.latencyMs < bestLatency)) {
        bestSlot = ep.lastSlot;
        bestLatency = ep.latencyMs;
        bestIdx = i;
      }
    }

    if (bestIdx !== this._activeIndex) {
      log.info('RPC', `Failover: ${this.scrubUrl(this.endpoints[this._activeIndex].url)} → ${this.scrubUrl(this.endpoints[bestIdx].url)}`);
      this._activeIndex = bestIdx;
    }
  }

  /**
   * Report a failure on the active endpoint.
   * Called by TxPipeline when an RPC call fails.
   * Triggers immediate failover if another healthy endpoint exists.
   */
  reportFailure(): void {
    const log = getLogger();
    const ep = this.endpoints[this._activeIndex];
    ep.consecutiveFailures++;
    ep.failedAt = Date.now();

    if (ep.consecutiveFailures >= 3) {
      ep.healthy = false;
      log.warn('RPC', `Endpoint marked unhealthy after ${ep.consecutiveFailures} failures`);
    }

    // Try to failover
    for (let i = 0; i < this.endpoints.length; i++) {
      if (i !== this._activeIndex && this.endpoints[i].healthy) {
        log.info('RPC', `Failover to ${this.scrubUrl(this.endpoints[i].url)}`);
        this._activeIndex = i;
        return;
      }
    }

    log.error('RPC', 'No healthy endpoints available — all RPCs degraded');
  }

  /** Report success — reset failure counter on active endpoint */
  reportSuccess(): void {
    const ep = this.endpoints[this._activeIndex];
    ep.consecutiveFailures = 0;
    ep.healthy = true;
    ep.failedAt = 0;
  }

  /** Get health summary for display */
  getHealthSummary(): { url: string; healthy: boolean; slot: number; lag: number; latencyMs: number; active: boolean }[] {
    return this.endpoints.map((ep, i) => ({
      url: this.scrubUrl(ep.url),
      healthy: ep.healthy,
      slot: ep.lastSlot,
      lag: this._maxSlot > 0 ? this._maxSlot - ep.lastSlot : 0,
      latencyMs: ep.latencyMs,
      active: i === this._activeIndex,
    }));
  }

  private scrubUrl(url: string): string {
    try { return new URL(url).origin; } catch { return url.slice(0, 30); }
  }
}

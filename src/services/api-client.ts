/**
 * Flash Trade REST API Client
 *
 * Typed HTTP client for https://flashapi.trade
 * Handles all read operations and transaction building.
 *
 * Phase 1: Interface + stubs
 * Phase 2: Full implementation with retry, rate limiting, timeout
 */

import type { IApiClient, ApiQuote, FlashXConfig } from '../types/index.js';
import { scrubError } from '../utils/format.js';

// ─── API Response Types ─────────────────────────────────────────────────────

export interface ApiHealthResponse {
  status: string;
  accounts?: {
    perpetuals: number;
    pools: number;
    custodies: number;
    markets: number;
    positions: number;
    orders: number;
  };
}

export interface ApiPriceResponse {
  price: number;
  exponent: number;
  confidence: number;
  priceUi: number;
  timestampUs: number;
  marketSession: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class FlashApiClient implements IApiClient {
  private baseUrl: string;
  private timeoutMs = 15_000;
  private maxResponseBytes = 2 * 1024 * 1024; // 2MB

  constructor(config: FlashXConfig) {
    this.baseUrl = config.flashApiUrl.replace(/\/$/, '');
  }

  // ─── Internal Fetch ───────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`API ${res.status}: ${res.statusText}`);
      }

      // Body size check
      const contentLength = res.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > this.maxResponseBytes) {
        throw new Error(`Response too large: ${contentLength} bytes`);
      }

      return await res.json() as T;
    } catch (e) {
      throw new Error(`API GET ${path} failed: ${scrubError(String(e))}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Flash API returns 200 even on errors — always check `err` field
      return await res.json() as T;
    } catch (e) {
      throw new Error(`API POST ${path} failed: ${scrubError(String(e))}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Read Endpoints ───────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    return this.get<ApiHealthResponse>('/health');
  }

  async getMarkets(): Promise<unknown[]> {
    return this.get<unknown[]>('/markets');
  }

  async getPrices(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>('/prices');
  }

  async getPrice(symbol: string): Promise<unknown> {
    return this.get<unknown>(`/prices/${encodeURIComponent(symbol)}`);
  }

  async getPositions(owner: string): Promise<unknown[]> {
    return this.get<unknown[]>(`/positions/owner/${encodeURIComponent(owner)}?includePnlInLeverageDisplay=true`);
  }

  async getOrders(owner: string): Promise<unknown[]> {
    return this.get<unknown[]>(`/orders/owner/${encodeURIComponent(owner)}`);
  }

  async getPoolData(poolPubkey?: string): Promise<unknown> {
    const path = poolPubkey ? `/pool-data/${encodeURIComponent(poolPubkey)}` : '/pool-data';
    return this.get<unknown>(path);
  }

  // ─── Transaction Builders ─────────────────────────────────────────────

  async buildOpenPosition(params: Record<string, unknown>): Promise<ApiQuote> {
    return this.post<ApiQuote>('/transaction-builder/open-position', params);
  }

  async buildClosePosition(params: Record<string, unknown>): Promise<unknown> {
    return this.post<unknown>('/transaction-builder/close-position', params);
  }

  async buildAddCollateral(params: Record<string, unknown>): Promise<unknown> {
    return this.post<unknown>('/transaction-builder/add-collateral', params);
  }

  async buildRemoveCollateral(params: Record<string, unknown>): Promise<unknown> {
    return this.post<unknown>('/transaction-builder/remove-collateral', params);
  }

  async buildReversePosition(params: Record<string, unknown>): Promise<unknown> {
    return this.post<unknown>('/transaction-builder/reverse-position', params);
  }
}

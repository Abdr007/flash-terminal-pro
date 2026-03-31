/**
 * StateEngine
 *
 * Centralized state management with TTL caching.
 * Fetches real data from Flash API and wallet.
 * Falls back to cached data on failure.
 */

import {
  Side,
  type IStateEngine,
  type Position,
  type Market,
  type Pool,
} from '../types/index.js';
import type { FlashApiClient } from '../services/api-client.js';
import type { WalletManager } from '../wallet/manager.js';
import { getLogger } from '../utils/logger.js';
import { resolvePool as resolvePoolFn } from '../services/pool-resolver.js';

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  data: T;
  expiry: number;
}

class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private ttlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiry) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data;
  }

  set(key: string, data: T): void {
    if (this.store.size >= 500) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { data, expiry: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── StateEngine ────────────────────────────────────────────────────────────

export class StateEngine implements IStateEngine {
  private positionCache = new TTLCache<Position[]>(10_000);
  private priceCache = new TTLCache<number>(5_000);
  private marketCache = new TTLCache<Market[]>(30_000);
  private poolCache = new TTLCache<Pool[]>(60_000);
  private balanceCache = new TTLCache<number>(15_000);

  private api: FlashApiClient | null = null;
  private wallet: WalletManager | null = null;

  /** Inject real API client (called during bootstrap) */
  setApiClient(api: FlashApiClient): void {
    this.api = api;
  }

  /** Inject wallet manager (called during bootstrap) */
  setWallet(wallet: WalletManager): void {
    this.wallet = wallet;
  }

  // ─── Positions ──────────────────────────────────────────────────────

  async getPositions(): Promise<Position[]> {
    const cached = this.positionCache.get('all');
    if (cached) return cached;

    if (!this.api || !this.wallet?.publicKey) return [];

    const log = getLogger();
    try {
      const raw = await this.api.getPositions(this.wallet.publicKey.toBase58()) as Record<string, unknown>[];
      const positions = raw.map(p => this.mapPosition(p)).filter((p): p is Position => p !== null);
      this.positionCache.set('all', positions);
      log.debug('STATE', `Fetched ${positions.length} positions`);
      return positions;
    } catch (e) {
      log.warn('STATE', `Position fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  async getPosition(market: string, side?: Side): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find(p => p.market === market && (!side || p.side === side)) ?? null;
  }

  private mapPosition(raw: Record<string, unknown>): Position | null {
    try {
      // Flash API enriched position format (verified field names from /positions/owner/)
      const r = raw as Record<string, unknown>;
      const sideStr = String(r['sideUi'] ?? r['side'] ?? 'Long');

      // Get mark price from API price data or entry price as fallback
      const entryPrice = Number(r['entryPriceUi'] ?? r['entryPrice'] ?? 0);

      return {
        pubkey: String(r['key'] ?? r['pubkey'] ?? r['positionKey'] ?? ''),
        market: String(r['marketSymbol'] ?? ''),
        side: sideStr.toLowerCase() === 'short' ? Side.Short : Side.Long,
        leverage: Number(r['leverageUi'] ?? r['leverage'] ?? 0),
        sizeUsd: Number(r['sizeUsdUi'] ?? r['sizeUsd'] ?? 0),
        collateralUsd: Number(r['collateralUsdUi'] ?? r['collateralUsd'] ?? 0),
        entryPrice,
        markPrice: entryPrice, // Will be updated by price feed
        liquidationPrice: Number(r['liquidationPriceUi'] ?? r['liquidationPrice'] ?? 0),
        pnl: Number(r['pnlWithFeeUsdUi'] ?? r['pnlUsd'] ?? 0),
        pnlPercent: Number(r['pnlPercentageWithFee'] ?? r['pnlPercent'] ?? 0),
        fees: 0,
        fundingRate: 0,
        openTime: 0,
        pool: String(r['pool'] ?? r['poolName'] ?? ''),
      };
    } catch {
      return null;
    }
  }

  // ─── Markets ──────────────────────────────────────────────────────────

  async getMarkets(): Promise<Market[]> {
    const cached = this.marketCache.get('all');
    if (cached) return cached;

    if (!this.api) return this.defaultMarkets();

    const log = getLogger();
    try {
      // Try fetching real prices to enrich market data
      const priceData = await this.api.getPrices() as Record<string, Record<string, unknown>>;
      const markets = this.buildMarketsFromPrices(priceData);
      if (markets.length > 0) {
        this.marketCache.set('all', markets);
        log.debug('STATE', `Fetched ${markets.length} markets with live prices`);
        return markets;
      }
    } catch (e) {
      log.debug('STATE', `Market fetch failed, using defaults: ${e instanceof Error ? e.message : String(e)}`);
    }

    const defaults = this.defaultMarkets();
    this.marketCache.set('all', defaults);
    return defaults;
  }

  async getMarket(symbol: string): Promise<Market | null> {
    const markets = await this.getMarkets();
    return markets.find(m => m.symbol === symbol) ?? null;
  }

  private buildMarketsFromPrices(priceData: Record<string, Record<string, unknown>>): Market[] {
    const markets: Market[] = [];

    for (const [symbol, data] of Object.entries(priceData)) {
      const pool = resolvePoolFn(symbol);
      if (!pool) continue;

      markets.push({
        symbol,
        pool,
        price: Number(data['priceUi'] ?? data['price'] ?? 0),
        change24h: 0, // Not available from /prices
        oiLong: 0,
        oiShort: 0,
        maxLeverage: this.getMaxLeverage(pool),
        maxDegenLeverage: this.getMaxDegenLeverage(pool),
        fundingRate: 0,
        isOpen: String(data['marketSession'] ?? 'open').toLowerCase() !== 'closed',
      });
    }
    return markets;
  }

  private getMaxLeverage(pool: string): number {
    switch (pool) {
      case 'Crypto.1': return 100;
      case 'Virtual.1': return 100;
      case 'Governance.1': return 50;
      case 'Community.1': case 'Community.2': case 'Trump.1': return 25;
      case 'Equity.1': return 20;
      case 'Ore.1': return 5;
      default: return 50;
    }
  }

  private getMaxDegenLeverage(pool: string): number {
    switch (pool) {
      case 'Crypto.1': return 500;
      case 'Virtual.1': return 200;
      case 'Governance.1': return 100;
      default: return this.getMaxLeverage(pool);
    }
  }

  private defaultMarkets(): Market[] {
    return [
      { symbol: 'SOL', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'BTC', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'ETH', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'XAU', pool: 'Virtual.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 200, fundingRate: 0, isOpen: true },
      { symbol: 'EUR', pool: 'Virtual.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 200, fundingRate: 0, isOpen: true },
      { symbol: 'JUP', pool: 'Governance.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 50, maxDegenLeverage: 100, fundingRate: 0, isOpen: true },
      { symbol: 'BONK', pool: 'Community.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 25, maxDegenLeverage: 50, fundingRate: 0, isOpen: true },
      { symbol: 'SPY', pool: 'Equity.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 20, maxDegenLeverage: 20, fundingRate: 0, isOpen: false },
    ];
  }

  // ─── Pools ────────────────────────────────────────────────────────────

  async getPools(): Promise<Pool[]> {
    const cached = this.poolCache.get('all');
    if (cached) return cached;

    if (!this.api) return this.defaultPools();

    const log = getLogger();
    try {
      const raw = await this.api.getPoolData() as Record<string, unknown>[];
      if (Array.isArray(raw) && raw.length > 0) {
        const pools = raw.map(p => this.mapPool(p)).filter((p): p is Pool => p !== null);
        if (pools.length > 0) {
          this.poolCache.set('all', pools);
          log.debug('STATE', `Fetched ${pools.length} pools`);
          return pools;
        }
      }
    } catch (e) {
      log.debug('STATE', `Pool fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const defaults = this.defaultPools();
    this.poolCache.set('all', defaults);
    return defaults;
  }

  private mapPool(raw: Record<string, unknown>): Pool | null {
    try {
      return {
        name: String(raw['poolName'] ?? ''),
        address: String(raw['poolAddress'] ?? raw['pubkey'] ?? ''),
        tvl: Number(raw['totalPoolValueUsd'] ?? raw['tvl'] ?? 0),
        assets: Array.isArray(raw['assets']) ? raw['assets'] as string[] : [],
        markets: Number(raw['markets'] ?? 0),
        utilization: Number(raw['utilization'] ?? 0),
        lpPrice: Number(raw['lpPrice'] ?? 0),
        sflpPrice: Number(raw['sflpPrice'] ?? 0),
        flpPrice: Number(raw['flpPrice'] ?? raw['lpPrice'] ?? 0),
      };
    } catch {
      return null;
    }
  }

  private defaultPools(): Pool[] {
    return [
      { name: 'Crypto.1', address: 'HfF7GCcEc76xubFCHLLXRdYcgRzwjEPdfKWqzRS8Ncog', tvl: 0, assets: ['USDC', 'SOL', 'BTC', 'ETH'], markets: 11, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Virtual.1', address: 'KwhpybQPe9xuZFmAfcjLHj3ukownWex1ratyascAC1X', tvl: 0, assets: ['USDC', 'XAU', 'XAG', 'EUR', 'GBP'], markets: 14, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Governance.1', address: 'D6bfytnxoZBSzJM7fcixg5sgWJ2hj8SbwkPvb2r8XpbH', tvl: 0, assets: ['USDC', 'JUP', 'PYTH', 'JTO', 'RAY'], markets: 14, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Community.1', address: '6HukhSeVVLQekKaGJYkwztBacjhKLKywVPrmcvccaYMz', tvl: 0, assets: ['USDC', 'BONK', 'PENGU', 'PUMP'], markets: 6, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Equity.1', address: 'Fa64Ua4bzN295egkQEqtyrWNeQMiFZ5Uxfq2DcQ4Sb3h', tvl: 0, assets: ['USDC', 'SPY', 'NVDA', 'TSLA', 'AAPL'], markets: 12, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
    ];
  }

  // ─── Prices ───────────────────────────────────────────────────────────

  async getPrice(symbol: string): Promise<number> {
    const cached = this.priceCache.get(symbol);
    if (cached !== undefined) return cached;

    if (!this.api) return 0;

    try {
      const data = await this.api.getPrice(symbol) as Record<string, unknown>;
      const price = Number(data['priceUi'] ?? data['price'] ?? 0);
      if (Number.isFinite(price) && price > 0) {
        this.priceCache.set(symbol, price);
        return price;
      }
    } catch {
      // Silently return 0
    }
    return 0;
  }

  // ─── Balance ──────────────────────────────────────────────────────────

  async getBalance(token?: string): Promise<number> {
    const key = token ?? 'SOL';
    const cached = this.balanceCache.get(key);
    if (cached !== undefined) return cached;

    if (!this.wallet) return 0;

    try {
      const balance = await this.wallet.getBalance(token);
      this.balanceCache.set(key, balance);
      return balance;
    } catch {
      return 0;
    }
  }

  async refresh(): Promise<void> {
    this.positionCache.clear();
    this.priceCache.clear();
    this.marketCache.clear();
    this.poolCache.clear();
    this.balanceCache.clear();
  }
}

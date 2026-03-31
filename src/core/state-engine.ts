/**
 * StateEngine
 *
 * Centralized state management with caching.
 * Holds positions, prices, balances, markets — all with TTL-based expiry.
 *
 * In Phase 1 this returns mock data. Phase 2+ connects to real API/SDK/RPC.
 */

import {
  Side,
  type IStateEngine,
  type Position,
  type Market,
  type Pool,
} from '../types/index.js';

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
    // Bound cache size
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
  private positionCache = new TTLCache<Position[]>(10_000);  // 10s
  private priceCache = new TTLCache<number>(5_000);           // 5s
  private marketCache = new TTLCache<Market[]>(30_000);       // 30s
  private poolCache = new TTLCache<Pool[]>(60_000);           // 60s
  private balanceCache = new TTLCache<number>(15_000);        // 15s

  // Will be injected in Phase 2
  // private apiClient: IApiClient;
  // private sdkClient: ISdkClient;

  async getPositions(): Promise<Position[]> {
    const cached = this.positionCache.get('all');
    if (cached) return cached;

    // Phase 1: return empty — no wallet connected
    const positions: Position[] = [];
    this.positionCache.set('all', positions);
    return positions;
  }

  async getPosition(market: string, side?: Side): Promise<Position | null> {
    const positions = await this.getPositions();
    return positions.find(p =>
      p.market === market && (!side || p.side === side)
    ) ?? null;
  }

  async getMarkets(): Promise<Market[]> {
    const cached = this.marketCache.get('all');
    if (cached) return cached;

    // Phase 1: stub markets from known Flash Trade pools
    const markets: Market[] = [
      { symbol: 'SOL', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'BTC', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'ETH', pool: 'Crypto.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 500, fundingRate: 0, isOpen: true },
      { symbol: 'XAU', pool: 'Virtual.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 200, fundingRate: 0, isOpen: true },
      { symbol: 'EUR', pool: 'Virtual.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 100, maxDegenLeverage: 200, fundingRate: 0, isOpen: true },
      { symbol: 'JUP', pool: 'Governance.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 50, maxDegenLeverage: 100, fundingRate: 0, isOpen: true },
      { symbol: 'BONK', pool: 'Community.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 25, maxDegenLeverage: 50, fundingRate: 0, isOpen: true },
      { symbol: 'SPY', pool: 'Equity.1', price: 0, change24h: 0, oiLong: 0, oiShort: 0, maxLeverage: 20, maxDegenLeverage: 20, fundingRate: 0, isOpen: false },
    ];
    this.marketCache.set('all', markets);
    return markets;
  }

  async getMarket(symbol: string): Promise<Market | null> {
    const markets = await this.getMarkets();
    return markets.find(m => m.symbol === symbol) ?? null;
  }

  async getPools(): Promise<Pool[]> {
    const cached = this.poolCache.get('all');
    if (cached) return cached;

    const pools: Pool[] = [
      { name: 'Crypto.1', address: 'HfF7GCcEc76xubFCHLLXRdYcgRzwjEPdfKWqzRS8Ncog', tvl: 0, assets: ['USDC', 'SOL', 'BTC', 'ETH'], markets: 11, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Virtual.1', address: 'KwhpybQPe9xuZFmAfcjLHj3ukownWex1ratyascAC1X', tvl: 0, assets: ['USDC', 'XAU', 'XAG', 'EUR', 'GBP'], markets: 14, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Governance.1', address: 'D6bfytnxoZBSzJM7fcixg5sgWJ2hj8SbwkPvb2r8XpbH', tvl: 0, assets: ['USDC', 'JUP', 'PYTH', 'JTO', 'RAY'], markets: 14, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Community.1', address: '6HukhSeVVLQekKaGJYkwztBacjhKLKywVPrmcvccaYMz', tvl: 0, assets: ['USDC', 'BONK', 'PENGU', 'PUMP'], markets: 6, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
      { name: 'Equity.1', address: 'Fa64Ua4bzN295egkQEqtyrWNeQMiFZ5Uxfq2DcQ4Sb3h', tvl: 0, assets: ['USDC', 'SPY', 'NVDA', 'TSLA', 'AAPL'], markets: 12, utilization: 0, lpPrice: 0, sflpPrice: 0, flpPrice: 0 },
    ];
    this.poolCache.set('all', pools);
    return pools;
  }

  async getPrice(symbol: string): Promise<number> {
    const cached = this.priceCache.get(symbol);
    if (cached !== undefined) return cached;

    // Phase 1: return 0 — will be filled by API in Phase 2
    return 0;
  }

  async getBalance(_token?: string): Promise<number> {
    const cached = this.balanceCache.get(_token ?? 'SOL');
    if (cached !== undefined) return cached;
    return 0;
  }

  async refresh(): Promise<void> {
    this.positionCache.clear();
    this.priceCache.clear();
    this.marketCache.clear();
    this.poolCache.clear();
    this.balanceCache.clear();
  }
}

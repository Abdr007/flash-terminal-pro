/**
 * Pool Resolver
 *
 * Maps market symbols to their Flash Trade pool.
 * Uses PoolConfig from flash-sdk for authoritative pool data.
 *
 * Each market exists in exactly one pool.
 * Markets are per-side: SOL-Long and SOL-Short are different market accounts.
 */

// ─── Static Pool → Market Mapping ───────────────────────────────────────────
// Derived from flash-sdk PoolConfig.json (verified against real protocol)

const MARKET_TO_POOL: Record<string, string> = {
  // Crypto.1
  SOL: 'Crypto.1', BTC: 'Crypto.1', ETH: 'Crypto.1',
  ZEC: 'Crypto.1', BNB: 'Crypto.1', JitoSOL: 'Crypto.1',

  // Virtual.1 (Forex + Commodities)
  XAU: 'Virtual.1', XAG: 'Virtual.1', EUR: 'Virtual.1',
  GBP: 'Virtual.1', CRUDEOIL: 'Virtual.1', USDJPY: 'Virtual.1',
  USDCNH: 'Virtual.1', NATGAS: 'Virtual.1',

  // Governance.1
  JUP: 'Governance.1', PYTH: 'Governance.1', JTO: 'Governance.1',
  RAY: 'Governance.1', KMNO: 'Governance.1', MET: 'Governance.1',
  HYPE: 'Governance.1',

  // Community.1
  BONK: 'Community.1', PENGU: 'Community.1', PUMP: 'Community.1',

  // Community.2
  WIF: 'Community.2',

  // Trump.1
  FARTCOIN: 'Trump.1',

  // Ore.1
  ORE: 'Ore.1',

  // Equity.1
  SPY: 'Equity.1', NVDA: 'Equity.1', TSLA: 'Equity.1',
  AAPL: 'Equity.1', AMD: 'Equity.1', AMZN: 'Equity.1',
};

// Pool addresses (mainnet)
const POOL_ADDRESSES: Record<string, string> = {
  'Crypto.1': 'HfF7GCcEc76xubFCHLLXRdYcgRzwjEPdfKWqzRS8Ncog',
  'Virtual.1': 'KwhpybQPe9xuZFmAfcjLHj3ukownWex1ratyascAC1X',
  'Governance.1': 'D6bfytnxoZBSzJM7fcixg5sgWJ2hj8SbwkPvb2r8XpbH',
  'Community.1': '6HukhSeVVLQekKaGJYkwztBacjhKLKywVPrmcvccaYMz',
  'Community.2': 'DP1FnZjWzDjSMQA64BcMzUdpDpyAQ6723d5fpX4yTk5G',
  'Trump.1': 'Crk3yzGpPCt9thXmV9wCkBM9nBq8EHhBct71ArkKY9wA',
  'Ore.1': 'B2FWYRHJpDe8T9CeWz7JR2MLqfvxKxa6oRwJLZF62FW9',
  'Remora.1': 'AKqWYgwiM198BsvuSqWQs1x5FSVRJfo8MNABEQjzsDJk',
  'Equity.1': 'Fa64Ua4bzN295egkQEqtyrWNeQMiFZ5Uxfq2DcQ4Sb3h',
};

// Collateral rules: Longs use native asset, Shorts use USDC
// Exception: virtual/synthetic markets always use USDC
const USDC_ONLY_POOLS = new Set(['Virtual.1', 'Equity.1']);

/**
 * Resolve market symbol to its pool name.
 * Returns undefined if market not found.
 */
export function resolvePool(market: string): string | undefined {
  return MARKET_TO_POOL[market];
}

/**
 * Get pool on-chain address.
 */
export function getPoolAddress(poolName: string): string | undefined {
  return POOL_ADDRESSES[poolName];
}

/**
 * Determine the collateral token for a given market and side.
 *
 * Protocol rules:
 *   - Longs: collateral = native asset (SOL for SOL-Long)
 *   - Shorts: collateral = USDC
 *   - Virtual/Equity pools: always USDC
 */
export function resolveCollateralToken(market: string, side: 'LONG' | 'SHORT'): string {
  const pool = resolvePool(market);

  // Virtual and equity pools always use USDC
  if (pool && USDC_ONLY_POOLS.has(pool)) return 'USDC';

  // Shorts always use USDC
  if (side === 'SHORT') return 'USDC';

  // Longs use the native asset
  return market;
}

/**
 * Get all known market symbols.
 */
export function getAllMarkets(): string[] {
  return Object.keys(MARKET_TO_POOL);
}

/**
 * Get all markets in a specific pool.
 */
export function getMarketsForPool(poolName: string): string[] {
  return Object.entries(MARKET_TO_POOL)
    .filter(([, pool]) => pool === poolName)
    .map(([market]) => market);
}

// ─── Swap Pool Resolution ───────────────────────────────────────────────────

// Tokens available in each pool for swapping
// USDC is the common token — most swaps route through USDC
const POOL_TOKENS: Record<string, string[]> = {
  'Crypto.1': ['USDC', 'SOL', 'WSOL', 'BTC', 'ETH', 'JitoSOL', 'ZEC', 'BNB'],
  'Virtual.1': ['USDC', 'XAUt'],  // Virtual assets can't be swapped, only USDC↔XAUt
  'Governance.1': ['USDC', 'JUP', 'JTO', 'RAY'],  // Only non-virtual tokens
  'Community.1': ['USDC', 'BONK', 'PENGU', 'PUMP'],
  'Community.2': ['USDC', 'WIF'],
  'Trump.1': ['USDC', 'FARTCOIN'],
  'Ore.1': ['USDC', 'ORE'],
  'Equity.1': ['USDC'],  // Equities are virtual — no token swaps
};

/**
 * Find a pool that contains both input and output tokens.
 * Returns the pool name or undefined if no pool has both.
 *
 * Flash swaps happen within a single pool — both tokens must
 * exist as custodies in the same pool.
 */
export function resolveSwapPool(inputToken: string, outputToken: string): string | undefined {
  for (const [poolName, tokens] of Object.entries(POOL_TOKENS)) {
    if (tokens.includes(inputToken) && tokens.includes(outputToken)) {
      return poolName;
    }
  }
  return undefined;
}

/**
 * Check if a swap is possible between two tokens.
 */
export function isSwapSupported(inputToken: string, outputToken: string): boolean {
  return resolveSwapPool(inputToken, outputToken) !== undefined;
}

/**
 * Get all tokens available for swapping in any pool.
 */
export function getSwappableTokens(): string[] {
  const tokens = new Set<string>();
  for (const poolTokens of Object.values(POOL_TOKENS)) {
    for (const t of poolTokens) tokens.add(t);
  }
  return [...tokens];
}

/**
 * Pool Registry
 *
 * Static metadata for all Flash Trade liquidity pools.
 * Matches flash-terminal's pool-registry.ts exactly.
 */

export interface PoolInfo {
  poolId: string;
  displayName: string;
  aliases: string[];
  flpSymbol: string;
  sflpSymbol: string;
  assets: string[];
  feeShare: number;  // 0.7 = 70%
}

const POOLS: PoolInfo[] = [
  {
    poolId: 'Crypto.1',
    displayName: 'Crypto Pool',
    aliases: ['crypto', 'main', 'bluechip', 'crypto.1'],
    flpSymbol: 'FLP.1', sflpSymbol: 'sFLP.1',
    assets: ['BTC', 'SOL', 'ETH', 'JitoSOL'],
    feeShare: 0.70,
  },
  {
    poolId: 'Virtual.1',
    displayName: 'Gold Pool',
    aliases: ['gold', 'virtual', 'forex', 'commodities', 'virtual.1'],
    flpSymbol: 'FLP.2', sflpSymbol: 'sFLP.2',
    assets: ['XAU', 'XAG', 'EUR', 'GBP', 'CRUDEOIL'],
    feeShare: 0.70,
  },
  {
    poolId: 'Governance.1',
    displayName: 'DeFi Pool',
    aliases: ['defi', 'governance', 'gov', 'governance.1'],
    flpSymbol: 'FLP.3', sflpSymbol: 'sFLP.3',
    assets: ['JUP', 'JTO', 'RAY', 'PYTH', 'KMNO'],
    feeShare: 0.70,
  },
  {
    poolId: 'Community.1',
    displayName: 'Meme Pool',
    aliases: ['meme', 'community', 'community.1'],
    flpSymbol: 'FLP.4', sflpSymbol: 'sFLP.4',
    assets: ['BONK', 'PENGU', 'PUMP'],
    feeShare: 0.80,
  },
  {
    poolId: 'Community.2',
    displayName: 'WIF Pool',
    aliases: ['wif', 'community.2'],
    flpSymbol: 'FLP.5', sflpSymbol: 'sFLP.5',
    assets: ['WIF'],
    feeShare: 0.80,
  },
  {
    poolId: 'Ore.1',
    displayName: 'Ore Pool',
    aliases: ['ore', 'ore.1'],
    flpSymbol: 'FLP.ore', sflpSymbol: 'sFLP.ore',
    assets: ['ORE'],
    feeShare: 0.90,
  },
  {
    poolId: 'Trump.1',
    displayName: 'FART Pool',
    aliases: ['fart', 'fartcoin', 'trump', 'trump.1'],
    flpSymbol: 'FLP.trump', sflpSymbol: 'sFLP.trump',
    assets: ['FARTCOIN'],
    feeShare: 0.80,
  },
  {
    poolId: 'Equity.1',
    displayName: 'Equity Pool',
    aliases: ['equity', 'stocks', 'equity.1'],
    flpSymbol: 'FLP.eq', sflpSymbol: 'sFLP.eq',
    assets: ['SPY', 'NVDA', 'TSLA', 'AAPL', 'AMD', 'AMZN'],
    feeShare: 0.80,
  },
  {
    poolId: 'Remora.1',
    displayName: 'Remora Pool',
    aliases: ['remora', 'remora.1'],
    flpSymbol: 'FLP.rem', sflpSymbol: 'sFLP.rem',
    assets: ['USDC'],
    feeShare: 0.70,
  },
];

export function getPoolRegistry(): PoolInfo[] {
  return POOLS;
}

export function resolveEarnPool(alias: string): PoolInfo | undefined {
  const lower = alias.toLowerCase().trim();
  return POOLS.find(p =>
    p.aliases.includes(lower) ||
    p.poolId.toLowerCase() === lower ||
    p.displayName.toLowerCase() === lower
  );
}

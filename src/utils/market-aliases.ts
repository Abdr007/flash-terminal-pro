/**
 * Asset alias normalization
 *
 * Maps user-friendly names → canonical Flash Trade symbols.
 * All 65+ markets across 9 pools.
 */

const ALIASES: Record<string, string> = {
  // Crypto (Crypto.1)
  bitcoin: 'BTC', btc: 'BTC',
  ethereum: 'ETH', eth: 'ETH',
  solana: 'SOL', sol: 'SOL',
  bnb: 'BNB', binance: 'BNB',
  zec: 'ZEC', zcash: 'ZEC',
  jitosol: 'JitoSOL',

  // Governance (Governance.1)
  jupiter: 'JUP', jup: 'JUP',
  jito: 'JTO', jto: 'JTO',
  raydium: 'RAY', ray: 'RAY',
  pyth: 'PYTH',
  kmno: 'KMNO', kamino: 'KMNO',
  met: 'MET', metaplex: 'MET',
  hype: 'HYPE',

  // Community (Community.1/2)
  bonk: 'BONK',
  wif: 'WIF', dogwifhat: 'WIF',
  pengu: 'PENGU', pudgy: 'PENGU',
  pump: 'PUMP',
  fartcoin: 'FARTCOIN', fart: 'FARTCOIN',

  // Forex (Virtual.1)
  euro: 'EUR', eur: 'EUR',
  pound: 'GBP', gbp: 'GBP', sterling: 'GBP',
  yen: 'USDJPY', usdjpy: 'USDJPY',
  yuan: 'USDCNH', usdcnh: 'USDCNH', cnh: 'USDCNH',

  // Commodities (Virtual.1)
  gold: 'XAU', xau: 'XAU',
  silver: 'XAG', xag: 'XAG',
  oil: 'CRUDEOIL', crude: 'CRUDEOIL', crudeoil: 'CRUDEOIL',
  natgas: 'NATGAS', gas: 'NATGAS',

  // Equities (Equity.1)
  spy: 'SPY', sp500: 'SPY',
  nvidia: 'NVDA', nvda: 'NVDA',
  tesla: 'TSLA', tsla: 'TSLA',
  apple: 'AAPL', aapl: 'AAPL',
  amd: 'AMD',
  amazon: 'AMZN', amzn: 'AMZN',

  // Ore (Ore.1)
  ore: 'ORE',

  // Stablecoins (not tradeable but used for collateral/swap)
  usdc: 'USDC', usd: 'USDC',
  xaut: 'XAUt',
};

/**
 * Normalize an asset identifier to its canonical symbol.
 * Returns uppercase input if no alias found.
 */
export function normalizeAsset(input: string): string {
  const lower = input.toLowerCase().trim();
  return ALIASES[lower] ?? input.toUpperCase();
}

/**
 * Check if a string looks like a market/asset identifier.
 */
export function isMarketLike(input: string): boolean {
  const lower = input.toLowerCase().trim();
  return lower in ALIASES || /^[A-Za-z]{2,12}$/.test(input.trim());
}

/** Get all known symbols */
export function getAllSymbols(): string[] {
  return [...new Set(Object.values(ALIASES))];
}

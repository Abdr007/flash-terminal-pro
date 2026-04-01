/**
 * Layer 1: Regex Parser
 *
 * Deterministic pattern matching for all command formats.
 * Each pattern returns a fully structured ParsedCommand or null.
 *
 * Handles:
 *   "long sol 10x 100"
 *   "open SOL LONG 10x $100 --tp 200 --sl 170"
 *   "close sol"
 *   "swap 1 sol to usdc"
 *   "deposit 500 usdc into crypto.1"
 */

import {
  Action,
  Side,
  ParseSource,
  LpMode,
  type ParsedCommand,
  type CommandParams,
} from '../types/index.js';
import { normalizeAsset } from '../utils/market-aliases.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseSide(raw: string): Side | undefined {
  const l = raw.toLowerCase();
  if (l === 'long' || l === 'buy') return Side.Long;
  if (l === 'short' || l === 'sell') return Side.Short;
  return undefined;
}

function extractFlags(input: string): { clean: string; flags: CommandParams } {
  const flags: CommandParams = {};

  // --tp <price>
  const tpMatch = input.match(/--tp\s+\$?(\d+(?:\.\d+)?)/i);
  if (tpMatch) flags.takeProfit = parseFloat(tpMatch[1]);

  // --sl <price>
  const slMatch = input.match(/--sl\s+\$?(\d+(?:\.\d+)?)/i);
  if (slMatch) flags.stopLoss = parseFloat(slMatch[1]);

  // --degen
  if (/--degen\b/i.test(input)) flags.degen = true;

  // --dry-run
  if (/--dry-?run\b/i.test(input)) flags.dryRun = true;

  // --json
  if (/--json\b/i.test(input)) flags.json = true;

  // --token <sym>
  const tokenMatch = input.match(/--token\s+(\w+)/i);
  if (tokenMatch) flags.collateralToken = normalizeAsset(tokenMatch[1]);

  // --pool <name>
  const poolMatch = input.match(/--pool\s+(\S+)/i);
  if (poolMatch) flags.pool = poolMatch[1];

  // --watch
  if (/--watch\b/i.test(input)) flags.watch = true;

  // --detailed
  if (/--detailed\b/i.test(input)) flags.detailed = true;

  // --min-out <amount>
  const minOutMatch = input.match(/--min-out\s+(\d+(?:\.\d+)?)/i);
  if (minOutMatch) flags.minOut = parseFloat(minOutMatch[1]);

  // inline tp/sl without -- prefix: "tp 200 sl 170"
  if (!flags.takeProfit) {
    const inlineTp = input.match(/\btp\s+\$?(\d+(?:\.\d+)?)/i);
    if (inlineTp) flags.takeProfit = parseFloat(inlineTp[1]);
  }
  if (!flags.stopLoss) {
    const inlineSl = input.match(/\bsl\s+\$?(\d+(?:\.\d+)?)/i);
    if (inlineSl) flags.stopLoss = parseFloat(inlineSl[1]);
  }

  // Strip all flags from input
  const clean = input
    .replace(/--\w[\w-]*(?:\s+\S+)?/g, '')
    .replace(/\b(?:tp|sl)\s+(?:to\s+|at\s+)?\$?\d+(?:\.\d+)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { clean, flags };
}

function cmd(action: Action, params: CommandParams, raw: string): ParsedCommand {
  return { action, source: ParseSource.Regex, confidence: 1.0, params, raw };
}

// ─── Trade Patterns ─────────────────────────────────────────────────────────

type PatternMatcher = (input: string, raw: string, flags: CommandParams) => ParsedCommand | null;

const tradePatterns: PatternMatcher[] = [
  // "long sol 10x 100" / "short eth 5x $50"
  (input, raw, flags) => {
    const m = input.match(/^(long|short|buy|sell)\s+(\w+)\s+(\d+(?:\.\d+)?)x\s+\$?(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    return cmd(Action.OpenPosition, {
      ...flags,
      side: parseSide(m[1]),
      market: normalizeAsset(m[2]),
      leverage: parseFloat(m[3]),
      collateral: parseFloat(m[4]),
    }, raw);
  },

  // "open long sol 10x 100" / "open SOL SHORT 5x $50"
  (input, raw, flags) => {
    const m = input.match(/^open\s+(?:(long|short|buy|sell)\s+)?(\w+)\s+(?:(long|short)\s+)?(\d+(?:\.\d+)?)x\s+\$?(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    const sideRaw = m[1] || m[3];
    if (!sideRaw) return null;
    return cmd(Action.OpenPosition, {
      ...flags,
      side: parseSide(sideRaw),
      market: normalizeAsset(m[2]),
      leverage: parseFloat(m[4]),
      collateral: parseFloat(m[5]),
    }, raw);
  },

  // "buy sol $100 at 10x" / "sell eth $50 at 5x"
  (input, raw, flags) => {
    const m = input.match(/^(buy|sell)\s+(\w+)\s+\$?(\d+(?:\.\d+)?)\s+(?:at\s+)?(\d+(?:\.\d+)?)x/i);
    if (!m) return null;
    return cmd(Action.OpenPosition, {
      ...flags,
      side: parseSide(m[1]),
      market: normalizeAsset(m[2]),
      collateral: parseFloat(m[3]),
      leverage: parseFloat(m[4]),
    }, raw);
  },

  // "long sol with 100 dollars at 10x"
  (input, raw, flags) => {
    const m = input.match(/^(long|short)\s+(\w+)\s+(?:with\s+)?\$?(\d+(?:\.\d+)?)\s*(?:dollars?|usd|usdc)?\s+(?:at\s+)?(\d+(?:\.\d+)?)x/i);
    if (!m) return null;
    return cmd(Action.OpenPosition, {
      ...flags,
      side: parseSide(m[1]),
      market: normalizeAsset(m[2]),
      collateral: parseFloat(m[3]),
      leverage: parseFloat(m[4]),
    }, raw);
  },

  // ─── Flexible order parser ─────────────────────────────────────────
  // Handles any word order: "open 2x sol long 10", "open sol long 2x $10 dollars"
  // Extracts: side, market, leverage, collateral from any position
  (input, raw, flags) => {
    // Must start with "open" or contain side keyword
    if (!/^open\b/i.test(input) && !/\b(long|short|buy|sell)\b/i.test(input)) return null;

    let body = input.replace(/^open\s+/i, '').replace(/\b(?:position|order|trade|with|at|for|a|an|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();

    // Extract side
    const sideMatch = body.match(/\b(long|short|buy|sell)\b/i);
    if (!sideMatch) return null;
    const side = parseSide(sideMatch[1]);
    if (!side) return null;
    body = body.replace(/\b(long|short|buy|sell)\b/i, ' ').replace(/\s+/g, ' ').trim();

    // Extract leverage: "2x", "10x", "2.5x"
    const levMatch = body.match(/\b(\d+(?:\.\d+)?)\s*x\b/i);
    if (!levMatch) return null;
    const leverage = parseFloat(levMatch[1]);
    body = body.replace(/\b\d+(?:\.\d+)?\s*x\b/i, ' ').replace(/\s+/g, ' ').trim();

    // Extract collateral: "$100", "100", "100 dollars", "10 usd"
    const colMatch = body.match(/\$?(\d+(?:\.\d+)?)\s*(?:dollars?|usd|usdc)?/i);
    if (!colMatch) return null;
    const collateral = parseFloat(colMatch[1]);
    body = body.replace(colMatch[0], ' ').replace(/\s+/g, ' ').trim();

    // Remaining should be the market
    const market = body.replace(/\b(open|position|order)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (!market || market.length > 20) return null;

    if (!Number.isFinite(leverage) || leverage < 1) return null;
    if (!Number.isFinite(collateral) || collateral <= 0) return null;

    return cmd(Action.OpenPosition, {
      ...flags,
      side,
      market: normalizeAsset(market),
      leverage,
      collateral,
    }, raw);
  },

  // "close sol" / "close sol long" / "close all"
  (input, raw, flags) => {
    const m = input.match(/^close\s+(?:(all)|(\w+)(?:\s+(long|short))?(?:\s+(\d+)%)?)/i);
    if (!m) return null;
    if (m[1]) {
      return cmd(Action.ClosePosition, { ...flags, market: 'ALL' }, raw);
    }
    return cmd(Action.ClosePosition, {
      ...flags,
      market: normalizeAsset(m[2]),
      side: m[3] ? parseSide(m[3]) : undefined,
      percent: m[4] ? parseFloat(m[4]) : undefined,
    }, raw);
  },

  // "close sol $500" — partial close by USD amount
  (input, raw, flags) => {
    const m = input.match(/^close\s+(\w+)(?:\s+(long|short))?\s+\$(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    return cmd(Action.ClosePosition, {
      ...flags,
      market: normalizeAsset(m[1]),
      side: m[2] ? parseSide(m[2]) : undefined,
      amount: parseFloat(m[3]),
    }, raw);
  },

  // "reverse sol" / "flip sol"
  (input, raw, flags) => {
    const m = input.match(/^(?:reverse|flip)\s+(\w+)/i);
    if (!m) return null;
    return cmd(Action.ReversePosition, { ...flags, market: normalizeAsset(m[1]) }, raw);
  },

  // "add 50 to sol" / "add $50 collateral to sol long"
  (input, raw, flags) => {
    const m = input.match(/^add\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:to\s+)?(\w+)(?:\s+(long|short))?/i);
    if (!m) return null;
    return cmd(Action.AddCollateral, {
      ...flags,
      collateral: parseFloat(m[1]),
      market: normalizeAsset(m[2]),
      side: m[3] ? parseSide(m[3]) : undefined,
    }, raw);
  },

  // "remove 50 from sol" / "remove $50 from sol long"
  (input, raw, flags) => {
    const m = input.match(/^remove\s+\$?(\d+(?:\.\d+)?)\s+(?:collateral\s+)?(?:from\s+)?(\w+)(?:\s+(long|short))?/i);
    if (!m) return null;
    return cmd(Action.RemoveCollateral, {
      ...flags,
      amount: parseFloat(m[1]),
      market: normalizeAsset(m[2]),
      side: m[3] ? parseSide(m[3]) : undefined,
    }, raw);
  },
];

// ─── Order Patterns ─────────────────────────────────────────────────────────

const orderPatterns: PatternMatcher[] = [
  // "limit long sol 10x $100 at $180"
  (input, raw, flags) => {
    const m = input.match(/^limit\s+(?:order\s+)?(long|short)\s+(\w+)\s+(\d+(?:\.\d+)?)x\s+\$?(\d+(?:\.\d+)?)\s+(?:@|at)\s+\$?(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    return cmd(Action.LimitOrder, {
      ...flags,
      side: parseSide(m[1]),
      market: normalizeAsset(m[2]),
      leverage: parseFloat(m[3]),
      collateral: parseFloat(m[4]),
      limitPrice: parseFloat(m[5]),
    }, raw);
  },

  // "set tp sol 200" / "set sl sol long 170"
  (input, raw, flags) => {
    const m = input.match(/^set\s+(tp|sl|take[\s-]?profit|stop[\s-]?loss)\s+(\w+)(?:\s+(long|short))?\s+(?:(?:to|at)\s+)?\$?(\d+(?:\.\d+)?)/i);
    if (!m) return null;
    const isTp = m[1].startsWith('tp') || m[1].startsWith('take');
    return cmd(isTp ? Action.TakeProfit : Action.StopLoss, {
      ...flags,
      market: normalizeAsset(m[2]),
      side: m[3] ? parseSide(m[3]) : undefined,
      triggerPrice: parseFloat(m[4]),
    }, raw);
  },

  // "cancel order sol long 1"
  (input, raw, flags) => {
    const m = input.match(/^cancel\s+(?:order\s+)?(\w+)(?:\s+(long|short))?(?:\s+(\d+))?/i);
    if (!m) return null;
    if (m[1].toLowerCase() === 'all') {
      return cmd(Action.CancelAllOrders, { ...flags, market: m[2] ? normalizeAsset(m[2]) : undefined }, raw);
    }
    return cmd(Action.CancelOrder, {
      ...flags,
      market: normalizeAsset(m[1]),
      side: m[2] ? parseSide(m[2]) : undefined,
      orderId: m[3] ? parseInt(m[3], 10) : undefined,
    }, raw);
  },
];

// ─── Swap Patterns ──────────────────────────────────────────────────────────

const swapPatterns: PatternMatcher[] = [
  // "swap 50 usdc to sol" / "swap 1 sol for usdc"
  (input, raw, flags) => {
    const m = input.match(/^swap\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:to|for|into)\s+(\w+)/i);
    if (!m) return null;
    return cmd(Action.Swap, {
      ...flags,
      amount: parseFloat(m[1]),
      inputToken: normalizeAsset(m[2]),
      outputToken: normalizeAsset(m[3]),
    }, raw);
  },

  // "buy 0.5 sol with usdc"
  (input, raw, flags) => {
    const m = input.match(/^buy\s+(\d+(?:\.\d+)?)\s+(\w+)\s+with\s+(\w+)/i);
    if (!m) return null;
    return cmd(Action.Swap, {
      ...flags,
      amount: parseFloat(m[1]),
      outputToken: normalizeAsset(m[2]),
      inputToken: normalizeAsset(m[3]),
    }, raw);
  },
];

// ─── LP Patterns ────────────────────────────────────────────────────────────

const lpPatterns: PatternMatcher[] = [
  // "deposit 500 usdc into crypto.1" / "deposit 500 usdc crypto.1 --stake"
  (input, raw, flags) => {
    const m = input.match(/^deposit\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:into?\s+)?(\S+)/i);
    if (!m) return null;
    return cmd(Action.AddLiquidity, {
      ...flags,
      amount: parseFloat(m[1]),
      token: normalizeAsset(m[2]),
      pool: m[3],
      lpMode: flags.degen ? undefined : (input.includes('--compound') ? LpMode.Compound : LpMode.Stake),
    }, raw);
  },

  // "withdraw 100 usdc from crypto.1"
  (input, raw, flags) => {
    const m = input.match(/^withdraw\s+(\d+(?:\.\d+)?)\s+(\w+)\s+(?:from\s+)?(\S+)/i);
    if (!m) return null;
    return cmd(Action.RemoveLiquidity, {
      ...flags,
      amount: parseFloat(m[1]),
      token: normalizeAsset(m[2]),
      pool: m[3],
    }, raw);
  },

  // "collect crypto.1" / "collect fees crypto.1"
  (input, raw, flags) => {
    const m = input.match(/^collect\s+(?:fees?\s+)?(\S+)/i);
    if (!m) return null;
    return cmd(Action.CollectFees, { ...flags, pool: m[1] }, raw);
  },
];

// ─── View Patterns ──────────────────────────────────────────────────────────

const viewPatterns: PatternMatcher[] = [
  (input, raw, flags) => {
    if (/^(?:positions?|pos)$/i.test(input)) return cmd(Action.ViewPositions, flags, raw);
    if (/^(?:portfolio|folio|pf)$/i.test(input)) return cmd(Action.ViewPortfolio, flags, raw);
    if (/^(?:markets?)$/i.test(input)) return cmd(Action.ViewMarkets, flags, raw);
    if (/^(?:pools?)$/i.test(input)) return cmd(Action.ViewPools, flags, raw);
    if (/^(?:prices?)$/i.test(input)) return cmd(Action.ViewPrices, flags, raw);
    if (/^(?:orders?)$/i.test(input)) return cmd(Action.ViewOrders, flags, raw);
    if (/^(?:funding|rates?)$/i.test(input)) return cmd(Action.ViewFunding, flags, raw);
    if (/^(?:oi|open\s*interest)$/i.test(input)) return cmd(Action.ViewOI, flags, raw);
    if (/^(?:fees?)$/i.test(input)) return cmd(Action.ViewFees, flags, raw);
    if (/^(?:hours|schedule|market\s*hours)$/i.test(input)) return cmd(Action.ViewHours, flags, raw);
    if (/^(?:balance|bal)$/i.test(input)) return cmd(Action.ViewBalance, flags, raw);
    if (/^(?:trades?|history|journal|trade\s*history)$/i.test(input)) return cmd(Action.ViewTrades, flags, raw);
    if (/^(?:stats|metrics|statistics)$/i.test(input)) return cmd(Action.ViewStats, flags, raw);
    if (/^(?:earn|rewards?|staking)$/i.test(input)) return cmd(Action.ViewEarn, flags, raw);
    if (/^(?:tokens?|holdings|assets)$/i.test(input)) return cmd(Action.ViewTokens, flags, raw);
    if (/^(?:allocation|alloc)$/i.test(input)) return cmd(Action.ViewAllocation, flags, raw);
    if (/^(?:dashboard|dash|overview)$/i.test(input)) return cmd(Action.ViewDashboard, flags, raw);
    if (/^(?:pnl|profit|loss|p&l)$/i.test(input)) return cmd(Action.ViewPnl, flags, raw);
    if (/^(?:exposure|exp)$/i.test(input)) return cmd(Action.ViewExposure, flags, raw);
    if (/^(?:risk|risk\s*report)$/i.test(input)) return cmd(Action.ViewRisk, flags, raw);
    if (/^(?:wallet\s+tokens?|holdings|assets|wallet\s+balance)$/i.test(input)) return cmd(Action.ViewWalletTokens, flags, raw);

    // FAF
    if (/^(?:faf|faf\s+dashboard|faf\s+status)$/i.test(input)) return cmd(Action.FafStatus, flags, raw);
    if (/^faf\s+stake\s+(\d+)/i.test(input)) return cmd(Action.FafStake, { ...flags, amount: parseFloat(input.match(/\d+/)![0]) }, raw);
    if (/^faf\s+unstake\s+(\d+)/i.test(input)) return cmd(Action.FafUnstake, { ...flags, amount: parseFloat(input.match(/\d+/)![0]) }, raw);
    if (/^faf\s+claim$/i.test(input)) return cmd(Action.FafClaim, flags, raw);
    if (/^faf\s+tier$/i.test(input)) return cmd(Action.FafTier, flags, raw);
    if (/^faf\s+rewards?$/i.test(input)) return cmd(Action.FafRewards, flags, raw);
    if (/^faf\s+referral$/i.test(input)) return cmd(Action.FafReferral, flags, raw);
    if (/^faf\s+points?$/i.test(input)) return cmd(Action.FafPoints, flags, raw);
    if (/^faf\s+requests?$/i.test(input)) return cmd(Action.FafRequests, flags, raw);
    if (/^faf\s+cancel\s+(\d+)/i.test(input)) {
      const m = input.match(/^faf\s+cancel\s+(\d+)/i)!;
      return cmd(Action.FafRequests, { ...flags, orderId: parseInt(m[1], 10) }, raw);
    }

    // Analytics
    if (/^(?:volume|vol)$/i.test(input)) return cmd(Action.ViewVolume, flags, raw);
    if (/^(?:liquidations?|liqs?)$/i.test(input)) return cmd(Action.ViewLiquidations, flags, raw);
    if (/^(?:depth)$/i.test(input)) return cmd(Action.ViewDepth, flags, raw);

    // Protocol
    if (/^(?:inspect\s+protocol|protocol\s+status|protocol)$/i.test(input)) return cmd(Action.InspectProtocol, flags, raw);
    if (/^(?:system\s+audit|audit)$/i.test(input)) return cmd(Action.SystemAudit, flags, raw);
    if (/^(?:doctor|diag|diagnostic)$/i.test(input)) return cmd(Action.Doctor, flags, raw);
    if (/^(?:rpc\s+status|rpc)$/i.test(input)) return cmd(Action.RpcStatus, flags, raw);
    if (/^(?:monitor|live|watch)$/i.test(input)) return cmd(Action.Monitor, flags, raw);

    // Earn (full command set — 16 commands)
    if (/^earn\s+dashboard$/i.test(input)) return cmd(Action.EarnDashboard, flags, raw);
    if (/^earn\s+best$/i.test(input)) return cmd(Action.EarnBest, flags, raw);
    if (/^earn\s+positions?$/i.test(input)) return cmd(Action.EarnPositions, flags, raw);
    if (/^earn\s+pnl$/i.test(input)) return cmd(Action.EarnPnl, flags, raw);
    if (/^earn\s+demand$/i.test(input)) return cmd(Action.EarnDemand, flags, raw);
    if (/^earn\s+rotate$/i.test(input)) return cmd(Action.EarnRotate, flags, raw);
    if (/^earn\s+claim$/i.test(input)) return cmd(Action.EarnClaim, flags, raw);
    // earn info <pool>
    if (/^earn\s+info\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+info\s+(\S+)/i)!;
      return cmd(Action.EarnInfo, { ...flags, pool: m[1] }, raw);
    }
    // earn simulate $<amount> <pool>
    if (/^earn\s+simulate\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+simulate\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i)!;
      return cmd(Action.EarnSimulate, { ...flags, amount: parseFloat(m[1]), pool: m[2] }, raw);
    }
    // earn history [pool]
    if (/^earn\s+history(?:\s+(\S+))?$/i.test(input)) {
      const m = input.match(/^earn\s+history(?:\s+(\S+))?$/i)!;
      return cmd(Action.EarnHistory, { ...flags, pool: m[1] }, raw);
    }
    // earn deposit/add $<amount> <pool>
    if (/^earn\s+(?:deposit|add)\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+(?:deposit|add)\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i)!;
      return cmd(Action.EarnDeposit, { ...flags, amount: parseFloat(m[1]), pool: m[2] }, raw);
    }
    // earn withdraw/remove <pct>% <pool>
    if (/^earn\s+(?:withdraw|remove)\s+(\d+)%?\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+(?:withdraw|remove)\s+(\d+)%?\s+(\S+)/i)!;
      return cmd(Action.EarnWithdraw, { ...flags, percent: parseFloat(m[1]), pool: m[2] }, raw);
    }
    // earn stake $<amount> <pool>
    if (/^earn\s+stake\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+stake\s+\$?(\d+(?:\.\d+)?)\s+(\S+)/i)!;
      return cmd(Action.EarnStake, { ...flags, amount: parseFloat(m[1]), pool: m[2] }, raw);
    }
    // earn unstake <pct>% <pool>
    if (/^earn\s+unstake\s+(\d+)%?\s+(\S+)/i.test(input)) {
      const m = input.match(/^earn\s+unstake\s+(\d+)%?\s+(\S+)/i)!;
      return cmd(Action.EarnUnstake, { ...flags, percent: parseFloat(m[1]), pool: m[2] }, raw);
    }

    // Wallet
    if (/^wallet$/i.test(input)) return cmd(Action.WalletStatus, flags, raw);
    if (/^wallet\s+disconnect$/i.test(input)) return cmd(Action.WalletDisconnect, flags, raw);
    if (/^wallet\s+list$/i.test(input)) return cmd(Action.WalletList, flags, raw);
    if (/^wallet\s+use\s+(\S+)/i.test(input)) {
      const m = input.match(/^wallet\s+use\s+(\S+)/i)!;
      return cmd(Action.WalletUse, { ...flags, name: m[1] }, raw);
    }

    // Extra commands
    if (/^close\s+all$/i.test(input)) return cmd(Action.CloseAll, flags, raw);
    if (/^(?:tp\s+status|sl\s+status|order\s+status)$/i.test(input)) return cmd(Action.TpStatus, flags, raw);
    if (/^(?:capital|buying\s+power|available)$/i.test(input)) return cmd(Action.Capital, flags, raw);
    if (/^wallet\s+address$/i.test(input)) return cmd(Action.WalletAddress, flags, raw);
    if (/^wallet\s+connect(?:\s+(\S+))?$/i.test(input)) {
      const m = input.match(/^wallet\s+connect(?:\s+(\S+))?$/i);
      return cmd(Action.WalletConnect, { ...flags, path: m?.[1] }, raw);
    }
    if (/^(?:position\s+debug|pos\s+debug)\s+(\w+)/i.test(input)) {
      const m = input.match(/(\w+)$/i)!;
      return cmd(Action.PositionDebug, { ...flags, symbol: normalizeAsset(m[1]) }, raw);
    }
    if (/^(?:system\s+health|runtime)$/i.test(input)) return cmd(Action.SystemHealth, flags, raw);
    if (/^(?:system\s+status|protocol\s+status)$/i.test(input)) return cmd(Action.SystemStatus, flags, raw);
    if (/^(?:system\s+metrics|metrics)$/i.test(input)) return cmd(Action.SystemMetrics, flags, raw);
    if (/^(?:tx\s+metrics|engine\s+status)$/i.test(input)) return cmd(Action.TxMetrics, flags, raw);
    if (/^(?:trade\s+history)$/i.test(input)) return cmd(Action.ViewTrades, flags, raw);
    if (/^(?:dryrun|dry-run)\s+(.+)/i.test(input)) return cmd(Action.Dryrun, { ...flags, value: input.replace(/^(?:dryrun|dry-run)\s+/i, '') }, raw);

    // TX inspection
    if (/^tx\s+inspect\s+(\S+)/i.test(input)) {
      const m = input.match(/^tx\s+inspect\s+(\S+)/i)!;
      return cmd(Action.TxInspect, { ...flags, value: m[1] }, raw);
    }
    if (/^tx\s+debug\s+(\S+)/i.test(input)) {
      const m = input.match(/^tx\s+debug\s+(\S+)/i)!;
      return cmd(Action.TxDebug, { ...flags, value: m[1] }, raw);
    }

    // Protocol
    if (/^(?:protocol\s+verify|source\s+verify)$/i.test(input)) return cmd(Action.ProtocolVerify, flags, raw);

    // RPC management
    if (/^rpc\s+add\s+(\S+)/i.test(input)) return cmd(Action.RpcAdd, { ...flags, value: input.match(/\S+$/)?.[0] }, raw);
    if (/^rpc\s+remove\s+(\S+)/i.test(input)) return cmd(Action.RpcRemove, { ...flags, value: input.match(/\S+$/)?.[0] }, raw);
    if (/^rpc\s+set\s+(\S+)/i.test(input)) return cmd(Action.RpcSet, { ...flags, value: input.match(/\S+$/)?.[0] }, raw);
    if (/^rpc\s+test$/i.test(input)) return cmd(Action.RpcTest, flags, raw);
    if (/^rpc\s+list$/i.test(input)) return cmd(Action.RpcList, flags, raw);
    if (/^(?:leaderboard|whale\s+activity)$/i.test(input)) return cmd(Action.ViewLiquidations, flags, raw); // routes to NOT SUPPORTED

    // Utilities
    if (/^degen$/i.test(input)) return cmd(Action.Degen, flags, raw);

    return null;
  },

  // "market sol" / "price sol"
  (input, raw, flags) => {
    const m = input.match(/^(?:market|info)\s+(\w+)/i);
    if (m) return cmd(Action.ViewMarket, { ...flags, symbol: normalizeAsset(m[1]) }, raw);
    const p = input.match(/^price\s+(\w+)/i);
    if (p) return cmd(Action.ViewPrices, { ...flags, symbol: normalizeAsset(p[1]) }, raw);
    const pl = input.match(/^pool\s+(\S+)/i);
    if (pl) return cmd(Action.ViewPoolDetail, { ...flags, pool: pl[1] }, raw);
    const tk = input.match(/^token\s+(\w+)/i);
    if (tk) return cmd(Action.ViewToken, { ...flags, symbol: normalizeAsset(tk[1]) }, raw);
    const az = input.match(/^(?:analyze|analysis)\s+(\w+)/i);
    if (az) return cmd(Action.Analyze, { ...flags, symbol: normalizeAsset(az[1]) }, raw);
    const ip = input.match(/^inspect\s+pool\s+(\S+)/i);
    if (ip) return cmd(Action.InspectPool, { ...flags, pool: ip[1] }, raw);
    const im = input.match(/^inspect\s+market\s+(\w+)/i);
    if (im) return cmd(Action.InspectMarket, { ...flags, symbol: normalizeAsset(im[1]) }, raw);
    const fd = input.match(/^funding\s+(\w+)/i);
    if (fd) return cmd(Action.ViewFunding, { ...flags, symbol: normalizeAsset(fd[1]) }, raw);
    return null;
  },

  // "what is the price of sol" / "show me sol price"
  (input, raw, flags) => {
    const m = input.match(/(?:what(?:'s| is)\s+)?(?:the\s+)?price\s+(?:of\s+)?(\w+)/i);
    if (m) return cmd(Action.ViewPrices, { ...flags, symbol: normalizeAsset(m[1]) }, raw);
    return null;
  },

  // "show positions" / "show my balance"
  (input, raw, flags) => {
    const m = input.match(/^show\s+(?:my\s+)?(\w+)/i);
    if (!m) return null;
    const what = m[1].toLowerCase();
    if (what === 'positions' || what === 'pos') return cmd(Action.ViewPositions, flags, raw);
    if (what === 'portfolio') return cmd(Action.ViewPortfolio, flags, raw);
    if (what === 'balance' || what === 'wallet') return cmd(Action.ViewBalance, flags, raw);
    if (what === 'markets') return cmd(Action.ViewMarkets, flags, raw);
    if (what === 'orders') return cmd(Action.ViewOrders, flags, raw);
    return null;
  },
];

// ─── Wallet Patterns ────────────────────────────────────────────────────────

const walletPatterns: PatternMatcher[] = [
  (input, raw, flags) => {
    const m = input.match(/^wallet\s+(create|import|list|use|balance)(?:\s+(\S+))?(?:\s+(\S+))?/i);
    if (!m) return null;
    const sub = m[1].toLowerCase();
    switch (sub) {
      case 'create': return cmd(Action.WalletCreate, { ...flags, name: m[2] }, raw);
      case 'import': return cmd(Action.WalletImport, { ...flags, name: m[2], path: m[3] }, raw);
      case 'list': return cmd(Action.WalletList, flags, raw);
      case 'use': return cmd(Action.WalletUse, { ...flags, name: m[2] }, raw);
      case 'balance': return cmd(Action.ViewBalance, flags, raw);
      default: return null;
    }
  },
];

// ─── System Patterns ────────────────────────────────────────────────────────

const systemPatterns: PatternMatcher[] = [
  (input, raw, flags) => {
    if (/^(?:health|status)$/i.test(input)) return cmd(Action.Health, flags, raw);
    if (/^(?:help|\?)$/i.test(input)) return cmd(Action.Help, flags, raw);
    const cfgMatch = input.match(/^config\s+(?:set\s+)?(\w+)\s+(.+)/i);
    if (cfgMatch) return cmd(Action.Config, { ...flags, key: cfgMatch[1], value: cfgMatch[2].trim() }, raw);
    if (/^config$/i.test(input)) return cmd(Action.Config, flags, raw);
    return null;
  },
];

// ─── Export ─────────────────────────────────────────────────────────────────

const ALL_PATTERNS = [
  ...systemPatterns,
  ...walletPatterns,
  ...viewPatterns,
  ...tradePatterns,
  ...orderPatterns,
  ...swapPatterns,
  ...lpPatterns,
];

/**
 * Try to parse input using regex patterns.
 * Returns null if no pattern matches.
 */
export function regexParse(rawInput: string): ParsedCommand | null {
  const { clean, flags } = extractFlags(rawInput);

  for (const pattern of ALL_PATTERNS) {
    const result = pattern(clean, rawInput, flags);
    if (result) return result;
  }

  return null;
}

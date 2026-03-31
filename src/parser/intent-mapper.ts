/**
 * Layer 2: Intent Mapper
 *
 * Keyword-based classification for inputs that don't match regex patterns
 * but contain enough signal to determine user intent.
 *
 * Works by extracting action keywords, market references, and numeric values
 * from unstructured input and assembling them into a ParsedCommand.
 */

import {
  Action,
  Side,
  ParseSource,
  type ParsedCommand,
  type CommandParams,
} from '../types/index.js';
import { normalizeAsset, isMarketLike } from '../utils/market-aliases.js';

// ─── Keyword Sets ───────────────────────────────────────────────────────────

const OPEN_KEYWORDS = new Set(['open', 'long', 'short', 'buy', 'sell', 'enter', 'trade']);
const CLOSE_KEYWORDS = new Set(['close', 'exit', 'sell', 'dump', 'flatten']);
const SWAP_KEYWORDS = new Set(['swap', 'convert', 'exchange']);
const LP_KEYWORDS = new Set(['deposit', 'withdraw', 'stake', 'unstake', 'lp', 'liquidity', 'earn']);
const VIEW_KEYWORDS = new Set(['show', 'view', 'check', 'get', 'see', 'display', 'list', 'what']);
const LONG_SIGNALS = new Set(['long', 'buy', 'bull', 'bullish', 'up']);
const SHORT_SIGNALS = new Set(['short', 'sell', 'bear', 'bearish', 'down']);

// ─── Token Extraction ───────────────────────────────────────────────────────

function extractTokens(words: string[]): string[] {
  return words.filter(w => isMarketLike(w)).map(w => normalizeAsset(w));
}

function extractNumbers(input: string): number[] {
  const matches = input.match(/\$?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches.map(m => parseFloat(m.replace('$', ''))).filter(n => Number.isFinite(n) && n > 0);
}

function extractLeverage(input: string): number | undefined {
  const m = input.match(/(\d+(?:\.\d+)?)\s*x\b/i);
  return m ? parseFloat(m[1]) : undefined;
}

function detectSide(words: string[]): Side | undefined {
  for (const w of words) {
    if (LONG_SIGNALS.has(w)) return Side.Long;
    if (SHORT_SIGNALS.has(w)) return Side.Short;
  }
  return undefined;
}

// ─── Intent Classification ──────────────────────────────────────────────────

interface IntentResult {
  action: Action;
  confidence: number;
  params: CommandParams;
}

function classifyIntent(input: string): IntentResult | null {
  const lower = input.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const tokens = extractTokens(words);
  const numbers = extractNumbers(input);
  const leverage = extractLeverage(input);
  const side = detectSide(words);

  // Count keyword matches per category
  let openScore = 0, closeScore = 0, swapScore = 0, lpScore = 0, viewScore = 0;

  for (const w of words) {
    if (OPEN_KEYWORDS.has(w)) openScore++;
    if (CLOSE_KEYWORDS.has(w)) closeScore++;
    if (SWAP_KEYWORDS.has(w)) swapScore++;
    if (LP_KEYWORDS.has(w)) lpScore++;
    if (VIEW_KEYWORDS.has(w)) viewScore++;
  }

  // Swap detection: "X to Y" pattern with two tokens
  if (swapScore > 0 && tokens.length >= 2 && /\b(?:to|for|into)\b/.test(lower)) {
    return {
      action: Action.Swap,
      confidence: 0.8,
      params: {
        inputToken: tokens[0],
        outputToken: tokens[1],
        amount: numbers[0],
      },
    };
  }

  // Open position: has side + market + (leverage or amount)
  if (openScore > 0 && side && tokens.length >= 1 && (leverage || numbers.length > 0)) {
    return {
      action: Action.OpenPosition,
      confidence: 0.75,
      params: {
        market: tokens[0],
        side,
        leverage: leverage ?? 2,
        collateral: numbers[0],
      },
    };
  }

  // Close position: close keyword + market
  if (closeScore > 0 && tokens.length >= 1) {
    return {
      action: Action.ClosePosition,
      confidence: 0.8,
      params: {
        market: tokens[0],
        side,
      },
    };
  }

  // LP: deposit/withdraw/stake keyword + pool name
  if (lpScore > 0) {
    if (/\b(?:deposit|add)\b/.test(lower)) {
      return {
        action: Action.AddLiquidity,
        confidence: 0.7,
        params: { amount: numbers[0], token: tokens[0], pool: tokens[1] },
      };
    }
    if (/\b(?:withdraw|remove)\b/.test(lower)) {
      return {
        action: Action.RemoveLiquidity,
        confidence: 0.7,
        params: { amount: numbers[0], token: tokens[0], pool: tokens[1] },
      };
    }
  }

  // View: just want to see something
  if (viewScore > 0 || (tokens.length === 0 && words.some(w => VIEW_KEYWORDS.has(w)))) {
    if (/\bposition/i.test(lower)) return { action: Action.ViewPositions, confidence: 0.85, params: {} };
    if (/\bportfolio/i.test(lower)) return { action: Action.ViewPortfolio, confidence: 0.85, params: {} };
    if (/\bmarket/i.test(lower)) return { action: Action.ViewMarkets, confidence: 0.85, params: {} };
    if (/\bbalance/i.test(lower)) return { action: Action.ViewBalance, confidence: 0.85, params: {} };
    if (/\bprice/i.test(lower) && tokens.length > 0) {
      return { action: Action.ViewPrices, confidence: 0.85, params: { symbol: tokens[0] } };
    }
    if (/\bpool/i.test(lower)) return { action: Action.ViewPools, confidence: 0.85, params: {} };
    if (/\border/i.test(lower)) return { action: Action.ViewOrders, confidence: 0.85, params: {} };
  }

  // Open position with less signal (just side + market, no leverage)
  if (side && tokens.length >= 1) {
    return {
      action: Action.OpenPosition,
      confidence: 0.5,  // low confidence — needs confirmation
      params: {
        market: tokens[0],
        side,
        leverage: 2,  // safe default
        collateral: numbers[0],
      },
    };
  }

  return null;
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * Try to classify input via keyword extraction.
 * Returns null if no intent can be determined.
 * Confidence < 0.8 means the result should be confirmed with the user.
 */
export function intentParse(rawInput: string): ParsedCommand | null {
  const result = classifyIntent(rawInput);
  if (!result) return null;

  return {
    action: result.action,
    source: ParseSource.Intent,
    confidence: result.confidence,
    params: result.params,
    raw: rawInput,
  };
}

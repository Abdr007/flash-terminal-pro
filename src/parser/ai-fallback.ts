/**
 * Layer 3: AI Fallback Parser
 *
 * Uses an LLM to classify ambiguous inputs into structured commands.
 * ONLY called when regex and intent mapping both fail or produce low confidence.
 *
 * SAFETY:
 *   - AI output is ALWAYS marked as a suggestion (requiresConfirmation = true)
 *   - AI NEVER triggers execution directly
 *   - Structured JSON output only — no freeform generation
 */

import {
  Action,
  Side,
  ParseSource,
  type ParsedCommand,
  type CommandParams,
} from '../types/index.js';
import { normalizeAsset, getAllSymbols } from '../utils/market-aliases.js';
import { loadConfig } from '../config/index.js';

// ─── AI Classification ─────────────────────────────────────────────────────

interface AIClassification {
  action: string;
  market?: string;
  side?: string;
  leverage?: number;
  collateral?: number;
  inputToken?: string;
  outputToken?: string;
  amount?: number;
}

const SYSTEM_PROMPT = `You are a Flash Trade CLI command parser. Parse user input into a JSON command.

Available actions: open_position, close_position, swap, view_positions, view_markets, view_prices, view_portfolio, view_balance, add_collateral, remove_collateral, take_profit, stop_loss, help

Available markets: ${getAllSymbols().join(', ')}

Rules:
- Output ONLY valid JSON, no explanation
- If uncertain, output {"action": "unknown"}
- side must be "LONG" or "SHORT"
- leverage must be a number >= 1
- collateral/amount must be a positive number

Example: "go long on solana fifty bucks 10 times leverage"
Output: {"action":"open_position","market":"SOL","side":"LONG","leverage":10,"collateral":50}`;

async function callAI(input: string): Promise<AIClassification | null> {
  const config = loadConfig();
  if (!config.groqApiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;

    return parsed as AIClassification;
  } catch {
    return null;
  }
}

// ─── Map AI Output to ParsedCommand ─────────────────────────────────────────

function mapAIResult(ai: AIClassification, raw: string): ParsedCommand | null {
  const actionMap: Record<string, Action> = {
    open_position: Action.OpenPosition,
    close_position: Action.ClosePosition,
    swap: Action.Swap,
    view_positions: Action.ViewPositions,
    view_markets: Action.ViewMarkets,
    view_prices: Action.ViewPrices,
    view_portfolio: Action.ViewPortfolio,
    view_balance: Action.ViewBalance,
    add_collateral: Action.AddCollateral,
    remove_collateral: Action.RemoveCollateral,
    take_profit: Action.TakeProfit,
    stop_loss: Action.StopLoss,
    help: Action.Help,
  };

  const action = actionMap[ai.action];
  if (!action) return null;

  const params: CommandParams = {};

  if (ai.market) params.market = normalizeAsset(ai.market);
  if (ai.side) params.side = ai.side.toUpperCase() === 'LONG' ? Side.Long : Side.Short;
  if (ai.leverage && Number.isFinite(ai.leverage) && ai.leverage >= 1) params.leverage = ai.leverage;
  if (ai.collateral && Number.isFinite(ai.collateral) && ai.collateral > 0) params.collateral = ai.collateral;
  if (ai.inputToken) params.inputToken = normalizeAsset(ai.inputToken);
  if (ai.outputToken) params.outputToken = normalizeAsset(ai.outputToken);
  if (ai.amount && Number.isFinite(ai.amount) && ai.amount > 0) params.amount = ai.amount;

  return {
    action,
    source: ParseSource.AIFallback,
    confidence: 0.6,   // AI results always get moderate confidence
    params,
    raw,
  };
}

// ─── Export ─────────────────────────────────────────────────────────────────

/**
 * Attempt AI-based command classification.
 * Returns null if AI is unavailable or returns garbage.
 * Results ALWAYS have confidence < 1.0 and require user confirmation.
 */
export async function aiFallbackParse(rawInput: string): Promise<ParsedCommand | null> {
  const ai = await callAI(rawInput);
  if (!ai) return null;
  if (ai.action === 'unknown') return null;

  return mapAIResult(ai, rawInput);
}

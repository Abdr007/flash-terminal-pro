/**
 * Command Parser — 3-layer pipeline
 *
 * Layer 1: Regex (deterministic, confidence=1.0)
 * Layer 2: Intent mapper (keyword extraction, confidence=0.5-0.85)
 * Layer 3: AI fallback (LLM classification, confidence=0.6)
 *
 * Pipeline:
 *   Raw input → normalize → regex → intent → AI → unknown
 */

import { Action, ParseSource, type ParsedCommand } from '../types/index.js';
import { regexParse } from './regex-parser.js';
import { intentParse } from './intent-mapper.js';
import { aiFallbackParse } from './ai-fallback.js';

// ─── Input Normalization ────────────────────────────────────────────────────

function normalize(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, ' ')  // strip control chars
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .replace(/[.!?]+$/, '');             // strip trailing punctuation
}

// ─── Main Parser ────────────────────────────────────────────────────────────

/**
 * Parse user input into a structured command.
 *
 * Returns a ParsedCommand with:
 *   - action: what to do
 *   - params: structured parameters
 *   - source: which parser layer resolved it
 *   - confidence: how certain we are (1.0 = regex, 0.5-0.85 = intent, 0.6 = AI)
 *
 * Commands with confidence < 0.8 should be confirmed with the user before execution.
 */
export async function parse(rawInput: string): Promise<ParsedCommand> {
  const input = normalize(rawInput);

  if (!input) {
    return {
      action: Action.Unknown,
      source: ParseSource.FastDispatch,
      confidence: 0,
      params: {},
      raw: rawInput,
    };
  }

  // Layer 1: Regex — deterministic, highest confidence
  const regexResult = regexParse(input);
  if (regexResult) return regexResult;

  // Layer 2: Intent mapper — keyword extraction
  const intentResult = intentParse(input);
  if (intentResult && intentResult.confidence >= 0.7) return intentResult;

  // Layer 3: AI fallback — only if we have some signal but not enough
  const aiResult = await aiFallbackParse(input);
  if (aiResult) return aiResult;

  // If intent had low confidence, return it as a last resort
  if (intentResult) return intentResult;

  // Unknown
  return {
    action: Action.Unknown,
    source: ParseSource.FastDispatch,
    confidence: 0,
    params: {},
    raw: rawInput,
  };
}

/**
 * Synchronous parse — regex + intent only (no AI).
 * Use this for fast dispatch in the REPL where latency matters.
 */
export function parseSync(rawInput: string): ParsedCommand {
  const input = normalize(rawInput);

  if (!input) {
    return { action: Action.Unknown, source: ParseSource.FastDispatch, confidence: 0, params: {}, raw: rawInput };
  }

  const regexResult = regexParse(input);
  if (regexResult) return regexResult;

  const intentResult = intentParse(input);
  if (intentResult) return intentResult;

  return { action: Action.Unknown, source: ParseSource.FastDispatch, confidence: 0, params: {}, raw: rawInput };
}

export { regexParse } from './regex-parser.js';
export { intentParse } from './intent-mapper.js';
export { aiFallbackParse } from './ai-fallback.js';

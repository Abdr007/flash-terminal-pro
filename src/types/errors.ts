/**
 * Typed Error Codes
 *
 * Every failure in the system uses a specific error code.
 * No generic "Error" messages. Each code maps to:
 *   - a category (input, risk, network, execution, state)
 *   - a human-readable description
 *   - an actionable suggestion
 */

export enum ErrorCode {
  // ─── Input Errors ──────────────────────────────────────────────────
  PARSE_FAILED = 'PARSE_FAILED',
  MISSING_PARAMS = 'MISSING_PARAMS',
  INVALID_MARKET = 'INVALID_MARKET',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  SAME_TOKEN = 'SAME_TOKEN',

  // ─── Risk Errors ──────────────────────────────────────────────────
  LEVERAGE_EXCEEDED = 'LEVERAGE_EXCEEDED',
  SIZE_EXCEEDED = 'SIZE_EXCEEDED',
  COLLATERAL_EXCEEDED = 'COLLATERAL_EXCEEDED',
  EXPOSURE_EXCEEDED = 'EXPOSURE_EXCEEDED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  MIN_COLLATERAL = 'MIN_COLLATERAL',
  MARKET_CLOSED = 'MARKET_CLOSED',
  LIQUIDATION_RISK = 'LIQUIDATION_RISK',

  // ─── Quote Errors ─────────────────────────────────────────────────
  QUOTE_EXPIRED = 'QUOTE_EXPIRED',
  QUOTE_FAILED = 'QUOTE_FAILED',
  PRICE_DRIFT = 'PRICE_DRIFT',
  SLIPPAGE_EXCEEDED = 'SLIPPAGE_EXCEEDED',

  // ─── Transaction Errors ───────────────────────────────────────────
  TX_BUILD_FAILED = 'TX_BUILD_FAILED',
  TX_DESERIALIZE_FAILED = 'TX_DESERIALIZE_FAILED',
  TX_VALIDATION_FAILED = 'TX_VALIDATION_FAILED',
  SIGNER_MISMATCH = 'SIGNER_MISMATCH',
  ACCOUNT_INTEGRITY = 'ACCOUNT_INTEGRITY',
  SIMULATION_FAILED = 'SIMULATION_FAILED',
  SIGN_FAILED = 'SIGN_FAILED',
  SEND_FAILED = 'SEND_FAILED',
  CONFIRM_TIMEOUT = 'CONFIRM_TIMEOUT',
  BLOCKHASH_EXPIRED = 'BLOCKHASH_EXPIRED',
  ON_CHAIN_FAILURE = 'ON_CHAIN_FAILURE',

  // ─── Network Errors ───────────────────────────────────────────────
  RPC_TIMEOUT = 'RPC_TIMEOUT',
  RPC_UNAVAILABLE = 'RPC_UNAVAILABLE',
  API_TIMEOUT = 'API_TIMEOUT',
  API_UNAVAILABLE = 'API_UNAVAILABLE',

  // ─── State Errors ─────────────────────────────────────────────────
  STATE_MISMATCH = 'STATE_MISMATCH',
  POSITION_NOT_FOUND = 'POSITION_NOT_FOUND',
  BALANCE_MISMATCH = 'BALANCE_MISMATCH',

  // ─── Safety Errors ────────────────────────────────────────────────
  REPLAY_DETECTED = 'REPLAY_DETECTED',
  PROGRAM_BLOCKED = 'PROGRAM_BLOCKED',
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',

  // ─── Unknown ──────────────────────────────────────────────────────
  UNKNOWN = 'UNKNOWN',
}

/**
 * Structured error with code, message, and optional suggestion.
 */
export class FlashError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'FlashError';
  }
}

/**
 * Map error codes to categories for filtering.
 */
export function errorCategory(code: ErrorCode): 'input' | 'risk' | 'quote' | 'tx' | 'network' | 'state' | 'safety' | 'unknown' {
  if (code.startsWith('PARSE') || code.startsWith('MISSING') || code.startsWith('INVALID') || code === 'SAME_TOKEN') return 'input';
  if (['LEVERAGE_EXCEEDED', 'SIZE_EXCEEDED', 'COLLATERAL_EXCEEDED', 'EXPOSURE_EXCEEDED', 'INSUFFICIENT_BALANCE', 'MIN_COLLATERAL', 'MARKET_CLOSED', 'LIQUIDATION_RISK'].includes(code)) return 'risk';
  if (code.startsWith('QUOTE') || code === 'PRICE_DRIFT' || code === 'SLIPPAGE_EXCEEDED') return 'quote';
  if (code.startsWith('TX_') || code.startsWith('SIGN') || code.startsWith('SEND') || code.startsWith('CONFIRM') || code.startsWith('BLOCKHASH') || code === 'SIMULATION_FAILED' || code === 'ON_CHAIN_FAILURE' || code === 'SIGNER_MISMATCH' || code === 'ACCOUNT_INTEGRITY') return 'tx';
  if (code.startsWith('RPC') || code.startsWith('API')) return 'network';
  if (code.startsWith('STATE') || code === 'POSITION_NOT_FOUND' || code === 'BALANCE_MISMATCH') return 'state';
  if (code === 'REPLAY_DETECTED' || code === 'PROGRAM_BLOCKED' || code === 'WALLET_NOT_CONNECTED') return 'safety';
  return 'unknown';
}

/**
 * Output formatting utilities — matching flash-terminal exactly
 */

import chalk from 'chalk';

// ─── Color Constants (matching flash-terminal's theme.ts) ───────────────────

const ACCENT = chalk.hex('#00FF88');
const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');

// ─── ANSI Helpers ──────────────────────────────────────────────────────────

/** Strip ANSI escape sequences for accurate width measurement. */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Visible length of a string (excluding ANSI escape codes). */
export function visibleLength(str: string): number {
  return stripAnsi(str).length;
}

/** Pad a string to a target visible width, ignoring ANSI codes. */
export function padVisible(str: string, width: number): string {
  const p = width - visibleLength(str);
  return p > 0 ? str + ' '.repeat(p) : str;
}

/** padStart equivalent that accounts for ANSI codes. */
export function padVisibleStart(str: string, width: number): string {
  const p = width - visibleLength(str);
  return p > 0 ? ' '.repeat(p) + str : str;
}

// ─── Numeric Formatting (matching flash-terminal) ──────────────────────────

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  // Normalize negative zero
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  if (value >= 1000) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'N/A';
  const v = Math.abs(value) < 0.005 ? 0 : value;
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

// ─── Semantic Colors (matching flash-terminal's theme) ─────────────────────

export function colorPnl(value: number): string {
  const formatted = formatUsd(value);
  if (value > 0) return ACCENT(formatted);
  if (value < 0) return chalk.red(formatted);
  return MUTED(formatted);
}

export function colorPercent(value: number): string {
  const formatted = formatPercent(value);
  if (value > 0) return ACCENT(formatted);
  if (value < 0) return chalk.red(formatted);
  return MUTED(formatted);
}

export function colorSide(side: string): string {
  return side.toUpperCase() === 'LONG' ? ACCENT('LONG') : chalk.red('SHORT');
}

// ─── Text Helpers ──────────────────────────────────────────────────────────

export function dim(s: string): string {
  return MUTED(s);
}

export function bold(s: string): string {
  return chalk.bold(s);
}

export function accent(s: string): string {
  return ACCENT(s);
}

export function accentBold(s: string): string {
  return ACCENT_BOLD(s);
}

export function warn(s: string): string {
  return chalk.yellow(s);
}

export function err(s: string): string {
  return chalk.red(s);
}

export function ok(s: string): string {
  return chalk.green(s);
}

/** ANSI-aware pad for table alignment */
export function pad(s: string, width: number): string {
  return padVisible(s, width);
}

/** Scrub sensitive data from error messages */
export function scrubError(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"']+/g, (url) => {
      try { return new URL(url).origin + '/***'; } catch { return '***'; }
    })
    .replace(/sk-ant-[^\s"']+/g, 'sk-ant-***')
    .replace(/gsk_[^\s"']+/g, 'gsk_***')
    .replace(/api[_-]?key=[^&\s"]+/gi, 'api_key=***')
    .replace(/[A-Za-z0-9+/]{44,}={0,2}/g, '[REDACTED]');
}

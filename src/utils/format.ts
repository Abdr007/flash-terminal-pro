/**
 * Output formatting utilities
 */

import chalk from 'chalk';

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  const abs = Math.abs(n);
  const str = abs >= 1_000_000
    ? `${(abs / 1_000_000).toFixed(2)}M`
    : abs >= 1_000
      ? `${(abs / 1_000).toFixed(2)}K`
      : abs.toFixed(2);
  return n < 0 ? `-$${str}` : `$${str}`;
}

export function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 10_000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '—%';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function colorPnl(n: number): string {
  const str = formatUsd(n);
  if (n > 0) return chalk.green(str);
  if (n < 0) return chalk.red(str);
  return chalk.dim(str);
}

export function colorSide(side: string): string {
  return side.toUpperCase() === 'LONG' ? chalk.green(side) : chalk.red(side);
}

export function colorPercent(n: number): string {
  const str = formatPercent(n);
  if (n > 0) return chalk.green(str);
  if (n < 0) return chalk.red(str);
  return chalk.dim(str);
}

export function dim(s: string): string {
  return chalk.dim(s);
}

export function bold(s: string): string {
  return chalk.bold(s);
}

export function accent(s: string): string {
  return chalk.cyan(s);
}

export function accentBold(s: string): string {
  return chalk.cyan.bold(s);
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

/** Pad string for table alignment */
export function pad(s: string, width: number): string {
  return s.padEnd(width);
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

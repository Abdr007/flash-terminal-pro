/**
 * Rich Display Module
 *
 * Professional terminal formatting matching Flash Terminal quality.
 * Reusable components for tables, headers, sections, bars.
 */

import chalk from 'chalk';

// ─── Layout ─────────────────────────────────────────────────────────────────

export function header(title: string): string {
  return `\n  ${chalk.cyan.bold(title)}\n  ${chalk.dim('─'.repeat(52))}\n`;
}

export function subheader(title: string): string {
  return `  ${chalk.dim(title)}`;
}

export function divider(): string {
  return `  ${chalk.dim('─'.repeat(52))}`;
}

export function section(title: string): string {
  return `\n  ${chalk.white.bold(title)}`;
}

export function kv(key: string, value: string, keyWidth = 14): string {
  return `  ${chalk.dim(key.padEnd(keyWidth))} ${value}`;
}

export function kvBold(key: string, value: string, keyWidth = 14): string {
  return `  ${chalk.dim(key.padEnd(keyWidth))} ${chalk.white.bold(value)}`;
}

export function kvColor(key: string, value: string, color: 'green' | 'red' | 'yellow' | 'cyan', keyWidth = 14): string {
  const colorFn = color === 'green' ? chalk.green : color === 'red' ? chalk.red : color === 'yellow' ? chalk.yellow : chalk.cyan;
  return `  ${chalk.dim(key.padEnd(keyWidth))} ${colorFn(value)}`;
}

// ─── Bars ───────────────────────────────────────────────────────────────────

export function progressBar(value: number, max: number, width = 20, color: 'green' | 'red' | 'yellow' | 'cyan' = 'green'): string {
  const filled = Math.min(Math.round((value / max) * width), width);
  const empty = width - filled;
  const colorFn = color === 'green' ? chalk.green : color === 'red' ? chalk.red : color === 'yellow' ? chalk.yellow : chalk.cyan;
  return colorFn('█'.repeat(filled)) + chalk.dim('░'.repeat(empty));
}

export function allocBar(pct: number, width = 20): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const color = pct > 50 ? chalk.green : pct > 20 ? chalk.cyan : chalk.dim;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export function tableHeader(cols: { label: string; width: number }[]): string {
  const row = cols.map(c => chalk.dim(c.label.padEnd(c.width))).join(' ');
  const line = chalk.dim('─'.repeat(cols.reduce((s, c) => s + c.width + 1, 0)));
  return `  ${row}\n  ${line}`;
}

export function tableRow(values: string[], widths: number[]): string {
  return '  ' + values.map((v, i) => v.padEnd(widths[i] ?? 10)).join(' ');
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function usd(n: number): string {
  if (!Number.isFinite(n)) return '$—';
  const abs = Math.abs(n);
  const str = abs >= 1_000_000 ? `${(abs / 1_000_000).toFixed(2)}M`
    : abs >= 1_000 ? `${(abs / 1_000).toFixed(2)}K`
    : abs.toFixed(2);
  return n < 0 ? `-$${str}` : `$${str}`;
}

export function price(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 10_000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(6)}`;
}

export function pnl(n: number): string {
  const s = usd(n);
  return n > 0 ? chalk.green('+' + s) : n < 0 ? chalk.red(s) : chalk.dim(s);
}

export function side(s: string): string {
  return s.toUpperCase() === 'LONG' ? chalk.green(s) : chalk.red(s);
}

export function status(ok: boolean, label?: string): string {
  return ok ? chalk.green(label ?? 'OK') : chalk.red(label ?? 'FAIL');
}

export function warning(msg: string): string {
  return `  ${chalk.yellow('⚠')} ${msg}`;
}

export function success(msg: string): string {
  return `  ${chalk.green('✓')} ${msg}`;
}

export function error(msg: string): string {
  return `  ${chalk.red('✗')} ${msg}`;
}

export function dim(msg: string): string {
  return chalk.dim(msg);
}

export function link(url: string): string {
  return chalk.dim(url);
}

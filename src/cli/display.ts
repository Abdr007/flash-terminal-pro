/**
 * Display System — Flash Terminal Exact Match
 *
 * Replicates flash-terminal's theme.ts formatting exactly:
 *   - Green accent (#00FF88) for headers
 *   - Muted gray (#6B7B73) for separators/labels
 *   - ─ dash separators (not dots)
 *   - Consistent 2-space indent
 */

import chalk from 'chalk';

// ─── Color Palette (matching flash-terminal) ────────────────────────────────

const ACCENT = chalk.hex('#00FF88');
const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');

// ─── Layout ─────────────────────────────────────────────────────────────────

export function header(title: string): string {
  return `\n  ${ACCENT_BOLD(title)}\n  ${MUTED('─'.repeat(40))}`;
}

export function titleBlock(title: string, width = 40): string {
  return `\n  ${ACCENT_BOLD(title)}\n  ${MUTED('─'.repeat(width))}`;
}

export function subline(text: string): string {
  return `  ${MUTED(text)}`;
}

export function divider(width = 40): string {
  return `  ${MUTED('─'.repeat(width))}`;
}

export function section(title: string): string {
  return `\n  ${chalk.bold(title)}`;
}

export function spacer(): string {
  return '';
}

// ─── Key-Value ──────────────────────────────────────────────────────────────

export function kv(key: string, value: string, keyWidth = 18): string {
  return `  ${MUTED(key.padEnd(keyWidth))}${value}`;
}

export function kvBold(key: string, value: string, keyWidth = 18): string {
  return `  ${MUTED(key.padEnd(keyWidth))}${chalk.white.bold(value)}`;
}

export function kvColor(key: string, value: string, color: 'green' | 'red' | 'yellow' | 'cyan', keyWidth = 18): string {
  const fn = color === 'green' ? chalk.green : color === 'red' ? chalk.red : color === 'yellow' ? chalk.yellow : chalk.cyan;
  return `  ${MUTED(key.padEnd(keyWidth))}${fn(value)}`;
}

// ─── Bars ───────────────────────────────────────────────────────────────────

export function progressBar(pct: number, width = 16): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  return ACCENT('█'.repeat(filled)) + MUTED('░'.repeat(width - filled));
}

export function allocBar(pct: number, width = 16): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const color = pct > 60 ? chalk.green : pct > 25 ? ACCENT : MUTED;
  return color('█'.repeat(filled)) + MUTED('░'.repeat(width - filled));
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export function tableHeader(cols: { label: string; width: number }[]): string {
  const row = cols.map(c => c.label.padEnd(c.width)).join(' ');
  return `  ${MUTED(chalk.bold(row))}`;
}

export function tableSeparator(width: number): string {
  return `  ${MUTED('─'.repeat(width))}`;
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
  if (n > 0) return chalk.green('+' + s);
  if (n < 0) return chalk.red(s);
  return MUTED(s);
}

export function colorPnl(n: number): string {
  return pnl(n);
}

export function side(s: string): string {
  return s.toUpperCase() === 'LONG' ? chalk.green('LONG') : chalk.red('SHORT');
}

export function colorSide(s: string): string {
  return side(s);
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
  return MUTED(msg);
}

export function accentBold(msg: string): string {
  return ACCENT_BOLD(msg);
}

export function ok(msg: string): string {
  return chalk.green(msg);
}

export function err(msg: string): string {
  return chalk.red(msg);
}

export function link(url: string): string {
  return MUTED(url);
}

export function hint(next: string): string {
  return `  ${MUTED('→ ' + next)}`;
}

export function pad(s: string, width: number): string {
  return s.padEnd(width);
}

export function formatUsd(n: number): string {
  return usd(n);
}

export function formatPrice(n: number): string {
  return price(n);
}

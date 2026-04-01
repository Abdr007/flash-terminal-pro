/**
 * Display System — Flash Terminal Exact Match
 *
 * Replicates flash-terminal's theme.ts formatting exactly:
 *   - Green accent (#00FF88) for headers
 *   - Muted gray (#6B7B73) for separators/labels
 *   - dash separators (not dots)
 *   - Consistent 2-space indent
 *   - ANSI-aware padding for table alignment
 */

import chalk from 'chalk';
import { stripAnsi } from '../utils/format.js';

// ─── Color Palette (matching flash-terminal) ────────────────────────────────

const ACCENT = chalk.hex('#00FF88');
const ACCENT_BOLD = chalk.hex('#00FF88').bold;
const MUTED = chalk.hex('#6B7B73');

// ─── Layout ─────────────────────────────────────────────────────────────────

export function header(title: string): string {
  return `\n  ${ACCENT_BOLD(title)}\n  ${MUTED('\u2500'.repeat(40))}`;
}

export function titleBlock(title: string, width = 40): string {
  return `\n  ${ACCENT_BOLD(title)}\n  ${MUTED('\u2500'.repeat(width))}`;
}

export function subline(text: string): string {
  return `  ${MUTED(text)}`;
}

export function divider(width = 40): string {
  return `  ${MUTED('\u2500'.repeat(width))}`;
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
  return ACCENT('\u2588'.repeat(filled)) + MUTED('\u2591'.repeat(width - filled));
}

export function allocBar(pct: number, width = 16): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const color = pct > 60 ? chalk.green : pct > 25 ? ACCENT : MUTED;
  return color('\u2588'.repeat(filled)) + MUTED('\u2591'.repeat(width - filled));
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export function tableHeader(cols: { label: string; width: number }[]): string {
  const row = cols.map(c => c.label.padEnd(c.width)).join('  ');
  return `  ${MUTED(chalk.bold(row))}`;
}

export function tableSeparator(width: number): string {
  return `  ${MUTED('\u2500'.repeat(width))}`;
}

export function tableRow(values: string[], widths: number[]): string {
  // ANSI-aware padding for colored text
  return '  ' + values.map((v, i) => {
    const w = widths[i] ?? 10;
    const visible = stripAnsi(v).length;
    const p = w - visible;
    return p > 0 ? v + ' '.repeat(p) : v;
  }).join('  ');
}

// ─── Formatting ─────────────────────────────────────────────────────────────

export function usd(n: number): string {
  if (!Number.isFinite(n)) return 'N/A';
  const v = Math.abs(n) < 0.005 ? 0 : n;
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function price(n: number): string {
  if (!Number.isFinite(n) || n === 0) return 'N/A';
  if (n >= 1000) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(6)}`;
}

export function pnl(n: number): string {
  const s = usd(n);
  if (n > 0) return ACCENT('+' + s);
  if (n < 0) return chalk.red(s);
  return MUTED(s);
}

export function colorPnl(n: number): string {
  return pnl(n);
}

export function side(s: string): string {
  return s.toUpperCase() === 'LONG' ? ACCENT('LONG') : chalk.red('SHORT');
}

export function colorSide(s: string): string {
  return side(s);
}

export function status(isOk: boolean, label?: string): string {
  return isOk ? chalk.green(label ?? 'OK') : chalk.red(label ?? 'FAIL');
}

export function warning(msg: string): string {
  return `  ${chalk.yellow('\u26a0')} ${msg}`;
}

export function success(msg: string): string {
  return `  ${chalk.green('\u2713')} ${msg}`;
}

export function error(msg: string): string {
  return `  ${chalk.red('\u2717')} ${msg}`;
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
  return `  ${MUTED('\u2192 ' + next)}`;
}

/** ANSI-aware pad for table alignment */
export function pad(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  const p = width - visible;
  return p > 0 ? s + ' '.repeat(p) : s;
}

export function formatUsd(n: number): string {
  return usd(n);
}

export function formatPrice(n: number): string {
  return price(n);
}

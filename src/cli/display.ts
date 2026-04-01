/**
 * Display System — Futuristic Minimal Terminal
 *
 * Design principles:
 *   - Whitespace over borders
 *   - Bold values, dim labels
 *   - Semantic colors (green=profit, red=loss, yellow=warn, cyan=info)
 *   - Compact vertical space
 *   - Subtle symbols (● ○ ▲ ▼)
 */

import chalk from 'chalk';

// ─── Layout ─────────────────────────────────────────────────────────────────

export function header(title: string): string {
  return `\n  ${chalk.white.bold(title)}`;
}

export function subline(text: string): string {
  return `  ${chalk.dim(text)}`;
}

export function divider(): string {
  return `  ${chalk.dim('·'.repeat(50))}`;
}

export function section(title: string): string {
  return `\n  ${chalk.dim.bold(title)}`;
}

export function spacer(): string {
  return '';
}

// ─── Key-Value ──────────────────────────────────────────────────────────────

export function kv(key: string, value: string, keyWidth = 16): string {
  return `  ${chalk.dim(key.padEnd(keyWidth))}${value}`;
}

export function kvBold(key: string, value: string, keyWidth = 16): string {
  return `  ${chalk.dim(key.padEnd(keyWidth))}${chalk.white.bold(value)}`;
}

export function kvColor(key: string, value: string, color: 'green' | 'red' | 'yellow' | 'cyan', keyWidth = 16): string {
  const fn = color === 'green' ? chalk.green : color === 'red' ? chalk.red : color === 'yellow' ? chalk.yellow : chalk.cyan;
  return `  ${chalk.dim(key.padEnd(keyWidth))}${fn(value)}`;
}

// ─── Bars ───────────────────────────────────────────────────────────────────

export function progressBar(pct: number, width = 16): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  return chalk.cyan('▓'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
}

export function allocBar(pct: number, width = 16): string {
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const color = pct > 60 ? chalk.green : pct > 25 ? chalk.cyan : chalk.dim;
  return color('▓'.repeat(filled)) + chalk.dim('░'.repeat(width - filled));
}

// ─── Tables ─────────────────────────────────────────────────────────────────

export function tableHeader(cols: { label: string; width: number }[]): string {
  return `  ${chalk.dim(cols.map(c => c.label.padEnd(c.width)).join(' '))}`;
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
  const s = usd(Math.abs(n));
  if (n > 0) return chalk.green(`▲ +${s}`);
  if (n < 0) return chalk.red(`▼ -${s}`);
  return chalk.dim(`— ${s}`);
}

export function side(s: string): string {
  return s.toUpperCase() === 'LONG' ? chalk.green('LONG') : chalk.red('SHORT');
}

export function status(ok: boolean, label?: string): string {
  return ok ? chalk.green(`● ${label ?? 'OK'}`) : chalk.red(`○ ${label ?? 'FAIL'}`);
}

export function warning(msg: string): string {
  return `  ${chalk.yellow('▲')} ${chalk.yellow(msg)}`;
}

export function success(msg: string): string {
  return `  ${chalk.green('●')} ${msg}`;
}

export function error(msg: string): string {
  return `  ${chalk.red('●')} ${msg}`;
}

export function dim(msg: string): string {
  return chalk.dim(msg);
}

export function link(url: string): string {
  return chalk.dim.underline(url);
}

export function hint(next: string): string {
  return `  ${chalk.dim('→')} ${chalk.dim(next)}`;
}

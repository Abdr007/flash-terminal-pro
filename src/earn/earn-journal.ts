/**
 * Earn Journal — tracks deposits/withdrawals for PnL calculation
 *
 * PnL = current_value + total_withdrawn - total_deposited
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const JOURNAL_DIR = resolve(homedir(), '.flash-x');
const JOURNAL_FILE = resolve(JOURNAL_DIR, 'earn-journal.json');
const MAX_ENTRIES = 5000;

export interface EarnJournalEntry {
  pool: string;
  action: 'deposit' | 'withdraw';
  amountUsd: number;
  timestamp: number;
  txSignature?: string;
}

function ensureDir(): void {
  if (!existsSync(JOURNAL_DIR)) mkdirSync(JOURNAL_DIR, { recursive: true, mode: 0o700 });
}

function loadJournal(): EarnJournalEntry[] {
  try {
    if (!existsSync(JOURNAL_FILE)) return [];
    const raw = readFileSync(JOURNAL_FILE, 'utf-8');
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) return data as EarnJournalEntry[];
    return [];
  } catch {
    return [];
  }
}

function saveJournal(entries: EarnJournalEntry[]): void {
  ensureDir();
  const trimmed = entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries;
  writeFileSync(JOURNAL_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

export function recordEarnAction(entry: EarnJournalEntry): void {
  const entries = loadJournal();
  entries.push(entry);
  saveJournal(entries);
}

export function getEarnJournal(pool?: string): EarnJournalEntry[] {
  const entries = loadJournal();
  if (pool) return entries.filter(e => e.pool === pool);
  return entries;
}

export function calculateEarnPnl(
  currentPositions: { pool: string; valueUsd: number }[],
): { totalDeposited: number; totalWithdrawn: number; currentValue: number; pnl: number } {
  const journal = loadJournal();

  const totalDeposited = journal
    .filter(e => e.action === 'deposit')
    .reduce((s, e) => s + e.amountUsd, 0);

  const totalWithdrawn = journal
    .filter(e => e.action === 'withdraw')
    .reduce((s, e) => s + e.amountUsd, 0);

  const currentValue = currentPositions.reduce((s, p) => s + p.valueUsd, 0);

  return {
    totalDeposited,
    totalWithdrawn,
    currentValue,
    pnl: currentValue + totalWithdrawn - totalDeposited,
  };
}

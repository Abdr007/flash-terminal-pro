/**
 * Trade Audit Log
 *
 * Persistent structured logging for every trade attempt.
 * Writes JSON-line records to ~/.flash-x/audit.log
 *
 * Each record contains:
 *   - timestamp (ISO 8601)
 *   - command (original user input)
 *   - action (open_position, swap, close_position, etc.)
 *   - market / tokens
 *   - amounts (input, output, fees)
 *   - txHash (if sent)
 *   - status (preview, sent, confirmed, failed, blocked)
 *   - error (if any)
 *
 * File rotation: 10MB max, rotates to .old
 * Never logs: private keys, secret bytes, full keypair data
 */

import { writeFileSync, appendFileSync, existsSync, statSync, renameSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const AUDIT_DIR = resolve(homedir(), '.flash-x');
const AUDIT_FILE = resolve(AUDIT_DIR, 'audit.log');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// ─── Audit Record ───────────────────────────────────────────────────────────

export interface AuditRecord {
  timestamp: string;
  action: string;
  command?: string;
  market?: string;
  side?: string;
  inputToken?: string;
  outputToken?: string;
  inputAmount?: number;
  outputAmount?: number;
  leverage?: number;
  collateral?: number;
  sizeUsd?: number;
  fees?: number;
  txHash?: string;
  status: 'preview' | 'sent' | 'confirmed' | 'failed' | 'blocked' | 'inconsistent';
  error?: string;
  durationMs?: number;
  pool?: string;
  slippageBps?: number;
  retryCount?: number;
  // Enhanced fields (TASK 7)
  rpcUsed?: string;
  driftPercent?: number;
  quoteAgeMs?: number;
}

// ─── Audit Logger ───────────────────────────────────────────────────────────

class AuditLogger {
  private ensuredDir = false;

  private ensureDir(): void {
    if (this.ensuredDir) return;
    if (!existsSync(AUDIT_DIR)) {
      mkdirSync(AUDIT_DIR, { recursive: true, mode: 0o700 });
    }
    this.ensuredDir = true;
  }

  /**
   * Write a single audit record as a JSON line.
   */
  log(record: AuditRecord): void {
    try {
      this.ensureDir();
      this.rotateIfNeeded();

      const line = JSON.stringify(record) + '\n';
      appendFileSync(AUDIT_FILE, line, { mode: 0o600 });
    } catch (e) {
      // Audit logging must never crash the system
      getLogger().debug('AUDIT', `Failed to write audit log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Read recent audit records (last N lines).
   */
  readRecent(count = 20): AuditRecord[] {
    try {
      if (!existsSync(AUDIT_FILE)) return [];
      const content = readFileSync(AUDIT_FILE, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      const recent = lines.slice(-count);
      return recent.map(line => {
        try { return JSON.parse(line) as AuditRecord; }
        catch { return null; }
      }).filter((r): r is AuditRecord => r !== null);
    } catch {
      return [];
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(AUDIT_FILE)) return;
      const stat = statSync(AUDIT_FILE);
      if (stat.size > MAX_FILE_SIZE) {
        const oldPath = AUDIT_FILE + '.old';
        if (existsSync(oldPath)) {
          const old2 = AUDIT_FILE + '.old.2';
          try { renameSync(oldPath, old2); } catch { /* ignore */ }
        }
        renameSync(AUDIT_FILE, oldPath);
        writeFileSync(AUDIT_FILE, '', { mode: 0o600 });
        getLogger().info('AUDIT', 'Log rotated (10MB limit)');
      }
    } catch {
      // Ignore rotation errors
    }
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _auditLogger: AuditLogger | null = null;

export function getAuditLog(): AuditLogger {
  if (!_auditLogger) _auditLogger = new AuditLogger();
  return _auditLogger;
}

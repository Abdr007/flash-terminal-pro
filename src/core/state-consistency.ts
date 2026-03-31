/**
 * State Consistency Engine
 *
 * After every transaction, verifies the expected state change occurred.
 * Catches silent failures, partial fills, and RPC inconsistencies.
 *
 * Usage:
 *   1. Record pre-transaction state (balances, positions)
 *   2. Execute transaction
 *   3. Compare post-transaction state against expectations
 *   4. Log any inconsistencies as CRITICAL warnings
 */

import { getLogger } from '../utils/logger.js';
import type { IStateEngine, Position, Side } from '../types/index.js';

// ─── Snapshot ───────────────────────────────────────────────────────────────

export interface StateSnapshot {
  timestamp: number;
  balances: Map<string, number>;
  positions: Position[];
}

// ─── Consistency Engine ─────────────────────────────────────────────────────

export class StateConsistency {
  constructor(private state: IStateEngine) {}

  /**
   * Take a snapshot of current balances and positions.
   * Call this BEFORE executing a transaction.
   */
  async snapshot(tokens: string[]): Promise<StateSnapshot> {
    const balances = new Map<string, number>();
    for (const token of tokens) {
      try {
        const bal = await this.state.getBalance(token);
        balances.set(token, bal);
      } catch {
        balances.set(token, 0);
      }
    }

    let positions: Position[] = [];
    try {
      positions = await this.state.getPositions();
    } catch {
      // OK — positions may not be available
    }

    return { timestamp: Date.now(), balances, positions };
  }

  /**
   * After a trade, refresh state and compare against the snapshot.
   * Returns a list of inconsistencies (empty = all good).
   */
  async verifyAfterTrade(
    preSnapshot: StateSnapshot,
    expectedChanges: ExpectedChange[],
  ): Promise<ConsistencyResult> {
    const log = getLogger();

    // Force refresh all caches
    await this.state.refresh();

    // Small delay for RPC propagation
    await new Promise(r => setTimeout(r, 2_000));

    const issues: string[] = [];
    const details: string[] = [];

    for (const expected of expectedChanges) {
      switch (expected.type) {
        case 'balance_increase': {
          const pre = preSnapshot.balances.get(expected.token) ?? 0;
          const post = await this.state.getBalance(expected.token);
          if (post <= pre) {
            const msg = `${expected.token} balance did not increase: ${pre} → ${post}`;
            issues.push(msg);
            log.error('CONSIST', `INCONSISTENCY: ${msg}`);
          } else {
            details.push(`${expected.token}: ${pre.toFixed(4)} → ${post.toFixed(4)} (+${(post - pre).toFixed(4)})`);
          }
          break;
        }

        case 'balance_decrease': {
          const pre = preSnapshot.balances.get(expected.token) ?? 0;
          const post = await this.state.getBalance(expected.token);
          if (post >= pre) {
            const msg = `${expected.token} balance did not decrease: ${pre} → ${post}`;
            issues.push(msg);
            log.error('CONSIST', `INCONSISTENCY: ${msg}`);
          } else {
            details.push(`${expected.token}: ${pre.toFixed(4)} → ${post.toFixed(4)} (${(post - pre).toFixed(4)})`);
          }
          break;
        }

        case 'position_opened': {
          const post = await this.state.getPosition(expected.market!, expected.side);
          if (!post) {
            const msg = `Position ${expected.market} ${expected.side ?? ''} not found after confirmed tx`;
            issues.push(msg);
            log.error('CONSIST', `INCONSISTENCY: ${msg}`);
          } else {
            details.push(`Position ${expected.market} ${expected.side}: size=$${post.sizeUsd.toFixed(0)}`);
          }
          break;
        }

        case 'position_closed': {
          const post = await this.state.getPosition(expected.market!, expected.side);
          if (post && post.sizeUsd > 0) {
            const msg = `Position ${expected.market} ${expected.side ?? ''} still exists after close (size=$${post.sizeUsd.toFixed(0)})`;
            issues.push(msg);
            log.error('CONSIST', `INCONSISTENCY: ${msg}`);
          } else {
            details.push(`Position ${expected.market} ${expected.side} closed`);
          }
          break;
        }
      }
    }

    if (issues.length === 0) {
      log.success('CONSIST', `State consistency verified: ${details.length} checks passed`);
    } else {
      log.error('CONSIST', `${issues.length} INCONSISTENCIES detected after transaction`);
    }

    return {
      consistent: issues.length === 0,
      issues,
      details,
    };
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExpectedChange {
  type: 'balance_increase' | 'balance_decrease' | 'position_opened' | 'position_closed';
  token: string;
  market?: string;
  side?: Side;
}

export interface ConsistencyResult {
  consistent: boolean;
  issues: string[];
  details: string[];
}

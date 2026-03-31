/**
 * Post-Execution Verification
 *
 * After a transaction is confirmed on-chain, verify the expected
 * state change actually occurred:
 *
 *   - Open position: position exists with expected market/side
 *   - Close position: position removed or size reduced
 *   - Swap: token balances changed as expected
 *   - Collateral: position collateral changed
 *
 * If mismatch: log CRITICAL warning. Never silently pass.
 */

import { getLogger } from '../utils/logger.js';
import type { IStateEngine, Side } from '../types/index.js';

// ─── Verification Results ───────────────────────────────────────────────────

export interface VerificationResult {
  verified: boolean;
  details: string;
  warnings: string[];
}

// ─── Post-Execution Verifier ────────────────────────────────────────────────

export class PostVerifier {
  constructor(private state: IStateEngine) {}

  /**
   * Verify that an open position trade resulted in the expected position.
   */
  async verifyOpenPosition(
    market: string,
    side: Side,
    expectedSizeUsd: number,
  ): Promise<VerificationResult> {
    const log = getLogger();
    const warnings: string[] = [];

    // Force state refresh to get latest on-chain data
    await this.state.refresh();

    // Small delay for RPC consistency
    await new Promise(r => setTimeout(r, 2_000));

    const position = await this.state.getPosition(market, side);

    if (!position) {
      log.error('VERIFY', `CRITICAL: Position ${market} ${side} NOT FOUND after confirmed tx`);
      return {
        verified: false,
        details: `Position ${market} ${side} not found on-chain after confirmed transaction`,
        warnings: ['Position may have been immediately liquidated or transaction reverted'],
      };
    }

    // Verify size is in the right ballpark (within 10% — accounts for fees and price movement)
    if (expectedSizeUsd > 0 && position.sizeUsd > 0) {
      const sizeDiff = Math.abs(position.sizeUsd - expectedSizeUsd) / expectedSizeUsd;
      if (sizeDiff > 0.1) {
        const msg = `Position size $${position.sizeUsd.toFixed(0)} differs from expected $${expectedSizeUsd.toFixed(0)} by ${(sizeDiff * 100).toFixed(1)}%`;
        log.warn('VERIFY', msg);
        warnings.push(msg);
      }
    }

    log.success('VERIFY', `Position verified: ${market} ${side} size=$${position.sizeUsd.toFixed(0)} entry=$${position.entryPrice.toFixed(2)}`);

    return {
      verified: true,
      details: `Position ${market} ${side}: size=$${position.sizeUsd.toFixed(0)}, entry=$${position.entryPrice.toFixed(2)}, liq=$${position.liquidationPrice.toFixed(2)}`,
      warnings,
    };
  }

  /**
   * Verify that a close position trade removed or reduced the position.
   */
  async verifyClosePosition(
    market: string,
    side: Side,
    previousSizeUsd: number,
    closePercent: number,
  ): Promise<VerificationResult> {
    const log = getLogger();
    const warnings: string[] = [];

    await this.state.refresh();
    await new Promise(r => setTimeout(r, 2_000));

    const position = await this.state.getPosition(market, side);

    if (closePercent >= 100) {
      // Full close — position should not exist
      if (position && position.sizeUsd > 0) {
        log.error('VERIFY', `CRITICAL: Position ${market} ${side} still exists after full close (size=$${position.sizeUsd.toFixed(0)})`);
        return {
          verified: false,
          details: `Position still exists after full close`,
          warnings: ['Close may have partially filled or failed silently'],
        };
      }
      log.success('VERIFY', `Position fully closed: ${market} ${side}`);
      return { verified: true, details: `Position ${market} ${side} fully closed`, warnings };
    }

    // Partial close — position should be smaller
    if (!position) {
      // Might have closed fully if position was small
      log.success('VERIFY', `Position closed (may have been fully closed): ${market} ${side}`);
      return { verified: true, details: `Position ${market} ${side} closed`, warnings };
    }

    const expectedRemaining = previousSizeUsd * (1 - closePercent / 100);
    const sizeDiff = Math.abs(position.sizeUsd - expectedRemaining) / expectedRemaining;
    if (sizeDiff > 0.15) {
      const msg = `Remaining size $${position.sizeUsd.toFixed(0)} differs from expected $${expectedRemaining.toFixed(0)} by ${(sizeDiff * 100).toFixed(1)}%`;
      log.warn('VERIFY', msg);
      warnings.push(msg);
    }

    log.success('VERIFY', `Partial close verified: ${market} ${side} remaining=$${position.sizeUsd.toFixed(0)}`);
    return {
      verified: true,
      details: `Position ${market} ${side} reduced to $${position.sizeUsd.toFixed(0)}`,
      warnings,
    };
  }

  /**
   * Verify balance changed after a swap.
   */
  async verifyBalanceChange(
    token: string,
    previousBalance: number,
    expectedDirection: 'increase' | 'decrease',
  ): Promise<VerificationResult> {
    const log = getLogger();

    await this.state.refresh();
    await new Promise(r => setTimeout(r, 2_000));

    const newBalance = await this.state.getBalance(token);
    const diff = newBalance - previousBalance;

    if (expectedDirection === 'increase' && diff <= 0) {
      log.warn('VERIFY', `Expected ${token} balance increase but got ${diff >= 0 ? 'no change' : 'decrease'}`);
      return {
        verified: false,
        details: `${token} balance did not increase as expected`,
        warnings: [`Previous: ${previousBalance.toFixed(4)}, Current: ${newBalance.toFixed(4)}`],
      };
    }

    if (expectedDirection === 'decrease' && diff >= 0) {
      log.warn('VERIFY', `Expected ${token} balance decrease but got ${diff <= 0 ? 'no change' : 'increase'}`);
      return {
        verified: false,
        details: `${token} balance did not decrease as expected`,
        warnings: [`Previous: ${previousBalance.toFixed(4)}, Current: ${newBalance.toFixed(4)}`],
      };
    }

    log.success('VERIFY', `Balance change verified: ${token} ${diff >= 0 ? '+' : ''}${diff.toFixed(4)}`);
    return {
      verified: true,
      details: `${token}: ${previousBalance.toFixed(4)} → ${newBalance.toFixed(4)} (${diff >= 0 ? '+' : ''}${diff.toFixed(4)})`,
      warnings: [],
    };
  }
}

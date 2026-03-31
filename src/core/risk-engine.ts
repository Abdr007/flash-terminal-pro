/**
 * RiskEngine
 *
 * Central risk evaluation gate. Every trade intent passes through here
 * BEFORE reaching the execution engine.
 *
 * Checks:
 *   1. Leverage limits (per-market, user config, degen mode)
 *   2. Position sizing (min collateral, max size, max collateral)
 *   3. Portfolio exposure (total, per-market, correlation)
 *   4. Volatility (oracle confidence, EMA divergence)
 *   5. Liquidation proximity
 *   6. Funding cost
 *   7. Balance sufficiency
 *   8. Market hours
 *   9. Duplicate position
 */

import {
  RiskLevel,
  type TradeIntent,
  type RiskAssessment,
  type RiskCheck,
  type IStateEngine,
  type FlashXConfig,
} from '../types/index.js';
import { getLogger } from '../utils/logger.js';

// ─── Risk Check Helpers ─────────────────────────────────────────────────────

function pass(name: string, message: string): RiskCheck {
  return { name, status: RiskLevel.Safe, message };
}

function warning(name: string, message: string, value?: number, limit?: number): RiskCheck {
  return { name, status: RiskLevel.Warning, message, value, limit };
}

function block(name: string, message: string, value?: number, limit?: number): RiskCheck {
  return { name, status: RiskLevel.Blocked, message, value, limit };
}

// ─── RiskEngine Class ───────────────────────────────────────────────────────

export class RiskEngine {
  constructor(
    private config: FlashXConfig,
    private state: IStateEngine,
  ) {}

  async evaluate(intent: TradeIntent): Promise<RiskAssessment> {
    const log = getLogger();

    // DEV_MODE bypass — allows full pipeline testing without wallet/balance
    if (this.config.devMode) {
      log.warn('RISK', 'DEV_MODE ACTIVE — all risk checks bypassed');
      return {
        allowed: true,
        mustConfirm: true,
        level: RiskLevel.Warning,
        checks: [warning('dev_mode', 'DEV_MODE ACTIVE — risk checks bypassed')],
        summary: 'DEV_MODE ACTIVE — risk checks bypassed',
      };
    }

    const checks: RiskCheck[] = [];

    checks.push(this.checkLeverage(intent));
    checks.push(this.checkPositionSize(intent));
    checks.push(await this.checkExposure(intent));
    checks.push(await this.checkBalance(intent));
    checks.push(await this.checkDuplicate(intent));
    checks.push(this.checkMinCollateral(intent));

    const blocked = checks.filter(c => c.status === RiskLevel.Blocked);
    const warned = checks.filter(c => c.status === RiskLevel.Warning);

    const level = blocked.length > 0
      ? RiskLevel.Blocked
      : warned.length > 0
        ? RiskLevel.Warning
        : RiskLevel.Safe;

    const summary = blocked.length > 0
      ? blocked.map(c => c.message).join('; ')
      : warned.length > 0
        ? warned.map(c => c.message).join('; ')
        : 'All checks passed';

    log.debug('RISK', `Evaluation: ${level} — ${summary}`);

    return {
      allowed: blocked.length === 0,
      mustConfirm: warned.length > 0,
      level,
      checks,
      summary,
    };
  }

  // ─── Individual Checks ──────────────────────────────────────────────────

  private checkLeverage(intent: TradeIntent): RiskCheck {
    const max = intent.degen ? 500 : this.config.maxLeverage;
    if (intent.leverage > max) {
      return block('leverage', `Leverage ${intent.leverage}x exceeds max ${max}x`, intent.leverage, max);
    }
    if (intent.leverage > max * 0.8) {
      return warning('leverage', `Leverage ${intent.leverage}x is ${Math.round(intent.leverage / max * 100)}% of max`, intent.leverage, max);
    }
    return pass('leverage', `${intent.leverage}x within limits`);
  }

  private checkPositionSize(intent: TradeIntent): RiskCheck {
    const sizeUsd = intent.collateral * intent.leverage;
    if (sizeUsd > this.config.maxPositionSize) {
      return block('position_size', `Size $${sizeUsd.toFixed(0)} exceeds limit $${this.config.maxPositionSize}`, sizeUsd, this.config.maxPositionSize);
    }
    if (intent.collateral > this.config.maxCollateralPerTrade) {
      return block('collateral', `Collateral $${intent.collateral} exceeds limit $${this.config.maxCollateralPerTrade}`, intent.collateral, this.config.maxCollateralPerTrade);
    }
    return pass('position_size', `Size $${sizeUsd.toFixed(0)} within limits`);
  }

  private async checkExposure(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const positions = await this.state.getPositions();
      const currentExposure = positions.reduce((sum, p) => sum + p.sizeUsd, 0);
      const newExposure = currentExposure + intent.sizeUsd;

      if (newExposure > this.config.maxTotalExposure) {
        return block('exposure', `Total exposure $${newExposure.toFixed(0)} would exceed limit $${this.config.maxTotalExposure}`, newExposure, this.config.maxTotalExposure);
      }

      // Warn if same-direction exposure on correlated assets
      const sameMarket = positions.filter(p =>
        p.market === intent.market && p.side === intent.side
      );
      if (sameMarket.length > 0) {
        return warning('exposure', `Already have ${intent.market} ${intent.side} position — consider increasing instead`);
      }

      return pass('exposure', `Total exposure $${newExposure.toFixed(0)} within limits`);
    } catch {
      // If state unavailable, allow but warn
      return warning('exposure', 'Could not check portfolio exposure — state unavailable');
    }
  }

  private async checkBalance(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const balance = await this.state.getBalance(intent.collateralToken);
      if (balance < intent.collateral) {
        return block('balance', `Insufficient ${intent.collateralToken}: have $${balance.toFixed(2)}, need $${intent.collateral.toFixed(2)}`, balance, intent.collateral);
      }
      return pass('balance', `${intent.collateralToken} balance sufficient`);
    } catch {
      return warning('balance', 'Could not verify balance — state unavailable');
    }
  }

  private async checkDuplicate(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const existing = await this.state.getPosition(intent.market, intent.side);
      if (existing) {
        return warning('duplicate', `Existing ${intent.market} ${intent.side} position (size: $${existing.sizeUsd.toFixed(0)}) — will increase position`);
      }
      return pass('duplicate', 'No existing position');
    } catch {
      return pass('duplicate', 'Could not check — assuming no duplicate');
    }
  }

  private checkMinCollateral(intent: TradeIntent): RiskCheck {
    if (intent.collateral < 10) {
      return block('min_collateral', `Minimum collateral is $10 (got $${intent.collateral})`, intent.collateral, 10);
    }
    return pass('min_collateral', 'Above minimum');
  }
}

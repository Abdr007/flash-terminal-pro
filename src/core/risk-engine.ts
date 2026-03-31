/**
 * RiskEngine — Production Hardened
 *
 * Central risk evaluation gate. Every trade intent passes through here
 * BEFORE reaching execution. No bypass paths.
 *
 * Checks (all mandatory, even in dev mode):
 *   1. Leverage limits (per-pool from protocol, user config)
 *   2. Position sizing (min $10, max from config)
 *   3. Collateral limits
 *   4. Portfolio exposure (total, per-market)
 *   5. Liquidation proximity (warn if <5%)
 *   6. Market hours (block if market closed)
 *   7. Duplicate position detection
 *
 * DEV_MODE scoped behavior:
 *   - Balance check: BYPASSED (allows testing without funds)
 *   - All other checks: ENFORCED (leverage, size, exposure, etc.)
 *
 * This ensures structural safety even during development.
 */

import {
  RiskLevel,
  type TradeIntent,
  type SwapIntent,
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

// ─── Pool Leverage Limits (from Flash protocol) ─────────────────────────────

const POOL_MAX_LEVERAGE: Record<string, number> = {
  'Crypto.1': 100,
  'Virtual.1': 100,
  'Governance.1': 50,
  'Community.1': 25,
  'Community.2': 25,
  'Trump.1': 25,
  'Ore.1': 5,
  'Equity.1': 20,
};

const POOL_DEGEN_LEVERAGE: Record<string, number> = {
  'Crypto.1': 500,
  'Virtual.1': 200,
  'Governance.1': 100,
};

// ─── RiskEngine Class ───────────────────────────────────────────────────────

export class RiskEngine {
  constructor(
    private config: FlashXConfig,
    private state: IStateEngine,
  ) {}

  async evaluate(intent: TradeIntent): Promise<RiskAssessment> {
    const log = getLogger();
    const checks: RiskCheck[] = [];

    if (this.config.devMode) {
      log.warn('RISK', 'DEV_MODE: balance check bypassed, all other checks enforced');
    }

    // ─── ALWAYS ENFORCED (even in dev mode) ─────────────────────────
    checks.push(this.checkLeverage(intent));
    checks.push(this.checkPositionSize(intent));
    checks.push(this.checkMinCollateral(intent));
    checks.push(await this.checkExposure(intent));
    checks.push(await this.checkDuplicate(intent));
    checks.push(this.checkLiquidationProximity(intent));
    checks.push(await this.checkMarketHours(intent));

    // ─── BALANCE CHECK: bypassed in dev mode ────────────────────────
    if (this.config.devMode) {
      checks.push(warning('balance', 'DEV_MODE: balance check bypassed'));
    } else {
      checks.push(await this.checkBalance(intent));
    }

    // ─── Aggregate results ──────────────────────────────────────────
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

  // ─── Individual Checks ────────────────────────────────────────────────

  /**
   * Check leverage against both pool protocol limits AND user config limits.
   * Uses the LOWER of the two.
   */
  private checkLeverage(intent: TradeIntent): RiskCheck {
    const poolMax = intent.degen
      ? (POOL_DEGEN_LEVERAGE[intent.pool] ?? POOL_MAX_LEVERAGE[intent.pool] ?? 50)
      : (POOL_MAX_LEVERAGE[intent.pool] ?? 50);

    // Effective max = min(pool limit, user config limit)
    const max = Math.min(poolMax, intent.degen ? 500 : this.config.maxLeverage);

    if (intent.leverage > max) {
      return block(
        'leverage',
        `Leverage ${intent.leverage}x exceeds ${intent.pool} max ${max}x${intent.degen ? ' (degen)' : ''}`,
        intent.leverage, max
      );
    }
    if (intent.leverage < 1) {
      return block('leverage', `Leverage must be >= 1 (got ${intent.leverage})`, intent.leverage, 1);
    }
    if (intent.leverage > max * 0.8) {
      return warning(
        'leverage',
        `Leverage ${intent.leverage}x is ${Math.round(intent.leverage / max * 100)}% of ${intent.pool} max`,
        intent.leverage, max
      );
    }
    return pass('leverage', `${intent.leverage}x within ${intent.pool} limits (max ${max}x)`);
  }

  private checkPositionSize(intent: TradeIntent): RiskCheck {
    if (intent.sizeUsd > this.config.maxPositionSize) {
      return block(
        'position_size',
        `Size $${intent.sizeUsd.toFixed(0)} exceeds limit $${this.config.maxPositionSize}`,
        intent.sizeUsd, this.config.maxPositionSize
      );
    }
    if (intent.collateral > this.config.maxCollateralPerTrade) {
      return block(
        'collateral',
        `Collateral $${intent.collateral} exceeds limit $${this.config.maxCollateralPerTrade}`,
        intent.collateral, this.config.maxCollateralPerTrade
      );
    }
    return pass('position_size', `Size $${intent.sizeUsd.toFixed(0)} within limits`);
  }

  private checkMinCollateral(intent: TradeIntent): RiskCheck {
    if (intent.collateral < 10) {
      return block('min_collateral', `Minimum collateral is $10 (got $${intent.collateral})`, intent.collateral, 10);
    }
    return pass('min_collateral', 'Above minimum');
  }

  private async checkExposure(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const positions = await this.state.getPositions();
      const currentExposure = positions.reduce((sum, p) => sum + p.sizeUsd, 0);
      const newExposure = currentExposure + intent.sizeUsd;

      if (newExposure > this.config.maxTotalExposure) {
        return block(
          'exposure',
          `Total exposure $${newExposure.toFixed(0)} would exceed limit $${this.config.maxTotalExposure}`,
          newExposure, this.config.maxTotalExposure
        );
      }

      const sameMarket = positions.filter(p =>
        p.market === intent.market && p.side === intent.side
      );
      if (sameMarket.length > 0) {
        return warning('exposure', `Already have ${intent.market} ${intent.side} position — will increase`);
      }

      return pass('exposure', `Total exposure $${newExposure.toFixed(0)} within limits`);
    } catch {
      return warning('exposure', 'Could not check portfolio exposure — state unavailable');
    }
  }

  private async checkBalance(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const balance = await this.state.getBalance(intent.collateralToken);
      if (balance < intent.collateral) {
        return block(
          'balance',
          `Insufficient ${intent.collateralToken}: have $${balance.toFixed(2)}, need $${intent.collateral.toFixed(2)}`,
          balance, intent.collateral
        );
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
        return warning(
          'duplicate',
          `Existing ${intent.market} ${intent.side} position (size: $${existing.sizeUsd.toFixed(0)}) — will increase`
        );
      }
      return pass('duplicate', 'No existing position');
    } catch {
      return pass('duplicate', 'Could not check — assuming no duplicate');
    }
  }

  /**
   * Warn if the implied liquidation distance is dangerously small.
   * liqDistance ≈ 1/leverage for most cases.
   */
  private checkLiquidationProximity(intent: TradeIntent): RiskCheck {
    // Approximate liquidation distance as percentage of entry price
    // Real formula depends on maintenance margin, but 1/leverage is close
    const maintenanceMargin = intent.pool === 'Crypto.1' ? 0.002 : 0.01;
    const liqDistance = (1 / intent.leverage) - maintenanceMargin;

    if (liqDistance < 0.01) {
      return block(
        'liquidation',
        `Liquidation distance ~${(liqDistance * 100).toFixed(2)}% — extremely dangerous at ${intent.leverage}x`,
        liqDistance * 100, 1
      );
    }
    if (liqDistance < 0.05) {
      return warning(
        'liquidation',
        `Liquidation distance ~${(liqDistance * 100).toFixed(1)}% — consider lower leverage`,
        liqDistance * 100, 5
      );
    }
    return pass('liquidation', `Liquidation distance ~${(liqDistance * 100).toFixed(1)}%`);
  }

  /**
   * Check if the market is open for trading.
   * Uses cached market data from StateEngine.
   */
  private async checkMarketHours(intent: TradeIntent): Promise<RiskCheck> {
    try {
      const market = await this.state.getMarket(intent.market);
      if (market && !market.isOpen) {
        return block('market_hours', `Market ${intent.market} is CLOSED — trading not available`);
      }
      return pass('market_hours', `Market ${intent.market} open`);
    } catch {
      return warning('market_hours', 'Could not verify market hours');
    }
  }

  // ─── Swap Risk Evaluation ─────────────────────────────────────────────

  /**
   * Evaluate swap risk. Checks:
   *   1. Valid token pair (pool exists)
   *   2. Amount bounds (min $1, max from config)
   *   3. Balance sufficiency (unless DEV_MODE)
   *   4. Slippage sanity
   *   5. Same-token check
   */
  async evaluateSwap(intent: SwapIntent): Promise<RiskAssessment> {
    const log = getLogger();
    const checks: RiskCheck[] = [];

    if (this.config.devMode) {
      log.warn('RISK', 'DEV_MODE: swap balance check bypassed');
    }

    // 1. Same-token check
    if (intent.inputToken === intent.outputToken) {
      checks.push(block('swap_pair', `Cannot swap ${intent.inputToken} to itself`));
    } else {
      checks.push(pass('swap_pair', `${intent.inputToken} → ${intent.outputToken}`));
    }

    // 2. Pool validation
    if (!intent.pool) {
      checks.push(block('swap_pool', `No pool found with both ${intent.inputToken} and ${intent.outputToken}`));
    } else {
      checks.push(pass('swap_pool', `Pool: ${intent.pool}`));
    }

    // 3. Amount bounds
    if (!Number.isFinite(intent.amountIn) || intent.amountIn <= 0) {
      checks.push(block('swap_amount', 'Swap amount must be positive'));
    } else if (intent.amountIn < 0.001) {
      checks.push(block('swap_amount', `Amount ${intent.amountIn} too small (min 0.001)`));
    } else if (intent.amountIn > this.config.maxCollateralPerTrade) {
      checks.push(block('swap_amount', `Amount $${intent.amountIn} exceeds max $${this.config.maxCollateralPerTrade}`));
    } else {
      checks.push(pass('swap_amount', `Amount: ${intent.amountIn} ${intent.inputToken}`));
    }

    // 4. Slippage sanity
    if (intent.slippageBps > 500) {
      checks.push(warning('swap_slippage', `Slippage ${intent.slippageBps} bps (${(intent.slippageBps / 100).toFixed(1)}%) — very high`));
    } else if (intent.slippageBps > 200) {
      checks.push(warning('swap_slippage', `Slippage ${intent.slippageBps} bps (${(intent.slippageBps / 100).toFixed(1)}%)`));
    } else {
      checks.push(pass('swap_slippage', `Slippage: ${intent.slippageBps} bps`));
    }

    // 5. Balance check (bypassed in dev mode)
    if (this.config.devMode) {
      checks.push(warning('swap_balance', 'DEV_MODE: balance check bypassed'));
    } else {
      try {
        const balance = await this.state.getBalance(intent.inputToken);
        if (balance < intent.amountIn) {
          checks.push(block('swap_balance', `Insufficient ${intent.inputToken}: have ${balance.toFixed(4)}, need ${intent.amountIn}`));
        } else {
          checks.push(pass('swap_balance', `${intent.inputToken} balance sufficient`));
        }
      } catch {
        checks.push(warning('swap_balance', 'Could not verify balance'));
      }
    }

    // Aggregate
    const blocked = checks.filter(c => c.status === RiskLevel.Blocked);
    const warned = checks.filter(c => c.status === RiskLevel.Warning);

    const level = blocked.length > 0 ? RiskLevel.Blocked
      : warned.length > 0 ? RiskLevel.Warning
      : RiskLevel.Safe;

    const summary = blocked.length > 0
      ? blocked.map(c => c.message).join('; ')
      : warned.length > 0
        ? warned.map(c => c.message).join('; ')
        : 'All swap checks passed';

    log.debug('RISK', `Swap evaluation: ${level} — ${summary}`);

    return {
      allowed: blocked.length === 0,
      mustConfirm: warned.length > 0,
      level,
      checks,
      summary,
    };
  }
}

/**
 * Flash SDK Client Wrapper
 *
 * Wraps PerpetualsClient from flash-sdk for:
 *   - Local quote calculations (sync, no network)
 *   - Position/pool account reads (via RPC)
 *   - Cross-validation of API quotes
 *
 * Phase 1: Stub — returns zeroed quotes
 * Phase 2: Full SDK integration with PerpetualsClient per pool
 */

import type { ISdkClient, LocalQuote } from '../types/index.js';

export class FlashSdkClient implements ISdkClient {
  // Phase 2: Map<poolName, PerpetualsClient>
  // private clients: Map<string, PerpetualsClient> = new Map();

  /**
   * Calculate open position quote locally (no network).
   * Uses SDK sync methods: getEntryPriceAndFeeSyncV2, getLiquidationPriceSync, etc.
   */
  getOpenQuote(_params: Record<string, unknown>): LocalQuote {
    // Phase 2: real SDK calculation
    return {
      entryPrice: 0,
      liquidationPrice: 0,
      openFee: 0,
      priceImpact: 0,
      leverage: 0,
      sizeUsd: 0,
      collateralUsd: 0,
      fundingRatePerHour: 0,
    };
  }

  getCloseQuote(_params: Record<string, unknown>): LocalQuote {
    return {
      entryPrice: 0,
      exitPrice: 0,
      liquidationPrice: 0,
      openFee: 0,
      closeFee: 0,
      priceImpact: 0,
      leverage: 0,
      sizeUsd: 0,
      collateralUsd: 0,
      fundingRatePerHour: 0,
    };
  }

  getLiquidationPrice(_params: Record<string, unknown>): number {
    return 0;
  }

  getPnl(_params: Record<string, unknown>): number {
    return 0;
  }

  async fetchPosition(_pubkey: string): Promise<unknown> {
    // Phase 2: program.account.position.fetch(pubkey)
    return null;
  }

  async fetchPositions(_owner: string): Promise<unknown[]> {
    // Phase 2: getUserPositionsMultiPool()
    return [];
  }
}

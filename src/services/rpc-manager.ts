/**
 * Solana RPC Manager
 *
 * Multi-endpoint with health monitoring, failover, and slot lag detection.
 *
 * Phase 1: Single endpoint stub
 * Phase 2: Full failover with slot lag detection from flash-terminal patterns
 */

import type { IRpcManager, FlashXConfig } from '../types/index.js';

export class RpcManager implements IRpcManager {
  private endpoints: string[];
  private _activeIndex = 0;

  constructor(config: FlashXConfig) {
    this.endpoints = [config.rpcUrl];
    if (config.rpcBackupUrl) {
      this.endpoints.push(config.rpcBackupUrl);
    }
  }

  get activeEndpoint(): string {
    return this.endpoints[this._activeIndex];
  }

  /**
   * Send a signed transaction (base64) via RPC.
   * Phase 2: sendRawTransaction with retry + multi-endpoint broadcast
   */
  async sendTransaction(_txBase64: string): Promise<string> {
    // Phase 2 implementation:
    // 1. Deserialize base64 → VersionedTransaction
    // 2. sendRawTransaction to all healthy endpoints
    // 3. Return first signature
    throw new Error('RPC sendTransaction not yet implemented — Phase 2');
  }

  /**
   * Confirm a transaction by polling signature status.
   * Phase 2: getSignatureStatuses polling + periodic resend
   */
  async confirmTransaction(_signature: string, _timeout?: number): Promise<boolean> {
    throw new Error('RPC confirmTransaction not yet implemented — Phase 2');
  }

  /**
   * Check slot health across endpoints.
   * Phase 2: Compare getSlot() across endpoints, detect lag
   */
  async getSlotHealth(): Promise<{ slot: number; lag: number }> {
    // Phase 1: stub
    return { slot: 0, lag: 0 };
  }
}

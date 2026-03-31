#!/usr/bin/env node

/**
 * flash — Protocol-grade CLI for Flash.trade
 *
 * Architecture:
 *   CLI → Router → Parser → ExecutionEngine → RiskEngine → StateEngine → Services
 *
 * Entry modes:
 *   1. Interactive REPL (default)
 *   2. Single command: flash "long sol 10x 100"
 */

import { loadConfig } from './config/index.js';
import { StateEngine } from './core/state-engine.js';
import { ExecutionEngine } from './core/execution-engine.js';
import { CommandRouter } from './cli/router.js';
import { Repl } from './cli/repl.js';
import { FlashApiClient } from './services/api-client.js';
import { FlashSdkClient } from './services/sdk-client.js';
import { RpcManager } from './services/rpc-manager.js';
import { WalletManager } from './wallet/manager.js';
import { TxPipeline } from './tx/pipeline.js';
import { getLogger } from './utils/logger.js';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();
  const log = getLogger();

  // Initialize services
  const api = new FlashApiClient(config);
  const sdk = new FlashSdkClient(config);
  const rpcManager = new RpcManager(config);
  const wallet = new WalletManager(config);

  // Try to load wallet if keypair path is configured
  if (config.keypairPath) {
    try {
      wallet.loadFromFile();
    } catch (e) {
      log.warn('BOOT', `Wallet load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Initialize state engine with real services
  const state = new StateEngine();
  state.setApiClient(api);
  state.setWallet(wallet);

  // Initialize tx pipeline with RPC manager's connection
  const txPipeline = new TxPipeline(rpcManager.connection, config);

  // Start RPC health monitoring
  rpcManager.startHealthMonitor();

  // Initialize execution engine (with RPC manager for health display)
  const execution = new ExecutionEngine(config, state, api, sdk, wallet, txPipeline, rpcManager);
  const router = new CommandRouter(execution);

  // Single command mode
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const input = args.join(' ');
    const output = await router.route(input);
    if (output) console.log(output);
    rpcManager.stopHealthMonitor();
    process.exit(0);
  }

  // Interactive REPL
  const repl = new Repl(router, config);

  const cleanup = () => {
    rpcManager.stopHealthMonitor();
    repl.stop();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', (e) => {
    log.error('FATAL', e.message);
    rpcManager.stopHealthMonitor();
    process.exit(1);
  });

  await repl.start();
}

main().catch((e) => {
  console.error(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

#!/usr/bin/env node

/**
 * flash — Protocol-grade CLI for Flash.trade
 *
 * Architecture:
 *   CLI → ModeSelector → Router → Parser → ExecutionEngine → RiskEngine → StateEngine → Services
 *
 * Entry modes:
 *   1. Interactive REPL (default) — with mode selection prompt
 *   2. Single command: flash "long sol 10x 100" — uses env mode
 */

import { loadConfig } from './config/index.js';
import { StateEngine } from './core/state-engine.js';
import { ExecutionEngine } from './core/execution-engine.js';
import { CommandRouter } from './cli/router.js';
import { Repl } from './cli/repl.js';
import { selectMode } from './cli/mode-selector.js';
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

  // Try to load wallet: KEYPAIR_PATH → WalletStore default → auto-detect
  if (config.keypairPath) {
    try {
      wallet.loadFromFile();
    } catch (e) {
      log.warn('BOOT', `KEYPAIR_PATH wallet failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (!wallet.isConnected) {
    // Try WalletStore
    const { WalletStore } = await import('./wallet/store.js');
    const store = new WalletStore();
    const defaultName = store.getDefault();
    if (defaultName) {
      try {
        const entry = store.get(defaultName);
        if (entry) {
          wallet.loadFromFile(entry.path);
          log.info('BOOT', `Loaded wallet "${defaultName}": ${wallet.shortAddress}`);
        }
      } catch (e) {
        log.debug('BOOT', `WalletStore default failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Auto-detect system keypair
    if (!wallet.isConnected) {
      const detected = store.autoDetect();
      if (detected) {
        try {
          wallet.loadFromFile(detected.path);
          log.info('BOOT', `Auto-detected wallet: ${wallet.shortAddress}`);
        } catch { /* ignore */ }
      }
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

  // ─── Single command mode (uses env SIMULATION_MODE) ─────────────────
  const args = process.argv.slice(2);
  if (args.length > 0) {
    const execution = new ExecutionEngine(config, state, api, sdk, wallet, txPipeline, rpcManager);
    const router = new CommandRouter(execution);
    const input = args.join(' ');
    const output = await router.route(input);
    if (output) console.log(output);
    rpcManager.stopHealthMonitor();
    process.exit(0);
  }

  // ─── Interactive mode: prompt for mode selection ────────────────────
  const selectedMode = await selectMode(config, wallet);

  // Apply selected mode to config (mutable override)
  config.simulationMode = selectedMode === 'simulation';

  // Initialize execution engine with final config
  const execution = new ExecutionEngine(config, state, api, sdk, wallet, txPipeline, rpcManager);
  const router = new CommandRouter(execution);

  // Interactive REPL
  const repl = new Repl(router, config, selectedMode);

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

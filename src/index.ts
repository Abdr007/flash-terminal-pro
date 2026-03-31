#!/usr/bin/env node

/**
 * flash-x — Protocol-grade CLI for Flash.trade
 *
 * Architecture:
 *   CLI → Router → Parser → ExecutionEngine → RiskEngine → StateEngine → Services
 *
 * Entry modes:
 *   1. Interactive REPL (default)
 *   2. Single command: flash-x "long sol 10x 100"
 */

import { loadConfig } from './config/index.js';
import { StateEngine } from './core/state-engine.js';
import { ExecutionEngine } from './core/execution-engine.js';
import { CommandRouter } from './cli/router.js';
import { Repl } from './cli/repl.js';

// ─── Bootstrap ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  // Initialize engines
  const state = new StateEngine();
  const execution = new ExecutionEngine(config, state);
  const router = new CommandRouter(execution);

  // Check if a command was passed as argument
  const args = process.argv.slice(2);
  if (args.length > 0) {
    // Single command mode: flash-x "long sol 10x 100"
    const input = args.join(' ');
    const output = await router.route(input);
    if (output) console.log(output);
    process.exit(0);
  }

  // Interactive REPL mode
  const repl = new Repl(router, config);

  // Graceful shutdown
  process.on('SIGINT', () => repl.stop());
  process.on('SIGTERM', () => repl.stop());
  process.on('uncaughtException', (err) => {
    console.error(`\n  Fatal: ${err.message}`);
    process.exit(1);
  });

  await repl.start();
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

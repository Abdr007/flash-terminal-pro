/**
 * Interactive REPL
 *
 * Readline-based interactive terminal with:
 *   - Command history
 *   - Tab completion (Phase 2)
 *   - Graceful shutdown
 *   - Error isolation (one bad command doesn't kill the REPL)
 */

import { createInterface, type Interface } from 'readline';
import chalk from 'chalk';
import { CommandRouter } from './router.js';
import { accentBold, dim } from '../utils/format.js';
import type { FlashXConfig } from '../types/index.js';

export class Repl {
  private rl: Interface | null = null;
  private running = false;

  constructor(
    private router: CommandRouter,
    private config: FlashXConfig,
  ) {}

  /**
   * Start the interactive REPL loop.
   */
  async start(): Promise<void> {
    this.running = true;

    // Banner
    console.log('');
    console.log(`  ${accentBold('flash-x')} ${dim('v0.1.0')}`);
    console.log(`  ${dim('Protocol-grade CLI for Flash.trade')}`);
    console.log('');

    const mode = this.config.simulationMode
      ? chalk.yellow('SIMULATION')
      : chalk.green('LIVE');
    console.log(`  ${dim('Mode:')}    ${mode}`);
    console.log(`  ${dim('Network:')} ${this.config.network}`);
    console.log(`  ${dim('Type "help" for commands')}`);
    console.log('');

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${chalk.cyan('flash-x')}${chalk.dim('>')} `,
      historySize: 200,
    });

    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const input = line.trim();

      if (!input) {
        this.rl?.prompt();
        return;
      }

      // Exit commands
      if (['exit', 'quit', 'q'].includes(input.toLowerCase())) {
        this.stop();
        return;
      }

      try {
        const output = await this.router.route(input);
        if (output) {
          console.log(output);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`  Error: ${msg}`));
      }

      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      this.stop();
    });

    // Keep the process alive
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!this.running) {
          clearInterval(check);
          resolve();
        }
      }, 100);
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    console.log('');
    console.log(dim('  Goodbye.'));
    console.log('');
    this.rl?.close();
    process.exit(0);
  }
}

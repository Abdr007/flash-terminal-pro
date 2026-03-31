/**
 * Interactive REPL
 *
 * Readline-based interactive terminal with:
 *   - Command history
 *   - Mode-aware prompt (SIM vs LIVE)
 *   - Graceful shutdown
 *   - Error isolation
 */

import { createInterface, type Interface } from 'readline';
import chalk from 'chalk';
import { CommandRouter } from './router.js';
import { dim } from '../utils/format.js';
import type { FlashXConfig } from '../types/index.js';
import type { SelectedMode } from './mode-selector.js';

export class Repl {
  private rl: Interface | null = null;
  private running = false;

  constructor(
    private router: CommandRouter,
    private config: FlashXConfig,
    private mode: SelectedMode = 'simulation',
  ) {}

  async start(): Promise<void> {
    this.running = true;

    // Mode-specific status line
    if (this.mode === 'live') {
      console.log(`  ${chalk.green.bold('●')} ${chalk.green('LIVE')} ${dim('— real trades active')}`);
    } else {
      console.log(`  ${chalk.yellow('●')} ${chalk.yellow('SIMULATION')} ${dim('— no real trades')}`);
    }

    if (this.config.devMode) {
      console.log(`  ${dim('Dev:')}     ${chalk.magenta.bold('DEV_MODE ACTIVE')}`);
    }
    console.log(`  ${dim('Type "help" for commands')}`);
    console.log('');

    // Mode-aware prompt
    const promptStr = this.mode === 'live'
      ? `${chalk.green('flash')}${chalk.green.bold('●')}${chalk.dim('>')} `
      : `${chalk.cyan('flash')}${chalk.dim('>')} `;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: promptStr,
      historySize: 200,
    });

    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const input = line.trim();

      if (!input) {
        this.rl?.prompt();
        return;
      }

      if (['exit', 'quit', 'q'].includes(input.toLowerCase())) {
        this.stop();
        return;
      }

      try {
        const output = await this.router.route(input);
        if (output) console.log(output);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`  Error: ${msg}`));
      }

      this.rl?.prompt();
    });

    this.rl.on('close', () => {
      this.stop();
    });

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

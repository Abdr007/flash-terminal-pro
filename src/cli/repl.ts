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
    _config: FlashXConfig,
    private mode: SelectedMode = 'simulation',
  ) { void _config; }

  async start(): Promise<void> {
    this.running = true;

    // Prompt matches flash-terminal: "flash [live] > " or "flash [sim] > "
    const modeTag = this.mode === 'live' ? chalk.green('live') : chalk.yellow('sim');
    const promptStr = `${chalk.hex('#00FF88')('flash')} ${chalk.dim('[')}${modeTag}${chalk.dim(']')} ${chalk.dim('>')} `;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: promptStr,
      historySize: 200,
    });

    // Give execution engine access to readline for monitor/TUI commands
    const eng = (this.router as unknown as { engine: { rl: Interface | null } }).engine;
    eng.rl = this.rl;

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

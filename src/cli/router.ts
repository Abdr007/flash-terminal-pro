/**
 * Command Router
 *
 * Connects the parser pipeline to the execution engine.
 * Handles the full flow:
 *   raw input → parse → execute → display result
 */

import { parse, parseSync } from '../parser/index.js';
import { ExecutionEngine } from '../core/execution-engine.js';
import { Action, type ParsedCommand, type TxResult } from '../types/index.js';

export class CommandRouter {
  constructor(private engine: ExecutionEngine) {}

  /**
   * Route a raw input string through the full pipeline.
   * Returns the formatted output string to display.
   */
  async route(rawInput: string): Promise<string> {
    // Fast path: try sync parse first (regex + intent, no AI latency)
    let command: ParsedCommand = parseSync(rawInput);

    // If sync parse failed, try async (includes AI fallback)
    if (command.action === Action.Unknown) {
      command = await parse(rawInput);
    }

    const result: TxResult = await this.engine.execute(command);

    // The error field is used as a display string (legacy naming from flash-terminal)
    return result.error ?? (result.success ? '' : 'Unknown error');
  }
}

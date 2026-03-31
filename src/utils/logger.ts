/**
 * Structured Logger
 *
 * Timestamped, color-coded, leveled logging.
 * Used across all engines and services.
 */

import chalk from 'chalk';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Success = 4,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  [LogLevel.Debug]: chalk.gray('DBG'),
  [LogLevel.Info]: chalk.blue('INF'),
  [LogLevel.Warn]: chalk.yellow('WRN'),
  [LogLevel.Error]: chalk.red('ERR'),
  [LogLevel.Success]: chalk.green('OK '),
};

class Logger {
  private minLevel: LogLevel;

  constructor(minLevel: LogLevel = LogLevel.Info) {
    this.minLevel = minLevel;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private log(level: LogLevel, module: string, message: string, data?: unknown): void {
    if (level < this.minLevel) return;

    const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
    const label = LEVEL_LABELS[level];
    const mod = chalk.cyan(module.padEnd(8));
    const line = `  ${chalk.dim(ts)} ${label} ${mod} ${message}`;

    if (level >= LogLevel.Error) {
      console.error(line);
    } else {
      console.log(line);
    }

    if (data !== undefined && this.minLevel <= LogLevel.Debug) {
      console.log(chalk.dim(`  ${''.padEnd(13)} ${''.padEnd(4)} ${''.padEnd(9)} ${JSON.stringify(data)}`));
    }
  }

  debug(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Debug, module, message, data);
  }

  info(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Info, module, message, data);
  }

  warn(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Warn, module, message, data);
  }

  error(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Error, module, message, data);
  }

  success(module: string, message: string, data?: unknown): void {
    this.log(LogLevel.Success, module, message, data);
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _logger: Logger | null = null;

export function getLogger(): Logger {
  if (!_logger) {
    const envLevel = process.env['LOG_LEVEL']?.toLowerCase();
    let level = LogLevel.Info;
    if (envLevel === 'debug') level = LogLevel.Debug;
    if (envLevel === 'warn') level = LogLevel.Warn;
    if (envLevel === 'error') level = LogLevel.Error;
    _logger = new Logger(level);
  }
  return _logger;
}

export { Logger };

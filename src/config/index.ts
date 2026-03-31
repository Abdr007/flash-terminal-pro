/**
 * Configuration loader
 *
 * Priority: env vars > ~/.flash-x/config.json > defaults
 */

import dotenv from 'dotenv';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import type { FlashXConfig } from '../types/index.js';

// Load .env from cwd, then ~/.flash-x/.env
const envPaths = [
  resolve(process.cwd(), '.env'),
  resolve(homedir(), '.flash-x', '.env'),
];
for (const p of envPaths) {
  if (existsSync(p)) dotenv.config({ path: p });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function env(key: string): string | undefined {
  return process.env[key];
}

function envInt(key: string, fallback: number): number {
  const v = env(key);
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key)?.toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return fallback;
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith('~/')) return resolve(homedir(), filepath.slice(2));
  if (filepath === '~') return homedir();
  return resolve(filepath);
}

// ─── RPC URL Validation ─────────────────────────────────────────────────────

export function validateRpcUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL: ${url}`);
  }

  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error(`RPC URL must use HTTPS (got ${parsed.protocol})`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('RPC URL must not contain embedded credentials');
  }

  // Block private/metadata IPs (SSRF protection)
  const host = parsed.hostname;
  if (!isLocal) {
    if (
      host.startsWith('169.254.') || host.startsWith('10.') ||
      host.startsWith('192.168.') || host === '0.0.0.0' ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      throw new Error(`RPC URL points to a private IP (${host})`);
    }
  }

  return url;
}

// ─── Config File ────────────────────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), '.flash-x');
const CONFIG_FILE = resolve(CONFIG_DIR, 'config.json');

function loadConfigFile(): Record<string, unknown> {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

export function ensureConfigDir(): string {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  return CONFIG_DIR;
}

export function saveConfigValue(key: string, value: string): void {
  ensureConfigDir();
  const existing = loadConfigFile();
  existing[key] = value;
  writeFileSync(CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
}

// ─── Build Config ───────────────────────────────────────────────────────────

let _config: FlashXConfig | null = null;

export function loadConfig(): FlashXConfig {
  if (_config) return _config;

  const file = loadConfigFile();

  const rpcUrl = (env('RPC_URL') ?? file['rpcUrl'] as string | undefined) ?? '';
  if (rpcUrl) validateRpcUrl(rpcUrl);

  const rpcBackup = env('RPC_BACKUP_URL') ?? (file['rpcBackupUrl'] as string | undefined);
  if (rpcBackup) validateRpcUrl(rpcBackup);

  _config = {
    rpcUrl: rpcUrl || 'https://api.mainnet-beta.solana.com',
    rpcBackupUrl: rpcBackup,
    network: (env('NETWORK') ?? file['network'] as string | undefined) === 'devnet' ? 'devnet' : 'mainnet-beta',
    flashApiUrl: env('FLASH_API_URL') ?? (file['flashApiUrl'] as string | undefined) ?? 'https://flashapi.trade',

    keypairPath: env('KEYPAIR_PATH') ? resolveHome(env('KEYPAIR_PATH')!) : undefined,
    simulationMode: envBool('SIMULATION_MODE', true),
    devMode: envBool('DEV_MODE', false),

    maxLeverage: envInt('MAX_LEVERAGE', 50),
    maxCollateralPerTrade: envInt('MAX_COLLATERAL_PER_TRADE', 1000),
    maxPositionSize: envInt('MAX_POSITION_SIZE', 50000),
    maxTotalExposure: envInt('MAX_TOTAL_EXPOSURE', 100000),

    maxTradesPerMinute: envInt('MAX_TRADES_PER_MINUTE', 10),
    minDelayBetweenTradesMs: envInt('MIN_DELAY_BETWEEN_TRADES_MS', 3000),
    defaultSlippageBps: envInt('DEFAULT_SLIPPAGE_BPS', 80),

    computeUnitLimit: envInt('COMPUTE_UNIT_LIMIT', 600_000),
    computeUnitPrice: envInt('COMPUTE_UNIT_PRICE', 50_000),

    groqApiKey: env('GROQ_API_KEY'),
  };

  return _config;
}

/** Reset config cache — for testing */
export function resetConfig(): void {
  _config = null;
}

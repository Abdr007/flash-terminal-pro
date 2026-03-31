/**
 * Wallet Store
 *
 * Registry of named wallets stored in ~/.flash-x/wallets.json.
 * Only stores: { name, path, address } — never stores key material.
 *
 * Ported from flash-terminal's WalletStore pattern.
 */

import {
  mkdirSync, writeFileSync, readFileSync, existsSync,
  statSync, lstatSync, realpathSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Keypair } from '@solana/web3.js';

const FLASH_DIR = join(homedir(), '.flash-x');
const REGISTRY_FILE = join(FLASH_DIR, 'wallets.json');

// Well-known default keypair locations
const DEFAULT_KEYPAIR_PATHS = [
  join(homedir(), '.config', 'solana', 'id.json'),
];

interface WalletEntry {
  name: string;
  path: string;
  address: string;
}

interface WalletRegistry {
  wallets: WalletEntry[];
  defaultWallet?: string;
}

function ensureDir(): void {
  if (!existsSync(FLASH_DIR)) {
    mkdirSync(FLASH_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadRegistry(): WalletRegistry {
  try {
    if (!existsSync(REGISTRY_FILE)) return { wallets: [] };
    const raw = readFileSync(REGISTRY_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj['wallets'])) return parsed as WalletRegistry;
    }
    return { wallets: [] };
  } catch {
    return { wallets: [] };
  }
}

function saveRegistry(registry: WalletRegistry): void {
  ensureDir();
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean || clean.length > 64) {
    throw new Error('Wallet name must be 1-64 alphanumeric/hyphen/underscore characters');
  }
  return clean;
}

export class WalletStore {
  /** Validate wallet file path for security */
  validatePath(filePath: string): string {
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    const resolved = filePath.startsWith('~')
      ? join(home, filePath.slice(1).replace(/^\//, ''))
      : join(filePath);

    if (!existsSync(resolved)) {
      throw new Error(`Wallet file not found: ${resolved}`);
    }

    // Symlink check
    const realPath = realpathSync(resolved);
    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error('Wallet path resolves outside home directory');
    }

    // Size check
    const stats = statSync(realPath);
    if (stats.size > 1024) {
      throw new Error(`File too large (${stats.size} bytes). Expected keypair JSON (<1KB).`);
    }

    // Symlink detection
    const lstats = lstatSync(resolved);
    if (lstats.isSymbolicLink()) {
      // Allowed if realpath is inside home (checked above)
    }

    // Permission check
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(`Insecure permissions (${mode.toString(8)}). Run: chmod 600 "${realPath}"`);
    }

    return realPath;
  }

  /** Register a wallet by file path. Derives address, stores only metadata. */
  register(name: string, filePath: string): { address: string; path: string } {
    const safeName = sanitizeName(name);
    const realPath = this.validatePath(filePath);

    const registry = loadRegistry();
    if (registry.wallets.some(w => w.name === safeName)) {
      throw new Error(`Wallet "${safeName}" already exists.`);
    }

    // Read keypair to derive address
    const raw = readFileSync(realPath, 'utf-8');
    const secretKey = JSON.parse(raw) as unknown;
    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      throw new Error('Invalid keypair: expected 64-byte JSON array');
    }

    const keyBytes = Uint8Array.from(secretKey as number[]);
    (secretKey as number[]).fill(0);

    const keypair = Keypair.fromSecretKey(keyBytes);
    const address = keypair.publicKey.toBase58();

    // Zero — we only needed the address
    try { keypair.secretKey.fill(0); } catch { /* best effort */ }

    registry.wallets.push({ name: safeName, path: realPath, address });
    saveRegistry(registry);

    return { address, path: realPath };
  }

  /** List all registered wallet names */
  list(): string[] {
    return loadRegistry().wallets.map(w => w.name);
  }

  /** Get wallet entry by name */
  get(name: string): WalletEntry | undefined {
    return loadRegistry().wallets.find(w => w.name === name);
  }

  /** Get the file path for a named wallet */
  getPath(name: string): string {
    const entry = this.get(name);
    if (!entry) throw new Error(`Wallet "${name}" not found`);
    return entry.path;
  }

  /** Get/set default wallet */
  getDefault(): string | undefined {
    return loadRegistry().defaultWallet;
  }

  setDefault(name: string): void {
    const registry = loadRegistry();
    if (!registry.wallets.some(w => w.name === name)) {
      throw new Error(`Wallet "${name}" not found`);
    }
    registry.defaultWallet = name;
    saveRegistry(registry);
  }

  /** Auto-detect system keypair if no wallets registered */
  autoDetect(): { name: string; path: string } | null {
    for (const path of DEFAULT_KEYPAIR_PATHS) {
      try {
        if (existsSync(path)) {
          const stats = statSync(path);
          if (stats.size <= 1024 && stats.size > 0) {
            return { name: 'default', path };
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }
}

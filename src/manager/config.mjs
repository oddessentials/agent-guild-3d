// Filesystem locations, the auth token, and the runtime discovery file.
//
// Everything lives in one per-user directory so that other clients (the
// launcher CLI, the agent reporter, a future Unreal Engine front end) can find
// a running manager without being told its port or token.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 47821;
export const DEFAULT_HOST = '127.0.0.1';
/** The package.json the manager runs from; an upgrade replaces it in place. */
export const PACKAGE_FILE = fileURLToPath(new URL('../../package.json', import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_FILE, 'utf8'));
export const VERSION = packageJson.version;
export const PACKAGE_NAME = packageJson.name;

/** Per-user data directory. Override with AGENT_GUILD_HOME (used by tests). */
export function dataDir() {
  if (process.env.AGENT_GUILD_HOME) return path.resolve(process.env.AGENT_GUILD_HOME);
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'AgentGuild');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'AgentGuild');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'agent-guild');
}

export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const paths = {
  get token() { return path.join(dataDir(), 'auth-token'); },
  get runtime() { return path.join(dataDir(), 'manager.json'); },
  get providers() { return path.join(dataDir(), 'providers.json'); },
  get accounts() { return path.join(dataDir(), 'accounts'); },
  get github() { return path.join(dataDir(), 'github'); },
  get log() { return path.join(dataDir(), 'manager.log'); },
  /** Launchers for agent-guild-report, put first on every session's PATH. */
  get shims() { return path.join(dataDir(), 'bin'); },
  get reporting() { return path.join(dataDir(), 'reporting'); },
  get reportTokens() { return path.join(dataDir(), 'report-tokens'); },
};

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  // writeFileSync only applies mode on creation; tighten an existing file too.
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on Windows */ }
}

/**
 * The API token guards every endpoint except /health. It persists across
 * manager restarts so a bookmarked page keeps working. Delete the file to
 * rotate it.
 */
export function loadOrCreateToken() {
  ensureDataDir();
  try {
    const existing = fs.readFileSync(paths.token, 'utf8').trim();
    if (/^[a-f0-9]{32,}$/.test(existing)) return existing;
  } catch { /* create below */ }
  const token = crypto.randomBytes(24).toString('hex');
  writePrivate(paths.token, token + '\n');
  return token;
}

export function writeRuntimeFile(info) {
  ensureDataDir();
  writePrivate(paths.runtime, JSON.stringify(info, null, 2) + '\n');
}

export function readRuntimeFile() {
  try {
    return JSON.parse(fs.readFileSync(paths.runtime, 'utf8'));
  } catch {
    return null;
  }
}

export function removeRuntimeFile(pid = process.pid) {
  const current = readRuntimeFile();
  if (current && current.pid !== pid) return; // another manager owns it
  try { fs.unlinkSync(paths.runtime); } catch { /* already gone */ }
}

export function resolvePort() {
  const raw = process.env.AGENT_GUILD_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENT_GUILD_PORT must be an integer between 0 and 65535, got "${raw}"`);
  }
  return port;
}

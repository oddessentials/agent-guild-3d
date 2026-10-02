// Recover the user's real PATH on macOS and Linux.
//
// An app started from Finder, the Dock, or a login item does not inherit the
// PATH that the user's shell profile builds (Homebrew, nvm, ~/.local/bin, ...),
// which is exactly where CLI coding tools usually live. Like VS Code, we ask
// the user's login shell for its PATH and merge it in.

import { execFile, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const START = '__AGENT_GUILD_PATH_START__';
const END = '__AGENT_GUILD_PATH_END__';

export function mergePathLists(primary, secondary, delimiter = path.delimiter) {
  const seen = new Set();
  const out = [];
  for (const list of [primary, secondary]) {
    for (const entry of (list || '').split(delimiter)) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(delimiter);
}

/** Pull PATH out of `env` output captured between the two markers. */
export function parsePathFromEnvOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const start = stdout.indexOf(START);
  const end = stdout.indexOf(END, start);
  if (start === -1 || end === -1) return null;
  const line = stdout.slice(start + START.length, end).split(/\r?\n/).find((l) => l.startsWith('PATH='));
  return line ? line.slice('PATH='.length) : null;
}

export function loginShellPath({ shell = process.env.SHELL, timeoutMs = 8000 } = {}) {
  if (process.platform === 'win32' || !shell) return null;
  // Read the exported PATH from `env` rather than expanding $PATH: fish, for
  // one, expands "$PATH" to a space-separated list.
  const result = spawnSync(shell, ['-l', '-i', '-c', `printf '%s' ${START}; command env; printf '%s' ${END}`], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AGENT_GUILD_RESOLVING_ENV: '1' },
  });
  if (result.error) return null;
  return parsePathFromEnvOutput(result.stdout);
}

/**
 * Returns a copy of process.env whose PATH also contains the login shell's
 * PATH entries. Set AGENT_GUILD_SKIP_SHELL_ENV=1 to disable the lookup.
 */
export function trimPathExt(env, platform = process.platform) {
  if (platform !== 'win32') return env;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATHEXT');
  if (key) env[key] = env[key].split(';').map((ext) => ext.trim()).filter(Boolean).join(';');
  return env;
}

export function resolveBaseEnv() {
  const env = trimPathExt({ ...process.env });
  if (process.env.AGENT_GUILD_SKIP_SHELL_ENV === '1') return env;
  const shellPath = loginShellPath();
  if (shellPath) env.PATH = mergePathLists(shellPath, env.PATH);
  return env;
}

export function weavePaths(current, discovered, { delimiter = path.delimiter, caseInsensitive = process.platform === 'win32' } = {}) {
  const id = (entry) => (caseInsensitive ? entry.toLowerCase() : entry).replace(/(?<=.)[\\/]+$/, '');
  const unique = (list) => {
    const seen = new Set();
    return (list || '').split(delimiter).filter((entry) => entry && !seen.has(id(entry)) && seen.add(id(entry)));
  };
  const out = unique(current);
  const fresh = unique(discovered);
  const indexOf = (entry) => out.findIndex((e) => id(e) === id(entry));
  fresh.forEach((entry, i) => {
    if (indexOf(entry) !== -1) return;
    for (let j = i - 1; j >= 0; j--) {
      const at = indexOf(fresh[j]);
      if (at !== -1) return void out.splice(at + 1, 0, entry);
    }
    for (let j = i + 1; j < fresh.length; j++) {
      const at = indexOf(fresh[j]);
      if (at !== -1) return void out.splice(at, 0, entry);
    }
    out.push(entry);
  });
  return out.join(delimiter);
}

export function parseRegValue(stdout, name = 'Path') {
  const pattern = new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'i');
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

export function expandWindowsVars(value, env) {
  return value.replace(/%([^%;]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key ? env[key] : whole;
  });
}

function queryRegistry(key, env, timeoutMs) {
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  return new Promise((resolve) => {
    execFile(path.win32.join(system32, 'reg.exe'), ['query', key, '/v', 'Path'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

export async function readWindowsPath({ env = process.env, timeoutMs = 5000, query = queryRegistry } = {}) {
  const machine = parseRegValue(await query('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', env, timeoutMs));
  if (!machine) return null;
  const user = parseRegValue(await query('HKCU\\Environment', env, timeoutMs));
  return [machine, user].filter(Boolean).map((value) => expandWindowsVars(value, env)).join(';');
}

export function readLoginShellPath({ shell = process.env.SHELL, timeoutMs = 8000 } = {}) {
  if (!shell) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = '';
    let child;
    try {
      child = spawn(shell, ['-l', '-i', '-c', `printf '%s' ${START}; command env; printf '%s' ${END}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, AGENT_GUILD_RESOLVING_ENV: '1' },
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parsePathFromEnvOutput(stdout)); });
  });
}

export function pathReader(platform = process.platform, env = process.env) {
  if (env.AGENT_GUILD_SKIP_SHELL_ENV === '1') return null;
  return platform === 'win32' ? () => readWindowsPath({ env }) : () => readLoginShellPath({ shell: env.SHELL });
}

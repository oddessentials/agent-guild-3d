// Locate a provider's command on PATH and turn it into something node-pty can
// spawn on every platform.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

function isExecutableFile(file, platform) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function windowsExtensions(env) {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const exts = raw.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
  // npm installs PowerShell shims too; accept them as a last resort.
  if (!exts.includes('.ps1')) exts.push('.ps1');
  return exts;
}

export function pathKey(env, platform = process.platform) {
  // Windows environment keys are case-insensitive ("Path" is common).
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || (platform === 'win32' ? 'Path' : 'PATH');
}

function getPath(env) {
  return env[pathKey(env)] || '';
}

function candidateGroups(command, env, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const hasExt = platform === 'win32' && p.extname(command) !== '';
  const withExts = (base) =>
    platform === 'win32' && !hasExt ? windowsExtensions(env).map((e) => base + e) : [base];

  if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) return [withExts(p.resolve(command))];
  const groups = [];
  const delimiter = platform === 'win32' ? ';' : ':';
  for (const dir of getPath(env).split(delimiter)) {
    if (!dir) continue;
    const clean = dir.replace(/^"(.*)"$/, '$1');
    groups.push(withExts(p.join(clean, command)));
  }
  return groups;
}

/**
 * Resolve `command` to an absolute path, or return null when it is not
 * installed. Commands that already contain a path separator are checked as-is.
 * `isExecutable` is injectable so tests can simulate another platform.
 */
export function resolveCommand(command, env = process.env, platform = process.platform, {
  isExecutable = (file) => isExecutableFile(file, platform),
} = {}) {
  if (!command) return null;
  for (const group of candidateGroups(command, env, platform)) {
    const hit = group.find((c) => isExecutable(c));
    if (hit) return hit;
  }
  return null;
}

export function resolveAllCommands(command, env = process.env, platform = process.platform, {
  isExecutable = (file) => isExecutableFile(file, platform),
} = {}) {
  if (!command) return [];
  const seen = new Set();
  const hits = [];
  for (const group of candidateGroups(command, env, platform)) {
    const hit = group.find((c) => isExecutable(c));
    const id = hit && (platform === 'win32' ? hit.toLowerCase() : hit);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    hits.push(hit);
  }
  return hits;
}

export function killWindowsTree(pid, done = () => {}) {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (err) => done(err));
}

/** Quote one argument for a cmd.exe command line. */
export function quoteForCmd(arg) {
  const s = String(arg);
  if (s !== '' && !/[\s"&|<>^()%!,;=]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Build the file/args pair passed to node-pty. On Windows, batch shims
 * (claude.cmd, codex.cmd, ...) must run through cmd.exe and PowerShell shims
 * through powershell.exe; ConPTY cannot execute them directly.
 */
export function buildSpawnSpec(resolvedPath, args = [], env = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: resolvedPath, args: [...args] };
  const ext = path.win32.extname(resolvedPath).toLowerCase();
  // Absolute paths: a bare name is looked up on the child's PATH, which a
  // provider's own env may not carry.
  const system32 = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32');
  if (ext === '.cmd' || ext === '.bat') {
    const comspec = env.ComSpec || env.COMSPEC || path.win32.join(system32, 'cmd.exe');
    const inner = [resolvedPath, ...args].map(quoteForCmd).join(' ');
    // A raw command-line string: /s strips the outer quotes and keeps the rest.
    return { file: comspec, args: `/d /s /c "${inner}"` };
  }
  if (ext === '.ps1') {
    return {
      file: path.win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedPath, ...args],
    };
  }
  return { file: resolvedPath, args: [...args] };
}

/**
 * Run a spawn spec to completion without a terminal. Resolves with its
 * output; rejects with the error carrying stdout and stderr.
 */
export function runSpec(spec, { env, timeoutMs = 15000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const opts = { env, cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 };
    let args = spec.args;
    if (typeof args === 'string') {
      opts.windowsVerbatimArguments = true;
      args = [args];
    }
    try {
      execFile(spec.file, args, opts, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    } catch (err) {
      reject(err);
    }
  });
}

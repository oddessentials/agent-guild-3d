// Launchers that make the bare `agent-guild-report` command work inside every
// session, without `npm link` or a global install.
//
// The coding tools run their hook commands through a shell (sh or Git Bash
// for Claude Code, a login shell for Codex CLI, bash or PowerShell for
// Gemini CLI, sh or PowerShell for Grok Build) and look the command up on
// the PATH they inherit from the terminal. The manager writes these shims
// into its data folder at every start and puts that folder first on each
// session's PATH. They run the reporter with the manager's own Node.js, and
// fall back to a `node` on the hook shell's PATH when that binary has moved
// since the manager started (a version manager switched versions).
//
// On Windows there is deliberately no .ps1 shim: PowerShell prefers a .ps1
// over the PATHEXT extensions, and the default Restricted execution policy
// refuses to run it. Gemini CLI and Grok Build run hooks in PowerShell without
// bypassing that policy, so they would fail; with only a .cmd present,
// PowerShell falls through to it and cmd.exe runs it with no policy involved.
// cmd.exe reads a batch file in the OEM code page, so no path may be written
// into the .cmd: the script's path lives in a loader module next to it, as
// an ASCII file: URL, and the Node.js path in AGENT_GUILD_NODE, which the
// manager sets in every session.

import fs from 'node:fs';
import path from 'node:path';

export const SHIM_NAME = 'agent-guild-report';
export const LOADER_NAME = 'agent-guild-report-loader.mjs';

/** Quote for double quotes in sh: backslash, double quote, dollar and backtick. */
function shQuote(value) {
  return `"${value.replace(/[\\"$`]/g, (c) => `\\${c}`)}"`;
}

/** A file: URL with every segment percent-encoded, like url.pathToFileURL. */
export function fileUrl(file, platform = process.platform) {
  const posix = platform === 'win32' ? `/${file.replace(/\\/g, '/')}` : file;
  return `file://${posix.split('/').map((s) => encodeURIComponent(s).replace(/%3A/gi, ':')).join('/')}`;
}

/**
 * The shim texts for one platform. `execPath` is the Node.js binary and
 * `script` the absolute path of bin/agent-guild-report.mjs. Git Bash accepts
 * forward slashes in Windows paths, and a backslash would be an escape in
 * the sh shim, so the sh shim gets forward slashes on Windows.
 */
export function shimContents({ execPath, script, platform = process.platform }) {
  const forSh = (p) => (platform === 'win32' ? p.replace(/\\/g, '/') : p);
  const files = {
    [SHIM_NAME]: [
      '#!/bin/sh',
      '[ "$1" = --hook ] && [ -z "$AGENT_GUILD_SESSION_ID" ] && exec cat >/dev/null',
      `n=${shQuote(forSh(execPath))}`,
      '[ -x "$n" ] || n=node',
      `exec "$n" ${shQuote(forSh(script))} "$@"`,
      '',
    ].join('\n'),
  };
  if (platform === 'win32') {
    files[LOADER_NAME] = `import ${JSON.stringify(fileUrl(script, platform))};\n`;
    files[`${SHIM_NAME}.cmd`] = [
      '@ECHO OFF',
      'IF "%~1"=="--hook" IF NOT DEFINED AGENT_GUILD_SESSION_ID EXIT /B 0',
      'IF EXIST "%AGENT_GUILD_NODE%" GOTO manager',
      `node "%~dp0${LOADER_NAME}" %*`,
      'EXIT /B %ERRORLEVEL%',
      ':manager',
      `"%AGENT_GUILD_NODE%" "%~dp0${LOADER_NAME}" %*`,
      '',
    ].join('\r\n');
  }
  return files;
}

/**
 * Write the shims into `dir` (created if needed), replacing stale ones
 * atomically so a hook that is starting meanwhile still runs a whole file.
 * Returns `dir`. Throws when the folder is not writable; the caller decides
 * whether that is fatal.
 */
export function writeReportShims({ dir, execPath = process.execPath, script, platform = process.platform }) {
  fs.mkdirSync(dir, { recursive: true });
  const files = shimContents({ execPath, script, platform });
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, { mode: 0o755 });
    try { fs.chmodSync(tmp, 0o755); } catch { /* Windows */ }
    fs.renameSync(tmp, file);
  }
  // A .ps1 from an earlier version would take precedence in PowerShell.
  try { fs.unlinkSync(path.join(dir, `${SHIM_NAME}.ps1`)); } catch { /* none */ }
  return dir;
}

/**
 * `env` with `dir` first on PATH. Windows environments may spell the
 * variable "Path"; whichever spelling exists is kept. Elsewhere names are
 * case-sensitive and only PATH counts.
 */
export function prependPath(env, dir, { platform = process.platform } = {}) {
  if (!dir) return env;
  const delimiter = platform === 'win32' ? ';' : ':';
  const key = platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH' : 'PATH';
  const current = env[key] ? String(env[key]).split(delimiter).filter((entry) => entry && entry !== dir) : [];
  return { ...env, [key]: [dir, ...current].join(delimiter) };
}

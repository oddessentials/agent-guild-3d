// Starting a session manager as a detached background process. Shared by
// the `agent-guild` CLI, which starts one when none is running, and by a
// manager that restarts itself: both run the package on disk, so a restart
// after an upgrade comes up on the new version.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureDataDir, paths } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The manager entry point, from the package files on disk. */
export const MANAGER_ENTRY = path.join(here, 'main.mjs');
/** The package root the manager runs from. */
export const ROOT_DIR = path.resolve(here, '../..');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Keep one previous log so the file cannot grow without bound. */
function rotateLog() {
  try {
    if (fs.statSync(paths.log).size > MAX_LOG_BYTES) fs.renameSync(paths.log, `${paths.log}.1`);
  } catch { /* no log yet */ }
}

/**
 * Start a manager that outlives this process, with its output appended to
 * `manager.log`. Returns the child; the caller watches `/health` or the
 * runtime file to learn when it is serving.
 *
 * @param {{ env?: NodeJS.ProcessEnv, note?: string }} [opts]
 */
export function spawnManager({ env = process.env, note = 'starting manager' } = {}) {
  ensureDataDir();
  rotateLog();
  const log = fs.openSync(paths.log, 'a');
  fs.writeSync(log, `\n--- ${note} ${new Date().toISOString()} ---\n`);
  const child = spawn(process.execPath, [MANAGER_ENTRY], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env,
  });
  child.unref();
  fs.closeSync(log);
  return child;
}

/**
 * The double-click launcher for this platform, when the package carries one
 * (a checkout of the repository; the npm package does not include them).
 * Null otherwise, so a page never names a file that is not there.
 */
export function launcherPath(platform = process.platform, rootDir = ROOT_DIR) {
  const name = platform === 'win32' ? 'AgentGuild.cmd' : platform === 'darwin' ? 'AgentGuild.command' : null;
  if (!name) return null;
  const file = path.join(rootDir, 'launchers', name);
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

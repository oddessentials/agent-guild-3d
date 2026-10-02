#!/usr/bin/env node
// Agent Guild launcher.
//
//   agent-guild [open]     start the session manager if needed, open the page
//   agent-guild start      run the session manager in the foreground
//   agent-guild stop       stop the manager (ends all sessions)
//   agent-guild restart    stop the manager and start it again (ends all sessions)
//   agent-guild status     show whether the manager is running
//   agent-guild url        print the page URL (includes the access token)

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import {
  DEFAULT_HOST,
  VERSION,
  loadOrCreateToken,
  paths,
  readRuntimeFile,
  resolvePort,
} from '../src/manager/config.mjs';
import { spawnManager } from '../src/manager/launch.mjs';

function usage() {
  console.log(`Usage: agent-guild [command] [--no-browser]

Commands:
  open      Start the session manager if needed and open the web page (default)
  start     Run the session manager in the foreground
  stop      Stop the session manager and every session it owns
  restart   Stop the session manager and start it again; ends every session
  status    Show whether the session manager is running
  url       Print the web page URL, including the access token

Environment:
  AGENT_GUILD_PORT             Port for the local API (default 47821)
  AGENT_GUILD_HOME             Data directory (default: per-user app data folder)
  AGENT_GUILD_NPM_REGISTRY     npm registry for version checks and installs
  AGENT_GUILD_NO_UPDATE_CHECK  Set to 1 to skip version checks`);
}

function baseUrl() {
  const runtime = readRuntimeFile();
  if (runtime?.url) return runtime.url;
  return `http://${DEFAULT_HOST}:${resolvePort()}`;
}

/** The port a URL names, including the one its scheme implies. */
function portOf(url) {
  const parsed = new URL(url);
  return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
}

async function health(url, timeoutMs = 1000) {
  try {
    const res = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.name === 'agent-guild' ? body : null;
  } catch {
    return null;
  }
}

function pageUrl(url, token) {
  return `${url}/#token=${token}`;
}

function versionNotice(running) {
  if (!running || running === VERSION) return null;
  return `The running manager is version ${running}; the installed Agent Guild is ${VERSION}. ` +
    `Run "agent-guild stop" to end its sessions, then start again to use ${VERSION}.`;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  let child;
  if (process.platform === 'darwin') child = spawn('open', [url], opts);
  else if (process.platform === 'win32') {
    // rundll32 avoids cmd.exe's special handling of characters like "&" in URLs.
    child = spawn('rundll32', ['url.dll,FileProtocolHandler', url], { ...opts, windowsHide: true });
  } else child = spawn('xdg-open', [url], opts);
  child.on('error', () => console.log(`Could not open a browser automatically. Open this URL:\n  ${url}`));
  child.unref();
}

function tailLog(lines = 15) {
  try {
    return fs.readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Start a manager unless one answers. `port` pins the one to listen on; by default the configured one. */
async function ensureManager({ port = null } = {}) {
  const listenPort = port ?? resolvePort();
  const expectedUrl = `http://${DEFAULT_HOST}:${listenPort}`;
  // A pinned port is the endpoint to serve, so it is also the one to check;
  // a manager found anywhere else is not the one asked for.
  const knownUrl = port === null ? baseUrl() : expectedUrl;
  const running = await health(knownUrl);
  if (running) return { url: knownUrl, started: false, version: running.version };

  const child = spawnManager({ env: { ...process.env, AGENT_GUILD_PORT: String(listenPort) } });

  let exited = false;
  child.once('exit', () => { exited = true; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !exited) {
    await new Promise((r) => setTimeout(r, 250));
    const url = readRuntimeFile()?.pid === child.pid ? readRuntimeFile().url : expectedUrl;
    const up = await health(url, 500);
    if (up) return { url, started: true, version: up.version };
  }
  // Two launchers started together both try to start a manager; the one
  // that lost the race should use the winner rather than report a failure.
  const winner = await health(expectedUrl, 1000);
  if (winner) return { url: expectedUrl, started: false, version: winner.version };
  const details = tailLog();
  throw new Error(`the session manager did not start.${details ? `\n\nRecent log (${paths.log}):\n${details}` : ''}`);
}

async function cmdOpen({ browser }) {
  const { url, started, version } = await ensureManager();
  const token = loadOrCreateToken();
  const target = pageUrl(url, token);
  console.log(started ? `Session manager started at ${url}` : `Session manager already running at ${url}`);
  const notice = versionNotice(version);
  if (notice) console.log(notice);
  if (browser) {
    openBrowser(target);
    console.log('Opening Agent Guild in your browser. You can close the page at any time; sessions keep running.');
  } else {
    console.log(`Open: ${target}`);
  }
}

/**
 * Ask a running manager to stop, or to stop and start again. Resolves to
 * what it reported: the running session count, and whether it will start
 * a successor itself (a manager from before restarts only stops).
 */
async function requestShutdown(url, { restart = false } = {}) {
  // `stop` and `restart` are documented as ending every session, so they do
  // not ask; the web page's buttons are the ones that confirm first.
  const res = await fetch(`${url}/api/v1/shutdown`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${loadOrCreateToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(restart ? { force: true, restart: true } : { force: true }),
  });
  if (!res.ok) throw new Error(`${restart ? 'restart' : 'stop'} failed: HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const running = body.running ?? 0;
  if (running > 0) console.log(`Ending ${running} running session(s).`);
  return { running, restart: body.restart === true };
}

/** Resolves to true once nothing answers at `url`, false when it still does after `timeoutMs`. */
async function waitForStop(url, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (!(await health(url, 300))) return true;
  }
  return false;
}

async function cmdStop() {
  const url = baseUrl();
  if (!(await health(url))) {
    console.log('Session manager is not running.');
    return;
  }
  await requestShutdown(url);
  console.log(await waitForStop(url) ? 'Session manager stopped.' : 'Stop requested; the manager is still shutting down.');
}

async function cmdRestart() {
  const url = baseUrl();
  const before = await health(url);
  if (!before) {
    // Nothing to stop: a restart of a stopped manager is a start.
    const { url: started, version } = await ensureManager();
    console.log(`Session manager was not running; started Agent Guild ${version} at ${started}.`);
    return;
  }
  const { restart } = await requestShutdown(url, { restart: true });
  if (!restart) {
    // A manager from before restarts stops without starting a successor,
    // which is the case right after an upgrade: start one here instead.
    if (!(await waitForStop(url, 15000))) throw new Error('the session manager did not stop, so it could not be restarted.');
    // On the port the old one served, which an ephemeral port setting would otherwise lose.
    const { url: started, version } = await ensureManager({ port: portOf(url) });
    const changed = version !== before.version ? `, now Agent Guild ${version} (was ${before.version})` : '';
    console.log(`Session manager restarted at ${started}${changed}.`);
    return;
  }
  // The old manager starts its successor from the package on disk once its
  // sessions have ended and its port is free, then exits.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await health(url, 500);
    if (now && now.pid !== before.pid) {
      const changed = now.version !== before.version ? `, now Agent Guild ${now.version} (was ${before.version})` : '';
      console.log(`Session manager restarted at ${url}${changed}.`);
      return;
    }
  }
  const details = tailLog();
  throw new Error(`the session manager did not come back after the restart.${details ? `\n\nRecent log (${paths.log}):\n${details}` : ''}`);
}

async function cmdStatus() {
  const url = baseUrl();
  const h = await health(url);
  if (!h) {
    console.log('Session manager is not running.');
    process.exitCode = 3;
    return;
  }
  const res = await fetch(`${url}/api/v1/sessions`, { headers: { Authorization: `Bearer ${loadOrCreateToken()}` } });
  const { sessions = [] } = res.ok ? await res.json() : {};
  const running = sessions.filter((s) => s.status === 'running').length;
  console.log(`Session manager ${h.version} running at ${url} (pid ${h.pid}).`);
  const notice = versionNotice(h.version);
  if (notice) console.log(notice);
  console.log(`${sessions.length} session(s), ${running} running.`);
  for (const s of sessions) {
    const model = s.model ? ` [${s.model.displayName || s.model.name}]` : '';
    const agents = s.agents.length ? `, ${s.agents.length} agent(s)` : '';
    console.log(`  ${s.id}  ${s.provider.vendor.padEnd(10)} ${s.status.padEnd(8)} ${s.name}${model}${agents}`);
  }
}

const MIN_NODE_MAJOR = 22;

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node.js ${MIN_NODE_MAJOR} or newer is required; this is ${process.versions.node}. Install a current LTS from https://nodejs.org.`);
  }
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('-')));
  const command = args.find((a) => !a.startsWith('-')) || 'open';
  if (flags.has('-h') || flags.has('--help') || command === 'help') return usage();

  switch (command) {
    case 'open': return cmdOpen({ browser: !flags.has('--no-browser') });
    case 'start': {
      await import('../src/manager/main.mjs').then(async (m) => {
        process.on('uncaughtException', (err) => console.error('[manager] unexpected error:', err));
        process.on('unhandledRejection', (err) => console.error('[manager] unhandled rejection:', err));
        const { shutdown } = await m.startManager();
        console.log(`Open: ${pageUrl(readRuntimeFile()?.url ?? baseUrl(), loadOrCreateToken())}`);
        for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
          process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
        }
      });
      return undefined;
    }
    case 'stop': return cmdStop();
    case 'restart': return cmdRestart();
    case 'status': return cmdStatus();
    case 'url': {
      console.log(pageUrl(baseUrl(), loadOrCreateToken()));
      return undefined;
    }
    default:
      usage();
      process.exitCode = 2;
      return undefined;
  }
}

main().catch((err) => {
  console.error(`agent-guild: ${err.message}`);
  process.exit(1);
});

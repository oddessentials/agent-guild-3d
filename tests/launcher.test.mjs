// The launcher starts a detached manager that outlives it, and can stop it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../bin/agent-guild.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));

// A provider that runs the fake tool, so a real session can be running when
// the manager is asked to stop.
fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')] },
    { id: 'anthropic', usage: null },
    { id: 'openai', usage: null },
    { id: 'google', usage: null },
  ],
}));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: String(port), AGENT_GUILD_SKIP_SHELL_ENV: '1', AGENT_GUILD_NO_UPDATE_CHECK: '1' };

function runWith(runEnv, ...args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: runEnv, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

const run = (...args) => runWith(env, ...args);

const token = () => fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim();

async function call(method, route, body) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

after(async () => {
  await run('stop');
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('open starts a background manager, status reports it, stop ends it', async () => {
  const opened = await run('open', '--no-browser');
  assert.equal(opened.code, 0, opened.stderr);
  assert.match(opened.stdout, /Session manager started/);
  assert.match(opened.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/#token=[a-f0-9]+`));

  // The launcher has exited; the manager must still be serving.
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);

  const again = await run('open', '--no-browser');
  assert.match(again.stdout, /already running/);
  assert.doesNotMatch(again.stdout, /running manager is version/);

  const status = await run('status');
  assert.equal(status.code, 0);
  assert.match(status.stdout, /running at/);

  const url = await run('url');
  assert.match(url.stdout, /#token=/);

  // With a session running, a bare shutdown request is refused: the web
  // page uses that refusal to ask before ending sessions.
  const created = await call('POST', '/sessions', { providerId: 'fake', cwd: home });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // Windows reports the pid a moment after the console connects.
  let pid = created.body.session.pid;
  for (let i = 0; pid === null && i < 200; i++) {
    await new Promise((r) => setTimeout(r, 25));
    pid = (await call('GET', `/sessions/${created.body.session.id}`)).body.session.pid;
  }
  assert.ok(pid, 'the session has a pid');
  const refused = await call('POST', '/shutdown');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'sessions_running');
  assert.equal(refused.body.error.running, 1);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200, 'a refused shutdown leaves the manager running');

  // Every events client hears that the manager is stopping before it goes.
  const events = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${token()}`);
  const messages = [];
  events.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
  const closed = new Promise((resolve) => events.once('close', resolve));

  // The CLI's stop is documented as ending every session, so it forces.
  const stopped = await run('stop');
  assert.match(stopped.stdout, /Ending 1 running session/);
  assert.match(stopped.stdout, /stopped/);
  await closed;
  // The socket closes only after the sessions have ended, so a page can
  // report "every session has ended" when its socket drops.
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(alive(), false, 'the session process has exited by the time the events socket closes');
  const types = messages.map((m) => m.type);
  const stopping = messages.find((m) => m.type === 'manager.stopping');
  assert.ok(stopping, `no manager.stopping event in ${JSON.stringify(types)}`);
  assert.equal(stopping.running, 1);
  // The last event confirms that every process exited before the API closed.
  const done = messages.find((m) => m.type === 'manager.stopped');
  assert.ok(done, `no manager.stopped event in ${JSON.stringify(types)}`);
  assert.equal(done.remaining, 0);
  assert.equal(types.at(-1), 'manager.stopped');

  const after = await run('status');
  assert.equal(after.code, 3);
  assert.ok(!fs.existsSync(path.join(home, 'manager.json')), 'runtime file is removed on shutdown');
});

test('restart starts a manager when none runs, and replaces a running one on the same port and token', async () => {
  const health = async () => {
    try {
      const res = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(500) });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  assert.equal(await health(), null, 'the previous test left the manager stopped');

  const first = await run('restart');
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /was not running; started/);
  const before = await health();
  assert.ok(before, 'restart started a manager');
  const tokenBefore = token();

  // A session is running: the CLI's restart forces, like its stop.
  const created = await call('POST', '/sessions', { providerId: 'fake', cwd: home });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const events = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${token()}`);
  const messages = [];
  events.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { events.once('open', resolve); events.once('error', reject); });
  const closed = new Promise((resolve) => events.once('close', resolve));

  const restarted = await run('restart');
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.match(restarted.stdout, /Ending 1 running session/);
  assert.match(restarted.stdout, /Session manager restarted/);
  await closed;

  // Clients learn that the stop is a restart, so a page can wait for the new manager.
  const stopping = messages.find((m) => m.type === 'manager.stopping');
  assert.equal(stopping?.restart, true, `manager.stopping should carry restart: ${JSON.stringify(messages.map((m) => m.type))}`);
  assert.equal(stopping.running, 1);
  const done = messages.find((m) => m.type === 'manager.stopped');
  assert.equal(done?.restart, true);
  assert.equal(done.remaining, 0);

  const after = await health();
  assert.ok(after, 'a manager answers after the restart');
  assert.notEqual(after.pid, before.pid, 'the new manager is another process');
  assert.equal(token(), tokenBefore, 'the token is kept');
  const sessions = await call('GET', '/sessions');
  assert.equal(sessions.status, 200, 'the kept token works against the new manager');
  assert.deepEqual(sessions.body.sessions, [], 'the new manager starts with no sessions');
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'manager.json'), 'utf8'));
  assert.equal(runtime.pid, after.pid, 'the runtime file names the new manager');

  // The hello message carries what the page shows: the version and the launcher, if any.
  const hello = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${token()}`);
    ws.once('message', (raw) => { resolve(JSON.parse(raw.toString())); ws.close(); });
    ws.once('error', reject);
  });
  assert.equal(hello.type, 'hello');
  assert.equal(hello.version, after.version);
  assert.equal(hello.pid, after.pid);
  assert.ok(hello.launcher === null || typeof hello.launcher === 'string');

  const stopped = await run('stop');
  assert.match(stopped.stdout, /stopped/);
});

test('restart keeps an ephemeral port, and starts the manager itself when the old one only stops', async () => {
  // AGENT_GUILD_PORT=0: the successor must listen where the old manager did, not on another free port.
  const zeroHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));
  const zeroEnv = { ...env, AGENT_GUILD_HOME: zeroHome, AGENT_GUILD_PORT: '0' };
  const runtime = () => JSON.parse(fs.readFileSync(path.join(zeroHome, 'manager.json'), 'utf8'));
  try {
    const opened = await runWith(zeroEnv, 'open', '--no-browser');
    assert.equal(opened.code, 0, opened.stderr);
    const before = runtime();
    assert.notEqual(before.port, 0);
    const restarted = await runWith(zeroEnv, 'restart');
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.match(restarted.stdout, /Session manager restarted/);
    const after = runtime();
    assert.equal(after.port, before.port, 'the successor serves the same port');
    assert.notEqual(after.pid, before.pid);
    assert.match((await runWith(zeroEnv, 'stop')).stdout, /stopped/);
  } finally {
    fs.rmSync(zeroHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // A manager from before restarts (the one still running after an upgrade)
  // answers a shutdown without `restart` and starts nothing.
  const oldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));
  const old = http.createServer((req, res) => {
    if (req.url === '/api/v1/shutdown') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, running: 0 }));
      // As a real manager: the runtime file goes with it.
      fs.rmSync(path.join(oldHome, 'manager.json'), { force: true });
      setImmediate(() => { old.closeAllConnections(); old.close(); });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'agent-guild', version: '0.0.1', pid: process.pid }));
  });
  await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
  const oldPort = old.address().port;
  // Found through its runtime file, as with an ephemeral port setting; the successor must keep that port.
  fs.writeFileSync(path.join(oldHome, 'manager.json'), JSON.stringify({ pid: process.pid, port: oldPort, url: `http://127.0.0.1:${oldPort}` }));
  // Another manager answers at the port the environment names; it is not the one being restarted.
  const other = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'agent-guild', version: '0.0.2', pid: process.pid }));
  });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const oldEnv = { ...env, AGENT_GUILD_HOME: oldHome, AGENT_GUILD_PORT: String(other.address().port) };
  try {
    const restarted = await runWith(oldEnv, 'restart');
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.match(restarted.stdout, new RegExp(`Session manager restarted at http://127\\.0\\.0\\.1:${oldPort}.* \\(was 0\\.0\\.1\\)`));
    const runtimeNow = JSON.parse(fs.readFileSync(path.join(oldHome, 'manager.json'), 'utf8'));
    assert.equal(runtimeNow.port, oldPort, 'the new manager took over the port, not the one the environment names');
    assert.notEqual(runtimeNow.pid, process.pid);
    assert.match((await runWith(oldEnv, 'stop')).stdout, /stopped/);
  } finally {
    other.closeAllConnections();
    await new Promise((resolve) => other.close(resolve));
    fs.rmSync(oldHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('open and status say when the running manager is another version', async () => {
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-launcher-'));
  const server = http.createServer((req, res) => {
    const body = req.url === '/api/v1/health' ? { ok: true, name: 'agent-guild', version: '9.9.9', pid: process.pid } : { sessions: [] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const otherEnv = { ...env, AGENT_GUILD_HOME: otherHome, AGENT_GUILD_PORT: String(server.address().port) };
  try {
    const opened = await runWith(otherEnv, 'open', '--no-browser');
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.stdout, /already running/);
    assert.match(opened.stdout, /running manager is version 9\.9\.9/);
    assert.match(opened.stdout, /agent-guild stop/);

    const status = await runWith(otherEnv, 'status');
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /running manager is version 9\.9\.9/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(otherHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

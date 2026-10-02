// End-to-end tests: a real manager, real PTYs, real WebSockets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { startFakeGitHub } from './fixtures/fake-github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-test-'));
process.env.AGENT_GUILD_HOME = home;
process.env.AGENT_GUILD_PORT = '0';
process.env.AGENT_GUILD_SKIP_SHELL_ENV = '1';
// As if the manager were started from a tmux shell; the tools must not inherit it.
process.env.TMUX = '/tmp/tmux-0/default,1,0';
process.env.TERM_PROGRAM = 'tmux';

// A stand-in npm so install sessions never touch the real global prefix. Not
// the manager's launcher folder (<home>/bin), so that folder reaches the
// session PATH only through the manager.
const bin = path.join(home, 'fake-npm');
fs.mkdirSync(bin);
if (process.platform === 'win32') {
  fs.writeFileSync(path.join(bin, 'npm.cmd'), '@echo off\r\necho FAKE-NPM %*\r\n');
} else {
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "FAKE-NPM $*"\n', { mode: 0o755 });
}
const win = process.platform === 'win32';
const fixture = path.join(here, 'fixtures', 'fake-tool.mjs');
const runFixture = { win: `"${process.execPath}" "${fixture}" %*`, sh: `exec "${process.execPath}" "${fixture}" "$@"` };
function writeScript(file, body) {
  if (win) fs.writeFileSync(`${file}.cmd`, `@echo off\r\n${body.win}\r\n`);
  else fs.writeFileSync(file, `#!/bin/sh\n${body.sh}\n`, { mode: 0o755 });
}

const gitTools = path.join(here, 'fixtures', 'fake-git-tools.mjs');
for (const name of ['ssh', 'ssh-keygen', 'git']) {
  writeScript(path.join(bin, name), { win: `"${process.execPath}" "${gitTools}" ${name} %*`, sh: `exec "${process.execPath}" "${gitTools}" ${name} "$@"` });
}
process.env.FAKE_GIT_TOOLS_LOG = path.join(home, 'git-tools.log');
process.env.FAKE_GIT_TOOLS_STATE = path.join(home, 'git-tools.json');
// Inherited settings a clone must not pick up.
process.env.GIT_SSH_COMMAND = 'ssh -i /somebody/elses/key';
process.env.GIT_CONFIG_COUNT = '1';
process.env.GIT_CONFIG_KEY_0 = 'url.https://github.com/.insteadOf';
process.env.GIT_CONFIG_VALUE_0 = 'git@github.com:';
process.env.GIT_COMMON_DIR = path.join(home, 'someone-elses-repo', '.git');
const fakeGitHub = await startFakeGitHub();

const nativeDir = path.join(home, 'native-bin');
fs.mkdirSync(nativeDir);
writeScript(path.join(nativeDir, 'fake-native'), runFixture);

const npmPrefix = path.join(home, 'npm-prefix');
const npmBinDir = win ? npmPrefix : path.join(npmPrefix, 'bin');
const npmPkgDir = path.join(npmPrefix, ...(win ? [] : ['lib']), 'node_modules', 'fake-tool-pkg');
fs.mkdirSync(path.join(npmPkgDir, 'bin'), { recursive: true });
fs.mkdirSync(npmBinDir, { recursive: true });
fs.writeFileSync(path.join(npmPkgDir, 'package.json'), JSON.stringify({ name: 'fake-tool-pkg' }));
if (win) {
  writeScript(path.join(npmBinDir, 'fake-npmtool'), { win: `REM "%~dp0\\node_modules\\fake-tool-pkg\\bin\\tool.js"\r\n${runFixture.win}` });
} else {
  writeScript(path.join(npmPkgDir, 'bin', 'fake-npmtool'), runFixture);
  fs.symlinkSync(path.join(npmPkgDir, 'bin', 'fake-npmtool'), path.join(npmBinDir, 'fake-npmtool'));
}
writeScript(path.join(npmBinDir, 'npm'), {
  win: 'echo FAKE-NPM-OWNER %*\r\nif not defined FAKE_NPM_BREAKS exit /b 0\r\nif exist "%FAKE_TOOL_BREAK_FILE%" (del "%FAKE_TOOL_BREAK_FILE%") else (type nul > "%FAKE_TOOL_BREAK_FILE%")',
  sh: 'echo "FAKE-NPM-OWNER $*"\n[ -z "$FAKE_NPM_BREAKS" ] && exit 0\nif [ -e "$FAKE_TOOL_BREAK_FILE" ]; then rm -f "$FAKE_TOOL_BREAK_FILE"; else : > "$FAKE_TOOL_BREAK_FILE"; fi',
});
const breakFlag = path.join(home, 'broken.flag');
fs.writeFileSync(path.join(home, 'break-version.txt'), '9.9.9');

const secondDir = path.join(home, 'second-bin');
fs.mkdirSync(secondDir);
const secondVersion = path.join(secondDir, 'version.txt');
fs.writeFileSync(secondVersion, '0.9.0');
writeScript(path.join(secondDir, 'fake-native'), {
  win: `set "FAKE_TOOL_VERSION_FILE=${secondVersion}"\r\n${runFixture.win}`,
  sh: `FAKE_TOOL_VERSION_FILE="${secondVersion}" ${runFixture.sh}`,
});
const linkDir = path.join(home, 'links');
fs.mkdirSync(linkDir);
if (win) fs.writeFileSync(path.join(npmBinDir, 'fake-npmtool.ps1'), '& "$PSScriptRoot\\fake-npmtool.cmd" @args\r\n');
else fs.symlinkSync(path.join(npmBinDir, 'fake-npmtool'), path.join(linkDir, 'fake-npmtool'));

const codingTool = path.join(here, 'fixtures', 'fake-coding-tool.mjs');
const toolsDir = path.join(home, 'coding-tools');
fs.mkdirSync(toolsDir);
for (const name of ['claude', 'codex', 'gemini', 'grok']) {
  writeScript(path.join(toolsDir, name), { win: `"${process.execPath}" "${codingTool}" ${name} %*`, sh: `exec "${process.execPath}" "${codingTool}" ${name} "$@"` });
}
const userHookLog = path.join(home, 'user-hooks.log');
const geminiCwdLog = path.join(home, 'gemini-extension-cwd.log');
process.env.FAKE_GEMINI_CWD_LOG = geminiCwdLog;
const userHook = path.join(home, 'user-hook.mjs');
fs.writeFileSync(userHook, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(userHookLog)}, process.argv[2] + '\\n');\n`);
const userHookCommand = (name) => `"${process.execPath}" "${userHook}" ${name}`;
const toolHomes = {
  claude: path.join(home, 'tool-homes', 'claude'),
  codex: path.join(home, 'tool-homes', 'codex'),
  gemini: path.join(home, 'tool-homes', 'gemini'),
  grok: path.join(home, 'tool-homes', 'grok'),
};
const writeFile = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
writeFile(path.join(toolHomes.claude, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: userHookCommand('claude-user') }] }] } }));
writeFile(path.join(toolHomes.codex, 'hooks.json'), JSON.stringify({ hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: userHookCommand('codex-user') }] }] } }));
writeFile(path.join(toolHomes.codex, 'config.toml'), 'model = "gpt-5-codex"\n');
writeFile(path.join(toolHomes.gemini, '.gemini', 'settings.json'), JSON.stringify({ security: { environmentVariableRedaction: { enabled: true } } }));
writeFile(path.join(toolHomes.grok, 'config.toml'), '[ui]\nscreen_mode = "minimal"\n');
process.env.CLAUDE_CONFIG_DIR = toolHomes.claude;
process.env.CODEX_HOME = toolHomes.codex;
process.env.GEMINI_CLI_HOME = toolHomes.gemini;
process.env.GROK_HOME = toolHomes.grok;
const claudeHooksOff = path.join(home, 'tool-homes', 'claude-hooks-off');
writeFile(path.join(claudeHooksOff, 'settings.json'), JSON.stringify({ disableAllHooks: true }));

function snapshot(dir) {
  const files = {};
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const file = path.join(d, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(dir, file)] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return files;
}
const homesBefore = Object.fromEntries(Object.entries(toolHomes).map(([name, dir]) => [name, snapshot(dir)]));

process.env.PATH = [toolsDir, bin, npmBinDir, nativeDir, secondDir, linkDir, process.env.PATH].join(path.delimiter);

const racyBuild = `racy-pkg-${process.platform}-${process.arch}`;
const registryRequests = [];
const npmRegistry = http.createServer((req, res) => {
  registryRequests.push(req.url);
  const manifests = {
    '/fake-tool-pkg/latest': { name: 'fake-tool-pkg', version: '9.9.9' },
    '/@oddessentials%2fagent-guild/latest': { name: '@oddessentials/agent-guild', version: '9.9.9' },
    '/racy-pkg/latest': { name: 'racy-pkg', version: '2.0.0', optionalDependencies: { [racyBuild]: `npm:racy-pkg@2.0.0-${process.platform}-${process.arch}` } },
  };
  const known = manifests[req.url];
  res.writeHead(known ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(known || { error: 'Not found' }));
});
await new Promise((resolve) => npmRegistry.listen(0, '127.0.0.1', resolve));
process.env.AGENT_GUILD_NPM_REGISTRY = `http://127.0.0.1:${npmRegistry.address().port}`;

fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({
  providers: [
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], resumeArgs: ['--resume', '{id}'], package: 'fake-tool-pkg', versionArgs: [path.join(here, 'fixtures', 'fake-tool.mjs'), '--version'], modelPattern: 'fake-model-[a-z0-9.]+' },
    { id: 'plain', vendor: 'Test', tool: 'Plain Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], usage: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-usage.mjs')] }, history: { command: process.execPath, args: [path.join(here, 'fixtures', 'fake-history.mjs')] } },
    { id: 'missing', vendor: 'Nobody', tool: 'Missing Tool', command: 'definitely-not-installed-agent-guild', install: 'npm i -g nothing', package: 'nothing' },
    { id: 'nativetool', vendor: 'Test', tool: 'Native Tool', command: 'fake-native', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'native-version-1.txt') }, channels: { native: { paths: [path.join(nativeDir, 'fake-native')], update: ['update'] } } },
    { id: 'nativetool2', vendor: 'Test', tool: 'Native Tool Two', command: 'fake-native', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'native-version-2.txt'), FAKE_TOOL_UPDATE_TO: '2.0.0' }, channels: { native: { paths: [path.join(nativeDir, 'fake-native')], update: ['update'] } } },
    { id: 'npmtool', vendor: 'Test', tool: 'Npm Tool', command: 'fake-npmtool', package: 'fake-tool-pkg', versionArgs: ['--version'] },
    { id: 'breaktool', vendor: 'Test', tool: 'Break Tool', command: 'fake-npmtool', package: 'fake-tool-pkg', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_FILE: path.join(home, 'break-version.txt'), FAKE_TOOL_BREAK_FILE: breakFlag, FAKE_NPM_BREAKS: '1' } },
    { id: 'oddtool', vendor: 'Test', tool: 'Odd Tool', command: 'fake-native', versionArgs: ['--version'], env: { FAKE_TOOL_VERSION_TEXT: 'fake-tool nightly build' } },
    { id: 'absent', vendor: 'Nobody', tool: 'Absent Tool', command: 'definitely-not-installed-agent-guild', package: 'fake-tool-pkg' },
    { id: 'racytool', vendor: 'Nobody', tool: 'Racy Tool', command: 'definitely-not-installed-agent-guild', package: 'racy-pkg' },
    { id: 'multi', vendor: 'Test', tool: 'Multi Tool', command: process.execPath, args: [path.join(here, 'fixtures', 'fake-tool.mjs')], homeVar: 'FAKE_TOOL_HOME', hooks: { path: 'hooks/settings.json', example: 'claude-code-settings.json' }, accounts: [{ id: 'work', label: 'Work' }, { id: 'kept', dir: path.join(home, 'kept-home') }] },
    // Never read the developer's real Claude Code, Codex, Gemini or Grok sign-in or sessions during tests.
    { id: 'anthropic', usage: null, history: null, accounts: [{ id: 'work', label: 'Work' }] },
    { id: 'openai', usage: null, history: null, accounts: [{ id: 'work', label: 'Work' }] },
    { id: 'google', usage: null, history: null },
    { id: 'xai', history: null },
    { id: 'claudeoff', vendor: 'Test', tool: 'Claude Hooks Off', command: 'claude', reporting: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHooksOff } },
    {
      id: 'codexbroken', vendor: 'Test', tool: 'Codex Changed', command: 'codex', reporting: 'codex', env: { FAKE_CODEX_REJECT: '1' },
      homeVar: 'CODEX_HOME', hooks: { path: 'hooks.json', example: 'codex-hooks.json' }, accounts: [{ id: 'work', label: 'Work' }],
    },
    { id: 'grokplugins', vendor: 'Test', tool: 'Grok Next', command: 'grok', reporting: 'grok', env: { FAKE_GROK_PLUGIN_DIR: '1' } },
  ],
}));

const { startManager } = await import('../src/manager/main.mjs');

// The manager runs as a released version, from package files an upgrade can replace.
const packageFile = path.join(home, 'package.json');
fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '1.0.0' }));

let ctx;
let probesAtStart;
let base;
let token;

before(async () => {
  ctx = await startManager({
    version: '1.0.0', packageFile, sessionDefaults: { doneAgentLingerMs: 200, activityIdleMs: 200, killGraceMs: 500, reportingTimeoutMs: 1500 },
    github: { apiUrl: fakeGitHub.url, webUrl: fakeGitHub.url, clientId: 'test-client' },
  });
  probesAtStart = new Set(ctx.manager.sessionHooks.probes.keys());
  base = ctx.api.url;
  token = ctx.token;
});

after(async () => {
  await ctx.shutdown('tests done');
  npmRegistry.close();
  await fakeGitHub.close();
  assert.equal(ctx.manager.exiting.size, 0, 'shutdown waits for removed sessions to exit');
  try {
    // Windows may hold the folder briefly after a process exits.
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`could not remove ${home}: ${err.message}`);
  }
  // node-pty on Windows can keep a handle open after every session has
  // ended. Exit once results are reported rather than hanging the run.
  setTimeout(() => process.exit(), 3000).unref();
});

async function call(method, route, body, headers = {}) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** Raw request so we can forge Host/Origin headers (fetch forbids that). */
function rawGet(route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${route}`, { headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

function waitFor(predicate, { timeout = 8000, interval = 25, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const value = await predicate();
        if (value) return resolve(value);
      } catch { /* retry */ }
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, interval);
    };
    tick();
  });
}

class Client {
  constructor(url) {
    this.messages = [];
    this.output = '';
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.type === 'data') this.output += msg.data;
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve(code)));
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  input(text) { this.send({ type: 'input', data: text + '\r' }); }
  close() { this.ws.close(); return this.closed; }
}

// ConPTY on Windows repaints with its own escape sequences, so compare text only.
const stripAnsi = (text) => text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>78]/g, '');

/** Visible text of a session's screen, read from the manager's mirror. */
function screenText(id) {
  const buffer = ctx.manager.get(id).term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return lines.join('\n');
}

async function waitForText(client, sessionId, text, label) {
  try {
    await waitFor(() => stripAnsi(client.output).includes(text) || screenText(sessionId).includes(text), { label });
  } catch (err) {
    err.message += `\n--- stream tail ---\n${JSON.stringify(client.output.slice(-600))}\n--- screen ---\n${screenText(sessionId).trimEnd().slice(-600)}`;
    throw err;
  }
}

const terminal = (id) => new Client(`${base.replace('http', 'ws')}/api/v1/sessions/${id}/terminal?token=${token}`);

const findProvider = async (id) => (await call('GET', '/providers')).body.providers.find((p) => p.id === id);

async function runInstall(id) {
  const startedAt = Date.now();
  const started = await call('POST', `/providers/${id}/install`);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { session } = started.body;
  const client = terminal(session.id);
  await client.opened;
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: `${id} update exit` });
  const output = `${stripAnsi(client.output)}\n${screenText(session.id)}`;
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
  const provider = await waitFor(async () => {
    const p = await findProvider(id);
    return p.lastInstall?.at >= startedAt ? p : null;
  }, { label: `${id} update outcome` });
  return { session, output, provider };
}

async function createFake(extra = {}) {
  const { status, body } = await call('POST', '/sessions', { providerId: 'fake', cwd: home, cols: 90, rows: 20, ...extra });
  assert.equal(status, 201, JSON.stringify(body));
  return body.session;
}

test('health is public, everything else needs the token', async () => {
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).name, 'agent-guild');
  const noToken = await fetch(`${base}/api/v1/sessions`);
  assert.equal(noToken.status, 401);
  const wrong = await call('GET', '/sessions', undefined, { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);
});

test('foreign Host and Origin headers are rejected', async () => {
  const port = new URL(base).port;
  assert.equal(await rawGet('/api/v1/health', { Host: `attacker.example:${port}` }), 403);
  assert.equal(await rawGet('/api/v1/health', { Origin: 'https://attacker.example' }), 403);
  assert.equal(await rawGet('/api/v1/health', { Origin: `http://localhost:${port}` }), 200);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`, { origin: 'https://attacker.example' });
  const err = await new Promise((resolve) => ws.once('unexpected-response', (_req, res) => resolve(res.statusCode)));
  assert.equal(err, 403);
  const noAuth = new WebSocket(`${base.replace('http', 'ws')}/api/v1/events`);
  assert.equal(await new Promise((resolve) => noAuth.once('unexpected-response', (_req, res) => resolve(res.statusCode))), 401);
});

test('the web page and xterm assets are served', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent Guild/);
  assert.equal((await fetch(`${base}/vendor/xterm/xterm.js`)).status, 200);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/theme.js`)).status, 200);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/skins/guild/page.avif`)).headers.get('content-type'), 'image/avif');
  assert.equal((await fetch(`${base}/skins/professional/page.svg`)).headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${base}/skins/orbital/fonts/exo2.woff2`)).headers.get('content-type'), 'font/woff2');
});

test('static files revalidate with their ETag instead of downloading again', async () => {
  const first = await fetch(`${base}/styles.css`);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'an ETag is sent');
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const again = await fetch(`${base}/styles.css`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  const vendor = await fetch(`${base}/vendor/xterm/xterm.js`);
  assert.equal((await fetch(`${base}/vendor/xterm/xterm.js`, { headers: { 'If-None-Match': vendor.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(`${base}/styles.css`, { headers: { 'If-None-Match': 'W/"0-0"' } })).status, 200);
});

test('the manager offers its own upgrade in a visible npm session', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;
  const hello = await waitFor(() => events.messages.find((m) => m.type === 'hello'), { label: 'hello' });
  assert.equal(hello.upgrade.version, '1.0.0');

  const info = await waitFor(async () => {
    const { body } = await call('GET', '/info');
    return body.upgrade.latestVersion ? body.upgrade : null;
  }, { label: 'self version check' });
  assert.equal(info.latestVersion, '9.9.9');
  assert.equal(info.available, true);
  assert.ok(info.command.endsWith(`install -g @oddessentials/agent-guild@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`), info.command);
  assert.equal(info.pendingVersion, null);
  assert.equal(info.lastInstall, null);

  const { status, body } = await call('POST', '/upgrade');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.session.task, 'upgrade');
  assert.equal(body.session.name, 'Upgrade Agent Guild to 9.9.9');
  assert.equal(body.session.provider.id, 'agent-guild');
  const client = terminal(body.session.id);
  await client.opened;
  await waitForText(client, body.session.id, `FAKE-NPM install -g @oddessentials/agent-guild@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`, 'npm output');
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'npm exit' });
  const result = await waitFor(() => events.messages.find((m) => m.type === 'manager.upgrade' && m.upgrade.lastInstall), { label: 'manager.upgrade' });
  assert.equal(result.upgrade.lastInstall.outcome, 'unchanged', 'the fake npm did not replace the package files');
  assert.equal(result.upgrade.lastInstall.exitCode, 0);
  assert.equal(result.upgrade.available, true, 'the upgrade stays on offer');
  await client.close();
  await call('DELETE', `/sessions/${body.session.id}`);

  // Once npm has replaced the files, the new version waits for a restart.
  fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '9.9.9' }));
  try {
    const pending = (await call('GET', '/info')).body.upgrade;
    assert.equal(pending.pendingVersion, '9.9.9');
    assert.equal(pending.available, false);
    const refused = await call('POST', '/upgrade');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, 'not_updatable');
    assert.match(refused.body.error.message, /restart the manager/);
  } finally {
    fs.writeFileSync(packageFile, JSON.stringify({ name: '@oddessentials/agent-guild', version: '1.0.0' }));
  }
  await events.close();
});

test('providers report availability', async () => {
  const { body } = await call('GET', '/providers');
  const fake = body.providers.find((p) => p.id === 'fake');
  const missing = body.providers.find((p) => p.id === 'missing');
  assert.equal(fake.available, true);
  assert.equal(fake.resumable, true);
  assert.equal(fake.installable, true);
  const plain = body.providers.find((p) => p.id === 'plain');
  assert.equal(plain.resumable, false);
  assert.equal(plain.installable, false, 'no npm package configured');
  assert.equal(missing.available, false);
  assert.equal(missing.installable, true);
  assert.ok(body.providers.some((p) => p.id === 'anthropic'), 'built-in providers are still listed');
  const anthropic = body.providers.find((p) => p.id === 'anthropic');
  assert.match(anthropic.usageUrl, /^https:\/\//);
  assert.match(anthropic.billingUrl, /^https:\/\//);
  assert.equal(fake.usageUrl, null);
  assert.equal(fake.billingUrl, null);
});

test('usage meters come from the provider usage source', async () => {
  const { body } = await call('GET', '/providers');
  assert.equal(body.providers.find((p) => p.id === 'plain').usageSource, 'command');
  assert.equal(body.providers.find((p) => p.id === 'fake').usageSource, null);
  assert.equal(body.providers.find((p) => p.id === 'anthropic').usageSource, null, 'built-in sources are disabled for tests');

  const { status, body: usage } = await call('GET', '/usage');
  assert.equal(status, 200);
  assert.deepEqual(usage.usage.map((u) => u.providerId), ['plain'], 'only providers with a source are listed');
  const [plain] = usage.usage;
  assert.equal(plain.error, null);
  assert.equal(plain.plan, 'test');
  assert.deepEqual(plain.windows, [
    { label: '5-hour', usedPercent: 42.3, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: '7-day', usedPercent: 90, resetsAt: null },
  ]);
});

test('installed and latest versions are reported and updates flagged', async () => {
  const fake = await waitFor(async () => {
    const p = (await call('GET', '/providers')).body.providers.find((x) => x.id === 'fake');
    return p.installedVersion && p.latestVersion ? p : null;
  }, { label: 'version check' });
  assert.equal(fake.installedVersion, '1.2.3');
  assert.equal(fake.latestVersion, '9.9.9');
  assert.equal(fake.updateAvailable, true);
  const missing = (await call('GET', '/providers')).body.providers.find((x) => x.id === 'missing');
  assert.equal(missing.installedVersion, null);
  assert.equal(missing.latestVersion, null, 'unknown packages have no latest version');
  assert.equal(missing.updateAvailable, false);
});

test('a provider can be installed or updated from a visible npm session', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;

  const { status, body } = await call('POST', '/providers/absent/install');
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.session.task, 'install');
  assert.equal(body.session.name, 'Install Absent Tool');
  assert.equal(body.session.provider.id, 'absent');
  const client = terminal(body.session.id);
  await client.opened;
  await waitForText(client, body.session.id, `FAKE-NPM install -g fake-tool-pkg@9.9.9 --registry ${process.env.AGENT_GUILD_NPM_REGISTRY}`, 'npm output');
  await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'npm exit' });
  const updated = await waitFor(() => events.messages.find((m) => m.type === 'providers.updated'), { label: 'providers.updated' });
  assert.ok(updated.providers.some((p) => p.id === 'absent'));
  await client.close();
  await call('DELETE', `/sessions/${body.session.id}`);

  assert.equal((await call('POST', '/providers/plain/install')).body.error.code, 'not_updatable');
  const unresolved = await call('POST', '/providers/missing/install');
  assert.equal(unresolved.status, 503);
  assert.equal(unresolved.body.error.code, 'release_unresolved');
  assert.equal((await call('POST', '/providers/nope/install')).status, 404);

  // Updating a tool that has running sessions needs an explicit go-ahead.
  await waitFor(async () => (await findProvider('nativetool')).updateCommand, { label: 'self-update probe' });
  const running = (await call('POST', '/sessions', { providerId: 'nativetool', cwd: home, cols: 90, rows: 20 })).body.session;
  const refused = await call('POST', '/providers/nativetool/install');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'provider_in_use');
  assert.equal(refused.body.error.running, 1);
  const forced = await call('POST', '/providers/nativetool/install', { force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.session.name, 'Update Native Tool (native)');
  await waitFor(async () => (await call('GET', `/sessions/${forced.body.session.id}`)).body.session.status === 'exited', { label: 'update exit' });
  await call('DELETE', `/sessions/${forced.body.session.id}`);
  await call('DELETE', `/sessions/${running.id}`);
  await events.close();
});

test('an installed tool reports the installation that owns it', async () => {
  const native = await waitFor(async () => {
    const p = await findProvider('nativetool');
    return p.updateCommand ? p : null;
  }, { label: 'self-update probe' });
  assert.equal(native.installChannel, 'native');
  assert.ok(native.resolvedPath.startsWith(nativeDir));
  assert.ok(native.updateCommand.includes(native.resolvedPath), 'the detected launcher is named by its absolute path');
  assert.ok(native.updateCommand.endsWith(' update'));

  const npmtool = await waitFor(async () => {
    const p = await findProvider('npmtool');
    return p.latestVersion ? p : null;
  }, { label: 'release lookup' });
  assert.equal(npmtool.installChannel, 'npm');
  assert.ok(npmtool.updateCommand.includes(path.join(npmBinDir, win ? 'npm.cmd' : 'npm')), 'the npm of the owning prefix');
  assert.ok(npmtool.updateCommand.includes('install -g --prefix'));
  assert.ok(npmtool.updateCommand.includes(npmPrefix));
  assert.ok(npmtool.updateCommand.includes('fake-tool-pkg@9.9.9'), 'the known release, as an exact version');

  const fake = await findProvider('fake');
  assert.equal(fake.installChannel, 'unknown');
  assert.equal(fake.updateCommand, null);
  assert.match(fake.updateGuidance, /does not recognise/);
  assert.equal((await findProvider('missing')).installChannel, null);
});

test('an update runs the updater of the owning installation and stays retryable', async () => {
  const native = await runInstall('nativetool');
  assert.equal(native.session.name, 'Update Native Tool (native)');
  assert.ok(native.output.includes('FAKE-TOOL UPDATE update'), native.output);
  assert.ok(!native.output.includes('FAKE-NPM'), 'npm is not run for a tool npm does not own');

  const unchanged = native.provider;
  assert.equal(unchanged.lastInstall.outcome, 'unchanged');
  assert.equal(unchanged.lastInstall.exitCode, 0);
  assert.equal(unchanged.installedVersion, '1.2.3');
  assert.equal(unchanged.latestVersion, '9.9.9', 'the release is still reported');
  assert.equal(unchanged.updateAvailable, true);
  assert.ok(unchanged.updateCommand, 'the update can be tried again');
  const retry = await runInstall('nativetool');
  assert.ok(retry.output.includes('FAKE-TOOL UPDATE update'), retry.output);

  const viaNpm = await runInstall('npmtool');
  assert.equal(viaNpm.session.name, 'Update Npm Tool (npm)');
  assert.ok(viaNpm.output.includes('FAKE-NPM-OWNER install -g --prefix'), viaNpm.output);
  assert.ok(!viaNpm.output.includes('FAKE-NPM install'), 'the first npm on PATH is not used');

  const unknown = await call('POST', '/providers/fake/install');
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'not_updatable');
});

test('the version is read again right after an update', async () => {
  const before = await waitFor(async () => {
    const p = await findProvider('nativetool2');
    return p.installedVersion && p.updateCommand ? p : null;
  }, { label: 'version check' });
  assert.equal(before.installedVersion, '1.2.3');
  const { provider: after } = await runInstall('nativetool2');
  assert.equal(after.lastInstall.outcome, 'updated');
  assert.equal(after.lastInstall.before, '1.2.3');
  assert.equal(after.installedVersion, '2.0.0');
  assert.equal(after.updateAvailable, true);
});

test('a clean npm exit that leaves the tool broken is reported and stays repairable', async () => {
  const healthy = await waitFor(async () => {
    const p = await findProvider('breaktool');
    return p.installedVersion ? p : null;
  }, { label: 'version check' });
  assert.equal(healthy.installedVersion, '9.9.9');
  assert.equal(healthy.updateAvailable, false, 'no newer release is known');
  assert.equal(healthy.versionStatus, 'ok');

  const broke = await runInstall('breaktool');
  assert.ok(broke.output.includes('FAKE-NPM-OWNER install -g --prefix'), broke.output);
  assert.equal(broke.provider.lastInstall.exitCode, 0, 'npm itself reported success');
  assert.equal(broke.provider.lastInstall.verification, 'failed');
  assert.equal(broke.provider.versionStatus, 'failed');
  assert.equal(broke.provider.installedVersion, null, 'the Node.js version in the error is not taken as the tool version');
  assert.match(broke.provider.versionError, /^Error: Missing optional dependency/);
  assert.equal(broke.provider.installChannel, 'npm');
  assert.equal(broke.provider.updateAvailable, false);
  assert.ok(broke.provider.updateCommand, 'the reinstall stays on offer with no newer release');

  const repaired = await runInstall('breaktool');
  assert.equal(repaired.provider.lastInstall.exitCode, 0);
  assert.equal(repaired.provider.lastInstall.verification, 'ok');
  assert.equal(repaired.provider.versionStatus, 'ok');
  assert.equal(repaired.provider.installedVersion, '9.9.9');

  const odd = await waitFor(async () => {
    const p = await findProvider('oddtool');
    return p.versionStatus ? p : null;
  }, { label: 'odd version check' });
  assert.equal(odd.versionStatus, 'unavailable');
  assert.equal(odd.installedVersion, null);
});

test('an unpublished platform build stops the install before anything runs', async () => {
  const before = (await call('GET', '/sessions')).body.sessions.length;
  registryRequests.length = 0;
  const refused = await call('POST', '/providers/racytool/install');
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'release_incomplete');
  assert.ok(refused.body.error.message.includes(`racy-pkg@2.0.0-${process.platform}-${process.arch}`));
  assert.match(refused.body.error.message, /Nothing was changed/);
  assert.deepEqual(registryRequests, ['/racy-pkg/latest', `/racy-pkg/2.0.0-${process.platform}-${process.arch}`]);
  assert.equal((await call('GET', '/sessions')).body.sessions.length, before, 'no session was started');
});

test('other copies of a tool are listed, wrappers of one copy are not', async () => {
  const native = await waitFor(async () => {
    const p = await findProvider('nativetool');
    return p.installs.length === 2 && p.installs.every((i) => i.version) ? p : null;
  }, { label: 'copy versions' });
  assert.deepEqual(native.installs.map((i) => [i.channel, i.version, i.active, i.onPath, i.newer]), [
    ['native', '1.2.3', true, true, false],
    ['unknown', '0.9.0', false, true, false],
  ]);
  assert.ok(native.installs[1].path.startsWith(secondDir));
  assert.equal(native.installs[1].removeCommand, null, 'no removal command without confirmed ownership');
  assert.equal(native.warnings.length, 1);
  assert.match(native.warnings[0], /^2 copies of Native Tool are installed\. The one in use is native v1\.2\.3 at /);

  const npmtool = await findProvider('npmtool');
  assert.equal(npmtool.installs.length, 1, 'several entry points of one installation are one installation');
  assert.equal(npmtool.installs[0].channel, 'npm');
  assert.ok(npmtool.installs[0].removeCommand.includes('uninstall -g --prefix'));
  assert.ok(npmtool.installs[0].removeCommand.includes(npmPrefix));
  assert.ok(npmtool.installs[0].removeCommand.endsWith('fake-tool-pkg'));
  assert.deepEqual(npmtool.warnings, []);
  assert.deepEqual((await findProvider('missing')).installs, []);
});

test('an existing tool session can be resumed by id', async () => {
  const session = await createFake({ resume: ' abc-123 ' });
  assert.equal(session.resume, 'abc-123');
  const client = terminal(session.id);
  await client.opened;
  client.input('args');
  await waitForText(client, session.id, 'ARGS:["--resume","abc-123"]', 'resume args');
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);

  const fresh = await createFake();
  assert.equal(fresh.resume, null);
  await call('DELETE', `/sessions/${fresh.id}`);

  assert.equal((await call('POST', '/sessions', { providerId: 'fake', resume: '' })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', resume: 'a\nb' })).status, 400);
  const unsupported = await call('POST', '/sessions', { providerId: 'plain', resume: 'abc' });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.error.code, 'resume_unsupported');
});

test('past sessions of a provider are listed from its history source', async () => {
  const { body: listed } = await call('GET', '/providers');
  assert.equal(listed.providers.find((p) => p.id === 'plain').historySource, 'command');
  assert.equal(listed.providers.find((p) => p.id === 'fake').historySource, null);
  assert.equal(listed.providers.find((p) => p.id === 'anthropic').historySource, null, 'built-in sources are disabled for tests');

  const { status, body } = await call('GET', '/providers/plain/history');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.history.sessions.map((s) => s.id), ['older-1', 'newer-2']);
  assert.deepEqual([body.history.providerId, body.history.accountId, body.history.total, body.history.error], ['plain', 'default', 2, null]);
  assert.ok(Date.parse(body.history.fetchedAt));
  assert.equal((await call('GET', '/providers/plain/history?limit=1')).body.history.sessions.length, 1);
  const unsupported = await call('GET', '/providers/fake/history');
  assert.deepEqual([unsupported.status, unsupported.body.error.code], [400, 'history_unsupported']);
  assert.equal((await call('GET', '/providers/nope/history')).status, 404);
  assert.equal((await call('GET', '/providers/plain/history?account=nobody')).body.error.code, 'unknown_account');
});

test('the tool\'s own session id is reported over HTTP, in-band, and through hooks', async () => {
  const session = await createFake();
  assert.equal(session.toolSessionId, null);
  const managed = ctx.manager.get(session.id);
  const route = `/sessions/${session.id}/tool-session`;
  assert.equal((await call('POST', route, { toolSessionId: 'x' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' })).status, 401);
  const ok = await call('POST', route, { toolSessionId: ' 550e8400-e29b-41d4-a716-446655440000 ' }, { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.deepEqual([ok.status, ok.body.toolSessionId], [200, '550e8400-e29b-41d4-a716-446655440000']);
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.toolSessionId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal((await call('POST', route, { toolSessionId: '' })).status, 400);
  assert.equal((await call('POST', route, { toolSessionId: 'a\nb' })).status, 400);

  const client = terminal(session.id);
  await client.opened;
  client.input('session in-band-1');
  await waitFor(() => ctx.manager.get(session.id).toolSessionId === 'in-band-1', { label: 'in-band tool session id' });
  client.input(`hook ${process.platform === 'win32' ? 'cmd' : 'sh'} ${JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hooked-2', source: 'startup' })}`);
  await waitForText(client, session.id, 'HOOK-EXIT:0', 'hook exit');
  await waitFor(() => ctx.manager.get(session.id).toolSessionId === 'hooked-2', { label: 'hook tool session id' });
  await client.close();
  await call('POST', `/sessions/${session.id}/stop`);
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.status === 'exited', { label: 'exit' });
  assert.equal((await call('POST', route, { toolSessionId: 'late' })).status, 409, 'an exited session takes no reports');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.toolSessionId, 'hooked-2', 'the id outlives the process');
  await call('DELETE', `/sessions/${session.id}`);
});

test('session creation validates its input', async () => {
  assert.equal((await call('POST', '/sessions', { providerId: 'nope' })).status, 404);
  const missing = await call('POST', '/sessions', { providerId: 'missing' });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error.message, /npm i -g nothing/);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', cwd: path.join(home, 'no-such-dir') })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', args: 'x' })).status, 400);
});

test('a session runs under the account picked, in that account\'s own home folder', async () => {
  const { body: listed } = await call('GET', '/providers');
  assert.deepEqual(listed.providers.find((p) => p.id === 'multi').accounts, [{ id: 'default', label: 'Default' }, { id: 'work', label: 'Work' }, { id: 'kept', label: 'Kept' }]);
  assert.deepEqual(listed.providers.find((p) => p.id === 'fake').accounts, [{ id: 'default', label: 'Default' }]);

  const workHome = path.join(home, 'accounts', 'multi', 'work');
  assert.ok(!fs.existsSync(workHome), 'nothing is created before the first session');
  const { status, body } = await call('POST', '/sessions', { providerId: 'multi', account: 'work', cwd: home, cols: 90, rows: 20 });
  assert.equal(status, 201, JSON.stringify(body));
  const work = body.session;
  assert.deepEqual(work.account, { id: 'work', label: 'Work' });
  assert.equal(work.name, 'Multi Tool · Work');
  assert.ok(fs.existsSync(workHome), 'the account folder is created');
  assert.ok(!fs.existsSync(path.join(workHome, 'hooks', 'settings.json')), 'no hooks file is seeded into the account');
  const client = terminal(work.id);
  await client.opened;
  client.input('env');
  await waitFor(() => client.output.includes('ENV:'), { label: 'env' });
  assert.ok(client.output.includes(`|home=${workHome}\r`), client.output);
  await client.close();
  await call('DELETE', `/sessions/${work.id}`);

  fs.mkdirSync(path.join(workHome, 'hooks'));
  fs.writeFileSync(path.join(workHome, 'hooks', 'settings.json'), '{"mine":true}');
  const again = (await call('POST', '/sessions', { providerId: 'multi', account: 'work', cwd: home, name: 'Named' })).body.session;
  assert.equal(again.name, 'Named');
  assert.equal(fs.readFileSync(path.join(workHome, 'hooks', 'settings.json'), 'utf8'), '{"mine":true}', 'an existing hooks file is kept');
  await call('DELETE', `/sessions/${again.id}`);

  const kept = (await call('POST', '/sessions', { providerId: 'multi', account: 'kept', cwd: home })).body.session;
  assert.ok(fs.existsSync(path.join(home, 'kept-home')), 'a configured dir is used as is');
  await call('DELETE', `/sessions/${kept.id}`);

  const plain = (await call('POST', '/sessions', { providerId: 'multi', cwd: home })).body.session;
  assert.deepEqual(plain.account, { id: 'default', label: 'Default' });
  assert.equal(plain.name, 'Multi Tool · Default');
  const single = await createFake();
  assert.deepEqual(single.account, { id: 'default', label: 'Default' });
  assert.equal(single.name, 'Fake Tool', 'one account leaves the name alone');
  await call('DELETE', `/sessions/${plain.id}`);
  await call('DELETE', `/sessions/${single.id}`);

  const unknown = await call('POST', '/sessions', { providerId: 'multi', account: 'nope', cwd: home });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_account');
  assert.equal((await call('POST', '/sessions', { providerId: 'multi', account: 3, cwd: home })).status, 400);
  assert.equal((await call('POST', '/sessions', { providerId: 'fake', account: 'work', cwd: home })).status, 404, 'other providers have only the default account');
});

test('a session runs, streams output, accepts input and resizes', async () => {
  const session = await createFake();
  assert.equal(session.status, 'running');
  assert.equal(session.cwd, home);

  const client = terminal(session.id);
  await client.opened;
  await waitFor(() => client.messages[0], { label: 'snapshot' });
  assert.equal(client.messages[0].type, 'snapshot', 'the first message is always a snapshot');

  await waitFor(() => client.messages.some((m) => m.type === 'snapshot' && m.data.includes('FAKE-TOOL READY')) || client.output.includes('FAKE-TOOL READY'), { label: 'banner' });
  client.input('echo hello world');
  await waitFor(() => client.output.includes('ECHO:hello world'), { label: 'echo' });
  const { pid } = (await call('GET', `/sessions/${session.id}`)).body.session;
  assert.ok(Number.isInteger(pid) && pid > 0, `a started session reports its pid, got ${pid}`);

  client.input('env');
  await waitFor(() => client.output.includes('ENV:'), { label: 'env' });
  await waitForText(client, session.id, '|term_program=', 'env line');
  assert.ok(client.output.includes(`ENV:${session.id}|fake|${base}|${path.join(home, 'bin')}|tmux=|term_program=|home=\r`), client.output);

  client.send({ type: 'resize', cols: 101, rows: 33 });
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.cols === 101, { label: 'resize' });
  if (process.platform === 'win32') {
    // ConPTY confirms a resize by emitting CSI 8 ; rows ; cols t. (A Node
    // child inside ConPTY can keep reporting its old size, so the tool's own
    // report is not a reliable signal there.)
    await waitFor(() => client.output.includes('\x1b[8;33;101t'), { label: 'ConPTY resize' });
  } else {
    // The tool's cached size changes only once it has handled SIGWINCH, so ask until it has.
    const ask = setInterval(() => client.input('size'), 300);
    client.input('size');
    try {
      await waitForText(client, session.id, 'SIZE:101x33', 'pty size');
    } finally {
      clearInterval(ask);
    }
  }

  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('reconnecting clients get a snapshot of the current screen', async () => {
  const session = await createFake();
  const first = terminal(session.id);
  await first.opened;
  first.input('echo before-disconnect');
  await waitFor(() => first.output.includes('ECHO:before-disconnect'), { label: 'first output' });
  await first.close();

  // Output produced while nobody is watching must still be captured.
  const { body } = await call('GET', `/sessions/${session.id}`);
  assert.equal(body.session.status, 'running', 'closing the client does not stop the session');

  const second = terminal(session.id);
  await second.opened;
  const snapshot = await waitFor(() => second.messages.find((m) => m.type === 'snapshot'), { label: 'snapshot' });
  assert.ok(snapshot.data.includes('ECHO:before-disconnect'), snapshot.data);
  assert.equal(snapshot.cols, 90);
  second.input('echo after-reconnect');
  await waitFor(() => second.output.includes('ECHO:after-reconnect'), { label: 'live output after snapshot' });
  await second.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('agents can be reported over HTTP with the session report token', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  const route = `/sessions/${session.id}/agents`;

  const denied = await call('POST', route, { agentId: 'a' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' });
  assert.equal(denied.status, 401);

  const ok = await call('POST', route, { agentId: 'explore-1', name: 'Explorer', detail: 'reading src/' },
    { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.agent.status, 'working');

  assert.equal((await call('POST', route, { agentId: 'x', status: 'dancing' })).status, 400);
  assert.equal((await call('POST', route, {})).status, 400);

  let { body } = await call('GET', `/sessions/${session.id}`);
  assert.deepEqual(body.session.agents.map((a) => a.name), ['Explorer']);

  await call('POST', route, { agentId: 'explore-1', status: 'done' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.equal(body.session.agents[0].status, 'done', 'done agents linger briefly');
  const lingerFrom = body.session.agents[0].updatedAt;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await call('POST', route, { agentId: 'explore-1', status: 'done' })).body.agent.updatedAt, lingerFrom, 'a repeated done keeps the first linger');
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.agents.length === 0, { label: 'agent removal' });

  // A stop for an agent that never started (Claude Code's internal helpers) shows nothing.
  assert.equal((await call('POST', route, { agentId: 'ghost', status: 'done' })).body.agent, null);
  assert.deepEqual((await call('GET', `/sessions/${session.id}`)).body.session.agents, []);

  // The cap counts working agents; a lingering done agent makes room.
  for (let i = 0; i < 64; i++) assert.equal((await call('POST', route, { agentId: `w${i}` })).status, 200);
  assert.equal((await call('POST', route, { agentId: 'w64' })).status, 400);
  await call('POST', route, { agentId: 'w0', status: 'done' });
  assert.equal((await call('POST', route, { agentId: 'w64' })).status, 200);
  const ids = (await call('GET', `/sessions/${session.id}`)).body.session.agents.map((a) => a.id);
  assert.ok(ids.includes('w64') && !ids.includes('w0'), ids.join(','));
  await call('DELETE', `/sessions/${session.id}`);
});

test('Claude Code sub-agent hooks reach the session through agent-guild-report', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = {
    ...process.env,
    AGENT_GUILD_URL: base,
    AGENT_GUILD_SESSION_ID: session.id,
    AGENT_GUILD_REPORT_TOKEN: managed.reportToken,
  };
  const runHook = (payload) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [reporter, '--hook'], { env, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`)); else resolve(stderr);
    });
    child.stdin.end(JSON.stringify(payload));
  });
  const common = { session_id: 'claude-session', cwd: home, transcript_path: '/tmp/t.jsonl' };

  assert.equal(await runHook({ ...common, hook_event_name: 'SubagentStart', agent_id: 'agent-7', agent_type: 'Explore' }), '');
  let { body } = await call('GET', `/sessions/${session.id}`);
  assert.deepEqual(body.session.agents.map((a) => [a.id, a.name, a.status]), [['hook-agent-7', 'Explore', 'working']]);

  await runHook({ ...common, hook_event_name: 'SubagentStop', agent_id: 'agent-7', agent_type: 'Explore', stop_hook_active: false });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.equal(body.session.agents[0].status, 'done');

  // Codex CLI's events carry the model too, and Grok Build spells the fields in camelCase.
  await runHook({ session_id: 'codex', cwd: home, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5-codex' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.deepEqual(body.session.model, { name: 'gpt-5-codex', displayName: null, source: 'report' });
  await runHook({ hookEventName: 'subagent_start', hook_event_name: 'SubagentStart', sessionId: 'grok', subagentId: 'sub-1', agentType: 'reviewer', modelId: 'grok-build' });
  ({ body } = await call('GET', `/sessions/${session.id}`));
  assert.ok(body.session.agents.some((a) => a.id === 'hook-sub-1' && a.name === 'reviewer' && a.status === 'working'));
  await call('DELETE', `/sessions/${session.id}`);
});

async function startTool(providerId, extra = {}) {
  const { status, body } = await call('POST', '/sessions', { providerId, cwd: home, cols: 100, rows: 30, ...extra });
  assert.equal(status, 201, JSON.stringify(body));
  const client = terminal(body.session.id);
  await client.opened;
  return { session: body.session, client };
}

const sessionNow = async (id) => (await call('GET', `/sessions/${id}`)).body.session;
const reportingIs = (id, state) => async () => ((await sessionNow(id)).reporting?.state === state ? sessionNow(id) : null);
const agentIs = (id, name, status) => async () => (await sessionNow(id)).agents.find((a) => a.name === name && a.status === status);

async function followSubagent({ session, client }, agentId, type) {
  client.input(`subagent ${agentId} ${type}`);
  const working = await waitFor(agentIs(session.id, type, 'working'), { label: `${type} working`, timeout: 15000 })
    .catch((err) => { err.message += `\n${stripAnsi(client.output).slice(-1500)}`; throw err; });
  assert.equal(working.kind, 'subagent');
  client.input(`subagent-done ${agentId} ${type}`);
  const done = await waitFor(agentIs(session.id, type, 'done'), { label: `${type} done`, timeout: 15000 });
  assert.equal(done.id, working.id);
}

test('a Default Claude Code session reports sub-agents through a plugin loaded for that session only', async () => {
  fs.rmSync(userHookLog, { force: true });
  const tool = await startTool('anthropic');
  assert.equal(tool.session.reporting.state, 'pending');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'the session start hook', timeout: 15000 });
  await followSubagent(tool, 'claude-1', 'Explore');
  assert.match(stripAnsi(tool.client.output), /FAKE-CLAUDE READY hooks=11/, 'the plugin hooks load beside the user\'s own');
  assert.match(fs.readFileSync(userHookLog, 'utf8'), /claude-user/, 'the user\'s own hook still runs');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Default Codex CLI session reports sub-agents through trusted hooks passed on its command line', async () => {
  fs.rmSync(userHookLog, { force: true });
  const tool = await startTool('openai');
  assert.equal(tool.session.reporting.state, 'pending');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await sessionNow(tool.session.id)).reporting.state, 'pending', 'no prompt yet, so still waiting');
  tool.client.input('prompt');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'the session start hook', timeout: 15000 });
  await followSubagent(tool, 'codex-1', 'explorer');
  const output = stripAnsi(tool.client.output);
  assert.ok(!output.includes('CODEX-UNTRUSTED'), 'every Agent Guild hook is trusted for the session');
  assert.match(output, /FAKE-CODEX READY hooks=11/);
  assert.match(fs.readFileSync(userHookLog, 'utf8'), /codex-user/, 'the user\'s own hooks still run');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Codex CLI sub-agent given a follow-up works again at its first tool call, whatever the tool', async () => {
  const tool = await startTool('openai');
  tool.client.input('prompt');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'the session start hook', timeout: 15000 });
  await followSubagent(tool, 'codex-2', 'worker');
  tool.client.input('tool codex-2 apply_patch');
  await waitFor(async () => (await sessionNow(tool.session.id)).agents.find((a) => a.id === 'hook-codex-2' && a.status === 'working'), { label: 'working again', timeout: 15000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Codex CLI that refuses the hook overrides still starts, and says it is not reporting', async () => {
  const tool = await startTool('codexbroken');
  assert.equal(tool.session.reporting.state, 'unavailable');
  assert.match(tool.session.reporting.reason, /did not accept/);
  await waitForText(tool.client, tool.session.id, 'FAKE-CODEX READY hooks=1', 'Codex started without the overrides');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('Gemini CLI reports invoke_agent helpers once its extension is turned on, through a redacted environment', async (t) => {
  const google = async () => (await call('GET', '/providers')).body.providers.find((p) => p.id === 'google');
  assert.equal((await google()).accounts[0].reportingEnabled, false);
  const before = await startTool('google');
  assert.equal(before.session.reporting.state, 'setup_required');
  assert.match(before.session.reporting.reason, /Turn it on/);
  await before.client.close();
  await call('DELETE', `/sessions/${before.session.id}`);

  t.after(() => call('POST', '/providers/google/reporting', { enabled: false }));
  const on = await call('POST', '/providers/google/reporting', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.provider.accounts[0].reportingEnabled, true);
  const record = JSON.parse(fs.readFileSync(path.join(toolHomes.gemini, '.gemini', 'extensions', 'agent-guild', '.gemini-extension-install.json'), 'utf8'));
  assert.equal(record.source, path.join(home, 'reporting', 'gemini'), 'linked through Gemini\'s own command');

  const tool = await startTool('google');
  assert.equal(tool.session.reporting.state, 'pending');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'the session start hook', timeout: 15000 })
    .catch((err) => { err.message += `\n${stripAnsi(tool.client.output).slice(-1500)}`; throw err; });
  await followSubagent(tool, 'gemini-1', 'codebase_investigator');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);

  const off = await call('POST', '/providers/google/reporting', { enabled: false });
  assert.equal(off.body.provider.accounts[0].reportingEnabled, false);
  assert.ok(!fs.existsSync(path.join(toolHomes.gemini, '.gemini', 'extensions', 'agent-guild')));
  assert.equal((await call('POST', '/providers/anthropic/reporting', { enabled: true })).status, 400, 'nothing to turn on where hooks come with each session');
});

test('Grok Build reports sub-agents through --plugin-dir where it accepts it, and says when it cannot', async () => {
  const old = await startTool('xai');
  assert.equal(old.session.reporting.state, 'unsupported');
  assert.match(old.session.reporting.reason, /cannot load hooks for a single session/);
  await waitForText(old.client, old.session.id, 'FAKE-GROK READY hooks=0', 'Grok started without --plugin-dir');
  await old.client.close();
  await call('DELETE', `/sessions/${old.session.id}`);

  const tool = await startTool('grokplugins');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'the session start hook', timeout: 15000 });
  await followSubagent(tool, 'grok-1', 'reviewer');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a tool whose hooks are turned off keeps running and shows that it is not reporting', async () => {
  const tool = await startTool('claudeoff');
  await waitForText(tool.client, tool.session.id, 'FAKE-CLAUDE READY hooks=0', 'Claude with hooks off');
  assert.equal((await sessionNow(tool.session.id)).reporting.state, 'pending', 'silence before any prompt is not a failure');
  tool.client.input('prompt');
  const unavailable = await waitFor(reportingIs(tool.session.id, 'unavailable'), { label: 'the reporting timeout' });
  assert.match(unavailable.reporting.reason, /turned off, restricted by an administrator, or not trusted/);
  assert.equal(unavailable.status, 'running');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('each session\'s report token sits in an owner-only file that goes with the session', async () => {
  const tool = await startTool('anthropic');
  const file = path.join(home, 'report-tokens', tool.session.id);
  assert.equal(fs.readFileSync(file, 'utf8'), ctx.manager.get(tool.session.id).reportToken);
  if (!win) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
  await waitFor(() => !fs.existsSync(file), { label: 'token file removal' });
});

test('an untouched Codex hooks file from earlier versions goes only where the session gets the same hooks', async () => {
  const seeded = fs.readFileSync(path.join(here, '..', 'examples', 'codex-hooks.json'));
  const supplied = path.join(home, 'accounts', 'openai', 'work', 'hooks.json');
  const refused = path.join(home, 'accounts', 'codexbroken', 'work', 'hooks.json');
  writeFile(supplied, seeded);
  writeFile(refused, seeded);
  for (const providerId of ['openai', 'codexbroken']) {
    const tool = await startTool(providerId, { account: 'work' });
    await tool.client.close();
    await call('DELETE', `/sessions/${tool.session.id}`);
  }
  assert.ok(!fs.existsSync(supplied), 'Agent Guild supplies these hooks, so the copy would run each one twice');
  assert.deepEqual(fs.readFileSync(refused), seeded, 'this Codex refused the session hooks, so the copy is all the reporting it has');
});

test('a Claude Code account keeps the settings file earlier versions seeded, status line and all', async () => {
  const seeded = fs.readFileSync(path.join(here, '..', 'examples', 'claude-code-settings.json'));
  const file = path.join(home, 'accounts', 'anthropic', 'work', 'settings.json');
  writeFile(file, seeded);
  const tool = await startTool('anthropic', { account: 'work' });
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'session start hook', timeout: 15000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
  assert.deepEqual(fs.readFileSync(file), seeded);
  assert.match(seeded.toString(), /claude-statusline/, 'the status line a plugin cannot set');
});

test('the reporting probes start with the manager, before any session asks', () => {
  for (const id of ['anthropic', 'openai', 'xai']) assert.ok(probesAtStart.has(id), `${id} was being probed when the manager came up`);
});

test('a second manager that cannot start leaves the running one\'s report token files alone', async () => {
  const tool = await startTool('anthropic');
  const file = path.join(home, 'report-tokens', tool.session.id);
  assert.ok(fs.existsSync(file));
  await assert.rejects(startManager({ port: ctx.api.port, version: '1.0.0', packageFile, github: { apiUrl: fakeGitHub.url, webUrl: fakeGitHub.url, clientId: 'test-client' } }), /already in use/);
  assert.ok(fs.existsSync(file), 'the running session still authenticates through it');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Codex probe that loads no hooks is asked again, not trusted for good', async () => {
  const { SessionHooks } = await import('../src/manager/session-hooks.mjs');
  const codex = path.join(toolsDir, win ? 'codex.cmd' : 'codex');
  const registry = { providers: [], env: process.env, platform: process.platform, resolve: () => codex };
  const hooks = new SessionHooks({ registry, dir: path.join(home, 'probe-retry'), version: '1', probeRetryMs: 0 });
  const provider = { id: 'retry', tool: 'Retry Codex', reporting: 'codex', env: { FAKE_CODEX_LOADS_NONE: '1' } };
  assert.equal((await hooks.launch(provider, null)).reporting.state, 'unavailable');
  provider.env = {};
  const again = await hooks.launch(provider, null);
  assert.equal(again.reporting.state, 'pending', 'the next session gets the hooks once Codex loads them');
  assert.ok(again.args.length > 0);
});

test('turning Gemini reporting on replaces a link left by an earlier data folder, and refuses another extension\'s name', async (t) => {
  const record = path.join(toolHomes.gemini, '.gemini', 'extensions', 'agent-guild', '.gemini-extension-install.json');
  t.after(() => fs.rmSync(path.dirname(record), { recursive: true, force: true }));
  const enablement = path.join(toolHomes.gemini, '.gemini', 'extensions', 'extension-enablement.json');
  t.after(() => fs.rmSync(enablement, { force: true }));
  writeFile(enablement, JSON.stringify({ 'agent-guild': { overrides: ['!/*'] }, other: { overrides: ['/*'] } }));
  const oldData = path.join(home, 'old-data', 'reporting', 'gemini');
  fs.mkdirSync(oldData, { recursive: true });
  writeFile(record, JSON.stringify({ source: oldData, type: 'link' }));
  let res = await call('POST', '/providers/google/reporting', { enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).source, path.join(home, 'reporting', 'gemini'));
  assert.ok(!fs.existsSync(path.join(toolHomes.gemini, '.gemini', 'trustedFolders.json')), 'linking trusts no folder');
  assert.deepEqual(JSON.parse(fs.readFileSync(enablement, 'utf8')), { other: { overrides: ['/*'] } }, 'the dangling link\'s disabled state goes with it, as Gemini\'s uninstall would do');
  const cwds = new Set(fs.readFileSync(geminiCwdLog, 'utf8').trim().split(/\r?\n/).map((dir) => fs.realpathSync.native(dir)));
  assert.deepEqual([...cwds], [fs.realpathSync.native(path.join(home, 'reporting'))], 'never the folder the manager was started in');
  assert.equal((await call('POST', '/providers/google/reporting', { enabled: false })).status, 200);
  assert.ok(!fs.existsSync(record));

  const foreign = path.join(home, 'someone-elses-extension');
  writeFile(path.join(foreign, 'gemini-extension.json'), JSON.stringify({ name: 'agent-guild', version: '1', description: 'Not ours' }));
  writeFile(record, JSON.stringify({ source: foreign, type: 'link' }));
  res = await call('POST', '/providers/google/reporting', { enabled: true });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'extension_conflict');
  assert.equal((await call('POST', '/providers/google/reporting', { enabled: false })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).source, foreign, 'someone else\'s extension is never removed');
});

function watchShells(id) {
  const seen = [];
  let leaked = false;
  const onEvent = (event) => {
    const text = JSON.stringify(event);
    if (text.includes('SECRET-MARKER')) leaked = true;
    if (event.session?.id === id) seen.push(event.session.shells.map((sh) => sh.id));
  };
  ctx.manager.on('event', onEvent);
  return { seen, leaked: () => leaked, stop: () => ctx.manager.off('event', onEvent) };
}
const shellsNow = async (id) => (await sessionNow(id)).shells;
const shellCountIs = (id, n) => async () => (await shellsNow(id)).length === n;

async function runShells(tool, lines, label) {
  for (const line of lines) tool.client.input(line);
  await waitFor(() => stripAnsi(tool.client.output).includes(label), { label, timeout: 15000 })
    .catch((err) => { err.message += `\n${stripAnsi(tool.client.output).slice(-1500)}`; throw err; });
}

test('a session shows each shell command from its start until its end, whatever reports that end', async () => {
  const { id } = await createFake();
  const session = ctx.manager.get(id);
  Object.assign(session, { shellDisplayDelayMs: 0, shellPidCheckMs: 25 });
  const report = (r) => session.reportShell(r);
  const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
  const drawn = async () => { await settle(); return session.toJSON().shells.length; };
  const keys = () => [...session.shells.values()].map((sh) => sh.key).sort();
  const m = (n) => String(n).repeat(32);

  report({ shell: 'start', key: 'k1', match: m(1) });
  assert.equal(await drawn(), 1);
  report({ shell: 'end', key: 'k1' });
  assert.equal(await drawn(), 0);

  report({ shell: 'start', key: 'k2', match: m(2) });
  report({ shell: 'waiting', match: m(2) });
  assert.equal(await drawn(), 0, 'hidden while it waits for permission');
  report({ shell: 'background', key: 'k2', task: 't2' });
  assert.equal(await drawn(), 1, 'running in the background, so drawn again');
  report({ shell: 'running', tasks: [] });
  assert.equal(await drawn(), 0, 'a task the tool no longer lists has ended');
  report({ shell: 'running', tasks: ['t2', 't3'] });
  assert.equal(session.toJSON().shells.length, 1, 'an ended task never comes back; one not seen before is drawn at once');
  report({ shell: 'end', task: 't3' });
  report({ shell: 'end', task: 't4' });
  report({ shell: 'running', tasks: ['t4'] });
  assert.equal(await drawn(), 0, 'nor one whose end came before the list');

  report({ shell: 'start', key: 'c1', match: m(3), persist: true });
  report({ shell: 'start', key: 'c2', match: m(4), persist: true });
  report({ shell: 'start', key: 'f1', match: m(5) });
  report({ shell: 'asked', match: m(4) });
  assert.equal(await drawn(), 3, 'a permission request that hides nothing');
  session.reportAgent({ finishForeground: true });
  assert.deepEqual(keys(), ['c1'], 'past its turn, only a command that persists and was not asked about');
  report({ shell: 'reset' });
  assert.equal(await drawn(), 0);

  session.reportAgent({ agentId: 'hook-a', name: 'Explore', status: 'working' });
  report({ shell: 'start', key: 's1', agentId: 'hook-a' });
  report({ shell: 'start', key: 's2', agentId: 'hook-a' });
  report({ shell: 'background', key: 's2', task: 'ts2', endsWithAgent: true });
  report({ shell: 'start', key: 's3', agentId: 'hook-a' });
  report({ shell: 'background', key: 's3', task: 'ts3' });
  report({ shell: 'start', key: 'main' });
  session.reportAgent({ agentId: 'hook-a', status: 'done' });
  assert.deepEqual(keys(), ['main', 's3'], 'a sub-agent\'s end takes its commands, but not one that outlives it');
  report({ shell: 'end', task: 'ts3' });
  report({ shell: 'end', key: 'main' });
  report({ shell: 'start', key: 'h1', agentId: 'hook-helper' });
  session.reportAgent({ agentId: 'hook-helper', status: 'done' });
  assert.equal(session.shells.size, 0, 'so does the end of one never seen starting');

  report({ shell: 'start', key: 'x1', match: m(6) });
  report({ shell: 'start', key: 'x2', match: m(6) });
  report({ shell: 'waiting', match: m(6) });
  assert.equal(await drawn(), 2, 'a request that could be either of two identical commands hides neither');
  report({ shell: 'end', key: 'x1' });
  report({ shell: 'waiting', match: m(7) });
  assert.equal(await drawn(), 0, 'a rewritten request goes to the only command left');
  report({ shell: 'end', key: 'x2' });

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
  await once(child, 'spawn');
  report({ shell: 'start', bucket: 'ab' });
  report({ shell: 'background', bucket: 'ab', pids: [child.pid] });
  assert.equal(await drawn(), 1, 'followed by its pid');
  await once(child, 'exit');
  await waitFor(shellCountIs(id, 0), { label: 'gone once its process exits', timeout: 2000 });
  assert.equal(session._pidTimer, null, 'and no pid is checked any more');
  report({ shell: 'start', bucket: 'cd' });
  report({ shell: 'background', bucket: 'cd', pids: [child.pid] });
  assert.equal(session.shells.size, 0, 'a pid that has already exited ends the command at once');

  assert.throws(() => report({ shell: 'start' }), /key or a bucket/);
  assert.throws(() => report({ shell: 'background', key: 'k9' }), /task or pids/);
  assert.throws(() => report({ shell: 'running' }), /tasks array/);
  assert.throws(() => report({ shell: 'end' }), /key, a bucket or a task/);
  await call('DELETE', `/sessions/${id}`);
});

test('Claude Code shell commands show while they run: not the brief ones, and not after they end', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  const watch = watchShells(tool.session.id);
  await runShells(tool, ['shell quick 150 fg echo SECRET-MARKER quick'], 'SHELL-DONE quick');
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(watch.seen.every((ids) => ids.length === 0), 'a 150 ms command is never drawn');
  tool.client.input('shell long 2500 fg sleep 2.5 SECRET-MARKER');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'the running command' });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE long', 'long command end');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone at its end', timeout: 1000 });
  tool.client.input('shell bg1 2000 bg npm run dev SECRET-MARKER');
  tool.client.input('shell bg2 4000 bg npm run dev SECRET-MARKER');
  await waitFor(shellCountIs(tool.session.id, 2), { label: 'two background commands', timeout: 15000 });
  await waitForText(tool.client, tool.session.id, 'SHELL-NOTIFIED bg1', 'the first one\'s notification');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'the first ends with its notification', timeout: 1000 });
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'the turn\'s end lists the one still running');
  await waitForText(tool.client, tool.session.id, 'SHELL-NOTIFIED bg2', 'the second one\'s notification');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'the second ends with its notification', timeout: 1000 });
  assert.deepEqual((await sessionNow(tool.session.id)).agents, []);
  watch.stop();
  assert.ok(!watch.leaked(), 'no command text in any event');
  assert.ok(!JSON.stringify(await call('GET', '/sessions')).includes('SECRET-MARKER'));
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Claude Code background command ends with TaskStop, or with the turn whose end no longer lists it', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  tool.client.input('shell stopped 30000 bg npm run dev');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'drawn', timeout: 15000 });
  await runShells(tool, ['taskstop stopped'], 'TASK-STOPPED stopped');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone with TaskStop', timeout: 2000 });
  tool.client.input('shell silent 1500 bg-silent npm test');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'drawn', timeout: 15000 });
  await waitForText(tool.client, tool.session.id, 'SHELL-EXITED silent', 'exit without a notification');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'nothing reported its end yet');
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone: the turn\'s end no longer lists it', timeout: 2000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Claude Code command waiting for permission is never drawn, approved or refused', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  const watch = watchShells(tool.session.id);
  await runShells(tool, ['shell refused 3000 ask-no rm -rf build'], 'SHELL-REJECTED refused');
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(() => ctx.manager.get(tool.session.id).shells.size === 0, { label: 'the refused command is gone' });
  await runShells(tool, ['shell approved 1500 ask-yes npm run build'], 'SHELL-DONE approved');
  await runShells(tool, ['shell rewritten 1500 ask-rewrite npm test'], 'SHELL-DONE rewritten');
  await waitFor(() => ctx.manager.get(tool.session.id).shells.size === 0, { label: 'both gone at their end' });
  assert.deepEqual(watch.seen.filter((ids) => ids.length), [], 'no event says it was approved, so it stays hidden while it runs');
  watch.stop();
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a permission request that matches no command and could be any of several leaves them all as they were', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  await runShells(tool, ['shell-denied a npm test', 'shell-denied b make lint'], 'SHELL-DENIED b');
  const session = ctx.manager.get(tool.session.id);
  await waitFor(() => session.shells.size === 2, { label: 'both announced' });
  const byCommand = () => Object.fromEntries([...session.shells.values()].map((sh) => [sh.key, { match: sh.match, waiting: sh.waiting }]));
  const before = byCommand();

  await runShells(tool, ['permit npm test -- --runInBand'], 'PERMIT npm test -- --runInBand');
  assert.deepEqual(byCommand(), before, 'a rewritten request for a, with b also announced, changes neither');

  await runShells(tool, ['permit make lint'], 'PERMIT make lint');
  assert.equal(byCommand().b.waiting, true, 'the request naming b\'s own command finds b');
  assert.equal(byCommand().a.waiting, false);

  await runShells(tool, ['permit npm test -- --ci'], 'PERMIT npm test -- --ci');
  assert.equal(byCommand().a.waiting, true, 'once a is the only command left, the rewritten request is a\'s');
  assert.equal((await shellsNow(tool.session.id)).length, 0, 'neither drawn while waiting');

  await runShells(tool, ['turn-end', 'shell-denied c cargo build', 'shell-denied d cargo build'], 'SHELL-DENIED d');
  await waitFor(() => session.shells.size === 2, { label: 'two identical commands announced' });
  await runShells(tool, ['permit cargo build'], 'PERMIT cargo build');
  assert.deepEqual([byCommand().c.waiting, byCommand().d.waiting], [false, false], 'a request that could be either of two identical commands hides neither');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('Claude Code PowerShell commands show and leave like Bash ones', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  tool.client.input('shell pwsh1 2500 ps Get-ChildItem -Recurse');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'shown', timeout: 15000 });
  await runShells(tool, [], 'SHELL-DONE pwsh1');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone', timeout: 2000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Claude Code command whose end never comes, or that Esc ends, leaves with its turn; one Esc moves to the background stays', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  await runShells(tool, ['shell-denied refused rm -rf /', 'shell stopped 1000 interrupt sleep 60'], 'SHELL-INTERRUPTED stopped');
  await waitFor(shellCountIs(tool.session.id, 2), { label: 'both drawn: no hook says either ended', timeout: 3000 });
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone with the turn', timeout: 2000 });

  await runShells(tool, ['shell moved 3000 esc-bg npm run build'], 'SHELL-ESCAPED moved');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'drawn', timeout: 3000 });
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'the turn\'s end lists it as a background task');
  await waitForText(tool.client, tool.session.id, 'SHELL-NOTIFIED moved', 'its notification');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone with its notification', timeout: 2000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('Codex CLI commands show until Codex reports their end, past their turn and Esc', async () => {
  const tool = await startTool('openai');
  tool.client.input('prompt');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  const watch = watchShells(tool.session.id);
  await runShells(tool, ['shell quick 200 fg ls SECRET-MARKER'], 'SHELL-DONE quick');
  tool.client.input('shell held 3000 fg cargo build SECRET-MARKER');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'the long command', timeout: 15000 });
  await runShells(tool, ['turn-end', 'interrupt'], 'INTERRUPTED');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'Codex keeps it running past its turn and Esc');
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE held', 'its end, when the model checks on it');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone at its end', timeout: 1000 });
  assert.ok(watch.seen.every((ids) => ids.length <= 1), 'the brief command never showed');

  await runShells(tool, ['shell orphan 800 unpolled npm run dev', 'shell-denied blocked rm -rf /'], 'SHELL-EXITED orphan');
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(shellCountIs(tool.session.id, 2), { label: 'neither reported an end', timeout: 3000 });
  await runShells(tool, ['session-end'], 'SESSION-ENDED');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone with the thread that ran them', timeout: 2000 });
  watch.stop();
  assert.ok(!watch.leaked());
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Codex CLI command that asked permission stays drawn, and one refused leaves with its turn', async () => {
  const tool = await startTool('openai');
  tool.client.input('prompt');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  await runShells(tool, ['shell refused 3000 ask-no git push'], 'SHELL-REJECTED refused');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'drawn: Codex may approve a request on its own');
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone with its turn: a refusal reports no end', timeout: 2000 });
  tool.client.input('shell approved 2500 ask-yes npm test');
  await waitForText(tool.client, tool.session.id, 'SHELL-STARTED approved', 'approved');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'drawn while it runs', timeout: 2000 });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE approved', 'its end');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'gone at its end', timeout: 1000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('more shell commands than the card draws are still all counted', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  for (let i = 0; i < 20; i++) tool.client.input(`shell many${i} 4000 fg build part ${i}`);
  await waitFor(shellCountIs(tool.session.id, 20), { label: 'twenty commands', timeout: 15000 });
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'all ended', timeout: 15000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('identical Gemini CLI commands each get their own familiar, and a background one ends with its pid', async (t) => {
  assert.equal((await call('POST', '/providers/google/reporting', { enabled: true })).status, 200);
  t.after(() => call('POST', '/providers/google/reporting', { enabled: false }));
  const tool = await startTool('google');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  tool.client.input('shell a 1500 fg npm test');
  tool.client.input('shell b 3000 fg npm test');
  await waitFor(shellCountIs(tool.session.id, 2), { label: 'two identical commands' });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE a', 'first end');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'one left', timeout: 1000 });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE b', 'second end');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'none left', timeout: 1000 });
  tool.client.input('shell server 3000 bg python -m http.server');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'background command', timeout: 15000 });
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  assert.equal((await shellsNow(tool.session.id)).length, 1, 'its process outlives the turn');
  await waitForText(tool.client, tool.session.id, 'SHELL-EXITED server', 'server exit');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'ended with its pid', timeout: 5000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Gemini CLI background command that has already ended is never drawn', async (t) => {
  assert.equal((await call('POST', '/providers/google/reporting', { enabled: true })).status, 200);
  t.after(() => call('POST', '/providers/google/reporting', { enabled: false }));
  const tool = await startTool('google');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  const watch = watchShells(tool.session.id);
  await runShells(tool, ['shell instant 1 bg-instant true'], 'SHELL-BACKGROUNDED instant');
  assert.equal(ctx.manager.get(tool.session.id).shells.size, 0, 'the pid Gemini named had already exited');
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepEqual(watch.seen.filter((ids) => ids.length), [], 'never drawn');
  watch.stop();
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Claude Code sub-agent stopped with TaskStop leaves the card, and neither its notification nor a prompt typed meanwhile ends the turn', async () => {
  const tool = await startTool('anthropic');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  await runShells(tool, ['subagent a7 general-purpose'], 'SUBAGENT a7');
  await waitFor(async () => (await sessionNow(tool.session.id)).agents.length === 1, { label: 'working' });
  await runShells(tool, ['shell meanwhile 4000 fg npm test', 'subagent-killed a7 general-purpose', 'prompt'], 'PROMPT-DONE');
  await waitFor(async () => (await sessionNow(tool.session.id)).agents.length === 0, { label: 'gone without a SubagentStop', timeout: 3000 });
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'the command started just before still runs: no turn ended', timeout: 3000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('a Gemini CLI call whose input a BeforeTool hook rewrote still ends, unless it could be another call', async (t) => {
  assert.equal((await call('POST', '/providers/google/reporting', { enabled: true })).status, 200);
  t.after(() => call('POST', '/providers/google/reporting', { enabled: false }));
  const tool = await startTool('google');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });

  tool.client.input('shell fgr 1200 fg-rewrite npm test');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'shown' });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE fgr', 'end');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'ended by its rewritten AfterTool', timeout: 1000 });

  tool.client.input('shell bgr 2000 bg-rewrite npm start');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'its rewritten AfterTool named its pid', timeout: 15000 });
  await waitForText(tool.client, tool.session.id, 'SHELL-EXITED bgr', 'exit');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'ended with its pid', timeout: 5000 });

  tool.client.input('shell one 1500 fg-rewrite make a');
  tool.client.input('shell two 3500 fg make b');
  await waitFor(shellCountIs(tool.session.id, 2), { label: 'both shown' });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE one', 'first end');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await shellsNow(tool.session.id)).length, 2, 'a rewritten end that could be either command ends neither');
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE two', 'second end');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'the second ends by its own input', timeout: 1000 });
  await runShells(tool, ['turn-end'], 'TURN-ENDED');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'the first ends with the turn', timeout: 1000 });

  const working = (name) => agentIs(tool.session.id, name, 'working');
  await runShells(tool, ['subagent g1 researcher', 'subagent-done-rewritten g1 researcher'], 'SUBAGENT-DONE g1');
  await waitFor(agentIs(tool.session.id, 'researcher', 'done'), { label: 'the agent ends by its rewritten AfterTool' });
  await runShells(tool, ['subagent g2 planner', 'subagent g3 coder', 'subagent-done-rewritten g2 planner'], 'SUBAGENT-DONE g2');
  assert.ok(await working('planner')() && await working('coder')(), 'a rewritten end that could be either agent ends neither');
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('Grok Build shell commands show from its hooks where it takes them', async () => {
  const tool = await startTool('grokplugins');
  await waitFor(reportingIs(tool.session.id, 'active'), { label: 'hooks', timeout: 15000 });
  tool.client.input('shell build 2500 fg make');
  await waitFor(shellCountIs(tool.session.id, 1), { label: 'running command' });
  await waitForText(tool.client, tool.session.id, 'SHELL-DONE build', 'end');
  await waitFor(shellCountIs(tool.session.id, 0), { label: 'removed', timeout: 1000 });
  await tool.client.close();
  await call('DELETE', `/sessions/${tool.session.id}`);
});

test('no session changed a tool\'s own home folder', () => {
  for (const [name, dir] of Object.entries(toolHomes)) assert.deepEqual(snapshot(dir), homesBefore[name], `${name} home unchanged`);
});

test('the model comes from arguments, the screen, or an explicit report', async () => {
  const session = await createFake({ args: ['--model', 'fake-model-1'] });
  assert.deepEqual(session.model, { name: 'fake-model-1', displayName: null, source: 'args' });
  const client = terminal(session.id);
  await client.opened;
  const modelIs = (name, source) => async () => {
    const { body } = await call('GET', `/sessions/${session.id}`);
    return body.session.model?.name === name && body.session.model.source === source ? body.session.model : null;
  };

  // Text on screen that matches the provider's modelPattern wins over the argument.
  client.input('echo now on fake-model-2.5, really');
  assert.equal((await waitFor(modelIs('fake-model-2.5', 'screen'), { label: 'screen model' })).source, 'screen');

  // A tool that keeps printing is still scanned while it prints.
  client.input('stream 3500 switching to fake-model-7');
  await waitFor(modelIs('fake-model-7', 'screen'), { timeout: 3000, label: 'model during continuous output' });
  await waitForText(client, session.id, 'STREAM-DONE', 'stream end');

  // An explicit report wins over the screen and is not replaced by later screen text.
  client.input('model fake-model-3 Three');
  const reported = await waitFor(modelIs('fake-model-3', 'report'), { label: 'reported model' });
  assert.equal(reported.displayName, 'Three');
  client.input('echo mention fake-model-4');
  await waitForText(client, session.id, 'ECHO:mention fake-model-4', 'later screen text');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.model.name, 'fake-model-3');

  // Reports also arrive over HTTP with the session report token.
  const managed = ctx.manager.get(session.id);
  const ok = await call('POST', `/sessions/${session.id}/model`, { model: 'fake-model-5' }, { Authorization: '', 'X-Agent-Guild-Report-Token': managed.reportToken });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.model, { name: 'fake-model-5', displayName: null, source: 'report' });
  assert.equal((await call('POST', `/sessions/${session.id}/model`, { model: '' })).status, 400);
  assert.equal((await call('POST', `/sessions/${session.id}/model`, { model: 'x' }, { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' })).status, 401);

  // Claude Code's status line feeds the model id and display name.
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = { ...process.env, AGENT_GUILD_URL: base, AGENT_GUILD_SESSION_ID: session.id, AGENT_GUILD_REPORT_TOKEN: managed.reportToken };
  const statusline = { model: { id: 'claude-opus-4-5', display_name: 'Opus 4.5' }, workspace: { current_dir: home }, context_window: { used_percentage: 12.4 } };
  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [reporter, '--claude-statusline'], { env, timeout: 10000 }, (err, out, stderr) => (err ? reject(new Error(stderr)) : resolve(out)));
    child.stdin.end(JSON.stringify(statusline));
  });
  assert.equal(stdout, `[Opus 4.5] | ${path.basename(home)} | 12% context\n`);
  assert.deepEqual((await call('GET', `/sessions/${session.id}`)).body.session.model, { name: 'claude-opus-4-5', displayName: 'Opus 4.5', source: 'report' });

  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('a hook run through the shell finds agent-guild-report on the session PATH', async () => {
  // The tools run `agent-guild-report --hook` by name in a shell that inherits
  // the session environment; nobody ran npm link here.
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('env');
  await waitForText(client, session.id, `|${path.join(home, 'bin')}`, 'launcher folder first on PATH');

  const shells = process.platform === 'win32' ? ['cmd', 'powershell'] : ['sh'];
  for (const [i, shell] of shells.entries()) {
    const payload = { session_id: 'claude-session', hook_event_name: 'SubagentStart', agent_id: `via-${shell}`, agent_type: 'Explore' };
    client.input(`hook ${shell} ${JSON.stringify(payload)}`);
    await waitFor(() => (stripAnsi(client.output).match(/HOOK-EXIT:[^\r\n]*/g) || []).length > i, { timeout: 20000, label: `${shell} hook exit` });
    const line = stripAnsi(client.output).match(/HOOK-EXIT:[^\r\n]*/g)[i];
    assert.match(line, /^HOOK-EXIT:0 STDERR:""/, `${shell}: ${line}`);
    const agents = (await call('GET', `/sessions/${session.id}`)).body.session.agents;
    assert.ok(agents.some((a) => a.id === `hook-via-${shell}` && a.name === 'Explore' && a.status === 'working'), `${shell}: ${JSON.stringify(agents)}`);
  }
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('a model reported while a foreground agent works is the agent\'s, not the session\'s', async () => {
  const session = await createFake();
  const route = `/sessions/${session.id}`;
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-main' })).body.model.name, 'fake-model-main');
  // Gemini CLI: BeforeModel fires for the sub-agent's own requests while invoke_agent runs.
  const [start] = [{ agentId: 'hook-task-1', name: 'codebase_investigator', kind: 'subagent', foreground: true }];
  assert.equal((await call('POST', `${route}/agents`, start)).body.agent.foreground, true);
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-sub' })).body.model.name, 'fake-model-main', 'ignored while the agent works');
  await call('POST', `${route}/agents`, { agentId: 'hook-task-1', status: 'done' });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-next' })).body.model.name, 'fake-model-next', 'accepted once the agent is done');
  // A cancelled call never reports done; the next turn boundary closes it.
  await call('POST', `${route}/agents`, { agentId: 'hook-task-2', name: 'generalist', kind: 'subagent', foreground: true });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-sub' })).body.model.name, 'fake-model-next');
  assert.equal((await call('POST', `${route}/agents`, { finishForeground: true })).body.agent, null);
  assert.equal((await call('GET', route)).body.session.agents.find((a) => a.id === 'hook-task-2').status, 'done');
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-after' })).body.model.name, 'fake-model-after', 'model reports resume after the boundary');
  // A background agent (Claude Code, Codex CLI) does not block its parent.
  await call('POST', `${route}/agents`, { agentId: 'hook-bg', name: 'Explore', kind: 'subagent' });
  assert.equal((await call('POST', `${route}/model`, { model: 'fake-model-switched' })).body.model.name, 'fake-model-switched');
  const { agents } = (await call('GET', route)).body.session;
  assert.equal(agents.find((a) => a.id === 'hook-bg').foreground, false);
  await call('DELETE', route);
});

test('agent-guild-report does nothing outside an Agent Guild terminal', async () => {
  const reporter = path.resolve(here, '../bin/agent-guild-report.mjs');
  const env = { ...process.env };
  delete env.AGENT_GUILD_URL; delete env.AGENT_GUILD_SESSION_ID; delete env.AGENT_GUILD_REPORT_TOKEN;
  const code = await new Promise((resolve) => {
    const child = execFile(process.execPath, [reporter, '--claude-hook'], { env }, (err) => resolve(err ? err.code : 0));
    child.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: 'Plan' }));
  });
  assert.equal(code, 0);
});

test('agents can be reported in-band with an OSC escape sequence', async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('agent worker-7 Builder');
  const agents = await waitFor(async () => {
    const { body } = await call('GET', `/sessions/${session.id}`);
    return body.session.agents.length ? body.session.agents : null;
  }, { label: 'osc agent' });
  assert.equal(agents[0].id, 'worker-7');
  assert.equal(agents[0].name, 'Builder');
  assert.equal(agents[0].source, 'terminal');
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('the events socket announces session lifecycle changes', async () => {
  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;
  await waitFor(() => events.messages.find((m) => m.type === 'hello'), { label: 'hello' });

  const session = await createFake({ name: 'Lifecycle' });
  assert.equal(session.exitedAt, null);
  await waitFor(() => events.messages.find((m) => m.type === 'session.created' && m.session.id === session.id), { label: 'created' });

  const renamed = await call('PATCH', `/sessions/${session.id}`, { name: 'Renamed' });
  assert.equal(renamed.body.session.name, 'Renamed');

  const term = terminal(session.id);
  await term.opened;
  const beforeExit = Date.now();
  term.input('exit 3');
  const exit = await waitFor(() => term.messages.find((m) => m.type === 'exit'), { label: 'exit message' });
  assert.equal(exit.exitCode, 3);
  const updated = await waitFor(() => events.messages.find((m) => m.type === 'session.updated' && m.session.id === session.id && m.session.status === 'exited'), { label: 'exited event' });
  const exitedAt = updated.session.exitedAt;
  assert.ok(Date.parse(exitedAt) >= beforeExit && Date.parse(exitedAt) <= Date.now(), 'exit time is recorded when the process exits');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.exitedAt, exitedAt);
  assert.equal((await call('GET', '/sessions')).body.sessions.find((s) => s.id === session.id).exitedAt, exitedAt);

  const reconnected = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await reconnected.opened;
  const hello = await waitFor(() => reconnected.messages.find((m) => m.type === 'hello'), { label: 'reconnected hello' });
  assert.equal(hello.sessions.find((s) => s.id === session.id).exitedAt, exitedAt);
  await reconnected.close();

  // Exited sessions stay listed until removed, and still replay their last screen.
  const late = terminal(session.id);
  await late.opened;
  await waitFor(() => late.messages.find((m) => m.type === 'exit'), { label: 'exit replay' });
  assert.equal(late.messages[0].type, 'snapshot');
  assert.equal(late.messages[0].session.exitedAt, exitedAt);

  assert.equal((await call('DELETE', `/sessions/${session.id}`)).status, 200);
  await waitFor(() => events.messages.find((m) => m.type === 'session.removed' && m.sessionId === session.id), { label: 'removed' });
  assert.equal(await late.closed, 4410);
  assert.equal((await call('GET', `/sessions/${session.id}`)).status, 404);
  await term.close();
  await events.close();
});

test('stop ends a running session', async () => {
  const session = await createFake();
  assert.equal(session.exitedAt, null);
  const beforeStop = Date.now();
  const { status } = await call('POST', `/sessions/${session.id}/stop`);
  assert.equal(status, 200);
  await waitFor(async () => (await call('GET', `/sessions/${session.id}`)).body.session.status === 'exited', { label: 'stopped' });
  const stopped = (await call('GET', `/sessions/${session.id}`)).body.session;
  assert.equal(stopped.pid, null, 'an exited session has no pid');
  assert.ok(Date.parse(stopped.exitedAt) >= beforeStop && Date.parse(stopped.exitedAt) <= Date.now(), 'stopping records an exit time');
  await call('DELETE', `/sessions/${session.id}`);
});

test('shutdown is refused while sessions are running unless forced', async () => {
  const session = await createFake();
  const refused = await call('POST', '/shutdown');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'sessions_running');
  assert.equal(refused.body.error.running, ctx.manager.runningCount());
  assert.ok(refused.body.error.running >= 1);
  assert.equal((await fetch(`${base}/api/v1/health`)).status, 200, 'the manager keeps running');
  assert.equal((await call('GET', `/sessions/${session.id}`)).body.session.status, 'running');
  await call('DELETE', `/sessions/${session.id}`);
});

test('model stats come from the catalog and match each session\'s model', async () => {
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const { ModelStats } = await import('../src/manager/model-stats.mjs');
  const entry = (id, coding) => ({
    id,
    name: `Test: ${id}`,
    created: 1780000000,
    architecture: { output_modalities: ['text'] },
    supported_parameters: ['tools'],
    benchmarks: { artificial_analysis: { coding_index: coding } },
  });
  let fetches = 0;
  const modelStats = new ModelStats({
    registry: ctx.registry,
    fetchImpl: async () => {
      fetches++;
      return { ok: true, json: async () => ({ data: [entry('test/fake-model-1', 50), entry('test/fake-model-2', 70)] }) };
    },
  });
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    modelStats,
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const session = await createFake({ args: ['--model', 'fake-model-1'] });
  try {
    const res = await fetch(`${spare.url}/api/v1/model-stats`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.providers.fake.models, ['test/fake-model-1', 'test/fake-model-2']);
    assert.equal(body.sessions[session.id], 'test/fake-model-1');
    assert.deepEqual([body.models['test/fake-model-1'].stats.coding.level, body.models['test/fake-model-2'].stats.coding.tier], [0, 'S']);
    assert.equal((await fetch(`${spare.url}/api/v1/model-stats`)).status, 401);
    assert.equal(fetches, 1);
  } finally {
    await call('DELETE', `/sessions/${session.id}`);
    await spare.close();
  }
});

test('the news endpoint needs the token, answers at once while it refreshes, and announces the refresh', async () => {
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const { NewsFeed } = await import('../src/manager/news.mjs');
  const published = new Date(Date.now() - 3600000).toUTCString();
  const news = new NewsFeed({
    feeds: [{ id: 'test', name: 'Test News', category: 'news', url: 'https://news.test/feed' }],
    fetchImpl: async () => new Response(`<rss version="2.0"><channel><item><title>Agents ship</title><link>https://news.test/agents</link><pubDate>${published}</pubDate><description>Plain words</description></item></channel></rss>`),
  });
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    modelStats: { snapshot: async () => ({}) },
    news,
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const events = new Client(`${spare.url.replace('http', 'ws')}/api/v1/events?token=${token}`);
  const read = async () => (await fetch(`${spare.url}/api/v1/news`, { headers: { Authorization: `Bearer ${token}` } })).json();
  try {
    await events.opened;
    assert.equal((await fetch(`${spare.url}/api/v1/news`)).status, 401);
    assert.deepEqual(await read(), {
      refreshedAt: null, refreshing: true, sources: [{ id: 'test', name: 'Test News', category: 'news', error: null, okAt: null }], items: [],
    });
    await waitFor(() => events.messages.find((m) => m.type === 'news.updated'), { label: 'news.updated' });
    const body = await read();
    assert.equal(body.refreshing, false);
    assert.deepEqual(body.items.map((i) => [i.title, i.url, i.source, i.summary]), [['Agents ship', 'https://news.test/agents', 'Test News', 'Plain words']]);
    assert.deepEqual(body.sources.map((s) => [s.name, s.error]), [['Test News', null]]);
  } finally {
    await events.close();
    await spare.close();
  }
});

test('the changelog endpoint needs the token, answers at once while it checks, and announces the result', async () => {
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const { Changelog } = await import('../src/manager/changelog.mjs');
  const release = {
    tag_name: 'v1.0.0', html_url: 'https://github.com/oddessentials/agent-guild/releases/tag/v1.0.0', published_at: '2026-10-01T15:42:18Z',
    body: '### Features\n\n* **page:** show the changelog',
  };
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    modelStats: { snapshot: async () => ({}) },
    changelog: new Changelog({ fetchImpl: async () => new Response(JSON.stringify([release])) }),
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const events = new Client(`${spare.url.replace('http', 'ws')}/api/v1/events?token=${token}`);
  const read = async () => (await fetch(`${spare.url}/api/v1/changelog`, { headers: { Authorization: `Bearer ${token}` } })).json();
  try {
    await events.opened;
    assert.equal((await fetch(`${spare.url}/api/v1/changelog`)).status, 401);
    assert.deepEqual(await read(), { refreshing: true, okAt: null, error: null, releases: [] });
    await waitFor(() => events.messages.find((m) => m.type === 'changelog.updated'), { label: 'changelog.updated' });
    const body = await read();
    assert.deepEqual([body.refreshing, body.error], [false, null]);
    assert.deepEqual(body.releases, [{
      version: '1.0.0', url: release.html_url, publishedAt: '2026-10-01T15:42:18.000Z',
      sections: [{ title: 'Features', changes: [[{ text: 'page:', strong: true }, { text: ' show the changelog' }]] }],
    }]);
  } finally {
    await events.close();
    await spare.close();
  }
});

test('no session can start once a shutdown has been accepted', async () => {
  // A second API server over the same manager, whose shutdown callback does
  // nothing, so the accepted request can be observed without exiting.
  const { createManagerServer } = await import('../src/manager/server.mjs');
  const spare = createManagerServer({
    manager: ctx.manager,
    registry: ctx.registry,
    usage: { all: async () => [] },
    token,
    webDir: path.join(here, '..', 'web'),
    onShutdownRequest: () => {},
  });
  await spare.listen();
  const spareCall = (method, route, body) => fetch(`${spare.url}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
  try {
    const accepted = await spareCall('POST', '/shutdown', { force: true });
    assert.equal(accepted.status, 202);
    assert.equal(ctx.manager.closing, true, 'the guard is set as soon as the shutdown is accepted');
    // Through either server: the guard lives in the manager.
    const { status, body } = await call('POST', '/sessions', { providerId: 'fake', cwd: home });
    assert.equal(status, 503);
    assert.equal(body.error.code, 'manager_stopping');
    assert.equal((await call('POST', '/providers/missing/install')).status, 503);
    assert.equal((await spareCall('POST', '/sessions', { providerId: 'fake', cwd: home })).status, 503);
  } finally {
    ctx.manager.closing = false;
    await spare.close();
  }
});

test('a tool that ignores the hang-up is force-killed', { skip: process.platform === 'win32' }, async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('stubborn');
  await waitFor(() => client.output.includes('STUBBORN'), { label: 'stubborn mode' });
  const pid = ctx.manager.get(session.id).pid;
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive(), { timeout: 5000, label: 'force kill' });
});

test('the manager answers terminal queries exactly once, with or without clients', async () => {
  const session = await createFake();
  // Two attached clients: neither replies, and the program still gets one answer.
  const a = terminal(session.id);
  const b = terminal(session.id);
  await Promise.all([a.opened, b.opened]);
  a.input('query cpr');
  await waitForText(a, session.id, 'REPLIES:', 'cpr replies with clients');
  assert.match(stripAnsi(a.output), /REPLIES:1:/);
  await Promise.all([a.close(), b.close()]);

  // No client at all: the manager still answers.
  const managed = ctx.manager.get(session.id);
  managed.write('query cpr\r');
  await waitFor(() => (screenText(session.id).match(/REPLIES:/g) || []).length >= 2, { label: 'cpr replies without clients' });
  assert.match(screenText(session.id), /REPLIES:1:[^\n]*\n[^]*REPLIES:1:/);
  await call('DELETE', `/sessions/${session.id}`);
});

test('background colour queries get the page theme colour', async () => {
  const session = await createFake();
  const client = terminal(session.id);
  await client.opened;
  client.input('query bg');
  await waitForText(client, session.id, 'REPLIES:', 'bg replies');
  const text = stripAnsi(client.output);
  if (process.platform === 'win32') {
    // ConPTY's console host sits between the program and the manager and may
    // handle this query itself. Whatever it does, there must be no duplicate.
    assert.match(text, /REPLIES:[01]:/);
  } else {
    assert.match(text, /REPLIES:1:/);
    assert.ok(text.includes('rgb:0f0f/1111/1515'), text.slice(-200));
  }
  await client.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('snapshots restore a hidden cursor and SGR mouse reporting', async () => {
  const session = await createFake();
  const first = terminal(session.id);
  await first.opened;
  first.input('modes');
  await waitForText(first, session.id, 'MODES-SET', 'modes set');
  await first.close();
  const second = terminal(session.id);
  await second.opened;
  const snapshot = await waitFor(() => second.messages.find((m) => m.type === 'snapshot'), { label: 'snapshot' });
  assert.ok(snapshot.data.includes('\x1b[?25l'), 'cursor stays hidden');
  if (process.platform !== 'win32') assert.ok(snapshot.data.includes('\x1b[?1006h'), 'SGR mouse encoding is restored');
  await second.close();
  await call('DELETE', `/sessions/${session.id}`);
});

test('input that arrives after removal is ignored safely', async () => {
  const session = await createFake();
  const managed = ctx.manager.get(session.id);
  await call('DELETE', `/sessions/${session.id}`);
  managed.write('echo too late\r');
  managed.resize(50, 10);
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
});

test('request validation: names, body size and report authentication', async () => {
  const session = await createFake({ name: { not: 'a string' } });
  assert.equal(session.name, 'Fake Tool', 'a non-string name falls back to the tool name');
  const long = await createFake({ name: 'x'.repeat(200) });
  assert.equal(long.name.length, 80);

  assert.equal((await call('PATCH', `/sessions/${session.id}`, { name: 42 })).status, 400);
  assert.equal((await call('PATCH', `/sessions/${session.id}`, { name: '   ' })).status, 400);

  const big = await fetch(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: 'fake', pad: 'x'.repeat(100 * 1024) }),
  });
  assert.equal(big.status, 413);

  // Without the API token, a real and a made-up session id are indistinguishable.
  const noAuth = { Authorization: '', 'X-Agent-Guild-Report-Token': 'wrong' };
  assert.equal((await call('POST', `/sessions/${session.id}/agents`, { agentId: 'a' }, noAuth)).status, 401);
  assert.equal((await call('POST', '/sessions/000000000000/agents', { agentId: 'a' }, noAuth)).status, 401);
  assert.equal((await call('POST', '/sessions/000000000000/agents', { agentId: 'a' })).status, 404);

  assert.equal((await fetch(`${base}/%00`)).status, 404);
  await call('DELETE', `/sessions/${session.id}`);
  await call('DELETE', `/sessions/${long.id}`);
});

test('several sessions run concurrently', async () => {
  const sessions = await Promise.all([createFake(), createFake(), createFake()]);
  const clients = sessions.map((s) => terminal(s.id));
  await Promise.all(clients.map((c) => c.opened));
  clients.forEach((c, i) => c.input(`echo session-${i}`));
  await Promise.all(clients.map((c, i) => waitFor(() => c.output.includes(`ECHO:session-${i}`), { label: `session ${i}` })));
  clients.forEach((c, i) => assert.ok(!c.output.includes(`ECHO:session-${(i + 1) % 3}`), 'output does not leak between sessions'));
  await Promise.all(clients.map((c) => c.close()));
  for (const s of sessions) await call('DELETE', `/sessions/${s.id}`);
});

test('a GitHub account signs in, sets up SSH and clones over it in a visible session', async () => {
  assert.equal((await fetch(`${base}/api/v1/github`)).status, 401);
  let { status, body } = await call('GET', '/github');
  assert.equal(status, 200);
  assert.deepEqual(body.github.accounts, []);
  assert.deepEqual(body.github.tools, { git: true, ssh: true, sshKeygen: true });
  assert.equal(body.github.appUrl, `${fakeGitHub.url}/settings/connections/applications/test-client`);

  const events = new Client(`${base.replace('http', 'ws')}/api/v1/events?token=${token}`);
  await events.opened;
  ({ status, body } = await call('POST', '/github/sign-in'));
  assert.equal(status, 202);
  assert.equal(body.github.signIn.status, 'pending');
  assert.equal(body.github.signIn.userCode, 'WDJB-MJHT');
  const account = await waitFor(async () => (await call('GET', '/github')).body.github.accounts[0], { label: 'GitHub sign-in', timeout: 15000 });
  assert.equal(account.id, 4242);
  assert.equal(account.login, 'octo-cat');
  assert.ok(events.messages.some((m) => m.type === 'github.updated'), 'github.updated');
  assert.ok(!JSON.stringify((await call('GET', '/github')).body).includes('access-1'), 'tokens never reach a client');

  const parent = fs.mkdtempSync(path.join(home, 'clones '));
  const repos = await call('GET', `/github/accounts/4242/repos?parent=${encodeURIComponent(parent)}`);
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.body.repos.repos.map((r) => [r.fullName, r.local]), [['octo-cat/agent-guild', 'absent'], ['acme/api', 'absent'], ['octo-cat/old-tool', 'absent']]);
  assert.equal((await call('GET', '/github/accounts/4242/repos?parent=%2Fno%2Fsuch%2Ffolder')).body.error.code, 'bad_cwd');
  assert.equal((await call('GET', '/github/accounts/1/repos')).status, 404);

  const early = await call('POST', '/github/clone', { account: 4242, repo: 'octo-cat/agent-guild', parent });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'ssh_not_ready');

  ({ status, body } = await call('POST', '/github/accounts/4242/ssh'));
  assert.equal(status, 200);
  assert.equal(body.account.ssh.status, 'ready', JSON.stringify(body.account.ssh.error));
  const data = path.join(home, 'github');
  assert.equal(body.account.ssh.key, path.join(data, 'keys', 'agent-guild-github-4242'));
  assert.equal(fakeGitHub.state.keyPosts.length, 1);

  assert.equal((await call('POST', '/github/clone', { account: 4242, repo: 'octo-cat/../x', parent })).status, 400);
  const started = await call('POST', '/github/clone', { account: 4242, repo: 'octo-cat/agent-guild', parent });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { session } = started.body;
  assert.equal(session.task, 'clone');
  assert.equal(session.name, 'Clone octo-cat/agent-guild');
  assert.deepEqual(session.clone, { repo: 'octo-cat/agent-guild', path: path.join(parent, 'agent-guild'), accountId: 4242 });
  const client = terminal(session.id);
  await client.opened;
  const exit = await waitFor(() => client.messages.find((m) => m.type === 'exit'), { label: 'clone exit' });
  assert.equal(exit.exitCode, 0, stripAnsi(client.output));
  await client.close();

  const runs = fs.readFileSync(process.env.FAKE_GIT_TOOLS_LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const git = runs.find((r) => r.tool === 'git');
  assert.equal(git.args.length, 5);
  assert.deepEqual([git.args[0], git.args[1], git.args[3], git.args[4]], ['clone', '--config', 'git@github.com:octo-cat/agent-guild.git', path.join(parent, 'agent-guild')]);
  assert.match(git.args[2], /^core\.sshCommand='[^']*ssh[^']*' '-F' .* '-o' 'IdentitiesOnly=yes' '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=yes' '-o' 'GlobalKnownHostsFile=none' '-o' 'UserKnownHostsFile="[^"]+known_hosts"'$/);
  const gitEnv = Object.fromEntries(Object.entries(git.env).map(([k, v]) => [k.toUpperCase(), v]));
  assert.equal(gitEnv.GIT_CONFIG_GLOBAL, path.join(data, 'clone.gitconfig'));
  assert.equal(gitEnv.GIT_CONFIG_SYSTEM, path.join(data, 'clone.gitconfig'));
  for (const key of ['GIT_SSH_COMMAND', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_COMMON_DIR']) assert.equal(gitEnv[key], undefined, key);

  const after = await call('GET', `/github/accounts/4242/repos?parent=${encodeURIComponent(parent)}`);
  assert.equal(after.body.repos.repos[0].local, 'cloned');
  const again = await call('POST', '/github/clone', { account: 4242, repo: 'octo-cat/agent-guild', parent });
  assert.equal(again.body.error.code, 'clone_exists');
  assert.equal(again.body.error.target, path.join(parent, 'agent-guild'));

  const created = await call('POST', '/github/accounts/4242/repos', { owner: 'octo-cat', name: 'new-thing', private: true, readme: true });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.repo.fullName, 'octo-cat/new-thing');
  assert.equal((await call('POST', '/github/accounts/4242/repos', { owner: 'octo-cat', name: 'new-thing' })).body.error.code, 'repo_exists');
  const cloneNew = await call('POST', '/github/clone', { account: 4242, repo: 'octo-cat/new-thing', parent });
  assert.equal(cloneNew.status, 201);

  await call('DELETE', `/sessions/${session.id}`);
  await waitFor(async () => (await call('GET', `/sessions/${cloneNew.body.session.id}`)).body.session.status === 'exited', { label: 'second clone exit' });
  await call('DELETE', `/sessions/${cloneNew.body.session.id}`);
  ({ body } = await call('DELETE', '/github/accounts/4242'));
  assert.deepEqual(body.github.accounts, []);
  await events.close();
});

test('the runtime file lets other clients discover the manager', () => {
  const runtime = JSON.parse(fs.readFileSync(path.join(home, 'manager.json'), 'utf8'));
  assert.equal(runtime.url, base);
  assert.equal(runtime.pid, process.pid);
  assert.equal(fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim(), token);
});

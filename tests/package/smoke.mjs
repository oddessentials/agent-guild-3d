import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const versionAt = args.indexOf('--version');
const expectedVersion = versionAt === -1 ? null : args[versionAt + 1];
const prefixArg = args.find((arg, i) => !arg.startsWith('--') && i !== versionAt + 1);
if (!prefixArg) {
  console.error('Usage: node tests/package/smoke.mjs <global prefix> [--version X.Y.Z]');
  process.exit(2);
}

const win = process.platform === 'win32';
const prefix = path.resolve(prefixArg);
const command = (name) => (win ? path.join(prefix, `${name}.cmd`) : path.join(prefix, 'bin', name));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-smoke-'));

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
const nodeDir = path.dirname(process.execPath);
const inherit = (...names) => Object.fromEntries(names.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const env = {
  ...(win
    ? {
      ...inherit('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData',
        'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'),
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      Path: [nodeDir, `${systemRoot}\\System32`, systemRoot, `${systemRoot}\\System32\\WindowsPowerShell\\v1.0`].join(';'),
    }
    : {
      ...inherit('HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG'),
      PATH: [nodeDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    }),
  AGENT_GUILD_HOME: home,
  AGENT_GUILD_PORT: String(port),
  AGENT_GUILD_NO_UPDATE_CHECK: '1',
  AGENT_GUILD_SKIP_SHELL_ENV: '1',
};

function run(name, ...commandArgs) {
  const file = win ? env.ComSpec || 'cmd.exe' : command(name);
  const argv = win ? ['/d', '/s', '/c', `"${[command(name), ...commandArgs].map((arg) => `"${arg}"`).join(' ')}"`] : commandArgs;
  return new Promise((resolve) => {
    execFile(file, argv, { env, cwd: home, timeout: 60000, windowsVerbatimArguments: win }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
    });
  });
}

const token = () => fs.readFileSync(path.join(home, 'auth-token'), 'utf8').trim();

async function api(method, route, body) {
  const res = await fetch(`${base}/api/v1${route}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const plain = (screen) => screen
  .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g'), '')
  .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
  .replace(new RegExp(`${ESC}[@-_]`, 'g'), '');

const started = Date.now();
function pass(name, detail = '') {
  console.log(`ok  ${String(Date.now() - started).padStart(6)} ms  ${name}${detail ? `  (${detail})` : ''}`);
}
function check(condition, name, detail = '') {
  if (!condition) throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  pass(name, detail);
}
const firstLine = (result) => `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] ?? '';

let failure = null;
try {
  const help = await run('agent-guild-report', '--help');
  check(help.code === 0 && /Usage: agent-guild-report/.test(help.stdout), 'agent-guild-report is installed', firstLine(help));

  const opened = await run('agent-guild', 'open', '--no-browser');
  check(opened.code === 0 && /Session manager started/.test(opened.stdout), 'open starts a manager', firstLine(opened));

  const health = await (await fetch(`${base}/api/v1/health`)).json();
  check(health.ok === true && health.name === 'agent-guild', 'the manager answers', `version ${health.version}`);
  if (expectedVersion !== null) check(health.version === expectedVersion, 'the manager is the expected version', expectedVersion);

  const assets = ['/', '/app.js', '/theme.js', '/styles.css', '/skins/guild/skin.css', '/skins/guild/page.avif', '/skins/professional/skin.css', '/skins/orbital/skin.css', '/vendor/xterm/xterm.js', '/vendor/xterm/xterm.css',
    '/vendor/xterm/addon-fit.js', '/vendor/xterm/addon-web-links.js', '/yard.css', '/yard.js', '/yard-layout.mjs', '/yard/court.webp'];
  for (const asset of assets) {
    const res = await fetch(`${base}${asset}`);
    const bytes = (await res.arrayBuffer()).byteLength;
    if (res.status !== 200 || bytes === 0) throw new Error(`page asset ${asset}: HTTP ${res.status}, ${bytes} bytes`);
  }
  pass('the page and its assets are served', `${assets.length} files`);

  const providers = await api('GET', '/providers');
  const shell = providers.body.providers?.find((provider) => provider.id === 'shell');
  check(providers.status === 200 && shell?.available === true, 'the shell provider is available', shell?.resolvedPath ?? '');

  const created = await api('POST', '/sessions', { providerId: 'shell', cwd: home });
  check(created.status === 201, 'a session starts', JSON.stringify(created.body).slice(0, 120));

  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/sessions/${created.body.session.id}/terminal?token=${token()}`);
  let screen = '';
  let snapshot = false;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot') snapshot = true;
    if (message.type === 'snapshot' || message.type === 'data') screen += message.data;
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', () => reject(new Error('the terminal socket did not open')));
  });
  const seen = async (test, what, timeoutMs = 120000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (test()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${what}: not seen within ${timeoutMs} ms; the screen ends with ${JSON.stringify(plain(screen).slice(-400))}`);
  };
  await seen(() => snapshot, 'the terminal snapshot', 15000);

  socket.send(JSON.stringify({ type: 'input', data: win ? 'Write-Output ("SMOKE_" + (40+2))\r' : 'echo SMOKE_$((40+2))\r' }));
  await seen(() => /SMOKE_42/.test(plain(screen)), 'the output of a command typed into the terminal');
  pass('a real terminal runs a command');

  socket.send(JSON.stringify({ type: 'input', data: 'agent-guild-report --help\r' }));
  await seen(() => /Usage: agent-guild-report/.test(plain(screen)), 'agent-guild-report inside the session');
  pass('agent-guild-report runs inside the session');
  socket.close();

  const status = await run('agent-guild', 'status');
  check(status.code === 0 && /1 session\(s\), 1 running/.test(status.stdout), 'status lists the session', firstLine(status));

  const stopped = await run('agent-guild', 'stop');
  check(/Session manager stopped/.test(stopped.stdout), 'stop ends the manager');
  const after = await run('agent-guild', 'status');
  check(after.code === 3, 'status reports that the manager is not running');
} catch (err) {
  failure = err;
}

if (failure) {
  console.error(`not ok  ${failure.message}`);
  try {
    console.error(`--- ${path.join(home, 'manager.log')} ---\n${fs.readFileSync(path.join(home, 'manager.log'), 'utf8').split('\n').slice(-25).join('\n')}`);
  } catch { /* no log was written */ }
  await run('agent-guild', 'stop');
  process.exitCode = 1;
}
fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

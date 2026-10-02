// A stand-in coding tool for tests. Works the same on every platform.
//   echo <text>        prints "ECHO:<text>"
//   agent <id> <name>  emits an in-band agent report (OSC 7777)
//   model <name>       emits an in-band model report (OSC 7777)
//   session <id>       emits an in-band tool session id report (OSC 7777)
//   args               prints the arguments that followed the script path
//   env                prints the Agent Guild variables, the first PATH entry, TMUX and FAKE_TOOL_HOME
//   hook <shell> <json> runs `agent-guild-report --hook` through sh, cmd or
//                      powershell, as the coding tools run their hooks, with
//                      this environment and <json> on stdin; prints
//                      HOOK-EXIT:<code> and the hook's stderr
//   size               prints the terminal size
//   query [cpr|bg]     asks the terminal for the cursor position or the
//                      background colour, then prints every reply received
//                      within 1.5 s
//   stream <ms> <text> prints <text> then a line every 250 ms for <ms>
//   modes              hides the cursor and enables SGR mouse reporting
//   stubborn           ignores hang-up signals
//   exit <code>        exits with that code
// Started with --version it prints "fake-tool 1.2.3" and exits.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const versionFile = process.env.FAKE_TOOL_VERSION_FILE;

if (process.argv.includes('update')) {
  if (process.argv.includes('--help')) {
    console.log('usage: fake-tool update');
    process.exit(0);
  }
  console.log(`FAKE-TOOL UPDATE ${process.argv.slice(2).join(' ')}`);
  if (versionFile && process.env.FAKE_TOOL_UPDATE_TO) fs.writeFileSync(versionFile, process.env.FAKE_TOOL_UPDATE_TO);
  process.exit(Number(process.env.FAKE_TOOL_UPDATE_EXIT || 0));
}

if (process.argv.includes('--version')) {
  if (process.env.FAKE_TOOL_BREAK_FILE && fs.existsSync(process.env.FAKE_TOOL_BREAK_FILE)) {
    console.error([
      'file:///C:/nodejs/v-24.20.0/nodejs-24.20.0/node_modules/fake-tool/bin/fake.js:107',
      '  throw new Error(',
      '        ^',
      '',
      'Error: Missing optional dependency fake-tool-win32-x64. Reinstall: npm install -g fake-tool-pkg@latest',
      '    at findExecutable (file:///C:/nodejs/v-24.20.0/nodejs-24.20.0/node_modules/fake-tool/bin/fake.js:107:9)',
    ].join('\n'));
    process.exit(1);
  }
  if (process.env.FAKE_TOOL_VERSION_TEXT) {
    console.log(process.env.FAKE_TOOL_VERSION_TEXT);
    process.exit(0);
  }
  let version = '1.2.3';
  try { if (versionFile) version = fs.readFileSync(versionFile, 'utf8').trim() || version; } catch { /* not updated yet */ }
  console.log(`fake-tool ${version}`);
  process.exit(0);
}

/** The hook command lines the real tools build, by shell. */
function hookSpawn(shell) {
  const command = 'agent-guild-report --hook';
  if (shell === 'cmd') return ['cmd.exe', ['/d', '/s', '/c', `"${command}"`]];
  if (shell === 'powershell') {
    // Gemini CLI and Grok Build pass no execution policy; Restricted (the
    // Windows client default) must still find and run the .cmd launcher.
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', command]];
  }
  return ['/bin/sh', ['-c', command]];
}

const out = (text) => process.stdout.write(`${text}\r\n`);
out(`FAKE-TOOL READY cwd=${process.cwd()}`);

let buffer = '';
let collecting = null;

function handle(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'echo') out(`ECHO:${rest.join(' ')}`);
  else if (cmd === 'agent') {
    const report = JSON.stringify({ agentId: rest[0], name: rest[1] || rest[0], status: rest[2] || 'working' });
    process.stdout.write(`\x1b]7777;agent-guild;${report}\x07`);
  } else if (cmd === 'model') {
    process.stdout.write(`\x1b]7777;agent-guild;${JSON.stringify({ model: rest[0], displayName: rest[1] })}\x07`);
  } else if (cmd === 'session') {
    process.stdout.write(`\x1b]7777;agent-guild;${JSON.stringify({ toolSessionId: rest[0] })}\x07`);
  } else if (cmd === 'args') out(`ARGS:${JSON.stringify(process.argv.slice(2))}`);
  else if (cmd === 'env') {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH');
    const first = (process.env[pathKey] || '').split(path.delimiter)[0];
    out(`ENV:${process.env.AGENT_GUILD_SESSION_ID}|${process.env.AGENT_GUILD_PROVIDER}|${process.env.AGENT_GUILD_URL}|${first}|tmux=${process.env.TMUX ?? ''}|term_program=${process.env.TERM_PROGRAM ?? ''}|home=${process.env.FAKE_TOOL_HOME ?? ''}`);
  } else if (cmd === 'hook') {
    const [file, args] = hookSpawn(rest[0]);
    const child = spawn(file, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: rest[0] === 'cmd',
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => out(`HOOK-EXIT:spawn-error STDERR:${JSON.stringify(err.message)}`));
    child.on('close', (code) => out(`HOOK-EXIT:${code} STDERR:${JSON.stringify(stderr.trim())}`));
    child.stdin.end(rest.slice(1).join(' '));
  } else if (cmd === 'size') {
    // getWindowSize() asks the console directly; .columns can be stale on Windows.
    const [cols, rows] = process.stdout.getWindowSize ? process.stdout.getWindowSize() : [process.stdout.columns, process.stdout.rows];
    out(`SIZE:${cols}x${rows}`);
  } else if (cmd === 'query') {
    const kind = rest[0] || 'cpr';
    const request = kind === 'bg' ? '\x1b]11;?\x07' : '\x1b[6n';
    const pattern = kind === 'bg' ? /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g : /\x1b\[\d+;\d+R/g;
    // Raw mode, as real TUIs use, so the reply arrives without a newline.
    process.stdin.setRawMode?.(true);
    collecting = '';
    process.stdout.write(request);
    setTimeout(() => {
      const replies = collecting.match(pattern) || [];
      collecting = null;
      process.stdin.setRawMode?.(false);
      out(`REPLIES:${replies.length}:${JSON.stringify(replies)}`);
    }, 1500);
  } else if (cmd === 'stream') {
    out(rest.slice(1).join(' '));
    const until = Date.now() + Number(rest[0] || 1000);
    const timer = setInterval(() => {
      if (Date.now() >= until) { clearInterval(timer); out('STREAM-DONE'); } else out('tick');
    }, 250);
  } else if (cmd === 'modes') {
    process.stdout.write('\x1b[?25l\x1b[?1000h\x1b[?1006h');
    out('MODES-SET');
  } else if (cmd === 'stubborn') {
    process.removeAllListeners('SIGHUP');
    process.on('SIGHUP', () => out('IGNORING-HUP'));
    out('STUBBORN');
  } else if (cmd === 'exit') process.exit(Number(rest[0] || 0));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (collecting !== null) {
    collecting += chunk;
    return;
  }
  buffer += chunk;
  let index;
  while ((index = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(line);
  }
});
process.on('SIGHUP', () => process.exit(129));

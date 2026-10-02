import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildSpawnSpec, runSpec, killWindowsTree } from './command-resolver.mjs';

export const REPORT_COMMAND = 'agent-guild-report --hook';
export const EXTENSION_NAME = 'agent-guild';
const MANIFEST_DESCRIPTION = 'Reports sub-agents to the Agent Guild session they run in.';
const PROBE_TIMEOUT_MS = 20000;
const PROBE_RETRY_MS = 5 * 60 * 1000;

const handler = (extra = {}) => ({ type: 'command', command: REPORT_COMMAND, ...extra });
const groups = (events, extra) => Object.fromEntries(events.map((event) => [event, [{ ...extra?.[event]?.group, hooks: [handler(extra?.[event]?.handler)] }]]));

const shellEvents = (events, matcher) => Object.fromEntries(events.map((event) => [event, { group: { matcher } }]));

const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PostModelSwitch', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
const CLAUDE_MATCHERS = { PreToolUse: 'Bash|PowerShell', PermissionRequest: 'Bash|PowerShell', PostToolUse: 'Bash|PowerShell|TaskStop', PostToolUseFailure: 'Bash|PowerShell' };
const CLAUDE_BLOCKING = new Set(['SubagentStart', 'PreToolUse']);
export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SessionEnd'];
const CODEX_MATCHERS = { PermissionRequest: 'Bash', PostToolUse: 'Bash' };

// Only the start of a sub-agent or a command holds Claude Code up, so the start reaches the manager before its end.
const claudeHooks = () => Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
  ...(CLAUDE_MATCHERS[event] ? { matcher: CLAUDE_MATCHERS[event] } : {}),
  hooks: [handler(CLAUDE_BLOCKING.has(event) ? {} : { async: true })],
}]]));
const GROK_EVENTS = ['SessionStart', 'SubagentStart', 'SubagentStop', 'StopCancelled', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'];

// Gemini's extension stays linked outside Agent Guild, where the launchers are not on PATH.
export function geminiCommand(shimDir, platform = process.platform) {
  if (!shimDir) return REPORT_COMMAND;
  if (platform === 'win32') return `& '${path.win32.join(shimDir, 'agent-guild-report.cmd').replace(/'/g, "''")}' --hook`;
  return `'${path.posix.join(shimDir, 'agent-guild-report').replace(/'/g, `'\\''`)}' --hook`;
}

export function bundleFiles(version, { shimDir = null, platform = process.platform } = {}) {
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = { name: EXTENSION_NAME, version, description: MANIFEST_DESCRIPTION };
  const gemini = (name, matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [handler({ name: `Agent Guild ${name}`, command: geminiCommand(shimDir, platform) })] });
  return {
    claude: {
      '.claude-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({ hooks: claudeHooks() }),
    },
    gemini: {
      'gemini-extension.json': json(manifest),
      'hooks/hooks.json': json({
        hooks: {
          SessionStart: [gemini('session start')],
          BeforeTool: [gemini('agent start', 'invoke_agent'), gemini('shell start', 'run_shell_command')],
          AfterTool: [gemini('agent stop', 'invoke_agent'), gemini('shell stop', 'run_shell_command')],
          BeforeAgent: [gemini('turn start')],
          AfterAgent: [gemini('turn end')],
          BeforeModel: [gemini('model')],
        },
      }),
    },
    grok: {
      '.grok-plugin/plugin.json': json(manifest),
      'hooks/hooks.json': json({
        hooks: groups(GROK_EVENTS, { SessionEnd: { handler: { timeout: 10 } }, ...shellEvents(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'], 'run_terminal_command') }),
      }),
    },
  };
}

export function writeBundles(dir, version, opts) {
  const out = {};
  for (const [name, files] of Object.entries(bundleFiles(version, opts))) {
    const root = path.join(dir, name);
    for (const [rel, contents] of Object.entries(files)) {
      const file = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, contents);
      fs.renameSync(tmp, file);
    }
    out[name] = root;
  }
  return out;
}

const tomlString = (value) => `'${value}'`;

export function codexHookArgs() {
  const value = (event) => {
    const matcher = CODEX_MATCHERS[event] ? `matcher=${tomlString(CODEX_MATCHERS[event])},` : '';
    return `[{${matcher}hooks=[{type=${tomlString('command')},command=${tomlString(REPORT_COMMAND)}}]}]`;
  };
  return CODEX_EVENTS.flatMap((event) => ['-c', `hooks.${event}=${value(event)}`]);
}

export function codexTrustArgs(hooks) {
  if (hooks.some(({ key, hash }) => /['\n]/.test(key) || /['\n]/.test(hash))) return null;
  return ['-c', `hooks.state={${hooks.map(({ key, hash }) => `${tomlString(key)}={trusted_hash=${tomlString(hash)}}`).join(',')}}`];
}

export function codexHooksFrom(result) {
  const hooks = (result?.data || []).flatMap((entry) => entry.hooks || [])
    .filter((h) => h.source === 'sessionFlags' && h.command === REPORT_COMMAND && h.enabled !== false);
  const found = CODEX_EVENTS.map((event) => {
    const name = event.charAt(0).toLowerCase() + event.slice(1);
    return hooks.find((h) => h.eventName === name);
  });
  if (found.some((h) => !h || typeof h.key !== 'string' || typeof h.currentHash !== 'string')) return null;
  return found.map((h) => ({ key: h.key, hash: h.currentHash, trusted: h.trustStatus === 'trusted' }));
}

export function codexHooksList(resolved, args, { env, platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS, tmpDir = os.tmpdir() } = {}) {
  const home = fs.mkdtempSync(path.join(tmpDir, 'agent-guild-codex-'));
  const spec = buildSpawnSpec(resolved, [...args, 'app-server'], env, platform);
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      endTree(child, platform);
      setTimeout(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {}), 500).unref();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex did not answer in time')), timeoutMs);
    timer.unref?.();
    try {
      const verbatim = typeof spec.args === 'string';
      child = spawn(spec.file, verbatim ? [spec.args] : spec.args, {
        cwd: home, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: verbatim,
      });
    } catch (err) {
      return finish(err);
    }
    let stderr = '';
    let buffer = '';
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on('error', (err) => finish(err));
    child.on('exit', (code) => finish(new Error(`Codex exited with code ${code}: ${stderr.trim().split('\n').find((l) => /error|caused/i.test(l)) || ''}`.trim())));
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          if (msg.error) return finish(new Error(msg.error.message || 'initialize failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [home] } });
        } else if (msg.id === 2) {
          if (msg.error) return finish(new Error(msg.error.message || 'hooks/list failed'));
          return finish(null, msg.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-guild', title: null, version: '1' } } });
  });
}

function endTree(child, platform) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch { /* closed */ }
  if (platform === 'win32' && child.pid) return killWindowsTree(child.pid);
  try { child.kill(); } catch { /* gone */ }
}

export async function probeCodex(resolved, opts) {
  const hookArgs = codexHookArgs();
  const listed = codexHooksFrom(await codexHooksList(resolved, hookArgs, opts));
  if (!listed) return { args: [], trusted: false, error: 'Codex did not load the hooks' };
  if (listed.every((h) => h.trusted)) return { args: hookArgs, trusted: true };
  const trustArgs = codexTrustArgs(listed);
  if (trustArgs) {
    try {
      const again = codexHooksFrom(await codexHooksList(resolved, [...hookArgs, ...trustArgs], opts));
      if (again?.every((h) => h.trusted)) return { args: [...hookArgs, ...trustArgs], trusted: true };
    } catch { /* fall back to untrusted hooks, which Codex asks the user about */ }
  }
  return { args: hookArgs, trusted: false };
}

export function helpLists(text, flag) {
  return new RegExp(`^\\s+(?:-\\w, )?${flag.replace(/[-]/g, '\\-')}\\b`, 'm').test(text);
}

export function geminiHome(env = {}) {
  return env.GEMINI_CLI_HOME || os.homedir();
}

function geminiRecord(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'extensions', EXTENSION_NAME, '.gemini-extension-install.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function geminiLinked(home, bundle) {
  const record = geminiRecord(home);
  return record?.type === 'link' && typeof record.source === 'string' && path.resolve(record.source) === path.resolve(bundle);
}

export function geminiStaleLink(home, bundle) {
  const record = geminiRecord(home);
  if (!record || geminiLinked(home, bundle)) return false;
  if (record.type !== 'link' || typeof record.source !== 'string') return false;
  try {
    return JSON.parse(fs.readFileSync(path.join(record.source, 'gemini-extension.json'), 'utf8')).description === MANIFEST_DESCRIPTION;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

// Gemini's uninstall finds only extensions that load, so a link to a folder without its manifest is removed here, as uninstall would.
function removeDanglingLink(home) {
  const extensions = path.join(home, '.gemini', 'extensions');
  fs.rmSync(path.join(extensions, EXTENSION_NAME), { recursive: true, force: true });
  const enablement = path.join(extensions, 'extension-enablement.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(enablement, 'utf8')); } catch { return; }
  if (!config || typeof config !== 'object' || !(EXTENSION_NAME in config)) return;
  delete config[EXTENSION_NAME];
  fs.writeFileSync(enablement, JSON.stringify(config, null, 2));
}

const pending = (tool, when) => ({ state: 'pending', reason: `Agent Guild added its reporting hooks to this ${tool} session. They report once ${tool} ${when}.` });

export class SessionHooks {
  constructor({ registry, dir, version, shimDir = null, probeTimeoutMs = PROBE_TIMEOUT_MS, probeRetryMs = PROBE_RETRY_MS }) {
    this.registry = registry;
    this.probeTimeoutMs = probeTimeoutMs;
    this.probeRetryMs = probeRetryMs;
    this.dir = dir;
    this.bundles = null;
    this.probes = new Map();
    if (dir) {
      try {
        this.bundles = writeBundles(dir, version, { shimDir, platform: registry.platform });
      } catch (err) {
        console.warn(`[reporting] could not write the reporting hooks to ${dir}: ${err.message}`);
      }
    }
  }

  warm() {
    for (const provider of this.registry.providers) {
      if (provider.reporting === 'claude' || provider.reporting === 'codex' || provider.reporting === 'grok') this._probe(provider).catch(() => {});
    }
  }

  _probe(provider) {
    const resolved = this.registry.resolve(provider);
    if (!resolved) return Promise.resolve(null);
    let mtime = null;
    try { mtime = fs.statSync(resolved).mtimeMs; } catch { /* probe anyway */ }
    const cached = this.probes.get(provider.id);
    const fresh = cached && cached.resolved === resolved && cached.mtime === mtime && (cached.ok || Date.now() - cached.at < this.probeRetryMs);
    if (fresh) return cached.promise;
    const env = { ...this.registry.env, ...provider.env };
    const platform = this.registry.platform;
    const entry = { resolved, mtime, at: Date.now(), ok: false };
    entry.promise = (async () => {
      if (provider.reporting === 'codex') {
        const result = await probeCodex(resolved, { env, platform, timeoutMs: this.probeTimeoutMs });
        entry.ok = result.args.length > 0;
        return result;
      }
      const { stdout, stderr } = await runSpec(buildSpawnSpec(resolved, ['--help'], env, platform), { env, timeoutMs: this.probeTimeoutMs });
      entry.ok = true;
      return { pluginDir: helpLists(`${stdout}\n${stderr}`, '--plugin-dir') };
    })().catch((err) => ({ error: err.message }));
    this.probes.set(provider.id, entry);
    return entry.promise;
  }

  async launch(provider, account) {
    const mode = provider.reporting;
    if (!mode) return { args: [], reporting: null };
    const tool = provider.tool;
    if (!this.bundles) {
      return { args: [], reporting: { state: 'unavailable', reason: `Agent Guild could not write its reporting hooks, so ${tool} cannot report agents.` } };
    }
    if (mode === 'gemini') {
      if (this.enabled(provider, account)) return { args: [], reporting: pending(tool, 'starts its session') };
      return { args: [], reporting: { state: 'setup_required', reason: `Agent reporting is off for ${tool}. Turn it on from the ${tool} card; it applies to new sessions.` } };
    }
    const probe = await this._probe(provider);
    if (mode === 'codex') {
      if (probe?.args?.length) return { args: probe.args, reporting: pending(tool, 'runs its first prompt') };
      return { args: [], reporting: { state: 'unavailable', reason: `${tool} did not accept Agent Guild's reporting hooks${probe?.error ? ` (${probe.error})` : ''}.` } };
    }
    const dir = mode === 'claude' ? this.bundles.claude : this.bundles.grok;
    if (probe?.pluginDir) return { args: ['--plugin-dir', dir], reporting: pending(tool, 'starts its session') };
    if (probe?.error) {
      return { args: [], reporting: { state: 'unavailable', reason: `Could not check whether ${tool} can load Agent Guild's reporting hooks (${probe.error}).` } };
    }
    return {
      args: [],
      reporting: {
        state: 'unsupported',
        reason: `This version of ${tool} cannot load hooks for a single session, so Agent Guild cannot add its reporting hooks. Hooks you add to ${tool}'s own settings still report agents.`,
      },
    };
  }

  enabled(provider, account) {
    if (provider.reporting !== 'gemini' || !this.bundles) return null;
    return geminiLinked(geminiHome({ ...this.registry.env, ...provider.env, ...account?.env }), this.bundles.gemini);
  }

  async setEnabled(provider, account, enabled) {
    if (provider.reporting !== 'gemini') throw Object.assign(new Error(`${provider.tool} needs no setup for agent reporting`), { status: 400, code: 'not_applicable' });
    if (!this.bundles) throw Object.assign(new Error('Agent Guild could not write its reporting hooks'), { status: 500, code: 'reporting_unavailable' });
    const resolved = this.registry.resolve(provider);
    if (!resolved) throw Object.assign(new Error(`${provider.tool} is not installed`), { status: 409, code: 'provider_unavailable' });
    const env = { ...this.registry.env, ...provider.env, ...account?.env };
    const home = geminiHome(env);
    const stale = geminiStaleLink(home, this.bundles.gemini);
    if (enabled === this.enabled(provider, account) && !stale) return enabled;
    if (enabled && !stale && geminiRecord(home)) {
      throw Object.assign(new Error(`${provider.tool} already has another extension named "${EXTENSION_NAME}". Remove it with "${provider.command} extensions uninstall ${EXTENSION_NAME}" to turn on agent reporting.`), { status: 409, code: 'extension_conflict' });
    }
    const run = async (args, what) => {
      try {
        const commandEnv = { ...env, GEMINI_CLI_TRUST_WORKSPACE: 'true' };
        await runSpec(buildSpawnSpec(resolved, args, commandEnv, this.registry.platform), { env: commandEnv, timeoutMs: 60000, cwd: this.dir });
      } catch (err) {
        const detail = `${err.stderr || ''}\n${err.stdout || ''}`.trim().split('\n').filter(Boolean).pop() || err.message;
        throw Object.assign(new Error(`${provider.tool} could not ${what} the Agent Guild extension: ${detail}`), { status: 502, code: 'reporting_setup_failed' });
      }
    };
    const record = geminiRecord(home);
    if (stale && !fs.existsSync(path.join(record.source, 'gemini-extension.json'))) {
      removeDanglingLink(home);
    } else if (stale || !enabled) {
      await run(['extensions', 'uninstall', EXTENSION_NAME], 'remove');
    }
    if (enabled) await run(['extensions', 'link', this.bundles.gemini, '--consent'], 'link');
    const now = this.enabled(provider, account);
    if (now !== enabled) {
      throw Object.assign(new Error(`${provider.tool} reported success, but the Agent Guild extension is ${now ? 'still linked' : 'not linked'}`), { status: 502, code: 'reporting_setup_failed' });
    }
    return now;
  }
}

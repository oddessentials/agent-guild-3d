// Owns every Session. The HTTP/WebSocket layer and any future front end talk
// to this object; nothing here knows about browsers.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Session, newId, clampDimension, cleanName } from './session.mjs';
import { prependPath } from './report-shims.mjs';
import { CHANNEL_LABELS } from './install-channels.mjs';
import { SELF_PROVIDER } from './self-update.mjs';
import { GITHUB_PROVIDER, dropsFromCloneEnv, parseRepo } from './github.mjs';

export const MAX_SESSIONS = 32;

// The hooks.json earlier versions copied into Codex CLI accounts; an untouched copy would run every hook twice.
const SEEDED_CODEX_HOOKS = '59d1cfb54cda5fd81add1edee7cf0cac56e4b2afec4c26ff207b675eeaaf70ce';

function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * Layer environment objects. On Windows, variable names are
 * case-insensitive, so a later "PATH" must replace an inherited "Path"
 * rather than sit beside it.
 */
export function mergeEnv(layers, platform = process.platform) {
  const out = {};
  const keyFor = new Map();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer || {})) {
      if (value === undefined || value === null) continue;
      if (platform === 'win32') {
        const existing = keyFor.get(key.toUpperCase());
        if (existing !== undefined && existing !== key) delete out[existing];
        keyFor.set(key.toUpperCase(), key);
      }
      out[key] = String(value);
    }
  }
  return out;
}

export class SessionManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {object} opts.baseEnv   environment the tools inherit
   * @param {() => string} opts.getApiUrl  base URL handed to tools for reporting
   * @param {object} [opts.sessionDefaults] passed through to Session
   * @param {string|null} [opts.shimDir]  folder with the agent-guild-report launchers, put first on PATH
   * @param {import('./self-update.mjs').SelfUpdate|null} [opts.selfUpdate]  the manager's own upgrade
   * @param {import('./github.mjs').GitHub|null} [opts.github]
   */
  constructor({ registry, baseEnv, getApiUrl, sessionDefaults = {}, shimDir = null, selfUpdate = null, github = null, sessionHooks = null, reportTokenDir = null }) {
    super();
    this.registry = registry;
    this.baseEnv = baseEnv;
    this.getApiUrl = getApiUrl;
    this.sessionDefaults = sessionDefaults;
    this.shimDir = shimDir;
    this.selfUpdate = selfUpdate;
    this.github = github;
    this.sessionHooks = sessionHooks;
    this.reportTokenDir = reportTokenDir;
    this.sessions = new Map();
    /** Removed sessions whose process has not exited yet. */
    this.exiting = new Set();
    /** True once shutdown has begun; no new session may start after that. */
    this.closing = false;
    this.installing = new Set();
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toJSON());
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw httpError(404, `no session with id "${id}"`, 'not_found');
    return session;
  }

  resolveCwd(cwd) {
    if (cwd === undefined || cwd === null || String(cwd).trim() === '') return os.homedir();
    let dir = String(cwd).trim();
    if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(1));
    dir = path.resolve(dir);
    let stat;
    try { stat = fs.statSync(dir); } catch { throw httpError(400, `working directory does not exist: ${dir}`, 'bad_cwd'); }
    if (!stat.isDirectory()) throw httpError(400, `working directory is not a folder: ${dir}`, 'bad_cwd');
    return dir;
  }

  async create({ providerId, cwd, cols, rows, name, args, resume, account } = {}) {
    const provider = this.registry.get(String(providerId || ''));
    if (!provider) throw httpError(404, `unknown provider "${providerId}"`, 'unknown_provider');
    if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
      throw httpError(400, 'args must be an array of strings', 'bad_args');
    }
    if (account !== undefined && account !== null && typeof account !== 'string') throw httpError(400, 'account must be a string', 'bad_account');
    const resumeId = cleanResumeId(resume);
    const workDir = this.resolveCwd(cwd);
    const signIn = this.registry.account(provider, account);
    const hooks = this.sessionHooks ? await this.sessionHooks.launch(provider, signIn) : { args: [], reporting: null };
    const spawnSpec = this.registry.spawnSpec(provider, args || [], resumeId, hooks.args);
    this.prepareAccount(provider, signIn, { hooksSupplied: hooks.args.length > 0 });
    const sessionName = cleanName(name) || (provider.accounts.length > 1 ? `${provider.tool} · ${signIn.label}` : null);
    const session = this._spawn({ provider, spawnSpec, cwd: workDir, cols, rows, name: sessionName, resume: resumeId, account: signIn, reporting: hooks.reporting });
    const model = modelFromArgs([...provider.args, ...(args || [])]);
    if (model) session.setModel({ name: model }, 'args');
    return session;
  }

  prepareAccount(provider, account, { hooksSupplied = false } = {}) {
    if (!account.dir) return;
    try {
      fs.mkdirSync(account.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw httpError(500, `could not prepare the ${account.label} account folder ${account.dir}: ${err.message}`, 'account_unavailable');
    }
    if (provider.reporting !== 'codex' || !hooksSupplied || !provider.hooks) return;
    const target = path.join(account.dir, ...provider.hooks.path.split('/'));
    try {
      if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === SEEDED_CODEX_HOOKS) fs.unlinkSync(target);
    } catch { /* absent or unreadable: nothing of ours to remove */ }
  }

  /**
   * Refuses while sessions of that provider are running unless `force` is
   * set, because replacing a tool under a running process can break it.
   */
  async install(providerId, { force = false } = {}) {
    const provider = this.registry.get(String(providerId || ''));
    if (!provider) throw httpError(404, `unknown provider "${providerId}"`, 'unknown_provider');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    const guard = () => {
      const running = this.runningFor(provider.id);
      if (running > 0 && !force) {
        const err = httpError(409, `${running} ${provider.tool} session(s) are running; updating the tool now may break them`, 'provider_in_use');
        err.running = running;
        throw err;
      }
    };
    guard();
    if (this.installing.has(provider.id) || this.installsRunningFor(provider.id) > 0) {
      throw httpError(409, `${provider.tool} is already being installed or updated`, 'install_in_progress');
    }
    this.installing.add(provider.id);
    try {
      if (this.registry.resolve(provider)) {
        const { spec, channel } = await this.registry.updateSpec(provider);
        guard();
        const name = `Update ${provider.tool} (${CHANNEL_LABELS[channel]})`;
        return this._spawn({ provider, spawnSpec: spec, cwd: os.homedir(), name, task: 'install', installKind: 'update' });
      }
      const spawnSpec = await this.registry.installSpec(provider);
      guard();
      return this._spawn({ provider, spawnSpec, cwd: os.homedir(), name: `Install ${provider.tool}`, task: 'install', installKind: 'install' });
    } finally {
      this.installing.delete(provider.id);
    }
  }

  installsRunningFor(providerId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'running' && s.task === 'install' && s.provider.id === providerId) n++;
    return n;
  }

  /**
   * Upgrade the manager itself: a visible session running npm. Sessions
   * keep running; the new version is used once the manager is restarted.
   */
  async upgrade() {
    if (!this.selfUpdate) throw httpError(400, 'this manager cannot upgrade itself', 'not_updatable');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    const inProgress = () => httpError(409, 'Agent Guild is already being upgraded', 'upgrade_in_progress');
    if (this.selfUpdate.installing) throw inProgress();
    const { spec, version } = await this.selfUpdate.spec();
    if (this.selfUpdate.installing) throw inProgress();
    const session = this._spawn({
      provider: SELF_PROVIDER, description: SELF_PROVIDER, spawnSpec: spec,
      cwd: os.homedir(), name: `Upgrade Agent Guild to ${version}`, task: 'upgrade',
    });
    // The lock is held until the npm process has exited, not until the
    // session is removed: a removed session's process may still be writing
    // the package, and two installers must not touch it at once.
    this.selfUpdate.beginInstall();
    session.exited.then(() => this.selfUpdate.finishInstall({ exitCode: session.exitCode, version }));
    return session;
  }

  /** Clone a GitHub repository into a folder under `parent`, in a visible session. */
  clone({ account, repo, parent } = {}) {
    if (!this.github) throw httpError(400, 'this manager has no GitHub integration', 'github_unavailable');
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    if (parent === undefined || parent === null || String(parent).trim() === '') throw httpError(400, 'parent must name the folder to clone into', 'bad_cwd');
    const dir = this.resolveCwd(parent);
    const target = path.join(dir, parseRepo(repo).name);
    for (const s of this.sessions.values()) {
      if (s.status === 'running' && s.task === 'clone' && s.clone?.path === target) {
        throw httpError(409, `${s.clone.repo} is already being cloned into ${target}`, 'clone_in_progress');
      }
    }
    const spec = this.github.cloneSpec({ accountId: account, repo, parent: dir });
    return this._spawn({
      provider: GITHUB_PROVIDER, description: GITHUB_PROVIDER, spawnSpec: spec.spawnSpec, cwd: dir,
      name: `Clone ${spec.fullName}`, task: 'clone', extraEnv: spec.env, dropEnv: dropsFromCloneEnv,
      clone: { repo: spec.fullName, path: spec.target, accountId: spec.account.id },
    });
  }

  runningFor(providerId) {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'running' && s.task === null && s.provider.id === providerId) n++;
    return n;
  }

  /** Sessions whose process is still running, install sessions included. */
  runningCount() {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'running') n++;
    return n;
  }

  _spawn({
    provider, description = this.registry.describe(provider), spawnSpec, cwd, cols, rows, name, resume = null, task = null, installKind = null, account = null,
    extraEnv = null, dropEnv = null, clone = null, reporting = null,
  }) {
    if (this.closing) throw httpError(503, 'the session manager is stopping', 'manager_stopping');
    if (this.sessions.size >= MAX_SESSIONS) {
      throw httpError(429, `session limit reached (${MAX_SESSIONS}); remove finished sessions first`, 'too_many_sessions');
    }
    const id = newId();
    const reportToken = crypto.randomBytes(16).toString('hex');
    const reportFile = this._writeReportToken(id, reportToken);

    // The tool's hooks run `agent-guild-report` by name, so the launchers
    // go first on PATH, after any provider PATH override.
    let env = prependPath(mergeEnv([this.baseEnv, provider.env, account?.env, {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      AGENT_GUILD_SESSION_ID: id,
      AGENT_GUILD_PROVIDER: provider.id,
      AGENT_GUILD_URL: this.getApiUrl(),
      AGENT_GUILD_REPORT_TOKEN: reportToken,
      AGENT_GUILD_REPORT_FILE: reportFile,
      AGENT_GUILD_NODE: process.execPath,
    }]), this.shimDir);
    // The tool runs in its own terminal, not in the terminal or multiplexer
    // the manager was started from: Claude Code would otherwise open
    // agent-team panes in that tmux window, outside the page, and tools
    // would tune their output to a terminal program that is not there.
    for (const key of ['TMUX', 'TMUX_PANE', 'STY', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID']) delete env[key];
    if (dropEnv) for (const key of Object.keys(env)) if (dropEnv(key)) delete env[key];
    if (extraEnv) env = mergeEnv([env, extraEnv]);

    let session;
    try {
      session = new Session({
        ...this.sessionDefaults,
        id,
        provider: description,
        spawnSpec,
        cwd,
        env,
        cols: clampDimension(cols, 120, 2, 1000),
        rows: clampDimension(rows, 32, 1, 500),
        name,
        reportToken,
        resume,
        task,
        account: account ? { id: account.id, label: account.label } : null,
        clone,
        reporting,
      });
    } catch (err) {
      this._removeReportToken(reportFile);
      throw httpError(500, `could not start ${provider.tool}: ${err.message}`, 'spawn_failed');
    }
    session.exited.then(() => this._removeReportToken(reportFile));

    session.on('changed', () => {
      if (this.sessions.has(id)) this.emit('event', { type: 'session.updated', session: session.toJSON() });
    });
    session.on('warning', (msg) => console.warn(`[session ${id}] ${msg}`));
    if (task === 'install') {
      session.on('exit', () => {
        this.registry.finishInstall(provider.id, { exitCode: session.exitCode, kind: installKind }).catch(() => {});
      });
    }
    this.sessions.set(id, session);
    this.emit('event', { type: 'session.created', session: session.toJSON() });
    return session;
  }

  stop(id) {
    const session = this.get(id);
    session.kill();
    return session;
  }

  // Only once this manager owns the port, so a second one that fails to start leaves the running one's files.
  sweepReportTokens() {
    if (!this.reportTokenDir) return;
    const live = new Set(this.sessions.keys());
    let names = [];
    try { names = fs.readdirSync(this.reportTokenDir); } catch { return; }
    for (const name of names) if (!live.has(name)) fs.rm(path.join(this.reportTokenDir, name), { force: true }, () => {});
  }

  _writeReportToken(id, token) {
    if (!this.reportTokenDir) return null;
    try {
      fs.mkdirSync(this.reportTokenDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.reportTokenDir, id);
      fs.writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
      return file;
    } catch (err) {
      console.warn(`[manager] could not write the report token file for session ${id}: ${err.message}`);
      return null;
    }
  }

  _removeReportToken(file) {
    if (file) fs.rm(file, { force: true }, () => {});
  }

  /** Remove a session from the list, ending its process if still running. */
  remove(id) {
    const session = this.get(id);
    this.sessions.delete(id);
    session._broadcast({ type: 'removed' });
    if (session.status === 'running') {
      this.exiting.add(session);
      session.exited.then(() => this.exiting.delete(session));
    }
    session.dispose();
    this.emit('event', { type: 'session.removed', sessionId: id });
  }

  /** Accepts either the session's own report token or the API token. */
  reportAgent(id, report, auth) {
    return this._reportingSession(id, auth).reportAgent(report, 'api');
  }

  reportModel(id, report, auth) {
    return this._reportingSession(id, auth).reportModel(report);
  }

  reportToolSession(id, report, auth) {
    return this._reportingSession(id, auth).reportToolSession(report);
  }

  reportHello(id, auth) {
    return this._reportingSession(id, auth).reportHello();
  }

  reportShell(id, report, auth) {
    return this._reportingSession(id, auth).reportShell(report);
  }

  _reportingSession(id, { reportToken, trusted = false } = {}) {
    const session = this.sessions.get(id);
    // Without the API token, an unknown session and a wrong token look the
    // same, so the endpoint does not reveal which session ids exist.
    if (!trusted && !(session && timingSafeEqualString(reportToken, session.reportToken))) {
      throw httpError(401, 'invalid report token', 'unauthorized');
    }
    if (!session) throw httpError(404, `no session with id "${id}"`, 'not_found');
    return session;
  }

  /**
   * End every session and wait, up to `timeoutMs`, for the processes to
   * exit. Waiting matters on Windows, where ending a ConPTY process is slow.
   * Resolves to `{ remaining }`: how many processes had not confirmed their
   * exit when the wait ended, so a caller can tell a timeout from a clean
   * teardown.
   */
  async shutdown({ graceMs = 1500, timeoutMs = 5000 } = {}) {
    this.closing = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    const pending = new Set([...sessions.filter((s) => s.status === 'running'), ...this.exiting]);
    for (const session of pending) session.exited.then(() => pending.delete(session));
    for (const session of sessions) session.dispose({ graceMs });
    if (pending.size === 0) return { remaining: 0 };
    let timer;
    await Promise.race([
      Promise.all([...pending].map((s) => s.exited)),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    clearTimeout(timer);
    return { remaining: pending.size };
  }
}

/** The model named by a --model, --model=, or -m argument, or null. */
export function modelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--model' || args[i] === '-m') && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--model=') && args[i].length > 8) return args[i].slice(8);
  }
  return null;
}

const MAX_RESUME_ID = 200;

/** A session id or name to resume: one printable line, or null when absent. */
export function cleanResumeId(resume) {
  if (resume === undefined || resume === null) return null;
  const id = String(resume).trim();
  if (!id || id.length > MAX_RESUME_ID || /\p{Cc}/u.test(id)) {
    throw httpError(400, `resume must be a printable id of at most ${MAX_RESUME_ID} characters`, 'bad_resume');
  }
  return id;
}

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

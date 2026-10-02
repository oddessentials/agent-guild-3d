// One terminal session: a node-pty process, a headless terminal that mirrors
// its screen (so a reconnecting client gets the current screen, not a raw
// byte replay), and the sub-agents and model the coding tool has reported.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { killWindowsTree } from './command-resolver.mjs';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

export const OSC_AGENT_CODE = 7777;
export const OSC_AGENT_PREFIX = 'agent-guild;';
const AGENT_STATUSES = new Set(['working', 'waiting', 'idle', 'done']);
const MODEL_SOURCE_RANK = { args: 0, screen: 1, report: 2 };
const SCREEN_SCAN_DELAY_MS = 400;
const SCREEN_SCAN_MAX_DELAY_MS = 2000;
const MAX_TOOL_SESSION_ID = 200;
const REPORTING_STATES = new Set(['pending', 'active', 'unavailable', 'setup_required', 'unsupported']);
const SHELL_EVENTS = new Set(['start', 'waiting', 'asked', 'background', 'end', 'running', 'reset']);
const MAX_SHELLS = 256;
const MAX_SHELL_PIDS = 16;
const MAX_ENDED_TASKS = 256;

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Colours reported to programs that query them (OSC 10/11/12), matching the
 * web page's terminal theme. Tools use these to choose light or dark output.
 */
export const REPORTED_COLORS = { 10: '#e6e9ef', 11: '#0f1115', 12: '#e6e9ef' };

function oscColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

/** Clean a user-supplied session name: a trimmed string of at most 80 chars. */
export function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}
const MAX_AGENTS = 64;

export function clampDimension(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export class Session extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {object} opts.provider   provider description (id, vendor, tool, color, ...)
   * @param {{file: string, args: string[]|string}} opts.spawnSpec
   * @param {string} opts.cwd
   * @param {object} opts.env
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @param {string} [opts.name]
   * @param {string|null} [opts.resume]  id of the tool's own session being resumed
   * @param {string|null} [opts.task]    "install" for a package install, "upgrade" for the manager's own, "clone" for a GitHub clone, else null
   * @param {{id: string, label: string}|null} [opts.account]  the tool sign-in the session runs under
   * @param {{repo: string, path: string, accountId: number}|null} [opts.clone]  what a clone session clones, and where
   * @param {string} opts.reportToken
   * @param {number} [opts.scrollback]
   * @param {number} [opts.activityIdleMs]
   * @param {number} [opts.doneAgentLingerMs]
   * @param {number} [opts.killGraceMs]  time between hang-up and force kill
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.provider = opts.provider;
    this.name = cleanName(opts.name) || opts.provider.tool;
    this.resume = opts.resume ?? null;
    this.task = opts.task ?? null;
    this.account = opts.account ?? null;
    this.clone = opts.clone ?? null;
    this.cwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.reportToken = opts.reportToken;
    this.scrollback = opts.scrollback ?? 5000;
    this.activityIdleMs = opts.activityIdleMs ?? 2500;
    this.doneAgentLingerMs = opts.doneAgentLingerMs ?? 15000;
    this.killGraceMs = opts.killGraceMs ?? 4000;
    this.reportingTimeoutMs = opts.reportingTimeoutMs ?? 30000;
    this.reporting = REPORTING_STATES.has(opts.reporting?.state) ? { state: opts.reporting.state, reason: opts.reporting.reason ?? null } : null;
    this._reportingTimer = null;
    this.shellDisplayDelayMs = opts.shellDisplayDelayMs ?? 600;
    this.shellPidCheckMs = opts.shellPidCheckMs ?? 2000;
    this.shells = new Map();
    this._shellSeq = 0;
    this._endedTasks = new Set();
    this._pidTimer = null;
    this.createdAt = new Date().toISOString();
    this.exitedAt = null;
    this.status = 'running';
    this.exitCode = null;
    this.signal = null;
    this.activity = 'quiet';
    this.lastOutputAt = null;
    this.agents = new Map();
    this.model = null;
    this.toolSessionId = null;
    this.modelRegex = null;
    if (opts.provider.modelPattern && this.task === null) {
      try {
        this.modelRegex = new RegExp(opts.provider.modelPattern, 'gi');
      } catch (err) {
        queueMicrotask(() => this.emit('warning', `ignoring modelPattern: ${err.message}`));
      }
    }
    this.subscribers = new Set();
    this._activityTimer = null;
    this._agentTimers = new Map();
    this._killTimer = null;
    this._scanTimer = null;
    this._scanDeadline = null;
    /** Resolves when the process has exited, even after dispose(). */
    this.exited = new Promise((resolve) => { this._resolveExited = resolve; });

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.parser.registerOscHandler(OSC_AGENT_CODE, (payload) => {
      this._handleOscReport(payload);
      return true;
    });
    // The mirror is the terminal of record: it answers the program's queries
    // (cursor position, device attributes, modes, colours) exactly once,
    // whether zero or several clients are attached. Clients must not answer.
    this.term.onData((reply) => this._reply(reply));
    for (const code of Object.keys(REPORTED_COLORS)) {
      this.term.parser.registerOscHandler(Number(code), (payload) => {
        if (payload !== '?') return false;
        this._reply(`\x1b]${code};${oscColor(REPORTED_COLORS[code])}\x1b\\`);
        return true;
      });
    }

    this.disposed = false;
    try {
      this.pty = pty.spawn(opts.spawnSpec.file, opts.spawnSpec.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: this.cwd,
        env: opts.env,
        useConpty: true,
      });
    } catch (err) {
      this.term.dispose();
      throw err;
    }
    this.pty.onData((data) => this._onData(data));
    this.pty.onExit(({ exitCode, signal }) => this._onExit(exitCode, signal));
  }

  /**
   * Read live: on Windows node-pty connects the console asynchronously and
   * reports pid 0 until then. The first output announces the session again.
   */
  get pid() {
    return this.status === 'running' && !this.disposed ? this.pty.pid || null : null;
  }

  // ---- terminal I/O ------------------------------------------------------

  _onData(data) {
    if (this.disposed) return;
    this.term.write(data);
    this._broadcast({ type: 'data', data });
    this.lastOutputAt = Date.now();
    if (this.modelRegex && this.model?.source !== 'report') this._scheduleModelScan();
    if (this.activity !== 'active') {
      this.activity = 'active';
      this._changed();
    }
    clearTimeout(this._activityTimer);
    this._activityTimer = setTimeout(() => {
      this.activity = 'quiet';
      this._changed();
    }, this.activityIdleMs);
    this._activityTimer.unref?.();
  }

  _onExit(exitCode, signal) {
    clearTimeout(this._killTimer);
    this._resolveExited();
    if (this.disposed) return;
    this.exitedAt ??= new Date().toISOString();
    this.status = 'exited';
    this.exitCode = exitCode ?? null;
    this.signal = signal || null;
    this.activity = 'quiet';
    clearTimeout(this._activityTimer);
    clearTimeout(this._killTimer);
    clearTimeout(this._scanTimer);
    clearTimeout(this._reportingTimer);
    this._clearAgents();
    this._clearShells();
    // Let the headless terminal finish parsing before announcing the exit so
    // any client attaching afterwards still sees the final screen.
    this.term.write('', () => {
      this._broadcast({ type: 'exit', exitCode: this.exitCode, signal: this.signal });
      this._changed();
      this.emit('exit', this);
    });
  }

  _broadcast(message) {
    for (const sub of this.subscribers) {
      if (sub.pending) sub.pending.push(message);
      else sub.send(message);
    }
  }

  /**
   * Attach a client. `send` receives protocol messages. The first message is
   * always a `snapshot` of the current screen; output produced while the
   * snapshot is being built is queued and delivered right after it.
   * Returns a detach function.
   */
  attach(send) {
    const sub = { send, pending: [] };
    this.subscribers.add(sub);
    // Everything written to the mirror before this marker is in the snapshot;
    // everything after it is queued in sub.pending.
    this.term.write('', () => {
      if (!this.subscribers.has(sub)) return;
      send({
        type: 'snapshot',
        data: this._serializeScreen(),
        cols: this.term.cols,
        rows: this.term.rows,
        session: this.toJSON(),
      });
      const queued = sub.pending;
      sub.pending = null;
      for (const message of queued) send(message);
      if (this.status === 'exited' && !queued.some((m) => m.type === 'exit')) {
        send({ type: 'exit', exitCode: this.exitCode, signal: this.signal });
      }
    });
    this._changed();
    return () => {
      if (this.subscribers.delete(sub)) this._changed();
    };
  }

  /**
   * The current screen as a VT stream. The serialize addon restores the
   * buffers and most modes; cursor visibility and the mouse encoding are
   * added here because it omits them.
   */
  _serializeScreen() {
    let data = this.serializer.serialize({ scrollback: this.scrollback });
    const core = this.term._core;
    if (core?.coreService?.isCursorHidden) data += '\x1b[?25l';
    const encoding = core?.coreMouseService?.activeEncoding;
    if (encoding === 'SGR') data += '\x1b[?1006h';
    else if (encoding === 'SGR_PIXELS') data += '\x1b[?1016h';
    return data;
  }

  write(data) {
    if (this.disposed || this.status !== 'running' || typeof data !== 'string' || data.length === 0) return;
    try { this.pty.write(data); } catch { /* process is exiting */ }
  }

  input(data) {
    this.write(data);
    if (this.reporting?.state === 'pending' && !this._reportingTimer && typeof data === 'string' && /[\r\n]/.test(data)) {
      this._reportingTimer = setTimeout(() => {
        if (this.reporting?.state !== 'pending' || this.status !== 'running') return;
        this.reporting = {
          state: 'unavailable',
          reason: `${this.provider.tool} has not run Agent Guild's reporting hooks yet. That is expected while it signs in or sets up; otherwise its hooks may be turned off, restricted by an administrator, or not trusted for this folder.`,
        };
        this._changed();
      }, this.reportingTimeoutMs);
      this._reportingTimer.unref?.();
    }
  }

  _reply(data) {
    this.write(data);
  }

  resize(cols, rows) {
    const c = clampDimension(cols, this.cols, 2, 1000);
    const r = clampDimension(rows, this.rows, 1, 500);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    this.term.resize(c, r);
    if (this.status === 'running') {
      try { this.pty.resize(c, r); } catch { /* process may be exiting */ }
    }
    this._broadcast({ type: 'resize', cols: c, rows: r });
  }

  /**
   * End the process. On macOS and Linux: hang-up first, force after a grace
   * period. On Windows: end the whole process tree at once. node-pty's own
   * Windows kill first asks a helper process for the console's process list,
   * and when that helper fails it waits a fixed five seconds.
   */
  kill({ graceMs = this.killGraceMs } = {}) {
    if (this.status !== 'running') return;
    if (process.platform === 'win32') {
      this._killWindowsTree();
      return;
    }
    const force = () => { try { this.pty.kill('SIGKILL'); } catch { /* gone */ } };
    try { this.pty.kill('SIGHUP'); } catch { force(); }
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(force, graceMs);
    this._killTimer.unref?.();
  }

  _killWindowsTree() {
    const fallback = () => {
      if (this.status === 'running') { try { this.pty.kill(); } catch { /* gone */ } }
    };
    const pid = this.pty.pid;
    if (!pid) return fallback();
    killWindowsTree(pid, (err) => { if (err) fallback(); });
  }

  /**
   * Detach everything. A still-running process gets the normal hang-up and
   * is force-killed after the grace period if it ignores it.
   */
  dispose({ graceMs } = {}) {
    if (this.disposed) return;
    this.kill(graceMs === undefined ? {} : { graceMs });
    this.disposed = true;
    clearTimeout(this._activityTimer);
    clearTimeout(this._scanTimer);
    clearTimeout(this._reportingTimer);
    this._clearShells();
    for (const t of this._agentTimers.values()) clearTimeout(t);
    this.subscribers.clear();
    this.term.dispose();
  }

  rename(name) {
    const clean = cleanName(name);
    if (!clean) return;
    this.name = clean;
    this._changed();
  }

  // ---- sub-agents --------------------------------------------------------

  /**
   * Record a report about an agent working inside this session. `status`
   * "done" (or `remove: true`) removes it after a short linger so the UI can
   * show it finishing. Returns the stored agent or null when removed.
   */
  reportAgent(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('agent report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    if (report.finishForeground === true && report.agentId === undefined) {
      // The tool is between turns, so no foreground agent can still be
      // running; one that is never got its end event.
      for (const agent of [...this.agents.values()]) {
        if (agent.foreground && agent.status === 'working') this.reportAgent({ agentId: agent.id, status: 'done' }, source);
      }
      this._endForegroundShells(null);
      return null;
    }
    const id = String(report.agentId ?? report.agent ?? report.id ?? '').trim().slice(0, 128);
    if (!id) throw badRequest('agentId is required');

    if (report.remove === true) {
      this._removeAgent(id);
      return null;
    }
    const status = report.status === undefined ? 'working' : String(report.status);
    if (!AGENT_STATUSES.has(status)) {
      throw badRequest(`status must be one of ${[...AGENT_STATUSES].join(', ')}`);
    }
    const now = new Date().toISOString();
    const existing = this.agents.get(id);
    if (!existing && status === 'done' && report.foreground === true) {
      // Gemini CLI's invoke_agent is paired by its input, which a BeforeTool hook may rewrite before AfterTool.
      const working = [...this.agents.values()].filter((agent) => agent.foreground && agent.status === 'working');
      return working.length === 1 ? this.reportAgent({ agentId: working[0].id, status: 'done' }, source) : null;
    }
    if (status === 'done') this._endForegroundShells(id);
    // A first report that already says done would only flash an icon:
    // Claude Code's internal helpers (prompt suggestions, side questions)
    // stop without ever having started here.
    if (!existing && status === 'done') return null;
    // A repeated done (Grok Build ends a sub-agent's session after its
    // turn) must not restart the linger.
    if (existing?.status === 'done' && status === 'done') return existing;
    if (!existing && this.agents.size >= MAX_AGENTS && !this._evictDoneAgent()) {
      throw badRequest(`too many agents (max ${MAX_AGENTS})`);
    }
    const agent = {
      id,
      name: String(report.name ?? existing?.name ?? id).slice(0, 80),
      kind: String(report.kind ?? existing?.kind ?? 'agent').slice(0, 40),
      status,
      detail: report.detail === undefined ? existing?.detail ?? '' : String(report.detail).slice(0, 200),
      // The parent waits for a foreground agent, so a model reported while
      // it works belongs to the agent, not to the session.
      foreground: report.foreground === undefined ? existing?.foreground ?? false : report.foreground === true,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      source,
    };
    this.agents.set(id, agent);
    clearTimeout(this._agentTimers.get(id));
    this._agentTimers.delete(id);
    if (status === 'done') {
      const timer = setTimeout(() => this._removeAgent(id), this.doneAgentLingerMs);
      timer.unref?.();
      this._agentTimers.set(id, timer);
    }
    this._changed();
    return agent;
  }

  _removeAgent(id) {
    clearTimeout(this._agentTimers.get(id));
    this._agentTimers.delete(id);
    if (this.agents.delete(id)) this._changed();
  }

  /** Drop the done agent that has lingered longest, to make room. */
  _evictDoneAgent() {
    let oldest = null;
    for (const agent of this.agents.values()) {
      if (agent.status === 'done' && (!oldest || agent.updatedAt < oldest.updatedAt)) oldest = agent;
    }
    if (!oldest) return false;
    this._removeAgent(oldest.id);
    return true;
  }

  _clearAgents() {
    for (const t of this._agentTimers.values()) clearTimeout(t);
    this._agentTimers.clear();
    this.agents.clear();
  }

  _handleOscReport(payload) {
    if (!payload.startsWith(OSC_AGENT_PREFIX)) return;
    try {
      const report = JSON.parse(payload.slice(OSC_AGENT_PREFIX.length));
      const isAgent = report && typeof report === 'object' &&
        ((report.agentId ?? report.agent ?? report.id) !== undefined || report.finishForeground === true);
      if (isAgent) this.reportAgent(report, 'terminal');
      else if (report?.toolSessionId !== undefined) this.reportToolSession(report, 'terminal');
      else this.reportModel(report, 'terminal');
    } catch (err) {
      this.emit('warning', `ignored in-band report: ${err.message}`);
    }
  }

  // ---- shells ------------------------------------------------------------

  reportShell(report) {
    if (!report || typeof report !== 'object') throw badRequest('shell report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (!SHELL_EVENTS.has(report.shell)) throw badRequest(`shell must be one of ${[...SHELL_EVENTS].join(', ')}`);
    const id = (value) => (typeof value === 'string' && value ? value.slice(0, 128) : null);
    const key = id(report.key);
    const bucket = !key && typeof report.bucket === 'string' && /^[a-f0-9]{1,64}$/.test(report.bucket) ? report.bucket : null;
    const task = id(report.task);
    const match = typeof report.match === 'string' && /^[a-f0-9]{32}$/.test(report.match) ? report.match : null;
    const agentId = id(report.agentId);
    this._reportingHeard();

    if (report.shell === 'reset') {
      for (const shell of [...this.shells.values()]) this._endShell(shell);
      return null;
    }

    if (report.shell === 'running') {
      if (!Array.isArray(report.tasks)) throw badRequest('a running report needs a tasks array');
      const running = new Set(report.tasks.slice(0, MAX_SHELLS).map(id).filter(Boolean));
      for (const shell of [...this.shells.values()]) if (shell.task && !running.has(shell.task)) this._endShell(shell);
      const known = new Set([...this.shells.values()].map((shell) => shell.task));
      for (const each of running) if (!known.has(each) && !this._endedTasks.has(each)) this._addShell({ task: each }, { now: true });
      return null;
    }

    if (report.shell === 'waiting' || report.shell === 'asked') {
      // A permission request carries no call id, and a PreToolUse hook may have rewritten its command: it belongs to the
      // agent's one foreground command with that command, else to its only one.
      const candidates = [...this.shells.values()].filter((shell) => shell.agentId === agentId && this._foreground(shell) && !shell.waiting && !shell.asked);
      const exact = match ? candidates.filter((shell) => shell.match === match) : [];
      const shell = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : null;
      if (shell && report.shell === 'asked') {
        shell.asked = true;
      } else if (shell) {
        clearTimeout(shell.timer);
        shell.waiting = true;
        this._setVisible(shell, false);
      }
      return null;
    }

    if (report.shell === 'end') {
      if (!key && !bucket && !task) throw badRequest('a shell end needs a key, a bucket or a task');
      if (task) this._rememberEnded(task);
      const shell = (key && this._shellBy('key', key)) || (task && this._shellBy('task', task)) || (bucket && this._shellByBucket(bucket));
      if (shell) this._endShell(shell);
      return null;
    }

    if (!key && !bucket) throw badRequest('a shell report needs a key or a bucket');
    if (report.shell === 'start') {
      if (!key || !this._shellBy('key', key)) this._addShell({ key, bucket, match, agentId, persist: report.persist === true });
      return null;
    }

    const pids = Array.isArray(report.pids) ? report.pids.filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, MAX_SHELL_PIDS) : [];
    if (!task && pids.length === 0) throw badRequest('a background report needs a task or pids');
    const shell = key ? this._shellBy('key', key) : this._shellByBucket(bucket);
    if (!shell) return null;
    if (task) {
      Object.assign(shell, { task, endsWithAgent: report.endsWithAgent === true });
    } else {
      // Gemini CLI names a pid even for a command that ended at once.
      shell.pids = pids.filter(processExists);
      if (shell.pids.length === 0) {
        this._endShell(shell);
        return null;
      }
      this._checkPids();
    }
    if (shell.waiting) {
      shell.waiting = false;
      this._showAfterDelay(shell);
    }
    return null;
  }

  _addShell(fields, { now = false } = {}) {
    if (this.shells.size >= MAX_SHELLS) {
      this.emit('warning', `ignored a shell command: ${MAX_SHELLS} are already running`);
      return;
    }
    const shell = {
      id: `shell-${++this._shellSeq}`, key: null, bucket: null, match: null, agentId: null, persist: false, task: null, pids: null,
      endsWithAgent: false, waiting: false, asked: false, visible: false, timer: null, ...fields,
    };
    this.shells.set(shell.id, shell);
    if (now) this._setVisible(shell, true);
    else this._showAfterDelay(shell);
  }

  _showAfterDelay(shell) {
    clearTimeout(shell.timer);
    shell.timer = setTimeout(() => this._setVisible(shell, true), this.shellDisplayDelayMs);
    shell.timer.unref?.();
  }

  _setVisible(shell, visible) {
    if (shell.visible === visible) return;
    shell.visible = visible;
    this._changed();
  }

  _foreground(shell) {
    return shell.task === null && shell.pids === null;
  }

  _shellBy(field, value) {
    for (const shell of this.shells.values()) if (shell[field] === value) return shell;
    return null;
  }

  // Gemini CLI's calls are paired by their input, which a BeforeTool hook may rewrite before AfterTool.
  _shellByBucket(bucket) {
    const open = [...this.shells.values()].filter((shell) => shell.bucket !== null && this._foreground(shell));
    return open.find((shell) => shell.bucket === bucket) ?? (open.length === 1 ? open[0] : null);
  }

  _checkPids() {
    if (this._pidTimer) return;
    this._pidTimer = setInterval(() => {
      let watching = false;
      for (const shell of [...this.shells.values()]) {
        if (!shell.pids) continue;
        shell.pids = shell.pids.filter(processExists);
        if (shell.pids.length) watching = true;
        else this._endShell(shell);
      }
      if (!watching) {
        clearInterval(this._pidTimer);
        this._pidTimer = null;
      }
    }, this.shellPidCheckMs);
    this._pidTimer.unref?.();
  }

  // A turn's foreground commands end with it; a background command, or one Codex CLI keeps running, does not.
  _endForegroundShells(agentId) {
    for (const shell of [...this.shells.values()]) {
      if (shell.agentId !== agentId) continue;
      const lasting = this._foreground(shell) ? shell.persist && !shell.asked : !(agentId && shell.endsWithAgent);
      if (!lasting) this._endShell(shell);
    }
  }

  _rememberEnded(task) {
    this._endedTasks.delete(task);
    this._endedTasks.add(task);
    if (this._endedTasks.size > MAX_ENDED_TASKS) this._endedTasks.delete(this._endedTasks.values().next().value);
  }

  _endShell(shell) {
    clearTimeout(shell.timer);
    if (shell.task) this._rememberEnded(shell.task);
    if (this.shells.delete(shell.id) && shell.visible) this._changed();
  }

  _clearShells() {
    for (const shell of this.shells.values()) clearTimeout(shell.timer);
    clearInterval(this._pidTimer);
    this._pidTimer = null;
    this.shells.clear();
  }

  // ---- model -------------------------------------------------------------

  /**
   * The main model the tool says it is using. Explicit reports win over
   * text seen on screen, which wins over a --model argument.
   */
  setModel({ name, displayName = null }, source) {
    if (this.model && MODEL_SOURCE_RANK[this.model.source] > MODEL_SOURCE_RANK[source]) return;
    const current = this.model;
    if (current && current.name === name && current.displayName === displayName && current.source === source) return;
    this.model = { name, displayName, source };
    this._changed();
  }

  reportModel(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('model report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    const name = String(report.model ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('model is required');
    const displayName = report.displayName === undefined || report.displayName === null ? null : String(report.displayName).trim().slice(0, 80) || null;
    // Gemini CLI fires BeforeModel for a sub-agent's requests too, with the
    // sub-agent's model and nothing to tell them apart. While a foreground
    // agent works its parent makes no request, so the report is the agent's.
    if (this._foregroundAgentWorking()) return this.model;
    this.setModel({ name, displayName }, 'report');
    return this.model;
  }

  reportToolSession(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('tool session report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    const id = String(report.toolSessionId ?? '').trim();
    if (!id || id.length > MAX_TOOL_SESSION_ID || /\p{Cc}/u.test(id)) throw badRequest(`toolSessionId must be a printable id of at most ${MAX_TOOL_SESSION_ID} characters`);
    if (this.toolSessionId !== id) {
      this.toolSessionId = id;
      this._changed();
    }
    return this.toolSessionId;
  }

  reportHello() {
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    this._reportingHeard();
    return this.reporting;
  }

  _reportingHeard() {
    clearTimeout(this._reportingTimer);
    if (!this.reporting || this.reporting.state === 'active') return;
    this.reporting = { state: 'active', reason: null };
    this._changed();
  }

  _foregroundAgentWorking() {
    for (const agent of this.agents.values()) {
      if (agent.foreground && agent.status === 'working') return true;
    }
    return false;
  }

  /**
   * Scan shortly after output pauses, and at least every couple of seconds
   * while output keeps coming, so a busy tool still gets scanned.
   */
  _scheduleModelScan() {
    const now = Date.now();
    this._scanDeadline ??= now + SCREEN_SCAN_MAX_DELAY_MS;
    clearTimeout(this._scanTimer);
    const delay = Math.max(0, Math.min(SCREEN_SCAN_DELAY_MS, this._scanDeadline - now));
    this._scanTimer = setTimeout(() => this._scanScreenForModel(), delay);
    this._scanTimer.unref?.();
  }

  _scanScreenForModel() {
    this._scanDeadline = null;
    if (this.disposed || !this.modelRegex || this.model?.source === 'report') return;
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    let last = null;
    for (const match of lines.join('\n').matchAll(this.modelRegex)) last = match[0];
    if (last) this.setModel({ name: last.replace(/[.,;:)]+$/, '') }, 'screen');
  }

  // ---- state -------------------------------------------------------------

  _changed() {
    this.emit('changed', this);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      provider: {
        id: this.provider.id,
        vendor: this.provider.vendor,
        tool: this.provider.tool,
        color: this.provider.color,
        monogram: this.provider.monogram,
        iconUrl: this.provider.iconUrl,
      },
      cwd: this.cwd,
      resume: this.resume,
      task: this.task,
      account: this.account,
      clone: this.clone,
      pid: this.pid,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      activity: this.activity,
      lastOutputAt: this.lastOutputAt ? new Date(this.lastOutputAt).toISOString() : null,
      createdAt: this.createdAt,
      exitedAt: this.exitedAt,
      cols: this.cols,
      rows: this.rows,
      attachedClients: this.subscribers.size,
      model: this.model,
      toolSessionId: this.toolSessionId,
      reporting: this.reporting,
      agents: [...this.agents.values()],
      shells: [...this.shells.values()].filter((s) => s.visible).map((s) => ({ id: s.id })),
    };
  }
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

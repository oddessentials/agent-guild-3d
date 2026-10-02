// Provider registry: which coding tools can be launched and how.
//
// Built-in defaults live in config/providers.default.json. Users customise
// them with providers.json in the data directory: entries are merged by `id`,
// new ids are appended, and `"enabled": false` hides a provider. Any field can
// be overridden per platform under a "win32", "darwin" or "linux" key.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolveCommand, resolveAllCommands, pathKey, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { compareVersions, probeVersion, fetchManifest, latestVersion, DEFAULT_NPM_REGISTRY } from './versions.mjs';
import { CHANNEL_LABELS, classifyInstall, expandHome, formatCommand, helpDescribes, knownLaunchers, listInstallations, platformDependency } from './install-channels.mjs';
import { weavePaths } from './shell-env.mjs';
import { paths } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS_FILE = path.resolve(here, '../../config/providers.default.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLATFORM_KEYS = ['win32', 'darwin', 'linux'];
const REPORTING_MODES = new Set(['claude', 'codex', 'gemini', 'grok']);
const VERSION_TTL_MS = 60 * 60 * 1000;
const FAILED_PROBE_TTL_MS = 5 * 60 * 1000;
const PATH_REFRESH_MS = 60 * 1000;
const INSTALLS_TTL_MS = 30 * 1000;

function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function defaultShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return 'powershell.exe';
  return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Keep string, number and boolean values as strings; drop anything else. */
function normalizeEnv(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = String(value);
  }
  return out;
}

/** "claude", "codex", "gemini", a { command, args } that prints usage JSON, or null. */
function normalizeUsage(usage) {
  if (usage === 'claude' || usage === 'codex' || usage === 'gemini') return usage;
  if (usage && typeof usage === 'object' && typeof usage.command === 'string' && usage.command) {
    return { command: usage.command, args: Array.isArray(usage.args) ? usage.args.map(String) : [] };
  }
  return null;
}

/** "claude", "codex", "gemini", "grok", a { command, args } that prints past sessions as JSON, or null. */
function normalizeHistory(history) {
  if (['claude', 'codex', 'gemini', 'grok'].includes(history)) return history;
  if (history && typeof history === 'object' && typeof history.command === 'string' && history.command) {
    return { command: history.command, args: Array.isArray(history.args) ? history.args.map(String) : [] };
  }
  return null;
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeChannels(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.native && typeof raw.native === 'object') {
    out.native = {
      paths: stringList(raw.native.paths),
      update: stringList(raw.native.update),
      uninstall: raw.native.uninstall ? String(raw.native.uninstall) : null,
      sharedWithNpm: raw.native.sharedWithNpm === true,
    };
  }
  if (raw.brew && typeof raw.brew === 'object') out.brew = { names: stringList(raw.brew.names) };
  if (raw.winget && typeof raw.winget === 'object' && raw.winget.id) out.winget = { id: String(raw.winget.id) };
  if (raw.legacy && typeof raw.legacy === 'object') {
    out.legacy = {
      paths: stringList(raw.legacy.paths),
      guidance: raw.legacy.guidance ? String(raw.legacy.guidance) : null,
      uninstall: raw.legacy.uninstall ? String(raw.legacy.uninstall) : null,
    };
  }
  return out;
}

function normalizeHooks(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || typeof raw.example !== 'string') return null;
  const parts = raw.path.split(/[\\/]+/);
  if (parts.some((part) => part === '' || part === '.' || part === '..') || !/^[A-Za-z0-9._-]+$/.test(raw.example)) return null;
  return { path: parts.join('/'), example: raw.example };
}

const DEFAULT_ACCOUNT = 'default';

function normalizeAccounts(raw, id, homeVar, warnings) {
  const accounts = [{ id: DEFAULT_ACCOUNT, label: 'Default', dir: null }];
  if (raw === undefined || raw === null) return accounts;
  if (!Array.isArray(raw)) {
    warnings.push(`provider "${id}": ignored accounts; it must be an array`);
    return accounts;
  }
  if (!homeVar && raw.length > 0) {
    warnings.push(`provider "${id}": ignored accounts; the provider has no homeVar`);
    return accounts;
  }
  for (const entry of raw) {
    const item = typeof entry === 'string' ? { id: entry } : entry;
    const accountId = item && typeof item === 'object' ? String(item.id ?? '') : '';
    if (!ID_RE.test(accountId)) {
      warnings.push(`provider "${id}": skipped account with invalid id ${JSON.stringify(item?.id ?? entry)}`);
      continue;
    }
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 40) : accountId.charAt(0).toUpperCase() + accountId.slice(1);
    const dir = typeof item.dir === 'string' && item.dir.trim() ? item.dir.trim() : null;
    const existing = accounts.find((a) => a.id === accountId);
    if (existing) {
      if (accountId !== DEFAULT_ACCOUNT) {
        warnings.push(`provider "${id}": skipped duplicate account "${accountId}"`);
        continue;
      }
      existing.label = label;
      if (dir) warnings.push(`provider "${id}": ignored dir of the default account; it uses the tool's own home folder`);
      continue;
    }
    accounts.push({ id: accountId, label, dir });
  }
  return accounts;
}

function httpsUrl(value, field, id, warnings) {
  if (value === undefined || value === null || value === '') return null;
  try {
    const url = new URL(String(value));
    if (url.protocol === 'https:') return url.href;
  } catch { /* reported below */ }
  warnings.push(`provider "${id}": ignored ${field} ${JSON.stringify(value)}; it must be an https:// URL`);
  return null;
}

function normalize(raw, platform, warnings) {
  const merged = { ...raw, ...(raw[platform] || {}) };
  for (const key of PLATFORM_KEYS) delete merged[key];
  const homeVar = typeof merged.homeVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(merged.homeVar) ? merged.homeVar : null;
  return {
    id: merged.id,
    vendor: String(merged.vendor || merged.id),
    tool: String(merged.tool || merged.command || ''),
    command: String(merged.command || ''),
    package: merged.package ? String(merged.package) : null,
    versionArgs: Array.isArray(merged.versionArgs) && merged.versionArgs.length ? merged.versionArgs.map(String) : null,
    usage: normalizeUsage(merged.usage),
    history: normalizeHistory(merged.history),
    reporting: REPORTING_MODES.has(merged.reporting) ? merged.reporting : null,
    modelPattern: merged.modelPattern ? String(merged.modelPattern) : null,
    args: Array.isArray(merged.args) ? merged.args.map(String) : [],
    resumeArgs: Array.isArray(merged.resumeArgs) ? merged.resumeArgs.map(String) : [],
    env: normalizeEnv(merged.env),
    homeVar,
    accountEnv: normalizeEnv(merged.accountEnv),
    hooks: normalizeHooks(merged.hooks),
    accounts: normalizeAccounts(merged.accounts, merged.id, homeVar, warnings),
    color: String(merged.color || '#64748B'),
    monogram: String(merged.monogram || String(merged.vendor || merged.id).charAt(0)).slice(0, 2),
    icon: merged.icon ? String(merged.icon) : null,
    install: String(merged.install || ''),
    npmNote: merged.npmNote ? String(merged.npmNote) : null,
    channels: normalizeChannels(merged.channels),
    docs: String(merged.docs || ''),
    usageUrl: httpsUrl(merged.usageUrl, 'usageUrl', merged.id, warnings),
    billingUrl: httpsUrl(merged.billingUrl, 'billingUrl', merged.id, warnings),
    enabled: merged.enabled !== false,
  };
}

/**
 * Load providers. Returns { providers, warnings } so a broken user file never
 * prevents the manager from starting.
 */
export function loadProviders({ userFile, platform = process.platform } = {}) {
  const warnings = [];
  const byId = new Map();
  const order = [];
  const add = (entry, source) => {
    if (!entry || typeof entry !== 'object' || !ID_RE.test(entry.id || '')) {
      warnings.push(`${source}: skipped provider with invalid id ${JSON.stringify(entry && entry.id)}`);
      return;
    }
    if (byId.has(entry.id)) {
      byId.set(entry.id, { ...byId.get(entry.id), ...entry });
    } else {
      byId.set(entry.id, { ...entry });
      order.push(entry.id);
    }
  };

  for (const entry of readJson(DEFAULTS_FILE).providers) add(entry, 'defaults');

  if (userFile && fs.existsSync(userFile)) {
    try {
      const user = readJson(userFile);
      const list = Array.isArray(user) ? user : user.providers;
      if (!Array.isArray(list)) throw new Error('expected a "providers" array');
      for (const entry of list) add(entry, userFile);
    } catch (err) {
      warnings.push(`${userFile}: ${err.message}; using built-in providers only`);
    }
  }

  const providers = order.map((id) => normalize(byId.get(id), platform, warnings)).filter((p) => p.enabled);
  return { providers, warnings };
}

export class ProviderRegistry extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.userFile]
   * @param {object} [opts.env]
   * @param {string} [opts.platform]
   * @param {string} [opts.iconDir]
   * @param {string} [opts.registryUrl]   npm registry for lookups and installs; default: npm's own configuration
   * @param {boolean} [opts.checkUpdates] false skips registry lookups entirely
   * @param {Function} [opts.fetchImpl]
   * @param {string} [opts.accountsDir]  where accounts without a dir get their home folders
   */
  constructor({ userFile, env, platform = process.platform, iconDir, registryUrl = null, checkUpdates = true, fetchImpl, pathReader = null, accountsDir = paths.accounts } = {}) {
    super();
    this.userFile = userFile;
    this.accountsDir = accountsDir;
    this.env = env || process.env;
    this.platform = platform;
    this.iconDir = iconDir;
    this.registryUrl = registryUrl || null;
    this.checkUpdates = checkUpdates;
    this.fetchImpl = fetchImpl;
    this.pathReader = pathReader;
    this._pathReadAt = 0;
    this._pathPending = null;
    this._installs = new Map();
    this.versions = new Map();
    this._refreshing = null;
    this._npmRegistry = null;
    this.reportingEnabled = null;
    this.reload();
  }

  reload() {
    const { providers, warnings } = loadProviders({ userFile: this.userFile, platform: this.platform });
    this.providers = providers;
    this.warnings = warnings;
    this._npmRegistry = null;
    this._installs.clear();
    for (const w of warnings) console.warn(`[providers] ${w}`);
    this.emit('updated');
  }

  /**
   * The registry that installs use: the configured one, else npm's global
   * configuration, which is what `npm install -g` reads (a project .npmrc
   * in the launch directory does not apply to it).
   */
  npmRegistryUrl() {
    if (this.registryUrl) return Promise.resolve(this.registryUrl);
    this._npmRegistry ??= (async () => {
      // PATH discovery in flight may change which npm is found; wait for it.
      await this._pathPending;
      const npm = this.resolveNpm();
      if (!npm) return DEFAULT_NPM_REGISTRY;
      try {
        const spec = buildSpawnSpec(npm, ['config', 'get', 'registry', '--global'], this.env, this.platform);
        const url = (await runSpec(spec, { env: this.env, timeoutMs: 10000 })).stdout.trim();
        return /^https?:\/\/\S+$/.test(url) ? url : DEFAULT_NPM_REGISTRY;
      } catch {
        return DEFAULT_NPM_REGISTRY;
      }
    })();
    return this._npmRegistry;
  }

  /**
   * Check installed and latest versions. Cheap when nothing changed: a
   * tool is re-run only when its file changed, hourly, or a few minutes
   * after a failed probe, and the registry is asked hourly, unless `force`.
   * Emits "updated" when a version changed.
   */
  refreshVersions({ force = false, ids = null } = {}) {
    const run = () => this._refreshVersions({ force, ids });
    const pending = this._refreshing ? this._refreshing.then(run, run) : run();
    this._refreshing = pending;
    pending.finally(() => { if (this._refreshing === pending) this._refreshing = null; }).catch(() => {});
    return pending;
  }

  /** Resolves to true when the PATH changed. A concurrent caller waits for the read already in flight. */
  refreshPath({ force = false } = {}) {
    if (!this.pathReader) return Promise.resolve(false);
    const now = Date.now();
    if (!force && now - this._pathReadAt < PATH_REFRESH_MS) return this._pathPending ?? Promise.resolve(false);
    this._pathReadAt = now;
    const pending = this._readPath().finally(() => { if (this._pathPending === pending) this._pathPending = null; });
    this._pathPending = pending;
    return pending;
  }

  async _readPath() {
    const discovered = await Promise.resolve().then(() => this.pathReader()).catch(() => null);
    if (!discovered) return false;
    const key = pathKey(this.env, this.platform);
    const next = weavePaths(this.env[key] || '', discovered, {
      delimiter: this.platform === 'win32' ? ';' : ':',
      caseInsensitive: this.platform === 'win32',
    });
    if (next === (this.env[key] || '')) return false;
    this.env[key] = next;
    this._installs.clear();
    return true;
  }

  async _refreshVersions({ force, ids }) {
    const now = Date.now();
    let changed = await this.refreshPath({ force });
    const providers = this.providers.filter((p) => !ids || ids.includes(p.id));
    if (force) for (const provider of providers) this._installs.delete(provider.id);
    const lookups = this.checkUpdates && providers.some((p) => p.package);
    const registryUrl = lookups ? await this.npmRegistryUrl() : null;
    await Promise.all(providers.map(async (provider) => {
      const entry = this.versions.get(provider.id) || {
        installed: null, versionStatus: null, versionError: null, installedPath: null, installedMtime: null, installedAt: 0,
        latest: null, latestAt: 0, probePath: null, probeMtime: null, probeAt: 0, probeOk: null, lastInstall: null, copies: {},
      };
      const found = this.resolve(provider);
      const channel = found ? this.channelFor(provider, found) : null;
      if (channel?.probe) {
        const mtime = fileMtime(found);
        const ttl = entry.probeOk === true ? VERSION_TTL_MS : FAILED_PROBE_TTL_MS;
        if (force || entry.probePath !== found || entry.probeMtime !== mtime || now - entry.probeAt > ttl) {
          const spec = buildSpawnSpec(channel.update.file, [...channel.update.args, '--help'], this.env, this.platform);
          const ok = await runSpec(spec, { env: { ...this.env, ...provider.env } })
            .then(({ stdout, stderr }) => helpDescribes(`${stdout}\n${stderr}`, channel.update.args), () => false);
          changed ||= ok !== entry.probeOk;
          Object.assign(entry, { probePath: found, probeMtime: mtime, probeAt: now, probeOk: ok });
        }
      } else if (entry.probePath !== null) {
        Object.assign(entry, { probePath: null, probeMtime: null, probeAt: 0, probeOk: null });
        changed = true;
      }
      const resolved = provider.versionArgs ? found : null;
      if (resolved) {
        const mtime = fileMtime(resolved);
        const ttl = entry.installed === null ? FAILED_PROBE_TTL_MS : VERSION_TTL_MS;
        const stale = entry.installedPath !== resolved || entry.installedMtime !== mtime || now - entry.installedAt > ttl;
        if (force || stale) {
          const spec = buildSpawnSpec(resolved, provider.versionArgs, this.env, this.platform);
          const probe = await probeVersion(spec, { env: { ...this.env, ...provider.env } });
          const versionStatus = !probe.ok ? 'failed' : probe.version ? 'ok' : 'unavailable';
          changed ||= probe.version !== entry.installed || versionStatus !== entry.versionStatus || probe.error !== entry.versionError;
          Object.assign(entry, {
            installed: probe.version, versionStatus, versionError: probe.error, installedPath: resolved, installedMtime: mtime, installedAt: now,
          });
        }
      } else if (entry.installedPath !== null) {
        Object.assign(entry, { installed: null, versionStatus: null, versionError: null, installedPath: null, installedMtime: null, installedAt: 0 });
        changed = true;
      }
      const copies = {};
      for (const other of provider.versionArgs ? this.installsFor(provider, found).filter((i) => i.resolvedPath !== found) : []) {
        const file = other.resolvedPath;
        const mtime = fileMtime(file);
        const cached = entry.copies[file];
        const ttl = cached?.version ? VERSION_TTL_MS : FAILED_PROBE_TTL_MS;
        if (!force && cached && cached.mtime === mtime && now - cached.at <= ttl) {
          copies[file] = cached;
          continue;
        }
        const probe = await probeVersion(buildSpawnSpec(file, provider.versionArgs, this.env, this.platform), { env: { ...this.env, ...provider.env } });
        const status = !probe.ok ? 'failed' : probe.version ? 'ok' : 'unavailable';
        changed ||= !cached || cached.version !== probe.version || cached.status !== status;
        copies[file] = { version: probe.version, status, mtime, at: now };
      }
      changed ||= Object.keys(entry.copies).length !== Object.keys(copies).length;
      entry.copies = copies;
      if (provider.package && lookups && (force || now - entry.latestAt > VERSION_TTL_MS)) {
        const latest = await latestVersion(provider.package, { registryUrl, fetchImpl: this.fetchImpl });
        changed ||= latest !== entry.latest;
        Object.assign(entry, { latest, latestAt: now });
      }
      const last = entry.lastInstall;
      if (last && (entry.installed !== last.after || entry.latest !== last.latest || entry.versionStatus !== last.verification)) {
        entry.lastInstall = null;
        changed = true;
      }
      this.versions.set(provider.id, entry);
    }));
    if (changed) this.emit('updated');
  }

  async finishInstall(id, { exitCode = null, kind = 'update' } = {}) {
    const provider = this.get(id);
    if (!provider) return;
    const before = this.versions.get(id)?.installed ?? null;
    this.emit('updated');
    await this.refreshVersions({ force: true, ids: [id] });
    const entry = this.versions.get(id);
    if (!entry) return;
    let outcome;
    if (exitCode !== 0) outcome = 'failed';
    else if (kind === 'install') outcome = this.resolve(provider) ? 'installed' : 'missing';
    else if (entry.installed === null) outcome = 'done';
    else outcome = entry.installed !== before ? 'updated' : 'unchanged';
    entry.lastInstall = {
      kind, outcome, exitCode, verification: entry.versionStatus, before, after: entry.installed, latest: entry.latest, at: Date.now(),
    };
    this.emit('updated');
  }

  async archFor(npm) {
    const p = this.platform === 'win32' ? path.win32 : path.posix;
    const node = p.join(p.dirname(npm), this.platform === 'win32' ? 'node.exe' : 'node');
    if (!fs.existsSync(node)) return process.arch;
    try {
      const { stdout } = await runSpec({ file: node, args: ['-p', 'process.arch'] }, { env: this.env, timeoutMs: 5000 });
      return stdout.trim() || process.arch;
    } catch {
      return process.arch;
    }
  }

  async resolveRelease(provider, npm) {
    if (!this.checkUpdates) return 'latest';
    const registryUrl = await this.npmRegistryUrl();
    const lookup = { registryUrl, fetchImpl: this.fetchImpl };
    const { manifest, error } = await fetchManifest(provider.package, 'latest', lookup);
    if (!manifest) {
      throw refusal(503, 'release_unresolved', `Could not read the latest ${provider.tool} release from ${registryUrl}: ${error}. Nothing was changed.`);
    }
    const arch = await this.archFor(npm);
    const build = platformDependency(manifest, provider.package, this.platform, arch);
    if (build) {
      const found = await fetchManifest(build.name, build.version, lookup);
      if (!found.manifest) {
        throw refusal(409, 'release_incomplete',
          `${provider.tool} ${manifest.version} is published, but its ${this.platform}-${arch} build (${build.name}@${build.version}) is not available yet: ${found.error}. Nothing was changed. Try again shortly.`);
      }
    }
    return manifest.version;
  }

  npmArgs(update, version) {
    const args = [...update.args];
    if (!update.package) return args;
    args.push(`${update.package}@${version}`);
    if (this.registryUrl) args.push('--registry', this.registryUrl);
    return args;
  }

  channelFor(provider, resolvedPath = this.resolve(provider)) {
    if (!resolvedPath) return null;
    return classifyInstall({
      resolvedPath,
      provider,
      env: { ...this.env, ...provider.env },
      platform: this.platform,
      npmOnPath: this.resolveNpm(),
      wingetOnPath: this.resolveWinget(),
    });
  }

  resolveWinget() {
    return this.platform === 'win32' ? resolveCommand('winget', this.env, this.platform) : null;
  }

  installsFor(provider, resolvedPath = this.resolve(provider)) {
    const cached = this._installs.get(provider.id);
    if (cached && cached.resolvedPath === resolvedPath && Date.now() - cached.at < INSTALLS_TTL_MS) return cached.list;
    const list = this.listInstalls(provider);
    this._installs.set(provider.id, { list, resolvedPath, at: Date.now() });
    return list;
  }

  listInstalls(provider) {
    const env = { ...this.env, ...provider.env };
    const command = this.commandFor(provider);
    const tracked = Boolean(provider.package) || Object.keys(provider.channels).length > 0;
    return listInstallations({
      onPath: tracked ? resolveAllCommands(command, env, this.platform) : [this.resolve(provider)].filter(Boolean),
      known: tracked ? knownLaunchers({ provider, command, env, platform: this.platform }) : [],
      provider,
      env,
      platform: this.platform,
      npmOnPath: this.resolveNpm(),
      wingetOnPath: this.resolveWinget(),
    });
  }

  installWarnings(provider, installs) {
    const label = (i) => [CHANNEL_LABELS[i.channel], i.version && `v${i.version}`].filter(Boolean).join(' ');
    const active = installs.find((i) => i.active);
    if (!active) return installs.map((i) => `A copy of ${provider.tool} exists at ${i.path}, but its folder is not on PATH.`);
    const warnings = [];
    if (installs.length > 1) {
      warnings.push(`${installs.length} copies of ${provider.tool} are installed. The one in use is ${label(active)} at ${active.path}.`);
    }
    const newer = installs.find((i) => i.newer);
    if (newer) warnings.push(`An older copy comes first on PATH: ${label(active)} is in use while ${label(newer)} is installed at ${newer.path}.`);
    return warnings;
  }

  updateFor(provider, channel = this.channelFor(provider)) {
    if (!channel) return { file: null, args: [], command: null, guidance: null };
    if (!channel.update) return { file: null, args: [], command: null, guidance: channel.guidance };
    const args = this.npmArgs(channel.update, this.versions.get(provider.id)?.latest ?? 'latest');
    const command = formatCommand(channel.update.file, args);
    if (channel.probe) {
      const probeOk = this.versions.get(provider.id)?.probeOk ?? null;
      if (probeOk === null) return { file: null, args: [], command: null, guidance: null };
      if (probeOk === false) {
        return { file: null, args: [], command: null, guidance: `This copy of ${provider.tool} does not accept "${command}". Update it the way you installed it.` };
      }
    }
    return { file: channel.update.file, args, command, guidance: null };
  }

  get(id) {
    return this.providers.find((p) => p.id === id) || null;
  }

  accountFor(provider, account) {
    if (account.id === DEFAULT_ACCOUNT || !provider.homeVar) return { id: account.id, label: account.label, dir: null, env: {} };
    const p = this.platform === 'win32' ? path.win32 : path.posix;
    const own = account.dir ? expandHome(account.dir, this.env, this.platform) : null;
    const dir = own && p.isAbsolute(own) ? p.normalize(own) : p.join(this.accountsDir, provider.id, own || account.id);
    const env = { [provider.homeVar]: dir };
    for (const [key, value] of Object.entries(provider.accountEnv)) env[key] = value.replaceAll('{dir}', dir);
    return { id: account.id, label: account.label, dir, env };
  }

  accountsFor(provider) {
    return provider.accounts.map((account) => this.accountFor(provider, account));
  }

  account(provider, id = null) {
    const wanted = id === null || id === undefined || id === '' ? DEFAULT_ACCOUNT : String(id);
    const found = provider.accounts.find((a) => a.id === wanted);
    if (!found) throw refusal(404, 'unknown_account', `${provider.tool} has no account "${wanted}"`);
    return this.accountFor(provider, found);
  }

  commandFor(provider) {
    return provider.command === '@shell' ? defaultShell(this.env, this.platform) : provider.command;
  }

  resolve(provider) {
    return resolveCommand(this.commandFor(provider), { ...this.env, ...provider.env }, this.platform);
  }

  resolveNpm() {
    return resolveCommand('npm', this.env, this.platform);
  }

  iconUrl(provider) {
    if (provider.icon) return provider.icon;
    if (this.iconDir && fs.existsSync(path.join(this.iconDir, `${provider.id}.svg`))) {
      return `/icons/${provider.id}.svg`;
    }
    return null;
  }

  /** Public description, including whether the tool is installed. */
  describe(provider) {
    const resolvedPath = this.resolve(provider);
    const versions = this.versions.get(provider.id);
    const installed = resolvedPath ? versions?.installed ?? null : null;
    const latest = versions?.latest ?? null;
    const channel = this.channelFor(provider, resolvedPath);
    const update = this.updateFor(provider, channel);
    const installs = this.installsFor(provider, resolvedPath).map((install) => {
      const active = install.resolvedPath === resolvedPath;
      const copy = active ? { version: installed, status: versions?.versionStatus ?? null } : versions?.copies?.[install.resolvedPath];
      return {
        path: install.resolvedPath,
        channel: install.channel,
        version: copy?.version ?? null,
        versionStatus: copy?.status ?? null,
        active,
        onPath: install.onPath,
        removeCommand: install.removeCommand,
      };
    });
    const inUse = installs.find((i) => i.active)?.version;
    for (const install of installs) {
      install.newer = Boolean(!install.active && inUse && install.version && compareVersions(install.version, inUse) > 0);
    }
    return {
      id: provider.id,
      vendor: provider.vendor,
      tool: provider.tool,
      command: this.commandFor(provider),
      package: provider.package,
      args: provider.args,
      resumable: provider.resumeArgs.length > 0,
      installable: Boolean(provider.package && this.resolveNpm()),
      installedVersion: installed,
      versionStatus: resolvedPath ? versions?.versionStatus ?? null : null,
      versionError: resolvedPath ? versions?.versionError ?? null : null,
      latestVersion: latest,
      updateAvailable: Boolean(installed && latest && compareVersions(latest, installed) > 0),
      installChannel: channel?.channel ?? null,
      updateCommand: update.command,
      updateGuidance: update.guidance,
      lastInstall: versions?.lastInstall ?? null,
      installs,
      warnings: this.installWarnings(provider, installs),
      npmNote: provider.npmNote,
      usageSource: provider.usage === null ? null : typeof provider.usage === 'string' ? provider.usage : 'command',
      historySource: provider.history === null ? null : typeof provider.history === 'string' ? provider.history : 'command',
      reporting: provider.reporting,
      accounts: provider.accounts.map((account) => {
        const reportingEnabled = this.reportingEnabled?.(provider, this.accountFor(provider, account)) ?? null;
        return { id: account.id, label: account.label, ...(reportingEnabled === null ? {} : { reportingEnabled }) };
      }),
      modelPattern: provider.modelPattern,
      color: provider.color,
      monogram: provider.monogram,
      iconUrl: this.iconUrl(provider),
      install: provider.install,
      docs: provider.docs,
      usageUrl: provider.usageUrl,
      billingUrl: provider.billingUrl,
      available: Boolean(resolvedPath),
      resolvedPath,
    };
  }

  list() {
    return this.providers.map((p) => this.describe(p));
  }

  /** Spawn spec for node-pty, or throws with a user-facing message. */
  spawnSpec(provider, extraArgs = [], resume = null, leadArgs = []) {
    const resolved = this.resolve(provider);
    if (!resolved) {
      const hint = provider.install ? ` ${provider.install}` : '';
      const err = new Error(`${provider.tool} ("${this.commandFor(provider)}") was not found on PATH.${hint}`);
      err.status = 409;
      err.code = 'provider_unavailable';
      throw err;
    }
    let resumeArgs = [];
    if (resume !== null) {
      if (provider.resumeArgs.length === 0) {
        const err = new Error(`${provider.tool} has no resumeArgs configured, so an existing session cannot be resumed`);
        err.status = 400;
        err.code = 'resume_unsupported';
        throw err;
      }
      resumeArgs = provider.resumeArgs.map((arg) => arg.replaceAll('{id}', resume));
    }
    return buildSpawnSpec(resolved, [...leadArgs, ...provider.args, ...resumeArgs, ...extraArgs], this.env, this.platform);
  }

  async updateSpec(provider) {
    const channel = this.channelFor(provider);
    const update = this.updateFor(provider, channel);
    if (!update.command) {
      throw refusal(400, 'not_updatable', update.guidance || `Still checking how ${provider.tool} was installed. Try again in a moment.`);
    }
    const args = channel.update.package
      ? this.npmArgs(channel.update, await this.resolveRelease(provider, update.file))
      : update.args;
    return { spec: buildSpawnSpec(update.file, args, this.env, this.platform), channel: channel.channel };
  }

  async installSpec(provider) {
    if (!provider.package) {
      const err = new Error(`${provider.tool} has no npm package configured; install it by hand: ${provider.install || provider.docs || 'see its documentation'}`);
      err.status = 400;
      err.code = 'not_installable';
      throw err;
    }
    const npm = this.resolveNpm();
    if (!npm) {
      const err = new Error('npm was not found on PATH. Install Node.js from https://nodejs.org and restart the session manager.');
      err.status = 409;
      err.code = 'npm_unavailable';
      throw err;
    }
    const version = await this.resolveRelease(provider, npm);
    return buildSpawnSpec(npm, this.npmArgs({ args: ['install', '-g'], package: provider.package }, version), this.env, this.platform);
  }
}

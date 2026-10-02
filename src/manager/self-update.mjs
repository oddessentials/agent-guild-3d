// The manager's own version against the npm registry, and the npm session
// that upgrades it. The running process keeps its code after an upgrade:
// the new version is used once the manager is restarted.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { compareVersions, fetchManifest } from './versions.mjs';
import { formatCommand } from './install-channels.mjs';
import { buildSpawnSpec } from './command-resolver.mjs';

const CHECK_TTL_MS = 60 * 60 * 1000;
const FAILED_CHECK_TTL_MS = 5 * 60 * 1000;

/** Shown as the provider of the upgrade session. */
export const SELF_PROVIDER = Object.freeze({
  id: 'agent-guild',
  vendor: 'Agent Guild',
  tool: 'Agent Guild',
  color: '#5B5BD6',
  monogram: 'AG',
  iconUrl: null,
  modelPattern: null,
  env: {},
});

/** True for a build that is not a published release, such as a git checkout. */
export function isDevelopmentBuild(version) {
  return !version || /^0\.0\.0(?:-|$)/.test(String(version));
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class SelfUpdate extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.pkg            the manager's npm package name
   * @param {string} opts.version        the running version
   * @param {string|null} [opts.packageFile]  the package.json the manager runs from; read again after an install
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry  for the registry URL, npm, and fetch
   */
  constructor({ pkg, version, packageFile = null, registry }) {
    super();
    this.pkg = pkg;
    this.version = version;
    this.packageFile = packageFile;
    this.registry = registry;
    this.latest = null;
    this.error = null;
    this.checkedAt = 0;
    this.lastInstall = null;
    /** True from the start of an upgrade session until its npm process has exited. */
    this.installing = false;
    /** The on-disk version a failed upgrade left behind, not to be trusted until an upgrade completes. */
    this.suspectVersion = null;
    this._refreshing = null;
  }

  /** Ask the registry for the latest release, hourly unless `force`. Emits "updated" on a change. */
  refresh({ force = false } = {}) {
    const run = () => this._refresh(force);
    const pending = this._refreshing ? this._refreshing.then(run, run) : run();
    this._refreshing = pending;
    pending.finally(() => { if (this._refreshing === pending) this._refreshing = null; }).catch(() => {});
    return pending;
  }

  async _refresh(force) {
    if (!this.registry.checkUpdates || isDevelopmentBuild(this.version)) return;
    const now = Date.now();
    const ttl = this.error ? FAILED_CHECK_TTL_MS : CHECK_TTL_MS;
    if (!force && now - this.checkedAt < ttl) return;
    this.checkedAt = now;
    const registryUrl = await this.registry.npmRegistryUrl();
    const { manifest, error } = await fetchManifest(this.pkg, 'latest', { registryUrl, fetchImpl: this.registry.fetchImpl });
    // A failed check keeps the release already known; it is still published.
    const latest = manifest?.version ?? this.latest;
    const changed = latest !== this.latest || error !== this.error;
    this.latest = latest;
    this.error = error;
    if (changed) this.emit('updated');
  }

  /** Forget an upgrade's outcome once a newer release or a different install supersedes it. */
  _pruneLastInstall(installed) {
    const last = this.lastInstall;
    if (last && (last.version !== this.latest || last.installedVersion !== installed)) this.lastInstall = null;
  }

  /** The version of the package files on disk, or null when unreadable (for example mid-install). */
  installedVersion() {
    if (!this.packageFile) return null;
    try {
      const version = JSON.parse(fs.readFileSync(this.packageFile, 'utf8')).version;
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * True while the files on disk are what an upgrade that did not finish
   * left behind: npm may have replaced package.json before it was stopped.
   * Kept apart from `lastInstall`, which a newer release supersedes; the
   * files stay suspect until an upgrade completes or they change again.
   */
  _diskSuspect(installed) {
    return this.suspectVersion !== null && installed === this.suspectVersion;
  }

  /** A version installed on disk that the running manager does not use yet, or null. */
  pendingVersion(installed = this.installedVersion()) {
    if (this._diskSuspect(installed)) return null;
    return installed && installed !== this.version && compareVersions(installed, this.version) > 0 ? installed : null;
  }

  /** True when the latest release is newer than the running manager and not yet, or not reliably, on disk. */
  available(installed = this.installedVersion()) {
    if (!this.latest || compareVersions(this.latest, this.version) <= 0) return false;
    return this._diskSuspect(installed) || compareVersions(this.latest, installed || this.version) > 0;
  }

  args() {
    return this.registry.npmArgs({ args: ['install', '-g'], package: this.pkg }, this.latest);
  }

  /** The npm command that performs the upgrade, or null without npm on PATH or a known release. */
  command() {
    const npm = this.registry.resolveNpm();
    return npm && this.latest ? formatCommand(npm, this.args()) : null;
  }

  /** Public description, sent in `/info`, `hello` and `manager.upgrade`. */
  describe() {
    // While npm runs, the files on disk are in flux: package.json may already
    // be new while dependencies are still being written, so nothing is
    // offered or announced until the process has exited.
    if (this.installing) {
      return {
        version: this.version, latestVersion: this.latest, available: false, command: null, guidance: null,
        pendingVersion: null, installing: true, lastInstall: null,
      };
    }
    const installed = this.installedVersion();
    this._pruneLastInstall(installed);
    const available = this.available(installed);
    const command = available ? this.command() : null;
    return {
      version: this.version,
      latestVersion: this.latest,
      available,
      command,
      guidance: available && !command ? `npm was not found on PATH. Install Node.js from https://nodejs.org, then run: npm install -g ${this.pkg}@${this.latest}` : null,
      pendingVersion: this.pendingVersion(installed),
      installing: false,
      lastInstall: this.lastInstall,
    };
  }

  /** Spawn spec for the upgrade session and the version it installs, or throws with a user-facing message. */
  async spec() {
    if (this.installing) throw refusal(409, 'upgrade_in_progress', 'Agent Guild is already being upgraded');
    if (isDevelopmentBuild(this.version)) {
      throw refusal(400, 'not_updatable', `This is a development build of Agent Guild (${this.version}); it is not upgraded from the registry.`);
    }
    if (!this.registry.checkUpdates) {
      throw refusal(400, 'not_updatable', 'Version checks are off (AGENT_GUILD_NO_UPDATE_CHECK), so Agent Guild cannot upgrade itself.');
    }
    await this.refresh();
    const installed = this.installedVersion();
    this._pruneLastInstall(installed);
    if (!this.available(installed)) {
      throw refusal(400, 'not_updatable', this.latest
        ? `Agent Guild ${this.latest} is the latest release${this.pendingVersion(installed) ? ' and is installed; restart the manager to use it' : ''}.`
        : `Could not read the latest Agent Guild release${this.error ? `: ${this.error}` : ''}. Nothing was changed.`);
    }
    const npm = this.registry.resolveNpm();
    if (!npm) {
      throw refusal(409, 'npm_unavailable', 'npm was not found on PATH. Install Node.js from https://nodejs.org and restart the session manager.');
    }
    // buildSpawnSpec wraps npm.cmd in cmd.exe on Windows, which a PTY needs.
    return { spec: buildSpawnSpec(npm, this.args(), this.registry.env, this.registry.platform), version: this.latest };
  }

  /** An upgrade session started; hold the lock until finishInstall. Emits "updated". */
  beginInstall() {
    this.installing = true;
    this.emit('updated');
  }

  /** Record how the upgrade session ended, once its process has exited. The files on disk say whether the running copy was replaced. */
  finishInstall({ exitCode = null, version = this.latest } = {}) {
    this.installing = false;
    const installed = this.installedVersion();
    let outcome;
    if (exitCode !== 0) outcome = 'failed';
    else if (installed && version && compareVersions(installed, version) >= 0) outcome = 'installed';
    else outcome = 'unchanged';
    if (outcome === 'failed') this.suspectVersion = installed;
    else if (outcome === 'installed') this.suspectVersion = null;
    this.lastInstall = { outcome, exitCode, version, installedVersion: installed, at: Date.now() };
    this.emit('updated');
  }
}

// Agent Guild owns every piece of GitHub state in <data>/github: tokens, keys,
// GitHub's host keys and the SSH and Git configuration a clone runs with. The
// user's own ~/.ssh and Git configuration are never read or written.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { USER_AGENT } from './news.mjs';

export const GITHUB_CLIENT_ID = 'Ov23lif6qqYKtXZTb130';
export const GITHUB_SCOPES = ['repo', 'write:public_key'];
const API_URL = 'https://api.github.com';
const WEB_URL = 'https://github.com';
const SSH_HOST = 'git@github.com';

/** GitHub's published SSH host keys (docs: "GitHub's SSH key fingerprints"). */
export const GITHUB_HOST_KEYS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
];

export const GITHUB_PROVIDER = Object.freeze({
  id: 'github',
  vendor: 'GitHub',
  tool: 'Git',
  color: '#24292f',
  monogram: 'GH',
  iconUrl: null,
  modelPattern: null,
  env: {},
});

const FETCH_TIMEOUT_MS = 15000;
const REPOS_TTL_MS = 5 * 60 * 1000;
const MAX_REPO_PAGES = 10;
const REFRESH_MARGIN_MS = 60 * 1000;
const MAX_AVATAR_BYTES = 100 * 1024;
const SSH_TIMEOUT_MS = 30000;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const ACCOUNT_ID_RE = /^[1-9]\d{0,15}$/;
const GREETING = /Hi ([^!\s]+)! You've successfully authenticated/;
const KEY_FAILURES = new Set(['ssh_key_manual', 'ssh_wrong_account', 'ssh_host_key', 'ssh_key_in_use', 'ssh_key_failed', 'ssh_unavailable', 'ssh_path_unsupported']);

/** Every inherited GIT_* variable is dropped: several (GIT_DIR, GIT_COMMON_DIR, GIT_SSH_COMMAND, ...) redirect a clone. */
export function dropsFromCloneEnv(key) {
  return key.toUpperCase().startsWith('GIT_');
}

function refusal(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

export function parseRepo(value) {
  const match = REPO_RE.exec(String(value ?? '').trim());
  if (!match || match[2] === '.' || match[2] === '..' || match[2].endsWith('.git')) {
    throw refusal(400, 'bad_repo', 'repo must be a GitHub repository written as owner/name');
  }
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

export function sshUrl(fullName) {
  return `${SSH_HOST}:${fullName}.git`;
}

export function remoteRepo(url) {
  const text = String(url ?? '').trim();
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(text);
  return match ? match[1].toLowerCase() : null;
}

export function originUrl(configText) {
  let inOrigin = false;
  for (const raw of String(configText).split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*([^\]\s"]+)(?:\s+"([^"]*)")?\s*\]/.exec(line);
    if (section) {
      inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin';
      continue;
    }
    const entry = inOrigin && /^url\s*=\s*(.*)$/i.exec(line);
    if (entry) return entry[1].replace(/^"(.*)"$/, '$1');
  }
  return null;
}

/** `absent` also covers an empty folder, which git clones into. */
export function localState(target, fullName) {
  let stat;
  try { stat = fs.statSync(target); } catch { return 'absent'; }
  if (!stat.isDirectory()) return 'conflict';
  try {
    if (fs.readdirSync(target).length === 0) return 'absent';
    const url = originUrl(fs.readFileSync(path.join(target, '.git', 'config'), 'utf8'));
    return remoteRepo(url) === fullName.toLowerCase() ? 'cloned' : 'conflict';
  } catch {
    return 'conflict';
  }
}

/** Quote one word for the POSIX shell Git runs core.sshCommand with (Git for Windows ships one too). */
export function shellQuote(word) {
  return `'${String(word).replaceAll('\'', '\'\\\'\'')}'`;
}

/** Paths for OpenSSH: forward slashes on Windows, where both Win32-OpenSSH and Git's ssh accept them. */
export function sshPath(file, platform = process.platform) {
  return platform === 'win32' ? file.replaceAll('\\', '/') : file;
}

/**
 * An -o value naming a file: quoted for OpenSSH's own word splitting, with its
 * %-tokens escaped. OpenSSH also expands ${VAR} and offers no escape for it.
 * The key goes through -o IdentityFile, not -i, because -i checks the raw
 * path before the tokens are expanded.
 */
function sshFileOption(name, file, platform) {
  const value = sshPath(file, platform);
  if (value.includes('${')) throw refusal(409, 'ssh_path_unsupported', `OpenSSH cannot use a path containing "\${": ${value}. Move the Agent Guild data folder with AGENT_GUILD_HOME.`);
  return `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

export function sshArgs({ key, knownHosts, config, platform = process.platform }) {
  return [
    '-F', sshPath(config, platform),
    '-o', sshFileOption('IdentityFile', key, platform),
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'GlobalKnownHostsFile=none',
    '-o', sshFileOption('UserKnownHostsFile', knownHosts, platform),
  ];
}

export function sshCommand({ ssh, platform = process.platform, ...files }) {
  return [sshPath(ssh, platform), ...sshArgs({ ...files, platform })].map(shellQuote).join(' ');
}

function keyBlob(line) {
  const [type, blob] = String(line ?? '').trim().split(/\s+/);
  return type && blob ? `${type} ${blob}` : null;
}

export function nextLink(header) {
  for (const part of String(header ?? '').split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match) return match[1];
  }
  return null;
}

export function cleanRepo(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.full_name !== 'string') return null;
  let repo;
  try { repo = parseRepo(raw.full_name); } catch { return null; }
  const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  const time = (value) => (Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);
  return {
    fullName: repo.fullName,
    owner: repo.owner,
    ownerType: raw.owner?.type === 'Organization' ? 'Organization' : 'User',
    name: repo.name,
    private: raw.private === true,
    fork: raw.fork === true,
    archived: raw.archived === true,
    description: text(raw.description, 300),
    language: text(raw.language, 40),
    pushedAt: time(raw.pushed_at),
    url: `${WEB_URL}/${repo.fullName}`,
  };
}

export function parseScopes(value) {
  return String(value ?? '').split(/[\s,]+/).filter(Boolean);
}

function canWriteKeys(scopes) {
  return scopes.includes('write:public_key') || scopes.includes('admin:public_key');
}

function writeAtomic(file, contents) {
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, contents, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function writeIfChanged(file, contents) {
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* written below */ }
  if (current !== contents) writeAtomic(file, contents);
}

/** A device-flow or token endpoint answers with an `error` field whatever its status. */
async function oauthJson(res) {
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== 'object') throw new Error(`GitHub answered HTTP ${res.status}`);
  return body;
}

function failure(err) {
  if (err?.name === 'TimeoutError') return 'GitHub did not answer in time';
  if (err?.status) return err.message;
  return `GitHub could not be reached (${err?.cause?.code || err?.message || 'unknown error'})`;
}

export class GitHub extends EventEmitter {
  constructor({
    dir, registry, clientId = GITHUB_CLIENT_ID, apiUrl = API_URL, webUrl = WEB_URL,
    fetchImpl = (...args) => fetch(...args), run = runSpec, hostname = os.hostname(), timeoutMs = FETCH_TIMEOUT_MS,
  }) {
    super();
    this.dir = dir;
    this.registry = registry;
    this.clientId = clientId;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.webUrl = webUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.run = run;
    this.hostname = hostname;
    this.timeoutMs = timeoutMs;
    this.signIn = null;
    this._signInTimer = null;
    this._signInGeneration = 0;
    this._refreshes = new Map();
    this._setups = new Map();
    this._sshErrors = new Map();
    this._repos = new Map();
    this.accounts = this._load();
  }

  get file() { return path.join(this.dir, 'accounts.json'); }
  get keysDir() { return path.join(this.dir, 'keys'); }
  get knownHostsFile() { return path.join(this.dir, 'known_hosts'); }
  get sshConfigFile() { return path.join(this.dir, 'ssh_config'); }
  get gitConfigFile() { return path.join(this.dir, 'clone.gitconfig'); }

  keyFile(id) { return path.join(this.keysDir, `agent-guild-github-${id}`); }

  _load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    try {
      const list = JSON.parse(raw)?.accounts;
      const valid = Array.isArray(list) ? list.filter((a) => Number.isSafeInteger(a?.id) && typeof a.login === 'string' && a.token?.access) : [];
      return [...new Map(valid.map((a) => [a.id, a])).values()];
    } catch (err) {
      console.warn(`[github] ${this.file} could not be read (${err.message}); starting without GitHub accounts`);
      return [];
    }
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.file, JSON.stringify({ accounts: this.accounts }, null, 2) + '\n');
  }

  _changed() {
    this.emit('updated');
  }

  close() {
    this._stopPolling();
  }

  _resolve(command) {
    return resolveCommand(command, this.registry.env, this.registry.platform);
  }

  /** ssh, and the ssh-keygen beside it when there is one, so a key is made and used by the same OpenSSH. */
  tools() {
    const ssh = this._resolve('ssh');
    const exe = this.registry.platform === 'win32' && ssh && path.win32.extname(ssh).toLowerCase() === '.exe' ? '.exe' : '';
    const sibling = ssh ? path.join(path.dirname(ssh), `ssh-keygen${exe}`) : null;
    const sshKeygen = sibling && fs.existsSync(sibling) ? sibling : this._resolve('ssh-keygen');
    return { git: this._resolve('git'), ssh, sshKeygen };
  }

  account(id) {
    const wanted = String(id ?? '');
    const found = ACCOUNT_ID_RE.test(wanted) ? this.accounts.find((a) => a.id === Number(wanted)) : null;
    if (!found) throw refusal(404, 'unknown_account', `no GitHub account with id "${wanted}" is signed in`);
    return found;
  }

  describeAccount(account) {
    const key = this.keyFile(account.id);
    let publicKey = null;
    try { publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim(); } catch { /* none yet */ }
    const hasKey = Boolean(publicKey) && fs.existsSync(key);
    const error = this._sshErrors.get(account.id) ?? null;
    return {
      id: account.id,
      login: account.login,
      name: account.name ?? null,
      avatar: account.avatar ?? null,
      scopes: account.scopes ?? [],
      needsSignIn: account.needsSignIn === true,
      addedAt: account.addedAt,
      ssh: {
        status: !hasKey ? 'none' : account.ssh?.verifiedAt ? 'ready' : 'unverified',
        key: hasKey ? key : null,
        publicKey: hasKey ? publicKey : null,
        verifiedAt: hasKey ? account.ssh?.verifiedAt ?? null : null,
        settingUp: this._setups.has(account.id),
        error,
      },
    };
  }

  snapshot() {
    const tools = this.tools();
    return {
      scopes: GITHUB_SCOPES,
      appUrl: `${this.webUrl}/settings/connections/applications/${this.clientId}`,
      keysUrl: `${this.webUrl}/settings/keys`,
      newKeyUrl: `${this.webUrl}/settings/ssh/new`,
      tools: { git: Boolean(tools.git), ssh: Boolean(tools.ssh), sshKeygen: Boolean(tools.sshKeygen) },
      signIn: this.signIn && {
        status: this.signIn.status,
        userCode: this.signIn.userCode ?? null,
        verificationUri: this.signIn.verificationUri ?? null,
        expiresAt: this.signIn.expiresAt ?? null,
        accountId: this.signIn.accountId ?? null,
        again: this.signIn.again === true,
        error: this.signIn.error ?? null,
      },
      accounts: this.accounts.map((a) => this.describeAccount(a)),
    };
  }

  _fetch(url, init = {}) {
    return this.fetchImpl(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...init.headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  _oauth(route, params) {
    return this._fetch(`${this.webUrl}${route}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, ...params }).toString(),
    }).then(oauthJson);
  }

  _plain(route, token, init = {}) {
    const url = /^https?:/.test(route) ? route : `${this.apiUrl}${route}`;
    return this._fetch(url, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  }

  async _api(account, route, init = {}) {
    const send = (token) => this._plain(route, token, init).catch((err) => {
      throw refusal(502, 'github_unreachable', failure(err));
    });
    const used = await this._accessToken(account);
    let res = await send(used);
    if (res.status === 401 && account.token.refresh) {
      res = await send(await this._accessToken(account, { stale: used }));
    }
    if (res.status === 401) {
      this._needsSignIn(account);
      throw refusal(409, 'github_sign_in', `GitHub no longer accepts the sign-in for @${account.login}. Sign in again.`);
    }
    if (res.headers.has('x-oauth-scopes')) {
      const scopes = parseScopes(res.headers.get('x-oauth-scopes'));
      if (scopes.join(' ') !== (account.scopes ?? []).join(' ')) {
        account.scopes = scopes;
        this._save();
        this._changed();
      }
    }
    return res;
  }

  async _apiJson(account, route, init) {
    const res = await this._api(account, route, init);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const limited = (res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0';
      throw refusal(502, 'github_error', limited ? 'GitHub API rate limit exceeded; try again later' : `GitHub answered HTTP ${res.status}${body?.message ? `: ${body.message}` : ''}`, { github: res.status });
    }
    return { body: await res.json(), res };
  }

  _needsSignIn(account) {
    if (account.needsSignIn) return;
    account.needsSignIn = true;
    this._save();
    this._changed();
  }

  /**
   * The account's access token. An expiring token is refreshed shortly
   * before it runs out. GitHub rotates the refresh token on every use, so
   * concurrent callers share one refresh, and the new pair is saved before
   * anyone uses it.
   */
  _accessToken(account, { stale = null } = {}) {
    if (this._refreshes.has(account.id)) return this._refreshes.get(account.id);
    if (account.needsSignIn) {
      return Promise.reject(refusal(409, 'github_sign_in', `GitHub no longer accepts the sign-in for @${account.login}. Sign in again.`));
    }
    const { token } = account;
    const due = token.expiresAt && Date.parse(token.expiresAt) - REFRESH_MARGIN_MS <= Date.now();
    // A token refused by GitHub is refreshed only if nobody has replaced it since.
    if (stale !== null ? token.access !== stale : !due) return Promise.resolve(token.access);
    const pending = this._refresh(account).finally(() => this._refreshes.delete(account.id));
    this._refreshes.set(account.id, pending);
    return pending;
  }

  async _refresh(account) {
    if (!account.token.refresh) {
      this._needsSignIn(account);
      throw refusal(409, 'github_sign_in', `GitHub no longer accepts the sign-in for @${account.login}. Sign in again.`);
    }
    const body = await this._oauth('/login/oauth/access_token', { grant_type: 'refresh_token', refresh_token: account.token.refresh }).catch((err) => {
      throw refusal(502, 'github_unreachable', failure(err));
    });
    if (!body.access_token) {
      this._needsSignIn(account);
      throw refusal(409, 'github_sign_in', `GitHub no longer accepts the sign-in for @${account.login} (${body.error || 'refresh refused'}). Sign in again.`);
    }
    account.token = tokenFrom(body, account.token);
    this._save();
    return account.token.access;
  }

  _stopPolling() {
    clearTimeout(this._signInTimer);
    this._signInTimer = null;
    this._signInGeneration++;
  }

  async startSignIn() {
    this._stopPolling();
    if (this.signIn) {
      this.signIn = null;
      this._changed();
    }
    const generation = this._signInGeneration;
    let body;
    try {
      body = await this._oauth('/login/device/code', { scope: GITHUB_SCOPES.join(' ') });
    } catch (err) {
      throw refusal(502, 'github_unreachable', `Could not start the GitHub sign-in: ${failure(err)}`);
    }
    if (!body.device_code || !body.user_code) {
      throw refusal(502, 'github_error', `GitHub refused the sign-in: ${body.error_description || body.error || 'no device code'}`);
    }
    let verificationUri = null;
    try {
      const url = new URL(body.verification_uri);
      if (url.protocol === 'https:' || url.origin === new URL(this.webUrl).origin) verificationUri = url.href;
    } catch { /* refused below */ }
    if (!verificationUri) throw refusal(502, 'github_error', 'GitHub sent no sign-in page to visit');
    if (generation !== this._signInGeneration) return this.snapshot();
    this.signIn = {
      status: 'pending',
      deviceCode: body.device_code,
      userCode: String(body.user_code),
      verificationUri,
      expiresAt: new Date(Date.now() + (Number(body.expires_in) || 900) * 1000).toISOString(),
      interval: Math.max(1, Number(body.interval) || 5),
    };
    this._schedulePoll(generation);
    this._changed();
    return this.snapshot();
  }

  cancelSignIn() {
    this._stopPolling();
    this.signIn = null;
    this._changed();
    return this.snapshot();
  }

  _schedulePoll(generation) {
    this._signInTimer = setTimeout(() => this._poll(generation), this.signIn.interval * 1000);
    this._signInTimer.unref?.();
  }

  _endSignIn(fields) {
    this._stopPolling();
    const { userCode, verificationUri, expiresAt } = this.signIn;
    this.signIn = { userCode, verificationUri, expiresAt, ...fields };
    this._changed();
  }

  async _poll(generation) {
    if (generation !== this._signInGeneration || this.signIn?.status !== 'pending') return;
    if (Date.parse(this.signIn.expiresAt) <= Date.now()) return this._endSignIn({ status: 'expired' });
    let body;
    try {
      body = await this._oauth('/login/oauth/access_token', {
        device_code: this.signIn.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      if (generation === this._signInGeneration) this._schedulePoll(generation);
      return;
    }
    if (generation !== this._signInGeneration) return;
    if (body.access_token) {
      try {
        const { account, again } = await this._addAccount(body);
        if (generation === this._signInGeneration) this._endSignIn({ status: 'done', accountId: account.id, again });
        else this._changed();
      } catch (err) {
        if (generation === this._signInGeneration) this._endSignIn({ status: 'failed', error: failure(err) });
      }
      return;
    }
    if (body.error === 'authorization_pending') return this._schedulePoll(generation);
    if (body.error === 'slow_down') {
      this.signIn.interval = Math.max(this.signIn.interval + 5, Number(body.interval) || 0);
      return this._schedulePoll(generation);
    }
    if (body.error === 'expired_token' || body.error === 'token_expired') return this._endSignIn({ status: 'expired' });
    if (body.error === 'access_denied') return this._endSignIn({ status: 'denied' });
    this._endSignIn({ status: 'failed', error: body.error_description || body.error || 'GitHub refused the sign-in' });
  }

  /** Accounts are keyed by GitHub's immutable user id; the login is only shown. */
  async _addAccount(tokenBody) {
    const token = tokenFrom(tokenBody);
    const res = await this._plain('/user', token.access);
    if (!res.ok) throw refusal(502, 'github_error', `GitHub answered HTTP ${res.status} for the signed-in user`);
    const user = await res.json();
    if (!Number.isSafeInteger(user?.id) || typeof user.login !== 'string') throw refusal(502, 'github_error', 'GitHub sent no user for the sign-in');
    const scopes = res.headers.has('x-oauth-scopes') ? parseScopes(res.headers.get('x-oauth-scopes')) : parseScopes(tokenBody.scope);
    const avatar = await this._avatar(user.avatar_url).catch(() => null);
    const existing = this.accounts.find((a) => a.id === user.id);
    const fields = { login: user.login, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0, 100) : null, avatar: avatar ?? existing?.avatar ?? null, scopes, token, needsSignIn: false };
    let account;
    if (existing) {
      account = Object.assign(existing, fields);
    } else {
      account = { id: user.id, ...fields, addedAt: new Date().toISOString(), ssh: { verifiedAt: null } };
      this.accounts.push(account);
    }
    this._repos.delete(account.id);
    this._save();
    return { account, again: Boolean(existing) };
  }

  async _avatar(url) {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
    const sized = new URL(url);
    sized.searchParams.set('s', '64');
    const res = await this._fetch(sized.href);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length <= MAX_AVATAR_BYTES ? `data:${type};base64,${bytes.toString('base64')}` : null;
  }

  signOut(id) {
    const account = this.account(id);
    this.accounts = this.accounts.filter((a) => a !== account);
    this._repos.delete(account.id);
    this._sshErrors.delete(account.id);
    this._save();
    this._changed();
    return this.snapshot();
  }

  async repos(id, { parent = null, refresh = false } = {}) {
    const account = this.account(id);
    let cached = this._repos.get(account.id);
    if (refresh || !cached?.repos || Date.now() - cached.at > REPOS_TTL_MS) {
      if (!cached?.loading) {
        const loading = this._loadRepos(account).then((loaded) => {
          if (this._repos.get(account.id)?.loading === loading) this._repos.set(account.id, loaded);
          return loaded;
        }, (err) => {
          if (this._repos.get(account.id)?.loading === loading) this._repos.delete(account.id);
          throw err;
        });
        this._repos.set(account.id, { ...cached, loading });
      }
      cached = await this._repos.get(account.id).loading;
    }
    const orgs = new Map();
    for (const repo of cached.repos) if (repo.ownerType === 'Organization') orgs.set(repo.owner.toLowerCase(), repo.owner);
    return {
      accountId: account.id,
      fetchedAt: new Date(cached.at).toISOString(),
      truncated: cached.truncated,
      owners: [account.login, ...[...orgs.values()].sort((a, b) => a.localeCompare(b))],
      parent,
      repos: cached.repos.map((repo) => {
        const target = parent ? path.join(parent, repo.name) : null;
        return { ...repo, target, local: target ? localState(target, repo.fullName) : null };
      }),
    };
  }

  async _loadRepos(account) {
    const seen = new Map();
    let url = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
    let pages = 0;
    try {
      while (url && pages < MAX_REPO_PAGES) {
        const { body, res } = await this._apiJson(account, url);
        for (const raw of Array.isArray(body) ? body : []) {
          const repo = cleanRepo(raw);
          if (repo && !seen.has(repo.fullName.toLowerCase())) seen.set(repo.fullName.toLowerCase(), repo);
        }
        url = nextLink(res.headers.get('link'));
        pages++;
      }
    } catch (err) {
      if (err.status) throw err;
      throw refusal(502, 'github_unreachable', `Could not list repositories: ${failure(err)}`);
    }
    const repos = [...seen.values()].sort((a, b) => (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0));
    return { repos, truncated: Boolean(url), at: Date.now() };
  }

  async createRepo(id, { owner, name, description = null, private: isPrivate = true, readme = true } = {}) {
    const account = this.account(id);
    const { fullName } = parseRepo(`${owner ?? ''}/${name ?? ''}`);
    const repoOwner = fullName.split('/')[0];
    if (description !== null && typeof description !== 'string') throw refusal(400, 'bad_description', 'description must be a string');
    const personal = repoOwner.toLowerCase() === account.login.toLowerCase();
    const route = personal ? '/user/repos' : `/orgs/${encodeURIComponent(repoOwner)}/repos`;
    const res = await this._api(account, route, {
      method: 'POST',
      body: JSON.stringify({
        name: fullName.split('/')[1],
        description: description?.trim().slice(0, 350) || undefined,
        private: isPrivate !== false,
        auto_init: readme !== false,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const detail = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : [])].filter(Boolean).join(' ');
      if (res.status === 422 && /already exists/i.test(detail)) throw refusal(409, 'repo_exists', `${fullName} already exists on GitHub`);
      if (res.status === 403 || res.status === 404) {
        throw refusal(403, 'repo_forbidden', `GitHub did not let @${account.login} create repositories in ${repoOwner}${detail ? `: ${detail}` : ''}`);
      }
      throw refusal(502, 'github_error', `GitHub answered HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    const repo = cleanRepo(await res.json());
    if (!repo) throw refusal(502, 'github_error', 'GitHub did not describe the new repository');
    const cached = this._repos.get(account.id);
    if (cached?.repos) {
      this._repos.set(account.id, { ...cached, repos: [repo, ...cached.repos.filter((r) => r.fullName.toLowerCase() !== repo.fullName.toLowerCase())] });
    }
    return repo;
  }

  _ensureFiles() {
    fs.mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    writeIfChanged(this.knownHostsFile, GITHUB_HOST_KEYS.join('\n') + '\n');
    writeIfChanged(this.sshConfigFile, '');
    writeIfChanged(this.gitConfigFile, gitConfig({ lfs: Boolean(this._resolve('git-lfs')), platform: this.registry.platform }));
  }

  setupSsh(id) {
    const account = this.account(id);
    if (!this._setups.has(account.id)) {
      const pending = this._setupSsh(account).finally(() => {
        this._setups.delete(account.id);
        this._changed();
      });
      this._setups.set(account.id, pending);
      this._changed();
    }
    return this._setups.get(account.id).then(() => this.describeAccount(account));
  }

  async _setupSsh(account) {
    try {
      const { ssh, sshKeygen } = this.tools();
      if (!ssh || !sshKeygen) {
        throw refusal(409, 'ssh_unavailable', 'OpenSSH (ssh and ssh-keygen) was not found on PATH.');
      }
      this._ensureFiles();
      await this._refreshUser(account);
      const key = this.keyFile(account.id);
      if (!fs.existsSync(key) || !fs.existsSync(`${key}.pub`)) await this._makeKey(sshKeygen, key, account);
      const publicKey = fs.readFileSync(`${key}.pub`, 'utf8').trim();
      const { problem } = await this._addKey(account, publicKey);
      const login = await this._testKey(ssh, key, problem);
      if (login.toLowerCase() !== account.login.toLowerCase()) {
        throw refusal(409, 'ssh_wrong_account', `GitHub signs this key in as ${login}, not @${account.login}. Remove it from ${login}'s SSH keys on GitHub, then check again.`);
      }
      account.ssh = { verifiedAt: new Date().toISOString() };
      this._sshErrors.delete(account.id);
      this._save();
    } catch (err) {
      if (account.ssh?.verifiedAt && KEY_FAILURES.has(err.code)) {
        account.ssh = { verifiedAt: null };
        this._save();
      }
      this._sshErrors.set(account.id, { code: err.code || 'ssh_failed', message: err.status ? err.message : `SSH setup failed: ${err.message}`, manual: err.manual === true });
      if (!err.status) throw err;
    }
  }

  async _refreshUser(account) {
    const { body } = await this._apiJson(account, '/user');
    if (body?.id === account.id && typeof body.login === 'string' && body.login !== account.login) {
      account.login = body.login;
      this._save();
    }
  }

  /** Ed25519, or RSA when this ssh-keygen cannot make Ed25519. Never overwrites: the files are known to be absent. */
  async _makeKey(sshKeygen, key, account) {
    for (const file of [key, `${key}.pub`]) fs.rmSync(file, { force: true });
    const comment = `agent-guild github ${account.login} (${account.id})`;
    const env = this.registry.env;
    const attempt = (type) => this.run(buildSpawnSpec(sshKeygen, ['-q', '-t', ...type, '-N', '', '-C', comment, '-f', key], env, this.registry.platform), { env, timeoutMs: SSH_TIMEOUT_MS });
    try {
      await attempt(['ed25519']);
    } catch {
      for (const file of [key, `${key}.pub`]) fs.rmSync(file, { force: true });
      try {
        await attempt(['rsa', '-b', '4096']);
      } catch (err) {
        throw refusal(500, 'ssh_key_failed', `ssh-keygen could not make a key: ${String(err.stderr || err.message).trim().split('\n').pop()}`);
      }
    }
    if (!fs.existsSync(key) || !fs.existsSync(`${key}.pub`)) throw refusal(500, 'ssh_key_failed', 'ssh-keygen did not write the key');
  }

  /**
   * Add the public key to the account unless it is there. When Agent Guild
   * cannot, `problem` says why; the user may have added the key themselves,
   * so the connection test still decides.
   */
  async _addKey(account, publicKey) {
    if (!canWriteKeys(account.scopes ?? [])) return { added: false, problem: `Agent Guild may not add SSH keys to @${account.login}.` };
    const blob = keyBlob(publicKey);
    let url = '/user/keys?per_page=100';
    for (let page = 0; url && page < MAX_REPO_PAGES; page++) {
      const res = await this._api(account, url);
      if (!res.ok) return { added: false, problem: `GitHub did not list @${account.login}'s SSH keys (HTTP ${res.status}).` };
      const keys = await res.json();
      if (Array.isArray(keys) && keys.some((k) => keyBlob(k?.key) === blob)) return { added: false, problem: null };
      url = nextLink(res.headers.get('link'));
    }
    const res = await this._api(account, '/user/keys', { method: 'POST', body: JSON.stringify({ title: `Agent Guild (${this.hostname})`, key: publicKey }) });
    if (res.ok) return { added: true, problem: null };
    const body = await res.json().catch(() => null);
    const detail = [body?.message, ...(Array.isArray(body?.errors) ? body.errors.map((e) => e?.message) : [])].filter(Boolean).join(' ');
    if (res.status === 422 && /already in use/i.test(detail)) {
      throw refusal(409, 'ssh_key_in_use', 'GitHub says this key is already in use by another account or as a deploy key.');
    }
    return { added: false, problem: `GitHub did not accept the key (HTTP ${res.status}${detail ? `: ${detail}` : ''}).` };
  }

  async _testKey(ssh, key, problem = null) {
    const args = ['-T', '-o', 'ConnectTimeout=15', ...sshArgs({ key, knownHosts: this.knownHostsFile, config: this.sshConfigFile, platform: this.registry.platform }), SSH_HOST];
    let output;
    try {
      const { stdout, stderr } = await this.run(buildSpawnSpec(ssh, args, this.registry.env, this.registry.platform), { env: this.registry.env, timeoutMs: SSH_TIMEOUT_MS });
      output = `${stdout}\n${stderr}`;
    } catch (err) {
      output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
      if (!GREETING.test(output)) {
        if (/host key verification failed|remote host identification has changed|host key for .* has changed/i.test(output)) {
          throw refusal(409, 'ssh_host_key', 'GitHub\'s SSH host key does not match the one Agent Guild ships. Update Agent Guild, then check again.');
        }
        if (/permission denied/i.test(output)) {
          throw refusal(409, 'ssh_key_manual', `${problem ?? 'GitHub does not accept this key yet.'} Add the key on GitHub yourself, then check again.`, { manual: true });
        }
        const last = output.trim().split(/\r?\n/).filter(Boolean).pop();
        throw refusal(502, 'ssh_failed', `ssh could not reach GitHub: ${err.killed ? 'it did not answer in time' : last || err.message}`);
      }
    }
    const match = GREETING.exec(output);
    if (!match) throw refusal(502, 'ssh_failed', 'GitHub did not greet the key');
    return match[1];
  }

  cloneSpec({ accountId, repo, parent }) {
    const account = this.account(accountId);
    const { fullName, name } = parseRepo(repo);
    const target = path.join(parent, name);
    const state = localState(target, fullName);
    if (state === 'cloned') throw refusal(409, 'clone_exists', `${target} is already a clone of ${fullName}`, { target });
    if (state === 'conflict') throw refusal(409, 'folder_conflict', `${target} already exists and is not a clone of ${fullName}`, { target });
    const { git, ssh } = this.tools();
    if (!git) throw refusal(409, 'git_unavailable', 'git was not found on PATH. Install Git from https://git-scm.com.');
    const described = this.describeAccount(account);
    if (!ssh || described.ssh.status !== 'ready') throw refusal(409, 'ssh_not_ready', `Set up SSH for @${account.login} before cloning`);
    this._ensureFiles();
    const command = sshCommand({ ssh, key: described.ssh.key, knownHosts: this.knownHostsFile, config: this.sshConfigFile, platform: this.registry.platform });
    const args = ['clone', '--config', `core.sshCommand=${command}`, sshUrl(fullName), target];
    return {
      spawnSpec: buildSpawnSpec(git, args, this.registry.env, this.registry.platform),
      target,
      fullName,
      account,
      env: { GIT_CONFIG_GLOBAL: this.gitConfigFile, GIT_CONFIG_SYSTEM: this.gitConfigFile, GIT_TERMINAL_PROMPT: '0' },
    };
  }
}

/**
 * The only Git configuration a clone sees. It keeps what a correct checkout
 * needs from what `git lfs install` and Git for Windows would set, and nothing
 * that could redirect the clone.
 */
export function gitConfig({ lfs, platform }) {
  const lines = [];
  if (platform === 'win32') lines.push('[core]', '\tlongpaths = true');
  if (lfs) lines.push('[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true');
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function tokenFrom(body, previous = null) {
  const at = (seconds) => (Number(seconds) > 0 ? new Date(Date.now() + Number(seconds) * 1000).toISOString() : null);
  return {
    access: String(body.access_token),
    expiresAt: at(body.expires_in),
    refresh: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previous?.refresh ?? null,
    refreshExpiresAt: at(body.refresh_token_expires_in) ?? previous?.refreshExpiresAt ?? null,
  };
}

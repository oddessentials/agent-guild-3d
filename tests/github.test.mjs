import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GitHub, GITHUB_HOST_KEYS, GITHUB_SCOPES, parseRepo, remoteRepo, originUrl, localState, shellQuote, sshCommand, sshArgs,
  nextLink, cleanRepo, dropsFromCloneEnv, parseScopes, gitConfig,
} from '../src/manager/github.mjs';
import { startFakeGitHub } from './fixtures/fake-github.mjs';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-git-tools.mjs');
const win = process.platform === 'win32';
const dirs = [];
const servers = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-github-'));
  dirs.push(dir);
  return dir;
}

/** A GitHub against a fake github.com, with ssh, ssh-keygen and git on its PATH run by fake-git-tools.mjs. */
async function setup({ tools = ['ssh', 'ssh-keygen', 'git'], ...fake } = {}) {
  const github = await startFakeGitHub(fake);
  servers.push(github);
  const root = tempDir();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  for (const name of tools) fs.writeFileSync(path.join(bin, win ? `${name}.exe` : name), '', { mode: 0o755 });
  const control = path.join(root, 'control.json');
  const log = path.join(root, 'tools.log');
  const env = { PATH: bin, ...(win ? { PATHEXT: '.EXE' } : {}), FAKE_GIT_TOOLS_STATE: control, FAKE_GIT_TOOLS_LOG: log };
  const run = (spec, { env: runEnv } = {}) => new Promise((resolve, reject) => {
    const tool = path.basename(spec.file).replace(/\.exe$/i, '');
    execFile(process.execPath, [fixture, tool, ...spec.args], { env: { ...process.env, ...runEnv } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
  const hub = new GitHub({ dir: path.join(root, 'data', 'github'), registry: { env, platform: process.platform }, clientId: 'client-1', apiUrl: github.url, webUrl: github.url, run, hostname: 'test-host' });
  const updates = [];
  hub.on('updated', () => updates.push(hub.snapshot()));
  const control_ = (value) => fs.writeFileSync(control, JSON.stringify(value));
  const runs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { hub, github, root, updates, control: control_, runs };
}

async function waitFor(predicate, label, timeout = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function signIn(ctx) {
  await ctx.hub.startSignIn();
  await waitFor(() => ctx.hub.signIn?.status === 'done', 'sign-in');
  return ctx.hub.accounts.at(-1);
}

test('repository names, remotes and clone targets are recognised strictly', () => {
  assert.deepEqual(parseRepo('octo-cat/agent-guild'), { owner: 'octo-cat', name: 'agent-guild', fullName: 'octo-cat/agent-guild' });
  assert.equal(parseRepo('org/.github').name, '.github');
  for (const bad of ['', 'nope', 'a/b/c', '-x/y', 'a/..', 'a/.', 'a/b.git', 'a/b c', 'a/b;rm', '../x']) {
    assert.throws(() => parseRepo(bad), { code: 'bad_repo' }, bad);
  }
  for (const url of ['git@github.com:Octo/Repo.git', 'ssh://git@github.com/octo/repo', 'https://github.com/octo/repo.git', 'https://token@github.com/octo/repo/']) {
    assert.equal(remoteRepo(url), 'octo/repo', url);
  }
  assert.equal(remoteRepo('git@gitlab.com:octo/repo.git'), null);
  assert.equal(originUrl('[core]\n\tbare = false\n[remote "upstream"]\n\turl = x\n[remote "origin"]\n\turl = git@github.com:o/r.git\n'), 'git@github.com:o/r.git');
  assert.equal(originUrl('[remote "upstream"]\n\turl = x\n'), null);

  const parent = tempDir();
  assert.equal(localState(path.join(parent, 'missing'), 'o/r'), 'absent');
  fs.mkdirSync(path.join(parent, 'empty'));
  assert.equal(localState(path.join(parent, 'empty'), 'o/r'), 'absent');
  fs.mkdirSync(path.join(parent, 'mine', '.git'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'mine', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:O/R.git\n');
  assert.equal(localState(path.join(parent, 'mine'), 'o/r'), 'cloned');
  assert.equal(localState(path.join(parent, 'mine'), 'o/other'), 'conflict');
  fs.mkdirSync(path.join(parent, 'stuff'));
  fs.writeFileSync(path.join(parent, 'stuff', 'notes.txt'), 'x');
  assert.equal(localState(path.join(parent, 'stuff'), 'o/r'), 'conflict');
  fs.writeFileSync(path.join(parent, 'file'), 'x');
  assert.equal(localState(path.join(parent, 'file'), 'o/r'), 'conflict');
});

test('core.sshCommand is one shell-quoted value that survives spaces, apostrophes, percent signs and Windows paths', () => {
  const posix = sshCommand({ ssh: '/usr/bin/ssh', key: "/data/Jo's files/keys/agent-guild-github-7", knownHosts: '/data/Jo\'s files/known_hosts', config: '/data/a b/ssh_config', platform: 'linux' });
  assert.equal(posix, "'/usr/bin/ssh' '-F' '/data/a b/ssh_config' '-o' 'IdentityFile=\"/data/Jo'\\''s files/keys/agent-guild-github-7\"' '-o' 'IdentitiesOnly=yes' '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=yes' '-o' 'GlobalKnownHostsFile=none' '-o' 'UserKnownHostsFile=\"/data/Jo'\\''s files/known_hosts\"'");
  const windows = sshCommand({
    ssh: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    key: 'C:\\Users\\Jo Ann\\AppData\\Roaming\\AgentGuild\\github\\keys\\agent-guild-github-7',
    knownHosts: 'C:\\Users\\Jo Ann\\AppData\\Roaming\\AgentGuild\\github\\known_hosts',
    config: 'C:\\Users\\Jo Ann\\AppData\\Roaming\\AgentGuild\\github\\ssh_config',
    platform: 'win32',
  });
  assert.equal(windows, "'C:/Windows/System32/OpenSSH/ssh.exe' '-F' 'C:/Users/Jo Ann/AppData/Roaming/AgentGuild/github/ssh_config' '-o' 'IdentityFile=\"C:/Users/Jo Ann/AppData/Roaming/AgentGuild/github/keys/agent-guild-github-7\"' '-o' 'IdentitiesOnly=yes' '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=yes' '-o' 'GlobalKnownHostsFile=none' '-o' 'UserKnownHostsFile=\"C:/Users/Jo Ann/AppData/Roaming/AgentGuild/github/known_hosts\"'");
  const percent = sshArgs({ key: '/50%/k', knownHosts: '/100%/kh', config: '/c', platform: 'linux' });
  assert.ok(percent.includes('IdentityFile="/50%%/k"') && percent.includes('UserKnownHostsFile="/100%%/kh"'), 'ssh expands %-tokens in both options');
  assert.throws(() => sshArgs({ key: '/x${HOME}/k', knownHosts: '/kh', config: '/c', platform: 'linux' }), { code: 'ssh_path_unsupported' });
  assert.equal(gitConfig({ lfs: false, platform: 'linux' }), '');
  assert.equal(gitConfig({ lfs: false, platform: 'win32' }), '[core]\n\tlongpaths = true\n');
  assert.match(gitConfig({ lfs: true, platform: 'linux' }), /^\[filter "lfs"\]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n$/);
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('core.sshCommand round-trips through a POSIX shell to the same arguments', { skip: win }, async () => {
  const dir = tempDir();
  const echo = path.join(dir, "print args'");
  fs.writeFileSync(echo, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n', { mode: 0o755 });
  const files = { key: path.join(dir, "Jo's keys", 'k'), knownHosts: path.join(dir, 'a b', 'kh'), config: path.join(dir, 'a b', 'cfg') };
  const command = sshCommand({ ssh: echo, ...files, platform: 'linux' });
  const out = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', `${command} git@github.com`], (err, stdout) => (err ? reject(err) : resolve(stdout))));
  assert.deepEqual(out.trim().split('\n'), [...sshArgs({ ...files, platform: 'linux' }), 'git@github.com']);
});

test('small parsers: Link pagination, repositories, scopes and the clone environment', () => {
  assert.equal(nextLink('<https://api.github.com/user/repos?page=2>; rel="next", <https://api.github.com/user/repos?page=5>; rel="last"'), 'https://api.github.com/user/repos?page=2');
  assert.equal(nextLink('<https://x/?page=1>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
  assert.deepEqual(cleanRepo({ full_name: 'o/r', private: true, description: '  hi ', language: 'Go', pushed_at: 'nope' }), {
    fullName: 'o/r', owner: 'o', ownerType: 'User', name: 'r', private: true, fork: false, archived: false, description: 'hi', language: 'Go', pushedAt: null, url: 'https://github.com/o/r',
  });
  assert.equal(cleanRepo({ full_name: '../evil' }), null);
  assert.deepEqual(parseScopes('repo, write:public_key'), ['repo', 'write:public_key']);
  assert.deepEqual(parseScopes('repo,write:public_key'), ['repo', 'write:public_key']);
  for (const key of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'git_ssh_command']) {
    assert.equal(dropsFromCloneEnv(key), true, key);
  }
  for (const key of ['GIT_COMMON_DIR', 'GIT_INDEX_VERSION', 'GIT_AUTHOR_NAME']) assert.equal(dropsFromCloneEnv(key), true, key);
  for (const key of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'DIGIT_X']) assert.equal(dropsFromCloneEnv(key), false, key);
});

test('device-flow sign-in waits out pending and slow_down answers, then keeps the account by id without exposing its token', async () => {
  const ctx = await setup();
  ctx.github.state.pendingPolls = 1;
  ctx.github.state.slowDownInterval = 1;
  const started = await ctx.hub.startSignIn();
  assert.equal(started.signIn.status, 'pending');
  assert.equal(started.signIn.userCode, 'WDJB-MJHT');
  assert.equal(ctx.github.state.deviceScope, GITHUB_SCOPES.join(' '));
  await waitFor(() => ctx.hub.signIn?.status === 'done', 'sign-in', 15000);
  const snapshot = ctx.hub.snapshot();
  assert.equal(snapshot.signIn.accountId, 4242);
  assert.equal(snapshot.signIn.again, false);
  assert.equal(snapshot.accounts.length, 1);
  const [account] = snapshot.accounts;
  assert.equal(account.id, 4242);
  assert.equal(account.login, 'octo-cat');
  assert.match(account.avatar, /^data:image\/png;base64,/);
  assert.deepEqual(account.scopes, ['repo', 'write:public_key']);
  assert.equal(account.ssh.status, 'none');
  const text = JSON.stringify(snapshot);
  assert.ok(!text.includes('access-') && !text.includes('refresh-'), 'no token reaches a client');
  assert.ok(ctx.updates.length >= 2);

  const file = path.join(ctx.root, 'data', 'github', 'accounts.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.accounts[0].token.access, 'access-1');
  assert.equal(stored.accounts[0].token.refresh, 'refresh-1');
  if (!win) assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The same GitHub user signing in again, under a new login, replaces that account only.
  ctx.github.state.user = { id: 4242, login: 'octo-renamed', name: null };
  await ctx.hub.startSignIn();
  await waitFor(() => ctx.hub.signIn?.status === 'done', 'second sign-in');
  assert.equal(ctx.hub.snapshot().signIn.again, true);
  assert.equal(ctx.hub.accounts.length, 1);
  assert.equal(ctx.hub.accounts[0].login, 'octo-renamed');
  assert.equal(ctx.hub.accounts[0].token.access, 'access-2');

  // Another user is a second account.
  ctx.github.state.user = { id: 7, login: 'work-me', name: 'Work' };
  await ctx.hub.startSignIn();
  await waitFor(() => ctx.hub.signIn?.status === 'done', 'third sign-in');
  assert.deepEqual(ctx.hub.accounts.map((a) => a.id), [4242, 7]);

  const reloaded = new GitHub({ dir: path.join(ctx.root, 'data', 'github'), registry: { env: {}, platform: process.platform } });
  assert.deepEqual(reloaded.accounts.map((a) => a.login), ['octo-renamed', 'work-me']);
  ctx.hub.signOut(7);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).accounts.map((a) => a.id), [4242]);
  assert.throws(() => ctx.hub.signOut(7), { code: 'unknown_account' });
});

test('a declined, expired or cancelled sign-in ends without an account', async () => {
  for (const [error, status] of [['access_denied', 'denied'], ['expired_token', 'expired'], ['token_expired', 'expired'], ['device_flow_disabled', 'failed']]) {
    const ctx = await setup();
    ctx.github.state.pollError = error;
    await ctx.hub.startSignIn();
    await waitFor(() => ctx.hub.signIn?.status !== 'pending', error);
    assert.equal(ctx.hub.signIn.status, status, error);
    assert.equal(ctx.hub.accounts.length, 0);
  }
  const ctx = await setup();
  ctx.github.state.pendingPolls = 100;
  await ctx.hub.startSignIn();
  assert.equal(ctx.hub.cancelSignIn().signIn, null);
  const polls = ctx.github.state.requests.filter((r) => r === 'POST /login/oauth/access_token').length;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(ctx.github.state.requests.filter((r) => r === 'POST /login/oauth/access_token').length, polls, 'no polling after cancel');
});

test('concurrent requests share one token refresh and the rotated refresh token is saved', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  account.token.expiresAt = new Date(Date.now() - 1000).toISOString();
  ctx.github.state.refreshDelayMs = 150;
  const results = await Promise.all([
    ctx.hub.repos(account.id, { refresh: true }),
    ctx.hub.repos(account.id, { refresh: true }),
    ctx.hub.setupSsh(account.id),
  ]);
  assert.equal(ctx.github.state.refreshes, 1, 'one refresh for every caller');
  assert.equal(results[0].repos.length, 3);
  assert.equal(results[2].ssh.status, 'ready');
  const stored = JSON.parse(fs.readFileSync(path.join(ctx.root, 'data', 'github', 'accounts.json'), 'utf8')).accounts[0].token;
  assert.equal(stored.access, 'access-2');
  assert.equal(stored.refresh, 'refresh-2');
  assert.equal(stored.access, ctx.github.state.access);

  // GitHub refusing a token that has not expired yet also refreshes it once.
  ctx.github.state.access = 'revoked';
  ctx.github.state.refresh = 'refresh-2';
  await ctx.hub.repos(account.id, { refresh: true });
  assert.equal(ctx.github.state.refreshes, 2);

  // A refused refresh asks for a new sign-in instead of retrying.
  ctx.github.state.access = 'revoked-again';
  ctx.github.state.refresh = 'unknown';
  await assert.rejects(ctx.hub.repos(account.id, { refresh: true }), { code: 'github_sign_in' });
  assert.equal(ctx.hub.snapshot().accounts[0].needsSignIn, true);
  await assert.rejects(ctx.hub.repos(account.id, { refresh: true }), { code: 'github_sign_in' });
  assert.equal(ctx.github.state.refreshes, 3);
});

test('repositories come newest push first, across pages, with what is at each clone target', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  const parent = tempDir();
  fs.mkdirSync(path.join(parent, 'agent-guild', '.git'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'agent-guild', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:octo-cat/agent-guild.git\n');
  fs.mkdirSync(path.join(parent, 'api'));
  fs.writeFileSync(path.join(parent, 'api', 'x'), '');
  const { repos, truncated } = await ctx.hub.repos(account.id, { parent });
  assert.equal(truncated, false);
  assert.deepEqual(repos.map((r) => [r.fullName, r.local]), [['octo-cat/agent-guild', 'cloned'], ['acme/api', 'conflict'], ['octo-cat/old-tool', 'absent']]);
  assert.equal(repos[0].target, path.join(parent, 'agent-guild'));
  assert.equal(ctx.github.state.requests.filter((r) => r === 'GET /user/repos').length, 2, 'both pages');
  await ctx.hub.repos(account.id, { parent });
  assert.equal(ctx.github.state.requests.filter((r) => r === 'GET /user/repos').length, 2, 'cached');
  assert.equal((await ctx.hub.repos(account.id)).repos[0].local, null);
  await assert.rejects(ctx.hub.repos(999), { code: 'unknown_account' });
});

test('SSH setup makes one key per account in the data folder, adds it, trusts only GitHub\'s shipped host keys and checks the login', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  const result = await ctx.hub.setupSsh(account.id);
  assert.equal(result.ssh.status, 'ready', JSON.stringify(result.ssh.error));
  const key = path.join(ctx.root, 'data', 'github', 'keys', 'agent-guild-github-4242');
  assert.equal(result.ssh.key, key);
  assert.match(result.ssh.publicKey, /^ssh-ed25519 /);
  assert.equal(ctx.github.state.keyPosts.length, 1);
  assert.equal(ctx.github.state.keyPosts[0].title, 'Agent Guild (test-host)');
  const knownHosts = path.join(ctx.root, 'data', 'github', 'known_hosts');
  assert.equal(fs.readFileSync(knownHosts, 'utf8'), GITHUB_HOST_KEYS.join('\n') + '\n');
  const ssh = ctx.runs().find((r) => r.tool === 'ssh');
  assert.deepEqual(ssh.args.slice(0, 3), ['-T', '-o', 'ConnectTimeout=15']);
  assert.deepEqual(ssh.args.slice(3), [...sshArgs({ key, knownHosts, config: path.join(ctx.root, 'data', 'github', 'ssh_config'), platform: process.platform }), 'git@github.com']);

  // Again: the same key, already on the account, so nothing is made or added.
  const keygens = ctx.runs().filter((r) => r.tool === 'ssh-keygen').length;
  assert.equal((await ctx.hub.setupSsh(account.id)).ssh.status, 'ready');
  assert.equal(ctx.runs().filter((r) => r.tool === 'ssh-keygen').length, keygens);
  assert.equal(ctx.github.state.keyPosts.length, 1);
});

test('SSH setup falls back to RSA, and reports what the user must do when it cannot finish', async () => {
  const rsa = await setup();
  rsa.control({ noEd25519: true });
  const a = await signIn(rsa);
  const made = await rsa.hub.setupSsh(a.id);
  assert.equal(made.ssh.status, 'ready');
  assert.match(made.ssh.publicKey, /^ssh-rsa /);
  assert.deepEqual(rsa.runs().filter((r) => r.tool === 'ssh-keygen').map((r) => r.args[r.args.indexOf('-t') + 1]), ['ed25519', 'rsa']);

  const wrong = await setup();
  wrong.control({ login: 'someone-else' });
  const b = await signIn(wrong);
  const mismatch = await wrong.hub.setupSsh(b.id);
  assert.equal(mismatch.ssh.status, 'unverified');
  assert.equal(mismatch.ssh.error.code, 'ssh_wrong_account');

  const noScope = await setup();
  noScope.github.state.scopes = 'repo';
  noScope.github.state.tokenScope = 'repo';
  noScope.control({ deny: true });
  const c = await signIn(noScope);
  const manual = await noScope.hub.setupSsh(c.id);
  assert.equal(manual.ssh.error.code, 'ssh_key_manual');
  assert.equal(manual.ssh.error.manual, true);
  assert.match(manual.ssh.publicKey, /^ssh-ed25519 /);
  assert.equal(noScope.github.state.keyPosts.length, 0);
  noScope.control({});
  assert.equal((await noScope.hub.setupSsh(c.id)).ssh.status, 'ready', 'checking again once the user added the key');

  const inUse = await setup();
  inUse.github.state.keyPostStatus = 422;
  const d = await signIn(inUse);
  assert.equal((await inUse.hub.setupSsh(d.id)).ssh.error.code, 'ssh_key_in_use');

  const hostKey = await setup();
  hostKey.control({ hostKeyChanged: true });
  const e = await signIn(hostKey);
  assert.equal((await hostKey.hub.setupSsh(e.id)).ssh.error.code, 'ssh_host_key');

  const noSsh = await setup({ tools: ['git'] });
  const f = await signIn(noSsh);
  assert.equal((await noSsh.hub.setupSsh(f.id)).ssh.error.code, 'ssh_unavailable');
});

test('a clone runs git directly with one core.sshCommand value and Agent Guild\'s own empty Git configuration', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  const parent = tempDir();
  assert.throws(() => ctx.hub.cloneSpec({ accountId: account.id, repo: 'octo-cat/agent-guild', parent }), { code: 'ssh_not_ready' });
  await ctx.hub.setupSsh(account.id);
  assert.throws(() => ctx.hub.cloneSpec({ accountId: account.id, repo: 'octo-cat/a b', parent }), { code: 'bad_repo' });
  const spec = ctx.hub.cloneSpec({ accountId: account.id, repo: 'octo-cat/agent-guild', parent });
  const data = path.join(ctx.root, 'data', 'github');
  const { ssh, git } = ctx.hub.tools();
  assert.equal(spec.spawnSpec.file, git);
  assert.deepEqual(spec.spawnSpec.args, [
    'clone', '--config',
    `core.sshCommand=${sshCommand({ ssh, key: path.join(data, 'keys', 'agent-guild-github-4242'), knownHosts: path.join(data, 'known_hosts'), config: path.join(data, 'ssh_config'), platform: process.platform })}`,
    'git@github.com:octo-cat/agent-guild.git', path.join(parent, 'agent-guild'),
  ]);
  assert.deepEqual(spec.env, { GIT_CONFIG_GLOBAL: path.join(data, 'clone.gitconfig'), GIT_CONFIG_SYSTEM: path.join(data, 'clone.gitconfig'), GIT_TERMINAL_PROMPT: '0' });
  assert.equal(fs.readFileSync(path.join(data, 'clone.gitconfig'), 'utf8'), gitConfig({ lfs: false, platform: process.platform }));
  assert.equal(fs.readFileSync(path.join(data, 'ssh_config'), 'utf8'), '');

  fs.mkdirSync(path.join(parent, 'agent-guild', '.git'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'agent-guild', '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:octo-cat/agent-guild.git\n');
  assert.throws(() => ctx.hub.cloneSpec({ accountId: account.id, repo: 'octo-cat/agent-guild', parent }), { code: 'clone_exists' });
  assert.throws(() => ctx.hub.cloneSpec({ accountId: account.id, repo: 'other/agent-guild', parent }), { code: 'folder_conflict' });

  const noGit = await setup({ tools: ['ssh', 'ssh-keygen'] });
  const b = await signIn(noGit);
  await noGit.hub.setupSsh(b.id);
  assert.throws(() => noGit.hub.cloneSpec({ accountId: b.id, repo: 'o/r', parent }), { code: 'git_unavailable' });
});

test('an outage during a check keeps a verified key, and a failed or cancelled sign-in leaves nothing behind', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  assert.equal((await ctx.hub.setupSsh(account.id)).ssh.status, 'ready');
  const online = ctx.hub.fetchImpl;
  ctx.hub.fetchImpl = async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); };
  const during = await ctx.hub.setupSsh(account.id);
  assert.equal(during.ssh.error.code, 'github_unreachable');
  assert.equal(during.ssh.status, 'ready', 'still verified');

  ctx.hub.fetchImpl = online;
  ctx.github.state.pendingPolls = 100;
  await ctx.hub.startSignIn();
  assert.equal(ctx.hub.snapshot().signIn.status, 'pending');
  ctx.hub.fetchImpl = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(ctx.hub.startSignIn(), { code: 'github_unreachable' });
  assert.equal(ctx.hub.snapshot().signIn, null, 'no stale pending sign-in');

  // Cancelled while the approved account is being added: it is still announced.
  let release;
  let holding = false;
  const held = new Promise((resolve) => { release = resolve; });
  ctx.hub.fetchImpl = async (url, init) => {
    if (new URL(url).pathname === '/user') {
      holding = true;
      await held;
    }
    return online(url, init);
  };
  ctx.github.state.pendingPolls = 0;
  ctx.github.state.user = { id: 99, login: 'late', name: null };
  await ctx.hub.startSignIn();
  await waitFor(() => holding, 'the account being added');
  ctx.hub.cancelSignIn();
  const before = ctx.updates.length;
  release();
  await waitFor(() => ctx.hub.accounts.some((a) => a.id === 99), 'late account');
  await waitFor(() => ctx.updates.length > before, 'announced');
  assert.ok(ctx.updates.at(-1).accounts.some((a) => a.id === 99));
  assert.equal(ctx.hub.snapshot().signIn, null);
});

test('a new repository is created under the account or one of its organizations and joins the list', async () => {
  const ctx = await setup();
  const account = await signIn(ctx);
  const listed = await ctx.hub.repos(account.id);
  assert.deepEqual(listed.owners, ['octo-cat', 'acme']);

  const repo = await ctx.hub.createRepo(account.id, { owner: 'octo-cat', name: 'fresh-idea', description: ' A test ', private: true, readme: true });
  assert.equal(repo.fullName, 'octo-cat/fresh-idea');
  assert.deepEqual(ctx.github.state.created.at(-1), { owner: 'octo-cat', name: 'fresh-idea', description: 'A test', private: true, auto_init: true });
  assert.ok(ctx.github.state.requests.includes('POST /user/repos'));
  assert.equal((await ctx.hub.repos(account.id)).repos[0].fullName, 'octo-cat/fresh-idea', 'listed first without a refetch');

  const org = await ctx.hub.createRepo(account.id, { owner: 'acme', name: 'tools', private: false, readme: false });
  assert.equal(org.ownerType, 'Organization');
  assert.ok(ctx.github.state.requests.includes('POST /orgs/acme/repos'));
  assert.deepEqual(ctx.github.state.created.at(-1), { owner: 'acme', name: 'tools', private: false, auto_init: false });

  await assert.rejects(ctx.hub.createRepo(account.id, { owner: 'octo-cat', name: 'fresh-idea' }), { code: 'repo_exists' });
  await assert.rejects(ctx.hub.createRepo(account.id, { owner: 'elsewhere', name: 'x' }), { code: 'repo_forbidden' });
  for (const name of ['', 'a b', '..', 'x.git', '-x/']) {
    await assert.rejects(ctx.hub.createRepo(account.id, { owner: 'octo-cat', name }), { code: 'bad_repo' }, name);
  }
});

test('an approved sign-in that finishes after a newer one for the same user keeps a single account', async () => {
  const ctx = await setup();
  const online = ctx.hub.fetchImpl;
  let release;
  let holding = false;
  const held = new Promise((resolve) => { release = resolve; });
  ctx.hub.fetchImpl = async (url, init) => {
    if (new URL(url).pathname.startsWith('/avatar/') && !holding) {
      holding = true;
      await held;
    }
    return online(url, init);
  };
  await ctx.hub.startSignIn();
  await waitFor(() => holding, 'the first sign-in fetching its avatar');
  ctx.hub.cancelSignIn();
  await ctx.hub.startSignIn();
  await waitFor(() => ctx.hub.signIn?.status === 'done', 'second sign-in');
  release();
  await waitFor(() => ctx.github.state.requests.filter((r) => r === 'GET /user').length >= 2 && ctx.updates.length > 0, 'first sign-in finished');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(ctx.hub.accounts.map((a) => a.id), [4242]);
  ctx.hub.signOut(4242);
  assert.deepEqual(ctx.hub.snapshot().accounts, []);

  const file = path.join(ctx.root, 'data', 'github', 'accounts.json');
  const stored = { accounts: [{ id: 5, login: 'a', token: { access: 'x' } }, { id: 5, login: 'a', token: { access: 'y' } }] };
  fs.writeFileSync(file, JSON.stringify(stored));
  const reloaded = new GitHub({ dir: path.join(ctx.root, 'data', 'github'), registry: { env: {}, platform: process.platform } });
  assert.deepEqual(reloaded.accounts.map((a) => a.token.access), ['y'], 'duplicates written by an older version collapse to one');
});

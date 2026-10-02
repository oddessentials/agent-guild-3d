import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// app.js is a browser script. Run its real events handler against a fake
// socket and stubbed page functions, without booting the DOM or a manager.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const connectSource = app.match(/function connectEvents\(\) \{[^]*?\n\}/)?.[0];
assert.ok(connectSource, 'connectEvents is present in app.js');

function connect({ changelogOpen, githubOpen = false }) {
  const calls = [];
  const sockets = [];
  const noop = () => {};
  const context = {
    state: { stopping: false, views: new Map() },
    sessionsShown: false,
    WebSocket: class { constructor() { sockets.push(this); } },
    $: (id) => ({ open: (id === 'changelog' && changelogOpen) || (id === 'github' && githubOpen) }),
    wsUrl: (path) => path,
    loadChangelog: () => calls.push('changelog'),
    loadNews: () => calls.push('news'),
    loadGitHub: () => calls.push('github'),
    setUpgrade: noop,
    renderVersion: noop,
    setConnection: noop,
    renderSessions: noop,
    dropSession: noop,
    leaveStopping: noop,
  };
  runInNewContext(`(${connectSource})()`, context);
  const hello = { type: 'hello', version: '1.2.3', pid: 1, sessions: [], upgrade: null };
  return { calls, send: (msg) => sockets[0].onmessage({ data: JSON.stringify(msg) }), hello };
}

test('a reconnect catches the open What\'s new panel up on a changelog.updated it missed', () => {
  const page = connect({ changelogOpen: true });
  page.send(page.hello);
  assert.deepEqual(page.calls, ['news', 'changelog']);
});

test('a reconnect leaves the changelog alone while its panel is closed', () => {
  const page = connect({ changelogOpen: false });
  page.send(page.hello);
  assert.deepEqual(page.calls, ['news']);
});

test('a reconnect and a github.updated reload the open GitHub panel', () => {
  const page = connect({ changelogOpen: false, githubOpen: true });
  page.send(page.hello);
  page.send({ type: 'github.updated' });
  assert.deepEqual(page.calls, ['news', 'github', 'github']);
});

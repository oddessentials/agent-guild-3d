import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import pty from 'node-pty';
import { Session } from '../src/manager/session.mjs';

// app.js is a browser script. Exercise its actual calculation without booting
// the DOM, starting a manager, or copying the formula into the test.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const levelSource = app.match(/function sessionLevel\(s\) \{[^]*?\n\}/)?.[0];
assert.ok(levelSource, 'sessionLevel is present in app.js');
const level = (session) => runInNewContext(`(${levelSource})`, { Date })(session);
const START = Date.parse('2026-09-30T09:00:00.000Z');
const EXIT = Date.parse('2026-09-30T12:00:00.000Z');
const HOUR = 3_600_000;

function createSession(t) {
  let onData;
  let onExit;
  const child = {
    pid: 0,
    onData(fn) { onData = fn; },
    onExit(fn) { onExit = fn; },
    write() {},
    resize() {},
    kill() { this.stopRequested = true; },
  };
  t.mock.method(pty, 'spawn', () => child);
  const session = new Session({
    id: 'test-session',
    provider: { id: 'fake', vendor: 'Test', tool: 'Fake Tool' },
    spawnSpec: { file: 'mocked-pty', args: [] },
    cwd: process.cwd(), env: {}, cols: 80, rows: 24, reportToken: 'test',
  });
  t.after(() => session.dispose());
  return {
    session,
    output: (data) => onData(data),
    exit: (exitCode, signal) => onExit({ exitCode, signal }),
  };
}

for (const scenario of [
  { name: 'a quiet session', output: true, code: 0 },
  { name: 'a session with no output', code: 0 },
  { name: 'a failed session', output: true, code: 3 },
  { name: 'a delayed exit after Stop', stop: true, code: 0 },
  { name: 'a session ended by a signal', output: true, code: null, signal: 'SIGTERM' },
]) {
  test(`the level freezes at the exit time for ${scenario.name}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: START });
    const { session, output, exit } = createSession(t);
    assert.equal(session.toJSON().exitedAt, null);
    if (scenario.output) {
      t.mock.timers.setTime(START + 5 * 60_000);
      output('last output\r\n');
      await new Promise((resolve) => session.term.write('', resolve));
    }
    const lastOutputAt = session.toJSON().lastOutputAt;
    if (scenario.stop) {
      t.mock.timers.setTime(EXIT - 1000);
      session.kill();
      assert.equal(session.pty.stopRequested, true);
      assert.equal(session.status, 'running');
      assert.equal(session.toJSON().exitedAt, null, 'Stop is only a request to exit');
    }
    t.mock.timers.setTime(EXIT);
    assert.equal(level(session.toJSON()), 4);
    const updates = [];
    session.on('changed', () => updates.push(session.toJSON()));
    const exited = once(session, 'exit');
    exit(scenario.code, scenario.signal);
    const exitedAt = new Date(EXIT).toISOString();
    assert.equal(session.toJSON().exitedAt, exitedAt, 'recorded before the terminal flush');

    // The asynchronous terminal flush must not determine the exit time.
    t.mock.timers.setTime(EXIT + HOUR);
    await exited;
    const completed = updates.find((s) => s.status === 'exited');
    assert.equal(completed.exitedAt, exitedAt);
    assert.equal(completed.lastOutputAt, lastOutputAt, 'exit does not count as output');
    assert.equal(completed.exitCode, scenario.code);
    assert.equal(completed.signal, scenario.signal ?? null);
    assert.equal(level(completed), 4, 'quiet runtime is retained');

    // A fresh client has no remembered level and must get it from the session.
    t.mock.timers.setTime(EXIT + 24 * HOUR);
    const snapshot = await new Promise((resolve) => session.attach((msg) => {
      if (msg.type === 'snapshot') resolve(JSON.parse(JSON.stringify(msg)));
    }));
    assert.equal(snapshot.session.exitedAt, exitedAt);
    assert.equal(level(snapshot.session), 4, 'reconnecting the next day preserves the level');

    const repeated = once(session, 'exit');
    exit(scenario.code, scenario.signal);
    await repeated;
    assert.equal(session.toJSON().exitedAt, exitedAt, 'repeated exits preserve the first timestamp');
    assert.equal(level(session.toJSON()), 4);
  });
}

test('session levels retain their boundaries and older-manager fallbacks', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: EXIT });
  const base = { createdAt: new Date(START).toISOString(), status: 'exited' };
  for (const [name, fields, expected] of [
    ['zero duration', { exitedAt: base.createdAt }, 1],
    ['just under one hour', { exitedAt: new Date(START + HOUR - 1).toISOString() }, 1],
    ['exactly one hour', { exitedAt: new Date(START + HOUR).toISOString() }, 2],
    ['clock before start', { exitedAt: new Date(START - HOUR).toISOString() }, 1],
    ['invalid creation time', { createdAt: 'invalid', exitedAt: new Date(EXIT).toISOString() }, 1],
    ['invalid exit time', { exitedAt: 'invalid' }, 1],
    ['legacy output time', { lastOutputAt: new Date(START + HOUR).toISOString() }, 2],
    ['legacy session without output', {}, 1],
    ['running uses current time', { status: 'running', exitedAt: base.createdAt }, 4],
  ]) {
    assert.equal(level({ ...base, ...fields }), expected, name);
  }
});

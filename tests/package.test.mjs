import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readTar, checkPackage } from './package/check-tarball.mjs';
import { generateNotes } from '../.github/release/capture.mjs';
import { parseNotes } from '../src/manager/changelog.mjs';

function header(name, size, { mode = 0o644, type = '0', prefix = '' } = {}) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(6, '0')} \0`, 100, 8, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')} `, 124, 12, 'latin1');
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\u000000', 257, 8, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  return block;
}

function entry(name, body = '', options) {
  const data = Buffer.from(body);
  return Buffer.concat([header(name, data.length, options), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function paxRecord(key, value) {
  const tail = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(tail) + 1;
  while (String(length).length + Buffer.byteLength(tail) !== length) length = String(length).length + Buffer.byteLength(tail);
  return `${length}${tail}`;
}

const tar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

const NAME = '@scope/app';
const lock = {
  packages: {
    '': { name: NAME },
    'node_modules/dep': { version: '1.0.0' },
    'node_modules/@scope/other': { version: '2.0.0' },
    'node_modules/tool': { version: '9.0.0', dev: true },
  },
};

function goodPackage({ manifest = {}, without = [], extra = [] } = {}) {
  const files = new Map([
    ['package.json', [JSON.stringify({ name: NAME, version: '1.2.3', bin: { app: 'bin/app.mjs' }, ...manifest })]],
    ['README.md', ['readme']],
    ['LICENSE', ['license']],
    ['bin/app.mjs', ['bin']],
    ['src/manager/main.mjs', ['main']],
    ['web/index.html', ['page']],
    ['config/providers.default.json', ['{}']],
    ['node_modules/dep/package.json', [JSON.stringify({ version: '1.0.0' })]],
    ['node_modules/dep/lib/package.json', [JSON.stringify({ type: 'commonjs' })]],
    ['node_modules/dep/prebuilds/darwin-arm64/spawn-helper', ['helper', { mode: 0o755 }]],
    ['node_modules/@scope/other/package.json', [JSON.stringify({ version: '2.0.0' })]],
    ...extra,
  ]);
  for (const name of without) files.delete(name);
  return readTar(tar(...[...files].map(([name, [body, options]]) => entry(`package/${name}`, body, options))));
}

test('the tarball reader understands plain, prefixed, pax and GNU long names', () => {
  const long = `package/${'deep/'.repeat(30)}file.txt`;
  const entries = readTar(tar(
    entry('package/a.txt', 'alpha', { mode: 0o755 }),
    entry('name.txt', 'beta', { prefix: 'package/dir' }),
    entry('PaxHeader', paxRecord('mtime', '1') + paxRecord('path', long), { type: 'x' }),
    entry('truncated', 'gamma'),
    entry('././@LongLink', `${long}2\0`, { type: 'L' }),
    entry('truncated', 'delta'),
    entry('pax_global_header', paxRecord('comment', 'x'), { type: 'g' }),
    entry('package/last.txt', ''),
  ));
  assert.deepEqual(entries.map((e) => [e.path, e.mode, e.size, e.body.toString()]), [
    ['package/a.txt', 0o755, 5, 'alpha'],
    ['package/dir/name.txt', 0o644, 4, 'beta'],
    [long, 0o644, 5, 'gamma'],
    [`${long}2`, 0o644, 5, 'delta'],
    ['package/last.txt', 0o644, 0, ''],
  ]);
});

test('a package with the listed files, the locked dependencies and an executable helper passes', () => {
  assert.deepEqual(checkPackage({ entries: goodPackage(), lock, version: '1.2.3' }), []);
  assert.deepEqual(checkPackage({ entries: goodPackage(), lock }), []);
});

test('the package check names every way a tarball can be wrong', () => {
  const problems = (options, version = '1.2.3') => checkPackage({ entries: goodPackage(options), lock, version });

  assert.match(problems({ extra: [['tests/unit.test.mjs', ['x']], ['npm-shrinkwrap.json', ['{}']]] }).join('\n'),
    /^tests is not on the list of shipped files\nnpm-shrinkwrap\.json is not on the list of shipped files$/);
  assert.deepEqual(problems({ without: ['LICENSE', 'bin/app.mjs'] }), ['LICENSE is missing', 'bin/app.mjs is missing']);
  assert.deepEqual(problems({ manifest: { name: 'other', private: true } }),
    ['the package is named other, not @scope/app', 'the package is marked private']);
  assert.deepEqual(problems({}, '1.2.4'), ['the package is version 1.2.3, not 1.2.4']);

  assert.deepEqual(problems({ without: ['node_modules/@scope/other/package.json'] }),
    ['node_modules/@scope/other is in the lockfile but not in the package']);
  assert.deepEqual(problems({ extra: [['node_modules/dep/package.json', [JSON.stringify({ version: '1.0.1' })]]] }),
    ['node_modules/dep is 1.0.1 in the package but 1.0.0 in the lockfile']);
  assert.deepEqual(problems({ extra: [['node_modules/dep/node_modules/nested/package.json', [JSON.stringify({ version: '3.0.0' })]]] }),
    ['node_modules/dep/node_modules/nested is in the package but is not a locked runtime dependency']);
  assert.deepEqual(problems({ extra: [['node_modules/tool/package.json', [JSON.stringify({ version: '9.0.0' })]]] }),
    ['node_modules/tool is in the package but is not a locked runtime dependency']);

  assert.deepEqual(problems({ extra: [['node_modules/dep/prebuilds/darwin-arm64/spawn-helper', ['helper', { mode: 0o644 }]]] }),
    ['node_modules/dep/prebuilds/darwin-arm64/spawn-helper is not executable (mode 644); pack on Linux or macOS']);
  assert.deepEqual(problems({ without: ['node_modules/dep/prebuilds/darwin-arm64/spawn-helper'] }),
    ['no spawn-helper was found; node-pty needs it to start terminals on macOS']);

  const outside = [...goodPackage(), ...readTar(tar(entry('elsewhere/file', 'x')))];
  assert.deepEqual(checkPackage({ entries: outside, lock, version: '1.2.3' }), ['elsewhere/file is outside package/']);
});

test('the release plan records the version and notes that end with the install command', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-release-'));
  const out = path.join(cwd, 'plan');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: NAME }));
  const context = {
    cwd,
    env: { RELEASE_PLAN_DIR: out },
    lastRelease: { version: '1.2.2' },
    nextRelease: { version: '1.2.3', notes: '## 1.2.3\n\n* a change' },
  };

  const added = await generateNotes({}, context);
  assert.match(added, /npm install -g @scope\/app@1\.2\.3\n/);
  assert.match(added, /agent-guild stop/);
  assert.equal(fs.readFileSync(path.join(out, 'version'), 'utf8'), '1.2.3');
  assert.equal(fs.readFileSync(path.join(out, 'notes.md'), 'utf8'), `## 1.2.3\n\n* a change\n\n${added}\n`);

  await generateNotes({}, { ...context, nextRelease: { version: '1.2.4' } });
  assert.equal(fs.readFileSync(path.join(out, 'notes.md'), 'utf8').startsWith('### Install or update'), true);
  await assert.rejects(generateNotes({}, { ...context, env: {} }), /RELEASE_PLAN_DIR/);

  fs.rmSync(out, { recursive: true, force: true });
  await assert.rejects(generateNotes({}, { ...context, lastRelease: {} }), /No release tag was found/);
  assert.equal(fs.existsSync(out), false, 'a first release without a baseline tag plans nothing');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('the changelog in the page leaves out the install steps that end every release note', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-release-'));
  const out = path.join(cwd, 'plan');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: NAME }));
  const notes = [
    '## [1.2.3](https://github.com/oddessentials/agent-guild/compare/v1.2.2...v1.2.3) (2026-10-01)',
    '',
    '### Bug Fixes',
    '',
    '* keep the fix ([#9](https://github.com/oddessentials/agent-guild/issues/9)) ([abc1234](https://github.com/oddessentials/agent-guild/commit/abc1234))',
  ].join('\n');
  await generateNotes({}, { cwd, env: { RELEASE_PLAN_DIR: out }, lastRelease: { version: '1.2.2' }, nextRelease: { version: '1.2.3', notes } });
  assert.deepEqual(parseNotes(fs.readFileSync(path.join(out, 'notes.md'), 'utf8')), [{
    title: 'Bug Fixes',
    changes: [[{ text: 'keep the fix (' }, { text: '#9', url: 'https://github.com/oddessentials/agent-guild/issues/9' }, { text: ')' }]],
  }]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

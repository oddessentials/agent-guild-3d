import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, '.github/release/node_modules/semantic-release/bin/semantic-release.js');
const configFiles = ['package.json', '.releaserc.json', '.github/release/capture.mjs'];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const repository = manifest.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');

const cases = [
  { from: '0.0.0', title: 'feat: publish to npm with automated releases (#30)', version: '0.1.0' },
  { from: '0.1.0', title: 'fix: handle an empty reply', version: '0.1.1' },
  { from: '0.1.0', title: 'perf: read usage once', version: '0.1.1' },
  { from: '0.1.0', title: 'fix(deps): bump ws from 8.22.0 to 8.22.1', version: '0.1.1' },
  { from: '0.1.0', title: 'feat(usage): show weekly limits', version: '0.2.0' },
  { from: '0.1.0', title: 'feat!: drop the legacy report flag', version: '0.2.0' },
  { from: '0.1.0', title: 'revert: show weekly limits', version: '0.1.1' },
  { from: '0.1.0', title: 'revert!: drop the legacy report flag', version: '0.2.0' },
  { from: '0.1.0', title: 'docs: remove a stale sentence', version: null },
  { from: '0.1.0', title: 'ci(deps): bump actions/checkout from 7.0.1 to 7.0.2', version: null },
  { from: '0.1.0', title: 'Merge pull request #1 from someone/branch', version: null },
  { from: null, title: 'feat: release without a baseline tag', refused: /No release tag was found/ },
];

const inherited = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG']);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => inherited.has(key.toUpperCase())));

function plan({ from, title }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-plan-'));
  const work = path.join(dir, 'work');
  const mirror = path.join(dir, 'origin.git');
  const out = path.join(dir, 'plan');
  const gitConfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env = {
    ...baseEnv,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Release plan',
    GIT_AUTHOR_EMAIL: 'plan@example.invalid',
    GIT_COMMITTER_NAME: 'Release plan',
    GIT_COMMITTER_EMAIL: 'plan@example.invalid',
    RELEASE_PLAN_DIR: out,
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.mkdirSync(work);
    git(work, 'init', '--quiet', '--initial-branch=main');
    for (const file of configFiles) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(work, file));
    }
    git(work, 'add', '--all');
    git(work, 'commit', '--quiet', '--message', 'chore: start');
    if (from !== null) git(work, 'tag', `v${from}`);
    git(work, 'commit', '--quiet', '--allow-empty', '--message', title);
    git(dir, 'clone', '--quiet', '--bare', work, mirror);
    let output;
    let exit = 0;
    try {
      output = execFileSync(process.execPath, [cli, '--dry-run', '--no-ci', '--repository-url', pathToFileURL(mirror).href], {
        cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      exit = err.status ?? 1;
    }
    const read = (file) => (fs.existsSync(path.join(out, file)) ? fs.readFileSync(path.join(out, file), 'utf8') : null);
    return { exit, output, version: read('version'), notes: read('notes.md') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function problemsWith(expected) {
  const { exit, output, version, notes } = plan(expected);
  if (expected.refused) {
    if (exit === 0) return ['the plan succeeded but should have been refused'];
    if (version !== null) return [`a refused plan still recorded version ${version}`];
    return expected.refused.test(output) ? [] : [`the refusal does not say why:\n${output}`];
  }
  if (exit !== 0) return [`semantic-release failed:\n${output}`];
  const problems = [];
  if (version !== expected.version) problems.push(`planned ${version ?? 'no release'}, expected ${expected.version ?? 'no release'}`);
  if (version !== null && expected.version !== null) {
    const subject = expected.title.replace(/^[^:]+: /, '').replace(/ \(#\d+\)$/, '');
    if (!notes.includes(subject)) problems.push(`the notes do not mention "${subject}"`);
    const compare = `${repository}/compare/v${expected.from}...v${version}`;
    if (!notes.includes(compare)) problems.push(`the notes do not link to ${compare}`);
    if (!notes.includes(`npm install -g ${manifest.name}@${version}`)) problems.push('the notes do not end with the install command');
  }
  return problems;
}

let failed = 0;
for (const expected of cases) {
  let problems;
  try {
    problems = problemsWith(expected);
  } catch (err) {
    problems = [`${err.message}\n${err.stdout ?? ''}${err.stderr ?? ''}`];
  }
  if (problems.length > 0) failed += 1;
  const outcome = expected.refused ? 'refused' : expected.version ?? 'no release';
  console.log(`${problems.length > 0 ? 'not ok' : 'ok'}  from ${expected.from ?? 'no tag'}: ${expected.title} -> ${outcome}`);
  for (const problem of problems) console.log(`        ${problem}`);
}
process.exitCode = failed > 0 ? 1 : 0;

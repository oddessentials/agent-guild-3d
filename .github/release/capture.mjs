import fs from 'node:fs';
import path from 'node:path';

export async function generateNotes(pluginConfig, { cwd, env, lastRelease, nextRelease }) {
  const dir = env.RELEASE_PLAN_DIR;
  if (!dir) throw new Error('RELEASE_PLAN_DIR must name the folder that receives the release plan');
  if (!lastRelease?.version) {
    throw new Error('No release tag was found, so the next version cannot follow from one. Tag the commit before the first release, for example v0.0.0.');
  }
  const { name } = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const install = [
    '### Install or update',
    '',
    'If Agent Guild is running, stop it first with `agent-guild stop`. That ends its sessions; a manager left running keeps the old version.',
    '',
    '```sh',
    `npm install -g ${name}@${nextRelease.version}`,
    'agent-guild',
    '```',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'version'), nextRelease.version);
  fs.writeFileSync(path.join(dir, 'notes.md'), `${[nextRelease.notes, install].filter(Boolean).join('\n\n')}\n`);
  return install;
}

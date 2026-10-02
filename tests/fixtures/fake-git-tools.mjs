// Stands in for ssh-keygen, ssh and git: `node fake-git-tools.mjs <tool> ...args`.
// FAKE_GIT_TOOLS_LOG gets one JSON line per run; FAKE_GIT_TOOLS_STATE (a JSON
// file, re-read on every run) sets the login ssh is greeted as, or a failure.
import fs from 'node:fs';
import path from 'node:path';

const [tool, ...args] = process.argv.slice(2);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const control = read(process.env.FAKE_GIT_TOOLS_STATE);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^GIT_/i.test(key)));
if (process.env.FAKE_GIT_TOOLS_LOG) fs.appendFileSync(process.env.FAKE_GIT_TOOLS_LOG, JSON.stringify({ tool, args, env, cwd: process.cwd() }) + '\n');
const after = (flag) => args[args.indexOf(flag) + 1];

if (tool === 'ssh-keygen') {
  const type = after('-t');
  if (control.noEd25519 && type === 'ed25519') {
    process.stderr.write('unknown key type ed25519\n');
    process.exit(1);
  }
  const file = after('-f');
  const name = type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519';
  const blob = Buffer.from(`${type}:${file}`).toString('base64');
  fs.writeFileSync(file, `PRIVATE ${type}\n`, { mode: 0o600 });
  fs.writeFileSync(`${file}.pub`, `${name} ${blob} ${after('-C')}\n`);
} else if (tool === 'ssh') {
  if (control.hostKeyChanged) {
    process.stderr.write('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n');
    process.exit(255);
  }
  if (control.deny) {
    process.stderr.write('git@github.com: Permission denied (publickey).\n');
    process.exit(255);
  }
  process.stderr.write(`Hi ${control.login ?? 'octo-cat'}! You've successfully authenticated, but GitHub does not provide shell access.\n`);
  process.exit(1);
} else if (tool === 'git') {
  const target = args.at(-1);
  const url = args.at(-2);
  process.stdout.write(`Cloning into '${target}'...\n`);
  if (control.cloneFails) {
    process.stderr.write('fatal: Could not read from remote repository.\n');
    process.exit(128);
  }
  fs.mkdirSync(path.join(target, '.git'), { recursive: true });
  const sshCommand = args.find((arg) => arg.startsWith('core.sshCommand='))?.slice('core.sshCommand='.length) ?? '';
  fs.writeFileSync(path.join(target, '.git', 'config'), `[core]\n\tsshCommand = ${sshCommand}\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  process.stdout.write('done.\n');
} else {
  process.stderr.write(`unknown tool ${tool}\n`);
  process.exit(2);
}

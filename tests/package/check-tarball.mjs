import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const MAX_PACKED_BYTES = 25 * 1024 * 1024;
const TOP_LEVEL = new Set(['package.json', 'README.md', 'LICENSE', 'bin', 'src', 'web', 'config', 'examples', 'node_modules']);
const REQUIRED = ['package.json', 'README.md', 'LICENSE', 'src/manager/main.mjs', 'web/index.html', 'config/providers.default.json'];
const PACKAGE_ROOT = /^((?:node_modules\/(?:@[^/]+\/)?[^/]+\/)+)package\.json$/;

function paxPath(body) {
  let found = null;
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(body.toString('utf8', at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = body.toString('utf8', space + 1, at + length - 1);
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') found = record.slice(eq + 1);
    at += length;
  }
  return found;
}

export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let longPath = null;
  const text = (start, length) => {
    const field = buffer.subarray(offset + start, offset + start + length);
    const end = field.indexOf(0);
    return field.toString('utf8', 0, end === -1 ? length : end);
  };
  while (offset + 512 <= buffer.length) {
    if (buffer.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(124, 12).trim() || '0', 8);
    const type = text(156, 1) || '0';
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      longPath = paxPath(body) ?? longPath;
    } else if (type === 'L') {
      longPath = body.toString('utf8').replace(/\0+$/, '');
    } else if (type !== 'g') {
      const prefix = text(345, 155);
      const name = text(0, 100);
      entries.push({ path: longPath ?? (prefix ? `${prefix}/${name}` : name), mode: parseInt(text(100, 8).trim() || '0', 8), size, type, body });
      longPath = null;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

export function packageFiles(entries) {
  const files = new Map();
  for (const entry of entries) {
    if (entry.type === '0' && entry.path.startsWith('package/')) files.set(entry.path.slice('package/'.length), entry);
  }
  return files;
}

export function bundledPackages(files) {
  const bundled = new Map();
  for (const [rel, entry] of files) {
    const match = rel.match(PACKAGE_ROOT);
    if (match) bundled.set(match[1].slice(0, -1), JSON.parse(entry.body.toString('utf8')).version);
  }
  return bundled;
}

export function checkPackage({ entries, lock, version = null }) {
  const problems = [];
  for (const entry of entries) {
    if (!entry.path.startsWith('package/')) problems.push(`${entry.path} is outside package/`);
  }
  const files = packageFiles(entries);

  const unexpected = new Set([...files.keys()].map((rel) => rel.split('/')[0]).filter((top) => !TOP_LEVEL.has(top)));
  for (const top of unexpected) problems.push(`${top} is not on the list of shipped files`);

  const manifestEntry = files.get('package.json');
  const manifest = manifestEntry ? JSON.parse(manifestEntry.body.toString('utf8')) : {};
  for (const rel of [...REQUIRED, ...Object.values(manifest.bin || {})]) {
    if (!files.has(rel)) problems.push(`${rel} is missing`);
  }
  if (manifestEntry) {
    const name = lock.packages[''].name;
    if (manifest.name !== name) problems.push(`the package is named ${manifest.name}, not ${name}`);
    if (manifest.private) problems.push('the package is marked private');
    if (version !== null && manifest.version !== version) problems.push(`the package is version ${manifest.version}, not ${version}`);
  }

  const expected = new Map(Object.entries(lock.packages).filter(([key, pkg]) => key && !pkg.dev).map(([key, pkg]) => [key, pkg.version]));
  const bundled = bundledPackages(files);
  for (const [key, want] of expected) {
    const got = bundled.get(key);
    if (got === undefined) problems.push(`${key} is in the lockfile but not in the package`);
    else if (got !== want) problems.push(`${key} is ${got} in the package but ${want} in the lockfile`);
  }
  for (const key of bundled.keys()) {
    if (!expected.has(key)) problems.push(`${key} is in the package but is not a locked runtime dependency`);
  }

  const helpers = [...files].filter(([rel]) => path.posix.basename(rel) === 'spawn-helper');
  if (helpers.length === 0) problems.push('no spawn-helper was found; node-pty needs it to start terminals on macOS');
  for (const [rel, entry] of helpers) {
    if ((entry.mode & 0o111) === 0) problems.push(`${rel} is not executable (mode ${entry.mode.toString(8)}); pack on Linux or macOS`);
  }
  return problems;
}

function main(argv) {
  let tarball = null;
  let version = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') version = argv[++i] ?? null;
    else tarball = argv[i];
  }
  if (!tarball) {
    console.error('Usage: node tests/package/check-tarball.mjs <tarball> [--version X.Y.Z]');
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const lock = JSON.parse(fs.readFileSync(path.resolve(here, '../../package-lock.json'), 'utf8'));
  const packed = fs.statSync(tarball).size;
  const entries = readTar(zlib.gunzipSync(fs.readFileSync(tarball)));
  const problems = checkPackage({ entries, lock, version });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  if (packed > MAX_PACKED_BYTES) problems.push(`the package is ${mb(packed)} MB packed; the limit is ${mb(MAX_PACKED_BYTES)} MB`);
  for (const problem of problems) console.error(`not ok  ${problem}`);
  if (problems.length > 0) return 1;
  const files = packageFiles(entries);
  const manifest = JSON.parse(files.get('package.json').body.toString('utf8'));
  const unpacked = [...files.values()].reduce((sum, entry) => sum + entry.size, 0);
  console.log(`ok  ${manifest.name}@${manifest.version}: ${files.size} files, ${mb(packed)} MB packed, ${mb(unpacked)} MB unpacked, ${bundledPackages(files).size} bundled packages`);
  return 0;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2));

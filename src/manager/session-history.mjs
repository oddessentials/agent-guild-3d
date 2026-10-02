// Past sessions of each coding tool, read from where the tool itself keeps
// them. Only the head of a transcript is read, and a file is parsed again
// only when its size or mtime changed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveCommand, buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { toIso } from './usage.mjs';

export const HISTORY_TTL_MS = 5 * 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;
const HEAD_BYTES = 256 * 1024;
const MAX_TITLE = 120;
const MAX_ID = 200;
const MAX_WALK_DEPTH = 4;

export class HistoryError extends Error {}

const TAG_RE = /^<[a-z][a-z0-9_-]*[\s>]/i;

function shortPath(file) {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

/** One line of prompt text, or null for an empty or tool-inserted (`<tag>…`) message. */
function promptTitle(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean || TAG_RE.test(clean)) return null;
  return clean.slice(0, MAX_TITLE);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n');
}

function parseLines(text) {
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* a cut-off or foreign line */ }
  }
  return records;
}

async function readHead(file, bytes = HEAD_BYTES) {
  if (file.endsWith('.zst')) {
    if (typeof zlib.createZstdDecompress !== 'function') return null;
    const source = fs.createReadStream(file);
    const inflate = source.pipe(zlib.createZstdDecompress());
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of inflate) {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= bytes) break;
      }
    } finally {
      source.destroy();
    }
    return Buffer.concat(chunks).subarray(0, bytes).toString('utf8');
  }
  const handle = await fs.promises.open(file, 'r');
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readDir(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw new HistoryError(`${shortPath(dir)} could not be read: ${err.message}`);
  }
}

async function readText(file) {
  try { return await fs.promises.readFile(file, 'utf8'); } catch { return null; }
}

function newestFirst(a, b) {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || (b.startedAt ?? '').localeCompare(a.startedAt ?? '') || a.id.localeCompare(b.id);
}

export function cleanEntry({ id, title, cwd, startedAt, updatedAt }) {
  const cleanId = String(id ?? '').trim();
  if (!cleanId || cleanId.length > MAX_ID || /\p{Cc}/u.test(cleanId)) return null;
  const folder = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : null;
  return {
    id: cleanId,
    title: typeof title === 'string' && title.trim() ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : null,
    cwd: folder,
    startedAt: toIso(startedAt),
    updatedAt: toIso(updatedAt),
  };
}

function dedupe(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const known = byId.get(entry.id);
    if (!known || newestFirst(entry, known) < 0) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort(newestFirst);
}

export class FileMemo {
  constructor() {
    this.entries = new Map();
  }

  async entry(file, stat, parse) {
    const known = this.entries.get(file);
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.entry;
    let entry = null;
    try { entry = await parse(); } catch { /* unreadable or not a transcript */ }
    this.entries.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, entry });
    return entry;
  }

  prune(root, seen) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    for (const file of this.entries.keys()) {
      if (file.startsWith(prefix) && !seen.has(file)) this.entries.delete(file);
    }
  }
}

async function statFile(file) {
  try {
    const stat = await fs.promises.stat(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

// ---- Claude Code ----------------------------------------------------------

export function claudeConfigDir(env = process.env) {
  return (env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')).normalize('NFC');
}

function claudeEntry(id, text, stat) {
  let cwd = null;
  let startedAt = null;
  let title = null;
  let seenUser = false;
  for (const record of parseLines(text)) {
    if (!record || typeof record !== 'object') continue;
    if (cwd === null && typeof record.cwd === 'string') cwd = record.cwd;
    if (startedAt === null && record.timestamp) startedAt = record.timestamp;
    if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) title = record.customTitle;
    if (record.type !== 'user' || record.isSidechain === true) continue;
    seenUser = true;
    if (title === null) title = promptTitle(contentText(record.message?.content));
  }
  if (cwd === null && !seenUser) return null;
  return cleanEntry({ id, title, cwd, startedAt, updatedAt: stat.mtime });
}

/** Sessions under `<dir>/projects/<folder>/<id>.jsonl`; sub-agent transcripts sit in sub-folders and are not listed. */
export async function listClaudeSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'projects');
  const entries = [];
  const seen = new Set();
  for (const project of await readDir(root)) {
    if (!project.isDirectory()) continue;
    const folder = path.join(root, project.name);
    for (const item of await readDir(folder)) {
      if (!item.isFile() || !item.name.endsWith('.jsonl')) continue;
      const file = path.join(folder, item.name);
      const stat = await statFile(file);
      if (!stat) continue;
      seen.add(file);
      const id = item.name.slice(0, -'.jsonl'.length);
      const entry = await memo.entry(file, stat, async () => claudeEntry(id, await readHead(file), stat));
      if (entry) entries.push(entry);
    }
  }
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- Codex CLI ------------------------------------------------------------

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function codexPrompt(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (record.type === 'event_msg') {
    if (payload.type === 'user_message') return promptTitle(payload.message);
    if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') return promptTitle(contentText(payload.item.content));
    return null;
  }
  if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') return promptTitle(contentText(payload.content));
  return null;
}

function codexEntry(text, stat) {
  const records = parseLines(text);
  const meta = records.find((r) => r?.type === 'session_meta')?.payload;
  if (!meta || typeof meta !== 'object') return null;
  const id = meta.id ?? meta.session_id;
  if (typeof meta.source === 'object' && meta.source !== null) return null;
  if (meta.parent_thread_id || (meta.thread_source && meta.thread_source !== 'user')) return null;
  let title = null;
  for (const record of records) {
    title = codexPrompt(record);
    if (title) break;
  }
  return cleanEntry({ id, title, cwd: meta.cwd, startedAt: meta.timestamp ?? records[0]?.timestamp, updatedAt: stat.mtime });
}

async function walk(dir, depth, onFile) {
  for (const item of await readDir(dir)) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (depth > 0) await walk(file, depth - 1, onFile);
    } else if (item.isFile()) await onFile(file, item.name);
  }
}

/** Rollouts under `<dir>/sessions/YYYY/MM/DD/rollout-*.jsonl`, uncompressed or zstd-compressed. Sub-agent threads are skipped. */
export async function listCodexSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'sessions');
  const entries = [];
  const seen = new Set();
  await walk(root, MAX_WALK_DEPTH, async (file, name) => {
    if (!/^rollout-.*\.jsonl(\.zst)?$/.test(name)) return;
    const stat = await statFile(file);
    if (!stat) return;
    seen.add(file);
    const entry = await memo.entry(file, stat, async () => {
      const head = await readHead(file);
      return head === null ? null : codexEntry(head, stat);
    });
    if (entry) entries.push(entry);
  });
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- Gemini CLI -----------------------------------------------------------

export function geminiDir(env = process.env) {
  return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini');
}

function geminiPrompt(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.type === 'user' && record.id !== undefined) {
    const text = contentText(record.content);
    return /^[/?]/.test(text.trim()) ? null : promptTitle(text);
  }
  const checkpoint = record.$set?.messages;
  if (Array.isArray(checkpoint)) {
    for (const message of checkpoint) {
      const title = geminiPrompt(message);
      if (title) return title;
    }
  }
  return null;
}

function geminiEntry(text, stat, cwd, legacy) {
  let meta;
  let records;
  if (legacy) {
    try { meta = JSON.parse(text); } catch { return null; }
    records = Array.isArray(meta?.messages) ? meta.messages : [];
  } else {
    records = parseLines(text);
    meta = records.shift();
  }
  if (!meta || typeof meta !== 'object' || typeof meta.sessionId !== 'string') return null;
  if (meta.kind === 'subagent') return null;
  let title = typeof meta.summary === 'string' && meta.summary.trim() ? meta.summary : null;
  for (const record of records) {
    if (title) break;
    title = geminiPrompt(record);
  }
  return cleanEntry({ id: meta.sessionId, title, cwd, startedAt: meta.startTime, updatedAt: stat.mtime });
}

/** The project folder a Gemini CLI temp folder stands for: its `.project_root` marker, else the registry in `projects.json`. */
async function geminiProjectRoots(root, folders) {
  const roots = new Map();
  let registry = null;
  for (const folder of folders) {
    const marker = (await readText(path.join(root, folder, '.project_root')))?.trim();
    if (marker) {
      roots.set(folder, marker);
      continue;
    }
    if (registry === null) {
      let projects = {};
      try { projects = JSON.parse(await readText(path.join(path.dirname(root), 'projects.json')))?.projects ?? {}; } catch { /* no registry */ }
      registry = new Map(Object.entries(projects).map(([dir, slug]) => [slug, dir]));
    }
    roots.set(folder, registry.get(folder) ?? null);
  }
  return roots;
}

/** Chats under `<dir>/tmp/<project>/chats/session-*.jsonl` (older versions: `.json`). Sub-agent chats sit in sub-folders. */
export async function listGeminiSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'tmp');
  const entries = [];
  const seen = new Set();
  const folders = (await readDir(root)).filter((item) => item.isDirectory()).map((item) => item.name);
  const roots = await geminiProjectRoots(root, folders);
  for (const folder of folders) {
    const chats = path.join(root, folder, 'chats');
    for (const item of await readDir(chats)) {
      const legacy = item.name.endsWith('.json');
      if (!item.isFile() || !item.name.startsWith('session-') || !(legacy || item.name.endsWith('.jsonl'))) continue;
      const file = path.join(chats, item.name);
      const stat = await statFile(file);
      if (!stat) continue;
      seen.add(file);
      const cwd = roots.get(folder);
      const entry = await memo.entry(file, stat, async () => geminiEntry(legacy ? await readText(file) : await readHead(file), stat, cwd, legacy));
      if (entry) entries.push(entry);
    }
  }
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- Grok Build -----------------------------------------------------------

export function grokHome(env = process.env) {
  return env.GROK_HOME || path.join(os.homedir(), '.grok');
}

/** The folder a Grok Build session bucket stands for: its percent-encoded name, else its `.cwd` file. */
async function grokBucketCwd(bucket) {
  let decoded = null;
  try { decoded = decodeURIComponent(path.basename(bucket)); } catch { /* not percent-encoded */ }
  if (decoded && (decoded.startsWith('/') || /^[A-Za-z]:[\\/]/.test(decoded))) return decoded;
  return (await readText(path.join(bucket, '.cwd')))?.trim() || null;
}

function grokPrompt(text) {
  const parts = [];
  let promptId;
  for (const record of parseLines(text)) {
    const update = record?.params?.update;
    if (update?.sessionUpdate !== 'user_message_chunk' || update.content?.type !== 'text') continue;
    if (update.content._meta?.bash_command || update._meta?.host_turn === true) continue;
    const id = record.params._meta?.promptId ?? null;
    if (parts.length && id !== promptId) break;
    promptId = id;
    parts.push(update.content.text);
  }
  return promptTitle(parts.join(''));
}

async function grokEntry(folder, summary, stat, bucketCwd) {
  const info = summary?.info;
  if (!summary || typeof summary !== 'object') return null;
  if (summary.hidden === true || String(summary.session_kind ?? '').startsWith('subagent')) return null;
  let title = [summary.generated_title, summary.session_summary].find((t) => typeof t === 'string' && t.trim()) ?? null;
  if (summary.num_messages === 0 && !title) return null;
  if (title === null) {
    const updates = await readHead(path.join(folder, 'updates.jsonl')).catch(() => null);
    if (updates) title = grokPrompt(updates);
  }
  return cleanEntry({
    id: info?.id ?? path.basename(folder),
    title,
    cwd: typeof info?.cwd === 'string' && info.cwd ? info.cwd : bucketCwd,
    startedAt: summary.created_at,
    updatedAt: summary.last_active_at ?? summary.updated_at ?? stat.mtime,
  });
}

/** Sessions under `<dir>/sessions/<percent-encoded folder>/<id>/summary.json`. Hidden and sub-agent sessions are skipped. */
export async function listGrokSessions(dir, memo = new FileMemo()) {
  const root = path.join(dir, 'sessions');
  const entries = [];
  const seen = new Set();
  for (const bucket of await readDir(root)) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(root, bucket.name);
    const cwd = await grokBucketCwd(bucketDir);
    for (const item of await readDir(bucketDir)) {
      if (!item.isDirectory()) continue;
      const folder = path.join(bucketDir, item.name);
      const file = path.join(folder, 'summary.json');
      const stat = await statFile(file);
      if (!stat) continue;
      seen.add(file);
      const entry = await memo.entry(file, stat, async () => grokEntry(folder, JSON.parse(await readText(file)), stat, cwd));
      if (entry) entries.push(entry);
    }
  }
  memo.prune(root, seen);
  return dedupe(entries);
}

// ---- any command that prints JSON ------------------------------------------

export async function commandHistory({ command, args = [] }, env, platform = process.platform) {
  const resolved = resolveCommand(command, env, platform);
  if (!resolved) throw new HistoryError(`history command "${command}" was not found on PATH`);
  const spec = buildSpawnSpec(resolved, args, env, platform);
  let stdout;
  try {
    ({ stdout } = await runSpec(spec, { env }));
  } catch (err) {
    throw new HistoryError(`history command failed: ${String(err.stderr || err.message).trim().slice(0, 200)}`);
  }
  let body;
  try { body = JSON.parse(stdout); } catch { throw new HistoryError('history command did not print JSON'); }
  if (!Array.isArray(body?.sessions)) throw new HistoryError('history command output has no "sessions" array');
  return dedupe(body.sessions.map((s) => (s && typeof s === 'object' ? cleanEntry(s) : null)).filter(Boolean));
}

// ---- monitor ----------------------------------------------------------------

export class SessionHistory {
  /**
   * @param {object} opts
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry
   * @param {object} [opts.env]
   * @param {number} [opts.ttlMs]
   * @param {object} [opts.readers]  session listers by source, replaceable in tests
   */
  constructor({ registry, env = process.env, platform = process.platform, ttlMs = HISTORY_TTL_MS, readers = {} } = {}) {
    this.registry = registry;
    this.env = env;
    this.platform = platform;
    this.ttlMs = ttlMs;
    this.readers = { claude: listClaudeSessions, codex: listCodexSessions, gemini: listGeminiSessions, grok: listGrokSessions, ...readers };
    this.memo = new FileMemo();
    this.cache = new Map();
  }

  static sourceDir(source, env) {
    if (source === 'claude') return claudeConfigDir(env);
    if (source === 'codex') return codexHome(env);
    if (source === 'gemini') return geminiDir(env);
    if (source === 'grok') return grokHome(env);
    return null;
  }

  async list(provider, account = this.registry.account(provider), { limit } = {}) {
    const n = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || DEFAULT_LIMIT));
    const snapshot = await this.snapshot(provider, account);
    return { ...snapshot, sessions: snapshot.sessions.slice(0, n) };
  }

  snapshot(provider, account) {
    const key = `${provider.id}\0${account.id}`;
    const entry = this.cache.get(key);
    const now = Date.now();
    if (entry?.inflight) return entry.inflight;
    if (entry && now - entry.at < this.ttlMs) return Promise.resolve(entry.snapshot);
    const inflight = this._read(provider, account).then((snapshot) => {
      this.cache.set(key, { snapshot, at: Date.now() });
      return snapshot;
    });
    this.cache.set(key, { ...entry, inflight });
    return inflight;
  }

  async _read(provider, account) {
    const base = { providerId: provider.id, accountId: account.id, sessions: [], total: 0, fetchedAt: new Date().toISOString(), error: null };
    const env = { ...this.env, ...provider.env, ...account.env };
    try {
      const sessions = typeof provider.history === 'string'
        ? await this.readers[provider.history](SessionHistory.sourceDir(provider.history, env), this.memo)
        : await commandHistory(provider.history, env, this.platform);
      return { ...base, sessions, total: sessions.length };
    } catch (err) {
      const message = err instanceof HistoryError ? err.message : `history could not be read: ${err.message}`;
      return { ...base, error: message };
    }
  }
}

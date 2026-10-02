import { EventEmitter } from 'node:events';
import { compareVersions } from './versions.mjs';
import { FeedError, USER_AGENT, decodeEntities, failure, readBody, refusal, webUrl } from './news.mjs';

const REPOSITORY = 'oddessentials/agent-guild';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`;
const TTL_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const MISSING_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHANGES = 100;
const MAX_NOTES = 20000;
const MAX_LINE = 1000;
const RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;
const VERSION_HEADING = /^v?\d+\.\d+\.\d+(?![\d.])/;
const INSTALL_STEPS = /^install or update$/i;
const COMMIT_LINK = /\s*\(\[[0-9a-f]{7,40}\]\([^)\s]*\)\)/gi;
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|!\[[^\]]*\]\([^)]*\)|<(https?:\/\/[^>\s]+)>|\[([^\]]+)\]\(([^)\s]+)\)|<\/?[a-z][^>]*>/gi;

const iso = (time) => (time ? new Date(time).toISOString() : null);

function textRun(text, strong) {
  return strong ? { text: decodeEntities(text), strong: true } : { text: decodeEntities(text) };
}

function inline(source, strong = false) {
  const runs = [];
  let at = 0;
  for (const match of source.matchAll(INLINE)) {
    if (match.index > at) runs.push(textRun(source.slice(at, match.index), strong));
    const [, bold, code, autolink, label, href] = match;
    if (bold !== undefined) {
      runs.push(...inline(bold, true));
    } else if (code !== undefined) {
      runs.push({ ...(strong && { strong: true }), text: code, code: true });
    } else if (autolink !== undefined || label !== undefined) {
      const url = webUrl(autolink ?? href);
      runs.push({ ...textRun(label ?? autolink, strong), ...(url && { url }) });
    }
    at = match.index + match[0].length;
  }
  if (at < source.length) runs.push(textRun(source.slice(at), strong));
  return runs;
}

const sameStyle = (a, b) => !a.url && !b.url && Boolean(a.code) === Boolean(b.code) && Boolean(a.strong) === Boolean(b.strong);

function tidy(runs) {
  const tidied = [];
  for (const run of runs) {
    const text = run.text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
    if (!text) continue;
    const last = tidied.at(-1);
    if (last && sameStyle(last, run)) last.text += text;
    else tidied.push({ ...run, text });
  }
  if (tidied.length) {
    tidied[0].text = tidied[0].text.trimStart();
    tidied.at(-1).text = tidied.at(-1).text.trimEnd();
  }
  return tidied.filter((run) => run.text);
}

function plain(source) {
  return tidy(inline(source)).map((run) => run.text).join('');
}

export function parseNotes(markdown) {
  const sections = [];
  let section = null;
  let change = null;
  let skipping = false;
  let fenced = false;
  let count = 0;
  for (const whole of String(markdown ?? '').slice(0, MAX_NOTES).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const line = whole.slice(0, MAX_LINE);
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      change = null;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const title = plain(heading[1]);
      change = null;
      section = null;
      skipping = INSTALL_STEPS.test(title);
      if (title && !skipping && !VERSION_HEADING.test(title)) sections.push(section = { title, changes: [] });
      continue;
    }
    if (skipping) continue;
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      change = null;
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    const body = (bullet ? bullet[1] : line.replace(/^\s*(?:>\s?)+/, '')).trim();
    if (!body) {
      change = null;
      continue;
    }
    const runs = tidy(inline(body.replace(COMMIT_LINK, '')));
    if (runs.length === 0) continue;
    if (!bullet && change) {
      change.splice(0, change.length, ...tidy([...change, { text: ' ' }, ...runs]));
      continue;
    }
    if (count === MAX_CHANGES) break;
    if (!section) sections.push(section = { title: null, changes: [] });
    section.changes.push(change = runs);
    count++;
  }
  return sections.filter((s) => s.changes.length > 0);
}

export function parseReleases(json) {
  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new FeedError('sent no releases');
  const releases = new Map();
  for (const release of list) {
    if (!release || typeof release !== 'object' || release.draft || release.prerelease) continue;
    const tag = String(release.tag_name ?? '');
    const version = RELEASE_TAG.exec(tag)?.[1];
    if (!version || releases.has(version)) continue;
    const published = Date.parse(release.published_at);
    releases.set(version, {
      version,
      url: webUrl(String(release.html_url ?? '')) ?? `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
      publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
      sections: parseNotes(typeof release.body === 'string' ? release.body : ''),
    });
  }
  return [...releases.values()].sort((a, b) => compareVersions(b.version, a.version));
}

export class Changelog extends EventEmitter {
  constructor({
    latest = () => null, fetchImpl = fetch, url = API_URL,
    ttlMs = TTL_MS, retryMs = RETRY_MS, missingMs = MISSING_MS, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES,
  } = {}) {
    super();
    this.latest = latest;
    this.fetchImpl = fetchImpl;
    this.url = url;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.missingMs = missingMs;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.releases = [];
    this.etag = null;
    this.checkedAt = 0;
    this.okAt = 0;
    this.error = null;
    this.refreshing = null;
  }

  snapshot() {
    this._refreshDue();
    return { refreshing: Boolean(this.refreshing), okAt: iso(this.okAt), error: this.error, releases: this.releases };
  }

  _refreshDue() {
    if (this.refreshing) return;
    const latest = this.latest();
    const missing = Boolean(latest) && !this.releases.some((release) => release.version === latest);
    const wait = this.error ? this.retryMs : missing ? this.missingMs : this.ttlMs;
    if (Date.now() - this.checkedAt < wait) return;
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null;
      this.emit('updated');
    });
  }

  async _refresh() {
    this.checkedAt = Date.now();
    try {
      const headers = { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      if (this.etag) headers['If-None-Match'] = this.etag;
      const res = await this.fetchImpl(this.url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status !== 304) {
        if (!res.ok) throw new FeedError(refusal(res));
        this.releases = parseReleases(await readBody(res, this.maxBytes));
        this.etag = res.headers.get('etag');
      }
      this.error = null;
      this.okAt = Date.now();
    } catch (err) {
      this.error = failure(err, this.timeoutMs);
    }
  }
}

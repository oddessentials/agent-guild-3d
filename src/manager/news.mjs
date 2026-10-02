import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { VERSION } from './config.mjs';

const TTL_MS = 30 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const RELEASE_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const MAX_BYTES = 5 * 1024 * 1024;
const CONCURRENCY = 4;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_MS = 2 * 24 * 60 * 60 * 1000;
const LIMITS = { news: 20, releases: 5, research: 10 };
const TITLE_MAX = 300;
const SUMMARY_MAX = 240;
const RAW_MAX = 8000;
export const USER_AGENT = `agent-guild/${VERSION} (+https://github.com/oddessentials/agent-guild)`;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

const latestRelease = (id, name, repo, provider) => ({
  id, name, category: 'releases', provider, format: 'github', every: RELEASE_TTL_MS,
  url: `https://api.github.com/repos/${repo}/releases/latest`,
});

export const FEEDS = [
  { id: 'openai', name: 'OpenAI', category: 'news', url: 'https://openai.com/news/rss.xml' },
  { id: 'google-deepmind', name: 'Google DeepMind', category: 'news', url: 'https://deepmind.google/blog/rss.xml' },
  { id: 'google-ai', name: 'Google AI', category: 'news', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { id: 'hugging-face', name: 'Hugging Face', category: 'news', url: 'https://huggingface.co/blog/feed.xml' },
  { id: 'ollama-blog', name: 'Ollama', category: 'news', url: 'https://ollama.com/blog/rss.xml' },
  latestRelease('claude-code', 'Claude Code', 'anthropics/claude-code', 'anthropic'),
  latestRelease('codex-cli', 'Codex CLI', 'openai/codex', 'openai'),
  latestRelease('gemini-cli', 'Gemini CLI', 'google-gemini/gemini-cli', 'google'),
  { id: 'ollama', name: 'Ollama', category: 'releases', url: 'https://github.com/ollama/ollama/releases.atom' },
  { id: 'llama-cpp', name: 'llama.cpp', category: 'releases', url: 'https://github.com/ggml-org/llama.cpp/releases.atom' },
  { id: 'transformers', name: 'Transformers', category: 'releases', url: 'https://github.com/huggingface/transformers/releases.atom' },
  { id: 'arxiv-cs-cl', name: 'arXiv cs.CL', category: 'research', filter: true, url: 'https://export.arxiv.org/rss/cs.CL' },
  { id: 'arxiv-cs-ai', name: 'arXiv cs.AI', category: 'research', filter: true, url: 'https://export.arxiv.org/rss/cs.AI' },
  { id: 'simon-willison', name: 'Simon Willison\'s Weblog', category: 'news', url: 'https://simonwillison.net/atom/everything/' },
  { id: 'interconnects', name: 'Interconnects', category: 'news', url: 'https://www.interconnects.ai/feed' },
  { id: 'lil-log', name: 'Lil\'Log', category: 'news', url: 'https://lilianweng.github.io/index.xml' },
  {
    id: 'hacker-news', name: 'Hacker News', category: 'news', format: 'hn', filter: true,
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E%3D50&hitsPerPage=100&attributesToRetrieve=title,url,created_at,points,num_comments,objectID&attributesToHighlight=none',
  },
  { id: 'llm-digest', name: 'LLM Digest', category: 'news', url: 'https://www.llm-digest.com/rss.xml' },
  { id: 'slashdot', name: 'Slashdot', category: 'news', filter: true, url: 'https://rss.slashdot.org/Slashdot/slashdotMain' },
  { id: 'slashdot-developers', name: 'Slashdot', category: 'news', filter: true, url: 'https://rss.slashdot.org/Slashdot/slashdotDevelopers' },
];

const TERMS = /\bagents?\b|\bagentic\b|\bmulti[-\s]?agents?\b|\btool[-\s]?use\b|\bmcp\b|\bollama\b|\bllama\.cpp\b|\bllamacpp\b|\bggml\b|\bgguf\b|\bopen[-\s]?weights?\b|\blocal[-\s]+models?\b|\bvllm\b|\bsglang\b|\bquanti[sz]\w*\b/i;
const TRACKING = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src']);
const ARXIV_PATH = /^\/(?:abs|pdf|html)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i;
const PRERELEASE = /(?:^|[^a-z])(?:alpha|beta|rc|nightly|preview|canary|dev|pre)(?![a-z])/i;
const ARXIV_PREFIX = /^arXiv:\S+\s+Announce Type:\s*[\w-]+\s+Abstract:\s*/i;
const ENTRY = /<((?:[\w-]+:)?(?:item|entry))\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const DATE_FIELDS = ['pubDate', 'published', 'dc:date', 'updated', 'issued', 'modified'];
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: '',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', prime: '′', Prime: '″', copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷',
  euro: '€', pound: '£', cent: '¢', yen: '¥', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', eacute: 'é', egrave: 'è', ecirc: 'ê', iacute: 'í', oacute: 'ó', ouml: 'ö',
  uacute: 'ú', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
};

export class FeedError extends Error {}

const fields = new Map();
const attrs = new Map();

export function matchesTerms(title, text = '') {
  return TERMS.test(`${title}\n${text}`);
}

export function decodeEntities(text) {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z][a-z0-9]{1,31}));/gi, (match, dec, hex, name) => {
    if (name) return Object.hasOwn(NAMED, name) ? NAMED[name] : match;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function tidy(text) {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

function stripTags(html) {
  return html
    .replace(/<(script|style|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|section|article|header|footer|figure|figcaption|hr)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/<[^>]*$/, '');
}

export function clip(text, max) {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  if (space >= max * 0.6) cut = cut.slice(0, space);
  return `${cut.replace(/[\s.,;:–—-]+$/, '')}…`;
}

function protect(xml) {
  const blocks = [];
  const text = xml
    .replace(/\u0000/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => `\u0000${blocks.push(inner) - 1}\u0000`)
    .replace(/<!--[\s\S]*?-->/g, '');
  return { text, blocks };
}

function xmlText(inner, blocks) {
  return inner.split(/\u0000(\d+)\u0000/).map((part, i) => (i % 2 ? blocks[Number(part)] ?? '' : decodeEntities(part))).join('');
}

function field(raw, name) {
  let re = fields.get(name);
  if (!re) fields.set(name, (re = new RegExp(`<${name}(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name}\\s*>)`, 'i')));
  const match = re.exec(raw);
  return match ? { attrs: match[1] ?? '', inner: match[2] ?? '' } : null;
}

function attr(source, name) {
  let re = attrs.get(name);
  if (!re) attrs.set(name, (re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')));
  const match = re.exec(source);
  return match ? decodeEntities(match[1] ?? match[2]) : null;
}

function textOf(found, blocks, { html, max = RAW_MAX }) {
  const type = attr(found.attrs, 'type');
  const source = xmlText(found.inner.slice(0, max), blocks).slice(0, max);
  return tidy(decodeEntities((type ? /html/i.test(type) : html) ? stripTags(source) : source));
}

export function webUrl(value, base) {
  try {
    const url = new URL(String(value).trim(), base);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.href.length > 2000) return null;
    return url.href;
  } catch {
    return null;
  }
}

function entryLink(raw, blocks, base) {
  const links = [...raw.matchAll(/<link\b([^>]*)>/gi)]
    .map(([, found]) => ({ href: attr(found, 'href'), rel: attr(found, 'rel') ?? 'alternate', type: attr(found, 'type') }))
    .filter((link) => link.href);
  const alternate = links.find((link) => link.rel === 'alternate' && (!link.type || /html/i.test(link.type))) ?? links.find((link) => link.rel === 'alternate');
  if (alternate) return webUrl(alternate.href, base);
  const text = field(raw, 'link');
  if (text && text.inner.trim()) return webUrl(tidy(xmlText(text.inner, blocks)), base);
  const guid = field(raw, 'guid');
  return guid && attr(guid.attrs, 'isPermaLink') !== 'false' ? webUrl(tidy(xmlText(guid.inner, blocks)), base) : null;
}

function entryDate(raw, blocks) {
  for (const name of DATE_FIELDS) {
    const found = field(raw, name);
    if (!found) continue;
    const time = Date.parse(tidy(xmlText(found.inner, blocks)));
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function feedEntries(xml) {
  const { text, blocks } = protect(xml);
  if (!/<(?:[\w-]+:)?(?:rss|feed|RDF)\b/i.test(text)) throw new FeedError('did not send a feed');
  return [...text.matchAll(ENTRY)].map(([, , raw]) => ({ raw, blocks, date: entryDate(raw, blocks) }));
}

function readEntry({ raw, blocks }, base) {
  const title = field(raw, 'title');
  const body = [['summary', false], ['description', true], ['content:encoded', true], ['content', false]]
    .map(([name, html]) => [field(raw, name), html])
    .find(([found]) => found);
  const announce = field(raw, 'arxiv:announce_type');
  return {
    title: title ? clip(textOf(title, blocks, { html: false, max: Infinity }), TITLE_MAX) : '',
    link: entryLink(raw, blocks, base),
    text: body ? textOf(body[0], blocks, { html: body[1] }).replace(ARXIV_PREFIX, '') : '',
    announce: announce ? tidy(xmlText(announce.inner, blocks)) : null,
  };
}

export function parseFeed(xml, base) {
  return feedEntries(xml).map((entry) => ({ ...readEntry(entry, base), date: entry.date }));
}

function count(value, word) {
  return Number.isInteger(value) && value >= 0 ? `${value} ${word}${value === 1 ? '' : 's'}` : null;
}

export function parseHackerNews(text) {
  const hits = JSON.parse(text)?.hits;
  if (!Array.isArray(hits)) throw new FeedError('sent no stories');
  return hits.filter((hit) => hit && typeof hit === 'object').map((hit) => {
    const id = String(hit.objectID ?? '');
    const thread = /^\d+$/.test(id) ? `https://news.ycombinator.com/item?id=${id}` : null;
    const link = (typeof hit.url === 'string' && webUrl(hit.url)) || thread;
    return {
      title: clip(tidy(decodeEntities(String(hit.title ?? ''))), TITLE_MAX),
      link,
      text: [count(hit.points, 'point'), count(hit.num_comments, 'comment')].filter(Boolean).join(' · '),
      discussion: link === thread ? null : thread,
      date: Date.parse(hit.created_at),
    };
  });
}

export function markdownText(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:#{1,6}\s|\*\*full changelog\b|full changelog\b)/i.test(line))
    .map((line) => tidy(decodeEntities(line
      .replace(/^\s*(?:[-*+]\s+|\d+\.\s+|>\s*)/, '')
      .replace(/^#\d+\s+|\s*\(#\d+\)/g, '')
      .replace(/\s+by @[\w-]+(?:\s+in\s+\S+)?/g, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`~]+/g, ''))))
    .filter(Boolean)
    .join(' · ');
}

export function releaseTitle(name, title) {
  const label = title.replace(/^(?:patch\s+)?release\b:?\s*/i, '').replace(/^rust-(?=v?\d)/i, '').trim() || title;
  return label.toLowerCase().startsWith(name.toLowerCase()) ? label : `${name} ${label}`;
}

export function parseGithubRelease(text, name) {
  const release = JSON.parse(text);
  if (!release || typeof release !== 'object' || typeof release.tag_name !== 'string') throw new FeedError('sent no release');
  if (release.draft || release.prerelease) return [];
  return [{
    title: releaseTitle(name, tidy(String(release.name || release.tag_name))),
    link: webUrl(release.html_url ?? ''),
    text: markdownText(release.body ?? ''),
    date: Date.parse(release.published_at),
  }];
}

function releaseTag(link) {
  const tag = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^/?#]+)/i.exec(link)?.[1];
  if (!tag) return null;
  try {
    return decodeURIComponent(tag);
  } catch {
    return tag;
  }
}

export function isPrerelease(tag) {
  return PRERELEASE.test(tag);
}

const tracking = (key) => /^utm_/i.test(key) || TRACKING.has(key.toLowerCase());

export function cleanUrl(link) {
  const url = new URL(link);
  const keys = [...url.searchParams.keys()].filter(tracking);
  if (keys.length === 0) return link;
  for (const key of keys) url.searchParams.delete(key);
  return url.href;
}

export function canonicalUrl(link) {
  const url = new URL(link);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const port = url.port && url.port !== '80' && url.port !== '443' ? `:${url.port}` : '';
  let path = url.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const arxiv = host.endsWith('arxiv.org') ? ARXIV_PATH.exec(path) : null;
  if (arxiv) path = `/abs/${arxiv[1]}`;
  const query = [...url.searchParams]
    .filter(([key]) => !tracking(key))
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  return `${host}${port}${path}${query.length ? `?${new URLSearchParams(query)}` : ''}`;
}

function summaryFor(text, title) {
  const rest = text.toLowerCase().startsWith(title.toLowerCase()) ? text.slice(title.length).replace(/^[\s.,;:–—-]+/, '') : text;
  return clip(rest, SUMMARY_MAX);
}

function select(feed, entries, now) {
  const fresh = entries
    .filter((entry) => Number.isFinite(entry.date) && entry.date - now <= FUTURE_MS && now - entry.date <= WINDOW_MS)
    .sort((a, b) => b.date - a.date);
  const items = [];
  for (const entry of fresh) {
    if (items.length >= LIMITS[feed.category]) break;
    const found = entry.raw === undefined ? entry : { ...readEntry(entry, feed.url), date: entry.date };
    if (!found.title || !found.link) continue;
    if (found.announce && /^replace/i.test(found.announce)) continue;
    const release = feed.category === 'releases' && feed.format !== 'github';
    const tag = releaseTag(found.link) ?? (release ? found.title.split(' ')[0] : null);
    if (tag && isPrerelease(tag)) continue;
    if (feed.filter && !matchesTerms(found.title, found.text)) continue;
    const key = canonicalUrl(found.link);
    items.push({
      key,
      id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16),
      title: release ? releaseTitle(feed.name, found.title) : found.title,
      url: cleanUrl(found.link),
      discussion: found.discussion ?? null,
      summary: summaryFor(found.text, found.title),
      date: found.date,
      time: Math.min(found.date, now),
    });
  }
  return items;
}

function merge(previous, fresh, limit, now) {
  const byKey = new Map(previous.filter((item) => now - item.time <= WINDOW_MS).map((item) => [item.key, item]));
  for (const item of fresh) {
    const stored = byKey.get(item.key);
    if (stored?.date === item.date) item.time = stored.time;
    byKey.set(item.key, item);
  }
  return [...byKey.values()].sort((a, b) => b.time - a.time).slice(0, limit);
}

export async function readBody(res, maxBytes) {
  const tooLarge = () => new FeedError(`sent more than ${maxBytes / 1024 / 1024} MB`);
  if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1]
    ?? /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)/i.exec(bytes.subarray(0, 256).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

export function refusal(res) {
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') return 'GitHub API rate limit exceeded';
  return `HTTP ${res.status}`;
}

export function failure(err, timeoutMs) {
  if (err instanceof FeedError) return err.message;
  if (err?.name === 'TimeoutError') return `did not answer within ${timeoutMs / 1000} seconds`;
  if (err instanceof SyntaxError) return 'sent data that could not be read';
  return `could not be reached (${err?.cause?.code || err?.message || 'unknown error'})`;
}

const iso = (time) => (time ? new Date(time).toISOString() : null);

export class NewsFeed extends EventEmitter {
  constructor({
    registry = null, feeds = FEEDS, fetchImpl = fetch, ttlMs = TTL_MS, retryMs = RETRY_MS, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_BYTES,
  } = {}) {
    super();
    this.registry = registry;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.states = feeds.map((feed) => ({ feed, items: [], etag: null, lastModified: null, checkedAt: 0, okAt: 0, error: null }));
    this.refreshedAt = 0;
    this.refreshing = null;
  }

  snapshot() {
    const active = this.states.filter((state) => !state.feed.provider || this._installed(state.feed.provider));
    this._refreshDue(active);
    return this._describe(active);
  }

  _installed(id) {
    const provider = this.registry?.providers?.find((p) => p.id === id);
    try {
      return Boolean(provider && this.registry.resolve(provider));
    } catch {
      return false;
    }
  }

  _refreshDue(active) {
    if (this.refreshing) return;
    const now = Date.now();
    const due = active.filter((state) => now - state.checkedAt >= (state.error ? this.retryMs : state.feed.every ?? this.ttlMs));
    if (due.length === 0) return;
    this.refreshing = this._refresh(due).finally(() => {
      this.refreshing = null;
      this.emit('updated');
    });
  }

  async _refresh(states) {
    const queue = [...states];
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) await this._update(queue.shift());
    }));
    this.refreshedAt = Date.now();
  }

  async _update(state) {
    const { feed } = state;
    state.checkedAt = Date.now();
    try {
      const headers = { 'User-Agent': USER_AGENT, Accept: feed.format === 'github' ? 'application/vnd.github+json' : feed.format === 'hn' ? 'application/json' : FEED_ACCEPT };
      if (feed.format === 'github') headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (state.etag) headers['If-None-Match'] = state.etag;
      if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
      const res = await this.fetchImpl(feed.url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status !== 304) {
        if (!res.ok) throw new FeedError(refusal(res));
        const text = await readBody(res, this.maxBytes);
        const entries = feed.format === 'hn' ? parseHackerNews(text) : feed.format === 'github' ? parseGithubRelease(text, feed.name) : feedEntries(text);
        const now = Date.now();
        state.items = merge(state.items, select(feed, entries, now), LIMITS[feed.category], now);
        state.etag = res.headers.get('etag');
        state.lastModified = res.headers.get('last-modified');
      }
      state.error = null;
      state.okAt = Date.now();
    } catch (err) {
      state.error = failure(err, this.timeoutMs);
    }
  }

  _describe(active) {
    const now = Date.now();
    const taken = new Set();
    const items = [];
    for (const { feed, items: own } of active) {
      for (const item of own) {
        if (now - item.time > WINDOW_MS || taken.has(item.key)) continue;
        taken.add(item.key);
        items.push({ feed, item });
      }
    }
    items.sort((a, b) => b.item.time - a.item.time);
    return {
      refreshedAt: iso(this.refreshedAt),
      refreshing: Boolean(this.refreshing),
      sources: active.map(({ feed, error, okAt }) => ({ id: feed.id, name: feed.name, category: feed.category, error, okAt: iso(okAt) })),
      items: items.map(({ feed, item }) => ({
        id: item.id,
        title: item.title,
        url: item.url,
        discussion: item.discussion,
        summary: item.summary,
        source: feed.name,
        sourceId: feed.id,
        category: feed.category,
        publishedAt: iso(item.time),
      })),
    };
  }
}

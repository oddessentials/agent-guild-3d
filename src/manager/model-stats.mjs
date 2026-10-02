import { toNumber } from './usage.mjs';

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20000;
const NEW_MS = 30 * 24 * 60 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?::[a-z0-9-]+)?$/;

const AA = 'Artificial Analysis';
const DA_MODELS = 'Design Arena · Models';
const DA_AGENTS = 'Design Arena · Agents';

const STATS = [
  {
    id: 'coding', label: 'Coding Index', short: 'Coding', group: AA, index: 'coding_index',
    about: 'How well the model writes and fixes code, scored by Artificial Analysis on coding evaluations such as Terminal-Bench (real tasks in a terminal). When building: working code with fewer retries.',
  },
  {
    id: 'intelligence', label: 'Intelligence Index', short: 'Intelligence', group: AA, index: 'intelligence_index',
    about: 'Artificial Analysis\'s overall score across its evaluations of agentic work, coding, scientific reasoning and general knowledge. When building: understanding what you ask, planning changes, solving hard problems.',
  },
  {
    id: 'agentic', label: 'Agentic Index', short: 'Agentic', group: AA, index: 'agentic_index',
    about: 'How well the model completes multi-step tasks on its own, using tools until the job is done (Artificial Analysis). When building: longer agent runs that stay on track without your help.',
  },
  {
    id: 'overall', label: 'Overall', group: DA_MODELS, arena: 'models', category: 'codecategories',
    about: 'Design Arena\'s combined result for Website, UI Component, Game Dev, Data Visualization and 3D, judged by real users\' votes. When building: overall front-end quality.',
  },
  {
    id: 'website', label: 'Website', group: DA_MODELS, arena: 'models', category: 'website',
    about: 'Complete websites built as one HTML file from real users\' prompts; users vote for the better one. When building: landing pages and site layouts.',
  },
  {
    id: 'uicomponent', label: 'UI Component', group: DA_MODELS, arena: 'models', category: 'uicomponent',
    about: 'Focused interface components as one HTML file; users vote. When building: individual pieces of an interface.',
  },
  {
    id: 'gamedev', label: 'Game Dev', group: DA_MODELS, arena: 'models', category: 'gamedev',
    about: 'Playable browser games as one HTML file; users play them and vote. When building: interactive, game-like front ends.',
  },
  {
    id: 'dataviz', label: 'Data Visualization', group: DA_MODELS, arena: 'models', category: 'dataviz',
    about: 'Interactive visualizations of provided data as one HTML file; users vote. When building: charts and dashboards.',
  },
  {
    id: '3d', label: '3D', group: DA_MODELS, arena: 'models', category: '3d',
    about: 'Interactive 3D experiences in the browser as one HTML file; users try them and vote. When building: 3D scenes.',
  },
  {
    id: 'svg', label: 'SVG', group: DA_MODELS, arena: 'models', category: 'svg',
    about: 'Scalable vector graphics as SVG markup: icons, illustrations, diagrams. When building: graphics as code.',
  },
  {
    id: 'webapps', label: 'Web Apps', group: DA_AGENTS, arena: 'agents', category: 'webapps',
    about: 'Multi-file React front ends built by the model as an agent over many steps; users compare results. When building: the multi-file work a coding agent does.',
  },
  {
    id: 'fullstack', label: 'Full Stack', group: DA_AGENTS, arena: 'agents', category: 'fullstack',
    about: 'Complete React apps with sign-in, a database and a back end, built by the model as an agent. When building: whole applications, not just pages.',
  },
  {
    id: 'mobileapps', label: 'Mobile Apps', group: DA_AGENTS, arena: 'agents', category: 'mobileapps',
    about: 'Cross-platform React Native mobile apps built by the model as an agent; users compare them. When building: mobile apps.',
  },
];
const INDEXES = STATS.filter((stat) => stat.index).map((stat) => stat.id);

class CatalogError extends Error {}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const newestFirst = (a, b) => (b.created ?? 0) - (a.created ?? 0) || compare(a.id, b.id);
const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const isMeasured = (model) => Object.keys(model.values).length > 0;

function text(value, max) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v).map((v) => v.slice(0, 40)) : [];
}

function perMillion(value) {
  const n = toNumber(value);
  return n === null || n < 0 ? null : Math.round(n * 1e10) / 1e4;
}

function displayName(name, id) {
  const full = text(name, 120) ?? id;
  const colon = full.indexOf(': ');
  return colon > 0 && colon <= 40 && full.length > colon + 2 ? full.slice(colon + 2) : full;
}

function readValues(benchmarks) {
  const analysis = record(benchmarks.artificial_analysis);
  const arena = Array.isArray(benchmarks.design_arena) ? benchmarks.design_arena.map(record) : [];
  const values = {};
  for (const stat of STATS) {
    if (stat.index) {
      const value = finite(analysis[stat.index]);
      if (value !== null) values[stat.id] = { value, rank: null };
      continue;
    }
    const rows = arena.filter((row) => row.arena === stat.arena && row.category === stat.category && finite(row.elo) !== null);
    if (rows.length === 1) values[stat.id] = { value: rows[0].elo, rank: finite(rows[0].rank) };
  }
  return values;
}

export function parseCatalog(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const listings = [];
  for (const raw of data) {
    const entry = record(raw);
    const id = typeof entry.id === 'string' ? entry.id : '';
    if (!ID_RE.test(id)) continue;
    const architecture = record(entry.architecture);
    const pricing = record(entry.pricing);
    listings.push({
      id,
      slug: id.slice(id.indexOf('/') + 1),
      canonical: text(entry.canonical_slug, 200) ?? '',
      name: displayName(entry.name, id),
      created: finite(entry.created),
      context: finite(entry.context_length),
      maxOutput: finite(record(entry.top_provider).max_completion_tokens),
      input: strings(architecture.input_modalities),
      text: strings(architecture.output_modalities).includes('text'),
      tools: strings(entry.supported_parameters).includes('tools'),
      reasoning: strings(record(entry.reasoning).supported_efforts),
      price: { input: perMillion(pricing.prompt), output: perMillion(pricing.completion) },
      expires: text(entry.expiration_date, 40),
      values: readValues(record(entry.benchmarks)),
    });
  }
  return listings;
}

function signature(listing) {
  return JSON.stringify(STATS.map((stat) => listing.values[stat.id] ?? null));
}

export function indexCatalog(listings) {
  const byId = new Map();
  for (const listing of listings) byId.set(listing.id, [...(byId.get(listing.id) ?? []), listing]);
  const groups = new Map();
  for (const copies of byId.values()) {
    if (new Set(copies.map(signature)).size > 1) continue;
    const key = copies[0].canonical || copies[0].id;
    groups.set(key, [...(groups.get(key) ?? []), copies[0]]);
  }
  const models = new Map();
  const aliasOf = new Map();
  for (const group of groups.values()) {
    const sets = new Set(group.map(signature)).size === 1 ? [group] : group.map((listing) => [listing]);
    for (const set of sets) {
      const [main] = [...set].sort((a, b) => a.id.includes(':') - b.id.includes(':') || compare(a.id, b.id));
      models.set(main.id, main);
      for (const listing of set) aliasOf.set(listing.id, main.id);
    }
  }
  const bySlug = new Map();
  for (const [id, main] of aliasOf) {
    const slug = id.slice(id.indexOf('/') + 1);
    bySlug.set(slug, bySlug.has(slug) && bySlug.get(slug) !== main ? null : main);
  }
  return { models, aliasOf, bySlug };
}

export function tierFor(level) {
  if (level >= 90) return 'S';
  if (level >= 75) return 'A';
  if (level >= 50) return 'B';
  if (level >= 25) return 'C';
  return 'D';
}

export function standing(value, others) {
  if (others.length === 0) return null;
  let above = 0;
  let tied = 0;
  for (const other of others) {
    if (other > value) above++;
    else if (other === value) tied++;
  }
  const of = others.length + 1;
  const level = Math.round((100 * (of - 1 - above - tied / 2)) / (of - 1));
  return { level, tier: tierFor(level), place: 1 + above, tied: tied > 0, of };
}

function patternFor(provider) {
  if (!provider.modelPattern) return null;
  try {
    return new RegExp(`^(?:${provider.modelPattern})$`, 'i');
  } catch {
    return null;
  }
}

export function providerModels(index, provider) {
  const pattern = patternFor(provider);
  if (!pattern) return [];
  return [...index.models.values()].filter((model) => model.text && model.tools && pattern.test(model.slug)).sort(newestFirst);
}

export function modelNames(raw) {
  const exact = String(raw ?? '').trim().toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .trim()
    .replace(/\s+/g, '-');
  if (!exact) return [];
  const name = exact.replace(/:[a-z0-9-]+$/, '');
  const undated = name.replace(/(?:-\d{8}|-\d{4}-\d{2}-\d{2}|@\d{8})$/, '');
  const dotted = undated.replace(/(\d+)-(\d+)(?=$|-)/g, '$1.$2');
  return [...new Set([exact, name, undated, dotted])];
}

export function resolveModel(index, related, model) {
  for (const raw of [model?.name, model?.displayName]) {
    const names = modelNames(raw);
    for (const name of names) {
      const id = name.includes('/') ? index.aliasOf.get(name) : index.bySlug.get(name);
      if (id) return id;
    }
    const last = names.at(-1);
    if (!last || !/[a-z]/.test(last)) continue;
    const hits = related.filter((m) => m.slug.slice(m.slug.indexOf('-') + 1) === last);
    if (hits.length === 1) return hits[0].id;
  }
  return null;
}

function cardFor(model, pool, retrievedAt) {
  const stats = {};
  for (const stat of STATS) {
    const own = model.values[stat.id];
    if (!own) continue;
    const others = pool[stat.id].filter((entry) => entry.id !== model.id).map((entry) => entry.value);
    const place = standing(own.value, others) ?? { level: null, tier: null, place: null, tied: false, of: null };
    stats[stat.id] = { ...place, value: own.value, rank: own.rank };
  }
  const created = model.created === null ? null : model.created * 1000;
  return {
    id: model.id,
    name: model.name,
    created: created === null ? null : new Date(created).toISOString(),
    new: created !== null && Date.parse(retrievedAt) - created < NEW_MS,
    expires: model.expires,
    context: model.context,
    maxOutput: model.maxOutput,
    input: model.input,
    reasoning: model.reasoning,
    price: model.price,
    stats,
  };
}

export function describeCatalog({ index, retrievedAt, stale, error }, providers, sessions = []) {
  const stats = STATS.map((stat) => ({ id: stat.id, label: stat.label, short: stat.short ?? stat.label, group: stat.group, about: stat.about }));
  const result = { retrievedAt, stale, error, stats, pool: null, providers: {}, models: {}, sessions: {} };
  if (!index) return result;
  const related = new Map(providers.map((provider) => [provider.id, providerModels(index, provider)]));
  const listed = new Map([...related].map(([id, models]) => [id, models.filter(isMeasured)]));
  const members = new Map();
  for (const models of listed.values()) for (const model of models) members.set(model.id, model);
  const pool = {};
  for (const stat of STATS) {
    pool[stat.id] = [...members.values()].filter((m) => m.values[stat.id]).map((m) => ({ id: m.id, value: m.values[stat.id].value }));
  }
  result.pool = { tools: providers.filter((p) => listed.get(p.id).length).map((p) => p.tool) };
  const card = (id) => (result.models[id] ??= cardFor(index.models.get(id), pool, retrievedAt));
  for (const provider of providers) {
    const models = listed.get(provider.id);
    if (models.length === 0) continue;
    const featured = models.find((m) => INDEXES.every((stat) => m.values[stat])) ?? models[0];
    result.providers[provider.id] = { featured: featured.id, models: models.map((m) => card(m.id).id) };
  }
  for (const session of sessions) {
    if (!session.model) continue;
    const id = resolveModel(index, related.get(session.provider?.id) ?? [], session.model);
    result.sessions[session.id] = id;
    if (id) card(id);
  }
  return result;
}

function failure(err) {
  if (err instanceof CatalogError) return err.message;
  if (err?.name === 'TimeoutError') return `OpenRouter did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds`;
  if (err instanceof SyntaxError) return 'OpenRouter sent a model list that could not be read';
  return `OpenRouter could not be reached (${err?.cause?.code || err?.message || 'unknown error'})`;
}

export class ModelStats {
  constructor({ registry, fetchImpl = fetch, ttlMs = CATALOG_TTL_MS, retryMs = RETRY_MS } = {}) {
    this.registry = registry;
    this.fetchImpl = fetchImpl;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.current = null;
    this.inflight = null;
  }

  async snapshot(sessions = []) {
    return describeCatalog(await this.catalog(), this.registry.providers, sessions);
  }

  catalog() {
    if (this.inflight) return this.inflight;
    const entry = this.current;
    if (entry && Date.now() - entry.at < (entry.catalog.error ? this.retryMs : this.ttlMs)) return Promise.resolve(entry.catalog);
    this.inflight = this._fetch().then((catalog) => {
      this.current = { catalog, at: Date.now() };
      return catalog;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _fetch() {
    try {
      const res = await this.fetchImpl(CATALOG_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'agent-guild' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new CatalogError(`OpenRouter answered HTTP ${res.status}`);
      const listings = parseCatalog(await res.json());
      if (listings.length === 0) throw new CatalogError('OpenRouter sent an empty model list');
      return { index: indexCatalog(listings), retrievedAt: new Date().toISOString(), stale: false, error: null };
    } catch (err) {
      const last = this.current?.catalog;
      if (last?.index) return { ...last, stale: true, error: failure(err) };
      return { index: null, retrievedAt: null, stale: false, error: failure(err) };
    }
  }
}

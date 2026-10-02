// Guild yard. Draws providers and sessions over the courtyard and runs the
// card buttons, so behaviour stays in app.js. It never calls the API itself.

import { PLOTS, anchorForProvider, layoutUnits } from '/yard-layout.mjs';

const $ = (id) => document.getElementById(id);
const VIEW_KEY = 'agentGuild.view';
const PORTRAITS = new Set(['anthropic', 'openai', 'google', 'xai', 'shell']);
const COLORS = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
  xai: '#9aa3b2',
  shell: '#8b5cf6',
};
const KINDS = {
  anthropic: 'mage',
  openai: 'knight',
  google: 'scholar',
  xai: 'star',
  shell: 'smith',
};

let selected = null;
let hudSig = '';
let tickSig = '';
const cam = { x: 0, y: 0, s: 1 };
let drag = null;
let dragMoved = false;

function safeToken(value) {
  return /^[a-z0-9-]+$/i.test(value || '') ? value : '';
}

function providerCard(id) {
  return [...document.querySelectorAll('#providers .provider')].find((card) => card.dataset.id === id) || null;
}

function sessionCard(id) {
  return [...document.querySelectorAll('#sessions .session-card')].find((card) => card.dataset.id === id) || null;
}

function unknownIndex(providerId) {
  const ids = [...document.querySelectorAll('#providers .provider')]
    .map((card) => card.dataset.id)
    .filter((id) => id && !PLOTS[id]);
  const at = ids.indexOf(providerId);
  return at < 0 ? 0 : at;
}

function anchorFor(providerId) {
  return anchorForProvider(providerId, unknownIndex(providerId));
}

function applyCam() {
  const node = $('yard-cam');
  if (!node) return;
  node.style.transform = `translate(calc(-50% + ${cam.x}px), calc(-50% + ${cam.y}px)) scale(${cam.s})`;
}

function applyInert() {
  const yard = document.documentElement.dataset.view === 'yard';
  const providers = $('providers');
  const sessions = $('sessions');
  const news = $('news-latest');
  if (providers) providers.inert = yard;
  if (sessions) sessions.inert = yard;
  if (news) news.inert = yard;
}

function setView(view) {
  const next = view === 'yard' ? 'yard' : 'cards';
  document.documentElement.dataset.view = next;
  try { localStorage.setItem(VIEW_KEY, next); } catch { /* storage unavailable */ }
  $('view-cards')?.setAttribute('aria-pressed', String(next === 'cards'));
  $('view-yard')?.setAttribute('aria-pressed', String(next === 'yard'));
  applyInert();
  if (next === 'yard') sync();
}

function pose(card, kind) {
  if (kind === 'plot') return card.classList.contains('unavailable') ? 'locked' : 'idle';
  return card.querySelector('.status-pill')?.classList.contains('active') ? 'working' : 'idle';
}

function monogramEl(card) {
  const span = document.createElement('span');
  span.className = 'yard-mono';
  const text = (card.querySelector('.provider-icon')?.textContent || '').trim();
  span.textContent = text ? text.slice(0, 2) : (card.dataset.provider || card.dataset.id || '?').slice(0, 1).toUpperCase();
  const color = getComputedStyle(card).getPropertyValue('--pc').trim();
  if (color) span.style.color = color;
  return span;
}

function setPortrait(card, kind) {
  const frame = $('yard-portrait');
  frame.replaceChildren();
  const providerId = safeToken(kind === 'plot' ? card.dataset.id : card.dataset.provider);
  const skin = safeToken(document.documentElement.dataset.skin) || 'guild';
  if (skin !== 'professional' && PORTRAITS.has(providerId)) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `/skins/${skin}/characters/${providerId}/${pose(card, kind)}.webp`;
    img.addEventListener('error', () => {
      img.remove();
      if (!frame.firstElementChild) frame.append(monogramEl(card));
    });
    frame.append(img);
    return;
  }
  frame.append(monogramEl(card));
}

function addProxy(host, source) {
  if (!source || source.hidden) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  if (source.classList.contains('primary')) button.classList.add('primary');
  if (source.classList.contains('danger')) button.classList.add('danger');
  button.textContent = source.textContent;
  button.title = source.title;
  const label = source.getAttribute('aria-label');
  if (label) button.setAttribute('aria-label', label);
  button.addEventListener('click', () => source.click());
  host.append(button);
}

function fillEmpty() {
  const frame = $('yard-portrait');
  frame.replaceChildren();
  const crest = document.createElement('img');
  crest.src = '/brand/crest.png';
  crest.alt = '';
  frame.append(crest);
  $('yard-kicker').textContent = 'Guild yard';
  $('yard-title').textContent = 'Select a hall';
  $('yard-sub').textContent = 'Halls are the tools. Heroes are the sessions.';
  $('yard-accounts').replaceChildren();
  $('yard-meters').replaceChildren();
  $('yard-actions').replaceChildren();
  $('yard-note').textContent = 'Choose a hall to start a session, or a hero to command one. The terminal, news, and GitHub controls are the same as on the cards.';
}

function fillProvider(card) {
  setPortrait(card, 'plot');
  $('yard-kicker').textContent = card.querySelector('.vendor')?.textContent || '';
  $('yard-title').textContent = card.querySelector('.tool')?.textContent || '';
  const stateLine = card.querySelector('.state');
  $('yard-sub').textContent = stateLine?.textContent || '';
  $('yard-sub').title = stateLine?.title || '';

  const accounts = $('yard-accounts');
  accounts.replaceChildren();
  const host = card.querySelector('.accounts');
  if (host && !host.hidden) {
    for (const chip of host.querySelectorAll('.account-chip')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'account-chip';
      if (chip.classList.contains('unsigned')) button.classList.add('unsigned');
      button.textContent = chip.textContent;
      button.title = chip.title;
      button.setAttribute('aria-selected', chip.getAttribute('aria-selected') || 'false');
      button.addEventListener('click', () => {
        chip.click();
        hudSig = '';
        sync();
      });
      accounts.append(button);
    }
  }

  const usage = card.querySelector('.usage');
  $('yard-meters').replaceChildren(...[...(usage?.children || [])].map((node) => node.cloneNode(true)));

  const actions = $('yard-actions');
  actions.replaceChildren();
  for (const sel of ['.new', '.existing', '.install', '.update', '.model-stats-head']) addProxy(actions, card.querySelector(sel));
  const reporting = card.querySelector('.reporting-row');
  if (reporting && !reporting.hidden) addProxy(actions, reporting.querySelector('.reporting-toggle'));

  const note = $('yard-note');
  note.replaceChildren();
  if (reporting && !reporting.hidden) {
    const text = document.createElement('p');
    text.textContent = reporting.querySelector('.reporting-text')?.textContent || '';
    note.append(text);
  }
  const links = card.querySelector('.provider-links');
  if (links && !links.hidden) {
    const row = document.createElement('p');
    row.className = 'yard-links';
    for (const link of links.querySelectorAll('a')) if (!link.hidden && link.getAttribute('href')) row.append(link.cloneNode(true));
    if (row.childElementCount) note.append(row);
  }
  const hint = card.querySelector('.hint');
  if (hint && !hint.hidden) {
    const copy = document.createElement('p');
    copy.append(...[...hint.childNodes].map((node) => node.cloneNode(true)));
    note.append(copy);
  }
  const copies = card.querySelector('.copies');
  if (copies && !copies.hidden) note.append(copies.cloneNode(true));
}

function fillSession(card) {
  setPortrait(card, 'unit');
  const level = card.querySelector('.level-badge')?.textContent || '';
  $('yard-kicker').textContent = level ? `Level ${level}` : 'Session';
  $('yard-title').textContent = card.querySelector('.name')?.textContent || 'Session';
  const status = card.querySelector('.status-pill')?.textContent || '';
  const meta = card.querySelector('.meta-text')?.textContent || '';
  $('yard-sub').textContent = [status, meta].filter(Boolean).join(' · ');
  $('yard-sub').title = '';
  $('yard-accounts').replaceChildren();
  $('yard-meters').replaceChildren();

  const actions = $('yard-actions');
  actions.replaceChildren();
  for (const sel of ['.open', '.resume', '.use-folder', '.rename', '.stop', '.remove', '.model-pill', '.session-id', '.reporting-why']) {
    addProxy(actions, card.querySelector(sel));
  }

  const note = $('yard-note');
  note.replaceChildren();
  const cwd = card.querySelector('.cwd-line');
  if (cwd?.textContent) {
    const line = document.createElement('p');
    line.className = 'yard-cwd';
    line.textContent = cwd.textContent.replace(/^\u200E/, '');
    line.title = cwd.title || '';
    note.append(line);
  }
  const agents = card.querySelector('.agents');
  if (agents && (agents.children.length || agents.dataset.empty)) {
    const row = document.createElement('div');
    row.className = 'yard-agents';
    const label = document.createElement('span');
    label.textContent = agents.children.length ? 'Agents' : (agents.dataset.empty || 'Agents');
    row.append(label);
    for (const agent of agents.children) row.append(agent.cloneNode(true));
    note.append(row);
  }
}

function hudSignature() {
  if (!selected) return 'empty';
  const card = selected.kind === 'plot' ? providerCard(selected.id) : sessionCard(selected.id);
  if (!card) return 'missing';
  const skin = document.documentElement.dataset.skin || '';
  const bits = [selected.kind, selected.id, skin, card.getAttribute('aria-label') || ''];
  if (selected.kind === 'plot') {
    bits.push(
      card.querySelector('.usage')?.textContent || '',
      card.querySelector('.accounts')?.textContent || '',
      card.querySelector('.state')?.textContent || '',
      card.querySelector('.hint')?.textContent || '',
      card.querySelector('.copies')?.textContent || '',
    );
    for (const sel of ['.new', '.existing', '.install', '.update', '.reporting-toggle', '.model-stats-head']) {
      const button = card.querySelector(sel);
      bits.push(sel, button ? String(Boolean(button.hidden)) : '0', button?.textContent || '');
    }
    const reporting = card.querySelector('.reporting-row');
    bits.push(reporting ? String(Boolean(reporting.hidden)) : '1');
  }
  return bits.join('\n');
}

function renderHud() {
  const sig = hudSignature();
  if (sig === hudSig) return;
  hudSig = sig;
  if (!selected) return fillEmpty();
  const card = selected.kind === 'plot' ? providerCard(selected.id) : sessionCard(selected.id);
  if (!card) {
    selected = null;
    hudSig = 'empty';
    return fillEmpty();
  }
  if (selected.kind === 'plot') fillProvider(card);
  else fillSession(card);
}

function unitSvg(providerId) {
  const kind = KINDS[providerId] || 'banner';
  const color = COLORS[providerId] || '#e2b867';
  const shadow = '<ellipse cx="32" cy="74" rx="14" ry="4.5" fill="rgba(0,0,0,.45)"/>';
  const figures = {
    mage: `${shadow}<path d="M32 18c8 0 12 8 12 14v6c4 2 8 8 8 16v14H12V54c0-8 4-14 8-16v-6c0-6 4-14 12-14z" fill="${color}"/><circle cx="32" cy="22" r="7" fill="#e6c2a0"/><path d="M20 16c2-8 20-8 24 0-6 2-18 2-24 0z" fill="${color}"/>`,
    knight: `${shadow}<path d="M20 40h24l4 28H16z" fill="${color}"/><path d="M22 28h20v12H22z" fill="#2a2e33"/><circle cx="32" cy="26" r="8" fill="#d5d8de"/><rect x="28" y="22" width="8" height="3" fill="#1b1e22"/><path d="M44 46l10 4-8 16-6-4z" fill="#c5a46a"/>`,
    scholar: `${shadow}<path d="M18 42h28l2 26H16z" fill="${color}"/><circle cx="32" cy="28" r="8" fill="#e6c2a0"/><path d="M16 24h32l-6 6H22z" fill="${color}"/><rect x="26" y="50" width="12" height="8" rx="1" fill="#f4ecd8"/>`,
    star: `${shadow}<path d="M32 16l4 10h10l-8 6 3 10-9-6-9 6 3-10-8-6h10z" fill="#f4ecd8"/><path d="M18 40h28l3 28H15z" fill="${color}"/>`,
    smith: `${shadow}<path d="M18 38h28l2 30H16z" fill="${color}"/><circle cx="32" cy="26" r="8" fill="#e6c2a0"/><path d="M40 48h14v4H40z" fill="#8a8175"/><rect x="50" y="42" width="6" height="10" fill="#c5a46a"/>`,
    banner: `${shadow}<path d="M30 16h4v52h-4z" fill="#8a8175"/><path d="M34 18h18l-4 8 4 8H34z" fill="${color}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 80" aria-hidden="true">${figures[kind]}</svg>`;
}

function renderPlots() {
  const host = $('yard-plots');
  if (!host) return;
  const cards = [...document.querySelectorAll('#providers .provider')];
  const seen = new Set();
  let unknown = 0;
  for (const card of cards) {
    const id = card.dataset.id;
    if (!id) continue;
    seen.add(id);
    const anchor = PLOTS[id] ? anchorForProvider(id) : anchorForProvider(id, unknown++);
    let el = [...host.children].find((node) => node.dataset.provider === id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'plot';
      el.dataset.provider = id;
      el.innerHTML = '<span class="plot-glow" aria-hidden="true"></span><span class="plot-plate"><span class="plot-tool"></span><span class="plot-state"></span><span class="plot-meter" hidden><span></span></span></span>';
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        select({ kind: 'plot', id });
      });
      el.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        event.preventDefault();
        const live = providerCard(id);
        const button = [...(live?.querySelectorAll('.new, .install') || [])].find((node) => !node.hidden);
        button?.click();
      });
      host.append(el);
    }
    el.style.left = `${anchor.x}%`;
    el.style.top = `${anchor.y}%`;
    el.classList.toggle('camp', Boolean(anchor.camp));
    el.classList.toggle('locked', card.classList.contains('unavailable'));
    el.classList.toggle('selected', selected?.kind === 'plot' && selected.id === id);
    el.querySelector('.plot-tool').textContent = card.querySelector('.tool')?.textContent || id;
    el.querySelector('.plot-state').textContent = card.querySelector('.state')?.textContent || '';
    const fill = card.querySelector('.meter-fill');
    const meter = el.querySelector('.plot-meter');
    const bar = meter.firstElementChild;
    if (fill && bar) {
      meter.hidden = false;
      bar.style.width = fill.style.width || '0%';
      meter.classList.toggle('low', Boolean(card.querySelector('.meter.low')));
      meter.classList.toggle('empty', Boolean(card.querySelector('.meter.empty')));
    } else {
      meter.hidden = true;
    }
    const busy = [...document.querySelectorAll('#sessions .session-card')].some((session) => (
      session.dataset.provider === id && session.querySelector('.status-pill')?.classList.contains('active')
    ));
    el.classList.toggle('working', busy);
    el.title = card.getAttribute('aria-label') || '';
    el.setAttribute('aria-pressed', String(el.classList.contains('selected')));
  }
  for (const el of [...host.children]) if (!seen.has(el.dataset.provider)) el.remove();
}

function paintFamiliars(host, card) {
  const skin = safeToken(document.documentElement.dataset.skin);
  const agents = [...card.querySelectorAll('.agents .agent')].slice(0, 4);
  host.replaceChildren(...agents.map((agent) => {
    const dot = document.createElement('span');
    const familiar = safeToken(agent.dataset.familiar);
    if (skin && skin !== 'professional' && familiar) {
      dot.className = 'familiar';
      dot.style.backgroundImage = `url("/skins/${skin}/familiars/${familiar}.png")`;
    } else {
      dot.className = 'familiar letter';
      dot.textContent = (agent.textContent || '').slice(0, 1);
    }
    dot.title = agent.getAttribute('aria-label') || agent.title || '';
    return dot;
  }));
}

function renderUnits() {
  const host = $('yard-units');
  if (!host) return;
  const cards = [...document.querySelectorAll('#sessions .session-card')];
  const placed = layoutUnits(
    cards.map((card) => ({ id: card.dataset.id, providerId: card.dataset.provider || 'camp' })),
    anchorFor,
  );
  const byId = new Map(placed.map((place) => [place.id, place]));
  const seen = new Set();
  for (const card of cards) {
    const place = byId.get(card.dataset.id);
    if (!place) continue;
    seen.add(card.dataset.id);
    let el = [...host.children].find((node) => node.dataset.id === card.dataset.id);
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'unit';
      el.dataset.id = card.dataset.id;
      el.innerHTML = '<span class="shadow" aria-hidden="true"></span><span class="sprite" aria-hidden="true"></span><span class="level"></span><span class="uname"></span><span class="familiars"></span><span class="more" hidden></span>';
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        select({ kind: 'unit', id: el.dataset.id });
      });
      el.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        event.preventDefault();
        const open = sessionCard(el.dataset.id)?.querySelector('.open');
        if (open && !open.hidden) open.click();
      });
      host.append(el);
    }
    el.style.left = `${place.x}%`;
    el.style.top = `${place.y}%`;
    el.style.zIndex = String(200 + Math.round(place.y));
    const providerId = card.dataset.provider || 'camp';
    if (el.dataset.sprite !== providerId) {
      el.dataset.sprite = providerId;
      el.querySelector('.sprite').innerHTML = unitSvg(providerId);
    }
    const working = card.querySelector('.status-pill')?.classList.contains('active');
    el.classList.toggle('working', Boolean(working));
    el.classList.toggle('exited', card.classList.contains('exited'));
    el.classList.toggle('selected', selected?.kind === 'unit' && selected.id === card.dataset.id);
    el.querySelector('.level').textContent = card.querySelector('.level-badge')?.textContent || '';
    el.querySelector('.uname').textContent = card.querySelector('.name')?.textContent || '';
    paintFamiliars(el.querySelector('.familiars'), card);
    const more = el.querySelector('.more');
    more.hidden = !place.more;
    more.textContent = place.more ? `+${place.more}` : '';
    el.title = card.getAttribute('aria-label') || '';
    el.setAttribute('aria-pressed', String(el.classList.contains('selected')));
  }
  for (const el of [...host.children]) if (!seen.has(el.dataset.id)) el.remove();
}

function renderTicker() {
  const headlines = $('yard-headlines');
  const count = $('yard-count');
  if (!headlines || !count) return;
  count.textContent = $('session-count')?.textContent || '';
  const links = [...document.querySelectorAll('#news-latest .news-link')];
  const note = $('news-note');
  const sig = `${links.map((link) => link.textContent).join('|')}|${note && !note.hidden ? note.textContent : ''}`;
  if (sig === tickSig) return;
  tickSig = sig;
  if (!links.length) {
    const empty = document.createElement('span');
    empty.textContent = note?.textContent || '';
    headlines.replaceChildren(empty);
    return;
  }
  headlines.replaceChildren(...links.map((link) => link.cloneNode(true)));
}

function selectable() {
  return [
    ...document.querySelectorAll('#yard-plots .plot'),
    ...document.querySelectorAll('#yard-units .unit'),
  ];
}

function select(next) {
  const same = selected?.kind === next?.kind && selected?.id === next?.id;
  selected = next;
  if (!same) hudSig = '';
  for (const el of document.querySelectorAll('#yard-plots .plot, #yard-units .unit')) {
    const on = next?.kind === 'plot'
      ? el.classList.contains('plot') && el.dataset.provider === next.id
      : next?.kind === 'unit' && el.classList.contains('unit') && el.dataset.id === next.id;
    el.classList.toggle('selected', Boolean(on));
    el.setAttribute('aria-pressed', String(Boolean(on)));
  }
  renderHud();
}

function sync() {
  if (!$('yard')) return;
  if (selected?.kind === 'plot' && !providerCard(selected.id)) selected = null;
  if (selected?.kind === 'unit' && !sessionCard(selected.id)) selected = null;
  if (!selected) hudSig = hudSig === 'empty' ? hudSig : '';
  renderPlots();
  renderUnits();
  renderTicker();
  renderHud();
  applyInert();
}

function onKey(event) {
  if (document.documentElement.dataset.view !== 'yard') return;
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if ([...document.querySelectorAll('dialog')].some((dialog) => dialog.open)) return;
  const panel = $('terminal-panel');
  if (panel && !panel.hidden) return;
  if (event.key === 'Escape') {
    if (!selected) return;
    event.preventDefault();
    select(null);
    return;
  }
  if (event.key === 'Enter' && event.target.closest('#yard-stage')) {
    const primary = document.querySelector('#yard-actions .btn.primary') || document.querySelector('#yard-actions .btn');
    if (!primary) return;
    event.preventDefault();
    primary.click();
    return;
  }
  const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!dir || !event.target.closest('#yard-stage, #yard-hud')) return;
  const items = selectable();
  if (!items.length) return;
  event.preventDefault();
  let index = items.findIndex((el) => el.classList.contains('selected'));
  if (index < 0) index = dir > 0 ? -1 : 0;
  const next = items[(index + dir + items.length) % items.length];
  next.focus();
  select(next.classList.contains('plot')
    ? { kind: 'plot', id: next.dataset.provider }
    : { kind: 'unit', id: next.dataset.id });
}

function bindStage() {
  const stage = $('yard-stage');
  if (!stage) return;
  stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('.plot, .unit')) return;
    drag = { x: event.clientX, y: event.clientY, ox: cam.x, oy: cam.y, id: event.pointerId };
    dragMoved = false;
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) dragMoved = true;
    cam.x = drag.ox + dx;
    cam.y = drag.oy + dy;
    applyCam();
  });
  const endDrag = (event) => {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    drag = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('click', (event) => {
    if (dragMoved || event.target.closest('.plot, .unit')) return;
    select(null);
  });
  stage.addEventListener('wheel', (event) => {
    if (document.documentElement.dataset.view !== 'yard') return;
    event.preventDefault();
    const next = Math.min(2.4, Math.max(0.75, cam.s * (event.deltaY > 0 ? 0.92 : 1.08)));
    cam.s = next;
    applyCam();
  }, { passive: false });
  stage.addEventListener('dblclick', (event) => {
    if (event.target.closest('.plot, .unit')) event.preventDefault();
  });
}

document.addEventListener('agentguild:sync', sync);
document.addEventListener('keydown', onKey);
$('view-cards')?.addEventListener('click', () => setView('cards'));
$('view-yard')?.addEventListener('click', () => setView('yard'));
$('yard-news')?.addEventListener('click', () => $('news-all')?.click());

const newsList = $('news-latest');
if (newsList) {
  new MutationObserver(() => renderTicker()).observe(newsList, { childList: true, subtree: true, characterData: true });
}
new MutationObserver(() => {
  hudSig = '';
  sync();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin'] });

bindStage();
applyCam();
setView(document.documentElement.dataset.view === 'yard' ? 'yard' : 'cards');

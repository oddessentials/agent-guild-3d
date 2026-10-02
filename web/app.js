// Agent Guild web page. A thin client of the session manager's local API:
// it never owns sessions, so closing the page leaves them running.

const TOKEN_KEY = 'agentGuild.token';
const CWD_KEY = 'agentGuild.cwd';
const ACCOUNTS_KEY = 'agentGuild.accounts';
const THEME_KEY = 'agentGuild.theme';
const SKIN_KEY = 'agentGuild.skin';
const NEWS_SEEN_KEY = 'agentGuild.newsSeen';
const NEWS_FILTER_KEY = 'agentGuild.newsFilter';
const CHANGELOG_SEEN_KEY = 'agentGuild.changelogSeen';
const GITHUB_ACCOUNT_KEY = 'agentGuild.githubAccount';
const CLONE_PARENT_KEY = 'agentGuild.cloneParent';
const RELEASES_URL = 'https://github.com/oddessentials/agent-guild/releases';
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

const $ = (id) => document.getElementById(id);
const state = {
  token: null,
  providers: [],
  usage: new Map(),
  accounts: {},
  stats: null,
  statsFor: new Map(),
  news: null,
  changelog: null,
  github: null,
  sessions: new Map(),
  views: new Map(),
  activeId: null,
  eventsSocket: null,
  eventsRetry: 0,
  /** True while the events socket is open. */
  connected: false,
  /** The manager's own version check, from `hello` and `manager.upgrade`. */
  upgrade: null,
  /** The running manager's version and pid, from `hello`. */
  version: null,
  pid: null,
  /** False for a manager from before restarts, which only stops: `agent-guild restart` replaces it. */
  restartable: false,
  /** The double-click launcher file on this computer, or null when the install has none. */
  launcher: null,
  /** True from a shutdown request until the manager is reachable again. */
  stopping: false,
  /** True while the stop is a restart: a new manager is expected to take over. */
  restarting: false,
  /** After a stop: how many session processes did not confirm exiting, or null if the manager never said. */
  stopRemaining: null,
};

// ---- storage (may be unavailable, e.g. blocked site data) -----------------

function load(key) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key, value) { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignore */ } }

// ---- helpers --------------------------------------------------------------

let toastTimer;
function toast(message, ms = 5000, action = null) {
  const el = $('toast');
  el.replaceChildren(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      el.hidden = true;
      action.run();
    });
    el.append(button);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setConnection(kind, label) {
  const el = $('connection');
  el.className = `connection ${kind}`;
  el.querySelector('.label').textContent = label;
  // The manager can only be stopped, restarted or upgraded while the page can reach it.
  state.connected = kind === 'ok';
  $('stop-manager').hidden = !state.connected;
  $('restart-manager').hidden = !state.connected || !state.restartable;
  renderUpgrade();
  guardLeaving();
}

// ---- the running version --------------------------------------------------

/** A development checkout runs as 0.0.0-development; releases carry a real version. */
function isDevelopmentBuild(version) {
  return !version || /^0\.0\.0(?:-|$)/.test(String(version));
}

function renderVersion() {
  const badge = $('version');
  const v = state.version;
  badge.hidden = !v;
  if (!v) return;
  const dev = isDevelopmentBuild(v);
  const unread = unreadRelease();
  const notes = unread ? `What’s new in v${unread}` : 'What’s new';
  badge.textContent = dev ? 'dev' : `v${v}`;
  badge.classList.toggle('unread', Boolean(unread));
  badge.title = [dev ? `Development build (${v})` : `Agent Guild ${v}`, state.pid && `session manager pid ${state.pid}`, notes].filter(Boolean).join(' · ');
  badge.setAttribute('aria-label', `${dev ? `Agent Guild development build ${v}` : `Agent Guild version ${v}`}. ${notes}${unread ? ', not read yet' : ''}`);
}

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

function compareReleases(a, b) {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

function newestRelease(versions) {
  return versions.filter((v) => RELEASE_VERSION.test(v ?? '')).reduce((newest, v) => (newest && compareReleases(newest, v) >= 0 ? newest : v), null);
}

function seenRelease() {
  const saved = load(CHANGELOG_SEEN_KEY);
  return RELEASE_VERSION.test(saved ?? '') ? saved : changelogView.seen;
}

function markReleasesSeen(...versions) {
  const newest = newestRelease([seenRelease(), ...versions]);
  if (!newest) return;
  changelogView.seen = newest;
  save(CHANGELOG_SEEN_KEY, newest);
}

function unreadRelease() {
  if (!RELEASE_VERSION.test(state.version ?? '')) return null;
  if (!seenRelease()) markReleasesSeen(state.version);
  const newest = newestRelease([state.version, state.upgrade?.pendingVersion, state.upgrade?.latestVersion]);
  return compareReleases(newest, seenRelease()) > 0 ? newest : null;
}

// ---- theme ----------------------------------------------------------------

/** theme.js applied the saved or system theme before the first paint; this keeps the menu in step. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector(`#appearance-menu input[name="theme"][value="${theme}"]`).checked = true;
}

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Repaints the page with `change`, revealed in a circle growing from the control that asked for it. */
function revealChange(control, change) {
  if (!document.startViewTransition || reducedMotion.matches) return change();
  const box = control.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const root = document.documentElement.style;
  root.setProperty('--reveal-x', `${Math.round(x)}px`);
  root.setProperty('--reveal-y', `${Math.round(y)}px`);
  root.setProperty('--reveal-r', `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
  // The browser skips the animation (still applying the change) when the page is hidden or another transition starts.
  document.startViewTransition(change).ready.catch(() => {});
}

function changeTheme(input) {
  const theme = input.value === 'dark' ? 'dark' : 'light';
  save(THEME_KEY, theme);
  revealChange(input.closest('label'), () => applyTheme(theme));
}

// ---- skin -----------------------------------------------------------------

/** The skins theme.js offers; it applied the saved one before the first paint. */
const SKINS = window.agentGuildSkins ?? [{ id: 'guild', name: 'Guild' }];

function renderSkinChoices() {
  const choices = SKINS.map((skin) => {
    const label = document.createElement('label');
    label.className = 'choice';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'skin', value: skin.id });
    input.checked = skin.id === document.documentElement.dataset.skin;
    label.append(input, Object.assign(document.createElement('span'), { textContent: skin.name }));
    return label;
  });
  $('skin-choices').append(...choices);
}

/**
 * Switches skin in place. Entrance and level-up animations are cleared first
 * so the new skin does not replay them on every card.
 */
function changeSkin(input) {
  const skin = input.value;
  if (!SKINS.some((s) => s.id === skin) || skin === document.documentElement.dataset.skin) return;
  save(SKIN_KEY, skin);
  for (const el of document.querySelectorAll('.deal, .enter, .level-up, .summon')) el.classList.remove('deal', 'enter', 'level-up', 'summon');
  revealChange(input.closest('label'), () => { document.documentElement.dataset.skin = skin; });
}

/** Places the open menu under its button, right-aligned with it and kept on screen. */
function placeAppearanceMenu() {
  const menu = $('appearance-menu');
  if (!menu.matches(':popover-open')) return;
  const box = $('appearance').getBoundingClientRect();
  menu.style.top = `${Math.round(box.bottom + 6)}px`;
  menu.style.right = `${Math.max(8, Math.round(innerWidth - box.right))}px`;
}

// ---- upgrading the manager ------------------------------------------------

function renderUpgrade() {
  const u = state.upgrade;
  const button = $('upgrade');
  const note = $('upgrade-note');
  const offer = Boolean(state.connected && u?.available && u.command);
  button.hidden = !offer;
  if (offer) {
    button.textContent = `Upgrade to ${u.latestVersion}`;
    button.title = `Run "${u.command}" in a session. Sessions keep running; the new version is used once the manager is restarted.`;
  }
  // A newer version on disk is used by the next manager, so the restart
  // button becomes the way to pick it up.
  const restart = $('restart-manager');
  const pending = u?.pendingVersion;
  restart.classList.toggle('pending', Boolean(pending));
  restart.textContent = pending ? `Restart to use v${pending}` : 'Restart manager';
  restart.title = pending
    ? `Agent Guild ${pending} is installed, but this manager is still ${u.version}. Restarting ends every session and starts the new version; this page reconnects by itself.`
    : 'Stop the session manager and start it again. This ends every session; this page reconnects by itself.';
  const panelUpgrade = $('changelog-upgrade');
  panelUpgrade.hidden = button.hidden;
  panelUpgrade.textContent = button.textContent;
  panelUpgrade.title = button.title;
  const panelRestart = $('changelog-restart');
  panelRestart.hidden = restart.hidden || !pending;
  panelRestart.textContent = restart.textContent;
  panelRestart.title = restart.title;
  $('changelog-actions').hidden = panelUpgrade.hidden && panelRestart.hidden;
  let text = '';
  let title = '';
  const last = u?.lastInstall;
  if (u?.installing) {
    text = `Upgrading${u.latestVersion ? ` to v${u.latestVersion}` : ''}…`;
    title = 'npm is running in a session. Keep the manager running until it finishes.';
  } else if (pending && !state.restartable) {
    text = `v${pending} installed · run "agent-guild restart" to use it`;
    title = `Agent Guild ${pending} is installed, but this manager is still ${u.version} and cannot restart itself. Run "agent-guild restart" in a terminal when your sessions are done; this page reconnects by itself.`;
  } else if (last?.outcome === 'failed') {
    text = last.exitCode === null ? 'Upgrade failed' : `Upgrade failed (exit ${last.exitCode})`;
    title = 'See the upgrade session for npm\'s output, then run the upgrade again: the files on disk may be incomplete. On Windows, files in use cannot be replaced: stop the manager first and run the command yourself.';
  } else if (last?.outcome === 'unchanged') {
    text = 'Upgrade finished, but this copy was not replaced';
    title = `npm did not replace the files this manager runs from. Run${u.command ? ` "${u.command}"` : ' the npm install'} where Agent Guild is installed.`;
  } else if (u?.available && !u.command) {
    text = `v${u.latestVersion} available`;
    title = u.guidance || '';
  }
  note.hidden = !state.connected || !text;
  note.textContent = text;
  note.title = title;
}

function setUpgrade(upgrade) {
  const before = state.upgrade;
  state.upgrade = upgrade || null;
  renderUpgrade();
  renderVersion();
  if ($('changelog').open) renderChangelog();
  const pending = state.upgrade?.pendingVersion;
  if (pending && pending !== before?.pendingVersion) {
    toast(state.restartable
      ? `Agent Guild ${pending} is installed. Use "Restart to use v${pending}" in the top bar when your sessions are done.`
      : `Agent Guild ${pending} is installed. Run "agent-guild restart" in a terminal when your sessions are done.`, 10000);
  }
}

async function upgradeManager() {
  const button = $('upgrade');
  button.disabled = true;
  try {
    const { session } = await api('POST', '/upgrade');
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  } finally {
    button.disabled = false;
  }
}

function relativeTime(iso) {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function untilTime(iso) {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (!Number.isFinite(s) || s <= 0) return 'resets now';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h >= 48) return `resets in ${Math.round(h / 24)} d`;
  if (h > 0) return `resets in ${h} h${m ? ` ${m} min` : ''}`;
  return `resets in ${Math.max(1, m)} min`;
}

function hueFor(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function httpsHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function planLabel(plan) {
  const text = String(plan ?? '').trim();
  if (/[A-Z]/.test(text)) return text;
  return text.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function paintProviderIcon(el, provider) {
  el.style.setProperty('--c', provider.color || '#64748b');
  el.dataset.provider = provider.id;
  if (provider.iconUrl) {
    el.classList.add('has-image');
    el.style.backgroundImage = `url(${JSON.stringify(provider.iconUrl)})`;
    el.textContent = '';
  } else {
    el.classList.remove('has-image');
    el.style.backgroundImage = '';
    el.textContent = provider.monogram || (provider.vendor || '?').charAt(0);
  }
  el.setAttribute('aria-hidden', 'true');
}

const FAMILIARS = ['flame', 'leaf', 'night', 'aether'];

const REPORTING_TEXT = {
  pending: 'waiting for hooks',
  unavailable: 'no reports yet',
  setup_required: 'reporting off',
  unsupported: 'not supported',
};

function paintReporting(row, s) {
  const reporting = s.status === 'running' ? s.reporting : null;
  const agents = row.querySelector('.agents');
  agents.dataset.empty = REPORTING_TEXT[reporting?.state] || 'none reported';
  agents.classList.toggle('reporting-attention', ['unavailable', 'setup_required', 'unsupported'].includes(reporting?.state));
  const why = row.querySelector('.reporting-why');
  const reason = reporting?.state !== 'active' ? reporting?.reason || '' : '';
  why.hidden = !reason;
  why.title = reason;
  why.setAttribute('aria-label', `Why agent reporting says ${agents.dataset.empty}: ${reason}`);
  why.onclick = () => toast(reason, 12000);
}

const MAX_SHELLS_SHOWN = 16;

function renderAgents(container, agents, shells = []) {
  const known = container.dataset.rendered ? new Set([...container.children].map((el) => el.dataset.agent)) : null;
  container.dataset.rendered = 'true';
  const familiar = (id, name, hue) => {
    const el = document.createElement('span');
    el.dataset.agent = id;
    if (known && !known.has(id)) el.classList.add('summon');
    el.style.setProperty('--c', `hsl(${hue} 65% 50%)`);
    el.dataset.familiar = FAMILIARS[hue % FAMILIARS.length];
    el.setAttribute('role', 'img');
    return el;
  };
  const agentEls = agents.map((agent) => {
    const el = familiar(agent.id, agent.name, hueFor(agent.name));
    el.classList.add('agent', agent.status);
    el.textContent = (agent.name || '?').charAt(0).toUpperCase();
    const detail = agent.detail ? ` — ${agent.detail}` : '';
    el.title = `${agent.name} (${agent.status})${detail}`;
    el.setAttribute('aria-label', el.title);
    return el;
  });
  const shellEls = shells.slice(0, MAX_SHELLS_SHOWN).map((shell) => {
    const el = familiar(shell.id, 'Shell', hueFor(shell.id));
    el.classList.add('agent', 'working', 'shell');
    el.textContent = '>';
    el.title = 'Shell command (running)';
    el.setAttribute('aria-label', el.title);
    return el;
  });
  if (shells.length > MAX_SHELLS_SHOWN) {
    const more = document.createElement('span');
    const hidden = shells.length - MAX_SHELLS_SHOWN;
    more.className = 'agent-overflow';
    more.dataset.agent = 'shell-overflow';
    more.textContent = `+${hidden}`;
    more.title = `${shells.length} shell commands running; ${hidden} more not drawn`;
    more.setAttribute('role', 'img');
    more.setAttribute('aria-label', more.title);
    shellEls.push(more);
  }
  container.replaceChildren(...agentEls, ...shellEls);
}

// ---- API ------------------------------------------------------------------

class AuthError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('The access token was rejected.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Request failed (HTTP ${res.status})`), data?.error);
  return data;
}

function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/v1${path}?token=${encodeURIComponent(state.token)}`;
}

// ---- providers ------------------------------------------------------------

function selectedAccount(provider) {
  const accounts = provider.accounts || [];
  return accounts.find((a) => a.id === state.accounts[provider.id]) || accounts[0] || { id: 'default', label: 'Default' };
}

function selectAccount(provider, id) {
  state.accounts[provider.id] = id;
  save(ACCOUNTS_KEY, JSON.stringify(state.accounts));
}

function usageFor(provider, account = selectedAccount(provider)) {
  return state.usage.get(`${provider.id}/${account.id}`);
}

function renderAccounts(card, provider) {
  const host = card.querySelector('.accounts');
  const accounts = provider.accounts || [];
  host.hidden = accounts.length < 2;
  if (host.hidden) return host.replaceChildren();
  const selected = selectedAccount(provider).id;
  const same = host.children.length === accounts.length && accounts.every((a, i) => host.children[i].dataset.account === a.id);
  if (!same) {
    host.replaceChildren(...accounts.map((account) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'account-chip';
      chip.setAttribute('role', 'tab');
      chip.dataset.account = account.id;
      chip.addEventListener('click', () => {
        selectAccount(provider, account.id);
        renderAccounts(card, provider);
        renderUsage(card, provider);
        renderReportingSetup(card, provider);
      });
      return chip;
    }));
  }
  accounts.forEach((account, i) => {
    const chip = host.children[i];
    chip.classList.toggle('unsigned', usageFor(provider, account)?.signedIn === false);
    chip.setAttribute('aria-selected', String(account.id === selected));
    chip.textContent = account.label;
    chip.title = `Start new ${provider.tool} sessions as the ${account.label} account`;
  });
}

function renderReportingSetup(card, provider) {
  const row = card.querySelector('.reporting-row');
  const account = selectedAccount(provider);
  row.hidden = !provider.available || typeof account.reportingEnabled !== 'boolean';
  if (row.hidden) return;
  const on = account.reportingEnabled;
  const whose = (provider.accounts || []).length > 1 ? ` for the ${account.label} account` : '';
  row.querySelector('.reporting-text').textContent = `Agent reporting ${on ? 'on' : 'off'}`;
  const button = row.querySelector('.reporting-toggle');
  button.textContent = on ? 'Turn off' : 'Turn on';
  button.title = on
    ? `Remove the Agent Guild extension from ${provider.tool}${whose}. New sessions stop reporting sub-agents.`
    : `Link the Agent Guild extension into ${provider.tool}${whose} with "${provider.command} extensions link", so new sessions show their sub-agents. It does nothing in sessions started outside Agent Guild.`;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await api('POST', `/providers/${provider.id}/reporting`, { account: account.id, enabled: !on });
      toast(on ? `Agent reporting is off for ${provider.tool}${whose}.` : `Agent reporting is on for ${provider.tool}${whose}. It applies to new sessions.`);
    } catch (err) {
      if (err instanceof AuthError) return showAuth(err.message);
      toast(err.message, 10000);
    } finally {
      button.disabled = false;
    }
  };
}

function syncViews() {
  document.dispatchEvent(new CustomEvent('agentguild:sync'));
}

let dealt = false;

function renderProviders() {
  const list = $('providers');
  const tpl = $('provider-template');
  list.replaceChildren(...state.providers.map((provider) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    paintProviderIcon(node.querySelector('.provider-icon'), provider);
    node.querySelector('.vendor').textContent = provider.vendor;
    node.querySelector('.tool').textContent = provider.tool;
    const stateLine = node.querySelector('.state');
    stateLine.textContent = providerState(provider);
    const checkFailed = provider.available && provider.versionStatus === 'failed';
    stateLine.classList.toggle('update-available', provider.updateAvailable || checkFailed || Boolean(installNote(provider)));
    stateLine.title = [provider.resolvedPath, provider.updateCommand && `Update: ${provider.updateCommand}`].filter(Boolean).join('\n');
    node.dataset.id = provider.id;
    node.classList.toggle('unavailable', !provider.available);
    node.setAttribute('aria-label', `${provider.vendor} ${provider.tool}, ${!provider.available ? 'not installed' : checkFailed ? 'version check failed' : 'ready'}`);
    const start = node.querySelector('.new');
    const existing = node.querySelector('.existing');
    const hint = node.querySelector('.hint');
    start.hidden = !provider.available;
    start.addEventListener('click', () => startSession(provider, node));
    existing.hidden = !provider.available || !provider.resumable;
    existing.title = provider.historySource
      ? `Resume one of ${provider.tool}'s own earlier sessions`
      : `Resume one of ${provider.tool}'s own sessions by its id`;
    existing.addEventListener('click', () => showHistory(provider));
    const install = node.querySelector('.install');
    install.hidden = provider.available || !provider.installable;
    install.title = `Install ${provider.tool} using npm.${provider.npmNote ? ` ${provider.npmNote}` : ''}`;
    install.addEventListener('click', () => installProvider(provider, node));
    const update = node.querySelector('.update');
    update.hidden = !(provider.available && provider.updateCommand && (provider.updateAvailable || checkFailed));
    if (provider.installChannel !== 'npm') update.textContent = 'Update';
    else update.textContent = checkFailed ? 'Reinstall' : `Update to ${provider.latestVersion}`;
    update.title = provider.updateCommand ? `Run "${provider.updateCommand}" in a session` : '';
    update.addEventListener('click', () => installProvider(provider, node));
    renderHint(hint, provider);
    renderCopies(node.querySelector('.copies'), provider);
    renderConsoleLinks(node, provider);
    renderAccounts(node, provider);
    renderUsage(node, provider);
    renderReportingSetup(node, provider);
    renderModelStats(node, provider);
    return node;
  }));
  if (!dealt && state.providers.length) {
    dealt = true;
    if (!reducedMotion.matches) list.classList.add('deal');
  }
  syncViews();
}

const openCopies = new Set();

function renderCopies(box, provider) {
  const installs = provider.installs || [];
  const warnings = provider.warnings || [];
  box.hidden = warnings.length === 0;
  if (box.hidden) return;
  const inUse = installs.some((i) => i.active);
  const older = installs.some((i) => i.newer);
  box.querySelector('summary').textContent = !inUse
    ? 'A copy exists off PATH'
    : `${installs.length} copies installed${older ? ' · older copy in use' : ''}`;
  box.open = openCopies.has(provider.id);
  box.addEventListener('toggle', () => (box.open ? openCopies.add(provider.id) : openCopies.delete(provider.id)));
  const line = (className, ...content) => {
    const span = document.createElement('span');
    span.className = className;
    span.append(...content);
    return span;
  };
  box.querySelector('ul').replaceChildren(...warnings.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }), ...installs.map((install) => {
    const item = document.createElement('li');
    const name = [CHANNEL_LABELS[install.channel] || install.channel, install.version && `v${install.version}`, install.active ? 'in use' : 'not in use'];
    item.append(line('copy-name', name.filter(Boolean).join(' · ')), line('copy-path', install.path));
    if (install.removeCommand) {
      const code = document.createElement('code');
      code.textContent = install.removeCommand;
      item.append(line('copy-remove', 'To remove it: ', code));
    } else {
      item.append(line('copy-remove', 'No removal command is known for this copy.'));
    }
    return item;
  }));
}

function renderHint(hint, provider) {
  let text = '';
  if (!provider.available) text = provider.installable ? '' : provider.install || `${provider.command} was not found on PATH.`;
  else if (provider.versionStatus === 'failed') text = [provider.versionError, !provider.updateCommand && provider.updateGuidance].filter(Boolean).join(' ');
  else if (provider.updateAvailable && !provider.updateCommand) text = provider.updateGuidance || '';
  hint.hidden = !text;
  hint.replaceChildren(text);
  const docs = text && httpsHref(provider.docs);
  if (!docs) return;
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = docs;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Docs';
  hint.append(' ', link);
}

function renderConsoleLinks(card, provider) {
  let any = false;
  for (const [selector, url, what] of [['.usage-link', provider.usageUrl, 'usage'], ['.billing-link', provider.billingUrl, 'billing']]) {
    const link = card.querySelector(selector);
    const href = httpsHref(url);
    link.hidden = !href;
    if (!href) { link.removeAttribute('href'); continue; }
    any = true;
    link.href = href;
    link.title = `${provider.vendor} ${what} console: ${href}`;
    link.setAttribute('aria-label', `${provider.vendor} ${what} console (opens in a new tab)`);
  }
  card.querySelector('.provider-links').hidden = !any;
}

function renderTier(card, provider, usage) {
  const tier = card.querySelector('.tier');
  const label = provider.available && usage?.plan ? planLabel(usage.plan) : '';
  tier.hidden = !label;
  tier.textContent = label;
  tier.title = label ? `${provider.vendor} subscription: ${label}` : '';
}

/** One line for a prepaid credit balance, when the provider reports one. */
function creditsNote(usage) {
  if (typeof usage?.credits !== 'number' || !Number.isFinite(usage.credits)) return [];
  const note = document.createElement('div');
  note.className = 'usage-note';
  note.textContent = `Credits: ${usage.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} left`;
  note.title = note.textContent;
  return [note];
}

function renderUsage(card, provider) {
  const host = card.querySelector('.usage');
  const account = selectedAccount(provider);
  const usage = usageFor(provider, account);
  renderTier(card, provider, provider.usageSource ? usage : null);
  const start = card.querySelector('.new');
  const unsigned = Boolean(provider.available && usage?.signedIn === false);
  start.textContent = unsigned ? 'Sign in' : 'New';
  start.title = unsigned
    ? `Start a ${provider.tool} session and sign in as the ${account.label} account`
    : `Start a new ${provider.tool} session${provider.accounts?.length > 1 ? ` as the ${account.label} account` : ''}`;
  if (!provider.available || !provider.usageSource || !usage) return host.replaceChildren();
  if (usage.error || usage.windows.length === 0) {
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = unsigned ? 'Not signed in yet' : `Usage: ${usage.error || 'no limits reported'}`;
    note.title = unsigned ? usage.error : note.textContent;
    return host.replaceChildren(note, ...creditsNote(usage));
  }
  host.replaceChildren(...usage.windows.map((w) => {
    const node = $('meter-template').content.firstElementChild.cloneNode(true);
    const left = Math.max(0, Math.round(100 - w.usedPercent));
    node.classList.toggle('low', left <= 25 && left > 10);
    node.classList.toggle('empty', left <= 10);
    node.querySelector('.meter-label').textContent = w.label;
    node.querySelector('.meter-fill').style.width = `${left}%`;
    node.querySelector('.meter-value').textContent = `${left}% left`;
    const when = untilTime(w.resetsAt);
    node.title = `${w.label}: ${Math.round(w.usedPercent)}% used${when ? `, ${when}` : ''}${usage.plan ? ` (${usage.plan} plan)` : ''}`;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', node.title);
    return node;
  }), ...creditsNote(usage));
}

async function loadUsage() {
  let usage;
  try { ({ usage } = await api('GET', '/usage')); } catch { return; }
  state.usage = new Map(usage.map((u) => [`${u.providerId}/${u.accountId ?? 'default'}`, u]));
  for (const card of $('providers').children) {
    const provider = state.providers.find((p) => p.id === card.dataset.id);
    if (!provider) continue;
    renderAccounts(card, provider);
    renderUsage(card, provider);
  }
  syncViews();
}

const ARTIFICIAL_ANALYSIS = 'Artificial Analysis';
const MODELS_SHOWN = 8;
const modelsView = { providerId: null, sessionId: null, focus: null, all: false, expanded: new Set() };
let modelsOpener = null;
let statsLoading = null;
let statsAgain = false;
let statsTimer;

function modelKey(s) {
  return s.model ? `${s.model.name}\n${s.model.displayName ?? ''}` : '';
}

function sessionModelId(s) {
  return state.statsFor.get(s.id) === modelKey(s) ? state.stats?.sessions[s.id] ?? null : null;
}

function loadStats() {
  if (statsLoading) {
    statsAgain = true;
    return statsLoading;
  }
  const asked = new Map([...state.sessions.values()].map((s) => [s.id, modelKey(s)]));
  statsLoading = api('GET', '/model-stats').then((stats) => {
    state.stats = stats;
    state.statsFor = asked;
    for (const card of $('providers').children) {
      const provider = state.providers.find((p) => p.id === card.dataset.id);
      if (provider) renderModelStats(card, provider);
    }
    renderSessions();
    if ($('models').open) {
      const body = document.querySelector('.models-body');
      const top = body.scrollTop;
      const focus = modelsFocus();
      const withTip = Boolean(tipFor?.closest('#models-list'));
      renderModels();
      body.scrollTop = top;
      restoreModelsFocus(focus, withTip);
    }
    if (tipFor && !tipFor.isConnected) hideTip();
  }, () => {}).finally(() => {
    statsLoading = null;
    if (statsAgain) {
      statsAgain = false;
      loadStats();
    }
  });
  return statsLoading;
}

function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(loadStats, 300);
}

function indexStats() {
  return state.stats?.stats.filter((stat) => stat.group === ARTIFICIAL_ANALYSIS) ?? [];
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] || suffixes[v] || suffixes[0]}`;
}

function listJoin(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(2))}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function formatPrice(n) {
  return `$${Number(n.toFixed(n < 1 ? 3 : 2))}`;
}

function formatDate(iso, options = { year: 'numeric', month: 'short', day: 'numeric' }) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, options);
}

function statValue(stat, entry) {
  return stat.group === ARTIFICIAL_ANALYSIS ? String(entry.value) : `Elo ${entry.value}`;
}

function statPlace(entry) {
  return `${entry.tied ? 'tied ' : ''}${ordinal(entry.place)} of ${entry.of}`;
}

function statSummary(stat, entry) {
  if (!entry) return `${stat.label}: no published result`;
  const value = `${stat.label} ${statValue(stat, entry)}`;
  if (entry.level === null) return `${value}: no other model has this result to compare with`;
  const rank = entry.rank === null ? '' : `, Design Arena rank ${entry.rank}`;
  return `${value}: level ${entry.level}, tier ${entry.tier}, ${statPlace(entry)}${rank}`;
}

function levelValue(entry) {
  if (!entry) return ['—'];
  if (entry.level === null) return [String(entry.value)];
  const tier = document.createElement('span');
  tier.className = 'stat-tier';
  tier.textContent = entry.tier;
  const level = document.createElement('span');
  level.className = 'level';
  level.textContent = entry.level;
  return [tier, level];
}

function tierClass(entry) {
  return entry?.tier ? `tier-${entry.tier.toLowerCase()}` : '';
}

function statRow(stat, card, { detail = false } = {}) {
  const node = $('stat-template').content.firstElementChild.cloneNode(true);
  const entry = card.stats[stat.id];
  node.querySelector('.stat-name').textContent = detail ? stat.label : stat.short;
  const info = node.querySelector('.info');
  info.dataset.stat = stat.id;
  info.setAttribute('aria-label', `${stat.label}: ${stat.about}`);
  const reading = node.querySelector('.stat-reading');
  reading.querySelector('.stat-value').replaceChildren(...levelValue(entry));
  node.classList.toggle('unmeasured', !entry);
  if (entry?.tier) {
    node.classList.add(tierClass(entry));
    reading.querySelector('.stat-fill').style.width = `${entry.level}%`;
  }
  if (detail) {
    const rank = entry?.rank == null ? '' : ` · Rank ${entry.rank}`;
    reading.querySelector('.stat-note').textContent = !entry ? 'No published result'
      : entry.level === null ? statValue(stat, entry) : `${statPlace(entry)} · ${statValue(stat, entry)}${rank}`;
  }
  reading.title = statSummary(stat, entry);
  reading.setAttribute('aria-label', reading.title);
  return node;
}

let tipFor = null;
let quietFocus = false;

function showTip(button) {
  const stat = state.stats?.stats.find((s) => s.id === button.dataset.stat);
  if (!stat) return;
  const tip = $('tip');
  $('tip-title').textContent = stat.label;
  $('tip-source').textContent = stat.group;
  $('tip-text').textContent = stat.about;
  const host = $('models').open ? $('models') : document.body;
  if (tip.parentElement !== host) host.append(tip);
  tip.hidden = false;
  const box = button.getBoundingClientRect();
  const left = Math.min(Math.max(8, box.left + box.width / 2 - tip.offsetWidth / 2), innerWidth - tip.offsetWidth - 8);
  const below = box.bottom + 8 + tip.offsetHeight <= innerHeight;
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(below ? box.bottom + 8 : box.top - tip.offsetHeight - 8)}px`;
  tipFor = button;
}

function hideTip() {
  $('tip').hidden = true;
  tipFor = null;
}

function renderModelStats(card, provider) {
  const host = card.querySelector('.model-stats');
  const stats = state.stats;
  const entry = stats?.providers[provider.id];
  if (!entry) {
    if (!stats?.error || !provider.modelPattern) return host.replaceChildren();
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = `Benchmarks: ${stats.error}`;
    note.title = note.textContent;
    return host.replaceChildren(note);
  }
  const featured = stats.models[entry.featured];
  const count = entry.models.length;
  const complete = indexStats().every((stat) => featured.stats[stat.id]);
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'model-stats-head';
  head.textContent = `${featured.name} · ${count} model${count === 1 ? '' : 's'}`;
  head.setAttribute('aria-label', head.textContent);
  head.title = `${featured.name} is the newest ${provider.tool} model with ${complete ? 'all three Artificial Analysis indexes' : 'published benchmarks'}. Open to compare ${count === 1 ? 'it' : `all ${count}`}.`;
  head.addEventListener('click', () => showModels({ providerId: provider.id, focus: featured.id }));
  host.replaceChildren(head, ...indexStats().map((stat) => statRow(stat, featured)));
}

function modelStatsLine(s) {
  const id = sessionModelId(s);
  const card = id ? state.stats.models[id] : null;
  if (!card) return '';
  return indexStats().map((stat) => {
    const entry = card.stats[stat.id];
    return `${stat.short} ${entry?.tier ? `${entry.tier} ${entry.level}` : '—'}`;
  }).join(' · ');
}

function modelsFocus() {
  const active = document.activeElement;
  const row = active?.closest?.('#models-list .model');
  return row ? { id: row.dataset.id, stat: active.dataset.stat ?? null } : null;
}

function restoreModelsFocus(focus, withTip) {
  const row = focus && [...$('models-list').children].find((el) => el.dataset.id === focus.id);
  if (!row) return;
  const info = focus.stat && row.querySelector(`.info[data-stat="${focus.stat}"]`);
  quietFocus = true;
  (info || row.querySelector('.model-toggle')).focus({ preventScroll: true });
  quietFocus = false;
  if (withTip && info) showTip(info);
}

function showModels({ providerId = null, sessionId = null, focus = null }) {
  Object.assign(modelsView, { providerId, sessionId, focus, all: false, expanded: new Set(focus ? [focus] : []) });
  const dialog = $('models');
  renderModels();
  if (!dialog.open) {
    modelsOpener = document.activeElement;
    dialog.showModal();
  }
  const toggle = $('models-list').querySelector('[aria-expanded="true"]');
  toggle?.focus();
  toggle?.scrollIntoView({ block: 'nearest' });
}

function openSessionModel(id) {
  const s = state.sessions.get(id);
  if (!s?.model) return;
  if (!state.stats || state.statsFor.get(id) !== modelKey(s)) scheduleStats();
  showModels({ sessionId: id, focus: sessionModelId(s) });
}

function unmatchedText(s) {
  const stats = state.stats;
  if (!stats) return 'Loading benchmarks from OpenRouter…';
  if (!stats.pool) return `Benchmarks are unavailable: ${stats.error}.`;
  if (!(s.id in stats.sessions) || state.statsFor.get(s.id) !== modelKey(s)) return 'Looking this model up in OpenRouter’s catalog…';
  const names = [s.model.name, s.model.displayName].filter((name, i, all) => name && all.indexOf(name) === i);
  return `OpenRouter’s catalog has no model named ${names.map((name) => `“${name}”`).join(' or ')}.`;
}

function sourceText(stats, { levels = true } = {}) {
  if (!stats?.retrievedAt) return '';
  const parts = [`Benchmarks from Artificial Analysis and Design Arena via OpenRouter, fetched ${relativeTime(stats.retrievedAt)}.`];
  if (stats.stale) parts.push(`The last refresh failed (${stats.error}), so these results may be out of date.`);
  if (stats.pool && levels) {
    parts.push('Artificial Analysis results are index scores. Design Arena results are Elo ratings from real users\' head-to-head votes, and Rank is the model\'s place on Design Arena\'s own leaderboard.');
    parts.push(`Level 0–100 is a model's standing on each benchmark among the models ${listJoin(stats.pool.tools)} run; 100 is the best result.`);
    parts.push('Tier: S 90+, A 75+, B 50+, C 25+, D below 25.');
  }
  return parts.join(' ');
}

function usedBy(id) {
  return [...state.sessions.values()]
    .filter((s) => s.status === 'running' && sessionModelId(s) === id)
    .map((s) => s.name);
}

function badge(kind, label, title) {
  const el = document.createElement('span');
  el.className = `badge ${kind}`;
  el.textContent = label;
  el.title = title;
  return el;
}

function modelFacts(card) {
  const list = document.createElement('dl');
  list.className = 'model-facts';
  const fact = (term, value) => {
    if (!value) return;
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  };
  fact('Context', card.context ? `${formatTokens(card.context)} tokens` : '');
  fact('Max output', card.maxOutput ? `${formatTokens(card.maxOutput)} tokens` : '');
  fact('Input', card.input.join(', '));
  fact('Reasoning effort', card.reasoning.join(', '));
  if (card.price.input !== null && card.price.output !== null) {
    fact('Price', `${formatPrice(card.price.input)} input · ${formatPrice(card.price.output)} output per 1M tokens`);
  }
  fact('Created', card.created ? formatDate(card.created) : '');
  fact('Expires', card.expires ? formatDate(card.expires, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = httpsHref(`https://openrouter.ai/${card.id}`) ?? '';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'OpenRouter';
  link.setAttribute('aria-label', `${card.name} on OpenRouter (opens in a new tab)`);
  const facts = document.createElement('div');
  facts.className = 'model-more';
  facts.append(list, link);
  return facts;
}

function modelDetail(card) {
  const groups = [];
  for (const stat of state.stats.stats) {
    if (groups.at(-1)?.name !== stat.group) groups.push({ name: stat.group, stats: [] });
    groups.at(-1).stats.push(stat);
  }
  const sections = groups.map(({ name, stats }) => {
    const section = document.createElement('div');
    section.className = 'model-group';
    const heading = document.createElement('h4');
    heading.textContent = name;
    section.append(heading);
    if (stats.some((stat) => card.stats[stat.id])) {
      section.append(...stats.map((stat) => statRow(stat, card, { detail: true })));
    } else {
      const none = document.createElement('p');
      none.className = 'model-none';
      none.textContent = 'No published results';
      section.append(none);
    }
    return section;
  });
  return [...sections, modelFacts(card)];
}

function modelRow(card) {
  const node = $('model-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = card.id;
  const toggle = node.querySelector('.model-toggle');
  const detail = node.querySelector('.model-detail');
  node.querySelector('.model-name').textContent = card.name;
  const users = usedBy(card.id);
  const badges = [];
  if (users.length) badges.push(badge('in-use', 'In use', `Used by ${listJoin(users)}`));
  if (card.new) badges.push(badge('new', 'New', `Created ${formatDate(card.created)}`));
  if (card.expires) {
    const day = formatDate(card.expires, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    badges.push(badge('expires', `Expires ${day}`, `OpenRouter lists this model as expiring on ${formatDate(card.expires, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
  }
  node.querySelector('.model-title').append(...badges);
  for (const stat of indexStats()) {
    const entry = card.stats[stat.id];
    const cell = document.createElement('span');
    cell.className = ['model-index', tierClass(entry), entry ? '' : 'unmeasured'].filter(Boolean).join(' ');
    cell.replaceChildren(...levelValue(entry));
    cell.title = statSummary(stat, entry);
    toggle.append(cell);
  }
  const context = document.createElement('span');
  context.className = 'model-context';
  context.textContent = formatTokens(card.context);
  context.title = card.context ? `Context: ${card.context.toLocaleString()} tokens` : 'Context: not listed';
  toggle.append(context);
  const summary = indexStats().map((stat) => statSummary(stat, card.stats[stat.id])).join('. ');
  toggle.setAttribute('aria-description', summary);
  const expand = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !detail.childElementCount) detail.replaceChildren(...modelDetail(card));
    detail.hidden = !open;
  };
  expand(modelsView.expanded.has(card.id));
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    if (open) modelsView.expanded.add(card.id);
    else modelsView.expanded.delete(card.id);
    expand(open);
  });
  return node;
}

function renderModels() {
  const stats = state.stats;
  const session = modelsView.sessionId ? state.sessions.get(modelsView.sessionId) : null;
  const provider = session?.provider ?? state.providers.find((p) => p.id === modelsView.providerId);
  if (!provider || (modelsView.sessionId && !session?.model)) return $('models').close();
  paintProviderIcon($('models-icon'), provider);
  const list = stats?.providers[provider.id]?.models ?? [];
  let ids = list;
  let title = `${provider.tool} models`;
  let note = '';
  if (session) {
    const id = sessionModelId(session);
    if (id && !modelsView.focus) {
      modelsView.focus = id;
      modelsView.expanded.add(id);
    }
    if (!id) {
      ids = [];
      title = `${provider.tool} · ${modelText(session)}`;
      note = unmatchedText(session);
    } else if (!list.includes(id)) {
      ids = [id];
      title = `${provider.tool} · ${stats.models[id].name}`;
    }
  } else if (!stats) {
    note = 'Loading benchmarks from OpenRouter…';
  } else if (list.length === 0) {
    note = stats.error ? `Benchmarks are unavailable: ${stats.error}.` : `OpenRouter lists no benchmarked ${provider.tool} models.`;
  }
  $('models-title').textContent = title;
  $('models-sub').textContent = ids.length > 1
    ? `${ids.length} models with published benchmarks, newest first`
    : session ? `Reported by ${session.name} as “${session.model.name}”` : '';
  const all = modelsView.all || ids.length <= MODELS_SHOWN || ids.indexOf(modelsView.focus) >= MODELS_SHOWN;
  const shown = all ? ids : ids.slice(0, MODELS_SHOWN);
  const columns = $('models-columns');
  columns.hidden = shown.length === 0;
  columns.replaceChildren(...['Model', ...indexStats().map((stat) => stat.short), 'Context'].map((label) => {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  }));
  $('models-list').replaceChildren(...shown.map((id) => modelRow(stats.models[id])));
  const more = $('models-more');
  more.hidden = all;
  more.textContent = `Show ${ids.length - shown.length} older models`;
  $('models-note').textContent = note;
  $('models-note').hidden = !note;
  $('models-source').textContent = sourceText(stats, { levels: shown.length > 0 });
  $('models-source').hidden = !$('models-source').textContent;
}

function closeModels() {
  if ($('models').open) $('models').close();
}

const NEWS_LATEST = 5;
const NEWS_POLL_MS = 10 * 60 * 1000;
const NEWS_FILTERS = [['all', 'All'], ['news', 'News'], ['releases', 'Releases'], ['research', 'Research']];
const newsView = { shown: null, since: Infinity, filter: 'all', opener: null };
let newsLoading = null;
let newsAgain = false;
let newsLoadedAt = 0;

function newsSeen() {
  const seen = Date.parse(load(NEWS_SEEN_KEY));
  return Number.isFinite(seen) ? seen : null;
}

function newestTime(items) {
  return items.reduce((newest, item) => Math.max(newest, Date.parse(item.publishedAt) || 0), 0);
}

function loadNews() {
  if (newsLoading) {
    newsAgain = true;
    return newsLoading;
  }
  newsLoading = api('GET', '/news').then(setNews, () => {}).finally(() => {
    newsLoading = null;
    newsLoadedAt = Date.now();
    if (newsAgain) {
      newsAgain = false;
      loadNews();
    }
  });
  return newsLoading;
}

function setNews(news) {
  state.news = news;
  if (newsSeen() === null && news.items.length) save(NEWS_SEEN_KEY, new Date(newestTime(news.items)).toISOString());
  renderLatestNews();
  if ($('news').open) updateNewsPanel();
}

function webHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function newsTitle(item) {
  const href = webHref(item.url);
  const title = document.createElement(href ? 'a' : 'span');
  title.className = 'news-link';
  title.textContent = item.title;
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.setAttribute('aria-description', 'Opens in a new tab');
  }
  return title;
}

function newsMeta(item) {
  const meta = document.createElement('span');
  meta.className = 'news-meta';
  const time = document.createElement('time');
  time.dateTime = item.publishedAt;
  time.textContent = relativeTime(item.publishedAt);
  time.title = new Date(item.publishedAt).toLocaleString();
  meta.append(`${item.source} · `, time);
  return meta;
}

function isNew(item, since) {
  return Date.parse(item.publishedAt) > since;
}

function newBadge() {
  return badge('new', 'New', 'Published since you last opened the news');
}

function latestNews(items) {
  const sources = new Set();
  const latest = [];
  for (const item of items) {
    if (item.category !== 'news' || sources.has(item.source)) continue;
    sources.add(item.source);
    latest.push(item);
    if (latest.length === NEWS_LATEST) break;
  }
  return latest;
}

function failureLines(news) {
  const groups = new Map();
  for (const source of news.sources) if (source.error) groups.set(source.error, [...(groups.get(source.error) ?? []), source]);
  return [...groups].map(([error, sources]) => {
    if (sources.length === 1) {
      const [source] = sources;
      return `${source.name}: ${error} · ${source.okAt ? `showing items fetched ${relativeTime(source.okAt)}` : 'nothing fetched yet'}`;
    }
    const names = [...new Set(sources.map((source) => source.name))];
    return `${names.length <= 3 ? listJoin(names) : `${sources.length} sources`}: ${error}`;
  });
}

function newsNote(news) {
  if (!news || (news.refreshing && news.items.length === 0)) return 'Loading news…';
  const failed = news.sources.filter((s) => s.error);
  if (news.items.length === 0 && failed.length > 0 && failed.length === news.sources.length) {
    return `News could not be loaded. ${failureLines(news)[0]}. Agent Guild tries again in a few minutes.`;
  }
  return 'No news from the last 30 days.';
}

function renderLatestNews() {
  const news = state.news;
  const list = $('news-latest');
  const seen = newsSeen() ?? Infinity;
  const items = news ? latestNews(news.items) : [];
  const focused = document.activeElement?.closest?.('#news-latest .news-row')?.dataset.id;
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement('li');
    row.className = 'news-row';
    row.dataset.id = item.id;
    row.append(newsTitle(item), ...(isNew(item, seen) ? [newBadge()] : []), newsMeta(item));
    return row;
  }));
  if (focused) [...list.children].find((row) => row.dataset.id === focused)?.querySelector('.news-link')?.focus({ preventScroll: true });
  list.hidden = items.length === 0;
  const fresh = news ? news.items.filter((item) => item.category === 'news' && isNew(item, seen)).length : 0;
  $('news-count').textContent = fresh ? `· ${fresh} new` : '';
  $('news-note').textContent = items.length ? '' : newsNote(news);
  $('news-note').hidden = items.length > 0;
}

function dayLabel(time) {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function newsEntry(item) {
  const entry = document.createElement('li');
  entry.className = 'news-item';
  entry.dataset.id = item.id;
  const head = document.createElement('div');
  head.className = 'news-head';
  head.append(newsTitle(item), ...(isNew(item, newsView.since) ? [newBadge()] : []));
  entry.append(head, newsMeta(item));
  if (item.summary) {
    const summary = document.createElement('p');
    summary.className = 'news-summary';
    const discussion = webHref(item.discussion);
    if (discussion) {
      const link = document.createElement('a');
      link.className = 'news-discussion';
      link.href = discussion;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.summary;
      link.setAttribute('aria-description', `Opens the discussion on ${item.source} in a new tab`);
      summary.append(link);
    } else {
      summary.textContent = item.summary;
    }
    entry.append(summary);
  }
  return entry;
}

function renderNewsFilters() {
  $('news-filters').replaceChildren(...NEWS_FILTERS.map(([id, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'news-filter';
    chip.textContent = label;
    chip.setAttribute('aria-pressed', String(id === newsView.filter));
    chip.addEventListener('click', () => {
      newsView.filter = id;
      save(NEWS_FILTER_KEY, id);
      for (const other of $('news-filters').children) other.setAttribute('aria-pressed', String(other === chip));
      newsView.shown = state.news;
      renderNewsList();
      document.querySelector('.news-body').scrollTop = 0;
    });
    return chip;
  }));
}

function renderNewsList() {
  const shown = newsView.shown;
  const items = (shown?.items ?? []).filter((item) => newsView.filter === 'all' || item.category === newsView.filter);
  const groups = [];
  for (const item of items) {
    const label = dayLabel(Date.parse(item.publishedAt));
    if (groups.at(-1)?.label !== label) groups.push({ label, items: [] });
    groups.at(-1).items.push(item);
  }
  $('news-list').replaceChildren(...groups.map((group) => {
    const section = document.createElement('section');
    section.className = 'news-group';
    const heading = document.createElement('h3');
    heading.className = 'news-day';
    heading.textContent = group.label;
    const list = document.createElement('ul');
    list.className = 'news-items';
    list.append(...group.items.map(newsEntry));
    section.append(heading, list);
    return section;
  }));
  const label = NEWS_FILTERS.find(([id]) => id === newsView.filter)[1];
  $('news-empty').textContent = items.length ? '' : newsView.filter === 'all' || !shown ? newsNote(shown) : `Nothing in ${label} from the last 30 days.`;
  $('news-empty').hidden = items.length > 0;
  $('news-fresh').hidden = true;
  const fresh = (shown?.items ?? []).filter((item) => isNew(item, newsView.since)).length;
  $('news-sub').textContent = fresh ? `${fresh} new since your last visit` : 'Newest first';
}

function renderNewsStatus() {
  const news = state.news;
  const status = $('news-status');
  status.hidden = !news;
  if (!news) return;
  const updated = news.refreshing ? 'checking for news…' : news.refreshedAt ? `updated ${relativeTime(news.refreshedAt)}` : '';
  const lines = [[`${news.sources.length} source${news.sources.length === 1 ? '' : 's'}`, updated].filter(Boolean).join(' · '), ...failureLines(news)];
  status.replaceChildren(...lines.map((text) => {
    const line = document.createElement('span');
    line.textContent = text;
    return line;
  }));
}

function updateNewsPanel() {
  renderNewsStatus();
  if (!newsView.shown?.items.length) {
    newsView.shown = state.news;
    renderNewsList();
    return;
  }
  const shownIds = new Set(newsView.shown.items.map((item) => item.id));
  const added = state.news.items.filter((item) => !shownIds.has(item.id) && (newsView.filter === 'all' || item.category === newsView.filter)).length;
  const fresh = $('news-fresh');
  fresh.hidden = added === 0;
  fresh.textContent = `Show ${added} new item${added === 1 ? '' : 's'}`;
}

function showFreshNews() {
  const before = new Set(newsView.shown.items.map((item) => item.id));
  newsView.shown = state.news;
  renderNewsList();
  const first = [...$('news-list').querySelectorAll('.news-item')].find((entry) => !before.has(entry.dataset.id));
  (first?.querySelector('.news-link') ?? $('news-close')).focus();
}

function openNews() {
  const dialog = $('news');
  const saved = load(NEWS_FILTER_KEY);
  newsView.filter = NEWS_FILTERS.some(([id]) => id === saved) ? saved : 'all';
  newsView.since = newsSeen() ?? Infinity;
  newsView.shown = state.news;
  renderNewsFilters();
  renderNewsList();
  renderNewsStatus();
  if (!dialog.open) {
    newsView.opener = document.activeElement;
    dialog.showModal();
  }
  ($('news-list').querySelector('.news-link') ?? $('news-close')).focus();
  if (!state.news) loadNews();
}

function closeNews() {
  if ($('news').open) $('news').close();
}

function tickNews() {
  for (const time of document.querySelectorAll('#news-latest time, #news-list time')) time.textContent = relativeTime(time.dateTime);
  if ($('news').open) renderNewsStatus();
}

const RELEASE_BADGES = {
  running: ['in-use', 'Running', 'The session manager runs this version'],
  installed: ['installed', 'Installed', 'Installed. Restart the session manager to use it.'],
  newer: ['new', 'New', 'Released after the version the session manager runs'],
};
const changelogView = { opener: null, failed: null, seen: null };
let changelogLoading = null;
let changelogAgain = false;

function loadChangelog() {
  if (changelogLoading) {
    changelogAgain = true;
    return changelogLoading;
  }
  changelogLoading = api('GET', '/changelog').then((changelog) => {
    state.changelog = changelog;
    changelogView.failed = null;
  }, (err) => {
    if (err instanceof AuthError) return showAuth(err.message);
    changelogView.failed = state.connected ? err.message : 'the session manager is not reachable';
  }).finally(() => {
    changelogLoading = null;
    if ($('changelog').open) {
      markReleasesSeen(state.changelog?.releases[0]?.version);
      renderVersion();
      renderChangelog();
    }
    if (changelogAgain) {
      changelogAgain = false;
      loadChangelog();
    }
  });
  return changelogLoading;
}

function openChangelog() {
  const dialog = $('changelog');
  renderChangelog();
  if (!dialog.open) {
    changelogView.opener = document.activeElement;
    dialog.showModal();
  }
  ($('changelog-list').querySelector('a') ?? $('changelog-close')).focus();
  markReleasesSeen(state.version, state.upgrade?.pendingVersion, state.upgrade?.latestVersion, state.changelog?.releases[0]?.version);
  renderVersion();
  loadChangelog();
}

function closeChangelog() {
  if ($('changelog').open) $('changelog').close();
}

function releasesLink(label) {
  const link = document.createElement('a');
  link.className = 'console-link';
  link.href = RELEASES_URL;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  link.setAttribute('aria-description', 'Opens in a new tab');
  return link;
}

function releaseStatus(version) {
  const running = state.version;
  if (!RELEASE_VERSION.test(running ?? '')) return null;
  const order = compareReleases(version, running);
  if (order <= 0) return order === 0 ? 'running' : null;
  const installed = state.upgrade?.pendingVersion;
  return RELEASE_VERSION.test(installed ?? '') && compareReleases(version, installed) <= 0 ? 'installed' : 'newer';
}

function changeRun(run) {
  const href = run.url ? webHref(run.url) : null;
  let node;
  if (href) {
    node = document.createElement('a');
    node.className = 'console-link';
    node.href = href;
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
    node.textContent = run.text;
  } else if (run.code) {
    node = document.createElement('code');
    node.textContent = run.text;
  } else {
    node = document.createTextNode(run.text);
  }
  if (!run.strong) return node;
  const strong = document.createElement('strong');
  strong.append(node);
  return strong;
}

function changeGroup(section) {
  const group = document.createElement('div');
  group.className = 'changelog-group';
  if (section.title) {
    const title = document.createElement('h4');
    title.className = 'changelog-type';
    title.classList.toggle('breaking', /breaking/i.test(section.title));
    title.textContent = section.title;
    group.append(title);
  }
  const list = document.createElement('ul');
  list.className = 'changelog-changes';
  list.append(...section.changes.map((runs) => {
    const item = document.createElement('li');
    item.append(...runs.map(changeRun));
    return item;
  }));
  group.append(list);
  return group;
}

function releaseEntry(release) {
  const entry = document.createElement('li');
  entry.className = 'changelog-release';
  entry.dataset.version = release.version;
  const heading = document.createElement('h3');
  heading.className = 'news-head';
  const href = webHref(release.url);
  const title = document.createElement(href ? 'a' : 'span');
  title.className = 'news-link';
  title.textContent = `v${release.version}`;
  if (href) {
    title.href = href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.setAttribute('aria-description', 'Opens the release on GitHub in a new tab');
  }
  heading.append(title);
  const status = releaseStatus(release.version);
  if (status) heading.append(badge(...RELEASE_BADGES[status]));
  entry.append(heading);
  if (release.publishedAt) {
    const time = document.createElement('time');
    time.className = 'news-meta';
    time.dateTime = release.publishedAt;
    time.textContent = relativeTime(release.publishedAt);
    time.title = new Date(release.publishedAt).toLocaleString();
    entry.append(time);
  }
  entry.append(...release.sections.map(changeGroup));
  return entry;
}

function changelogSummary() {
  const v = state.version;
  if (!v) return 'Agent Guild releases, newest first';
  if (isDevelopmentBuild(v)) return `Development build (${v}) · releases, newest first`;
  const u = state.upgrade;
  const parts = [`Running v${v}`];
  if (u?.pendingVersion) parts.push(`v${u.pendingVersion} installed`);
  const newer = state.changelog?.releases.some((release) => compareReleases(release.version, v) > 0);
  if (u?.available && u.latestVersion) parts.push(`v${u.latestVersion} available`);
  else if (!u?.pendingVersion && u?.latestVersion === v && !newer) parts.push('the latest release');
  return parts.join(' · ');
}

function changelogNote(changelog) {
  if (changelog?.releases.length) return [];
  if (changelogView.failed) return [`Release notes could not be loaded: ${changelogView.failed}. `, releasesLink('Read them on GitHub')];
  if (!changelog || changelog.refreshing) return ['Loading release notes…'];
  if (changelog.error) return [`Release notes could not be loaded. GitHub Releases: ${changelog.error}. `, releasesLink('Read them on GitHub')];
  return ['No releases yet.'];
}

function renderChangelogStatus(changelog) {
  const lines = [];
  if (changelog) {
    const updated = changelog.refreshing ? 'checking for new releases…' : changelog.okAt ? `updated ${relativeTime(changelog.okAt)}` : '';
    lines.push(['From GitHub Releases', updated].filter(Boolean).join(' · '));
    if (changelog.error && changelog.releases.length) lines.push(`The last check failed (${changelog.error}); showing notes fetched ${relativeTime(changelog.okAt)}.`);
  }
  lines.push(releasesLink('All releases on GitHub'));
  $('changelog-status').replaceChildren(...lines.map((content) => {
    const line = document.createElement('span');
    line.append(content);
    return line;
  }));
  $('changelog-status').hidden = false;
}

function renderChangelog() {
  const changelog = state.changelog;
  const releases = changelog?.releases ?? [];
  $('changelog-sub').textContent = changelogSummary();
  const list = $('changelog-list');
  const body = list.parentElement;
  const top = body.scrollTop;
  const entry = document.activeElement?.closest?.('#changelog-list .changelog-release');
  const focus = entry && { version: entry.dataset.version, index: [...entry.querySelectorAll('a')].indexOf(document.activeElement) };
  list.replaceChildren(...releases.map(releaseEntry));
  list.hidden = releases.length === 0;
  const note = changelogNote(changelog);
  $('changelog-note').replaceChildren(...note);
  $('changelog-note').hidden = note.length === 0;
  renderChangelogStatus(changelog);
  body.scrollTop = top;
  if (focus) {
    const again = [...list.children].find((el) => el.dataset.version === focus.version);
    (again?.querySelectorAll('a')[focus.index] ?? again?.querySelector('a') ?? $('changelog-close')).focus({ preventScroll: true });
  }
}

const CHANNEL_LABELS = {
  npm: 'npm', native: 'native', brew: 'Homebrew', winget: 'WinGet', legacy: 'legacy install', unknown: 'unknown install',
};

function installNote(provider) {
  const last = provider.lastInstall;
  if (!last) return '';
  if (last.outcome === 'failed') {
    const what = last.kind === 'install' ? 'Install' : 'Update';
    return last.exitCode === null ? `${what} failed` : `${what} failed (exit ${last.exitCode})`;
  }
  if (last.verification === 'failed') return `Installation completed, but ${provider.tool} verification failed`;
  if (last.outcome === 'missing') return 'Installed, but not found on PATH';
  if (last.outcome === 'unchanged') return 'No version change after update';
  return '';
}

function providerState(provider) {
  const note = installNote(provider);
  if (!provider.available) return note ? `Not installed · ${note}` : 'Not installed';
  const checkFailed = provider.versionStatus === 'failed';
  const named = provider.installChannel && (provider.installChannel !== 'unknown' || provider.updateAvailable || checkFailed);
  const channel = named ? CHANNEL_LABELS[provider.installChannel] || provider.installChannel : '';
  if (checkFailed) {
    const unverified = note && provider.lastInstall.outcome !== 'failed' && provider.lastInstall.verification === 'failed';
    return (unverified ? [note, channel] : ['Version check failed', channel, note]).filter(Boolean).join(' · ');
  }
  const parts = ['Ready'];
  if (provider.installedVersion) parts.push(`v${provider.installedVersion}`);
  else if (provider.versionStatus === 'unavailable') parts.push('Version unavailable');
  if (channel) parts.push(channel);
  if (provider.updateAvailable) parts.push(`${provider.latestVersion} ${provider.installChannel === 'npm' ? 'available' : 'released'}`);
  if (note) parts.push(note);
  return parts.join(' · ');
}

async function installProvider(provider, card, { force = false } = {}) {
  card.classList.add('busy');
  try {
    const { session } = await api('POST', `/providers/${provider.id}/install`, { force });
    upsertSession(session);
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'provider_in_use') {
      card.classList.remove('busy');
      const n = err.running;
      const what = `${n} ${provider.tool} session${n === 1 ? ' is' : 's are'} running`;
      if (confirm(`${what}. Updating ${provider.tool} while it runs can break ${n === 1 ? 'that session' : 'those sessions'}. Update anyway?`)) {
        return installProvider(provider, card, { force: true });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    card.classList.remove('busy');
  }
}

/**
 * Start a session. A resumed session starts in the folder its transcript
 * names, since Claude Code and Gemini CLI only find a session from there;
 * when that folder is gone, the working folder is used instead.
 */
async function startSession(provider, card, { resume, cwd, account = selectedAccount(provider).id } = {}) {
  const working = $('cwd').value.trim();
  save(CWD_KEY, working);
  card?.classList.add('busy');
  try {
    const body = { providerId: provider.id, account, cwd: cwd || working || undefined, cols: 120, rows: 32, resume };
    let session;
    try {
      ({ session } = await api('POST', '/sessions', body));
    } catch (err) {
      if (err.code !== 'bad_cwd' || !cwd) throw err;
      toast(`${cwd} no longer exists; starting in the working folder instead.`, 8000);
      ({ session } = await api('POST', '/sessions', { ...body, cwd: working || undefined }));
    }
    upsertSession(session);
    closeHistory({ focusOpener: false });
    openPanel(session.id);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  } finally {
    card?.classList.remove('busy');
  }
}

// ---- session history ------------------------------------------------------

const HISTORY_LIMIT = 200;
const historyView = { providerId: null, accountId: null, snapshot: null, loading: false };
let historyOpener = null;

function historyProvider() {
  return state.providers.find((p) => p.id === historyView.providerId) ?? null;
}

function toolSessionId(s) {
  return s.toolSessionId || s.resume || null;
}

function shortId(id) {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function copyText(text, what) {
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${what}`, 2500), () => toast(text, 10000));
}

function copyId(id) {
  copyText(id, id);
}

function paintIdButton(button, id) {
  button.hidden = !id;
  if (!id) return;
  button.textContent = shortId(id);
  button.title = `Session id ${id}. Click to copy it.`;
  button.setAttribute('aria-label', `Copy session id ${id}`);
}

function runningOn(providerId, accountId, id) {
  return [...state.sessions.values()].find((s) =>
    s.status === 'running' && s.task === null && s.provider.id === providerId && (s.account?.id ?? 'default') === accountId && toolSessionId(s) === id) ?? null;
}

function showHistory(provider) {
  const account = selectedAccount(provider);
  const same = historyView.providerId === provider.id && historyView.accountId === account.id;
  if (!same) Object.assign(historyView, { providerId: provider.id, accountId: account.id, snapshot: null, loading: false });
  const dialog = $('history');
  $('history-filter').value = '';
  $('history-id').value = '';
  renderHistory();
  if (!dialog.open) {
    historyOpener = document.activeElement;
    dialog.showModal();
  }
  if (provider.historySource) loadHistory();
  else $('history-id').focus();
}

async function loadHistory() {
  const provider = historyProvider();
  if (!provider || historyView.loading) return;
  const { providerId, accountId } = historyView;
  historyView.loading = true;
  renderHistory();
  try {
    const { history } = await api('GET', `/providers/${providerId}/history?account=${encodeURIComponent(accountId)}&limit=${HISTORY_LIMIT}`);
    if (historyView.providerId === providerId && historyView.accountId === accountId) historyView.snapshot = history;
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (historyView.providerId === providerId) historyView.snapshot = { sessions: [], total: 0, error: err.message };
  } finally {
    historyView.loading = false;
    renderHistory();
  }
}

function historyText(entry) {
  return `${entry.title ?? ''}\n${entry.cwd ?? ''}\n${entry.id}`.toLowerCase();
}

function folderName(dir) {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || dir;
}

function sameFolder(a, b) {
  const clean = (dir) => (dir || '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  return clean(a) === clean(b);
}

function historyEntry(id) {
  return historyView.snapshot?.sessions.find((entry) => entry.id === id) ?? null;
}

function resumeFromHistory(provider, id, cwd) {
  const running = runningOn(provider.id, historyView.accountId, id);
  if (running) {
    closeHistory({ focusOpener: false });
    openPanel(running.id);
  } else startSession(provider, null, { resume: id, cwd: cwd || undefined, account: historyView.accountId });
}

function buildHistoryRow(id) {
  const node = $('history-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = id;
  const idButton = node.querySelector('.session-id');
  paintIdButton(idButton, id);
  idButton.addEventListener('click', () => copyId(id));
  node.querySelector('.history-resume').addEventListener('click', () => {
    const provider = historyProvider();
    const entry = historyEntry(id);
    if (provider && entry) resumeFromHistory(provider, id, entry.cwd);
  });
  return node;
}

function updateHistoryRow(node, provider, entry) {
  const running = runningOn(provider.id, historyView.accountId, entry.id);
  node.classList.toggle('untitled', !entry.title);
  node.classList.toggle('running', Boolean(running));
  node.querySelector('.history-title').textContent = entry.title ?? 'Untitled session';
  node.querySelector('.history-title').title = entry.title ?? '';
  const meta = node.querySelector('.history-meta');
  const when = entry.updatedAt ? `updated ${relativeTime(entry.updatedAt)}` : '';
  meta.textContent = [entry.cwd && folderName(entry.cwd), when, running && `open in Agent Guild as ${running.name}`].filter(Boolean).join(' · ');
  meta.title = [entry.cwd, entry.startedAt && `started ${new Date(entry.startedAt).toLocaleString()}`].filter(Boolean).join('\n');
  const action = node.querySelector('.history-resume');
  action.textContent = running ? 'Open' : 'Resume';
  action.title = running
    ? `This session is running in Agent Guild as "${running.name}". Open it instead of resuming it twice.`
    : `Resume this ${provider.tool} session${entry.cwd ? ` in ${entry.cwd}` : ''}`;
  action.setAttribute('aria-label', `${action.textContent} ${entry.title ?? entry.id}`);
}

/** Rows are kept and updated in place, so a refresh never drops keyboard focus from a row's buttons. */
function renderHistoryRows(provider, shown) {
  const list = $('history-list');
  const rows = new Map([...list.children].map((node) => [node.dataset.id, node]));
  const wanted = new Set(shown.map((entry) => entry.id));
  for (const [id, node] of rows) if (!wanted.has(id)) node.remove();
  shown.forEach((entry, index) => {
    let node = rows.get(entry.id);
    if (!node) node = buildHistoryRow(entry.id);
    updateHistoryRow(node, provider, entry);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
}

function renderHistory() {
  const provider = historyProvider();
  if (!provider) return closeHistory();
  const account = provider.accounts?.find((a) => a.id === historyView.accountId);
  paintProviderIcon($('history-icon'), provider);
  $('history-title').textContent = `${provider.tool} sessions`;
  const snapshot = historyView.snapshot;
  const filter = $('history-filter').value.trim().toLowerCase();
  const working = $('cwd').value.trim();
  const here = $('history-here');
  here.disabled = !working;
  here.parentElement.title = working ? `Only sessions started in ${working}` : 'Set a working folder above to filter by it';
  const all = snapshot?.sessions ?? [];
  const shown = all.filter((entry) => (!filter || historyText(entry).includes(filter)) && (!here.checked || here.disabled || sameFolder(entry.cwd, working)));
  const parts = [];
  if ((provider.accounts?.length ?? 0) > 1 && account) parts.push(`${account.label} account`);
  if (snapshot && !snapshot.error) {
    parts.push(snapshot.total === 0 ? 'no sessions found' : `${snapshot.total} session${snapshot.total === 1 ? '' : 's'}, newest first`);
    if (shown.length !== all.length) parts.push(`${shown.length} shown`);
  }
  $('history-sub').textContent = parts.join(' · ');
  renderHistoryRows(provider, shown);
  let note = '';
  if (!provider.historySource) note = `Agent Guild cannot list ${provider.tool}'s sessions. Enter the id of one to resume it.`;
  else if (historyView.loading && !snapshot) note = `Reading ${provider.tool}'s sessions…`;
  else if (snapshot?.error) note = `Sessions could not be read: ${snapshot.error}`;
  else if (snapshot && all.length === 0) note = `No ${provider.tool} sessions were found${account && account.id !== 'default' ? ` for the ${account.label} account` : ''}.`;
  else if (snapshot && shown.length === 0) note = 'No session matches the filter.';
  $('history-note').textContent = note;
  $('history-note').hidden = !note;
  $('history-filter').disabled = !provider.historySource;
  here.parentElement.hidden = !provider.historySource;
}

/** Closing to open a session leaves focus with the terminal; otherwise it returns to the opener. */
function closeHistory({ focusOpener = true } = {}) {
  if (!$('history').open) return;
  if (!focusOpener) historyOpener = false;
  $('history').close();
}

function resumeById(event) {
  event.preventDefault();
  const provider = historyProvider();
  const id = $('history-id').value.trim();
  if (provider && id) resumeFromHistory(provider, id, null);
}

// ---- GitHub ---------------------------------------------------------------

const GITHUB_SCOPES = {
  repo: 'Read and write access to all your repositories, private ones included. GitHub offers apps no read-only choice; Agent Guild only lists them.',
  'write:public_key': 'Add the SSH key Agent Guild creates for this account.',
};
const githubView = { accountId: null, repos: null, reposFor: null, loading: null, error: null, parentError: null, opener: null, card: null, started: new Set(), announced: new Set() };
let githubLoading = null;

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function button(label, onClick, className = 'btn') {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function externalLink(label, href, className = 'console-link') {
  const link = el('a', className, label);
  link.href = webHref(href) ?? '';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.setAttribute('aria-description', 'Opens in a new tab');
  return link;
}

function githubAccount() {
  return state.github?.accounts.find((a) => a.id === githubView.accountId) ?? null;
}

function selectGitHubAccount(id) {
  if (githubView.accountId === id) return;
  githubView.accountId = id;
  githubView.repos = null;
  githubView.reposFor = null;
  githubView.error = null;
  save(GITHUB_ACCOUNT_KEY, id === null ? null : String(id));
}

let githubAgain = false;

function loadGitHub() {
  if (githubLoading) {
    githubAgain = true;
    return githubLoading;
  }
  githubLoading = api('GET', '/github').then(({ github }) => setGitHub(github), (err) => {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }).finally(() => {
    githubLoading = null;
    if (githubAgain) {
      githubAgain = false;
      loadGitHub();
    }
  });
  return githubLoading;
}

function setGitHub(github) {
  const before = state.github?.signIn;
  state.github = github;
  const done = github.signIn?.status === 'done' && before?.status === 'pending' ? github.signIn : null;
  if (done) {
    selectGitHubAccount(done.accountId);
    Object.assign(githubView, { repos: null, reposFor: null, error: null });
  }
  if (!githubAccount()) selectGitHubAccount(github.accounts[0]?.id ?? null);
  const account = githubAccount();
  if (done && account) {
    toast(done.again
      ? `You are already signed in as @${account.login}; that sign-in was renewed. To add another account, switch to it on github.com first.`
      : `Signed in to GitHub as @${account.login}.`, done.again ? 10000 : 4000);
  }
  if (!$('github').open) return;
  renderGitHub();
  ensureRepos();
}

function cloneParent() {
  return $('github-parent').value.trim();
}

function reposKey(account) {
  return account ? `${account.id}\n${cloneParent()}` : null;
}

function ensureRepos() {
  const account = githubAccount();
  if (!account || account.needsSignIn) return;
  const key = reposKey(account);
  if (githubView.reposFor !== key && githubView.loading !== key) loadRepos();
}

async function loadRepos({ refresh = false } = {}) {
  const account = githubAccount();
  if (!account) return;
  const key = reposKey(account);
  const parent = cloneParent();
  githubView.loading = key;
  renderGitHub();
  const ask = (withParent) => {
    const query = new URLSearchParams();
    if (withParent && parent) query.set('parent', parent);
    if (refresh) query.set('refresh', '1');
    return api('GET', `/github/accounts/${account.id}/repos?${query}`);
  };
  let result = null;
  let error = null;
  let parentError = null;
  try {
    try {
      result = (await ask(true)).repos;
    } catch (err) {
      if (err.code !== 'bad_cwd') throw err;
      parentError = err.message;
      result = (await ask(false)).repos;
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    error = err.message;
  }
  if (githubView.loading !== key) return;
  Object.assign(githubView, { loading: null, reposFor: key, error, parentError });
  if (result || !githubView.repos || githubView.repos.accountId !== account.id) githubView.repos = result;
  renderGitHub();
}

async function startGitHubSignIn() {
  try {
    setGitHub((await api('POST', '/github/sign-in')).github);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }
}

async function cancelGitHubSignIn() {
  try {
    setGitHub((await api('DELETE', '/github/sign-in')).github);
  } catch (err) {
    toast(err.message);
  }
}

async function setupGitHubSsh(account) {
  try {
    const result = await api('POST', `/github/accounts/${account.id}/ssh`);
    if (result.account.ssh.status === 'ready') toast(`SSH is ready for @${account.login}.`, 4000);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
  }
  loadGitHub();
}

async function signOutGitHub(account) {
  const text = `Sign out of @${account.login}? Agent Guild forgets this sign-in. Its SSH key stays in the Agent Guild data folder and on your GitHub account, so existing clones keep working.\n\nTo remove Agent Guild's access entirely, revoke it on GitHub; GitHub then also removes the SSH keys Agent Guild added.`;
  if (!confirm(text)) return;
  try {
    const { github } = await api('DELETE', `/github/accounts/${account.id}`);
    if (githubView.accountId === account.id) selectGitHubAccount(null);
    setGitHub(github);
  } catch (err) {
    toast(err.message);
  }
}

function openGitHub() {
  const dialog = $('github');
  $('github-parent').value = load(CLONE_PARENT_KEY) ?? $('cwd').value.trim();
  $('github-filter').value = '';
  githubView.card = null;
  if (!dialog.open) {
    githubView.opener = document.activeElement;
    dialog.showModal();
  }
  renderGitHub();
  if (githubAccount() && !githubAccount().needsSignIn) loadRepos();
  loadGitHub();
  ($('github-card').querySelector('.btn.primary') ?? $('github-close')).focus();
}

function closeGitHub({ focusOpener = true } = {}) {
  if (!$('github').open) return;
  if (!focusOpener) githubView.opener = false;
  $('github').close();
}

function renderGitHub() {
  const github = state.github;
  const account = githubAccount();
  const repos = githubView.repos?.accountId === account?.id ? githubView.repos : null;
  const sub = !github ? 'Loading…'
    : !account ? 'Clone your repositories over SSH'
    : [`@${account.login}`, account.name, repos && `${repos.repos.length} ${repos.repos.length === 1 ? 'repository' : 'repositories'}`].filter(Boolean).join(' · ');
  $('github-sub').textContent = sub;
  renderGitHubChips(github);
  renderGitHubCard(github, account);
  renderGitHubStatus(github, account);
  renderGitHubRepos(github, account, repos);
}

function githubAvatar(account) {
  if (account.avatar?.startsWith('data:image/')) {
    const img = el('img', 'github-avatar');
    img.src = account.avatar;
    img.alt = '';
    return img;
  }
  const mono = el('span', 'github-avatar', account.login.charAt(0).toUpperCase());
  mono.style.setProperty('--c', `hsl(${hueFor(account.login)} 45% 45%)`);
  return mono;
}

function renderGitHubChips(github) {
  const accounts = github?.accounts ?? [];
  $('github-accounts').hidden = accounts.length === 0;
  const host = $('github-chips');
  const focused = document.activeElement?.closest?.('#github-chips .account-chip')?.dataset.account;
  host.replaceChildren(...accounts.map((account) => {
    const chip = el('button', `account-chip github-chip${account.needsSignIn ? ' unsigned' : ''}`, githubAvatar(account), el('span', null, account.login));
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.dataset.account = account.id;
    chip.setAttribute('aria-selected', String(account.id === githubView.accountId));
    chip.title = account.needsSignIn ? `@${account.login}: sign in again` : `${account.name ? `${account.name} · ` : ''}@${account.login}${account.ssh.status === 'ready' ? ' · SSH ready' : ' · SSH not set up'}`;
    chip.addEventListener('click', () => {
      selectGitHubAccount(account.id);
      githubView.card = null;
      renderGitHub();
      ensureRepos();
    });
    return chip;
  }));
  if (focused) [...host.children].find((chip) => chip.dataset.account === focused)?.focus({ preventScroll: true });
  const pending = github?.signIn?.status === 'pending';
  $('github-add').hidden = accounts.length === 0 || pending;
}

function minutesLeft(iso) {
  return Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
}

function scopeList(github) {
  return el('ul', 'github-scopes', ...(github.scopes ?? []).map((scope) => el('li', null, el('code', null, scope), ` ${GITHUB_SCOPES[scope] ?? ''}`)));
}

function signInCard(github) {
  return [
    el('h3', null, 'Sign in to GitHub'),
    el('p', null, 'See your repositories and clone them over SSH, with a key Agent Guild keeps for each account.'),
    el('p', 'github-small', 'GitHub will ask you to allow Agent Guild to:'),
    scopeList(github),
    el('p', 'github-small', 'Your sign-in stays in the Agent Guild data folder on this computer; this page never receives it.'),
    el('div', 'github-actions', button('Sign in with GitHub', startGitHubSignIn, 'btn primary')),
  ];
}

function codeCard(signIn) {
  const code = signIn.userCode;
  const open = externalLink('Open GitHub', signIn.verificationUri, 'btn primary');
  open.addEventListener('click', () => navigator.clipboard?.writeText(code).catch(() => {}));
  open.title = `Copies the code and opens ${signIn.verificationUri}`;
  const codeText = el('span', 'github-code-text', code);
  codeText.setAttribute('aria-label', `Code ${[...code].join(' ')}`);
  return [
    el('h3', null, 'Enter this code on GitHub'),
    el('div', 'github-code', codeText, button('Copy', () => copyText(code, 'the code'))),
    el('div', 'github-actions', open, button('Cancel', cancelGitHubSignIn)),
    el('p', 'github-small github-waiting', `Waiting for you to approve Agent Guild on GitHub. The code expires in ${minutesLeft(signIn.expiresAt)} min.`),
    el('p', 'github-small', 'Adding another account? Switch to it on github.com before you enter the code.'),
  ];
}

function signInResultCard(signIn) {
  const text = signIn.status === 'expired' ? 'The code expired before it was entered on GitHub.'
    : signIn.status === 'denied' ? 'The sign-in was declined on GitHub.'
    : `The sign-in did not finish: ${signIn.error || 'GitHub refused it'}.`;
  return [
    el('h3', null, 'Not signed in'),
    el('p', null, text),
    el('div', 'github-actions', button('Try again', startGitHubSignIn, 'btn primary'), button('Dismiss', cancelGitHubSignIn)),
  ];
}

function signInAgainCard(account) {
  return [
    el('h3', null, `Sign in again as @${account.login}`),
    el('p', null, `GitHub no longer accepts Agent Guild's sign-in for @${account.login}. If github.com is signed in to another account, switch to @${account.login} there first.`),
    el('div', 'github-actions', button('Sign in again', startGitHubSignIn, 'btn primary'), button('Sign out', () => signOutGitHub(account))),
  ];
}

function sshCard(github, account) {
  const ssh = account.ssh;
  const missing = !github.tools.ssh || !github.tools.sshKeygen;
  const step = (done, text) => el('li', done ? 'done' : null, text);
  const parts = [
    el('h3', null, `Set up SSH for @${account.login}`),
    el('p', null, 'Agent Guild clones over SSH with a key of its own for each account, so your other SSH keys and settings are never used or changed.'),
    el('ol', 'github-steps',
      step(Boolean(ssh.key), 'Create a key for this account in the Agent Guild data folder'),
      step(false, 'Add its public key to your GitHub account'),
      step(false, `Check that GitHub signs in as @${account.login}`)),
  ];
  if (missing) {
    parts.push(el('p', 'github-error', 'OpenSSH (ssh and ssh-keygen) was not found. On Windows, add the "OpenSSH Client" optional feature in Settings, or install Git for Windows; on Linux, install the openssh-client package. Then check again.'));
  } else if (ssh.error) {
    parts.push(el('p', 'github-error', ssh.error.message));
  }
  const setup = button(ssh.settingUp ? 'Setting up…' : ssh.error || ssh.key ? 'Check again' : 'Set up SSH', () => setupGitHubSsh(account), 'btn primary');
  setup.disabled = ssh.settingUp || missing;
  const actions = el('div', 'github-actions', setup);
  if (ssh.error?.manual && ssh.publicKey) {
    actions.append(button('Copy public key', () => copyText(ssh.publicKey, 'the public key')), externalLink('Open GitHub SSH settings', github.newKeyUrl, 'btn'));
  }
  parts.push(actions);
  const approve = externalLink('request access', github.appUrl);
  parts.push(el('p', 'github-small', 'Organizations that restrict third-party apps accept this key only once an owner approves Agent Guild: ', approve, '.'));
  return parts;
}

function renderGitHubCard(github, account) {
  const card = $('github-card');
  let kind = null;
  let build = null;
  const signIn = github?.signIn;
  if (!github) kind = null;
  else if (signIn?.status === 'pending') [kind, build] = [`code:${signIn.userCode}:${minutesLeft(signIn.expiresAt)}`, () => codeCard(signIn)];
  else if (signIn && signIn.status !== 'done') [kind, build] = [`result:${signIn.status}`, () => signInResultCard(signIn)];
  else if (!account) [kind, build] = ['welcome', () => signInCard(github)];
  else if (account.needsSignIn) [kind, build] = [`again:${account.id}`, () => signInAgainCard(account)];
  else if (account.ssh.status !== 'ready') {
    const { settingUp, key, error } = account.ssh;
    [kind, build] = [`ssh:${account.id}:${settingUp}:${Boolean(key)}:${error?.message}:${github.tools.ssh && github.tools.sshKeygen}`, () => sshCard(github, account)];
  }
  card.hidden = !kind;
  if (kind === githubView.card) return;
  const hadFocus = card.contains(document.activeElement);
  githubView.card = kind;
  card.replaceChildren(...(build ? build() : []));
  if (hadFocus) (card.querySelector('.btn.primary:not(:disabled)') ?? card.querySelector('button, a'))?.focus({ preventScroll: true });
}

function renderGitHubStatus(github, account) {
  const strip = $('github-status');
  strip.hidden = !account || account.needsSignIn;
  if (strip.hidden) return strip.replaceChildren();
  const ssh = account.ssh;
  const text = ssh.status === 'ready'
    ? el('span', 'github-ready', 'SSH ready', el('span', 'github-small', ` · checked ${relativeTime(ssh.verifiedAt)}`))
    : el('span', 'github-small', 'SSH not set up yet');
  const actions = el('span', 'github-status-actions');
  if (ssh.status === 'ready') {
    const check = button(ssh.settingUp ? 'Checking…' : 'Check SSH', () => setupGitHubSsh(account));
    check.disabled = ssh.settingUp;
    check.title = `Check that GitHub still signs in as @${account.login} with Agent Guild's key`;
    actions.append(check);
  }
  actions.append(button('Sign out', () => signOutGitHub(account)));
  const focused = strip.contains(document.activeElement) ? document.activeElement.textContent : null;
  strip.replaceChildren(text, actions);
  if (focused) [...strip.querySelectorAll('button')].find((b) => b.textContent === focused)?.focus({ preventScroll: true });
}

function runningClone(target) {
  return [...state.sessions.values()].find((s) => s.task === 'clone' && s.status === 'running' && s.clone?.path === target) ?? null;
}

function cloneBlocker(github, account) {
  if (!github.tools.git) return 'Git was not found. Install it from git-scm.com, then reopen this dialog.';
  if (account.ssh.status !== 'ready') return `Set up SSH for @${account.login} first.`;
  if (githubView.parentError) return githubView.parentError;
  if (!cloneParent()) return 'Choose the folder to clone into below.';
  return null;
}

function buildRepoRow(fullName) {
  const node = $('github-repo-template').content.firstElementChild.cloneNode(true);
  node.dataset.repo = fullName;
  node.querySelector('.github-action').addEventListener('click', (event) => {
    const repo = githubView.repos?.repos.find((r) => r.fullName === fullName);
    if (repo) repoAction(repo, event.currentTarget);
  });
  return node;
}

function repoAction(repo, control) {
  const running = runningClone(repo.target);
  if (running) {
    closeGitHub({ focusOpener: false });
    openPanel(running.id);
  } else if (repo.local === 'cloned') {
    useFolder(repo.target);
  } else {
    cloneRepo(repo, control);
  }
}

function updateRepoRow(node, repo, blocker) {
  const name = node.querySelector('.repo-name');
  name.replaceChildren(el('span', 'repo-owner', `${repo.owner}/`), repo.name);
  name.title = repo.url;
  const title = node.querySelector('.history-title');
  title.replaceChildren(name,
    ...(repo.private ? [badge('', 'Private', 'Only people with access can see it')] : []),
    ...(repo.fork ? [badge('', 'Fork', 'A fork of another repository')] : []),
    ...(repo.archived ? [badge('', 'Archived', 'Read-only on GitHub')] : []));
  const running = runningClone(repo.target);
  const conflict = repo.local === 'conflict';
  const meta = node.querySelector('.history-meta');
  meta.textContent = conflict
    ? `${repo.target} already exists and is not a clone of ${repo.fullName}`
    : [running && 'Cloning…', repo.local === 'cloned' && `Cloned in ${repo.target}`, repo.description, repo.language, repo.pushedAt && `pushed ${relativeTime(repo.pushedAt)}`].filter(Boolean).join(' · ');
  meta.title = [repo.description, repo.target].filter(Boolean).join('\n');
  node.classList.toggle('conflict', conflict);
  node.classList.toggle('running', Boolean(running) || repo.local === 'cloned');
  const action = node.querySelector('.github-action');
  action.hidden = conflict && !running;
  action.className = `btn github-action${running ? '' : ' primary'}`;
  action.textContent = running ? 'Show' : repo.local === 'cloned' ? 'Use folder' : 'Clone';
  action.disabled = !running && repo.local !== 'cloned' && Boolean(blocker);
  action.title = running ? `Show the session cloning ${repo.fullName}`
    : repo.local === 'cloned' ? `Make ${repo.target} the working folder, so new sessions start there`
    : blocker || `Clone ${repo.fullName} into ${repo.target} over SSH`;
  action.setAttribute('aria-label', `${action.textContent} ${repo.fullName}`);
}

function renderGitHubRepos(github, account, repos) {
  const ready = Boolean(github && account && !account.needsSignIn);
  $('github-tools').hidden = !ready;
  $('github-parent').closest('.github-form').hidden = !ready;
  const list = $('github-list');
  const filter = $('github-filter').value.trim().toLowerCase();
  const shown = ready && repos ? repos.repos.filter((repo) => !filter || `${repo.fullName}\n${repo.description ?? ''}`.toLowerCase().includes(filter)) : [];
  const blocker = ready ? cloneBlocker(github, account) : null;
  const rows = new Map([...list.children].map((node) => [node.dataset.repo, node]));
  const wanted = new Set(shown.map((repo) => repo.fullName));
  for (const [id, node] of rows) if (!wanted.has(id)) node.remove();
  shown.forEach((repo, index) => {
    const node = rows.get(repo.fullName) ?? buildRepoRow(repo.fullName);
    updateRepoRow(node, repo, blocker);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
  });
  const note = $('github-note');
  const lines = [];
  if (ready) {
    if (githubView.loading && !repos) lines.push('Loading repositories…');
    else if (githubView.error) lines.push(`Repositories could not be loaded: ${githubView.error}`);
    else if (repos && repos.repos.length === 0) lines.push(`@${account.login} has no repositories yet.`);
    else if (repos && shown.length === 0) lines.push('No repository matches the filter.');
    if (githubView.parentError) lines.push(githubView.parentError);
    if (repos?.truncated) lines.push(`Showing the ${repos.repos.length} most recently pushed repositories.`);
    if (repos) lines.push(['Missing an organization\'s repositories? Its owners may need to approve Agent Guild: ', externalLink('request access', github.appUrl), '.']);
  }
  note.replaceChildren(...lines.map((line) => el('span', null, ...[line].flat())));
  note.hidden = lines.length === 0;
  $('github-refresh').disabled = Boolean(githubView.loading);
  if (!ready) showCreate(false);
  renderCreate();
}

async function startClone(account, fullName) {
  const { session } = await api('POST', '/github/clone', { account: account.id, repo: fullName, parent: cloneParent() });
  githubView.started.add(session.id);
  upsertSession(session);
  closeGitHub({ focusOpener: false });
  openPanel(session.id);
}

async function cloneRepo(repo, control) {
  const account = githubAccount();
  if (!account) return;
  control.disabled = true;
  try {
    await startClone(account, repo.fullName);
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    toast(err.message, 8000);
    if (err.code === 'clone_exists' || err.code === 'folder_conflict') loadRepos();
  } finally {
    control.disabled = false;
  }
}

function showCreate(open) {
  const form = $('github-create');
  form.hidden = !open;
  $('github-new').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('github-create-name').value = '';
  $('github-create-description').value = '';
  $('github-create-error').hidden = true;
  renderCreate();
  $('github-create-name').focus();
}

function renderCreate() {
  const form = $('github-create');
  const account = githubAccount();
  if (form.hidden || !account) return;
  const repos = githubView.repos?.accountId === account.id ? githubView.repos : null;
  const owners = repos?.owners ?? [account.login];
  const select = $('github-create-owner');
  const chosen = select.value;
  if ([...select.options].map((o) => o.value).join('\n') !== owners.join('\n')) {
    select.replaceChildren(...owners.map((owner) => {
      const option = el('option', null, owner === account.login ? `${owner} (you)` : owner);
      option.value = owner;
      return option;
    }));
    select.value = owners.includes(chosen) ? chosen : owners[0];
  }
  const blocker = cloneBlocker(state.github, account);
  const clone = $('github-create-clone');
  clone.disabled = Boolean(blocker);
  if (blocker) clone.checked = false;
  const name = $('github-create-name').value.trim();
  $('github-create-clone-label').textContent = blocker ? 'Clone it' : `Clone it into ${cloneParent()}${name ? `/${name}` : ''}`;
  clone.parentElement.title = blocker ?? '';
}

async function createRepo(event) {
  event.preventDefault();
  const account = githubAccount();
  if (!account) return;
  const submit = $('github-create-submit');
  const error = $('github-create-error');
  const owner = $('github-create-owner').value;
  const name = $('github-create-name').value.trim();
  const clone = $('github-create-clone').checked && !$('github-create-clone').disabled;
  submit.disabled = true;
  error.hidden = true;
  try {
    const { repo } = await api('POST', `/github/accounts/${account.id}/repos`, {
      owner,
      name,
      description: $('github-create-description').value.trim() || null,
      private: $('github-create-private').checked,
      readme: $('github-create-readme').checked,
    });
    showCreate(false);
    githubView.reposFor = null;
    if (clone) {
      toast(`Created ${repo.fullName} on GitHub.`, 4000);
      await startClone(account, repo.fullName);
    } else {
      toast(`Created ${repo.fullName} on GitHub.`, 6000);
      await loadRepos();
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if ($('github-create').hidden) {
      toast(err.message, 8000);
      loadRepos();
    } else {
      error.textContent = err.message;
      error.hidden = false;
    }
  } finally {
    submit.disabled = false;
  }
}

function clonedPath(s) {
  return s.task === 'clone' && s.status === 'exited' && s.exitCode === 0 && s.clone?.path ? s.clone.path : null;
}

function noticeClone(s) {
  if (s.task !== 'clone' || s.status !== 'exited' || githubView.announced.has(s.id)) return;
  githubView.announced.add(s.id);
  githubView.reposFor = null;
  if ($('github').open) loadRepos();
  if (!githubView.started.has(s.id)) return;
  if (clonedPath(s)) toast(`Cloned ${s.clone.repo} into ${s.clone.path}.`, 12000, { label: 'Use folder', run: () => useFolder(s.clone.path) });
  else toast(`Cloning ${s.clone?.repo ?? 'the repository'} did not finish. Its session shows why.`, 8000);
}

function useFolder(dir) {
  $('cwd').value = dir;
  save(CWD_KEY, dir);
  if ($('github').open) renderGitHub();
  toast(`New sessions start in ${dir}.`, 4000);
}

// ---- session cards --------------------------------------------------------

const cards = new Map();
let sessionsShown = false;

const MODEL_SOURCES = { report: 'reported by the tool', screen: 'seen on the tool\'s screen', args: 'from the --model argument' };

function modelText(s) {
  return s.model ? s.model.displayName || s.model.name : '';
}

function modelTitle(s) {
  if (!s.model) return '';
  const id = s.model.displayName && s.model.displayName !== s.model.name ? ` (${s.model.name})` : '';
  return `Model ${modelText(s)}${id}, ${MODEL_SOURCES[s.model.source] || s.model.source}`;
}

function accountLabel(s) {
  if (!s.account) return '';
  const provider = state.providers.find((p) => p.id === s.provider.id);
  return (provider?.accounts?.length ?? 0) > 1 || s.account.id !== 'default' ? s.account.label : '';
}

function statusText(s) {
  if (s.status === 'exited') {
    if (s.signal) return `Exited (${s.signal})`;
    return s.exitCode === 0 || s.exitCode === null ? 'Exited' : `Exited (${s.exitCode})`;
  }
  return s.activity === 'active' ? 'Working' : 'Running';
}

function buildCard(session) {
  const node = $('session-template').content.firstElementChild.cloneNode(true);
  node.dataset.id = session.id;
  const open = () => openPanel(session.id);
  node.addEventListener('click', (e) => { if (!e.target.closest('button')) open(); });
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === node) open(); });
  node.querySelector('.open').addEventListener('click', open);
  node.querySelector('.stop').addEventListener('click', () => stopSession(session.id));
  node.querySelector('.remove').addEventListener('click', () => removeSession(session.id));
  node.querySelector('.rename').addEventListener('click', () => renameSession(session.id));
  node.querySelector('.resume').addEventListener('click', () => resumeCard(session.id));
  node.querySelector('.use-folder').addEventListener('click', () => {
    const path = state.sessions.get(session.id)?.clone?.path;
    if (path) useFolder(path);
  });
  node.querySelector('.session-id').addEventListener('click', () => {
    const id = toolSessionId(state.sessions.get(session.id) ?? session);
    if (id) copyId(id);
  });
  node.querySelector('.model-pill').addEventListener('click', () => openSessionModel(session.id));
  // Skins name their own keyframes, so the one-shot classes clear on any animation they run.
  node.addEventListener('animationend', (e) => {
    if (e.target.classList.contains('level-up')) e.target.classList.remove('level-up');
    else if (e.target.classList.contains('summon')) e.target.classList.remove('summon');
    else if (e.target === node) node.classList.remove('enter');
  });
  return node;
}

function resumable(s) {
  const provider = state.providers.find((p) => p.id === s.provider.id);
  const id = toolSessionId(s);
  return Boolean(s.status === 'exited' && s.task === null && id && provider?.available && provider.resumable
    && !runningOn(s.provider.id, s.account?.id ?? 'default', id));
}

function resumeCard(id) {
  const s = state.sessions.get(id);
  if (!s || !resumable(s)) return;
  const provider = state.providers.find((p) => p.id === s.provider.id);
  const account = provider.accounts?.find((a) => a.id === s.account?.id)?.id;
  startSession(provider, cards.get(id), { resume: toolSessionId(s), cwd: s.cwd, account });
}

function sessionLevel(s) {
  const end = s.status === 'exited'
    ? Date.parse(s.exitedAt ?? s.lastOutputAt ?? s.createdAt)
    : Date.now();
  const hours = (end - Date.parse(s.createdAt)) / 3_600_000;
  return Number.isFinite(hours) ? Math.max(0, Math.floor(hours)) + 1 : 1;
}

function updateCard(node, s) {
  node.dataset.provider = s.provider.id;
  paintProviderIcon(node.querySelector('.provider-icon'), s.provider);
  const level = sessionLevel(s);
  const badge = node.querySelector('.level-badge');
  if (badge.textContent && Number(badge.textContent) < level) badge.classList.add('level-up');
  badge.textContent = level;
  badge.title = `Level ${level}`;
  node.querySelector('.name').textContent = s.name;
  const id = toolSessionId(s);
  const resumed = s.resume && s.resume !== id ? ` · resumed ${s.resume}` : s.resume ? ' · resumed' : '';
  node.querySelector('.meta-text').textContent = [s.provider.vendor, s.provider.tool, accountLabel(s), `started ${relativeTime(s.createdAt)}${resumed}`].filter(Boolean).join(' · ');
  paintIdButton(node.querySelector('.session-id'), id);
  const pill = node.querySelector('.status-pill');
  pill.textContent = statusText(s);
  pill.className = `status-pill ${s.status === 'exited' ? 'exited' : s.activity}`;
  const model = node.querySelector('.model-pill');
  model.hidden = !s.model;
  model.textContent = modelText(s);
  model.title = [modelTitle(s), modelStatsLine(s)].filter(Boolean).join('\n');
  model.setAttribute('aria-label', `Benchmarks for ${modelText(s)}`);
  model.className = `model-pill ${s.model?.source || ''}`;
  const cwd = node.querySelector('.cwd-line');
  // The LRM keeps a leading "/" in place under the right-to-left truncation style.
  cwd.textContent = `\u200E${s.cwd}`;
  cwd.title = s.cwd;
  renderAgents(node.querySelector('.agents'), s.agents, s.shells || []);
  paintReporting(node.querySelector('.agents-row'), s);
  node.classList.toggle('exited', s.status === 'exited');
  node.querySelector('.stop').hidden = s.status !== 'running';
  node.querySelector('.remove').hidden = s.status === 'running';
  const useButton = node.querySelector('.use-folder');
  useButton.hidden = !clonedPath(s);
  useButton.title = clonedPath(s) ? `Make ${s.clone.path} the working folder, so new sessions start there` : '';
  const resume = node.querySelector('.resume');
  resume.hidden = !resumable(s);
  resume.title = `Start ${s.provider.tool} again on this session${id ? ` (${id})` : ''} in ${s.cwd}`;
  const modelLabel = s.model ? `, model ${modelText(s)}` : '';
  const accountName = accountLabel(s) ? `, ${accountLabel(s)} account` : '';
  const shellCount = (s.shells || []).length;
  const reportingNote = s.status === 'running' && REPORTING_TEXT[s.reporting?.state] ? `, agent reporting: ${REPORTING_TEXT[s.reporting.state]}` : '';
  node.setAttribute('aria-label', `${s.name}, ${s.provider.vendor}${accountName}${modelLabel}, ${statusText(s)}, ${s.agents.length} agents${shellCount ? `, ${shellCount} shell command${shellCount === 1 ? '' : 's'} running` : ''}${reportingNote}`);
}

function renderSessions() {
  const grid = $('sessions');
  const sessions = [...state.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const [id, node] of cards) {
    if (!state.sessions.has(id)) { node.remove(); cards.delete(id); }
  }
  sessions.forEach((s, index) => {
    let node = cards.get(s.id);
    if (!node) {
      node = buildCard(s);
      cards.set(s.id, node);
      if (sessionsShown) node.classList.add('enter');
    }
    updateCard(node, s);
    // Move a card only when it is out of place: re-inserting a node drops
    // keyboard focus and can swallow a click that is in progress.
    if (grid.children[index] !== node) grid.insertBefore(node, grid.children[index] || null);
  });
  const running = sessions.filter((s) => s.status === 'running').length;
  $('session-count').textContent = sessions.length ? `· ${running} running` : '';
  $('empty').hidden = sessions.length > 0;
  guardLeaving();
  if (state.activeId) updatePanel();
  if ($('history').open) renderHistory();
  if (state.stats && sessions.some((s) => s.model && state.statsFor.get(s.id) !== modelKey(s))) scheduleStats();
  syncViews();
}

function confirmLeaving(event) {
  event.preventDefault();
  event.returnValue = true;
}

function guardLeaving() {
  const running = state.connected && [...state.sessions.values()].some((s) => s.status === 'running');
  if (running) addEventListener('beforeunload', confirmLeaving);
  else removeEventListener('beforeunload', confirmLeaving);
}

function upsertSession(session) {
  state.sessions.set(session.id, session);
  renderSessions();
  noticeClone(session);
}

function dropSession(id) {
  state.sessions.delete(id);
  const view = state.views.get(id);
  if (view) { view.dispose(); state.views.delete(id); }
  if (state.activeId === id) closePanel();
  renderSessions();
}

async function stopSession(id) {
  const s = state.sessions.get(id);
  if (!s || s.status !== 'running') return;
  if (!confirm(`Stop "${s.name}"? The ${s.provider.tool} process will be ended.`)) return;
  try { upsertSession((await api('POST', `/sessions/${id}/stop`)).session); } catch (err) { toast(err.message); }
}

async function removeSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  if (s.status === 'running' && !confirm(`"${s.name}" is still running. End it and remove it?`)) return;
  try { await api('DELETE', `/sessions/${id}`); dropSession(id); } catch (err) { toast(err.message); }
}

async function renameSession(id) {
  const s = state.sessions.get(id);
  if (!s) return;
  const name = prompt('Session name', s.name);
  if (name === null || !name.trim()) return;
  try { upsertSession((await api('PATCH', `/sessions/${id}`, { name })).session); } catch (err) { toast(err.message); }
}

// ---- terminal views -------------------------------------------------------

const TERMINAL_THEME = {
  background: '#0f1115',
  foreground: '#e6e9ef',
  cursor: '#e6e9ef',
  selectionBackground: '#3a4050',
};

/**
 * The session manager answers terminal queries (cursor position, device
 * attributes, mode and colour reports) once for every session. If each
 * attached page answered too, replies would be duplicated into the
 * program's input. Swallow the queries here before xterm.js replies.
 */
function suppressQueryReplies(term) {
  const swallow = () => true;
  const csi = [
    { final: 'n' }, // DSR, including cursor position
    { prefix: '?', final: 'n' },
    { final: 'c' }, // primary device attributes
    { prefix: '>', final: 'c' }, // secondary device attributes
    { prefix: '=', final: 'c' }, // tertiary device attributes
    { intermediates: '$', final: 'p' }, // DECRQM (ANSI modes)
    { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM (private modes)
    { prefix: '>', final: 'q' }, // XTVERSION
  ];
  for (const id of csi) term.parser.registerCsiHandler(id, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow); // DECRQSS
  for (const code of [4, 10, 11, 12]) {
    term.parser.registerOscHandler(code, (data) => data.includes('?'));
  }
}

class TerminalView {
  constructor(sessionId) {
    this.id = sessionId;
    this.el = document.createElement('div');
    this.term = new window.Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: TERMINAL_THEME,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
    suppressQueryReplies(this.term);
    this.term.onData((data) => this.send({ type: 'input', data }));
    this.opened = false;
    this.disposed = false;
    this.retry = 0;
    this.sent = { cols: 0, rows: 0 };
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.connect();
  }

  handleKey(e) {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    // Copy: Ctrl+Shift+C, or Ctrl+C when text is selected (Windows Terminal style).
    if (!isMac && e.ctrlKey && key === 'c' && (e.shiftKey || this.term.hasSelection())) {
      const text = this.term.getSelection();
      if (text) navigator.clipboard?.writeText(text).catch(() => {});
      this.term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Paste: let the browser deliver a native paste event for Ctrl+V / Ctrl+Shift+V.
    if (!isMac && e.ctrlKey && key === 'v') return false;
    return true;
  }

  connect() {
    if (this.disposed) return;
    const ws = new WebSocket(wsUrl(`/sessions/${this.id}/terminal`));
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.sent = { cols: 0, rows: 0 }; this.sendSize(); };
    ws.onmessage = (event) => this.onMessage(JSON.parse(event.data));
    ws.onclose = (event) => {
      if (this.disposed || event.code === 4404 || event.code === 4410) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        this.term.reset();
        this.term.resize(msg.cols, msg.rows);
        this.term.write(msg.data, () => { this.sent = { cols: 0, rows: 0 }; this.refit(); });
        break;
      case 'data':
        this.term.write(msg.data);
        break;
      case 'exit': {
        const how = msg.signal ? `signal ${msg.signal}` : `code ${msg.exitCode ?? 0}`;
        this.term.write(`\r\n\x1b[2m[process exited with ${how}]\x1b[0m\r\n`);
        break;
      }
      default:
        break;
    }
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  sendSize() {
    const { cols, rows } = this.term;
    if (!this.el.isConnected || (cols === this.sent.cols && rows === this.sent.rows)) return;
    this.sent = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  mount(host) {
    host.replaceChildren(this.el);
    if (!this.opened) { this.term.open(this.el); this.opened = true; }
    this.resizeObserver.observe(host);
    this.refit();
    this.term.focus();
  }

  unmount() {
    this.resizeObserver.disconnect();
    this.el.remove();
  }

  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => this.refit());
  }

  refit() {
    if (!this.el.isConnected) return;
    try { this.fit.fit(); } catch { /* not measurable yet */ }
    this.sendSize();
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.ws?.close();
    this.term.dispose();
    this.el.remove();
  }
}

// ---- terminal panel -------------------------------------------------------

function openPanel(id) {
  if (!state.sessions.has(id)) return;
  if (state.activeId && state.activeId !== id) state.views.get(state.activeId)?.unmount();
  state.activeId = id;
  let view = state.views.get(id);
  if (!view) { view = new TerminalView(id); state.views.set(id, view); }
  $('terminal-panel').hidden = false;
  updatePanel();
  view.mount($('terminal-host'));
}

function closePanel() {
  if (state.activeId) state.views.get(state.activeId)?.unmount();
  state.activeId = null;
  $('terminal-panel').hidden = true;
}

function updatePanel() {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  paintProviderIcon($('panel-icon'), s.provider);
  $('panel-title').textContent = s.name;
  const id = toolSessionId(s);
  $('panel-sub').textContent = [s.provider.tool, accountLabel(s), modelText(s), statusText(s), s.cwd, id && `session ${id}`].filter(Boolean).join(' · ');
  $('panel-sub').title = modelTitle(s);
  renderAgents($('panel-agents'), s.agents, s.shells || []);
  const stop = $('panel-stop');
  stop.textContent = s.status === 'running' ? 'Stop' : 'Remove';
}

// ---- stopping the manager -------------------------------------------------

/**
 * Stop the session manager, or stop it and start it again. The manager
 * refuses while sessions are running unless told to force, so the warning is
 * enforced for every client and the count in the dialog is the manager's,
 * not this page's possibly stale list.
 */
async function stopManager({ force = false, restart = false } = {}) {
  const buttons = [$('stop-manager'), $('restart-manager')];
  for (const button of buttons) button.disabled = true;
  try {
    const body = force || restart ? { ...(force && { force: true }), ...(restart && { restart: true }) } : undefined;
    const answer = await api('POST', '/shutdown', body);
    // A manager that does not say it will restart only stops.
    enterStopping(answer.running, restart && answer.restart === true);
    if (restart && answer.restart !== true) {
      toast('This manager cannot restart itself. Run "agent-guild restart" in a terminal to start the new one.', 12000);
    }
  } catch (err) {
    if (err instanceof AuthError) return showAuth(err.message);
    if (err.code === 'sessions_running') {
      const n = err.running;
      const what = `${n} session${n === 1 ? ' is' : 's are'} still running`;
      const them = n === 1 ? 'it' : 'all of them';
      const verb = restart ? 'Restarting' : 'Stopping';
      if (confirm(`${what}. ${verb} the session manager ends ${them}. ${restart ? 'Restart' : 'Stop'} anyway?`)) {
        return stopManager({ force: true, restart });
      }
      return;
    }
    toast(err.message, 8000);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

/** How long to wait for a restarted manager before telling the user how to start one by hand. */
const RESTART_WAIT_MS = 30000;
let restartTimer;

/** The manager is going down, by this page's request or another client's. */
function enterStopping(running = 0, restart = false) {
  if (restart) state.restarting = true;
  if (state.stopping) return;
  state.stopping = true;
  state.stopRemaining = null;
  closePanel();
  closeModels();
  closeNews();
  closeChangelog();
  closeHistory();
  closeGitHub();
  for (const view of state.views.values()) view.dispose();
  state.views.clear();
  state.sessions.clear();
  renderSessions();
  $('app').hidden = true;
  const n = Number(running) || 0;
  const ending = n ? `Ending ${n} running session${n === 1 ? '' : 's'}. ` : '';
  if (state.restarting) {
    showStopped('restarting', 'Restarting the session manager…', `${ending}A new manager starts in a moment and this page reconnects to it by itself.`);
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restartGaveUp, RESTART_WAIT_MS);
  } else {
    showStopped('stopping', 'Stopping the session manager…', `${ending}This can take a few seconds.`);
  }
  setConnection('down', state.restarting ? 'Restarting the session manager…' : 'Stopping the session manager…');
}

/** The manager is back: a `hello` arrived while the page was waiting out a stop. */
function leaveStopping() {
  state.stopping = false;
  state.restarting = false;
  clearTimeout(restartTimer);
  $('stopped').hidden = true;
  $('app').hidden = false;
}

/** A restarted manager did not come back in time; the user has to start one by hand. */
function restartGaveUp() {
  if (!state.stopping || !state.restarting) return;
  state.restarting = false;
  setConnection('down', 'Session manager stopped');
  showStopped('stopped', 'The session manager did not come back',
    `Nothing answered within ${Math.round(RESTART_WAIT_MS / 1000)} seconds of the restart. Check manager.log in the Agent Guild data folder, then start it yourself.`);
}

function showStopped(phase, title, text) {
  const el = $('stopped');
  el.classList.toggle('stopping', phase === 'stopping');
  el.classList.toggle('restarting', phase === 'restarting');
  $('stopped-title').textContent = title;
  $('stopped-text').textContent = text;
  // How to start again is only useful once the manager is really gone; a
  // restart brings it back without the user doing anything.
  $('stopped-help').hidden = phase !== 'stopped';
  if (phase === 'stopped') renderStoppedHelp();
  el.hidden = false;
}

/** Instructions for starting the manager again, worded for this computer. */
function renderStoppedHelp() {
  const windows = /Win/.test(navigator.platform || navigator.userAgent);
  $('stopped-how').textContent = isMac
    ? 'To start again, open Terminal (search for it with Spotlight) and run:'
    : windows
      ? 'To start again, open Windows Terminal or PowerShell (search for it in the Start menu) and run:'
      : 'To start again, open a terminal and run:';
  const launcher = state.launcher;
  $('stopped-launcher').hidden = !launcher;
  $('stopped-launcher-path').textContent = launcher || '';
}

async function copyCommand() {
  const button = $('copy-command');
  try {
    await navigator.clipboard.writeText('agent-guild open');
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  } catch {
    toast('Could not copy. Select the command and copy it yourself.');
  }
}

/**
 * The manager has stopped. Only a manager.stopped event with nothing
 * remaining confirms that every process exited; a timeout, or a socket that
 * dropped without the event, must not be announced as a clean stop.
 */
function showManagerStopped() {
  const n = state.stopRemaining;
  const sessions = n === 0 ? 'Every session has ended.'
    : n > 0 ? `${n} session process${n === 1 ? '' : 'es'} did not confirm exiting in time and may still be running. Check your system's process list.`
    : 'The manager went away before confirming that every session had ended.';
  if (state.restarting) {
    setConnection('down', 'Restarting the session manager…');
    return showStopped('restarting', 'Restarting the session manager…', `${sessions} Waiting for the new manager; this page reconnects to it by itself.`);
  }
  setConnection('down', 'Session manager stopped');
  showStopped('stopped', 'Session manager stopped', sessions);
}

// ---- events ---------------------------------------------------------------

function connectEvents() {
  const ws = new WebSocket(wsUrl('/events'));
  state.eventsSocket = ws;
  ws.onopen = () => {
    state.eventsRetry = 0;
    setConnection('ok', 'Connected to session manager');
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      // The manager is back after a stop or restart; the page picks up where it was.
      if (state.stopping) leaveStopping();
      state.version = msg.version || null;
      state.pid = msg.pid || null;
      state.restartable = typeof msg.pid === 'number';
      state.launcher = typeof msg.launcher === 'string' ? msg.launcher : null;
      renderVersion();
      setConnection('ok', 'Connected to session manager');
      state.sessions = new Map(msg.sessions.map((s) => [s.id, s]));
      for (const id of [...state.views.keys()]) if (!state.sessions.has(id)) dropSession(id);
      renderSessions();
      sessionsShown = true;
      setUpgrade(msg.upgrade);
      loadNews();
      // A changelog.updated sent while the socket was down is lost; catch up the open panel.
      if ($('changelog').open) loadChangelog();
      if ($('github').open) loadGitHub();
    } else if (msg.type === 'news.updated') {
      loadNews();
    } else if (msg.type === 'github.updated') {
      if ($('github').open) loadGitHub();
    } else if (msg.type === 'changelog.updated') {
      if ($('changelog').open) loadChangelog();
    } else if (msg.type === 'manager.upgrade') {
      setUpgrade(msg.upgrade);
    } else if (msg.type === 'manager.stopping') {
      enterStopping(msg.running, msg.restart === true);
    } else if (msg.type === 'manager.stopped') {
      enterStopping(0, msg.restart === true);
      state.stopRemaining = Number(msg.remaining) || 0;
      showManagerStopped();
    } else if (msg.type === 'session.created' || msg.type === 'session.updated') {
      upsertSession(msg.session);
    } else if (msg.type === 'session.removed') {
      dropSession(msg.sessionId);
    } else if (msg.type === 'providers.updated') {
      state.providers = msg.providers;
      renderProviders();
      if ($('history').open) renderHistory();
      scheduleStats();
    }
  };
  ws.onclose = () => {
    if (state.stopping) {
      showManagerStopped();
    } else {
      setConnection('down', 'Session manager not reachable. Run "agent-guild open" to start it.');
    }
    // Keep trying: after a stop, a relaunched manager brings the page back by itself.
    const delay = Math.min(5000, 500 * 2 ** state.eventsRetry++);
    setTimeout(async () => {
      try { await loadProviders(); } catch (err) { if (err instanceof AuthError) return showAuth(err.message); }
      connectEvents();
    }, delay);
  };
}

async function loadProviders() {
  const { providers } = await api('GET', '/providers');
  state.providers = providers;
  renderProviders();
}

// ---- auth & boot ----------------------------------------------------------

function readTokenFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token');
  if (token) {
    // Keep the token out of the address bar and browser history.
    history.replaceState(null, '', location.pathname + location.search);
  }
  return token;
}

let usageTimer;
let statsInterval;
let newsTimer;

function showAuth(message = '') {
  closeModels();
  closeNews();
  closeChangelog();
  closeHistory();
  closeGitHub();
  $('app').hidden = true;
  $('terminal-panel').hidden = true;
  $('stopped').hidden = true;
  state.stopping = false;
  state.restarting = false;
  clearTimeout(restartTimer);
  $('auth').hidden = false;
  $('auth-error').textContent = message;
  setConnection('down', 'Not connected');
}

async function boot() {
  $('app').hidden = true;
  $('auth').hidden = true;
  $('stopped').hidden = true;
  if (!state.token) return showAuth();
  try {
    await loadProviders();
  } catch (err) {
    if (err instanceof AuthError) {
      save(TOKEN_KEY, null);
      return showAuth(`${err.message} Open the page again with "agent-guild open".`);
    }
    setConnection('down', 'Session manager not reachable. Run "agent-guild open" to start it.');
  }
  save(TOKEN_KEY, state.token);
  $('app').hidden = false;
  connectEvents();
  loadUsage();
  clearInterval(usageTimer);
  usageTimer = setInterval(loadUsage, 60000);
  loadStats();
  clearInterval(statsInterval);
  statsInterval = setInterval(loadStats, 60 * 60 * 1000);
  clearInterval(newsTimer);
  newsTimer = setInterval(() => { if (document.visibilityState === 'visible') loadNews(); }, NEWS_POLL_MS);
}

$('auth-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const token = $('auth-token').value.trim();
  if (!token) return;
  state.token = token;
  boot();
});
$('panel-close').addEventListener('click', closePanel);
$('models-close').addEventListener('click', closeModels);
$('history-close').addEventListener('click', closeHistory);
$('history').addEventListener('click', (e) => { if (e.target === $('history')) closeHistory(); });
$('history').addEventListener('close', () => {
  if (historyOpener !== false) {
    const opener = historyOpener?.isConnected ? historyOpener
      : $('providers').querySelector(`.provider[data-id="${historyView.providerId}"] .existing`);
    opener?.focus();
  }
  historyOpener = null;
});
$('history-filter').addEventListener('input', renderHistory);
$('github-open').addEventListener('click', openGitHub);
$('github-close').addEventListener('click', () => closeGitHub());
$('github').addEventListener('click', (e) => { if (e.target === $('github')) closeGitHub(); });
$('github').addEventListener('close', () => {
  if (githubView.opener !== false) (githubView.opener?.isConnected && !githubView.opener.closest('[hidden]') ? githubView.opener : $('github-open')).focus();
  githubView.opener = null;
});
$('github-add').addEventListener('click', startGitHubSignIn);
$('github-filter').addEventListener('input', () => renderGitHub());
$('github-refresh').addEventListener('click', () => loadRepos({ refresh: true }));
$('github-new').addEventListener('click', () => showCreate($('github-create').hidden));
$('github-create').addEventListener('submit', createRepo);
$('github-create-cancel').addEventListener('click', () => {
  showCreate(false);
  $('github-new').focus();
});
$('github-create').addEventListener('input', () => {
  $('github-create-error').hidden = true;
  renderCreate();
});
$('github-parent').addEventListener('change', () => {
  save(CLONE_PARENT_KEY, cloneParent());
  loadRepos();
});
$('history-here').addEventListener('change', renderHistory);
$('history-form').addEventListener('submit', resumeById);
$('models').addEventListener('click', (e) => { if (e.target === $('models')) closeModels(); });
$('models').addEventListener('close', () => {
  hideTip();
  const opener = modelsOpener?.isConnected ? modelsOpener
    : modelsView.sessionId ? cards.get(modelsView.sessionId)?.querySelector('.model-pill')
    : $('providers').querySelector(`.provider[data-id="${modelsView.providerId}"] .model-stats-head`);
  opener?.focus();
  modelsOpener = null;
});
document.addEventListener('pointerover', (e) => {
  const info = e.target.closest?.('.info');
  if (info && e.pointerType !== 'touch') showTip(info);
});
document.addEventListener('pointerout', (e) => {
  if (tipFor && e.target === tipFor && document.activeElement !== tipFor) hideTip();
});
document.addEventListener('pointerdown', (e) => { if (tipFor && !e.target.closest?.('.info')) hideTip(); });
document.addEventListener('click', (e) => {
  const info = e.target.closest?.('.info');
  if (info) showTip(info);
});
document.addEventListener('focusin', (e) => { if (!quietFocus && e.target.matches?.('.info')) showTip(e.target); });
document.addEventListener('focusout', (e) => { if (e.target === tipFor) hideTip(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !tipFor) return;
  hideTip();
  e.preventDefault();
  e.stopPropagation();
}, true);
addEventListener('scroll', () => { if (tipFor) hideTip(); }, true);
addEventListener('resize', () => { if (tipFor) hideTip(); });
$('news-all').addEventListener('click', openNews);
$('news-close').addEventListener('click', closeNews);
$('news-fresh').addEventListener('click', showFreshNews);
$('news').addEventListener('click', (e) => { if (e.target === $('news')) closeNews(); });
$('news').addEventListener('close', () => {
  const newest = newestTime(newsView.shown?.items ?? []);
  if (newest > (newsSeen() ?? 0)) save(NEWS_SEEN_KEY, new Date(newest).toISOString());
  renderLatestNews();
  const opener = newsView.opener?.isConnected && !newsView.opener.closest('[hidden]') ? newsView.opener : $('news-all');
  opener.focus();
  newsView.opener = null;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.connected && Date.now() - newsLoadedAt > 60000) loadNews();
});
$('version').addEventListener('click', openChangelog);
$('changelog-close').addEventListener('click', closeChangelog);
$('changelog').addEventListener('click', (e) => { if (e.target === $('changelog')) closeChangelog(); });
$('changelog').addEventListener('close', () => {
  const opener = changelogView.opener?.isConnected && !changelogView.opener.closest('[hidden]') ? changelogView.opener : $('version');
  opener.focus();
  changelogView.opener = null;
});
$('changelog-upgrade').addEventListener('click', () => {
  closeChangelog();
  upgradeManager();
});
$('changelog-restart').addEventListener('click', () => {
  closeChangelog();
  stopManager({ restart: true });
});
addEventListener('storage', (e) => { if (e.key === CHANGELOG_SEEN_KEY) renderVersion(); });
$('models-more').addEventListener('click', () => {
  const before = $('models-list').childElementCount;
  modelsView.all = true;
  renderModels();
  $('models-list').children[before]?.querySelector('.model-toggle')?.focus();
});
$('stop-manager').addEventListener('click', () => stopManager());
$('restart-manager').addEventListener('click', () => stopManager({ restart: true }));
$('copy-command').addEventListener('click', copyCommand);
$('upgrade').addEventListener('click', upgradeManager);
$('appearance-menu').addEventListener('change', (e) => {
  if (e.target.name === 'skin') changeSkin(e.target);
  else if (e.target.name === 'theme') changeTheme(e.target);
});
$('appearance-menu').addEventListener('toggle', (e) => {
  if (e.newState !== 'open') return;
  placeAppearanceMenu();
  e.currentTarget.querySelector('input:checked')?.focus();
});
window.addEventListener('resize', placeAppearanceMenu);
$('providers').addEventListener('animationend', (e) => {
  if (e.target === e.currentTarget.lastElementChild) e.currentTarget.classList.remove('deal');
});
let tiltFrame = 0;
$('providers').addEventListener('pointermove', (e) => {
  const card = e.target.closest('.provider');
  if (!card || !finePointer.matches || reducedMotion.matches) return;
  const box = card.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * 2 - 1;
  const y = ((e.clientY - box.top) / box.height) * 2 - 1;
  cancelAnimationFrame(tiltFrame);
  tiltFrame = requestAnimationFrame(() => {
    card.style.setProperty('--px', x.toFixed(3));
    card.style.setProperty('--py', y.toFixed(3));
  });
});
$('providers').addEventListener('pointerout', (e) => {
  const card = e.target.closest('.provider');
  if (card && !card.contains(e.relatedTarget)) {
    cancelAnimationFrame(tiltFrame);
    card.style.removeProperty('--px');
    card.style.removeProperty('--py');
  }
});
applyTheme(currentTheme());
renderSkinChoices();
// Follow the system setting until the user picks a theme.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!load(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
});
$('panel-stop').addEventListener('click', () => {
  const s = state.sessions.get(state.activeId);
  if (!s) return;
  if (s.status === 'running') stopSession(s.id);
  else removeSession(s.id);
});
$('cwd').value = load(CWD_KEY) || '';
try { state.accounts = JSON.parse(load(ACCOUNTS_KEY)) || {}; } catch { state.accounts = {}; }
githubView.accountId = Number(load(GITHUB_ACCOUNT_KEY)) || null;
if (typeof state.accounts !== 'object' || Array.isArray(state.accounts)) state.accounts = {};
setInterval(renderSessions, 30000);
setInterval(tickNews, 30000);
setInterval(() => { if ($('github').open && state.github) renderGitHub(); }, 30000);

// The terminal panel sits below the top bar, which wraps onto two rows on
// narrow screens; publish its height so the panel never covers its controls.
const topbar = document.querySelector('.topbar');
const publishTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${topbar.offsetHeight}px`);
new ResizeObserver(publishTopbarHeight).observe(topbar);
publishTopbarHeight();

state.token = readTokenFromHash() || load(TOKEN_KEY);
boot();

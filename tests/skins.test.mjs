import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Every skin must define these for light; the colour tokens again for dark.
const TOKENS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--heading', '--accent', '--accent-fill', '--accent-text',
  '--danger', '--ok', '--warn', '--gold', '--gold-ink', '--focus', '--shadow', '--radius', '--font-display'];
const DARK_TOKENS = TOKENS.filter((t) => !['--accent-text', '--radius', '--font-display'].includes(t));

const web = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');

/** The skins list exactly as theme.js builds it in the browser. */
function skins() {
  const window = { matchMedia: () => ({ matches: false }) };
  const document = { documentElement: { dataset: {} } };
  const localStorage = { getItem: () => null };
  runInNewContext(readFileSync(new URL('theme.js', web), 'utf8'), { window, document, localStorage });
  return window.agentGuildSkins;
}

/** The bodies of every top-level block with exactly this selector, joined. */
function blocks(css, selector) {
  let out = '';
  for (let at = css.indexOf(`${selector} {`); at !== -1; at = css.indexOf(`${selector} {`, at + 1)) {
    if (at > 0 && css[at - 1] !== '\n') continue;
    let depth = 0;
    const start = css.indexOf('{', at);
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { out += css.slice(start + 1, i); break; }
    }
  }
  return out;
}

/** Custom properties declared directly in a block body, not inside nested rules. */
function declared(body) {
  const names = new Set();
  let depth = 0;
  for (const part of body.split(/([{}])/)) {
    if (part === '{') depth++;
    else if (part === '}') depth--;
    else if (depth === 0) for (const m of part.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  }
  return names;
}

const list = skins();

test('theme.js lists skins with unique, valid ids', () => {
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.equal(new Set(list.map((s) => s.id)).size, list.length);
  for (const skin of list) assert.match(skin.id, /^[a-z][a-z0-9-]*$/, skin.id);
});

for (const { id } of list) {
  const file = new URL(`skins/${id}/skin.css`, web);

  test(`skin "${id}": stylesheet exists and index.html links it`, () => {
    assert.ok(existsSync(file), `web/skins/${id}/skin.css`);
    assert.ok(html.includes(`<link rel="stylesheet" href="/skins/${id}/skin.css">`), `index.html links /skins/${id}/skin.css`);
  });

  test(`skin "${id}": defines every token for light and the colour tokens for dark`, () => {
    const css = readFileSync(file, 'utf8');
    const light = declared(blocks(css, `:where(:root[data-skin="${id}"])`));
    const dark = declared(blocks(css, `:where(:root[data-skin="${id}"][data-theme="dark"])`));
    assert.deepEqual(TOKENS.filter((t) => !light.has(t)), [], 'missing light tokens');
    assert.deepEqual(DARK_TOKENS.filter((t) => !dark.has(t)), [], 'missing dark tokens');
  });

  test(`skin "${id}": keyframes are prefixed with the skin id`, () => {
    const css = readFileSync(file, 'utf8');
    const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    assert.deepEqual(names.filter((n) => !n.startsWith(`${id}-`)), []);
  });

  test(`skin "${id}": every relative url() points to a file`, () => {
    const css = readFileSync(file, 'utf8');
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]).filter((u) => !/^(data:|\/|#|https?:)/.test(u));
    assert.ok(urls.length > 0);
    assert.deepEqual(urls.filter((u) => !existsSync(new URL(u, file))), []);
  });
}

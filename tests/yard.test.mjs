import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CAMP, MAX_SHOWN, PLOTS, anchorForProvider, layoutUnits } from '../web/yard-layout.mjs';

const web = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('yard.css', web), 'utf8');

function bootTheme(stored) {
  const window = { matchMedia: () => ({ matches: false }) };
  const document = { documentElement: { dataset: {} } };
  const localStorage = { getItem: (key) => stored[key] ?? null };
  runInNewContext(readFileSync(new URL('theme.js', web), 'utf8'), { window, document, localStorage });
  return document.documentElement.dataset;
}

test('theme.js defaults the view to cards and can restore the yard', () => {
  assert.equal(bootTheme({}).view, 'cards');
  assert.equal(bootTheme({ 'agentGuild.view': 'yard' }).view, 'yard');
  assert.equal(bootTheme({ 'agentGuild.view': 'nope' }).view, 'cards');
});

test('the page offers Cards and Yard and loads the yard after the card app', () => {
  assert.match(html, /id="view-cards"/);
  assert.match(html, /id="view-yard"/);
  assert.match(html, /id="yard"/);
  assert.match(html, /href="\/yard\.css"/);
  assert.match(html, /src="\/yard\/court\.webp"/);
  const appAt = html.indexOf('src="/app.js"');
  const yardAt = html.indexOf('src="/yard.js"');
  assert.ok(appAt > 0 && yardAt > appAt, 'yard.js follows app.js so it can hear its sync event');
});

test('the card page tells the yard when providers, sessions or usage change', () => {
  assert.equal(app.match(/syncViews\(\);/g).length, 3);
  assert.match(app, /new CustomEvent\('agentguild:sync'\)/);
});

test('the yard hides until asked and does not animate when motion is reduced', () => {
  const base = readFileSync(new URL('styles.css', web), 'utf8');
  assert.match(base, /#yard\s*\{\s*display:\s*none/);
  assert.match(css, /:root\[data-view="yard"\]\s+#yard/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('heroes stand in front of their hall and overflow is counted', () => {
  const placed = layoutUnits([
    { id: 'a', providerId: 'anthropic' },
    { id: 'b', providerId: 'anthropic' },
  ], anchorForProvider);
  assert.equal(placed.length, 2);
  for (const hero of placed) {
    assert.ok(hero.y > PLOTS.anthropic.y, `${hero.id} should stand in front of the keep`);
    assert.ok(Math.abs(hero.x - PLOTS.anthropic.x) < 12);
  }
  const crowd = layoutUnits(
    Array.from({ length: MAX_SHOWN + 4 }, (_, i) => ({ id: `s${i}`, providerId: 'shell' })),
    anchorForProvider,
  );
  assert.equal(crowd.length, MAX_SHOWN);
  assert.equal(crowd.at(-1).more, 4);
  assert.ok(crowd.slice(0, -1).every((hero) => hero.more === 0));
});

test('clone and upgrade sessions share the camp without stacking', () => {
  const placed = layoutUnits([
    { id: 'clone', providerId: 'github' },
    { id: 'upgrade', providerId: 'agent-guild' },
  ], anchorForProvider);
  assert.equal(placed.length, 2);
  assert.ok(Math.hypot(placed[0].x - CAMP.x, placed[0].y - CAMP.y) < 16);
  assert.notEqual(`${placed[0].x},${placed[0].y}`, `${placed[1].x},${placed[1].y}`);
});

test('a custom provider gets its own camp instead of a built-in hall', () => {
  const anchor = anchorForProvider('workshop', 1);
  assert.equal(anchor.camp, true);
  assert.ok(anchor.y >= 85);
  assert.ok(!PLOTS.workshop);
});

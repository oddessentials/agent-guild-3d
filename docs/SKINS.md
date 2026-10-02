# Skins

A skin is the page's art and design styling, in a light and a dark variant.
The Appearance menu in the top bar switches skin and variant in place. A skin
changes how the page looks and nothing else: layout, controls, labels and
behaviour stay the same. The Yard view (`web/yard.js`) is a separate layout,
not a skin. Its frame uses the same colour tokens.

The skins are `web/skins/guild/` (the default), `web/skins/professional/`, `web/skins/orbital/` and `web/skins/grove/`.
Copy the closer one to start a new skin.

## What a skin never changes

| Element | Where it lives |
| --- | --- |
| Logo: crest and "Agent Guild" wordmark | `web/brand/`, `--wordmark`, `--font-brand` in `web/styles.css` |
| Favicon and loading splash | `web/brand/`, `web/styles.css` |
| Terminal | `TERMINAL_THEME` in `web/app.js`, `--term-bg` in `web/styles.css` |
| Interface icons | `--icon-*` in `web/styles.css` |
| Provider icons supplied by the user (`.provider-icon.has-image`) | the manager |
| Labels, layout, markup and behaviour | `web/index.html`, `web/styles.css`, `web/app.js` |

## Adding a skin with id `<id>`

1. Add `{ id: '<id>', name: '<Menu label>' }` to the `skins` list in `web/theme.js`. The order is the menu order; the first entry is the default.
2. Add `<link rel="stylesheet" href="/skins/<id>/skin.css">` after the other skin stylesheets in `web/index.html`.
3. Write `web/skins/<id>/skin.css`:
   * Nest every rule inside `:where(:root[data-skin="<id>"])`, `:where(:root[data-skin="<id>"][data-theme="dark"])` or `:where(:root[data-skin="<id>"][data-theme="light"])`. `:where()` keeps each rule's specificity equal to the base rule it overrides.
   * Define the tokens listed in `tests/skins.test.mjs`.
   * Start every `@keyframes` name with `<id>-`.
   * Reference art by URLs relative to `skin.css`.
4. Put the art's sources or generator in `concept-art/`.
5. Run `npm test`. `tests/skins.test.mjs` checks steps 1–3 and that every referenced file exists.

## Slots

Fill each of these in both variants.

| Slot | Selector |
| --- | --- |
| Provider colour and art (idle, working, locked) | `--pc`, `--idle`, `--working`, `--locked` on `.provider[data-id="…"]` and `.session-card[data-provider="…"]`, with a fallback on `.provider, .session-card` |
| Provider art | `.card-art::before`; working art on `.session-card .card-art::after`; locked art on `.provider.unavailable .card-art::before` |
| Provider icon | `.provider-icon:not(.has-image)[data-provider="…"]` |
| Card and dialog frames | `.provider::after`, `.session-card::after`, `.models::after`, `.auth::after` |
| Locked provider badge | `.provider.unavailable::after` |
| Level badge | `.level-badge` (its text is the level number) |
| Agent avatars | `.agent[data-familiar="flame\|leaf\|night\|aether"]` |
| Usage meter markers | `.meter-label`, `.meter + .meter .meter-label` |
| Empty sessions illustration | `#empty::before` |
| Page background | `body::before` |
| Working effect | `.card-aura::before`, `.card-aura::after` while the session is active |
| Card art size | `.provider` `padding-top` with `.provider .card-art`; `.session-card` `padding-left` with `.session-card .card-art, .card-aura` `width` |

## Motion hooks

The page adds these classes once and removes each when an animation on that
element ends. Run an animation on each, and none under
`prefers-reduced-motion: reduce`.

| Class | When |
| --- | --- |
| `.providers.deal > .provider` | Provider cards first appear |
| `.session-card.enter` | A session card appears |
| `.level-badge.level-up` | A session's level rises |
| `.agent.summon` | A new agent appears |

## Acceptance checklist

* The skin appears in the Appearance menu, and selecting it restyles the page without a reload.
* After a reload the page opens in the selected skin with no flash of another skin.
* Light and dark both fill every slot.
* The logo, favicon, splash, terminal and interface icons look the same in every skin.
* All four motion hooks animate once and stop; nothing animates under reduced motion.
* `npm test` passes.

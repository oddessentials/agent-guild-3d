// A stand-in history command for screenshots and video: prints earlier
// sessions in the format a provider's `history` command uses (README,
// Configure providers). Arguments: the provider id and the demo root folder.

import path from 'node:path';

const [provider, root = '.'] = process.argv.slice(2);
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const id = (n) => `${provider.slice(0, 2)}${(0x5f3a91c2 + n * 7919).toString(16)}-${(0x2b7e + n * 131).toString(16)}-4c1d-9e0a-${(0x7d21a4e0c3b5 + n * 104729).toString(16)}`;

const TITLES = [
  ['storefront', 'Add Apple Pay and Google Pay to the checkout flow'],
  ['storefront', 'Why does the cart badge flicker on Safari?'],
  ['api-gateway', 'Add per-key rate limiting to the API gateway'],
  ['billing', 'Migrate the invoice job to the new billing API'],
  ['storefront', 'Write Playwright tests for guest checkout'],
  ['docs-site', 'Move the docs site to the new static generator'],
  ['game-engine', 'Speed up the particle shader on mobile'],
  ['api-gateway', 'Trace the 502s behind the load balancer'],
  ['billing', 'Explain the proration rules in plain English'],
  ['storefront', 'Refactor the product grid to server components'],
  ['game-engine', 'Port the physics step to a worker'],
  ['docs-site', 'Generate API reference pages from the OpenAPI spec'],
];

const hours = [0.4, 2, 5, 9, 26, 30, 49, 75, 100, 150, 200, 260];
console.log(JSON.stringify({
  sessions: TITLES.map(([folder, title], n) => ({
    id: id(n),
    title,
    cwd: path.join(root, folder),
    startedAt: ago(hours[n] + 1.5),
    updatedAt: ago(hours[n]),
  })),
}));

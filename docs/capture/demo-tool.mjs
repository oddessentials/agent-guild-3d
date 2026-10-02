// A stand-in coding tool for screenshots and video: it streams plausible
// work in a loop and reports its model and helper agents the way the real
// tools' hooks do, through the in-band report sequence (docs/agent-reporting.md).
//
//   node demo-tool.mjs [--script <name>] [--model <id> <display name>]
//                      [--agents <name:status,...>] [--quiet]
//   node demo-tool.mjs --version      prints DEMO_VERSION, or 1.0.0
//
// --script picks one of SCRIPTS below. The script plays once, then a
// watch-mode test run keeps printing, so the card reads "Working" without
// the screen repeating itself. --quiet prints the script at once and then waits,
// so the card reads "Running". Typed lines are echoed back, so the terminal
// answers like a real one.

const argv = process.argv.slice(2);

if (argv.includes('--version')) {
  console.log(`demo-tool ${process.env.DEMO_VERSION || '1.0.0'}`);
  process.exit(0);
}

function option(name, count = 1) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv.slice(i + 1, i + 1 + count);
}

const ESC = '\x1b';
const c = {
  dim: (s) => `${ESC}[2m${s}${ESC}[22m`,
  bold: (s) => `${ESC}[1m${s}${ESC}[22m`,
  green: (s) => `${ESC}[32m${s}${ESC}[39m`,
  red: (s) => `${ESC}[31m${s}${ESC}[39m`,
  yellow: (s) => `${ESC}[33m${s}${ESC}[39m`,
  cyan: (s) => `${ESC}[36m${s}${ESC}[39m`,
  magenta: (s) => `${ESC}[35m${s}${ESC}[39m`,
};

const step = (verb, rest) => `${c.cyan('●')} ${c.bold(verb)} ${rest}`;
const ok = (s) => `  ${c.green('✓')} ${s}`;
const diff = (file, add, del) => step('Edit', `${file}  ${c.green(`+${add}`)} ${c.red(`−${del}`)}`);

// Each script is a prompt and the lines that follow it, replayed in a loop.
const SCRIPTS = {
  checkout: {
    prompt: 'Add Apple Pay and Google Pay to the checkout flow, with tests',
    lines: [
      step('Read', 'src/checkout/PaymentStep.tsx'),
      step('Search', `"PaymentRequest" ${c.dim('· 14 matches in 6 files')}`),
      step('Agent', `${c.magenta('explore')} mapping the payment providers`),
      step('Agent', `${c.magenta('test-writer')} drafting wallet tests`),
      diff('src/checkout/PaymentStep.tsx', 48, 9),
      `  ${c.dim('41')}   const methods = useMemo(() => [`,
      `  ${c.dim('42')} ${c.red('-')}   { type: 'card' },`,
      `  ${c.dim('42')} ${c.green('+')}   { type: 'card' },`,
      `  ${c.dim('43')} ${c.green('+')}   ...(wallets.applePay ? [{ type: 'apple_pay' }] : []),`,
      `  ${c.dim('44')} ${c.green('+')}   ...(wallets.googlePay ? [{ type: 'google_pay' }] : []),`,
      `  ${c.dim('45')}   ], [wallets]);`,
      diff('src/checkout/wallets.ts', 112, 0),
      step('Run', 'npm test -- checkout'),
      ok(`38 passed ${c.dim('(4.2 s)')}`),
      step('Agent', `${c.magenta('reviewer')} checking the diff`),
      ok('No issues found'),
    ],
  },
  billing: {
    prompt: 'Migrate the invoice job to the new billing API',
    lines: [
      step('Read', 'services/billing/invoice-job.ts'),
      step('Read', 'docs/billing-v2.md'),
      step('Agent', `${c.magenta('explore')} listing every v1 call site`),
      diff('services/billing/invoice-job.ts', 64, 41),
      diff('services/billing/client.ts', 27, 12),
      step('Run', 'npm run typecheck'),
      ok('No type errors'),
    ],
  },
  ratelimit: {
    prompt: 'Add per-key rate limiting to the API gateway',
    lines: [
      step('Read', 'gateway/middleware/index.go'),
      step('Search', `"TokenBucket" ${c.dim('· 3 matches')}`),
      diff('gateway/middleware/ratelimit.go', 96, 0),
      diff('gateway/middleware/index.go', 6, 1),
      step('Run', 'go test ./gateway/...'),
      ok(`ok  gateway/middleware  ${c.dim('0.41s')}`),
    ],
  },
  docs: {
    prompt: 'Move the docs site to the new static generator',
    lines: [
      step('Read', 'docs/config.yaml'),
      step('Agent', `${c.magenta('migrator')} converting 86 pages`),
      diff('docs/site.config.ts', 58, 0),
      step('Run', 'npm run docs:build'),
      ok(`Built 86 pages ${c.dim('(2.9 s)')}`),
      step('Run', 'npm run docs:links'),
      ok('0 broken links'),
    ],
  },
  shaders: {
    prompt: 'Speed up the particle shader on mobile',
    lines: [
      step('Read', 'engine/shaders/particles.wgsl'),
      step('Agent', `${c.magenta('profiler')} measuring frame times`),
      diff('engine/shaders/particles.wgsl', 31, 22),
      step('Run', 'npm run bench -- particles'),
      ok(`16.4 ms → ${c.green('9.1 ms')} per frame`),
    ],
  },
  shell: {
    prompt: null,
    lines: [
      `${c.green('$')} npm run dev`,
      `${c.dim('> storefront@3.4.0 dev')}`,
      `  ${c.green('➜')}  Local:   ${c.cyan('http://localhost:5173/')}`,
      `  ${c.dim('➜')}  ready in 412 ms`,
      `  ${c.dim('12:04:11')} ${c.green('[hmr]')} /src/checkout/PaymentStep.tsx`,
      `  ${c.dim('12:04:19')} ${c.green('[hmr]')} /src/checkout/wallets.ts`,
    ],
  },
};

const script = SCRIPTS[option('--script')?.[0]] || SCRIPTS.checkout;
const [modelId, ...modelName] = option('--model', 2) || [];
const quiet = argv.includes('--quiet');

const write = (s) => process.stdout.write(s);
const line = (s = '') => write(`${s}\r\n`);
const report = (body) => write(`${ESC}]7777;agent-guild;${JSON.stringify(body)}\x07`);

if (modelId) report({ model: modelId, displayName: modelName.join(' ') || undefined });
for (const spec of (option('--agents')?.[0] || '').split(',').filter(Boolean)) {
  const [name, status = 'working'] = spec.split(':');
  report({ agentId: name.toLowerCase().replace(/\W+/g, '-'), name, status });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// After the script, a watch-mode test run passes one test at a time.
const SUITES = ['checkout', 'cart', 'wallets', 'billing', 'gateway', 'session', 'search', 'profile'];
const CASES = [
  'renders the payment step', 'handles a declined card', 'retries on timeout', 'keeps the cart in sync',
  'applies the discount code', 'rejects an expired token', 'shows the wallet button', 'rounds totals to cents',
  'falls back without a wallet', 'records the receipt', 'limits requests per key', 'resumes after reconnect',
];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

(async () => {
  if (script.prompt) {
    line(`${c.bold('›')} ${script.prompt}`);
    line();
  }
  for (const l of script.lines) {
    line(l);
    if (!quiet) await sleep(900 + Math.random() * 700);
  }
  line();
  if (quiet) return;
  line(step('Run', `npm test -- --watch ${c.dim('· watching for changes')}`));
  for (;;) {
    await sleep(1100 + Math.random() * 900);
    line(ok(`${pick(SUITES)} › ${pick(CASES)} ${c.dim(`(${8 + Math.floor(Math.random() * 90)} ms)`)}`));
  }
})();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.search(/[\r\n]/)) !== -1) {
    const typed = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (typed) line(`${c.bold('›')} ${typed}`);
  }
});
process.on('SIGHUP', () => process.exit(129));

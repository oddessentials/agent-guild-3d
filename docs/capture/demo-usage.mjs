// A stand-in usage command for screenshots and video: prints one usage
// report in the format a provider's `usage` command uses (README, Configure
// providers). The provider id is the first argument. A non-default account
// is told apart by DEMO_ACCOUNT, its home folder, which capture.mjs sets
// through the provider's accountEnv.

import path from 'node:path';

const provider = process.argv[2];
const account = process.env.DEMO_ACCOUNT ? path.basename(process.env.DEMO_ACCOUNT) : 'default';
const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const REPORTS = {
  anthropic: {
    default: { plan: 'pro', windows: [{ label: '5-hour', usedPercent: 38, resetsAt: inHours(2.6) }, { label: '7-day', usedPercent: 21, resetsAt: inHours(97) }] },
    work: { plan: 'max', windows: [{ label: '5-hour', usedPercent: 64, resetsAt: inHours(1.2) }, { label: '7-day', usedPercent: 47, resetsAt: inHours(52) }] },
  },
  openai: {
    default: { plan: 'plus', windows: [{ label: '5-hour', usedPercent: 27, resetsAt: inHours(3.4) }, { label: '7-day', usedPercent: 12, resetsAt: inHours(130) }] },
  },
  google: {
    default: { plan: 'free', windows: [{ label: 'Pro', usedPercent: 18, resetsAt: inHours(15) }, { label: 'Flash', usedPercent: 6, resetsAt: inHours(15) }] },
  },
};

const report = REPORTS[provider]?.[account] || REPORTS[provider]?.default || { windows: [] };
console.log(JSON.stringify(report));

// A stand-in usage command for tests: prints one usage report as JSON.
console.log(JSON.stringify({
  plan: 'test',
  windows: [
    { label: '5-hour', usedPercent: 42.25, resetsAt: '2030-01-01T00:00:00.000Z' },
    { label: '7-day', remainingPercent: 10 },
    { label: 'broken' },
    { label: 'unknown', usedPercent: null, remainingPercent: null },
  ],
}));

// A stand-in history command for tests: prints past sessions as JSON.
console.log(JSON.stringify({
  sessions: [
    { id: 'older-1', title: 'Fix the  login\nbug', cwd: '/work/app', startedAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T01:00:00.000Z' },
    { id: 'newer-2', title: '', cwd: '', updatedAt: 1893456000 },
    { id: ' ', title: 'no id' },
    { id: 'bad\nid' },
    'not an object',
  ],
}));

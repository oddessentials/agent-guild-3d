import http from 'node:http';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function startFakeGitHub({ user = { id: 4242, login: 'octo-cat', name: 'Octo Cat' }, repos = null } = {}) {
  const state = {
    user,
    scopes: 'repo, write:public_key',
    tokenScope: 'repo,write:public_key',
    pendingPolls: 0,
    pollError: null,
    slowDownInterval: null,
    expiresIn: 28800,
    access: null,
    refresh: null,
    issued: 0,
    refreshes: 0,
    refreshDelayMs: 0,
    keys: [],
    keyPosts: [],
    keyPostStatus: 201,
    repos: repos ?? [
      { full_name: 'octo-cat/old-tool', private: false, fork: false, archived: true, description: 'An old tool', language: 'Go', pushed_at: '2025-01-01T00:00:00Z' },
      { full_name: 'octo-cat/agent-guild', private: true, fork: false, archived: false, description: 'Run coding agents', language: 'JavaScript', pushed_at: '2026-09-30T00:00:00Z' },
      { full_name: 'acme/api', private: true, fork: true, archived: false, description: null, language: null, pushed_at: '2026-06-01T00:00:00Z' },
    ],
    requests: [],
    created: [],
    orgs: ['acme'],
  };
  const withOwner = (repo) => {
    const owner = repo.full_name.split('/')[0];
    return { owner: { login: owner, type: state.orgs.includes(owner) ? 'Organization' : 'User' }, ...repo };
  };
  const issue = () => {
    state.issued++;
    state.access = `access-${state.issued}`;
    state.refresh = `refresh-${state.issued}`;
    return { access_token: state.access, token_type: 'bearer', scope: state.tokenScope, expires_in: state.expiresIn, refresh_token: state.refresh, refresh_token_expires_in: 15897600 };
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const form = Object.fromEntries(new URLSearchParams(raw));
    if (req.method === 'POST' && url.pathname === '/login/device/code') {
      if (!form.client_id) return json(400, { error: 'unsupported_grant_type' });
      state.deviceScope = form.scope;
      return json(200, { device_code: 'device-1', user_code: 'WDJB-MJHT', verification_uri: `${base}/login/device`, expires_in: 900, interval: 1 });
    }
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      if (form.grant_type === 'refresh_token') {
        state.refreshes++;
        if (state.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, state.refreshDelayMs));
        if (form.refresh_token !== state.refresh) return json(200, { error: 'bad_refresh_token' });
        return json(200, issue());
      }
      if (state.pollError) return json(200, { error: state.pollError });
      if (state.slowDownInterval) {
        const interval = state.slowDownInterval;
        state.slowDownInterval = null;
        return json(200, { error: 'slow_down', interval });
      }
      if (state.pendingPolls > 0) {
        state.pendingPolls--;
        return json(200, { error: 'authorization_pending' });
      }
      return json(200, issue());
    }
    if (url.pathname.startsWith('/avatar/')) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(PNG);
    }
    if (req.headers.authorization !== `Bearer ${state.access}`) return json(401, { message: 'Bad credentials' });
    const scoped = { 'X-OAuth-Scopes': state.scopes };
    if (req.method === 'GET' && url.pathname === '/user') {
      return json(200, { ...state.user, avatar_url: `${base}/avatar/${state.user.id}?v=4` }, scoped);
    }
    if (req.method === 'GET' && url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') || 1);
      const half = Math.ceil(state.repos.length / 2);
      const slice = page === 1 ? state.repos.slice(0, half) : state.repos.slice(half);
      const link = page === 1 && state.repos.length > half ? { Link: `<${base}/user/repos?page=2>; rel="next", <${base}/user/repos?page=2>; rel="last"` } : {};
      return json(200, slice.map(withOwner), { ...scoped, ...link });
    }
    const orgRepos = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (req.method === 'POST' && (url.pathname === '/user/repos' || orgRepos)) {
      const body = JSON.parse(raw);
      const owner = orgRepos ? decodeURIComponent(orgRepos[1]) : state.user.login;
      if (orgRepos && !state.orgs.includes(owner)) return json(404, { message: 'Not Found' });
      const fullName = `${owner}/${body.name}`;
      if (state.repos.some((r) => r.full_name.toLowerCase() === fullName.toLowerCase())) {
        return json(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
      }
      state.created.push({ owner, ...body });
      const repo = { full_name: fullName, private: body.private, fork: false, archived: false, description: body.description ?? null, language: null, pushed_at: new Date().toISOString() };
      state.repos.unshift(repo);
      return json(201, withOwner(repo), scoped);
    }
    if (url.pathname === '/user/keys') {
      if (!/public_key/.test(state.scopes)) return json(404, { message: 'Not Found' });
      if (req.method === 'GET') return json(200, state.keys.map((key, i) => ({ id: i + 1, key })), scoped);
      if (req.method === 'POST') {
        const body = JSON.parse(raw);
        state.keyPosts.push(body);
        if (state.keyPostStatus !== 201) return json(state.keyPostStatus, { message: 'Validation Failed', errors: [{ message: 'key is already in use' }] });
        state.keys.push(body.key.split(' ').slice(0, 2).join(' '));
        return json(201, { id: state.keys.length, key: body.key, title: body.title }, scoped);
      }
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { state, url: base, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

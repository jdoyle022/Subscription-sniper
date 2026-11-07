'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setup, ADMIN, AGENT } = require('./helpers');

async function serve(ctx) {
  const server = http.createServer(ctx.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { call, close: () => server.close() };
}

test('auth: no token 401, agent token cannot use admin routes', async (t) => {
  const s = await serve(setup());
  t.after(s.close);
  assert.equal((await s.call('GET', '/api/account')).status, 401);
  assert.equal((await s.call('GET', '/api/account', { token: 'wrong' })).status, 401);
  assert.equal((await s.call('GET', '/api/account', { token: AGENT })).status, 403);
  assert.equal((await s.call('POST', '/api/orders', { token: AGENT, body: { symbol: 'MSFT', side: 'buy', qty: 1 } })).status, 403);
  assert.equal((await s.call('GET', '/api/account', { token: ADMIN })).status, 200);
});

test('external agent proposes; only the human can approve', async (t) => {
  const ctx = setup();
  const s = await serve(ctx);
  t.after(s.close);
  const r = await s.call('POST', '/api/agent/tools/propose_order', {
    token: AGENT, body: { symbol: 'MSFT', side: 'buy', qty: 1, rationale: 'momentum' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const id = r.json.result.proposal_id;
  assert.equal(ctx.desk.getProposal(id).agent, 'grok');
  assert.equal(ctx.alpaca.submitted.length, 0);

  assert.equal((await s.call('POST', `/api/proposals/${id}/approve`, { token: AGENT })).status, 403);
  const own = await s.call('GET', `/api/agent/proposals/${id}`, { token: AGENT });
  assert.equal(own.json.status, 'pending');

  const ap = await s.call('POST', `/api/proposals/${id}/approve`, { token: ADMIN });
  assert.equal(ap.status, 200);
  assert.equal(ctx.alpaca.submitted.length, 1);
});

test('human order: preview, blocked, accepted', async (t) => {
  const ctx = setup();
  const s = await serve(ctx);
  t.after(s.close);
  const pv = await s.call('POST', '/api/orders/preview', { token: ADMIN, body: { symbol: 'MSFT', side: 'buy', qty: 1 } });
  assert.equal(pv.json.risk.ok, true);
  const blocked = await s.call('POST', '/api/orders', { token: ADMIN, body: { symbol: 'MSFT', side: 'buy', qty: 50 } });
  assert.equal(blocked.status, 422);
  assert.ok(blocked.json.details.reasons.length);
  const bad = await s.call('POST', '/api/orders', { token: ADMIN, body: { symbol: 'MSFT', side: 'buy' } });
  assert.equal(bad.status, 400);
  const ok = await s.call('POST', '/api/orders', { token: ADMIN, body: { symbol: 'MSFT', side: 'buy', qty: 1 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'accepted');
  const audit = await s.call('GET', '/api/audit', { token: ADMIN });
  assert.ok(audit.json.some((e) => e.event === 'order.blocked'));
  assert.ok(audit.json.some((e) => e.event === 'order.accepted'));
});

test('crypto symbols in the path, static UI with CSP, openapi', async (t) => {
  const s = await serve(setup({ env: { PUBLIC_URL: 'https://desk.example.com' } }));
  t.after(s.close);
  const q = await s.call('GET', `/api/quote/${encodeURIComponent('BTC/USD')}`, { token: ADMIN });
  assert.equal(q.json.symbol, 'BTC/USD');
  const page = await s.call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await s.call('GET', '/../src/config.js')).status, 404);
  const spec = await s.call('GET', '/openapi.json');
  assert.equal(spec.json.servers[0].url, 'https://desk.example.com');
  assert.ok(spec.json.paths['/api/agent/tools/propose_order']);
});

test('AI chat route uses configured seats', async (t) => {
  const stub = { model: 'stub', run: async ({ runTool }) => {
    const r = await runTool('propose_order', { symbol: 'MSFT', side: 'buy', qty: 1, rationale: 'x' }, { agent: 'claude' });
    return { text: 'ok', trace: [{ name: 'propose_order', ok: r.ok, result: r.result }] };
  } };
  const ctx = setup({ agents: { claude: stub } });
  const s = await serve(ctx);
  t.after(s.close);
  const r = await s.call('POST', '/api/ai/chat', { token: ADMIN, body: { provider: 'claude', message: 'go' } });
  assert.equal(r.status, 200);
  assert.equal(r.json[0].proposals.length, 1);
  assert.equal((await s.call('POST', '/api/ai/chat', { token: ADMIN, body: { provider: 'grok', message: 'go' } })).status, 400);
});

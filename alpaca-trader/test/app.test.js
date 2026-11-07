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

test('options: expirations (paginated), chain, contracts, exercise, asset search', async (t) => {
  const ctx = setup();
  const s = await serve(ctx);
  t.after(s.close);
  const exps = await s.call('GET', '/api/options/expirations/spy', { token: ADMIN });
  assert.deepEqual(exps.json, ['2026-12-18', '2027-01-15']);
  const chain = await s.call('GET', '/api/options/chain/SPY?expiration_date=2026-12-18&strike_price_gte=450', { token: ADMIN });
  assert.equal(chain.json.length, 2);
  assert.deepEqual(chain.json.map((r) => r.type), ['put', 'call']); // sorted by strike
  assert.equal(chain.json[1].delta, 0.52);
  assert.equal(ctx.alpaca.lastChainQuery.strike_price_gte, '450');
  const contracts = await s.call('GET', '/api/options/contracts?underlying=SPY&type=call', { token: ADMIN });
  assert.equal(contracts.json[0].symbol, 'SPY261218C00500000');
  assert.equal(ctx.alpaca.lastContractQuery.type, 'call');

  assert.equal((await s.call('POST', '/api/positions/AAPL/exercise', { token: ADMIN })).status, 400);
  assert.equal((await s.call('POST', '/api/positions/SPY261218C00500000/exercise', { token: AGENT })).status, 403);
  assert.equal((await s.call('POST', '/api/positions/SPY261218C00500000/exercise', { token: ADMIN })).status, 200);
  assert.deepEqual(ctx.alpaca.exercised, ['SPY261218C00500000']);

  const assets = await s.call('GET', '/api/assets?q=apple', { token: ADMIN });
  assert.deepEqual(assets.json.map((a) => a.symbol), ['AAPL']); // non-tradable filtered out
});

test('agent proposes a multi-leg spread; human approves; it executes as mleg', async (t) => {
  const ctx = setup();
  const s = await serve(ctx);
  t.after(s.close);
  const r = await s.call('POST', '/api/agent/tools/propose_order', {
    token: AGENT,
    body: {
      order_class: 'mleg', qty: 1, type: 'limit', limit_price: -3,
      legs: [{ symbol: 'SPY261218P00490000', side: 'sell', ratio_qty: 1 }, { symbol: 'SPY261218P00480000', side: 'buy', ratio_qty: 1 }],
      rationale: 'Bull put spread; max loss $700.',
    },
  });
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.result.risk_preview.ok, true, JSON.stringify(r.json.result.risk_preview));
  assert.match(r.json.result.summary, /STRATEGY x1/);
  const ap = await s.call('POST', `/api/proposals/${r.json.result.proposal_id}/approve`, { token: ADMIN });
  assert.equal(ap.status, 200);
  const sent = ctx.alpaca.submitted[0];
  assert.equal(sent.order_class, 'mleg');
  assert.equal(sent.legs.length, 2);
  assert.equal(sent.symbol, undefined);
});

test('Alpaca Connect: start issues state, callback exchanges code once', async (t) => {
  const { AlpacaConnect } = require('../src/oauth');
  const tokenCalls = [];
  const ctx0 = setup({ env: { ALPACA_OAUTH_CLIENT_ID: 'cid', ALPACA_OAUTH_CLIENT_SECRET: 'csecret' } });
  const connect = new AlpacaConnect(
    { oauth: ctx0.config.oauth, mode: 'paper', dataDir: ctx0.config.dataDir },
    ctx0.alpaca,
    ctx0.store,
    async (url, opts) => {
      tokenCalls.push({ url: String(url), body: new URLSearchParams(opts.body) });
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-123', token_type: 'bearer', scope: 'account:write trading data' }) };
    },
  );
  const { build } = require('../src/server');
  const ctx = build(ctx0.config, { alpaca: ctx0.alpaca, store: ctx0.store, connect });
  const s = await serve(ctx);
  t.after(s.close);

  const st = await s.call('GET', '/api/oauth/start', { token: ADMIN });
  const url = new URL(st.json.url);
  assert.equal(url.origin + url.pathname, 'https://app.alpaca.markets/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('env'), 'paper');
  assert.equal(url.searchParams.get('response_type'), 'code');
  const state = url.searchParams.get('state');

  assert.equal((await s.call('GET', '/oauth/callback?code=abc&state=forged')).status, 400);
  assert.equal(tokenCalls.length, 0);
  const cb = await s.call('GET', `/oauth/callback?code=abc&state=${state}`);
  assert.equal(cb.status, 200);
  assert.match(cb.text, /Connected/);
  assert.equal(tokenCalls[0].body.get('grant_type'), 'authorization_code');
  assert.equal(tokenCalls[0].body.get('client_secret'), 'csecret');
  assert.equal(ctx0.alpaca.oauthToken, 'tok-123');
  // state is single-use
  assert.equal((await s.call('GET', `/oauth/callback?code=abc&state=${state}`)).status, 400);

  const status = await s.call('GET', '/api/status', { token: ADMIN });
  assert.equal(status.json.connect.connected, true);
  assert.equal(status.json.authMethod, 'oauth');
  const fs = require('node:fs');
  const file = require('node:path').join(ctx0.config.dataDir, 'oauth.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // A paper token is not loaded in live mode.
  const live = new AlpacaConnect({ oauth: ctx0.config.oauth, mode: 'live', dataDir: ctx0.config.dataDir }, { setOAuthToken() { throw new Error('must not load'); } }, ctx0.store);
  assert.equal(live.status.connected, false);

  await s.call('POST', '/api/oauth/disconnect', { token: ADMIN });
  assert.equal(ctx0.alpaca.oauthToken, '');
  assert.equal(fs.existsSync(file), false);
});

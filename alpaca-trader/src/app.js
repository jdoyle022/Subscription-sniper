'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeOrder } = require('./orders');
const { TOOLS, makeToolRunner } = require('./tools');
const { runAgents } = require('./agents');
const { AlpacaError } = require('./alpaca');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Simple fixed-window limiter for failed auth attempts per IP.
function makeAuthLimiter(maxFailures = 20, windowMs = 60_000) {
  const hits = new Map();
  return {
    blocked(ip) {
      const h = hits.get(ip);
      return Boolean(h && Date.now() - h.start < windowMs && h.count >= maxFailures);
    },
    fail(ip) {
      const now = Date.now();
      const h = hits.get(ip);
      if (!h || now - h.start >= windowMs) hits.set(ip, { start: now, count: 1 });
      else h.count++;
      if (hits.size > 10_000) hits.clear();
    },
  };
}

function openApiSpec(publicUrl) {
  const paths = {};
  for (const t of TOOLS) {
    paths[`/api/agent/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.slice(0, 300),
        requestBody: {
          required: false,
          content: { 'application/json': { schema: t.input_schema } },
        },
        responses: {
          200: {
            description: 'Tool result',
            content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, result: {}, error: { type: 'string' } } } } },
          },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Alpaca Trader Agent API',
      version: '1.0.0',
      description:
        'Read account and market data and submit order proposals for human approval. Agents cannot execute trades.',
    },
    servers: [{ url: publicUrl || 'http://127.0.0.1:8787' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearer: [] }],
    paths,
  };
}

function createApp({ config, alpaca, store, desk, agents }) {
  const runTool = makeToolRunner({ alpaca, desk, config });
  const limiter = makeAuthLimiter();

  function authenticate(req) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header);
    if (!m) return null;
    const token = m[1].trim();
    if (safeEqual(token, config.adminToken)) return { role: 'admin', name: 'human' };
    for (const [agentToken, name] of config.agentTokens) {
      if (safeEqual(token, agentToken)) return { role: 'agent', name };
    }
    return null;
  }

  const routes = [];
  const route = (method, pattern, role, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, re, keys, role, handler });
  };

  // ---------- Admin (human) API ----------
  route('GET', '/api/status', 'admin', async () => ({
    mode: config.alpaca.mode,
    alpacaConfigured: alpaca.configured,
    killSwitch: store.state.killSwitch,
    aiAutoExecute: config.ai.autoExecute,
    providers: Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, a.model])),
    externalAgents: [...new Set(config.agentTokens.values())],
    limits: config.risk,
    ordersToday: desk.risk.ordersToday(),
    pendingProposals: desk.listProposals({ status: 'pending' }).length,
  }));
  route('GET', '/api/account', 'admin', () => alpaca.getAccount());
  route('GET', '/api/clock', 'admin', () => alpaca.getClock());
  route('GET', '/api/positions', 'admin', () => alpaca.getPositions());
  route('GET', '/api/orders', 'admin', (ctx) =>
    alpaca.listOrders({ status: ctx.query.get('status') || 'open', limit: ctx.query.get('limit') || 100 }),
  );
  route('GET', '/api/portfolio-history', 'admin', (ctx) =>
    alpaca.getPortfolioHistory({
      period: ctx.query.get('period') || '1M',
      timeframe: ctx.query.get('timeframe') || '1D',
    }),
  );
  route('GET', '/api/activities', 'admin', (ctx) =>
    alpaca.getActivities({ activity_types: ctx.query.get('types') || 'FILL', page_size: 50 }),
  );
  route('GET', '/api/quote/:symbol', 'admin', (ctx) => alpaca.getSnapshot(ctx.params.symbol.toUpperCase()));
  route('GET', '/api/bars/:symbol', 'admin', async (ctx) => {
    const r = await runTool(
      'get_bars',
      { symbol: ctx.params.symbol, timeframe: ctx.query.get('timeframe') || '1Day', limit: Number(ctx.query.get('limit')) || 90 },
      {},
    );
    if (!r.ok) throw Object.assign(new Error(r.error), { status: 502 });
    return r.result;
  });
  route('GET', '/api/asset/:symbol', 'admin', (ctx) => alpaca.getAsset(ctx.params.symbol.toUpperCase()));

  route('POST', '/api/orders/preview', 'admin', async (ctx) => {
    const order = normalizeOrder(ctx.body);
    return { order, risk: await desk.risk.check(order) };
  });
  route('POST', '/api/orders', 'admin', (ctx) => desk.placeOrder(ctx.body, { actor: 'human' }));
  route('PATCH', '/api/orders/:id', 'admin', (ctx) => desk.replaceOrder(ctx.params.id, ctx.body, { actor: 'human' }));
  route('DELETE', '/api/orders/:id', 'admin', (ctx) => desk.cancelOrder(ctx.params.id, { actor: 'human' }));
  route('DELETE', '/api/orders', 'admin', () => desk.cancelAllOrders({ actor: 'human' }));
  route('DELETE', '/api/positions/:symbol', 'admin', (ctx) =>
    desk.closePosition(
      ctx.params.symbol.toUpperCase(),
      { qty: ctx.query.get('qty') || undefined, percentage: ctx.query.get('percentage') || undefined },
      { actor: 'human' },
    ),
  );
  route('DELETE', '/api/positions', 'admin', () => desk.closeAllPositions({ actor: 'human' }));
  route('POST', '/api/killswitch', 'admin', (ctx) => desk.setKillSwitch(Boolean(ctx.body.on), { actor: 'human' }));

  route('GET', '/api/proposals', 'admin', (ctx) => desk.listProposals({ status: ctx.query.get('status') || undefined }));
  route('POST', '/api/proposals/:id/approve', 'admin', (ctx) => desk.approveProposal(ctx.params.id, { actor: 'human' }));
  route('POST', '/api/proposals/:id/reject', 'admin', (ctx) =>
    desk.rejectProposal(ctx.params.id, { actor: 'human', reason: ctx.body.reason }),
  );

  route('POST', '/api/ai/chat', 'admin', async (ctx) => {
    const { provider, message, history } = ctx.body;
    if (typeof message !== 'string' || !message.trim()) {
      throw Object.assign(new Error('message is required'), { status: 400 });
    }
    return runAgents({
      agents,
      provider: provider || 'claude',
      message: message.slice(0, 8000),
      history,
      runTool,
      mode: config.alpaca.mode,
      maxIterations: config.ai.maxToolIterations,
      audit: (e, d) => store.audit(e, d),
    });
  });

  route('GET', '/api/audit', 'admin', (ctx) => store.readAudit(Math.min(Number(ctx.query.get('limit')) || 200, 1000)));

  // ---------- External agent API (ChatGPT Actions, Grok bots, MCP bridge, scripts) ----------
  route('GET', '/api/agent/tools', 'agent', () =>
    TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
  );
  route('POST', '/api/agent/tools/:name', 'agent', async (ctx) => {
    const out = await runTool(ctx.params.name, ctx.body, { agent: ctx.user.name });
    store.audit('agent.tool', { agent: ctx.user.name, tool: ctx.params.name, ok: out.ok });
    return out;
  });
  route('GET', '/api/agent/proposals/:id', 'agent', (ctx) => {
    const p = desk.getProposal(ctx.params.id);
    if (!p || p.agent !== ctx.user.name) throw Object.assign(new Error('Proposal not found'), { status: 404 });
    return { id: p.id, status: p.status, summary: p.summary, orderId: p.orderId, error: p.error };
  });

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !STATIC_TYPES[path.extname(file)]) return false;
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': `${STATIC_TYPES[path.extname(file)]}; charset=utf-8`,
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-cache',
    });
    res.end(content);
    return true;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const ip = req.socket.remoteAddress || 'unknown';

    try {
      if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
      if (req.method === 'GET' && pathname === '/openapi.json') return send(res, 200, openApiSpec(config.publicUrl));

      if (!pathname.startsWith('/api/')) {
        if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
        return send(res, 404, { error: 'Not found' });
      }

      const matches = routes.filter((r) => r.re.test(pathname));
      if (!matches.length) return send(res, 404, { error: 'Not found' });
      const r = matches.find((m) => m.method === req.method);
      if (!r) return send(res, 405, { error: 'Method not allowed' });

      if (limiter.blocked(ip)) return send(res, 429, { error: 'Too many failed auth attempts' });
      const user = authenticate(req);
      if (!user) {
        limiter.fail(ip);
        return send(res, 401, { error: 'Unauthorized' });
      }
      // Admin may call everything; agent tokens may call only /api/agent/*.
      if (r.role === 'admin' && user.role !== 'admin') return send(res, 403, { error: 'Forbidden' });

      const m = r.re.exec(pathname);
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({ params, query: url.searchParams, body, user });
      return send(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
      const isAlpaca = err instanceof AlpacaError;
      const payload = { error: err.message || 'Internal error' };
      if (err.details) payload.details = err.details;
      if (status >= 500 && !isAlpaca) console.error(err);
      return send(res, isAlpaca && status >= 500 ? 502 : status, payload);
    }
  };
}

module.exports = { createApp, openApiSpec };

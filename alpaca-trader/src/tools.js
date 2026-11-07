'use strict';

// One tool catalogue shared by every AI integration: the in-app Claude/ChatGPT/Grok loops,
// the MCP server, and the external agent HTTP API (ChatGPT Actions, Grok bots, scripts).
// Tools are read-only except propose_order, which only queues a proposal for human approval.

const { parseOcc } = require('./alpaca');

const symbolProp = {
  type: 'string',
  description: 'Stock/ETF ticker (AAPL), crypto pair (BTC/USD), or OCC option symbol (AAPL260116C00200000)',
};

const legSchema = {
  type: 'object',
  properties: {
    symbol: { type: 'string', description: 'OCC option symbol (or the underlying stock for a stock leg)' },
    ratio_qty: { type: 'integer', minimum: 1, description: 'Units of this leg per 1 strategy qty' },
    side: { type: 'string', enum: ['buy', 'sell'] },
    position_intent: { type: 'string', enum: ['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'] },
  },
  required: ['symbol', 'side'],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'get_account',
    description: 'Get account equity, cash, buying power, trading mode (paper/live) and status.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_positions',
    description: 'List open positions with quantity, cost basis, market value and unrealized P/L.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_orders',
    description: 'List orders. status is open, closed or all.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_quote',
    description: 'Get the latest snapshot (quote, last trade, daily bar) for a symbol.',
    input_schema: {
      type: 'object',
      properties: { symbol: symbolProp },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_bars',
    description: 'Get historical OHLCV bars for a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        timeframe: { type: 'string', description: 'e.g. 1Min, 5Min, 15Min, 1Hour, 1Day, 1Week' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
        start: { type: 'string', description: 'RFC3339 or YYYY-MM-DD start date' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_assets',
    description:
      'Find tradable assets. asset_class is us_equity (stocks/ETFs) or crypto. query matches symbol or name. ' +
      'For options use get_option_contracts or get_option_chain.',
    input_schema: {
      type: 'object',
      properties: {
        asset_class: { type: 'string', enum: ['us_equity', 'crypto'] },
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_option_contracts',
    description:
      'List option contracts for an underlying: OCC symbol, expiration, strike, type, open interest, close price. ' +
      'Use it to find expirations and strikes.',
    input_schema: {
      type: 'object',
      properties: {
        underlying: { type: 'string', description: 'e.g. SPY' },
        type: { type: 'string', enum: ['call', 'put'] },
        expiration_date: { type: 'string', description: 'YYYY-MM-DD' },
        expiration_date_gte: { type: 'string' },
        expiration_date_lte: { type: 'string' },
        strike_price_gte: { type: 'number' },
        strike_price_lte: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['underlying'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_option_chain',
    description:
      'Option chain with live quotes, implied volatility and greeks (delta, gamma, theta, vega, rho) for an underlying. ' +
      'Filter tightly by expiration and strike range; results are capped.',
    input_schema: {
      type: 'object',
      properties: {
        underlying: { type: 'string' },
        type: { type: 'string', enum: ['call', 'put'] },
        expiration_date: { type: 'string', description: 'YYYY-MM-DD' },
        expiration_date_gte: { type: 'string' },
        expiration_date_lte: { type: 'string' },
        strike_price_gte: { type: 'number' },
        strike_price_lte: { type: 'number' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max contracts returned (default 40)' },
      },
      required: ['underlying'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_clock',
    description: 'Is the US equity market open, and when are the next open and close.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_asset',
    description: 'Check whether a symbol is tradable, fractionable and shortable.',
    input_schema: {
      type: 'object',
      properties: { symbol: symbolProp },
      required: ['symbol'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_risk_limits',
    description: 'Get the desk risk limits every order must pass, and whether the kill switch is on.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'propose_order',
    description:
      'Queue an order PROPOSAL for the human trader to approve or reject. This does not place a trade. ' +
      'Works for stocks/ETFs, crypto, single options (OCC symbol, whole-contract qty) and multi-leg option ' +
      'strategies (order_class "mleg" with 2-4 legs, e.g. spreads, straddles, condors, collars). ' +
      'For mleg: omit symbol and side, set qty (number of strategy units), legs, and for limit orders the net ' +
      'limit_price per unit. Include a rationale with thesis, max loss, exit plan and what would prove it wrong.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] },
        qty: { type: 'number', description: 'Shares, coins, option contracts, or strategy units (mleg)' },
        notional: { type: 'number', description: 'Dollar amount (stock/crypto market orders only)' },
        time_in_force: { type: 'string', enum: ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'] },
        limit_price: { type: 'number', description: 'For mleg this is the net price per strategy unit' },
        stop_price: { type: 'number' },
        trail_percent: { type: 'number' },
        trail_price: { type: 'number' },
        order_class: { type: 'string', enum: ['simple', 'bracket', 'oco', 'oto', 'mleg'] },
        position_intent: {
          type: 'string',
          enum: ['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'],
          description: 'Options only',
        },
        legs: { type: 'array', items: legSchema, minItems: 2, maxItems: 4, description: 'mleg only' },
        take_profit_limit_price: { type: 'number', description: 'Stock bracket/oco/oto only' },
        stop_loss_stop_price: { type: 'number', description: 'Stock bracket/oco/oto only' },
        rationale: { type: 'string', description: 'Why this trade, the max loss, and what would invalidate it' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['rationale'],
      additionalProperties: false,
    },
  },
];

const trimPosition = (p) => ({
  symbol: p.symbol,
  asset_class: p.asset_class,
  qty: p.qty,
  side: p.side,
  avg_entry_price: p.avg_entry_price,
  current_price: p.current_price,
  market_value: p.market_value,
  unrealized_pl: p.unrealized_pl,
  unrealized_plpc: p.unrealized_plpc,
});

const trimOrder = (o) => ({
  id: o.id,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  qty: o.qty,
  notional: o.notional,
  filled_qty: o.filled_qty,
  filled_avg_price: o.filled_avg_price,
  limit_price: o.limit_price,
  stop_price: o.stop_price,
  status: o.status,
  time_in_force: o.time_in_force,
  order_class: o.order_class,
  submitted_at: o.submitted_at,
  legs: o.legs ? o.legs.map((l) => ({ symbol: l.symbol, side: l.side, ratio_qty: l.ratio_qty, status: l.status })) : undefined,
});

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function trimChainEntry(symbol, snap) {
  const occ = parseOcc(symbol) || {};
  const q = snap.latestQuote || {};
  const t = snap.latestTrade || {};
  const g = snap.greeks || {};
  return {
    symbol,
    type: occ.type,
    expiration: occ.expiration,
    strike: occ.strike,
    bid: q.bp,
    ask: q.ap,
    last: t.p,
    iv: snap.impliedVolatility,
    delta: g.delta,
    gamma: g.gamma,
    theta: g.theta,
    vega: g.vega,
  };
}

function contractQuery(input) {
  return {
    underlying_symbols: String(input.underlying || '').toUpperCase(),
    type: input.type,
    expiration_date: input.expiration_date,
    expiration_date_gte: input.expiration_date_gte,
    expiration_date_lte: input.expiration_date_lte,
    strike_price_gte: num(input.strike_price_gte),
    strike_price_lte: num(input.strike_price_lte),
  };
}

function makeToolRunner({ alpaca, desk, config }) {
  const handlers = {
    async get_account() {
      const a = await alpaca.getAccount();
      return {
        mode: config.alpaca.mode,
        equity: a.equity,
        last_equity: a.last_equity,
        cash: a.cash,
        buying_power: a.buying_power,
        long_market_value: a.long_market_value,
        short_market_value: a.short_market_value,
        pattern_day_trader: a.pattern_day_trader,
        daytrade_count: a.daytrade_count,
        trading_blocked: a.trading_blocked,
        status: a.status,
        options_trading_level: a.options_trading_level,
        options_approved_level: a.options_approved_level,
        options_buying_power: a.options_buying_power,
        crypto_status: a.crypto_status,
        shorting_enabled: a.shorting_enabled,
      };
    },
    async get_positions() {
      return (await alpaca.getPositions()).map(trimPosition);
    },
    async get_orders({ status = 'open', limit = 50 }) {
      return (await alpaca.listOrders({ status, limit })).map(trimOrder);
    },
    async get_quote({ symbol }) {
      return alpaca.getSnapshot(String(symbol).toUpperCase());
    },
    async get_bars({ symbol, timeframe = '1Day', limit = 60, start }) {
      const bars = await alpaca.getBars(String(symbol).toUpperCase(), {
        timeframe,
        limit: Math.min(Number(limit) || 60, 500),
        start: start || defaultStart(timeframe, limit),
      });
      return bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    },
    async search_assets({ asset_class = 'us_equity', query = '', limit = 25 }) {
      const assets = await alpaca.listAssets({ asset_class });
      const q = String(query).trim().toUpperCase();
      const hits = assets
        .filter((a) => a.tradable)
        .filter((a) => !q || a.symbol.toUpperCase().includes(q) || String(a.name || '').toUpperCase().includes(q))
        .sort((a, b) => (a.symbol.toUpperCase() === q ? -1 : b.symbol.toUpperCase() === q ? 1 : a.symbol.length - b.symbol.length));
      return hits.slice(0, Math.min(Number(limit) || 25, 100)).map((a) => ({
        symbol: a.symbol, name: a.name, class: a.class, exchange: a.exchange,
        fractionable: a.fractionable, shortable: a.shortable, attributes: a.attributes,
      }));
    },
    async get_option_contracts(input) {
      if (!input.underlying) throw new Error('underlying is required');
      const d = await alpaca.listOptionContracts({ ...contractQuery(input), limit: Math.min(Number(input.limit) || 50, 200) });
      return (d.option_contracts || []).map((c) => ({
        symbol: c.symbol, type: c.type, style: c.style, expiration_date: c.expiration_date, strike_price: c.strike_price,
        multiplier: c.multiplier || c.size, open_interest: c.open_interest, close_price: c.close_price, tradable: c.tradable,
      }));
    },
    async get_option_chain(input) {
      if (!input.underlying) throw new Error('underlying is required');
      const { underlying_symbols: underlying, ...query } = contractQuery(input);
      const chain = await alpaca.getOptionChain(underlying, query, { maxPages: 3 });
      const rows = Object.entries(chain).map(([sym, snap]) => trimChainEntry(sym, snap));
      rows.sort((a, b) => (a.expiration || '').localeCompare(b.expiration || '') || a.strike - b.strike || (a.type || '').localeCompare(b.type || ''));
      const cap = Math.min(Number(input.limit) || 40, 100);
      return { underlying, total: rows.length, returned: Math.min(cap, rows.length), contracts: rows.slice(0, cap) };
    },
    async get_clock() {
      return alpaca.getClock();
    },
    async get_asset({ symbol }) {
      const a = await alpaca.getAsset(String(symbol).toUpperCase());
      return {
        symbol: a.symbol,
        name: a.name,
        class: a.class,
        exchange: a.exchange,
        tradable: a.tradable,
        fractionable: a.fractionable,
        shortable: a.shortable,
        easy_to_borrow: a.easy_to_borrow,
      };
    },
    async get_risk_limits() {
      const r = config.risk;
      return {
        mode: config.alpaca.mode,
        kill_switch: desk.store.state.killSwitch,
        max_order_notional: r.maxOrderNotional,
        max_position_pct_of_equity: r.maxPositionPct,
        max_daily_orders: r.maxDailyOrders,
        orders_today: desk.risk.ordersToday(),
        shorting_allowed: r.allowShort,
        options_enabled: r.optionsEnabled,
        naked_short_options_allowed: r.allowShortOptions,
        sizing_note: 'Options are sized by premium x 100 per contract; short puts by strike x 100; spreads by the larger of premium and strike width.',
        allowlist: r.allowlist,
        denylist: r.denylist,
        ai_auto_execute: config.ai.autoExecute,
      };
    },
    async propose_order(input, { agent }) {
      const { rationale, confidence, take_profit_limit_price, stop_loss_stop_price, ...rest } = input;
      const order = { ...rest };
      if (take_profit_limit_price) order.take_profit = { limit_price: take_profit_limit_price };
      if (stop_loss_stop_price) order.stop_loss = { stop_price: stop_loss_stop_price };
      const p = await desk.createProposal({ agent, order, rationale, confidence });
      return {
        proposal_id: p.id,
        status: p.status,
        summary: p.summary,
        risk_preview: p.riskPreview,
        note:
          p.status === 'pending'
            ? 'Queued for human approval. It has NOT been executed.'
            : `Proposal status: ${p.status}`,
      };
    },
  };

  // Returns { ok, result } or { ok:false, error } — never throws, so model loops can recover.
  return async function runTool(name, input, ctx) {
    if (!Object.hasOwn(handlers, name)) return { ok: false, error: `Unknown tool: ${name}` };
    const handler = handlers[name];
    try {
      const result = await handler(input || {}, ctx);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  };
}

function defaultStart(timeframe, limit) {
  const n = Math.min(Number(limit) || 60, 500);
  const perBarMs = /Min/.test(timeframe)
    ? 60_000 * (parseInt(timeframe, 10) || 1)
    : /Hour/.test(timeframe)
      ? 3_600_000 * (parseInt(timeframe, 10) || 1)
      : /Week/.test(timeframe)
        ? 7 * 86_400_000
        : 86_400_000;
  // Pad for weekends/holidays/after-hours gaps.
  return new Date(Date.now() - n * perBarMs * 3).toISOString();
}

module.exports = { TOOLS, makeToolRunner, trimChainEntry };

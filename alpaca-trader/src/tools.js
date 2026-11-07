'use strict';

// One tool catalogue shared by every AI integration: the in-app Claude/ChatGPT/Grok loops,
// the MCP server, and the external agent HTTP API (ChatGPT Actions, Grok bots, scripts).
// Tools are read-only except propose_order, which only queues a proposal for human approval.

const symbolProp = {
  type: 'string',
  description: 'Ticker such as AAPL, or a crypto pair such as BTC/USD',
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
      'Provide exactly one of qty or notional. Include a clear rationale and the risk you see.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: symbolProp,
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'] },
        qty: { type: 'number', description: 'Share/coin quantity' },
        notional: { type: 'number', description: 'Dollar amount (market, day orders only)' },
        time_in_force: { type: 'string', enum: ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'] },
        limit_price: { type: 'number' },
        stop_price: { type: 'number' },
        trail_percent: { type: 'number' },
        trail_price: { type: 'number' },
        order_class: { type: 'string', enum: ['simple', 'bracket', 'oco', 'oto'] },
        take_profit_limit_price: { type: 'number', description: 'For bracket/oco/oto' },
        stop_loss_stop_price: { type: 'number', description: 'For bracket/oco/oto' },
        rationale: { type: 'string', description: 'Why this trade, and what would invalidate it' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['symbol', 'side', 'rationale'],
      additionalProperties: false,
    },
  },
];

const trimPosition = (p) => ({
  symbol: p.symbol,
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
});

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

module.exports = { TOOLS, makeToolRunner };

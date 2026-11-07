'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store');
const { loadConfig } = require('../src/config');
const { build } = require('../src/server');

class FakeAlpaca {
  constructor() {
    this.configured = true;
    this.account = { equity: '10000', last_equity: '9900', cash: '5000', buying_power: '10000', status: 'ACTIVE', options_trading_level: 3 };
    this.oauthToken = '';
    this.exercised = [];
    this.positions = { AAPL: { symbol: 'AAPL', qty: '5', market_value: '1000', avg_entry_price: '190' } };
    this.prices = {
      AAPL: 200, MSFT: 400, 'BTC/USD': 60000, SPY: 500,
      SPY261218C00500000: 20, SPY261218C00510000: 15, SPY261218P00490000: 12, SPY261218P00480000: 9,
      AAPL261218C00220000: 5, AAPL261218P00180000: 4,
    };
    this.submitted = [];
    this.cancelled = [];
  }
  async getAccount() { return this.account; }
  async getClock() { return { is_open: true, next_close: new Date().toISOString() }; }
  async getPositions() { return Object.values(this.positions); }
  async getPosition(sym) { return this.positions[sym.replace('/', '')] || null; }
  async getReferencePrice(sym) { return this.prices[sym] ?? null; }
  async getSnapshot(sym) { return { symbol: sym, latestTrade: { p: this.prices[sym] } }; }
  async getBars() { return [{ t: '2026-11-06', o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }]; }
  async getAsset(sym) { return { symbol: sym, tradable: true }; }
  setOAuthToken(t) { this.oauthToken = t || ''; }
  get authMethod() { return this.oauthToken ? 'oauth' : 'api_key'; }
  async listAssets() {
    return [
      { symbol: 'AAPL', name: 'Apple Inc.', tradable: true, class: 'us_equity' },
      { symbol: 'AAPLX', name: 'Something', tradable: true, class: 'us_equity' },
      { symbol: 'DEAD', name: 'Apple delisted', tradable: false, class: 'us_equity' },
    ];
  }
  async listOptionContracts(q) {
    this.lastContractQuery = q;
    if (!q.page_token) {
      return { option_contracts: [{ symbol: 'SPY261218C00500000', expiration_date: '2026-12-18', strike_price: '500', type: 'call' }], next_page_token: 'p2' };
    }
    return { option_contracts: [{ symbol: 'SPY270115C00500000', expiration_date: '2027-01-15', strike_price: '500', type: 'call' }] };
  }
  async getOptionChain(underlying, q) {
    this.lastChainQuery = q;
    return {
      SPY261218P00490000: { latestQuote: { bp: 11.9, ap: 12.1 }, greeks: { delta: -0.4 }, impliedVolatility: 0.18 },
      SPY261218C00500000: { latestQuote: { bp: 19.9, ap: 20.1 }, latestTrade: { p: 20 }, greeks: { delta: 0.52 }, impliedVolatility: 0.17 },
    };
  }
  async exerciseOption(sym) { this.exercised.push(sym); return {}; }
  async listOrders() { return this.submitted; }
  async submitOrder(o) {
    if (this.submitted.some((s) => s.client_order_id === o.client_order_id)) {
      const e = new Error('client_order_id must be unique'); e.status = 422; throw e;
    }
    const r = { id: `ord-${this.submitted.length + 1}`, status: 'accepted', ...o };
    this.submitted.push(r);
    return r;
  }
  async getOrder(id) { return this.submitted.find((o) => o.id === id); }
  async replaceOrder(id, patch) { return { ...(await this.getOrder(id)), ...patch, id: `${id}-r` }; }
  async cancelOrder(id) { this.cancelled.push(id); }
  async cancelAllOrders() { return []; }
  async closePosition() { return {}; }
  async closeAllPositions() { return []; }
}

const ADMIN = 'a'.repeat(32);
const AGENT = 'g'.repeat(32);

function makeEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpaca-trader-test-'));
  return {
    ADMIN_TOKEN: ADMIN,
    AGENT_TOKENS: `grok:${AGENT}`,
    DATA_DIR: dataDir,
    MAX_ORDER_NOTIONAL: '2000',
    MAX_POSITION_PCT: '25',
    MAX_DAILY_ORDERS: '10',
    ...extra,
  };
}

function setup({ env = {}, agents } = {}) {
  const config = loadConfig(makeEnv(env));
  const alpaca = new FakeAlpaca();
  const store = new Store(config.dataDir);
  const built = build(config, { alpaca, store, agents });
  return { config, ...built };
}

module.exports = { FakeAlpaca, setup, makeEnv, ADMIN, AGENT };

'use strict';

// Thin REST client for Alpaca's Trading API v2 and Market Data API, covering every asset class
// the Trading API trades: US equities/ETFs, crypto, and US options (single-leg and multi-leg).
// Authenticates with API keys, or with an OAuth access token from Alpaca Connect.

class AlpacaError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'AlpacaError';
    this.status = status;
    this.body = body;
  }
}

// OCC option symbol: ROOT (1-6 chars) + YYMMDD + C/P + strike*1000 (8 digits), e.g. AAPL250117C00150000
const OCC_RE = /^([A-Z]{1,6}\d?)(\d{6})([CP])(\d{8})$/;
const isCrypto = (symbol) => String(symbol).includes('/');
const isOption = (symbol) => OCC_RE.test(String(symbol));

function parseOcc(symbol) {
  const m = OCC_RE.exec(String(symbol));
  if (!m) return null;
  const [, root, ymd, cp, strike] = m;
  return {
    root: root.replace(/\d$/, ''),
    expiration: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strike) / 1000,
  };
}

function assetClassOf(symbol) {
  if (isOption(symbol)) return 'us_option';
  if (isCrypto(symbol)) return 'crypto';
  return 'us_equity';
}

class AlpacaClient {
  constructor(
    { keyId, secretKey, tradingUrl, dataUrl, feed = 'iex', optionsFeed = 'indicative' },
    fetchImpl = globalThis.fetch,
  ) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.oauthToken = '';
    this.tradingUrl = tradingUrl.replace(/\/$/, '');
    this.dataUrl = dataUrl.replace(/\/$/, '');
    this.feed = feed;
    this.optionsFeed = optionsFeed;
    this.fetch = fetchImpl;
  }

  setOAuthToken(token) {
    this.oauthToken = token || '';
  }

  get authMethod() {
    if (this.oauthToken) return 'oauth';
    if (this.keyId && this.secretKey) return 'api_key';
    return null;
  }

  get configured() {
    return Boolean(this.authMethod);
  }

  authHeaders() {
    // An OAuth token (Alpaca Connect) takes precedence over API keys when both are present.
    if (this.oauthToken) return { Authorization: `Bearer ${this.oauthToken}` };
    return { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secretKey };
  }

  async request(base, method, path, { query, body } = {}) {
    if (!this.configured) {
      throw new AlpacaError(503, 'Alpaca is not connected: add API keys to .env or use Connect with Alpaca');
    }
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        ...this.authHeaders(),
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    if (!res.ok) {
      throw new AlpacaError(res.status, (data && data.message) || `Alpaca HTTP ${res.status}`, data);
    }
    return data;
  }

  trade(method, path, opts) {
    return this.request(this.tradingUrl, method, path, opts);
  }

  data(method, path, opts) {
    return this.request(this.dataUrl, method, path, opts);
  }

  // ---- Account ----
  getAccount() { return this.trade('GET', '/v2/account'); }
  getAccountConfig() { return this.trade('GET', '/v2/account/configurations'); }
  getClock() { return this.trade('GET', '/v2/clock'); }
  getPortfolioHistory(query) { return this.trade('GET', '/v2/account/portfolio/history', { query }); }
  getActivities(query) { return this.trade('GET', '/v2/account/activities', { query }); }

  // ---- Assets (everything tradable) ----
  getAsset(symbol) { return this.trade('GET', `/v2/assets/${encodeURIComponent(symbol)}`); }
  // asset_class: us_equity | crypto ; status: active ; exchange, attributes, etc.
  listAssets(query = {}) { return this.trade('GET', '/v2/assets', { query: { status: 'active', ...query } }); }

  // ---- Options contracts ----
  // query: underlying_symbols, expiration_date, expiration_date_gte/lte, root_symbol, type (call|put),
  // style, strike_price_gte/lte, limit (max 10000), page_token, status
  listOptionContracts(query = {}) { return this.trade('GET', '/v2/options/contracts', { query }); }
  getOptionContract(symbolOrId) { return this.trade('GET', `/v2/options/contracts/${encodeURIComponent(symbolOrId)}`); }
  // Exercises all held contracts of this option position.
  exerciseOption(symbol) { return this.trade('POST', `/v2/positions/${encodeURIComponent(symbol)}/exercise`); }

  // ---- Positions ----
  getPositions() { return this.trade('GET', '/v2/positions'); }
  async getPosition(symbol) {
    try {
      return await this.trade('GET', `/v2/positions/${encodeURIComponent(symbol.replace('/', ''))}`);
    } catch (err) {
      if (err instanceof AlpacaError && err.status === 404) return null;
      throw err;
    }
  }
  closePosition(symbol, { qty, percentage } = {}) {
    return this.trade('DELETE', `/v2/positions/${encodeURIComponent(symbol.replace('/', ''))}`, {
      query: { qty, percentage },
    });
  }
  closeAllPositions({ cancelOrders = true } = {}) {
    return this.trade('DELETE', '/v2/positions', { query: { cancel_orders: cancelOrders } });
  }

  // ---- Orders ----
  listOrders(query = {}) {
    return this.trade('GET', '/v2/orders', { query: { status: 'open', limit: 100, nested: true, ...query } });
  }
  getOrder(id) { return this.trade('GET', `/v2/orders/${encodeURIComponent(id)}`, { query: { nested: true } }); }
  submitOrder(order) { return this.trade('POST', '/v2/orders', { body: order }); }
  replaceOrder(id, patch) { return this.trade('PATCH', `/v2/orders/${encodeURIComponent(id)}`, { body: patch }); }
  cancelOrder(id) { return this.trade('DELETE', `/v2/orders/${encodeURIComponent(id)}`); }
  cancelAllOrders() { return this.trade('DELETE', '/v2/orders'); }

  // ---- Market data: stocks / crypto ----
  async getLatestQuote(symbol) {
    if (isOption(symbol)) return (await this.getOptionLatestQuotes([symbol]))[symbol] || null;
    if (isCrypto(symbol)) {
      const d = await this.data('GET', '/v1beta3/crypto/us/latest/quotes', { query: { symbols: symbol } });
      return d.quotes ? d.quotes[symbol] : null;
    }
    const d = await this.data('GET', `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`, {
      query: { feed: this.feed },
    });
    return d.quote || null;
  }

  async getLatestTrade(symbol) {
    if (isOption(symbol)) {
      const d = await this.data('GET', '/v1beta1/options/trades/latest', { query: { symbols: symbol, feed: this.optionsFeed } });
      return d.trades ? d.trades[symbol] : null;
    }
    if (isCrypto(symbol)) {
      const d = await this.data('GET', '/v1beta3/crypto/us/latest/trades', { query: { symbols: symbol } });
      return d.trades ? d.trades[symbol] : null;
    }
    const d = await this.data('GET', `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, {
      query: { feed: this.feed },
    });
    return d.trade || null;
  }

  async getSnapshot(symbol) {
    if (isOption(symbol)) return (await this.getOptionSnapshots([symbol]))[symbol] || null;
    if (isCrypto(symbol)) {
      const d = await this.data('GET', '/v1beta3/crypto/us/snapshots', { query: { symbols: symbol } });
      return d.snapshots ? d.snapshots[symbol] : null;
    }
    return this.data('GET', `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, { query: { feed: this.feed } });
  }

  // Returns the most recent `limit` bars (at or after `start`), oldest first.
  async getBars(symbol, { timeframe = '1Day', start, end, limit = 100 } = {}) {
    let bars;
    if (isOption(symbol)) {
      const d = await this.data('GET', '/v1beta1/options/bars', {
        query: { symbols: symbol, timeframe, start, end, limit, sort: 'desc' },
      });
      bars = (d.bars && d.bars[symbol]) || [];
    } else if (isCrypto(symbol)) {
      const d = await this.data('GET', '/v1beta3/crypto/us/bars', {
        query: { symbols: symbol, timeframe, start, end, limit, sort: 'desc' },
      });
      bars = (d.bars && d.bars[symbol]) || [];
    } else {
      const d = await this.data('GET', `/v2/stocks/${encodeURIComponent(symbol)}/bars`, {
        query: { timeframe, start, end, limit, feed: this.feed, adjustment: 'split', sort: 'desc' },
      });
      bars = d.bars || [];
    }
    return bars.slice().reverse();
  }

  // ---- Market data: options ----
  async getOptionLatestQuotes(symbols) {
    const d = await this.data('GET', '/v1beta1/options/quotes/latest', {
      query: { symbols: symbols.join(','), feed: this.optionsFeed },
    });
    return d.quotes || {};
  }

  async getOptionSnapshots(symbols) {
    const d = await this.data('GET', '/v1beta1/options/snapshots', {
      query: { symbols: symbols.join(','), feed: this.optionsFeed },
    });
    return d.snapshots || {};
  }

  // Option chain for an underlying: { [occSymbol]: { latestQuote, latestTrade, greeks, impliedVolatility } }
  // query: type, strike_price_gte/lte, expiration_date, expiration_date_gte/lte, root_symbol
  async getOptionChain(underlying, query = {}, { maxPages = 5 } = {}) {
    const out = {};
    let pageToken;
    for (let page = 0; page < maxPages; page++) {
      const d = await this.data('GET', `/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`, {
        query: { feed: this.optionsFeed, limit: 1000, ...query, page_token: pageToken },
      });
      Object.assign(out, d.snapshots || {});
      pageToken = d.next_page_token;
      if (!pageToken) break;
    }
    return out;
  }

  // Best-effort reference price for risk checks: last trade, else quote midpoint.
  // For options this is the per-share premium (multiply by the contract multiplier for dollars).
  async getReferencePrice(symbol) {
    let quote = null;
    if (isOption(symbol)) {
      // Prefer the live quote midpoint for options; last trades can be stale on thin contracts.
      quote = await this.getLatestQuote(symbol).catch(() => null);
      const mid = midpoint(quote);
      if (mid) return mid;
    }
    try {
      const t = await this.getLatestTrade(symbol);
      if (t && Number(t.p) > 0) return Number(t.p);
    } catch {
      // fall through to quote
    }
    if (!quote) quote = await this.getLatestQuote(symbol);
    return midpoint(quote);
  }
}

function midpoint(q) {
  if (!q) return null;
  const bid = Number(q.bp);
  const ask = Number(q.ap);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (ask > 0) return ask;
  if (bid > 0) return bid;
  return null;
}

module.exports = { AlpacaClient, AlpacaError, isCrypto, isOption, parseOcc, assetClassOf, OCC_RE };

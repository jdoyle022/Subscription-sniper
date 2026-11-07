'use strict';

// Thin REST client for Alpaca's Trading API v2 and Market Data API.
// Docs: https://docs.alpaca.markets/reference

class AlpacaError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'AlpacaError';
    this.status = status;
    this.body = body;
  }
}

const isCrypto = (symbol) => String(symbol).includes('/');

class AlpacaClient {
  constructor({ keyId, secretKey, tradingUrl, dataUrl, feed = 'iex' }, fetchImpl = globalThis.fetch) {
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.tradingUrl = tradingUrl.replace(/\/$/, '');
    this.dataUrl = dataUrl.replace(/\/$/, '');
    this.feed = feed;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.keyId && this.secretKey);
  }

  async request(base, method, path, { query, body } = {}) {
    if (!this.configured) throw new AlpacaError(503, 'Alpaca API keys are not configured');
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await this.fetch(url, {
      method,
      headers: {
        'APCA-API-KEY-ID': this.keyId,
        'APCA-API-SECRET-KEY': this.secretKey,
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
  getClock() { return this.trade('GET', '/v2/clock'); }
  getPortfolioHistory(query) { return this.trade('GET', '/v2/account/portfolio/history', { query }); }
  getActivities(query) { return this.trade('GET', '/v2/account/activities', { query }); }

  // ---- Assets ----
  getAsset(symbol) { return this.trade('GET', `/v2/assets/${encodeURIComponent(symbol)}`); }

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
  getOrder(id) { return this.trade('GET', `/v2/orders/${encodeURIComponent(id)}`); }
  submitOrder(order) { return this.trade('POST', '/v2/orders', { body: order }); }
  replaceOrder(id, patch) { return this.trade('PATCH', `/v2/orders/${encodeURIComponent(id)}`, { body: patch }); }
  cancelOrder(id) { return this.trade('DELETE', `/v2/orders/${encodeURIComponent(id)}`); }
  cancelAllOrders() { return this.trade('DELETE', '/v2/orders'); }

  // ---- Market data ----
  async getLatestQuote(symbol) {
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
    if (isCrypto(symbol)) {
      const d = await this.data('GET', '/v1beta3/crypto/us/snapshots', { query: { symbols: symbol } });
      return d.snapshots ? d.snapshots[symbol] : null;
    }
    return this.data('GET', `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, { query: { feed: this.feed } });
  }

  // Returns the most recent `limit` bars (at or after `start`), oldest first.
  async getBars(symbol, { timeframe = '1Day', start, end, limit = 100 } = {}) {
    let bars;
    if (isCrypto(symbol)) {
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

  // Best-effort reference price for risk checks: last trade, else quote midpoint.
  async getReferencePrice(symbol) {
    try {
      const t = await this.getLatestTrade(symbol);
      if (t && Number(t.p) > 0) return Number(t.p);
    } catch {
      // fall through to quote
    }
    const q = await this.getLatestQuote(symbol);
    if (q) {
      const bid = Number(q.bp);
      const ask = Number(q.ap);
      if (bid > 0 && ask > 0) return (bid + ask) / 2;
      if (ask > 0) return ask;
      if (bid > 0) return bid;
    }
    return null;
  }
}

module.exports = { AlpacaClient, AlpacaError, isCrypto };

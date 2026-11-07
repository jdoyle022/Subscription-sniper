'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AlpacaClient, AlpacaError } = require('../src/alpaca');

function client(responder) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body = {} } = responder(String(url), opts);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const c = new AlpacaClient(
    { keyId: 'KID', secretKey: 'SEC', tradingUrl: 'https://paper-api.alpaca.markets', dataUrl: 'https://data.alpaca.markets', feed: 'iex' },
    fetchImpl,
  );
  return { c, calls };
}

test('sends auth headers and JSON body', async () => {
  const { c, calls } = client(() => ({ body: { id: 'o1' } }));
  await c.submitOrder({ symbol: 'AAPL', side: 'buy', qty: '1', type: 'market', time_in_force: 'day' });
  assert.equal(calls[0].url, 'https://paper-api.alpaca.markets/v2/orders');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['APCA-API-KEY-ID'], 'KID');
  assert.equal(JSON.parse(calls[0].opts.body).symbol, 'AAPL');
});

test('maps errors and 404 positions', async () => {
  const { c } = client((url) => (url.includes('/positions/') ? { status: 404, body: { message: 'position does not exist' } } : { status: 403, body: { message: 'insufficient buying power' } }));
  assert.equal(await c.getPosition('AAPL'), null);
  await assert.rejects(c.getAccount(), (e) => e instanceof AlpacaError && e.status === 403 && /buying power/.test(e.message));
});

test('bars come back oldest-first and crypto uses v1beta3', async () => {
  const { c, calls } = client((url) =>
    url.includes('crypto') ? { body: { bars: { 'BTC/USD': [{ t: '2' }, { t: '1' }] } } } : { body: { bars: [{ t: 'b' }, { t: 'a' }] } },
  );
  assert.deepEqual((await c.getBars('AAPL', { limit: 2 })).map((b) => b.t), ['a', 'b']);
  assert.match(calls[0].url, /sort=desc/);
  assert.deepEqual((await c.getBars('BTC/USD', { limit: 2 })).map((b) => b.t), ['1', '2']);
  assert.match(calls[1].url, /v1beta3\/crypto\/us\/bars\?symbols=BTC%2FUSD/);
});

test('reference price falls back to quote midpoint', async () => {
  const { c } = client((url) => (url.includes('trades') ? { body: { trade: null } } : { body: { quote: { bp: 99, ap: 101 } } }));
  assert.equal(await c.getReferencePrice('AAPL'), 100);
});

test('unconfigured client refuses', async () => {
  const c = new AlpacaClient({ keyId: '', secretKey: '', tradingUrl: 'x', dataUrl: 'y' });
  await assert.rejects(c.getAccount(), { status: 503 });
});

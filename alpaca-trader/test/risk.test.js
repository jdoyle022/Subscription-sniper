'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');
const { normalizeOrder } = require('../src/orders');

const check = (ctx, o) => ctx.risk.check(normalizeOrder(o));

test('passes a small buy', async () => {
  const ctx = setup();
  const r = await check(ctx, { symbol: 'MSFT', side: 'buy', qty: 1 });
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal(r.estimate.notional, 400);
});

test('blocks oversized notional and concentration', async () => {
  const ctx = setup();
  let r = await check(ctx, { symbol: 'MSFT', side: 'buy', qty: 10 });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /exceeds limit/);
  // AAPL already $1000 of $10000 equity; +$1800 -> 28% > 25%
  r = await check(ctx, { symbol: 'AAPL', side: 'buy', qty: 9 });
  assert.match(r.reasons.join(), /% of equity/);
});

test('blocks shorting unless allowed', async () => {
  const ctx = setup();
  let r = await check(ctx, { symbol: 'AAPL', side: 'sell', qty: 6 });
  assert.match(r.reasons.join(), /shorting is disabled/);
  r = await check(ctx, { symbol: 'AAPL', side: 'sell', qty: 5 });
  assert.equal(r.ok, true);
  const ctx2 = setup({ env: { ALLOW_SHORT: 'true' } });
  r = await check(ctx2, { symbol: 'MSFT', side: 'sell', qty: 1 });
  assert.equal(r.ok, true);
});

test('kill switch, lists, unpriceable, daily cap', async () => {
  const ctx = setup({ env: { SYMBOL_DENYLIST: 'GME', MAX_DAILY_ORDERS: '1' } });
  assert.match((await check(ctx, { symbol: 'GME', side: 'buy', qty: 1 })).reasons.join(), /deny list/);
  assert.match((await check(ctx, { symbol: 'ZZZ', side: 'buy', qty: 1 })).reasons.join(), /Cannot price/);
  ctx.desk.setKillSwitch(true, { actor: 't' });
  assert.match((await check(ctx, { symbol: 'MSFT', side: 'buy', qty: 1 })).reasons.join(), /Kill switch/);
  ctx.desk.setKillSwitch(false, { actor: 't' });
  ctx.risk.recordOrder();
  assert.match((await check(ctx, { symbol: 'MSFT', side: 'buy', qty: 1 })).reasons.join(), /Daily order cap/);

  const ctx2 = setup({ env: { SYMBOL_ALLOWLIST: 'SPY' } });
  assert.match((await check(ctx2, { symbol: 'MSFT', side: 'buy', qty: 1 })).reasons.join(), /allow list/);
});

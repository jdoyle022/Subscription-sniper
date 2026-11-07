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

const C500 = 'SPY261218C00500000';
const C510 = 'SPY261218C00510000';
const P490 = 'SPY261218P00490000';
const P480 = 'SPY261218P00480000';

test('long option is sized by premium x 100', async () => {
  const ctx = setup({ env: { MAX_POSITION_PCT: '50' } });
  const r = await check(ctx, { symbol: C500, side: 'buy', qty: 1, type: 'limit', limit_price: 20 });
  assert.equal(r.estimate.notional, 2000);
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal((await check(ctx, { symbol: C500, side: 'buy', qty: 2, type: 'limit', limit_price: 20 })).ok, false);
});

test('naked short call blocked; covered call and cash-secured put allowed', async () => {
  const ctx = setup({ env: { MAX_ORDER_NOTIONAL: '60000' } });
  let r = await check(ctx, { symbol: 'AAPL261218C00220000', side: 'sell', qty: 1, type: 'limit', limit_price: 5 });
  assert.match(r.reasons.join(), /naked short option/); // 5 shares held, need 100
  ctx.alpaca.positions.AAPL.qty = '100';
  r = await check(ctx, { symbol: 'AAPL261218C00220000', side: 'sell', qty: 1, type: 'limit', limit_price: 5 });
  assert.equal(r.ok, true, r.reasons.join());

  // Short put: cash 5000 < 180*100 -> naked; with cash -> allowed and sized by strike.
  r = await check(ctx, { symbol: 'AAPL261218P00180000', side: 'sell', qty: 1, type: 'limit', limit_price: 4 });
  assert.match(r.reasons.join(), /naked short option/);
  ctx.alpaca.account.cash = '20000';
  ctx.alpaca.account.equity = '100000';
  r = await check(ctx, { symbol: 'AAPL261218P00180000', side: 'sell', qty: 1, type: 'limit', limit_price: 4 });
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal(r.estimate.notional, 18000);

  const ctx2 = setup({ env: { ALLOW_SHORT_OPTIONS: 'true' } });
  assert.equal((await check(ctx2, { symbol: C500, side: 'sell', qty: 1, type: 'limit', limit_price: 20 })).ok, true);
});

test('selling an option you hold is a close, not a short', async () => {
  const ctx = setup({ env: { MAX_POSITION_PCT: '100', MAX_ORDER_NOTIONAL: '5000' } });
  ctx.alpaca.positions[C500] = { symbol: C500, qty: '2', market_value: '4000' };
  assert.equal((await check(ctx, { symbol: C500, side: 'sell', qty: 2, type: 'limit', limit_price: 20 })).ok, true);
  assert.match((await check(ctx, { symbol: C500, side: 'sell', qty: 3, type: 'limit', limit_price: 20 })).reasons.join(), /naked/);
});

test('spreads are sized by width; naked strangle blocked', async () => {
  const ctx = setup({ env: { MAX_ORDER_NOTIONAL: '2000' } });
  // Bull put credit spread: sell 490P, buy 480P, width 10 -> $1000 max-risk bound per unit.
  const spread = {
    order_class: 'mleg', qty: 1, limit_price: -3,
    legs: [{ symbol: P490, side: 'sell' }, { symbol: P480, side: 'buy' }],
  };
  let r = await check(ctx, spread);
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal(r.estimate.notional, 1000); // credit received; risk is the 10-point width
  r = await check(ctx, { ...spread, qty: 3 });
  assert.match(r.reasons.join(), /exceeds limit/);
  // Debit spread: buy 500C @20, sell 510C @15 -> max loss is the debit; limit 5.20 -> $520.
  r = await check(ctx, { order_class: 'mleg', qty: 1, limit_price: 5.2, legs: [{ symbol: C500, side: 'buy' }, { symbol: C510, side: 'sell' }] });
  assert.equal(r.ok, true, r.reasons.join());
  assert.equal(r.estimate.notional, 520);
  // Bear call credit spread: sell 500C, buy 510C -> width risk 10 points.
  r = await check(ctx, { order_class: 'mleg', qty: 1, limit_price: -4.8, legs: [{ symbol: C500, side: 'sell' }, { symbol: C510, side: 'buy' }] });
  assert.equal(r.estimate.notional, 1000);

  // Short strangle: two short legs, no longs.
  r = await check(ctx, { order_class: 'mleg', qty: 1, limit_price: -30, legs: [{ symbol: C510, side: 'sell' }, { symbol: P490, side: 'sell' }] });
  assert.match(r.reasons.join(), /naked short option/);

  // A put cannot cover a call: sell 500C + buy 480P is still a naked call.
  r = await check(ctx, { order_class: 'mleg', qty: 1, limit_price: -10, legs: [{ symbol: C500, side: 'sell' }, { symbol: P480, side: 'buy' }] });
  assert.match(r.reasons.join(), /SPY261218C00500000 without a matching long/);

  // Long straddle (all buys) is fine on the naked check.
  r = await check(setup({ env: { MAX_ORDER_NOTIONAL: '5000' } }), { order_class: 'mleg', qty: 1, limit_price: 32, legs: [{ symbol: C500, side: 'buy' }, { symbol: P490, side: 'buy' }] });
  assert.equal(r.ok, true, r.reasons.join());
});

test('options lists use the underlying, and account/desk switches apply', async () => {
  const ctx = setup({ env: { SYMBOL_ALLOWLIST: 'SPY', MAX_ORDER_NOTIONAL: '5000', MAX_POSITION_PCT: '100' } });
  assert.equal((await check(ctx, { symbol: C500, side: 'buy', qty: 1, type: 'limit', limit_price: 20 })).ok, true);
  assert.match((await check(ctx, { symbol: 'AAPL261218C00220000', side: 'buy', qty: 1 })).reasons.join(), /allow list/);
  ctx.alpaca.account.options_trading_level = 0;
  assert.match((await check(ctx, { symbol: C500, side: 'buy', qty: 1, type: 'limit', limit_price: 20 })).reasons.join(), /options level 0/);
  const off = setup({ env: { OPTIONS_ENABLED: 'false' } });
  assert.match((await check(off, { symbol: C500, side: 'buy', qty: 1, type: 'limit', limit_price: 1 })).reasons.join(), /OPTIONS_ENABLED/);
});

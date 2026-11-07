'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrder, describeOrder } = require('../src/orders');

test('market qty order gets defaults', () => {
  assert.deepEqual(normalizeOrder({ symbol: 'aapl', side: 'buy', qty: 3 }), {
    symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '3',
  });
});

test('crypto defaults to gtc', () => {
  assert.equal(normalizeOrder({ symbol: 'btc/usd', side: 'buy', notional: 50 }).time_in_force, 'gtc');
});

test('rejects bad inputs', () => {
  const bad = [
    {},
    { symbol: 'AAPL', side: 'hold', qty: 1 },
    { symbol: 'AAPL', side: 'buy' },
    { symbol: 'AAPL', side: 'buy', qty: 1, notional: 5 },
    { symbol: 'AAPL', side: 'buy', qty: -1 },
    { symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit' },
    { symbol: 'AAPL', side: 'buy', notional: 10, type: 'limit', limit_price: 1 },
    { symbol: 'AAPL', side: 'buy', qty: 1.5, type: 'limit', limit_price: 1 },
    { symbol: 'AAPL', side: 'buy', qty: 1, type: 'trailing_stop' },
    { symbol: 'AAPL', side: 'buy', qty: 1, extended_hours: true },
    { symbol: 'AAPL', side: 'buy', qty: 1, order_class: 'bracket', take_profit: { limit_price: 5 } },
    { symbol: 'AAPL; DROP', side: 'buy', qty: 1 },
  ];
  for (const o of bad) assert.throws(() => normalizeOrder(o), { name: 'ValidationError' }, JSON.stringify(o));
});

test('bracket order is passed through', () => {
  const o = normalizeOrder({
    symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400,
    order_class: 'bracket', take_profit: { limit_price: 440 }, stop_loss: { stop_price: 380 },
  });
  assert.deepEqual(o.take_profit, { limit_price: '440' });
  assert.deepEqual(o.stop_loss, { stop_price: '380' });
  assert.match(describeOrder(o), /BUY 2 MSFT limit @ limit 400 day \[bracket\]/);
});

test('single option orders: whole contracts, no notional, no extended hours', () => {
  const o = normalizeOrder({ symbol: 'spy261218c00500000', side: 'buy', qty: 2, type: 'limit', limit_price: 19.5 });
  assert.deepEqual(o, { symbol: 'SPY261218C00500000', side: 'buy', type: 'limit', time_in_force: 'day', qty: '2', limit_price: '19.5' });
  assert.match(describeOrder(o), /BUY 2 SPY 2026-12-18 500 CALL limit @ limit 19.5 day/);
  const bad = [
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1.5 },
    { symbol: 'SPY261218C00500000', side: 'buy', notional: 100 },
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1, type: 'trailing_stop', trail_percent: 5 },
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1, time_in_force: 'ioc' },
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1, type: 'limit', limit_price: 2, extended_hours: true },
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1, order_class: 'bracket' },
    { symbol: 'SPY261218C00500000', side: 'buy', qty: 1, position_intent: 'sell_to_open' },
  ];
  for (const b of bad) assert.throws(() => normalizeOrder(b), { name: 'ValidationError' }, JSON.stringify(b));
  assert.equal(normalizeOrder({ symbol: 'SPY261218P00490000', side: 'sell', qty: 1, position_intent: 'sell_to_open' }).position_intent, 'sell_to_open');
});

test('mleg strategies', () => {
  const o = normalizeOrder({
    order_class: 'mleg', qty: 3, limit_price: -1.25,
    legs: [
      { symbol: 'SPY261218P00490000', side: 'sell', ratio_qty: 1 },
      { symbol: 'SPY261218P00480000', position_intent: 'buy_to_open' },
    ],
  });
  assert.equal(o.type, 'limit');
  assert.equal(o.limit_price, '-1.25');
  assert.deepEqual(o.legs[1], { symbol: 'SPY261218P00480000', ratio_qty: '1', side: 'buy', position_intent: 'buy_to_open' });
  assert.match(describeOrder(o), /STRATEGY x3: SELL 1x SPY 2026-12-18 490 PUT \/ BUY 1x SPY 2026-12-18 480 PUT @ net -1.25/);

  const leg = (symbol, side) => ({ symbol, side });
  const bad = [
    { order_class: 'mleg', qty: 1, limit_price: 1, legs: [leg('SPY261218P00490000', 'buy')] },
    { order_class: 'mleg', qty: 1, limit_price: 1, legs: [leg('SPY261218P00490000', 'buy'), leg('SPY261218P00490000', 'sell')] },
    { order_class: 'mleg', qty: 1, limit_price: 0, legs: [leg('SPY261218P00490000', 'buy'), leg('SPY261218P00480000', 'sell')] },
    { order_class: 'mleg', qty: 1.5, limit_price: 1, legs: [leg('SPY261218P00490000', 'buy'), leg('SPY261218P00480000', 'sell')] },
    { order_class: 'mleg', qty: 1, type: 'stop', legs: [leg('SPY261218P00490000', 'buy'), leg('SPY261218P00480000', 'sell')] },
    { order_class: 'mleg', qty: 1, limit_price: 1, symbol: 'SPY', legs: [leg('SPY261218P00490000', 'buy'), leg('SPY261218P00480000', 'sell')] },
    { order_class: 'mleg', qty: 1, limit_price: 1, legs: [{ symbol: 'SPY261218P00490000' }, leg('SPY261218P00480000', 'sell')] },
    { order_class: 'mleg', qty: 1, limit_price: 1, legs: [leg('AAPL', 'buy'), leg('MSFT', 'sell')] },
    { order_class: 'mleg', qty: 1, limit_price: 1, legs: [{ symbol: 'SPY261218P00490000', side: 'buy', position_intent: 'sell_to_open' }, leg('SPY261218P00480000', 'sell')] },
  ];
  for (const b of bad) assert.throws(() => normalizeOrder(b), { name: 'ValidationError' }, JSON.stringify(b));
  // A stock leg plus an option leg (e.g. a covered call written as one order) is allowed.
  assert.equal(normalizeOrder({ order_class: 'mleg', qty: 1, type: 'market', legs: [{ symbol: 'AAPL', side: 'buy', ratio_qty: 100 }, leg('AAPL261218C00220000', 'sell')] }).legs.length, 2);
});

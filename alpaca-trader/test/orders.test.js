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

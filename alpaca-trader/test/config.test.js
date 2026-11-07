'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

const base = { ADMIN_TOKEN: 'x'.repeat(24) };

test('defaults to paper', () => {
  const c = loadConfig(base);
  assert.equal(c.alpaca.mode, 'paper');
  assert.equal(c.alpaca.tradingUrl, 'https://paper-api.alpaca.markets');
});

test('live requires the confirmation phrase', () => {
  assert.throws(() => loadConfig({ ...base, TRADING_MODE: 'live' }), /LIVE_TRADING_CONFIRM/);
  const c = loadConfig({ ...base, TRADING_MODE: 'live', LIVE_TRADING_CONFIRM: 'I accept live trading risk' });
  assert.equal(c.alpaca.tradingUrl, 'https://api.alpaca.markets');
});

test('rejects weak tokens', () => {
  assert.throws(() => loadConfig({ ADMIN_TOKEN: 'short' }), /ADMIN_TOKEN/);
  assert.throws(() => loadConfig({ ...base, AGENT_TOKENS: 'grok:short' }), /at least 24/);
});

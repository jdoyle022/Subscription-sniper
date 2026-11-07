'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

const order = { symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limit_price: 400 };

test('proposal stays pending until a human approves; executes exactly once', async () => {
  const { desk, alpaca } = setup();
  const p = await desk.createProposal({ agent: 'claude', order, rationale: 'test' });
  assert.equal(p.status, 'pending');
  assert.equal(alpaca.submitted.length, 0);

  const [a, b] = await Promise.allSettled([
    desk.approveProposal(p.id, { actor: 'human' }),
    desk.approveProposal(p.id, { actor: 'human' }),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(b.reason.status, 409);
  assert.equal(alpaca.submitted.length, 1);
  assert.equal(alpaca.submitted[0].client_order_id, `prop-${p.id}`);
  assert.equal(desk.getProposal(p.id).status, 'executed');
});

test('reject and expiry', async () => {
  const { desk } = setup({ env: { PROPOSAL_TTL_MINUTES: '1' } });
  const p = await desk.createProposal({ agent: 'grok', order, rationale: 'x' });
  desk.rejectProposal(p.id, { actor: 'human', reason: 'no' });
  await assert.rejects(desk.approveProposal(p.id, { actor: 'human' }), { status: 409 });

  const q = await desk.createProposal({ agent: 'grok', order, rationale: 'x' });
  desk.getProposal(q.id).createdAt = new Date(Date.now() - 120_000).toISOString();
  await assert.rejects(desk.approveProposal(q.id, { actor: 'human' }), /expired/);
});

test('risk guard is re-run at approval time', async () => {
  const { desk, alpaca } = setup();
  const p = await desk.createProposal({ agent: 'chatgpt', order, rationale: 'x' });
  desk.setKillSwitch(true, { actor: 'human' });
  await assert.rejects(desk.approveProposal(p.id, { actor: 'human' }), { status: 422 });
  assert.equal(desk.getProposal(p.id).status, 'failed');
  assert.equal(alpaca.submitted.length, 0);
});

test('paper auto-execute only when enabled, never in live', async () => {
  const { desk, alpaca } = setup({ env: { AI_PAPER_AUTO_EXECUTE: 'true' } });
  const p = await desk.createProposal({ agent: 'claude', order, rationale: 'x' });
  assert.equal(p.status, 'executed');
  assert.equal(alpaca.submitted.length, 1);

  const live = setup({
    env: { AI_PAPER_AUTO_EXECUTE: 'true', TRADING_MODE: 'live', LIVE_TRADING_CONFIRM: 'I accept live trading risk' },
  });
  assert.equal(live.config.ai.autoExecute, false);
  const q = await live.desk.createProposal({ agent: 'claude', order, rationale: 'x' });
  assert.equal(q.status, 'pending');
});

test('replacing an order is risk-checked', async () => {
  const { desk } = setup();
  const o = await desk.placeOrder(order, { actor: 'human' });
  await assert.rejects(desk.replaceOrder(o.id, { qty: 50 }, { actor: 'human' }), { status: 422 });
  const r = await desk.replaceOrder(o.id, { limit_price: 398 }, { actor: 'human' });
  assert.equal(r.limit_price, '398');
  desk.setKillSwitch(true, { actor: 'human' });
  await assert.rejects(desk.replaceOrder(o.id, { limit_price: 397 }, { actor: 'human' }), /risk guard/);
  await assert.rejects(desk.replaceOrder(o.id, {}, { actor: 'human' }), { status: 400 });
});

test('tool runner ignores prototype names', async () => {
  const { makeToolRunner } = require('../src/tools');
  const ctx = setup();
  const run = makeToolRunner(ctx);
  for (const name of ['constructor', '__proto__', 'toString', 'nope']) {
    assert.deepEqual(await run(name, {}, { agent: 'x' }), { ok: false, error: `Unknown tool: ${name}` });
  }
});

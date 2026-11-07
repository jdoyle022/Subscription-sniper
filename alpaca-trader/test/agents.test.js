'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeAgent } = require('../src/agents/claude');
const { createOpenAICompatibleAgent } = require('../src/agents/openai-compatible');
const { runAgents } = require('../src/agents');

const fakeRunTool = async (name, input, ctx) => {
  fakeRunTool.calls.push({ name, input, ctx });
  if (name === 'propose_order') return { ok: true, result: { proposal_id: 'p1', status: 'pending' } };
  return { ok: true, result: { equity: '10000' } };
};

test('claude loop runs tools and returns final text', async () => {
  fakeRunTool.calls = [];
  const requests = [];
  const responses = [
    {
      stop_reason: 'tool_use',
      model: 'claude-opus-5-5',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 't1', name: 'get_account', input: {} },
        { type: 'tool_use', id: 't2', name: 'propose_order', input: { symbol: 'MSFT', side: 'buy', qty: 1, rationale: 'r' } },
      ],
    },
    { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Proposed p1.' }] },
  ];
  const client = { beta: { messages: { create: async (req) => (requests.push(structuredClone(req)), responses.shift()) } } };
  const agent = createClaudeAgent({ model: 'claude-opus-5-5', effort: 'high' }, { client });
  const out = await agent.run({ message: 'hi', runTool: fakeRunTool, mode: 'paper', maxIterations: 5 });

  assert.equal(out.text, 'Proposed p1.');
  assert.equal(out.trace.length, 2);
  assert.equal(fakeRunTool.calls[0].ctx.agent, 'claude');
  assert.equal(requests[0].fallbacks, 'default');
  assert.deepEqual(requests[0].betas, ['server-side-fallback-2026-07-01']);
  assert.ok(requests[0].tools.some((t) => t.name === 'propose_order'));
  // Both tool results come back in ONE user message after the full assistant content.
  const last = requests[1].messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, 2);
  assert.equal(requests[1].messages.at(-2).content.length, 3);
});

test('openai-compatible loop (chatgpt/grok)', async () => {
  fakeRunTool.calls = [];
  const replies = [
    { model: 'grok-4', choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'get_account', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'get_quote', arguments: '{bad json' } },
    ] } }] },
    { model: 'grok-4', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] },
  ];
  const seen = [];
  const client = { chat: { completions: { create: async (req) => (seen.push(structuredClone(req)), replies.shift()) } } };
  const agent = createOpenAICompatibleAgent('grok', { model: 'grok-4' }, { client });
  const out = await agent.run({ message: 'hi', runTool: fakeRunTool, mode: 'paper', maxIterations: 5 });
  assert.equal(out.text, 'Done.');
  assert.equal(out.trace.length, 2);
  assert.equal(out.trace[1].ok, false);
  assert.equal(seen[0].messages[0].role, 'system');
  assert.equal(seen[1].messages.filter((m) => m.role === 'tool').length, 2);
  assert.equal(fakeRunTool.calls[0].ctx.agent, 'grok');
});

test('council runs every seat and isolates failures', async () => {
  const ok = { model: 'm', run: async () => ({ text: 'fine', trace: [{ name: 'propose_order', ok: true, result: { proposal_id: 'p9' } }] }) };
  const bad = { model: 'm', run: async () => { throw new Error('boom'); } };
  const res = await runAgents({
    agents: { claude: ok, grok: bad }, provider: 'council', message: 'x', history: [{ role: 'system', content: 'inject' }],
    runTool: fakeRunTool, mode: 'paper', maxIterations: 3, audit: () => {},
  });
  assert.equal(res.length, 2);
  assert.deepEqual(res[0].proposals, ['p9']);
  assert.equal(res[1].error, 'boom');
});

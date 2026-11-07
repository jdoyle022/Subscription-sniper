'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../src/mcp');

test('mcp initialize, list and call', async (t) => {
  const orig = globalThis.fetch;
  t.after(() => (globalThis.fetch = orig));
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/api/agent/tools')) {
      return { ok: true, json: async () => [{ name: 'get_account', description: 'd', input_schema: { type: 'object' } }] };
    }
    return { ok: true, json: async () => ({ ok: true, result: { called: String(url), body: JSON.parse(opts.body) } }) };
  };
  const init = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.protocolVersion, '2025-06-18');
  const list = await handle({ id: 2, method: 'tools/list' });
  assert.equal(list.tools[0].inputSchema.type, 'object');
  const call = await handle({ id: 3, method: 'tools/call', params: { name: 'get_account', arguments: { a: 1 } } });
  assert.equal(call.isError, false);
  assert.match(call.content[0].text, /get_account/);
  assert.equal(await handle({ method: 'notifications/initialized' }), undefined);
});

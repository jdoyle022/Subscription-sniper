#!/usr/bin/env node
'use strict';

// Minimal MCP (Model Context Protocol) server over stdio. It exposes the desk's agent tools to any
// MCP client (Claude Desktop, Claude Code, other MCP-capable assistants) by forwarding each call to
// the running app's /api/agent API with an agent token. The token decides which seat the calls are
// attributed to. Like every agent, an MCP client can read data and propose orders, never execute.
//
// Env: TRADER_URL (default http://127.0.0.1:8787), TRADER_AGENT_TOKEN (one of AGENT_TOKENS).

const readline = require('node:readline');

const BASE = (process.env.TRADER_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const TOKEN = process.env.TRADER_AGENT_TOKEN || '';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'alpaca-trader', version: '1.0.0' },
        instructions:
          'Trading desk tools. You can read the account and market data and call propose_order to queue a proposal. ' +
          'A human approves or rejects every proposal; you cannot execute trades.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list': {
      const tools = await api('GET', '/api/agent/tools');
      return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) };
    }
    case 'tools/call': {
      const out = await api('POST', `/api/agent/tools/${encodeURIComponent(params.name)}`, params.arguments || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(out.ok ? out.result : { error: out.error }, null, 2) }],
        isError: !out.ok,
      };
    }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

if (require.main === module) {
  if (!TOKEN) {
    console.error('TRADER_AGENT_TOKEN is required (use one of the tokens from AGENT_TOKENS).');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && result !== undefined) write({ jsonrpc: '2.0', id: msg.id, result });
    } catch (err) {
      if (msg.id !== undefined) {
        write({ jsonrpc: '2.0', id: msg.id, error: { code: err.code || -32000, message: err.message } });
      }
    }
  });
}

module.exports = { handle };

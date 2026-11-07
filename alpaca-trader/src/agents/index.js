'use strict';

const { createClaudeAgent } = require('./claude');
const { createOpenAICompatibleAgent } = require('./openai-compatible');

// Builds the seats that have API keys configured. Missing keys simply leave a seat empty.
function createAgents(aiConfig, overrides = {}) {
  const p = aiConfig.providers;
  const agents = {};
  if (overrides.claude || p.claude.apiKey) agents.claude = overrides.claude || createClaudeAgent(p.claude);
  if (overrides.chatgpt || p.chatgpt.apiKey) {
    agents.chatgpt = overrides.chatgpt || createOpenAICompatibleAgent('chatgpt', p.chatgpt);
  }
  if (overrides.grok || p.grok.apiKey) agents.grok = overrides.grok || createOpenAICompatibleAgent('grok', p.grok);
  return agents;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .slice(-20)
    .map((h) => ({ role: h.role, content: h.content.slice(0, 8000) }));
}

// Runs one seat, or every configured seat in parallel ("council").
async function runAgents({ agents, provider, message, history, runTool, mode, maxIterations, audit }) {
  const names = provider === 'council' ? Object.keys(agents) : [provider];
  if (!names.length) throw Object.assign(new Error('No AI providers are configured'), { status: 400 });
  for (const n of names) {
    if (!agents[n]) throw Object.assign(new Error(`AI provider "${n}" is not configured`), { status: 400 });
  }
  const clean = sanitizeHistory(history);
  const settled = await Promise.allSettled(
    names.map(async (n) => {
      const agent = agents[n];
      const started = Date.now();
      const out = await agent.run({ message, history: clean, runTool, mode, maxIterations });
      const proposals = out.trace
        .filter((t) => t.name === 'propose_order' && t.ok)
        .map((t) => t.result.proposal_id);
      audit('ai.run', { agent: n, model: agent.model, ms: Date.now() - started, tools: out.trace.length, proposals });
      return { provider: n, model: out.servedBy || agent.model, text: out.text, trace: out.trace, proposals };
    }),
  );
  return settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { provider: names[i], error: s.reason.message || String(s.reason) },
  );
}

module.exports = { createAgents, runAgents, sanitizeHistory };

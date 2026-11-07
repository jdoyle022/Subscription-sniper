'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { TOOLS } = require('../tools');
const { systemPrompt } = require('./prompt');

// Claude seat: manual tool-use loop over the Messages API so every tool call can be traced and
// attributed to the "claude" agent. Server-side refusal fallbacks are enabled ("default" routing).
function createClaudeAgent({ apiKey, model, effort }, { client } = {}) {
  const anthropic = client || new Anthropic({ apiKey });
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  return {
    name: 'claude',
    model,
    async run({ message, history = [], runTool, mode, maxIterations }) {
      const messages = [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];
      const trace = [];

      for (let i = 0; i < maxIterations; i++) {
        const response = await anthropic.beta.messages.create({
          model,
          max_tokens: 16000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          output_config: { effort },
          system: systemPrompt({ agent: 'claude', mode }),
          tools,
          messages,
        });

        // Append the full content (including thinking blocks) unchanged.
        messages.push({ role: 'assistant', content: response.content });
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();

        if (response.stop_reason === 'refusal') {
          return { text: text || 'Claude declined this request.', trace, servedBy: response.model };
        }
        if (response.stop_reason === 'pause_turn') continue;
        if (response.stop_reason !== 'tool_use') {
          return { text, trace, servedBy: response.model, stopReason: response.stop_reason };
        }

        const toolUses = response.content.filter((b) => b.type === 'tool_use');
        const results = await Promise.all(
          toolUses.map(async (tu) => {
            const out = await runTool(tu.name, tu.input, { agent: 'claude' });
            trace.push({ name: tu.name, input: tu.input, ok: out.ok, result: out.ok ? out.result : undefined, error: out.error });
            return {
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(out.ok ? out.result : { error: out.error }),
              is_error: !out.ok,
            };
          }),
        );
        // All tool results for one assistant turn go back in a single user message.
        messages.push({ role: 'user', content: results });
      }
      return { text: '(stopped: tool-call limit reached)', trace };
    },
  };
}

module.exports = { createClaudeAgent };

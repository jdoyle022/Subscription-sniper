'use strict';

const OpenAI = require('openai');
const { TOOLS } = require('../tools');
const { systemPrompt } = require('./prompt');

// ChatGPT (OpenAI) and Grok (xAI) seats. xAI's API is OpenAI-compatible, so both use the
// official openai SDK's Chat Completions function-calling loop with a different baseURL.
function createOpenAICompatibleAgent(name, { apiKey, model, baseURL }, { client } = {}) {
  const openai = client || new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const tools = TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  return {
    name,
    model,
    async run({ message, history = [], runTool, mode, maxIterations }) {
      const messages = [
        { role: 'system', content: systemPrompt({ agent: name, mode }) },
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: 'user', content: message },
      ];
      const trace = [];

      for (let i = 0; i < maxIterations; i++) {
        const completion = await openai.chat.completions.create({ model, messages, tools });
        const choice = completion.choices[0];
        const msg = choice.message;
        messages.push(msg);

        const calls = msg.tool_calls || [];
        if (!calls.length) {
          return { text: (msg.content || '').trim(), trace, servedBy: completion.model, stopReason: choice.finish_reason };
        }

        const results = await Promise.all(
          calls.map(async (call) => {
            let input;
            try {
              input = JSON.parse(call.function.arguments || '{}');
            } catch {
              return { call, out: { ok: false, error: 'Tool arguments were not valid JSON' }, input: null };
            }
            return { call, input, out: await runTool(call.function.name, input, { agent: name }) };
          }),
        );
        for (const { call, input, out } of results) {
          trace.push({ name: call.function.name, input, ok: out.ok, result: out.ok ? out.result : undefined, error: out.error });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(out.ok ? out.result : { error: out.error }),
          });
        }
      }
      return { text: '(stopped: tool-call limit reached)', trace };
    },
  };
}

module.exports = { createOpenAICompatibleAgent };

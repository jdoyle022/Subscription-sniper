'use strict';

const path = require('node:path');

const LIVE_CONFIRM_PHRASE = 'I accept live trading risk';

function num(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number, got "${value}"`);
  return n;
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function list(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

// AGENT_TOKENS="claude:longrandom1,chatgpt:longrandom2,grok:longrandom3"
function parseAgentTokens(value) {
  const tokens = new Map();
  if (!value) return tokens;
  for (const pair of String(value).split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) throw new Error('AGENT_TOKENS entries must look like name:token');
    const name = pair.slice(0, idx).trim();
    const token = pair.slice(idx + 1).trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(name)) throw new Error(`Bad agent name "${name}"`);
    if (token.length < 24) throw new Error(`Agent token for "${name}" must be at least 24 characters`);
    tokens.set(token, name);
  }
  return tokens;
}

function loadConfig(env = process.env) {
  const mode = (env.TRADING_MODE || 'paper').toLowerCase();
  if (!['paper', 'live'].includes(mode)) throw new Error('TRADING_MODE must be "paper" or "live"');
  if (mode === 'live' && env.LIVE_TRADING_CONFIRM !== LIVE_CONFIRM_PHRASE) {
    throw new Error(
      `TRADING_MODE=live requires LIVE_TRADING_CONFIRM="${LIVE_CONFIRM_PHRASE}". Refusing to start.`,
    );
  }

  const adminToken = env.ADMIN_TOKEN || '';
  if (adminToken.length < 24) throw new Error('ADMIN_TOKEN must be set and at least 24 characters');

  const cfg = {
    port: num(env.PORT, 8787),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || '',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    adminToken,
    agentTokens: parseAgentTokens(env.AGENT_TOKENS),
    alpaca: {
      keyId: env.ALPACA_KEY_ID || '',
      secretKey: env.ALPACA_SECRET_KEY || '',
      mode,
      tradingUrl:
        env.ALPACA_TRADING_URL ||
        (mode === 'live' ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets'),
      dataUrl: env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
      feed: env.ALPACA_DATA_FEED || 'iex',
    },
    risk: {
      maxOrderNotional: num(env.MAX_ORDER_NOTIONAL, 1000),
      maxPositionPct: num(env.MAX_POSITION_PCT, 20),
      maxDailyOrders: num(env.MAX_DAILY_ORDERS, 50),
      allowShort: bool(env.ALLOW_SHORT, false),
      allowlist: list(env.SYMBOL_ALLOWLIST),
      denylist: list(env.SYMBOL_DENYLIST),
    },
    ai: {
      // Auto-execution of AI proposals is honoured only in paper mode. Live always needs a human.
      autoExecute: mode === 'paper' && bool(env.AI_PAPER_AUTO_EXECUTE, false),
      proposalTtlMinutes: num(env.PROPOSAL_TTL_MINUTES, 60),
      maxToolIterations: num(env.AI_MAX_TOOL_ITERATIONS, 8),
      providers: {
        claude: {
          apiKey: env.ANTHROPIC_API_KEY || '',
          model: env.CLAUDE_MODEL || 'claude-opus-5-5',
          effort: env.CLAUDE_EFFORT || 'high',
        },
        chatgpt: {
          apiKey: env.OPENAI_API_KEY || '',
          model: env.OPENAI_MODEL || 'gpt-5',
        },
        grok: {
          apiKey: env.XAI_API_KEY || '',
          model: env.XAI_MODEL || 'grok-4',
          baseURL: env.XAI_BASE_URL || 'https://api.x.ai/v1',
        },
      },
    },
  };
  return cfg;
}

module.exports = { loadConfig, parseAgentTokens, LIVE_CONFIRM_PHRASE };

'use strict';

require('dotenv').config({ path: require('node:path').join(__dirname, '..', '.env'), quiet: true });

const http = require('node:http');
const { loadConfig } = require('./config');
const { AlpacaClient } = require('./alpaca');
const { Store } = require('./store');
const { RiskGuard } = require('./risk');
const { TradingDesk } = require('./desk');
const { createAgents } = require('./agents');
const { createApp } = require('./app');
const { AlpacaConnect } = require('./oauth');

function build(config, overrides = {}) {
  const alpaca = overrides.alpaca || new AlpacaClient(config.alpaca);
  const store = overrides.store || new Store(config.dataDir);
  const risk = new RiskGuard(config.risk, alpaca, store);
  const desk = new TradingDesk({ alpaca, store, risk, config });
  const connect =
    overrides.connect ||
    new AlpacaConnect({ oauth: config.oauth, mode: config.alpaca.mode, dataDir: config.dataDir }, alpaca, store);
  const agents = createAgents(config.ai, overrides.agents);
  const handler = createApp({ config, alpaca, store, desk, agents, connect });
  return { alpaca, store, risk, desk, agents, connect, handler };
}

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }
  const { handler, agents, store } = build(config);
  store.audit('server.start', { mode: config.alpaca.mode });
  http.createServer(handler).listen(config.port, config.host, () => {
    const seats = Object.keys(agents).join(', ') || 'none (add API keys)';
    console.log(`Alpaca Trader on http://${config.host}:${config.port}`);
    console.log(`Mode: ${config.alpaca.mode.toUpperCase()} | AI seats: ${seats} | auto-execute: ${config.ai.autoExecute}`);
    if (config.alpaca.mode === 'live') console.log('*** LIVE TRADING: orders use real money ***');
  });
}

module.exports = { build };

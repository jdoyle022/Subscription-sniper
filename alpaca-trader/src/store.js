'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Small durable store: one JSON state file (atomic replace) + an append-only JSONL audit log.
class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.statePath = path.join(dataDir, 'state.json');
    this.auditPath = path.join(dataDir, 'audit.jsonl');
    this.state = this.#load();
  }

  #load() {
    const empty = { proposals: [], killSwitch: false, daily: { date: '', count: 0 } };
    try {
      return { ...empty, ...JSON.parse(fs.readFileSync(this.statePath, 'utf8')) };
    } catch (err) {
      if (err.code === 'ENOENT') return empty;
      throw new Error(`Cannot read ${this.statePath}: ${err.message}`);
    }
  }

  save() {
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }

  audit(event, details = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
    fs.appendFileSync(this.auditPath, line + '\n', { mode: 0o600 });
  }

  readAudit(limit = 200) {
    let text;
    try {
      text = fs.readFileSync(this.auditPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const lines = text.trim().split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { event: 'unparseable', raw: l };
        }
      });
  }
}

module.exports = { Store };

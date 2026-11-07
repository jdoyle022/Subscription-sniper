'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Alpaca Connect (OAuth 2.0 authorization-code flow).
//   1. start()     -> authorize URL on app.alpaca.markets (with a one-time `state`)
//   2. the user signs in to Alpaca and approves this app
//   3. callback()  -> exchanges ?code for an access token at the token endpoint
// The token is stored in data/oauth.json (mode 600) and sent as `Authorization: Bearer <token>`.
// It is tied to the trading mode (paper/live) it was granted for.

const STATE_TTL_MS = 10 * 60_000;

class AlpacaConnect {
  constructor({ oauth, mode, dataDir }, alpaca, store, fetchImpl = globalThis.fetch) {
    this.cfg = oauth;
    this.mode = mode;
    this.alpaca = alpaca;
    this.store = store;
    this.fetch = fetchImpl;
    this.file = path.join(dataDir, 'oauth.json');
    this.states = new Map();
    this.token = this.#load();
    if (this.token) this.alpaca.setOAuthToken(this.token.access_token);
  }

  get enabled() {
    return Boolean(this.cfg.clientId && this.cfg.clientSecret);
  }

  get status() {
    return {
      enabled: this.enabled,
      connected: Boolean(this.token),
      connectedAt: this.token ? this.token.connectedAt : null,
      scope: this.token ? this.token.scope : null,
      redirectUri: this.cfg.redirectUri,
    };
  }

  #load() {
    try {
      const t = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // A paper token must never be used in live mode (or vice versa).
      return t && t.access_token && t.mode === this.mode ? t : null;
    } catch {
      return null;
    }
  }

  #save(token) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(token), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  start() {
    if (!this.enabled) {
      throw Object.assign(new Error('Set ALPACA_OAUTH_CLIENT_ID and ALPACA_OAUTH_CLIENT_SECRET to use Connect with Alpaca'), { status: 400 });
    }
    const now = Date.now();
    for (const [s, t] of this.states) if (now - t > STATE_TTL_MS) this.states.delete(s);
    const state = crypto.randomBytes(24).toString('hex');
    this.states.set(state, now);
    const url = new URL(this.cfg.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', this.cfg.scope);
    url.searchParams.set('env', this.mode);
    return { url: url.toString() };
  }

  async callback({ code, state, error }) {
    const issued = state ? this.states.get(state) : undefined;
    if (state) this.states.delete(state);
    if (!issued || Date.now() - issued > STATE_TTL_MS) {
      throw Object.assign(new Error('Invalid or expired sign-in attempt. Start again from the desk.'), { status: 400 });
    }
    if (error) throw Object.assign(new Error(`Alpaca declined the connection: ${error}`), { status: 400 });
    if (!code) throw Object.assign(new Error('Missing authorization code'), { status: 400 });

    const res = await this.fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        redirect_uri: this.cfg.redirectUri,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw Object.assign(new Error(data.message || data.error_description || data.error || `Token exchange failed (HTTP ${res.status})`), { status: 502 });
    }
    this.token = { access_token: data.access_token, scope: data.scope || null, mode: this.mode, connectedAt: new Date().toISOString() };
    this.#save(this.token);
    this.alpaca.setOAuthToken(this.token.access_token);
    this.store.audit('oauth.connected', { actor: 'human', mode: this.mode, scope: this.token.scope });
    return this.status;
  }

  disconnect() {
    this.token = null;
    this.alpaca.setOAuthToken('');
    try {
      fs.unlinkSync(this.file);
    } catch {
      // already gone
    }
    this.store.audit('oauth.disconnected', { actor: 'human' });
    return this.status;
  }
}

module.exports = { AlpacaConnect };

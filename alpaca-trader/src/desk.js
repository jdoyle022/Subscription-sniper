'use strict';

const crypto = require('node:crypto');
const { normalizeOrder, describeOrder } = require('./orders');

class DeskError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'DeskError';
    this.status = status;
    this.details = details;
  }
}

// The trading desk is the only component that submits orders to Alpaca.
// AI agents never call it directly for execution: they create proposals, which a human approves.
class TradingDesk {
  constructor({ alpaca, store, risk, config }) {
    this.alpaca = alpaca;
    this.store = store;
    this.risk = risk;
    this.config = config;
    this.inFlight = new Set();
  }

  get mode() {
    return this.config.alpaca.mode;
  }

  // ---------- Direct (human) actions ----------

  async placeOrder(rawOrder, { actor, clientOrderId, proposalId } = {}) {
    const order = normalizeOrder(rawOrder);
    const check = await this.risk.check(order);
    if (!check.ok) {
      this.store.audit('order.blocked', { actor, proposalId, order, reasons: check.reasons });
      throw new DeskError(422, 'Blocked by risk guard', { reasons: check.reasons, estimate: check.estimate });
    }
    const body = { ...order, client_order_id: clientOrderId || `desk-${crypto.randomUUID()}` };
    this.store.audit('order.submit', { actor, proposalId, mode: this.mode, order: body, estimate: check.estimate });
    try {
      const result = await this.alpaca.submitOrder(body);
      this.risk.recordOrder();
      this.store.audit('order.accepted', { actor, proposalId, id: result.id, status: result.status });
      return result;
    } catch (err) {
      this.store.audit('order.rejected', { actor, proposalId, status: err.status, message: err.message });
      throw err;
    }
  }

  async cancelOrder(id, { actor }) {
    await this.alpaca.cancelOrder(id);
    this.store.audit('order.cancel', { actor, id });
    return { ok: true };
  }

  async cancelAllOrders({ actor }) {
    const res = await this.alpaca.cancelAllOrders();
    this.store.audit('order.cancel_all', { actor, count: Array.isArray(res) ? res.length : undefined });
    return res;
  }

  async replaceOrder(id, patch, { actor }) {
    const allowed = ['qty', 'time_in_force', 'limit_price', 'stop_price', 'trail'];
    const clean = {};
    for (const k of allowed) if (patch[k] !== undefined && patch[k] !== '') clean[k] = String(patch[k]);
    if (!Object.keys(clean).length) throw new DeskError(400, `Nothing to replace; allowed fields: ${allowed.join(', ')}`);

    // A replacement is a new order as far as risk is concerned: re-check the resulting order.
    const existing = await this.alpaca.getOrder(id);
    const candidate = {
      symbol: existing.symbol,
      side: existing.side,
      qty: clean.qty || existing.qty || undefined,
      notional: clean.qty ? undefined : existing.notional || undefined,
      limit_price: clean.limit_price || existing.limit_price || undefined,
      stop_price: clean.stop_price || existing.stop_price || undefined,
    };
    const check = await this.risk.check(candidate);
    if (!check.ok) {
      this.store.audit('order.replace_blocked', { actor, id, patch: clean, reasons: check.reasons });
      throw new DeskError(422, 'Blocked by risk guard', { reasons: check.reasons, estimate: check.estimate });
    }
    const res = await this.alpaca.replaceOrder(id, clean);
    this.store.audit('order.replace', { actor, id, patch: clean, newId: res.id });
    return res;
  }

  async closePosition(symbol, opts, { actor }) {
    const res = await this.alpaca.closePosition(symbol, opts);
    this.store.audit('position.close', { actor, symbol, ...opts });
    return res;
  }

  async closeAllPositions({ actor }) {
    const res = await this.alpaca.closeAllPositions({ cancelOrders: true });
    this.store.audit('position.close_all', { actor });
    return res;
  }

  setKillSwitch(on, { actor }) {
    this.store.state.killSwitch = Boolean(on);
    this.store.save();
    this.store.audit('killswitch', { actor, on: Boolean(on) });
    return { killSwitch: this.store.state.killSwitch };
  }

  // ---------- AI proposals ----------

  listProposals({ status } = {}) {
    this.expireStale();
    const all = this.store.state.proposals;
    return (status ? all.filter((p) => p.status === status) : all).slice().reverse();
  }

  getProposal(id) {
    return this.store.state.proposals.find((p) => p.id === id) || null;
  }

  expireStale() {
    const ttl = this.config.ai.proposalTtlMinutes * 60_000;
    const now = Date.now();
    let changed = false;
    for (const p of this.store.state.proposals) {
      if (p.status === 'pending' && now - Date.parse(p.createdAt) > ttl) {
        p.status = 'expired';
        p.decidedAt = new Date().toISOString();
        changed = true;
      }
    }
    // Keep the state file bounded.
    if (this.store.state.proposals.length > 500) {
      this.store.state.proposals = this.store.state.proposals.slice(-500);
      changed = true;
    }
    if (changed) this.store.save();
  }

  async createProposal({ agent, order: rawOrder, rationale, confidence }) {
    const order = normalizeOrder(rawOrder);
    const preview = await this.risk.check(order).catch((err) => ({ ok: false, reasons: [err.message] }));
    const proposal = {
      id: crypto.randomUUID(),
      agent,
      order,
      summary: describeOrder(order),
      rationale: String(rationale || '').slice(0, 4000),
      confidence: confidence === undefined ? null : Number(confidence),
      riskPreview: { ok: preview.ok, reasons: preview.reasons, estimate: preview.estimate },
      status: 'pending',
      createdAt: new Date().toISOString(),
      mode: this.mode,
    };
    this.store.state.proposals.push(proposal);
    this.store.save();
    this.store.audit('proposal.created', { agent, id: proposal.id, summary: proposal.summary });

    if (this.config.ai.autoExecute && this.mode === 'paper') {
      await this.approveProposal(proposal.id, { actor: `auto-paper:${agent}` }).catch(() => {});
    }
    return this.getProposal(proposal.id);
  }

  async approveProposal(id, { actor }) {
    this.expireStale();
    const p = this.getProposal(id);
    if (!p) throw new DeskError(404, 'Proposal not found');
    if (p.status !== 'pending') throw new DeskError(409, `Proposal is ${p.status}`);
    if (p.mode !== this.mode) throw new DeskError(409, `Proposal was made in ${p.mode} mode`);
    if (this.inFlight.has(id)) throw new DeskError(409, 'Proposal is already executing');

    this.inFlight.add(id);
    p.status = 'executing';
    p.decidedBy = actor;
    p.decidedAt = new Date().toISOString();
    this.store.save();
    try {
      // client_order_id is derived from the proposal so Alpaca itself rejects a duplicate submission.
      const result = await this.placeOrder(p.order, { actor, proposalId: id, clientOrderId: `prop-${id}` });
      p.status = 'executed';
      p.orderId = result.id;
      return { proposal: p, order: result };
    } catch (err) {
      p.status = 'failed';
      p.error = err.message;
      if (err.details) p.errorDetails = err.details;
      throw err;
    } finally {
      this.inFlight.delete(id);
      this.store.save();
    }
  }

  rejectProposal(id, { actor, reason }) {
    const p = this.getProposal(id);
    if (!p) throw new DeskError(404, 'Proposal not found');
    if (p.status !== 'pending') throw new DeskError(409, `Proposal is ${p.status}`);
    p.status = 'rejected';
    p.decidedBy = actor;
    p.decidedAt = new Date().toISOString();
    p.rejectReason = reason ? String(reason).slice(0, 500) : undefined;
    this.store.save();
    this.store.audit('proposal.rejected', { actor, id, reason: p.rejectReason });
    return p;
  }
}

module.exports = { TradingDesk, DeskError };

'use strict';

// Pre-trade risk guard. Every order — human ticket, approved AI proposal, or auto-executed
// paper proposal — passes through check() immediately before submission.

class RiskGuard {
  constructor(limits, alpaca, store) {
    this.limits = limits;
    this.alpaca = alpaca;
    this.store = store;
  }

  today() {
    return new Date().toISOString().slice(0, 10);
  }

  ordersToday() {
    const d = this.store.state.daily;
    return d.date === this.today() ? d.count : 0;
  }

  recordOrder() {
    const today = this.today();
    const d = this.store.state.daily;
    this.store.state.daily = { date: today, count: (d.date === today ? d.count : 0) + 1 };
    this.store.save();
  }

  // Returns { ok, reasons[], estimate: { price, notional } }
  async check(order) {
    const reasons = [];
    const L = this.limits;
    const sym = order.symbol;

    if (this.store.state.killSwitch) reasons.push('Kill switch is ON: new orders are blocked');
    if (L.denylist.includes(sym)) reasons.push(`${sym} is on the deny list`);
    if (L.allowlist.length && !L.allowlist.includes(sym)) reasons.push(`${sym} is not on the allow list`);
    if (this.ordersToday() >= L.maxDailyOrders) reasons.push(`Daily order cap (${L.maxDailyOrders}) reached`);

    let price = null;
    if (order.limit_price) price = Number(order.limit_price);
    else if (order.stop_price) price = Number(order.stop_price);
    else {
      try {
        price = await this.alpaca.getReferencePrice(sym);
      } catch {
        price = null;
      }
    }

    let notional = order.notional ? Number(order.notional) : null;
    if (notional === null && price) notional = Number(order.qty) * price;
    if (notional === null) reasons.push(`Cannot price ${sym} to size-check this order`);
    else if (notional > L.maxOrderNotional) {
      reasons.push(`Order notional $${notional.toFixed(2)} exceeds limit $${L.maxOrderNotional}`);
    }

    if (notional !== null) {
      const [account, position] = await Promise.all([
        this.alpaca.getAccount(),
        this.alpaca.getPosition(sym),
      ]);
      const equity = Number(account.equity);
      const held = position ? Number(position.qty) : 0;
      const heldValue = position ? Number(position.market_value) : 0;

      if (account.trading_blocked || account.account_blocked) reasons.push('Alpaca reports the account is blocked');

      if (order.side === 'buy') {
        const after = Math.max(heldValue, 0) + notional;
        if (equity > 0 && (after / equity) * 100 > L.maxPositionPct) {
          reasons.push(
            `Position would be ${((after / equity) * 100).toFixed(1)}% of equity (limit ${L.maxPositionPct}%)`,
          );
        }
      } else if (!L.allowShort) {
        const sellQty = order.qty ? Number(order.qty) : price ? notional / price : Infinity;
        if (sellQty > held + 1e-9) {
          reasons.push(`Sell exceeds long position (${held} held); shorting is disabled`);
        }
      }
    }

    return { ok: reasons.length === 0, reasons, estimate: { price, notional } };
  }
}

module.exports = { RiskGuard };

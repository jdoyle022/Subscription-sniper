'use strict';

const { isOption, parseOcc } = require('./alpaca');

// Pre-trade risk guard. Every order — human ticket, approved AI proposal, auto-executed paper
// proposal, or an order replacement — passes through check() immediately before submission.
//
// Sizing ("notional") per asset class:
//   stocks / ETFs / crypto  qty x price (or the dollar notional)
//   single option           contracts x premium x multiplier (100)
//   options strategy (mleg) what it can lose: the net debit (at reference prices or the limit, whichever
//                           is larger) plus, for short option legs, the strike width to the paired long
//                           leg (an upper bound for verticals), the strike for cash-secured puts, and, if
//                           naked shorts are allowed, strike (puts) or premium (calls)
// Short options are allowed when covered: a short call against 100 held shares per contract
// (covered call), a short put with cash for strike x 100 per contract (cash-secured put), or a
// short leg paired with a long leg of the same type and underlying (spread). Other short options
// (naked) are blocked unless ALLOW_SHORT_OPTIONS=true.

const MULTIPLIER = 100;

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

  async price(symbol) {
    try {
      return await this.alpaca.getReferencePrice(symbol);
    } catch {
      return null;
    }
  }

  async heldQty(symbol) {
    const p = await this.alpaca.getPosition(symbol).catch(() => null);
    return p ? Number(p.qty) : 0;
  }

  checkSymbolLists(symbols, reasons) {
    const L = this.limits;
    for (const sym of new Set(symbols)) {
      const occ = parseOcc(sym);
      const names = occ ? [sym, occ.root] : [sym];
      if (names.some((n) => L.denylist.includes(n))) reasons.push(`${sym} is on the deny list`);
      if (L.allowlist.length && !names.some((n) => L.allowlist.includes(n))) {
        reasons.push(`${sym} is not on the allow list`);
      }
    }
  }

  // Returns { ok, reasons[], estimate: { price, notional } }
  async check(order) {
    const reasons = [];
    const L = this.limits;

    if (this.store.state.killSwitch) reasons.push('Kill switch is ON: new orders are blocked');
    if (this.ordersToday() >= L.maxDailyOrders) reasons.push(`Daily order cap (${L.maxDailyOrders}) reached`);

    const isMleg = order.order_class === 'mleg';
    const touchesOptions = isMleg || isOption(order.symbol);
    if (touchesOptions && !L.optionsEnabled) reasons.push('Options trading is disabled on this desk (OPTIONS_ENABLED=false)');

    const account = await this.alpaca.getAccount();
    const equity = Number(account.equity);
    if (account.trading_blocked || account.account_blocked) reasons.push('Alpaca reports the account is blocked');
    if (touchesOptions && account.options_trading_level !== undefined && Number(account.options_trading_level) === 0) {
      reasons.push('Options trading is not enabled on this Alpaca account (options level 0)');
    }

    const estimate = isMleg
      ? await this.checkMleg(order, reasons, account)
      : await this.checkSingle(order, reasons, account);

    if (estimate.notional === null) reasons.push('Cannot price this order to size-check it');
    else if (estimate.notional > L.maxOrderNotional) {
      reasons.push(`Order size $${estimate.notional.toFixed(2)} exceeds limit $${L.maxOrderNotional}`);
    }
    return { ok: reasons.length === 0, reasons, estimate };
  }

  // Is a short option covered by held shares (calls) or cash (puts)?
  async coverage(occ, contracts, account) {
    if (occ.type === 'call') {
      const shares = await this.heldQty(occ.root);
      return shares >= contracts * MULTIPLIER ? 'covered call' : null;
    }
    return Number(account.cash) >= occ.strike * contracts * MULTIPLIER ? 'cash-secured put' : null;
  }

  async checkSingle(order, reasons, account) {
    const L = this.limits;
    const equity = Number(account.equity);
    const sym = order.symbol;
    const option = isOption(sym);
    this.checkSymbolLists([sym], reasons);

    let price = null;
    if (order.limit_price) price = Number(order.limit_price);
    else if (order.stop_price) price = Number(order.stop_price);
    else price = await this.price(sym);

    const mult = option ? MULTIPLIER : 1;
    let notional = order.notional ? Number(order.notional) : null;
    if (notional === null && price) notional = Number(order.qty) * price * mult;
    if (notional === null) return { price, notional };

    const position = await this.alpaca.getPosition(sym);
    const held = position ? Number(position.qty) : 0;
    const heldValue = position ? Number(position.market_value) : 0;

    if (order.side === 'buy') {
      const after = Math.max(heldValue, 0) + notional;
      if (equity > 0 && (after / equity) * 100 > L.maxPositionPct) {
        reasons.push(`Position would be ${((after / equity) * 100).toFixed(1)}% of equity (limit ${L.maxPositionPct}%)`);
      }
    } else {
      const sellQty = order.qty ? Number(order.qty) : price ? notional / price : Infinity;
      const opening = sellQty > held + 1e-9 || order.position_intent === 'sell_to_open';
      if (opening && option) {
        const toOpen = Math.max(sellQty - Math.max(held, 0), 0) || sellQty;
        const occ = parseOcc(sym);
        const covered = await this.coverage(occ, toOpen, account);
        // A short put can lose up to strike x 100 per contract: size it by that, not the premium.
        if (occ.type === 'put') notional = Math.max(notional, occ.strike * toOpen * MULTIPLIER);
        if (!covered && !L.allowShortOptions) {
          reasons.push(`Selling ${sym} to open is a naked short option (not covered by shares or cash); ALLOW_SHORT_OPTIONS is off`);
        }
      } else if (opening && !option && !L.allowShort) {
        reasons.push(`Sell exceeds long position (${held} held); shorting is disabled`);
      }
    }
    return { price, notional };
  }

  async checkMleg(order, reasons, account) {
    const L = this.limits;
    const qty = Number(order.qty);
    this.checkSymbolLists(order.legs.map((l) => l.symbol), reasons);

    const legs = await Promise.all(
      order.legs.map(async (l) => ({
        ...l,
        ratio: Number(l.ratio_qty),
        occ: parseOcc(l.symbol),
        price: await this.price(l.symbol),
        held: await this.heldQty(l.symbol),
      })),
    );
    if (legs.some((l) => l.price === null)) return { price: null, notional: null };

    // Net debit at reference prices (stock legs at 1x, option legs at 100x), and at the limit price.
    const netDebit = legs.reduce(
      (sum, l) => sum + (l.side === 'buy' ? 1 : -1) * l.price * l.ratio * qty * (l.occ ? MULTIPLIER : 1),
      0,
    );
    const limitDebit = order.limit_price && Number(order.limit_price) > 0 ? Number(order.limit_price) * qty * MULTIPLIER : 0;
    let nakedRisk = 0;

    // Pair each short option leg with an unused long option leg of the same underlying and type.
    const longs = legs.filter((l) => l.occ && l.side === 'buy').map((l) => ({ ...l, left: l.ratio }));
    let widthRisk = 0;
    for (const s of legs.filter((l) => l.side === 'sell')) {
      const closing = s.held >= s.ratio * qty - 1e-9 && s.position_intent !== 'sell_to_open';
      if (!s.occ) {
        if (!closing && !L.allowShort) reasons.push(`Leg sells ${s.symbol} shares you do not hold; shorting is disabled`);
        continue;
      }
      if (closing) continue;
      let need = s.ratio;
      for (const lg of longs) {
        if (need <= 0) break;
        if (lg.left <= 0 || lg.occ.root !== s.occ.root || lg.occ.type !== s.occ.type) continue;
        if (lg.occ.expiration < s.occ.expiration) continue; // long must last at least as long as the short
        const used = Math.min(need, lg.left);
        // Loss beyond the debit only exists when the long is further out of the money than the short
        // (credit verticals): calls with long strike above the short, puts with long strike below it.
        const width = s.occ.type === 'call' ? lg.occ.strike - s.occ.strike : s.occ.strike - lg.occ.strike;
        widthRisk += Math.max(width, 0) * used * qty * MULTIPLIER;
        lg.left -= used;
        need -= used;
      }
      if (need > 0 && s.occ.type === 'call') {
        // Shares bought in this strategy, or already held, can cover the remaining short calls.
        const stockLeg = legs.find((l) => !l.occ && l.side === 'buy' && l.symbol === s.occ.root);
        const shares = (await this.heldQty(s.occ.root)) + (stockLeg ? stockLeg.ratio * qty : 0);
        if (shares >= need * qty * MULTIPLIER) need = 0;
      }
      if (need > 0 && s.occ.type === 'put' && (await this.coverage(s.occ, need * qty, account))) {
        widthRisk += s.occ.strike * need * qty * MULTIPLIER; // cash-secured: capital at risk is the strike
        need = 0;
      }
      if (need > 0) {
        if (!L.allowShortOptions) {
          reasons.push(`Leg sells ${s.symbol} without a matching long leg (naked short option); ALLOW_SHORT_OPTIONS is off`);
        }
        // Allowed naked shorts: puts by strike, calls (unbounded) by premium as a floor.
        nakedRisk += (s.occ.type === 'put' ? s.occ.strike : s.price) * need * qty * MULTIPLIER;
      }
    }
    // What the strategy can lose: the debit paid, or for short legs the spread width / strike obligation.
    const notional = Math.max(netDebit, limitDebit, 0) + widthRisk + nakedRisk;
    return { price: order.limit_price ? Number(order.limit_price) : null, notional };
  }
}

module.exports = { RiskGuard, MULTIPLIER };

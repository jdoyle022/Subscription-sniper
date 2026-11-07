'use strict';

// Validates and normalises an order request into the exact body Alpaca's POST /v2/orders expects.
// Used for human tickets, AI proposals, and the external agent API alike.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

const { isOption, parseOcc } = require('./alpaca');

const SIDES = ['buy', 'sell'];
const INTENTS = ['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close'];
const OPTION_TYPES = ['market', 'limit', 'stop', 'stop_limit'];
const MLEG_TYPES = ['market', 'limit'];
const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'];
const TIFS = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];
const CLASSES = ['simple', 'bracket', 'oco', 'oto', 'mleg'];
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}(\/[A-Z]{2,6})?$/;
const OPTION_SYMBOL_RE = /^[A-Z]{1,6}\d?\d{6}[CP]\d{8}$/;

function symbolOf(value, name = 'symbol') {
  const symbol = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!SYMBOL_RE.test(symbol) && !OPTION_SYMBOL_RE.test(symbol)) {
    throw new ValidationError(`${name} is missing or invalid`);
  }
  return symbol;
}

function wholeContracts(name, value) {
  const n = positive(name, value, { required: true });
  if (!Number.isInteger(n)) throw new ValidationError(`${name} must be a whole number of contracts`);
  return n;
}

function positive(name, value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${name} is required`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ValidationError(`${name} must be a positive number`);
  return n;
}

function oneOf(name, value, allowed, fallback) {
  const v = value === undefined || value === null || value === '' ? fallback : String(value).toLowerCase();
  if (!allowed.includes(v)) throw new ValidationError(`${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

// Alpaca accepts decimal strings; keep them as strings to avoid float noise.
const str = (n) => (n === undefined ? undefined : String(n));

function intentOf(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return oneOf(name, value, INTENTS);
}

// Multi-leg options order (Alpaca order_class "mleg"): 2-4 legs with unique symbols, a whole-number
// strategy qty, market or limit. For limit, limit_price is the net price for one unit of the strategy.
function normalizeMleg(input) {
  if (input.symbol) throw new ValidationError('mleg orders take symbols on each leg, not at the top level');
  if (input.side) throw new ValidationError('mleg orders take side/position_intent on each leg, not at the top level');
  if (input.notional) throw new ValidationError('mleg orders require qty, not notional');
  const qty = wholeContracts('qty', input.qty);
  const type = oneOf('type', input.type, MLEG_TYPES, 'limit');
  const tif = oneOf('time_in_force', input.time_in_force, ['day', 'gtc'], 'day');
  if (!Array.isArray(input.legs) || input.legs.length < 2 || input.legs.length > 4) {
    throw new ValidationError('mleg orders need 2 to 4 legs');
  }
  const legs = input.legs.map((leg, i) => {
    if (!leg || typeof leg !== 'object') throw new ValidationError(`legs[${i}] must be an object`);
    const symbol = symbolOf(leg.symbol, `legs[${i}].symbol`);
    if (symbol.includes('/')) throw new ValidationError('crypto cannot be a leg of an options strategy');
    const ratio = positive(`legs[${i}].ratio_qty`, leg.ratio_qty ?? 1, { required: true });
    if (!Number.isInteger(ratio)) throw new ValidationError(`legs[${i}].ratio_qty must be a whole number`);
    let side = leg.side === undefined || leg.side === '' ? undefined : oneOf(`legs[${i}].side`, leg.side, SIDES);
    const intent = intentOf(leg.position_intent, `legs[${i}].position_intent`);
    if (!side && !intent) throw new ValidationError(`legs[${i}] needs side or position_intent`);
    if (!side) side = intent.startsWith('buy') ? 'buy' : 'sell';
    if (intent && !intent.startsWith(side)) throw new ValidationError(`legs[${i}] side and position_intent disagree`);
    const out = { symbol, ratio_qty: String(ratio), side };
    if (intent) out.position_intent = intent;
    return out;
  });
  if (new Set(legs.map((l) => l.symbol)).size !== legs.length) throw new ValidationError('mleg legs must have unique symbols');
  if (!legs.some((l) => isOption(l.symbol))) throw new ValidationError('mleg orders need at least one option leg');

  const order = { order_class: 'mleg', qty: String(qty), type, time_in_force: tif, legs };
  if (type === 'limit') {
    const lp = Number(input.limit_price);
    if (input.limit_price === undefined || input.limit_price === '' || !Number.isFinite(lp) || lp === 0) {
      throw new ValidationError('limit mleg orders need a non-zero net limit_price');
    }
    order.limit_price = String(lp);
  }
  return order;
}

function normalizeOptionOrder(input, symbol) {
  if (input.notional) throw new ValidationError('option orders require qty (contracts), not notional');
  const qty = wholeContracts('qty', input.qty);
  const side = oneOf('side', input.side, SIDES);
  const type = oneOf('type', input.type, OPTION_TYPES, 'market');
  const tif = oneOf('time_in_force', input.time_in_force, ['day', 'gtc'], 'day');
  const cls = oneOf('order_class', input.order_class, CLASSES, 'simple');
  if (cls !== 'simple') throw new ValidationError('single option orders must be simple; use mleg for strategies');
  if (input.extended_hours) throw new ValidationError('options do not trade in extended hours');
  const order = { symbol, side, type, time_in_force: tif, qty: String(qty) };
  if (type === 'limit' || type === 'stop_limit') {
    order.limit_price = str(positive('limit_price', input.limit_price, { required: true }));
  }
  if (type === 'stop' || type === 'stop_limit') {
    order.stop_price = str(positive('stop_price', input.stop_price, { required: true }));
  }
  const intent = intentOf(input.position_intent, 'position_intent');
  if (intent) {
    if (!intent.startsWith(side)) throw new ValidationError('side and position_intent disagree');
    order.position_intent = intent;
  }
  return order;
}

function normalizeOrder(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('order must be an object');
  if (String(input.order_class || '').toLowerCase() === 'mleg') return normalizeMleg(input);
  const symbol = symbolOf(input.symbol);
  if (isOption(symbol)) return normalizeOptionOrder(input, symbol);
  if (!SYMBOL_RE.test(symbol)) throw new ValidationError('symbol is missing or invalid');
  const crypto = symbol.includes('/');

  const side = oneOf('side', input.side, SIDES);
  const type = oneOf('type', input.type, TYPES, 'market');
  const tif = oneOf('time_in_force', input.time_in_force, TIFS, crypto ? 'gtc' : 'day');
  const orderClass = oneOf('order_class', input.order_class, CLASSES, 'simple');

  const qty = positive('qty', input.qty);
  const notional = positive('notional', input.notional);
  if ((qty === undefined) === (notional === undefined)) {
    throw new ValidationError('provide exactly one of qty or notional');
  }
  if (notional !== undefined && (type !== 'market' || tif !== 'day') && !crypto) {
    throw new ValidationError('notional (dollar) orders must be market orders with time_in_force=day');
  }
  if (qty !== undefined && !crypto && !Number.isInteger(qty) && (type !== 'market' || tif !== 'day')) {
    throw new ValidationError('fractional share quantities must be market orders with time_in_force=day');
  }

  const order = {
    symbol,
    side,
    type,
    time_in_force: tif,
    qty: str(qty),
    notional: str(notional),
  };

  if (type === 'limit' || type === 'stop_limit') {
    order.limit_price = str(positive('limit_price', input.limit_price, { required: true }));
  }
  if (type === 'stop' || type === 'stop_limit') {
    order.stop_price = str(positive('stop_price', input.stop_price, { required: true }));
  }
  if (type === 'trailing_stop') {
    const tp = positive('trail_price', input.trail_price);
    const tpc = positive('trail_percent', input.trail_percent);
    if ((tp === undefined) === (tpc === undefined)) {
      throw new ValidationError('trailing_stop needs exactly one of trail_price or trail_percent');
    }
    order.trail_price = str(tp);
    order.trail_percent = str(tpc);
  }

  if (input.extended_hours) {
    if (type !== 'limit' || tif !== 'day') {
      throw new ValidationError('extended_hours requires a limit order with time_in_force=day');
    }
    order.extended_hours = true;
  }

  if (orderClass !== 'simple') {
    if (crypto) throw new ValidationError('advanced order classes are not supported for crypto');
    if (qty === undefined) throw new ValidationError(`${orderClass} orders require qty`);
    order.order_class = orderClass;
    const tpLimit = positive('take_profit.limit_price', input.take_profit && input.take_profit.limit_price);
    const slStop = positive('stop_loss.stop_price', input.stop_loss && input.stop_loss.stop_price);
    const slLimit = positive('stop_loss.limit_price', input.stop_loss && input.stop_loss.limit_price);
    if (tpLimit !== undefined) order.take_profit = { limit_price: str(tpLimit) };
    if (slStop !== undefined) order.stop_loss = { stop_price: str(slStop), limit_price: str(slLimit) };
    if (orderClass === 'bracket' && (!order.take_profit || !order.stop_loss)) {
      throw new ValidationError('bracket orders need take_profit.limit_price and stop_loss.stop_price');
    }
    if (orderClass === 'oco' && (!order.take_profit || !order.stop_loss)) {
      throw new ValidationError('oco orders need take_profit.limit_price and stop_loss.stop_price');
    }
    if (orderClass === 'oto' && !order.take_profit === !order.stop_loss) {
      throw new ValidationError('oto orders need exactly one of take_profit or stop_loss');
    }
  }

  for (const k of Object.keys(order)) if (order[k] === undefined) delete order[k];
  if (order.stop_loss && order.stop_loss.limit_price === undefined) delete order.stop_loss.limit_price;
  return order;
}

function describeLeg(symbol) {
  const occ = parseOcc(symbol);
  return occ ? `${occ.root} ${occ.expiration} ${occ.strike} ${occ.type.toUpperCase()}` : symbol;
}

function describeOrder(o) {
  if (o.order_class === 'mleg') {
    const legs = o.legs.map((l) => `${l.side.toUpperCase()} ${l.ratio_qty}x ${describeLeg(l.symbol)}`).join(' / ');
    const px = o.limit_price ? ` @ net ${o.limit_price}` : ' @ market';
    return `STRATEGY x${o.qty}: ${legs}${px} ${o.time_in_force}`;
  }
  if (isOption(o.symbol)) {
    const intent = o.position_intent ? ` (${o.position_intent.replace(/_/g, ' ')})` : '';
    const px = [o.limit_price && `limit ${o.limit_price}`, o.stop_price && `stop ${o.stop_price}`].filter(Boolean);
    return `${o.side.toUpperCase()} ${o.qty} ${describeLeg(o.symbol)} ${o.type}${px.length ? ' @ ' + px.join(', ') : ''}${intent} ${o.time_in_force}`;
  }
  const size = o.qty ? `${o.qty} ${o.symbol}` : `$${o.notional} of ${o.symbol}`;
  const px = [
    o.limit_price && `limit ${o.limit_price}`,
    o.stop_price && `stop ${o.stop_price}`,
    o.trail_percent && `trail ${o.trail_percent}%`,
    o.trail_price && `trail $${o.trail_price}`,
  ].filter(Boolean);
  const cls = o.order_class ? ` [${o.order_class}]` : '';
  return `${o.side.toUpperCase()} ${size} ${o.type}${px.length ? ' @ ' + px.join(', ') : ''} ${o.time_in_force}${cls}`;
}

module.exports = { normalizeOrder, describeOrder, describeLeg, ValidationError };

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

const SIDES = ['buy', 'sell'];
const TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'];
const TIFS = ['day', 'gtc', 'opg', 'cls', 'ioc', 'fok'];
const CLASSES = ['simple', 'bracket', 'oco', 'oto'];
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}(\/[A-Z]{2,6})?$/;

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

function normalizeOrder(input) {
  if (!input || typeof input !== 'object') throw new ValidationError('order must be an object');
  const symbol = String(input.symbol || '').trim().toUpperCase();
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

function describeOrder(o) {
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

module.exports = { normalizeOrder, describeOrder, ValidationError };

'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const TOKEN_KEY = 'alpaca-trader-token';

  let token = '';
  try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* storage unavailable */ }

  const state = { status: null, orderStatus: 'open', side: 'buy', propFilter: 'pending', history: [] };

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const money = (v, digits = 2) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
  };
  const pct = (v) => (Number.isFinite(Number(v)) ? `${(Number(v) * 100).toFixed(2)}%` : '—');
  const signClass = (v) => (Number(v) > 0 ? 'up' : Number(v) < 0 ? 'down' : '');
  const time = (s) => (s ? new Date(s).toLocaleString() : '—');

  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), isErr ? 7000 : 3500);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      lock('Token rejected.');
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.details = data.details;
      throw err;
    }
    return data;
  }

  function confirmDialog(title, bodyNodes, okLabel = 'Confirm', danger = false) {
    const dlg = $('#confirm');
    $('#confirm-title').textContent = title;
    $('#confirm-body').replaceChildren(...bodyNodes);
    const ok = $('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'danger' : 'primary';
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // ---------- auth ----------
  function lock(msg) {
    token = '';
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#login-error').textContent = msg || '';
    $('#login-token').focus();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    token = $('#login-token').value.trim();
    try {
      await api('GET', '/api/status');
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
      $('#login-token').value = '';
      start();
    } catch (err) {
      $('#login-error').textContent = err.message === 'Unauthorized' ? 'Token rejected.' : err.message;
    }
  });
  $('#logout').addEventListener('click', () => lock());

  // ---------- tabs ----------
  $$('.tab').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab-panel').forEach((p) => (p.hidden = p.id !== `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'audit') loadAudit();
      if (b.dataset.tab === 'ai') loadProposals();
    }),
  );

  // ---------- status / header ----------
  async function loadStatus() {
    const s = await api('GET', '/api/status');
    state.status = s;
    const badge = $('#mode-badge');
    badge.textContent = s.mode.toUpperCase();
    badge.className = `badge ${s.mode}`;
    document.title = `Alpaca Trader (${s.mode})`;
    $('#kill-switch').checked = s.killSwitch;
    const pc = $('#pending-count');
    pc.hidden = !s.pendingProposals;
    pc.textContent = s.pendingProposals;

    const sel = $('#ai-provider');
    const current = sel.value;
    const names = Object.keys(s.providers);
    sel.replaceChildren(
      ...names.map((n) => el('option', { value: n }, `${n} (${s.providers[n]})`)),
      ...(names.length > 1 ? [el('option', { value: 'council' }, 'Council: ask all seats')] : []),
    );
    if (current) sel.value = current;
    $('#ai-send').disabled = !names.length;
    $('#ai-note').textContent = names.length
      ? `Seats can read data and propose orders. You approve every trade${s.aiAutoExecute ? ' (except: paper auto-execute is ON)' : ''}. External agents: ${s.externalAgents.join(', ') || 'none'}.`
      : 'No AI seats configured. Add ANTHROPIC_API_KEY, OPENAI_API_KEY and/or XAI_API_KEY to .env.';
    if (!s.alpacaConfigured) toast('Alpaca keys missing: set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env', true);
  }

  async function loadClock() {
    try {
      const c = await api('GET', '/api/clock');
      $('#clock').textContent = c.is_open
        ? `Market open · closes ${new Date(c.next_close).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : `Market closed · opens ${new Date(c.next_open).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      $('#clock').textContent = '';
    }
  }

  $('#kill-switch').addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await api('POST', '/api/killswitch', { on });
      toast(on ? 'Kill switch ON: new orders blocked' : 'Kill switch off');
    } catch (err) {
      e.target.checked = !on;
      toast(err.message, true);
    }
  });

  // ---------- desk ----------
  async function loadAccount() {
    const a = await api('GET', '/api/account');
    const dayPl = Number(a.equity) - Number(a.last_equity);
    const dayPct = Number(a.last_equity) ? dayPl / Number(a.last_equity) : 0;
    const stat = (label, value, cls = '') => el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: `value ${cls}` }, value));
    $('#stats').replaceChildren(
      stat('Equity', money(a.equity)),
      stat('Day P/L', `${money(dayPl)} (${pct(dayPct)})`, signClass(dayPl)),
      stat('Cash', money(a.cash)),
      stat('Buying power', money(a.buying_power)),
      stat('Day trades (5d)', `${a.daytrade_count ?? '—'}${a.pattern_day_trader ? ' · PDT' : ''}`),
    );
  }

  function table(target, headers, rows, empty) {
    const thead = el('thead', {}, el('tr', {}, headers.map((h) => el('th', { class: h.num ? 'num' : '' }, h.label))));
    const tbody = el('tbody');
    if (!rows.length) tbody.append(el('tr', {}, el('td', { class: 'empty', colspan: headers.length }, empty)));
    rows.forEach((r) => tbody.append(r));
    $(target).replaceChildren(thead, tbody);
  }

  async function loadPositions() {
    const ps = await api('GET', '/api/positions');
    table(
      '#positions',
      [
        { label: 'Symbol' }, { label: 'Qty', num: true }, { label: 'Avg cost', num: true }, { label: 'Price', num: true },
        { label: 'Value', num: true }, { label: 'Unrealized P/L', num: true }, { label: '' },
      ],
      ps.map((p) =>
        el('tr', {},
          el('td', {}, el('strong', {}, p.symbol)),
          el('td', { class: 'num' }, p.qty),
          el('td', { class: 'num' }, money(p.avg_entry_price)),
          el('td', { class: 'num' }, money(p.current_price)),
          el('td', { class: 'num' }, money(p.market_value)),
          el('td', { class: `num ${signClass(p.unrealized_pl)}` }, `${money(p.unrealized_pl)} (${pct(p.unrealized_plpc)})`),
          el('td', {},
            el('button', { class: 'ghost small', onclick: () => fillTicket(p.symbol) }, 'Trade'), ' ',
            el('button', { class: 'danger small', onclick: () => closePosition(p) }, 'Close'),
          ),
        ),
      ),
      'No open positions',
    );
  }

  async function closePosition(p) {
    const ok = await confirmDialog(`Close ${p.symbol}?`, [el('p', {}, `Market-close all ${p.qty} ${p.symbol} (≈ ${money(p.market_value)}).`)], 'Close position', true);
    if (!ok) return;
    try {
      await api('DELETE', `/api/positions/${encodeURIComponent(p.symbol)}`);
      toast(`Close order sent for ${p.symbol}`);
      refreshDesk();
    } catch (err) {
      toast(err.message, true);
    }
  }

  $('#close-all').addEventListener('click', async () => {
    const ok = await confirmDialog('Flatten everything?', [el('p', {}, 'Cancels all open orders and market-closes every position.')], 'Flatten all', true);
    if (!ok) return;
    try {
      await api('DELETE', '/api/positions');
      toast('Flatten requested');
      refreshDesk();
    } catch (err) {
      toast(err.message, true);
    }
  });

  async function loadOrders() {
    const os = await api('GET', `/api/orders?status=${state.orderStatus}&limit=100`);
    const flat = [];
    os.forEach((o) => {
      flat.push(o);
      (o.legs || []).forEach((l) => flat.push({ ...l, _leg: true }));
    });
    const cancellable = ['new', 'accepted', 'pending_new', 'partially_filled', 'held', 'accepted_for_bidding', 'pending_replace'];
    table(
      '#orders',
      [
        { label: 'Submitted' }, { label: 'Symbol' }, { label: 'Side' }, { label: 'Type' }, { label: 'Qty', num: true },
        { label: 'Filled', num: true }, { label: 'Price', num: true }, { label: 'Status' }, { label: '' },
      ],
      flat.map((o) =>
        el('tr', {},
          el('td', { class: 'muted' }, o._leg ? '  └ leg' : time(o.submitted_at)),
          el('td', {}, o.symbol),
          el('td', { class: o.side === 'buy' ? 'up' : 'down' }, o.side),
          el('td', {}, `${o.type}${o.order_class && o.order_class !== 'simple' && !o._leg ? ` (${o.order_class})` : ''}`),
          el('td', { class: 'num' }, o.qty || (o.notional ? money(o.notional) : '—')),
          el('td', { class: 'num' }, `${o.filled_qty}${o.filled_avg_price ? ' @ ' + money(o.filled_avg_price) : ''}`),
          el('td', { class: 'num' }, [o.limit_price && `L ${o.limit_price}`, o.stop_price && `S ${o.stop_price}`, o.trail_percent && `T ${o.trail_percent}%`].filter(Boolean).join(' ') || 'mkt'),
          el('td', {}, o.status),
          el('td', {}, cancellable.includes(o.status) ? el('button', { class: 'ghost small', onclick: () => cancelOrder(o) }, 'Cancel') : ''),
        ),
      ),
      'No orders',
    );
  }

  async function cancelOrder(o) {
    try {
      await api('DELETE', `/api/orders/${encodeURIComponent(o.id)}`);
      toast('Cancel requested');
      setTimeout(refreshDesk, 600);
    } catch (err) {
      toast(err.message, true);
    }
  }

  $('#cancel-all').addEventListener('click', async () => {
    const ok = await confirmDialog('Cancel all open orders?', [el('p', {}, 'This includes stop-loss and take-profit legs.')], 'Cancel all', true);
    if (!ok) return;
    try {
      await api('DELETE', '/api/orders');
      toast('Cancel-all requested');
      setTimeout(refreshDesk, 600);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $$('#order-status button').forEach((b) =>
    b.addEventListener('click', () => {
      state.orderStatus = b.dataset.status;
      $$('#order-status button').forEach((x) => x.classList.toggle('active', x === b));
      loadOrders().catch((e) => toast(e.message, true));
    }),
  );

  // ---------- ticket ----------
  const form = $('#ticket');

  function syncTicket() {
    const type = $('#t-type').value;
    const show = {
      limit_price: type === 'limit' || type === 'stop_limit',
      stop_price: type === 'stop' || type === 'stop_limit',
      trail: type === 'trailing_stop',
      extended: type === 'limit',
    };
    $$('[data-show]', form).forEach((n) => (n.hidden = !show[n.dataset.show]));
    $('#t-size-label').textContent = $('#t-sizeby').value === 'qty' ? 'Quantity' : 'Dollar amount';
  }
  $('#t-type').addEventListener('change', syncTicket);
  $('#t-sizeby').addEventListener('change', syncTicket);
  syncTicket();

  $$('#t-side button').forEach((b) =>
    b.addEventListener('click', () => {
      state.side = b.dataset.side;
      $$('#t-side button').forEach((x) => x.classList.toggle('active', x === b));
    }),
  );

  function fillTicket(symbol) {
    $$('.tab')[0].click();
    $('#t-symbol').value = symbol;
    lookupQuote();
    $('#t-size').focus();
  }

  async function lookupQuote() {
    const sym = $('#t-symbol').value.trim().toUpperCase();
    if (!sym) return;
    const box = $('#quote-box');
    box.textContent = 'Loading…';
    try {
      const s = await api('GET', `/api/quote/${encodeURIComponent(sym)}`);
      const q = s.latestQuote || {};
      const t = s.latestTrade || {};
      const d = s.dailyBar || {};
      const prev = s.prevDailyBar || {};
      const chg = prev.c ? (t.p - prev.c) / prev.c : null;
      box.replaceChildren(
        el('strong', {}, sym), ` last ${money(t.p, 2)} `,
        chg !== null ? el('span', { class: signClass(chg) }, `(${pct(chg)}) `) : '',
        ` bid ${money(q.bp)} × ${q.bs ?? '—'} · ask ${money(q.ap)} × ${q.as ?? '—'} · day ${money(d.l)}–${money(d.h)}`,
      );
    } catch (err) {
      box.textContent = err.message;
    }
  }
  $('#quote-btn').addEventListener('click', lookupQuote);
  $('#t-symbol').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); lookupQuote(); }
  });

  function buildOrder() {
    const fd = new FormData(form);
    const val = (k) => (fd.get(k) || '').toString().trim();
    const type = val('type');
    const order = {
      symbol: val('symbol').toUpperCase(),
      side: state.side,
      type,
      time_in_force: val('time_in_force'),
      [$('#t-sizeby').value]: $('#t-size').value,
    };
    if (type === 'limit' || type === 'stop_limit') order.limit_price = val('limit_price');
    if (type === 'stop' || type === 'stop_limit') order.stop_price = val('stop_price');
    if (type === 'trailing_stop') {
      if (val('trail_percent')) order.trail_percent = val('trail_percent');
      else order.trail_price = val('trail_price');
    }
    if (type === 'limit' && fd.get('extended_hours')) order.extended_hours = true;
    const cls = val('order_class');
    if (cls && cls !== 'simple') {
      order.order_class = cls;
      if (val('tp_limit')) order.take_profit = { limit_price: val('tp_limit') };
      if (val('sl_stop')) order.stop_loss = { stop_price: val('sl_stop'), ...(val('sl_limit') ? { limit_price: val('sl_limit') } : {}) };
    }
    return order;
  }

  function showRisk(order, risk) {
    const msg = $('#ticket-msg');
    const est = risk.estimate || {};
    const head = el('div', { class: risk.ok ? 'up' : 'down' },
      risk.ok ? 'Passes risk checks.' : 'Blocked by risk guard:',
      est.notional ? ` Est. notional ${money(est.notional)}${est.price ? ` @ ${money(est.price)}` : ''}.` : '');
    msg.replaceChildren(head, risk.reasons.length ? el('ul', {}, risk.reasons.map((r) => el('li', {}, r))) : '');
  }

  $('#preview-btn').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/orders/preview', buildOrder());
      showRisk(r.order, r.risk);
    } catch (err) {
      $('#ticket-msg').replaceChildren(el('span', { class: 'down' }, err.message));
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const order = buildOrder();
    let preview;
    try {
      preview = await api('POST', '/api/orders/preview', order);
    } catch (err) {
      $('#ticket-msg').replaceChildren(el('span', { class: 'down' }, err.message));
      return;
    }
    showRisk(preview.order, preview.risk);
    if (!preview.risk.ok) return;
    const live = state.status && state.status.mode === 'live';
    const o = preview.order;
    const ok = await confirmDialog(
      live ? 'Submit LIVE order (real money)' : 'Submit paper order',
      [
        el('p', {}, el('strong', {}, `${o.side.toUpperCase()} ${o.qty ? o.qty + ' ' + o.symbol : money(o.notional) + ' of ' + o.symbol}`)),
        el('p', { class: 'muted' }, `${o.type} · ${o.time_in_force}${o.limit_price ? ' · limit ' + o.limit_price : ''}${o.stop_price ? ' · stop ' + o.stop_price : ''}${o.order_class ? ' · ' + o.order_class : ''}`),
        el('p', {}, `Estimated notional: ${money(preview.risk.estimate.notional)}`),
      ],
      live ? 'Send live order' : 'Send order',
      live,
    );
    if (!ok) return;
    try {
      const res = await api('POST', '/api/orders', order);
      $('#ticket-msg').replaceChildren(el('span', { class: 'up' }, `Order ${res.status}: ${res.id}`));
      toast('Order submitted');
      setTimeout(refreshDesk, 800);
    } catch (err) {
      const reasons = (err.details && err.details.reasons) || [];
      $('#ticket-msg').replaceChildren(el('span', { class: 'down' }, err.message), reasons.length ? el('ul', {}, reasons.map((r) => el('li', {}, r))) : '');
    }
  });

  // ---------- AI seats ----------
  function addBubble(who, text, cls = '', extra = []) {
    const b = el('div', { class: `bubble ${cls}` }, el('div', { class: 'who' }, who), text, ...extra);
    $('#chat').append(b);
    b.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return b;
  }

  function traceDetails(trace) {
    if (!trace || !trace.length) return [];
    return [
      el('details', {},
        el('summary', {}, `${trace.length} tool call${trace.length > 1 ? 's' : ''}`),
        trace.map((t) => el('pre', {}, `${t.ok ? '✓' : '✗'} ${t.name}(${JSON.stringify(t.input)})${t.error ? ' → ' + t.error : ''}`)),
      ),
    ];
  }

  $('#ai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#ai-input');
    const message = input.value.trim();
    if (!message) return;
    const provider = $('#ai-provider').value;
    addBubble('You', message, 'user');
    input.value = '';
    const send = $('#ai-send');
    send.disabled = true;
    const pending = addBubble(provider, 'Thinking…');
    try {
      const results = await api('POST', '/api/ai/chat', { provider, message, history: state.history });
      pending.remove();
      state.history.push({ role: 'user', content: message });
      const combined = [];
      for (const r of results) {
        if (r.error) {
          addBubble(r.provider, r.error, 'err');
          continue;
        }
        const props = r.proposals.length ? [el('div', { class: 'small up' }, `Created ${r.proposals.length} proposal(s): see the queue →`)] : [];
        addBubble(`${r.provider} · ${r.model}`, r.text || '(no text)', '', [...props, ...traceDetails(r.trace)]);
        combined.push(results.length > 1 ? `[${r.provider}] ${r.text}` : r.text);
      }
      state.history.push({ role: 'assistant', content: combined.join('\n\n') || '(no answer)' });
      loadProposals();
      loadStatus();
    } catch (err) {
      pending.remove();
      addBubble(provider, err.message, 'err');
    } finally {
      send.disabled = false;
    }
  });
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#ai-form').requestSubmit();
  });
  $('#ai-clear').addEventListener('click', () => {
    state.history = [];
    $('#chat').replaceChildren();
  });

  async function loadProposals() {
    const qs = state.propFilter ? `?status=${state.propFilter}` : '';
    const ps = await api('GET', `/api/proposals${qs}`);
    const box = $('#proposals');
    if (!ps.length) {
      box.replaceChildren(el('p', { class: 'muted' }, state.propFilter ? 'No pending proposals.' : 'No proposals yet.'));
      return;
    }
    box.replaceChildren(
      ...ps.map((p) => {
        const risk = p.riskPreview || { ok: true, reasons: [] };
        return el('div', { class: 'proposal' },
          el('div', { class: 'top' },
            el('span', { class: `status ${p.status}` }, p.status),
            el('strong', {}, p.agent),
            p.confidence !== null && p.confidence !== undefined ? el('span', { class: 'muted small' }, `confidence ${Math.round(p.confidence * 100)}%`) : '',
            el('span', { class: 'muted small' }, time(p.createdAt)),
          ),
          el('div', { class: 'summary' }, p.summary),
          el('div', { class: 'rationale' }, p.rationale || '(no rationale)'),
          !risk.ok ? el('div', { class: 'risk bad' }, `Risk preview: ${risk.reasons.join('; ')}`) : '',
          p.error ? el('div', { class: 'down small' }, p.error) : '',
          p.orderId ? el('div', { class: 'muted small' }, `Order ${p.orderId} · by ${p.decidedBy}`) : '',
          p.status === 'pending'
            ? el('div', { class: 'row actions' },
                el('button', { class: 'ghost small', onclick: () => decide(p, false) }, 'Reject'),
                el('button', { class: 'primary small', onclick: () => decide(p, true) }, 'Approve & execute'),
              )
            : '',
        );
      }),
    );
  }

  async function decide(p, approve) {
    if (approve) {
      const live = state.status && state.status.mode === 'live';
      const ok = await confirmDialog(
        live ? 'Execute LIVE (real money)' : 'Execute on paper',
        [el('p', {}, el('strong', {}, p.summary)), el('p', { class: 'muted' }, `Proposed by ${p.agent}. Risk checks run again at submission.`)],
        'Approve & execute',
        live,
      );
      if (!ok) return;
      try {
        await api('POST', `/api/proposals/${p.id}/approve`);
        toast('Proposal executed');
        refreshDesk();
      } catch (err) {
        toast(`${err.message}${err.details && err.details.reasons ? ': ' + err.details.reasons.join('; ') : ''}`, true);
      }
    } else {
      try {
        await api('POST', `/api/proposals/${p.id}/reject`, { reason: 'Rejected by trader' });
        toast('Proposal rejected');
      } catch (err) {
        toast(err.message, true);
      }
    }
    loadProposals();
    loadStatus();
  }

  $$('#prop-filter button').forEach((b) =>
    b.addEventListener('click', () => {
      state.propFilter = b.dataset.status;
      $$('#prop-filter button').forEach((x) => x.classList.toggle('active', x === b));
      loadProposals().catch((e) => toast(e.message, true));
    }),
  );

  // ---------- audit ----------
  async function loadAudit() {
    const rows = await api('GET', '/api/audit?limit=300');
    table(
      '#audit',
      [{ label: 'Time' }, { label: 'Event' }, { label: 'Actor' }, { label: 'Details' }],
      rows.map((r) => {
        const { ts, event, actor, agent, ...rest } = r;
        return el('tr', {},
          el('td', { class: 'muted' }, time(ts)),
          el('td', {}, event),
          el('td', {}, actor || agent || ''),
          el('td', { class: 'muted small' }, JSON.stringify(rest).slice(0, 300)),
        );
      }),
      'No events yet',
    );
  }

  // ---------- lifecycle ----------
  async function refreshDesk() {
    const jobs = [loadAccount(), loadPositions(), loadOrders(), loadStatus()];
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed && failed.reason.message !== 'Unauthorized') toast(failed.reason.message, true);
  }
  $('#refresh').addEventListener('click', () => { refreshDesk(); loadClock(); });

  let timer;
  function start() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    refreshDesk();
    loadClock();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!token || document.hidden) return;
      refreshDesk();
      if (!$('#tab-ai').hidden) loadProposals().catch(() => {});
    }, 15000);
  }

  if (token) start();
  else lock();
})();

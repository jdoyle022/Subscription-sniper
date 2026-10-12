// Click guard for capture sessions. Any click on a control whose label sounds
// destructive (cancel, confirm, downgrade...) is held until the operator decides
// in the terminal. The default answer is "block", so an accidental Enter can
// never submit a cancellation.

const RISKY = /\b(cancel|confirm|yes|end|stop|downgrade|turn off|unsubscribe)\b/i;

function guardScript(riskySource) {
  const risky = new RegExp(riskySource, 'i');
  const allowed = new WeakSet();
  const pick = (target) => target?.closest?.('button, a, [role="button"], [role="link"], input[type="submit"]');
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 120);

  window.addEventListener('click', (event) => {
    const el = pick(event.target);
    if (!el) return;
    // Keep the approval until the click's own form submission (if any) has run.
    if (allowed.has(el)) { setTimeout(() => allowed.delete(el), 0); return; }
    const text = label(el);
    if (!risky.test(text)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__sniperGuard(text).then((decision) => {
      if (decision === 'allow') { allowed.add(el); el.click(); }
    });
  }, true);

  // Pressing Enter in a form can submit without a click on a risky button.
  window.addEventListener('submit', (event) => {
    const submitter = event.submitter;
    if (submitter && allowed.has(submitter)) return;
    const text = submitter ? label(submitter) : '(form submitted with Enter)';
    if (submitter && !risky.test(text)) return;
    if (!submitter && !risky.test(event.target.innerText || '')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.__sniperGuard(text).then((decision) => {
      if (decision === 'allow' && submitter) { allowed.add(submitter); submitter.click(); }
    });
  }, true);
}

// ask(page, text) must resolve to 'allow' or 'block'.
async function installGuard(context, ask) {
  await context.exposeBinding('__sniperGuard', async (source, text) => {
    const decision = await ask(source.page, String(text));
    return decision === 'allow' ? 'allow' : 'block';
  });
  await context.addInitScript(guardScript, RISKY.source);
}

module.exports = { installGuard, RISKY };

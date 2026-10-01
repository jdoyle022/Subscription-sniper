const { manualRequired, needsReview, failedBeforeSubmission } = require('./outcomes');

// Only audited adapters implementing this contract can enter this runner.
// Existing guessed-selector scripts do not implement it and are never loaded.
function createRunner({ adapters, launchBrowser, capture = async () => null }) {
  return async function run(service, credentials, job) {
    const adapter = Object.hasOwn(adapters, service) ? adapters[service] : null;
    if (!adapter) return manualRequired(service);
    const targetId = job?.data?.targetId;
    if (!targetId || !credentials?.email || !credentials?.password) return failedBeforeSubmission();
    let browser, page, submitting = false;
    const evidence = [];
    const sameTarget = (state) => state?.targetId === targetId &&
      state?.accountEmail?.trim().toLowerCase() === credentials.email.trim().toLowerCase();
    const isCancelled = (state) => sameTarget(state) && state.autoRenew === false &&
      (state.status === 'cancelled' ||
        (state.status === 'cancellation_scheduled' && typeof state.effectiveAt === 'string' &&
          Number.isFinite(Date.parse(state.effectiveAt))));
    const confirmed = () => ({ success: true, outcome: 'confirmed', targetId, evidence,
      message: 'Cancellation verified in the selected subscription billing state.' });
    const record = async (label) => {
      try {
        const file = await capture(page, job.id, label);
        if (file) evidence.push(file);
      } catch { /* Optional diagnostics never alter a cancellation outcome. */ }
    };
    try {
      browser = await launchBrowser();
      const context = await browser.newContext();
      page = await context.newPage();
      const before = await adapter.inspect(page, credentials, targetId);
      if (!sameTarget(before)) return failedBeforeSubmission();
      if (isCancelled(before)) return confirmed();
      // Unknown terms, third-party billing, and fees are never approved implicitly.
      if (before.status !== 'active' || before.autoRenew !== true ||
          before.billingSource !== 'direct' || before.termsKnown !== true ||
          before.cancellationFee !== 0) return manualRequired(service);
      await record('before-submission');
      // Must be durable BEFORE any action that might change the subscription.
      await job.updateData({ ...job.data, operationState: 'submitting' });
      submitting = true;
      await adapter.submitCancellation(page, { targetId, accountEmail: credentials.email });
      // verify() must reload billing state; whole-page text is not evidence.
      const after = await adapter.verify(page, targetId);
      await record('after-submission');
      return isCancelled(after) ? confirmed() : { ...needsReview(), evidence };
    } catch {
      if (page) await record('failure');
      return { ...(submitting ? needsReview() : failedBeforeSubmission()), evidence };
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* Never replace the operation result. */ }
      }
    }
  };
}

module.exports = { createRunner };

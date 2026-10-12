const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

// Notion often logs in with an emailed code instead of a password; that
// case is reported as a login failure so the user cancels manually.
async function draftCancellation(page, c, ss) {
  await page.goto('https://www.notion.so/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[type="email"]', 'input[name="email"]'], c.email);
  await clickFirst(page, ['div[role="button"]:has-text("Continue")', 'button:has-text("Continue")']);
  try {
    await fillFirst(page, 'input[type="password"]', c.password, 8000);
  } catch {
    return { success: false, manual: true, message: 'Notion asked for an emailed login code instead of a password — cancel manually.' };
  }
  await clickFirst(page, ['div[role="button"]:has-text("Continue with password")', 'button:has-text("Continue")']);
  if (!(await waitForLeave(page, /\/login/))) return loginFailed('Notion');

  // Billing lives in the Settings modal of the current workspace.
  await clickFirst(page, ['div[role="button"]:has-text("Settings")', 'a:has-text("Settings")'], 15000);
  await clickFirst(page, ['div[role="button"]:has-text("Billing")', 'div[role="tab"]:has-text("Billing")']);
  await ss(page, 'notion-billing');
  await clickFirst(page, ['div[role="button"]:has-text("Downgrade")', 'div[role="button"]:has-text("Cancel plan")', 'button:has-text("Downgrade")']);
  await tryClick(page, ['div[role="button"]:has-text("Continue")', 'button:has-text("Continue")']);
  await clickFirst(page, ['div[role="button"]:has-text("Downgrade")', 'div[role="button"]:has-text("Confirm")', 'button:has-text("Confirm")']);
  await ss(page, 'notion-done');

  if (!(await pageSays(page, /has been downgraded|cancel(l)?ed|free plan/))) return unconfirmed('Notion');
  return { success: true, message: 'Notion plan downgraded to Free at the end of the billing period.' };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('notion'); }
module.exports = { cancel };

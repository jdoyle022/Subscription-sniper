const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

async function draftCancellation(page, c, ss) {
  await page.goto('https://www.disneyplus.com/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[type="email"]', '#email'], c.email);
  await clickFirst(page, ['button:has-text("Continue")', 'button[type="submit"]']);
  await fillFirst(page, ['input[type="password"]', '#password'], c.password);
  await clickFirst(page, ['button:has-text("Log In")', 'button[type="submit"]']);
  if (!(await waitForLeave(page, /\/login|\/identity/))) return loginFailed('Disney+');

  await tryClick(page, '[data-testid="profile-avatar-0"], [data-testid="selectProfile"]', 3000);
  await page.goto('https://www.disneyplus.com/account', { waitUntil: 'domcontentloaded' });
  await ss(page, 'disney-account');

  // Bundles show the subscription as a link; pick the Disney+ one.
  await clickFirst(page, ['a:has-text("Disney+")', 'button:has-text("Disney+")', '[data-testid="subscription-card"]']);
  await clickFirst(page, ['a:has-text("Cancel Subscription")', 'button:has-text("Cancel Subscription")']);
  await tryClick(page, 'input[type=radio], [role=radio]', 2000);
  await clickFirst(page, ['button:has-text("Complete Cancellation")', 'button:has-text("Confirm")']);
  await ss(page, 'disney-done');

  if (!(await pageSays(page, /cancel(l)?ed|subscription (will )?end/))) return unconfirmed('Disney+');
  return { success: true, message: 'Disney+ cancelled. Access continues until end of billing period.' };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('disney'); }
module.exports = { cancel };

const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

// NordVPN cancellation = turning off auto-renewal in Nord Account.
async function draftCancellation(page, c, ss) {
  await page.goto('https://my.nordaccount.com/login/', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[name="identifier"]', 'input[type="email"]'], c.email);
  await clickFirst(page, ['button:has-text("Continue")', 'button[type="submit"]']);
  await fillFirst(page, ['input[name="password"]', 'input[type="password"]'], c.password);
  await clickFirst(page, ['button:has-text("Log in")', 'button[type="submit"]']);
  if (!(await waitForLeave(page, /\/login|nordaccount\.com\/oauth/))) return loginFailed('NordVPN');

  await page.goto('https://my.nordaccount.com/billing/my-subscriptions/', { waitUntil: 'domcontentloaded' });
  await ss(page, 'nordvpn-subscriptions');
  await clickFirst(page, ['button:has-text("Cancel automatic payments")', 'a:has-text("Cancel automatic payments")', 'button:has-text("Turn off auto-renewal")']);
  for (let i = 0; i < 3; i++) {
    if (!(await tryClick(page, ['button:has-text("Cancel automatic payments")', 'button:has-text("Continue")', 'button:has-text("No thanks")']))) break;
  }
  await ss(page, 'nordvpn-done');

  if (!(await pageSays(page, /auto(matic)?[- ]?(payments?|renewal) (is |are )?(off|cancel(l)?ed|turned off)|will not renew/))) return unconfirmed('NordVPN');
  return { success: true, message: 'NordVPN auto-renewal turned off. Service continues until the paid period ends.' };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('nordvpn'); }
module.exports = { cancel };

const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

// Only works for Super/Max bought on the web. App Store / Google Play
// subscriptions have to be cancelled on the device.
async function draftCancellation(page, c, ss) {
  await page.goto('https://www.duolingo.com/?isLoggingIn=true', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[data-test="email-input"]', 'input[type="email"]', 'input[name="identifier"]'], c.email);
  await fillFirst(page, ['input[data-test="password-input"]', 'input[type="password"]'], c.password);
  await clickFirst(page, ['button[data-test="register-button"]', 'button:has-text("Log in")']);
  if (!(await waitForLeave(page, /isLoggingIn|\/log-in/))) return loginFailed('Duolingo');

  await page.goto('https://www.duolingo.com/settings/subscription', { waitUntil: 'domcontentloaded' });
  await ss(page, 'duolingo-subscription');

  if (await pageSays(page, /app store|google play|itunes/, 2000)) {
    return { success: false, manual: true, message: 'This Duolingo subscription is billed through Apple or Google — cancel it on your device.' };
  }

  await clickFirst(page, ['button:has-text("Cancel subscription")', 'a:has-text("Cancel subscription")', 'button:has-text("Cancel")']);
  await tryClick(page, ['button:has-text("Continue")', 'button:has-text("No thanks")']);
  await clickFirst(page, ['button:has-text("Cancel subscription")', 'button:has-text("Confirm")']);
  await ss(page, 'duolingo-done');

  if (!(await pageSays(page, /cancel(l)?ed|will not renew|ends on/))) return unconfirmed('Duolingo');
  return { success: true, message: 'Duolingo subscription cancelled. Access continues until end of billing period.' };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('duolingo'); }
module.exports = { cancel };

const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

async function cancel(page, c, ss) {
  await page.goto('https://www.grammarly.com/signin', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[name="email"]', 'input[type="email"]'], c.email);
  await tryClick(page, 'button:has-text("Continue")', 3000);
  await fillFirst(page, ['input[name="password"]', 'input[type="password"]'], c.password);
  await clickFirst(page, ['button:has-text("Sign in")', 'button:has-text("Log in")', 'button[type="submit"]']);
  if (!(await waitForLeave(page, /\/signin/))) return loginFailed('Grammarly');

  await page.goto('https://account.grammarly.com/subscription', { waitUntil: 'domcontentloaded' });
  await ss(page, 'grammarly-subscription');

  if (await pageSays(page, /app store|google play|itunes/, 2000)) {
    return { success: false, manual: true, message: 'This Grammarly subscription is billed through Apple or Google — cancel it on your device.' };
  }

  await clickFirst(page, ['a:has-text("Cancel Subscription")', 'button:has-text("Cancel Subscription")']);
  for (let i = 0; i < 3; i++) {
    if (!(await tryClick(page, ['button:has-text("Continue to cancel")', 'button:has-text("No thanks")', 'button:has-text("Continue")']))) break;
  }
  await tryClick(page, 'input[type=radio], [role=radio]', 2000);
  await clickFirst(page, ['button:has-text("Cancel Subscription")', 'button:has-text("Confirm")']);
  await ss(page, 'grammarly-done');

  if (!(await pageSays(page, /cancel(l)?ed|will not renew|access until/))) return unconfirmed('Grammarly');
  return { success: true, message: 'Grammarly subscription cancelled. Premium continues until end of billing period.' };
}

module.exports = { cancel };

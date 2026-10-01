const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

async function cancel(page, c, ss) {
  await page.goto('https://auth.hulu.com/web/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[name="email"]', 'input[type="email"]'], c.email);
  await tryClick(page, 'button:has-text("Continue")', 3000);
  await fillFirst(page, ['input[name="password"]', 'input[type="password"]'], c.password);
  await clickFirst(page, ['button:has-text("Log In")', 'button[type="submit"]']);
  if (!(await waitForLeave(page, /auth\.hulu\.com|\/login/))) return loginFailed('Hulu');

  await tryClick(page, '[data-testid="profile-link"], .profile-link', 3000);
  await page.goto('https://secure.hulu.com/account/cancel', { waitUntil: 'domcontentloaded' });
  await ss(page, 'hulu-cancel');

  // Hulu walks through survey and offer screens before the final button.
  for (let i = 0; i < 4; i++) {
    if (!(await tryClick(page, ['button:has-text("Continue to Cancel")', 'button:has-text("No thanks")', 'a:has-text("Continue to Cancel")']))) break;
  }
  await clickFirst(page, ['button:has-text("Cancel Subscription")', 'button:has-text("Yes, Cancel")']);
  await ss(page, 'hulu-done');

  if (!(await pageSays(page, /cancel(l)?ed|subscription (will )?end/))) return unconfirmed('Hulu');
  return { success: true, message: 'Hulu cancelled. Access continues until end of billing period.' };
}

module.exports = { cancel };

const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

// Canva usually logs in with an emailed code; that case is reported for
// manual cancellation rather than guessed at.
async function cancel(page, c, ss) {
  await page.goto('https://www.canva.com/login', { waitUntil: 'domcontentloaded' });
  await tryClick(page, ['button:has-text("Continue with email")', 'button:has-text("Continue another way")'], 5000);
  await fillFirst(page, ['input[type="email"]', 'input[name="email"]'], c.email);
  await clickFirst(page, ['button:has-text("Continue")', 'button[type="submit"]']);
  try {
    await fillFirst(page, 'input[type="password"]', c.password, 8000);
  } catch {
    return { success: false, manual: true, message: 'Canva asked for an emailed login code instead of a password — cancel manually.' };
  }
  await clickFirst(page, ['button:has-text("Log in")', 'button:has-text("Continue")']);
  if (!(await waitForLeave(page, /\/login/))) return loginFailed('Canva');

  await page.goto('https://www.canva.com/settings/billing-and-teams', { waitUntil: 'domcontentloaded' });
  await ss(page, 'canva-billing');
  await clickFirst(page, ['button:has-text("Cancel subscription")', 'button:has-text("Cancel plan")', 'button[aria-label*="options" i]']);
  await tryClick(page, ['button:has-text("Cancel subscription")', 'span:has-text("Cancel subscription")'], 3000);
  for (let i = 0; i < 3; i++) {
    if (!(await tryClick(page, ['button:has-text("Continue cancellation")', 'button:has-text("No thanks")', 'button:has-text("Continue")']))) break;
  }
  await clickFirst(page, ['button:has-text("Cancel subscription")', 'button:has-text("Confirm")']);
  await ss(page, 'canva-done');

  if (!(await pageSays(page, /cancel(l)?ed|will (end|expire)|access until/))) return unconfirmed('Canva');
  return { success: true, message: 'Canva subscription cancelled. Pro continues until end of billing period.' };
}

module.exports = { cancel };

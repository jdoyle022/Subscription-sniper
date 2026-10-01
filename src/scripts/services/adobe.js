const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, unconfirmed } = require('../helpers');

async function draftCancellation(page, creds, screenshot) {
  await page.goto('https://account.adobe.com/plans', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await screenshot(page, 'adobe-01-plans');

  if (/auth\.services\.adobe|login/.test(page.url())) {
    await fillFirst(page, ['input[name=email]', 'input[type=email]'], creds.email);
    await clickFirst(page, 'button:has-text("Continue")', 8000);
    await fillFirst(page, 'input[type=password]', creds.password);
    await clickFirst(page, ['button:has-text("Sign in")', 'button:has-text("Continue")'], 8000);
    await screenshot(page, 'adobe-02-signed-in');

    const err = await page.$('[data-id=ErrorBanner], .error-message');
    if (err) return { success: false, message: 'Adobe login failed: ' + (await err.textContent()).trim() };
    if (!(await waitForLeave(page, /auth\.services\.adobe|\/login/))) {
      return { success: false, message: 'Adobe login did not complete (2FA or captcha?). Cancel manually.' };
    }
    if (!page.url().includes('account.adobe.com')) {
      await page.goto('https://account.adobe.com/plans', { waitUntil: 'domcontentloaded' });
    }
  }

  await screenshot(page, 'adobe-03-plans');
  await clickFirst(page, ['button:has-text("Manage plan")', 'a:has-text("Manage plan")'], 12000);
  await screenshot(page, 'adobe-04-manage');
  await clickFirst(page, ['button:has-text("Cancel your plan")', 'button:has-text("Cancel plan")']);
  await screenshot(page, 'adobe-05-cancel');
  await clickFirst(page, ['button:has-text("Continue to cancel")', 'button:has-text("Continue")']);

  // Optional "why are you leaving" survey.
  const reason = await page.$('input[type=radio], [role=radio]');
  if (reason) {
    await reason.click();
    await tryClick(page, ['button:has-text("Continue")', 'button:has-text("Next")']);
  }

  // Adobe may show one or more retention offers before the final confirm.
  for (let i = 0; i < 3; i++) {
    if (!(await tryClick(page, ['button:has-text("No thanks")', 'button:has-text("Continue to cancel")'], 3000))) break;
  }

  await screenshot(page, 'adobe-06-confirm-screen');
  await clickFirst(page, ['button:has-text("Confirm cancellation")', 'button:has-text("Confirm")']);
  await screenshot(page, 'adobe-07-done');

  if (!(await pageSays(page, /cancel(l)?ed|cancellation (is )?(confirmed|complete)/))) return unconfirmed('Adobe');
  return {
    success: true,
    message: 'Adobe plan cancelled. Access continues until end of your billing period. Check your email for Adobe confirmation.',
  };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('adobe'); }
module.exports = { cancel };

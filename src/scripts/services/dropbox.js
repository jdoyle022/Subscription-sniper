const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

// Cancelling Dropbox downgrades the account to Basic (free) at period end.
async function draftCancellation(page, c, ss) {
  await page.goto('https://www.dropbox.com/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, ['input[name="login_email"]', 'input[type="email"]'], c.email);
  await tryClick(page, 'button:has-text("Continue")', 3000);
  await fillFirst(page, ['input[name="login_password"]', 'input[type="password"]'], c.password);
  await clickFirst(page, ['button:has-text("Log in")', 'button[type="submit"]']);
  if (!(await waitForLeave(page, /\/login/))) return loginFailed('Dropbox');

  await page.goto('https://www.dropbox.com/account/plan', { waitUntil: 'domcontentloaded' });
  await ss(page, 'dropbox-plan');
  await clickFirst(page, ['a:has-text("Cancel plan")', 'button:has-text("Cancel plan")']);
  for (let i = 0; i < 3; i++) {
    if (!(await tryClick(page, ['button:has-text("I still want to cancel")', 'button:has-text("Continue")', 'button:has-text("No thanks")']))) break;
  }
  await tryClick(page, 'input[type=radio], [role=radio]', 2000);
  await clickFirst(page, ['button:has-text("Cancel plan")', 'button:has-text("Confirm")']);
  await ss(page, 'dropbox-done');

  if (!(await pageSays(page, /cancel(l)?ed|downgrade(d)? to basic|will (be )?downgrade/))) return unconfirmed('Dropbox');
  return { success: true, message: 'Dropbox plan cancelled. Account moves to Basic at the end of the billing period.' };
}

// Quarantined draft: never invoke until replaced by an audited target-aware adapter.
const { manualRequired } = require('../outcomes');
async function cancel() { return manualRequired('dropbox'); }
module.exports = { cancel };

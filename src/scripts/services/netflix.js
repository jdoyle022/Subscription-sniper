const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

async function cancel(page, c, ss) {
  await page.goto('https://www.netflix.com/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, '[name="userLoginId"]', c.email);
  await fillFirst(page, '[name="password"]', c.password);
  await page.click('[type="submit"]');
  if (!(await waitForLeave(page, /\/login/))) return loginFailed('Netflix');

  // Profile picker can appear after login; pick the first profile.
  await tryClick(page, '.profile-link, [data-uia="profile-link"]', 3000);

  await page.goto('https://www.netflix.com/cancelplan', { waitUntil: 'domcontentloaded' });
  await ss(page, 'netflix-cancel');
  await clickFirst(page, ['button:has-text("Cancel Membership")', 'a:has-text("Cancel Membership")']);
  await tryClick(page, ['button:has-text("Finish Cancellation")', 'button:has-text("Complete Cancellation")']);
  await ss(page, 'netflix-done');

  if (!(await pageSays(page, /cancel(l)?ed|membership (will )?end|we'?re sorry to see you go/))) return unconfirmed('Netflix');
  return { success: true, message: 'Netflix cancelled. Access continues until end of billing period.' };
}

module.exports = { cancel };

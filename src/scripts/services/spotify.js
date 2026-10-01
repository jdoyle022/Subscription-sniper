const { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed } = require('../helpers');

async function cancel(page, c, ss) {
  await page.goto('https://accounts.spotify.com/login', { waitUntil: 'domcontentloaded' });
  await fillFirst(page, '#login-username', c.email);
  await fillFirst(page, '#login-password', c.password);
  await page.click('#login-button');
  if (!(await waitForLeave(page, /\/login/))) return loginFailed('Spotify');

  await page.goto('https://www.spotify.com/account/subscription/', { waitUntil: 'domcontentloaded' });
  await ss(page, 'spotify-subscription');
  await clickFirst(page, ['a:has-text("Change Plan")', 'button:has-text("Change Plan")', 'a:has-text("Cancel subscription")']);
  await clickFirst(page, ['button:has-text("Cancel Premium")', 'a:has-text("Cancel Premium")', 'button:has-text("Cancel subscription")']);
  await tryClick(page, ['button:has-text("Confirm")', 'button:has-text("Yes, cancel")', 'button:has-text("Continue to cancel")']);
  await ss(page, 'spotify-done');

  if (!(await pageSays(page, /cancel(l)?ed|switch(ed)? to (spotify )?free|premium (will )?end/))) return unconfirmed('Spotify');
  return { success: true, message: 'Spotify Premium cancelled. Reverts to free plan.' };
}

module.exports = { cancel };

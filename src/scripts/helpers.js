// Shared Playwright helpers for the per-service cancellation scripts.

function anyOf(selectors) {
  return Array.isArray(selectors) ? selectors.join(', ') : selectors;
}

// Waits for the first matching element and clicks it. Throws if none appears.
async function clickFirst(page, selectors, timeout = 10000) {
  const el = await page.waitForSelector(anyOf(selectors), { timeout, state: 'visible' });
  await el.click();
  await page.waitForTimeout(1500);
}

// Clicks the first matching element if it shows up; returns whether it did.
async function tryClick(page, selectors, timeout = 4000) {
  try {
    await clickFirst(page, selectors, timeout);
    return true;
  } catch {
    return false;
  }
}

async function fillFirst(page, selectors, value, timeout = 10000) {
  const el = await page.waitForSelector(anyOf(selectors), { timeout, state: 'visible' });
  await el.fill(value);
}

// Waits until the URL no longer matches `loginPattern`. Returns false on timeout,
// which callers treat as a failed login (bad password, 2FA or a captcha).
async function waitForLeave(page, loginPattern, timeout = 20000) {
  try {
    await page.waitForURL((url) => !loginPattern.test(url.href), { timeout });
    return true;
  } catch {
    return false;
  }
}

// Looks for confirmation text on the page after the final click.
async function pageSays(page, pattern, timeout = 8000) {
  try {
    await page.waitForFunction((src) => new RegExp(src, 'i').test(document.body.innerText), pattern.source, {
      timeout,
    });
    return true;
  } catch {
    return false;
  }
}

function loginFailed(name) {
  return {
    success: false,
    message: `${name} login failed. Check the credentials, or the account may need 2FA or a captcha — cancel manually.`,
  };
}

function unconfirmed(name) {
  return {
    success: false,
    needsReview: true,
    message: `Went through the ${name} cancel flow but could not confirm it finished. Check the screenshots or your ${name} account.`,
  };
}

module.exports = { clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed };

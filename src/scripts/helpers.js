// Shared Playwright helpers for the per-service cancellation scripts.

function anyOf(selectors) {
  return Array.isArray(selectors) ? selectors.join(', ') : selectors;
}

// Require a single visible match. Selector alternatives form a union, not
// a priority list. Destructive adapters must pass a target-scoped locator here.
async function uniqueVisible(scope, selectors, timeout = 10000) {
  const matches = scope.locator(anyOf(selectors));
  const deadline = Date.now() + timeout;
  do {
    const visible = [];
    for (let i = 0, n = await matches.count(); i < n; i++) {
      const candidate = matches.nth(i);
      if (await candidate.isVisible()) visible.push(candidate);
    }
    if (visible.length > 1) {
      const err = new Error('Ambiguous selector; manual review required');
      err.code = 'SELECTOR_AMBIGUOUS';
      throw err;
    }
    if (visible.length === 1) return visible[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const err = new Error('Required control not found');
  err.code = 'SELECTOR_MISSING';
  throw err;
}

async function clickFirst(scope, selectors, timeout = 10000) {
  const el = await uniqueVisible(scope, selectors, timeout);
  await el.click({ timeout });
}

// Only absence is optional. A failed click may have changed the account;
// ambiguity or dispatch errors must propagate to the guarded runner.
async function tryClick(scope, selectors, timeout = 4000) {
  let el;
  try {
    el = await uniqueVisible(scope, selectors, timeout);
  } catch (err) {
    if (err.code === 'SELECTOR_MISSING') return false;
    throw err;
  }
  await el.click({ timeout });
  return true;
}

async function fillFirst(scope, selectors, value, timeout = 10000) {
  const el = await uniqueVisible(scope, selectors, timeout);
  await el.fill(value, { timeout });
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

module.exports = { uniqueVisible, clickFirst, tryClick, fillFirst, waitForLeave, pageSays, loginFailed, unconfirmed };

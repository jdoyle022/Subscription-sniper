async function cancel(page, creds, screenshot) {
  try {
    await page.goto("https://account.adobe.com/plans", { waitUntil: "domcontentloaded", timeout: 20000 });
    await screenshot(page, "adobe-01-plans");

    if (page.url().includes("auth.services.adobe") || page.url().includes("login")) {
      const emailField = await page.waitForSelector("input[name=email], input[type=email]", { timeout: 10000 });
      await emailField.fill(creds.email);
      const cont1 = await page.waitForSelector("button:has-text(\"Continue\")", { timeout: 8000 });
      await cont1.click();
      await page.waitForTimeout(2000);
      const pwField = await page.waitForSelector("input[type=password]", { timeout: 10000 });
      await pwField.fill(creds.password);
      await screenshot(page, "adobe-02-password");
      const signIn = await page.waitForSelector("button:has-text(\"Sign in\"), button:has-text(\"Continue\")", { timeout: 8000 });
      await signIn.click();
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });
      await screenshot(page, "adobe-03-signed-in");
      const err = await page.$("[data-id=ErrorBanner], .error-message");
      if (err) return { success: false, message: "Login failed: " + (await err.textContent()).trim() };
      if (!page.url().includes("account.adobe.com")) await page.goto("https://account.adobe.com/plans", { waitUntil: "domcontentloaded" });
    }

    await page.waitForTimeout(2000);
    await screenshot(page, "adobe-04-plans");
    const manageBtn = await page.waitForSelector("button:has-text(\"Manage plan\"), a:has-text(\"Manage plan\")", { timeout: 12000 });
    await manageBtn.click();
    await page.waitForTimeout(2000);
    await screenshot(page, "adobe-05-manage");

    const cancelBtn = await page.waitForSelector("button:has-text(\"Cancel your plan\"), button:has-text(\"Cancel plan\")", { timeout: 10000 });
    await cancelBtn.click();
    await page.waitForTimeout(2000);
    await screenshot(page, "adobe-06-cancel");

    const contBtn = await page.waitForSelector("button:has-text(\"Continue to cancel\"), button:has-text(\"Continue\")", { timeout: 10000 });
    await contBtn.click();
    await page.waitForTimeout(2000);
    await screenshot(page, "adobe-07-continue");

    try {
      const reason = await page.$("input[type=radio], [role=radio]");
      if (reason) { await reason.click(); await page.waitForTimeout(500); }
      const rc = await page.waitForSelector("button:has-text(\"Continue\"), button:has-text(\"Next\")", { timeout: 5000 });
      await rc.click();
      await page.waitForTimeout(2000);
    } catch(e) {}

    await screenshot(page, "adobe-08-confirm-screen");
    const confirmBtn = await page.waitForSelector("button:has-text(\"Confirm cancellation\"), button:has-text(\"Confirm\")", { timeout: 10000 });
    await confirmBtn.click();
    await page.waitForTimeout(3000);
    await screenshot(page, "adobe-09-done");

    return {
      success: true,
      message: "Adobe plan cancelled. Access continues until end of your billing period. Check your email for Adobe confirmation."
    };
  } catch(err) {
    throw new Error("Adobe script error: " + err.message);
  }
}
module.exports = { cancel };

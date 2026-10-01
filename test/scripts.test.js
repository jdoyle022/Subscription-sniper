require('./setup-env');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { SERVICES, isSupported, runCancellation, launchBrowser } = require('../src/scripts');
const helpers = require('../src/scripts/helpers');

test('every registered service has a script with cancel()', () => {
  for (const file of new Set(Object.values(SERVICES))) {
    assert.strictEqual(typeof require(`../src/scripts/services/${file}`).cancel, 'function', file);
  }
});

test('every script file is registered', () => {
  const files = fs.readdirSync(path.join(__dirname, '../src/scripts/services')).map((f) => f.replace(/\.js$/, ''));
  for (const f of files) assert.ok(Object.values(SERVICES).includes(f), `${f} not registered`);
});

test('aliases and case', () => {
  assert.ok(isSupported('Disney+'));
  assert.ok(isSupported(' ADOBE '));
  assert.ok(!isSupported('toString'));
});

test('unsupported service and missing credentials short-circuit', async () => {
  assert.strictEqual((await runCancellation('myspace', null)).manual, true);
  assert.strictEqual((await runCancellation('netflix', null)).outcome, 'manual_required');
});

// Drives the shared helpers against a local page in real Chromium.
// Set SKIP_BROWSER_TESTS=1 where no Chromium is installed.
test('helpers work in a real browser', { skip: !!process.env.SKIP_BROWSER_TESTS }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <input id="email"><button id="next" onclick="document.body.insertAdjacentHTML('beforeend','<p>Your plan is cancelled.</p>')">Cancel plan</button>`);
    await helpers.fillFirst(page, ['#missing', '#email'], 'a@b.c');
    assert.strictEqual(await page.inputValue('#email'), 'a@b.c');
    assert.strictEqual(await helpers.tryClick(page, 'button:has-text("Nope")', 500), false);
    assert.strictEqual(await helpers.pageSays(page, /cancel(l)?ed/, 500), false);
    await helpers.clickFirst(page, ['button:has-text("Cancel plan")']);
    assert.strictEqual(await helpers.pageSays(page, /cancel(l)?ed/), true);
  } finally {
    await browser.close();
  }
});

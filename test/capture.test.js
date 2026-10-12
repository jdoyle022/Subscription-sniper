const test = require('node:test');
const assert = require('node:assert');
const { redactText } = require('../tools/capture/redact');
const { sanitizeDocument } = require('../tools/capture/sanitize');
const { installGuard } = require('../tools/capture/guard');
const { parseArgs } = require('../tools/capture/capture');

test('redacts emails, card tails, long numbers and extra terms', () => {
  const out = redactText('Jane Q <jane.q@example.com> card •••• 4242, ending in 1234, call +1 (555) 123-4567. Jane Q pays $11.99 on 12/03/2026', ['jane q']);
  assert.doesNotMatch(out, /example\.com|4242|1234|555/);
  assert.doesNotMatch(out, /jane q/i);
  assert.match(out, /\$11\.99/);
  assert.match(out, /12\/03\/2026/);
});

test('redacts brand card tails and aria URL queries', () => {
  const out = redactText('- paragraph: Visa â€¢â€¢â€¢â€¢ 4242 and Mastercard ending 5555\n  - /url: /account/subscription/?flow=abc#x', []);
  assert.doesNotMatch(out, /4242|5555|flow=abc/);
  assert.match(out, /\/url: \/account\/subscription\//);
});

test('parses capture arguments', () => {
  assert.deepStrictEqual(parseArgs(['Spotify', '--redact', 'Jane', '--screenshots']), { service: 'spotify', redact: ['Jane'], screenshots: true, startUrl: null });
});

test('sanitize and click guard work in a real browser', { skip: !!process.env.SKIP_BROWSER_TESTS }, async () => {
  const { launchBrowser } = require('../src/scripts');
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const asked = [];
    let answer = 'block';
    await installGuard(context, async (_page, text) => { asked.push(text); return answer; });
    const page = await context.newPage();
    // A real navigation, like the capture tool does (setContent skips init scripts).
    await page.route('https://capture.test/**', (route) => (new URL(route.request().url()).pathname !== '/'
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'text/html', body: `
      <script>window.secret = 1</script>
      <form><input type="hidden" name="csrf" value="tok123"><input name="email" value="me@x.com"></form>
      <a href="https://example.com/account?session=abc#frag" data-token="${'z'.repeat(60)}" data-testid="plan-link">Plan</a>
      <button id="next" onclick="document.body.dataset.next=1">Change plan</button>
      <button id="final" onclick="document.body.dataset.cancelled=1">Cancel Premium</button>
      <form id="f" onsubmit="event.preventDefault(); document.body.dataset.submitted=1"><button id="confirm">Confirm</button></form>` })));
    await page.goto('https://capture.test/');

    const html = await page.evaluate(sanitizeDocument);
    assert.doesNotMatch(html, /tok123|me@x\.com|session=abc|window\.secret|zzzz|onclick/);
    assert.match(html, /href="https:\/\/example\.com\/account"/);
    assert.match(html, /data-testid="plan-link"/);

    // A harmless button goes straight through without asking.
    await page.click('#next');
    assert.strictEqual(await page.evaluate(() => document.body.dataset.next), '1');
    assert.deepStrictEqual(asked, []);

    // A risky button is held and blocked by default.
    await page.click('#final');
    await page.waitForTimeout(200);
    assert.deepStrictEqual(asked, ['Cancel Premium']);
    assert.strictEqual(await page.evaluate(() => document.body.dataset.cancelled), undefined);

    // Only an explicit allow lets it through.
    answer = 'allow';
    await page.click('#final');
    await page.waitForFunction(() => document.body.dataset.cancelled === '1');

    // Form submit buttons: blocked by default, and one allow is enough to submit.
    answer = 'block';
    await page.click('#confirm');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.body.dataset.submitted), undefined);
    answer = 'allow';
    asked.length = 0;
    await page.click('#confirm');
    await page.waitForFunction(() => document.body.dataset.submitted === '1');
    assert.deepStrictEqual(asked, ['Confirm']);
  } finally {
    await browser.close();
  }
});

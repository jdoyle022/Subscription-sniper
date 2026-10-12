#!/usr/bin/env node
// Records a service's real account and cancel pages so an adapter can be written
// against them. YOU drive the browser: log in, then click through the cancel
// flow. Risky clicks are held for your decision in this terminal, and the final
// confirmation must stay blocked. Nothing here cancels anything by itself.
//
//   npm run capture -- spotify [--redact "Your Name"] [--screenshots] [--start-url URL]

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const { redactText } = require('./redact');
const { sanitizeDocument } = require('./sanitize');
const { installGuard } = require('./guard');

const START_URLS = {
  spotify: 'https://www.spotify.com/account/overview/',
};

function parseArgs(argv) {
  const opts = { service: null, redact: [], screenshots: false, startUrl: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--redact') opts.redact.push(argv[++i] || '');
    else if (a === '--screenshots') opts.screenshots = true;
    else if (a === '--start-url') opts.startUrl = argv[++i] || null;
    else if (!a.startsWith('-') && !opts.service) opts.service = a.toLowerCase();
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startUrl = opts.startUrl || START_URLS[opts.service];
  if (!opts.service || !startUrl) {
    console.error(`Usage: npm run capture -- <service>   (supported: ${Object.keys(START_URLS).join(', ')})`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '../../captures', `${opts.service}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Each terminal line answers the oldest held click, if any; otherwise it is a
  // capture command. Held clicks default to "block".
  const held = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  let step = 0;
  const index = [];
  let capturing = Promise.resolve();
  let page = null; // first tab
  let current = null; // tab the operator used most recently
  let ready = false;

  async function capture(page, rawLabel) {
    const label = redactText(rawLabel, opts.redact);
    step += 1;
    const name = `${String(step).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 50) || 'page'}`;
    const url = new URL(page.url());
    const html = redactText(await page.evaluate(sanitizeDocument), opts.redact);
    const aria = redactText(await page.locator('body').ariaSnapshot(), opts.redact);
    const write = (file, data) => fs.writeFileSync(path.join(outDir, file), data, { mode: 0o600 });
    write(`${name}.html`, html);
    write(`${name}.aria.yml`, aria);
    if (opts.screenshots) {
      write(`${name}.png`, await page.screenshot({ fullPage: true, mask: [page.locator('input, textarea')] }));
    }
    index.push({ step, label, url: `${url.origin}${url.pathname}`, title: redactText(await page.title(), opts.redact) });
    write('index.json', JSON.stringify(index, null, 2));
    console.log(`  ✓ saved ${name}`);
  }
  const safeCapture = (page, label) => {
    capturing = capturing.then(() => capture(page, label)).catch((e) => console.log(`  (capture failed: ${e.message})`));
    return capturing;
  };

  function prompt() {
    if (held.length) {
      console.log(`\n⚠  The page wants to click: "${held[0].text}"`);
      console.log('   Is this the FINAL button that would actually cancel? If so, press Enter to BLOCK it.');
      rl.setPrompt('   Type "allow" only if it just moves to the next step: ');
    } else {
      rl.setPrompt('capture> ');
    }
    rl.prompt();
  }

  rl.on('line', async (line) => {
    const cmd = line.trim();
    if (!ready) {
      console.log('  (browser still starting, try again in a moment)');
      return;
    }
    if (held.length) {
      const allow = cmd.toLowerCase() === 'allow';
      console.log(allow ? '   → allowed' : '   → blocked');
      held.shift().resolve(allow ? 'allow' : 'block');
    } else if (cmd === 'q' || cmd === 'quit') {
      finish();
      return;
    } else {
      await safeCapture(current || page, cmd || 'page');
    }
    prompt();
  });

  const browser = await chromium.launch({ headless: false, executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.on('page', (p) => { current = p; p.on('framenavigated', () => { current = p; }); });

  await installGuard(context, async (heldPage, text) => {
    await safeCapture(heldPage, `before-${text}`);
    return new Promise((resolve) => {
      held.push({ text, resolve });
      if (held.length === 1) prompt();
    });
  });

  page = await context.newPage();
  current = page;
  await page.goto(startUrl);
  ready = true;

  console.log(`
Capturing ${opts.service}. Saving to ${outDir}

  1. Log in to your account in the browser window.
  2. Go to your subscription/plan page, then click through the cancel steps.
  3. Press Enter here (or type a label, then Enter) to save the page you are on.
     Save every distinct screen: the plan page, each cancel step, any offers.
  4. When you reach the final "confirm cancellation" screen, save it and STOP.
     Do not let the final click through.
  5. Type q and Enter to finish.
`);
  prompt();
  await finished;
  await capturing;
  for (const h of held.splice(0)) h.resolve('block');

  rl.close();
  await browser.close();
  console.log(`
Done: ${index.length} page(s) saved in
  ${outDir}

Before sending:
  • Open the .html and .aria.yml files and look for anything personal the
    automatic redaction missed (your name, address, plan family members).
    Re-run with --redact "text" to scrub specific words.
  • Send the files by uploading them in the Claude chat.
  • Do NOT commit them to git. captures/ is in .gitignore for that reason.
`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, START_URLS };

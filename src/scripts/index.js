const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, '../../screenshots');

// Service name -> script module. Aliases map to the same file.
const SERVICES = {
  adobe: 'adobe',
  canva: 'canva',
  'disney+': 'disney',
  disney: 'disney',
  disneyplus: 'disney',
  dropbox: 'dropbox',
  duolingo: 'duolingo',
  grammarly: 'grammarly',
  hulu: 'hulu',
  netflix: 'netflix',
  nordvpn: 'nordvpn',
  notion: 'notion',
  spotify: 'spotify',
};

function normalizeService(name) {
  return String(name || '').toLowerCase().trim();
}

function isSupported(name) {
  return Object.hasOwn(SERVICES, normalizeService(name));
}

async function screenshot(page, label) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: file });
    return file;
  } catch {
    return null;
  }
}

async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch({
    headless: true,
    // Optional: use a system Chromium instead of Playwright's download.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
}

async function runCancellation(service, credentials, job) {
  const key = normalizeService(service);
  if (!isSupported(key)) {
    return { success: false, manual: true, message: `No script for ${service} yet — cancel manually.` };
  }
  if (!credentials?.email || !credentials?.password) {
    return { success: false, message: `Credentials required for ${service}.` };
  }

  const script = require(`./services/${SERVICES[key]}`);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await job?.updateProgress?.(30);
    const result = await script.cancel(page, credentials, screenshot);
    await job?.updateProgress?.(90);
    return result;
  } catch (err) {
    return { success: false, message: `Failed: ${err.message}` };
  } finally {
    await browser.close();
  }
}

module.exports = { runCancellation, launchBrowser, isSupported, normalizeService, SERVICES };

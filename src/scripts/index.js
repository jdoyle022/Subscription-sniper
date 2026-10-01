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
  const key = String(name || '').toLowerCase().trim();
  return ['disney+', 'disneyplus'].includes(key) ? 'disney' : key;
}

function isSupported(name) {
  return Object.hasOwn(SERVICES, normalizeService(name));
}

async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch({
    headless: true,
    // Optional: use a system Chromium instead of Playwright's download.
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-dev-shm-usage'],
  });
}

// Empty deliberately: no adapter has live validation evidence. Environment
// variables cannot enable guessed selectors. Promotion requires a reviewed adapter
// implementing inspect / submitCancellation / verify with a specific target.
const VALIDATED_ADAPTERS = Object.freeze({});
const { createRunner } = require('./runner');
const { screenshot } = require('./artifacts');
const run = createRunner({ adapters: VALIDATED_ADAPTERS, launchBrowser, capture: screenshot });

function isEnabled(name) {
  return Object.hasOwn(VALIDATED_ADAPTERS, normalizeService(name));
}

async function runCancellation(service, credentials, job) {
  return run(normalizeService(service), credentials, job);
}

module.exports = { runCancellation, launchBrowser, isSupported, isEnabled, normalizeService, SERVICES };

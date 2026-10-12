const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '../../screenshots');
const RETENTION_MS = 24 * 60 * 60 * 1000;

// Local diagnostic images may contain account information. Never serve this
// directory through express.static; only expose opaque references in job results.
function purgeArtifacts(root = ROOT, now = Date.now()) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  for (const file of fs.readdirSync(root)) {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    if (stat.isFile() && now - stat.mtimeMs >= RETENTION_MS) fs.unlinkSync(full);
  }
}

async function screenshot(page, jobId, label, root = ROOT) {
  purgeArtifacts(root);
  const safeJob = crypto.createHash('sha256').update(String(jobId)).digest('hex');
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const ref = `${safeJob}-${safeLabel}-${crypto.randomUUID()}.png`;
  const file = path.join(root, ref);
  const pixels = await page.screenshot({
    mask: [page.locator('input, textarea, [contenteditable="true"]')],
  });
  fs.writeFileSync(file, pixels, { mode: 0o600, flag: 'wx' });
  return ref;
}

module.exports = { screenshot, purgeArtifacts, RETENTION_MS };

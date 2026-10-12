const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('../src/scripts/runner');
const { createProcessor } = require('../src/queue/processor');
const { createAddCancelJob, operationIdentity, JOB_OPTIONS, CREDENTIAL_TTL_SECONDS } = require('../src/queue/operations');
const { isEnabled, normalizeService, runCancellation, SERVICES } = require('../src/scripts');
const { clickFirst, tryClick } = require('../src/scripts/helpers');
const { screenshot, purgeArtifacts, RETENTION_MS } = require('../src/scripts/artifacts');

function fixture(overrides = {}) {
  const calls = { submit: 0, close: 0, inspect: 0, verify: 0 };
  const state = { targetId: 'plan-1', accountEmail: 'a@b.c', status: 'active',
    autoRenew: true, billingSource: 'direct', termsKnown: true, cancellationFee: 0 };
  const page = {};
  const job = { id: 'j1', data: { targetId: 'plan-1' },
    async updateData(data) { this.data = data; } };
  const adapter = {
    async inspect() { calls.inspect++; return { ...state }; },
    async submitCancellation() { calls.submit++; assert.equal(job.data.operationState, 'submitting'); },
    async verify() { calls.verify++; return { ...state, status: 'cancelled', autoRenew: false }; },
    ...overrides.adapter,
  };
  const browser = { async newContext() { return { async newPage() { return page; } }; },
    async close() { calls.close++; if (overrides.closeFails) throw Error('private cleanup error'); } };
  const run = createRunner({ adapters: { service: adapter },
    launchBrowser: async () => browser, capture: overrides.capture });
  return { calls, state, job, run, credentials: { email: 'a@b.c', password: 'PRIVATE_PASSWORD' } };
}

test('all registered service entrypoints are inert, even when called directly', async () => {
  for (const service of Object.keys(SERVICES)) {
    assert.equal(isEnabled(service), false);
    assert.equal((await runCancellation(service, { email: 'a@b.c', password: 'pw' })).outcome, 'manual_required');
    const adapter = require(`../src/scripts/services/${SERVICES[service]}`);
    assert.deepEqual(Object.keys(adapter), ['cancel']);
    assert.equal((await adapter.cancel()).outcome, 'manual_required');
  }
});

test('Disney aliases resolve to one canonical identity', () => {
  for (const alias of ['Disney+', ' disneyplus ', 'disney']) assert.equal(normalizeService(alias), 'disney');
  const data = { service: 'disney+', targetId: 'plan-1', idempotencyKey: 'request', credentials: { email: ' A@B.C ' } };
  const one = operationIdentity(data, 'secret');
  const two = operationIdentity({ ...data, service: 'disney', userId: 'changed', credentials: { email: 'a@b.c' } }, 'secret');
  assert.deepEqual(one, two);
});

test('account fences survive auth/encryption secret rotation', () => {
  const data = { service: 'service', targetId: 'plan', idempotencyKey: 'same', credentials: { email: 'a@b.c' } };
  assert.deepEqual(operationIdentity(data, 'old-secret'), operationIdentity(data, 'new-secret'));
});

test('confirmed cancellation requires a matching re-read of billing state', async () => {
  const f = fixture();
  const result = await f.run('service', f.credentials, f.job);
  assert.equal(result.outcome, 'confirmed');
  assert.equal(f.calls.submit, 1);
  assert.equal(f.calls.verify, 1);
});

test('already-cancelled target performs no destructive action', async () => {
  const f = fixture(); f.state.status = 'cancelled'; f.state.autoRenew = false;
  assert.equal((await f.run('service', f.credentials, f.job)).success, true);
  assert.equal(f.calls.submit, 0);
});

test('wrong account or wrong plan cannot reach submission', async () => {
  for (const change of [{ targetId: 'other' }, { accountEmail: 'wrong@example.com' }]) {
    const f = fixture(); Object.assign(f.state, change);
    assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'failed_before_submission');
    assert.equal(f.calls.submit, 0);
  }
});

test('fees, unknown terms, and third-party billing require manual cancellation', async () => {
  for (const change of [{ cancellationFee: 20 }, { cancellationFee: undefined },
    { termsKnown: false }, { billingSource: 'apple' }, { autoRenew: undefined }]) {
    const f = fixture(); Object.assign(f.state, change);
    assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'manual_required');
    assert.equal(f.calls.submit, 0);
  }
});

test('pre-cancellation phrases and positive renewal do not establish success', async () => {
  for (const text of ['Your plan will renew', 'Downgrade', "We are sorry to see you go", 'Access until tomorrow']) {
    const f = fixture({ adapter: { async verify() {
      return { targetId: 'plan-1', accountEmail: 'a@b.c', text, autoRenew: true, status: 'active' };
    } } });
    assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'needs_review');
  }
});

test('confirmation for a different subscription is rejected', async () => {
  const f = fixture({ adapter: { async verify() {
    return { targetId: 'other', accountEmail: 'a@b.c', status: 'cancelled', autoRenew: false };
  } } });
  assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'needs_review');
});

test('scheduled cancellation requires a valid effective date and renewal off', async () => {
  for (const effectiveAt of [undefined, 'not-a-date', '2026-11-01T00:00:00Z']) {
    const f = fixture({ adapter: { async verify() {
      return { targetId: 'plan-1', accountEmail: 'a@b.c', status: 'cancellation_scheduled', autoRenew: false, effectiveAt };
    } } });
    assert.equal((await f.run('service', f.credentials, f.job)).success, effectiveAt === '2026-11-01T00:00:00Z');
  }
});

test('failed durable checkpoint prevents all submission', async () => {
  const f = fixture(); f.job.updateData = async () => { throw Error('offline'); };
  assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'failed_before_submission');
  assert.equal(f.calls.submit, 0);
});

test('timeout after dispatch is uncertain and redacts the original error', async () => {
  const f = fixture({ adapter: { async submitCancellation() { throw Error('PRIVATE_PASSWORD'); } } });
  const result = await f.run('service', f.credentials, f.job);
  assert.equal(result.outcome, 'needs_review');
  assert.equal(JSON.stringify(result).includes('PRIVATE_PASSWORD'), false);
});

test('browser-close and screenshot failures never override a verified outcome', async () => {
  const f = fixture({ closeFails: true, capture: async () => { throw Error('disk full'); } });
  assert.equal((await f.run('service', f.credentials, f.job)).outcome, 'confirmed');
  assert.equal(f.calls.close, 1);
});

function visibleScope(count, clickError) {
  let clicks = 0;
  return { scope: { locator: () => ({ count: async () => count,
    nth: () => ({ isVisible: async () => true, click: async () => { clicks++; if (clickError) throw clickError; } }) }) },
    clicks: () => clicks };
}

test('ambiguous destructive selectors stop without clicking', async () => {
  const f = visibleScope(2);
  await assert.rejects(clickFirst(f.scope, ['button', 'a'], 1), { code: 'SELECTOR_AMBIGUOUS' });
  await assert.rejects(tryClick(f.scope, ['button', 'a'], 1), { code: 'SELECTOR_AMBIGUOUS' });
  assert.equal(f.clicks(), 0);
});

test('optional click suppresses only absence, never dispatch failures', async () => {
  assert.equal(await tryClick(visibleScope(0).scope, 'button', 1), false);
  await assert.rejects(tryClick(visibleScope(1, Error('dispatch timeout')).scope, 'button', 1), /dispatch timeout/);
});

test('producer uses a stable job ID and never puts credentials into job data', async () => {
  const calls = [];
  const reservations = [];
  const add = createAddCancelJob({ secret: 'secret', encrypt: (s) => 'encrypted:' + s,
    redis: { async eval(...args) { reservations.push(args); return 1; } },
    queue: { async add(...args) { calls.push(args); return { id: args[2].jobId }; } } });
  const data = { service: 'service', targetId: 'plan', userId: 'user', idempotencyKey: 'same',
    credentials: { email: 'a@b.c', password: 'ciphertext' } };
  assert.equal((await add(data)).id, (await add(data)).id);
  assert.equal(calls[0][2].attempts, 1);
  assert.equal('credentials' in calls[0][1], false);
  assert.equal(JSON.stringify(calls[0][1]).includes('a@b.c'), false);
  assert.equal(reservations[0].at(-1), CREDENTIAL_TTL_SECONDS);
  assert.equal(JOB_OPTIONS.attempts, 1);
});

test('conflicting reservations do not enqueue a second cancellation', async () => {
  let queued = false;
  const add = createAddCancelJob({ secret: 'secret', encrypt: (s) => s,
    redis: { async eval() { return 0; } }, queue: { async add() { queued = true; } } });
  await assert.rejects(add({ service: 'service', targetId: 'plan', idempotencyKey: 'same',
    credentials: { email: 'a@b.c' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(queued, false);
});

test('worker consumes credentials before work and permanently fences stalled replay', async () => {
  let claimed = false, consumed = false, runs = 0;
  const redis = { async set() { if (claimed) return null; claimed = true; return 'OK'; },
    async eval() { consumed = true; return JSON.stringify({ email: 'a@b.c', password: 'pw' }); } };
  const processJob = createProcessor({ redis, decrypt: (s) => s, isEnabled: () => true,
    async runCancellation() { assert.equal(consumed, true); runs++; return { outcome: 'confirmed', success: true }; } });
  const job = { id: 'a'.repeat(64), data: { service: 'service', credentialRef: `sniper:v2:credentials:${'a'.repeat(64)}` } };
  assert.equal((await processJob(job)).outcome, 'confirmed');
  assert.equal((await processJob(job)).outcome, 'needs_review');
  assert.equal(runs, 1);
});

test('legacy jobs are scrubbed and drained manually without decrypting', async () => {
  const job = { id: 'old', data: { service: 'netflix', credentials: { password: 'old ciphertext' } },
    async updateData(data) { this.data = data; } };
  const processJob = createProcessor({ redis: {}, isEnabled: () => false,
    decrypt: () => { throw Error('must not decrypt'); }, runCancellation: () => { throw Error('must not run'); } });
  assert.equal((await processJob(job)).outcome, 'manual_required');
  assert.equal(job.data.credentials, null);
});

test('failed legacy cleanup blocks processing instead of reporting success', async () => {
  const processJob = createProcessor({ redis: {}, isEnabled: () => false });
  await assert.rejects(processJob({ data: { credentials: { password: 'old' } },
    async updateData() { throw Error('offline'); } }), /offline/);
});

test('expired credentials cause no cancellation attempt', async () => {
  const processJob = createProcessor({ redis: { async set() { return 'OK'; }, async eval() { return null; } },
    isEnabled: () => true, runCancellation: () => { throw Error('must not run'); } });
  assert.equal((await processJob({ id: 'a'.repeat(64), data: { service: 'service',
    credentialRef: `sniper:v2:credentials:${'a'.repeat(64)}` } })).outcome, 'failed_before_submission');
});

test('artifacts are private, masked, job-associated, and expire', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-artifacts-'));
  try {
    let masked = false;
    const page = { locator: (s) => s, async screenshot(options) {
      masked = options.mask[0].includes('input'); return Buffer.from('fake image');
    } };
    const ref = await screenshot(page, '../job', '../../failure', root);
    assert.equal(masked, true);
    assert.equal(path.basename(ref), ref);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, ref)).mode & 0o777, 0o600);
    purgeArtifacts(root, Date.now() + RETENTION_MS + 1000);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

require('./setup-env');
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');

const added = [];
const fakeQueue = {
  addCancelJob: async (data) => (added.push(data), { id: `job-${added.length}` }),
  getJobStatus: async (id) => (id === 'job-1' ? { jobId: id, status: 'waiting' } : null),
  getAllJobs: async () => [{ jobId: 'job-1' }],
};

let base, server;
test.before(async () => {
  server = createApp(fakeQueue).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function login() {
  const res = await post('/api/auth/token', { password: process.env.ADMIN_PASSWORD });
  assert.strictEqual(res.status, 200);
  return (await res.json()).token;
}

test('rejects a wrong password', async () => {
  assert.strictEqual((await post('/api/auth/token', { password: 'nope' })).status, 401);
  assert.strictEqual((await post('/api/auth/token', {})).status, 401);
});

test('issues a short-lived token', async () => {
  const { exp, iat } = jwt.decode(await login());
  assert.strictEqual(exp - iat, 12 * 60 * 60);
});

test('admin password in the query string no longer works', async () => {
  const res = await fetch(`${base}/api/admin/jobs?key=${encodeURIComponent(process.env.ADMIN_PASSWORD)}`);
  assert.strictEqual(res.status, 401);
});

test('admin jobs work with a bearer token', async () => {
  const res = await fetch(`${base}/api/admin/jobs`, { headers: { authorization: `Bearer ${await login()}` } });
  assert.strictEqual(res.status, 200);
});

test('rejects tokens signed with another secret or algorithm', async () => {
  const forged = jwt.sign({ role: 'admin' }, 'wrong-secret');
  const res = await fetch(`${base}/api/admin/jobs`, { headers: { authorization: `Bearer ${forged}` } });
  assert.strictEqual(res.status, 401);
  const none = jwt.sign({ role: 'admin' }, null, { algorithm: 'none' });
  assert.strictEqual((await fetch(`${base}/api/admin/jobs`, { headers: { authorization: `Bearer ${none}` } })).status, 401);
});

test('all unvalidated services are rejected without queuing credentials', async () => {
  const auth = { authorization: `Bearer ${await login()}` };
  for (const service of ['adobe', 'canva', 'disney+', 'dropbox', 'duolingo', 'grammarly',
    'hulu', 'netflix', 'nordvpn', 'notion', 'spotify']) {
    const res = await post('/api/cancel', { service, userId: 'u1',
      credentials: { email: 'a@b.c', password: 'pw' } }, auth);
    assert.strictEqual(res.status, 422);
    assert.strictEqual((await res.json()).outcome, 'manual_required');
  }
  assert.strictEqual(added.length, 0);
});

test('validates cancel requests', async () => {
  const auth = { authorization: `Bearer ${await login()}` };
  const creds = { email: 'a@b.c', password: 'pw' };
  assert.strictEqual((await post('/api/cancel', { service: 'netflix', credentials: creds })).status, 401);
  assert.strictEqual((await post('/api/cancel', { service: 'netflix' }, auth)).status, 400);
  assert.strictEqual((await post('/api/cancel', { service: 'netflix', userId: 'u' }, auth)).status, 422);
  assert.strictEqual((await post('/api/cancel', { service: ['x'], userId: 'u', credentials: creds }, auth)).status, 400);
  assert.strictEqual((await post('/api/cancel', { service: 'myspace', userId: 'u', credentials: creds }, auth)).status, 422);
  assert.strictEqual((await post('/api/cancel', { service: 'netflix', userId: 'u', billingSource: 'apple' }, auth)).status, 422);
});

test('job status', async () => {
  const auth = { authorization: `Bearer ${await login()}` };
  assert.strictEqual((await fetch(`${base}/api/status/job-1`, { headers: auth })).status, 200);
  assert.strictEqual((await fetch(`${base}/api/status/missing`, { headers: auth })).status, 404);
});

test('CORS only allows configured origins', async () => {
  const ok = await fetch(`${base}/health`, { headers: { origin: 'https://app.example.com' } });
  assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'https://app.example.com');
  const bad = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
  assert.strictEqual(bad.headers.get('access-control-allow-origin'), null);
});

test('rate-limits password attempts', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/api/auth/token', { password: 'nope' });
  assert.strictEqual(last.status, 429);
});

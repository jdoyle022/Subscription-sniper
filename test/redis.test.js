require('./setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createAddCancelJob, CREDENTIAL_TTL_SECONDS } = require('../src/queue/operations');
const { createProcessor } = require('../src/queue/processor');
const { encrypt, decrypt } = require('../src/utils/crypto');

test('real Redis: atomic admission, vault TTL, and stalled replay protection',
  { skip: !process.env.REDIS_TEST_URL }, async () => {
    const IORedis = require('ioredis');
    const { Queue } = require('bullmq');
    const redis = new IORedis(process.env.REDIS_TEST_URL, { maxRetriesPerRequest: null });
    const queue = new Queue(`safety-${crypto.randomUUID()}`, { connection: redis });
    const token = crypto.randomUUID();
    const data = { service: 'disney+', targetId: 'plan-1', userId: 'u', idempotencyKey: token,
      requestedAt: new Date().toISOString(),
      credentials: { email: `${token}@example.test`, password: encrypt('private-password') } };
    const keys = [];
    try {
      await redis.ping();
      const add = createAddCancelJob({ queue, redis, encrypt, secret: token });
      const jobs = await Promise.all(Array.from({ length: 8 }, () => add(data)));
      assert.equal(new Set(jobs.map((j) => j.id)).size, 1);
      assert.equal(await queue.getWaitingCount(), 1);
      const job = await queue.getJob(jobs[0].id);
      const ref = job.data.credentialRef;
      keys.push(ref, `sniper:v2:claimed:${job.id}`, `sniper:v2:request:${job.id}`);
      const { operationIdentity } = require('../src/queue/operations');
      keys.push(`sniper:v2:account:${operationIdentity(data, token).account}`);
      assert.equal(job.opts.attempts, 1);
      assert.equal('credentials' in job.data, false);
      assert.equal(JSON.stringify(job.data).includes(data.credentials.email), false);
      const ttl = await redis.ttl(ref);
      assert.ok(ttl > 0 && ttl <= CREDENTIAL_TTL_SECONDS);
      assert.equal(JSON.parse(decrypt(await redis.get(ref))).password, data.credentials.password);
      await assert.rejects(add({ ...data, targetId: 'wrong-plan' }), { code: 'IDEMPOTENCY_CONFLICT' });
      await assert.rejects(add({ ...data, idempotencyKey: crypto.randomUUID() }), { code: 'IDEMPOTENCY_CONFLICT' });
      let runs = 0;
      const processJob = createProcessor({ redis, decrypt, isEnabled: () => true,
        async runCancellation(service, credentials) {
          runs++;
          assert.equal(service, 'disney');
          assert.equal(credentials.password, 'private-password');
          assert.equal(await redis.exists(ref), 0);
          return { outcome: 'confirmed', success: true };
        } });
      assert.equal((await processJob(job)).outcome, 'confirmed');
      assert.equal((await processJob(job)).outcome, 'needs_review');
      assert.equal(runs, 1);
      // A failed queue write leaves a reservation: retrying the SAME key is safe.
      const retryData = { ...data, idempotencyKey: crypto.randomUUID(),
        credentials: { ...data.credentials, email: `${crypto.randomUUID()}@example.test` } };
      const retryIdentity = operationIdentity(retryData, token);
      keys.push(`sniper:v2:request:${retryIdentity.jobId}`, `sniper:v2:account:${retryIdentity.account}`,
        `sniper:v2:credentials:${retryIdentity.jobId}`);
      const failingAdd = createAddCancelJob({ queue: { async add() { throw Error('queue unavailable'); } },
        redis, encrypt, secret: token });
      await assert.rejects(failingAdd(retryData), /queue unavailable/);
      assert.equal((await add(retryData)).id, retryIdentity.jobId);
    } finally {
      if (keys.length) await redis.del(...keys);
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    }
  });

const { assertConfig } = require('../config');
assertConfig();
const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { cancelQueue } = require('./jobQueue');
const { decrypt } = require('../utils/crypto');
const { runCancellation, isEnabled } = require('../scripts');
const { createProcessor } = require('./processor');
const { purgeArtifacts } = require('../scripts/artifacts');

// Worker connections may wait for Redis; API producers have bounded failures.
const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});
connection.on('error', () => console.error('Worker Redis connection unavailable.'));
const worker = new Worker('cancellations', createProcessor({
  redis: connection, decrypt, runCancellation, isEnabled,
}), { connection, concurrency: 2 });
worker.on('completed', (job, result) => {
  console.log(`Job ${job.id}: ${result?.outcome || 'needs_review'}`);
});
worker.on('failed', (job) => console.error(`Job ${job?.id || 'unknown'} requires manual review.`));
worker.on('error', () => console.error('Worker error; no cancellation replay is authorized.'));

// Recover legacy credential cleanup independently of completion events. Repeat
// full passes so a crash, offline Redis, or a failed update does not lose cleanup.
let sweeping = false;
async function scrubLegacyJobs() {
  if (sweeping) return;
  sweeping = true;
  try {
    try { purgeArtifacts(); } catch { console.error('Artifact cleanup incomplete; will retry.'); }
    for (const state of ['wait', 'paused', 'delayed', 'active', 'completed', 'failed']) {
      for (let start = 0; ; start += 100) {
        const jobs = await cancelQueue.getJobs([state], start, start + 99);
        for (const job of jobs) {
          if (job.data.credentials) await job.updateData({ ...job.data, credentials: null });
        }
        if (jobs.length < 100) break;
      }
    }
  } catch {
    console.error('Legacy credential cleanup incomplete; will retry.');
  } finally { sweeping = false; }
}
scrubLegacyJobs();
const cleanupTimer = setInterval(scrubLegacyJobs, 60000);
cleanupTimer.unref();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(cleanupTimer);
  await worker.close();
  await scrubLegacyJobs();
  await cancelQueue.close();
  await connection.quit();
  const { connection: producerConnection } = require('./jobQueue');
  await producerConnection.quit();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('Subscription Sniper worker running (unvalidated adapters are manual-only)');

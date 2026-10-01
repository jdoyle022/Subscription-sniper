const { assertConfig } = require('../config');
assertConfig();

const { Worker } = require('bullmq');
const { connection } = require('./jobQueue');
const { decrypt } = require('../utils/crypto');
const { runCancellation } = require('../scripts');

const worker = new Worker(
  'cancellations',
  async (job) => {
    const { service, credentials } = job.data;
    await job.updateProgress(10);
    const creds = credentials
      ? { email: credentials.email, password: decrypt(credentials.password) }
      : null;
    await job.updateProgress(20);
    const result = await runCancellation(service, creds, job);
    await job.updateProgress(100);
    return result;
  },
  { connection, concurrency: 2 }
);

// Once a job will not run again, delete the stored (encrypted) credentials
// so they don't sit in Redis for the life of the job record.
async function scrubCredentials(job) {
  if (!job?.data?.credentials) return;
  try {
    await job.updateData({ ...job.data, credentials: null });
  } catch (err) {
    console.error(`Could not scrub credentials for job ${job.id}: ${err.message}`);
  }
}

worker.on('completed', async (job) => {
  console.log(`✓ ${job.data.service} done`);
  await scrubCredentials(job);
});

worker.on('failed', async (job, err) => {
  console.error(`✗ ${job?.data?.service}: ${err.message}`);
  const maxAttempts = job?.opts?.attempts || 1;
  if (job && job.attemptsMade >= maxAttempts) await scrubCredentials(job);
});

process.on('SIGTERM', async () => {
  await worker.close();
  process.exit(0);
});

console.log('🎯 Subscription Sniper worker running');

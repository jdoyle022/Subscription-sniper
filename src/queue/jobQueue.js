require('dotenv').config();
const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});

const { encrypt } = require('../utils/crypto');
const { createAddCancelJob, JOB_OPTIONS } = require('./operations');
connection.on('error', () => console.error('Queue Redis connection unavailable.'));

const cancelQueue = new Queue('cancellations', {
  connection,
  defaultJobOptions: JOB_OPTIONS,
});

const addCancelJob = createAddCancelJob({ queue: cancelQueue, redis: connection,
  encrypt });

// Never include job.data.credentials here: this shape is returned by the API.
function formatJob(job, status) {
  return {
    jobId: job.id,
    service: job.data.service,
    userId: job.data.userId,
    status,
    result: job.returnvalue || null,
    error: job.failedReason ? 'Job could not complete; manual review required.' : null,
    outcome: job.returnvalue?.outcome || (status === 'failed' ? 'needs_review' : null),
    requestedAt: job.data.requestedAt,
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

async function getJobStatus(id) {
  const job = await cancelQueue.getJob(id);
  if (!job) return null;
  return formatJob(job, await job.getState());
}

async function getAllJobs() {
  const [waiting, active, completed, failed] = await Promise.all([
    cancelQueue.getWaiting(),
    cancelQueue.getActive(),
    cancelQueue.getCompleted(0, 49),
    cancelQueue.getFailed(0, 49),
  ]);
  return [
    ...active.map((j) => formatJob(j, 'active')),
    ...waiting.map((j) => formatJob(j, 'waiting')),
    ...completed.map((j) => formatJob(j, 'completed')),
    ...failed.map((j) => formatJob(j, 'failed')),
  ].sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
}

module.exports = { cancelQueue, connection, addCancelJob, getJobStatus, getAllJobs, formatJob };

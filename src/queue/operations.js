const crypto = require('crypto');

const CREDENTIAL_TTL_SECONDS = 15 * 60;
const JOB_OPTIONS = Object.freeze({ attempts: 1,
  removeOnComplete: { age: 7 * 24 * 60 * 60 }, removeOnFail: { age: 7 * 24 * 60 * 60 } });

function digest(value, secret) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
}

function operationIdentity(data, secret) {
  const email = data.credentials?.email?.trim().toLowerCase();
  if (!email || !data.targetId || !data.idempotencyKey) throw new Error('Operation identity required');
  const service = data.service === 'disney+' || data.service === 'disneyplus' ? 'disney' : data.service;
  const account = digest([service, email], secret);
  return { service, account, request: digest([service, email, data.targetId], secret),
    jobId: digest(['request', data.idempotencyKey], secret) };
}

// Atomic durable account fence + idempotency binding. Neither expires automatically:
// an uncertain cancellation requires explicit reconciliation, never a fresh replay.
const RESERVE = `
local request = redis.call('GET', KEYS[1])
local account = redis.call('GET', KEYS[2])
if request and request ~= ARGV[1] then return 0 end
if account and account ~= ARGV[2] then return 0 end
if not request and account then return 0 end
if not request then
  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[2], ARGV[2])
  redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
end
return 1`;

function createAddCancelJob({ queue, redis, encrypt, secret }) {
  return async function addCancelJob(data) {
    const id = operationIdentity(data, secret);
    const credentialRef = `sniper:v2:credentials:${id.jobId}`;
    const reserved = await redis.eval(RESERVE, 3,
      `sniper:v2:request:${id.jobId}`, `sniper:v2:account:${id.account}`, credentialRef,
      id.request, id.jobId, encrypt(JSON.stringify(data.credentials)), CREDENTIAL_TTL_SECONDS);
    if (reserved !== 1) {
      const err = new Error('Operation already reserved or idempotency key reused');
      err.code = 'IDEMPOTENCY_CONFLICT';
      throw err;
    }
    // Whitelist metadata; passwords/emails/idempotency tokens never enter job history.
    return queue.add('cancel', { service: id.service, userId: data.userId,
      targetId: data.targetId, requestedAt: data.requestedAt, credentialRef,
      operationState: 'reserved' }, { ...JOB_OPTIONS, jobId: id.jobId });
  };
}

module.exports = { createAddCancelJob, operationIdentity, JOB_OPTIONS, CREDENTIAL_TTL_SECONDS };

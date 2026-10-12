const { manualRequired, needsReview, failedBeforeSubmission } = require('../scripts/outcomes');

const TAKE_CREDENTIALS = `local v = redis.call('GET', KEYS[1]); redis.call('DEL', KEYS[1]); return v`;

function createProcessor({ redis, decrypt, runCancellation, isEnabled }) {
  return async function processCancellation(job) {
    // Scrub legacy inline credentials before processing. Failure must stop processing.
    if (job.data.credentials) await job.updateData({ ...job.data, credentials: null });
    const ref = job.data.credentialRef;
    if (ref && (!/^[a-f0-9]{64}$/.test(job.id) || ref !== `sniper:v2:credentials:${job.id}`)) {
      return failedBeforeSubmission();
    }
    // Legacy jobs and disabled adapters must never reach browser automation.
    if (!ref || !isEnabled(job.data.service)) {
      if (ref) await redis.del(ref);
      return manualRequired(job.data.service);
    }
    const claim = `sniper:v2:claimed:${job.id}`;
    if (await redis.set(claim, 'started', 'NX') !== 'OK') {
      // A crash/stall/retry may follow a successful site operation. Never resubmit.
      return needsReview();
    }
    let credentials;
    try {
      const encrypted = await redis.eval(TAKE_CREDENTIALS, 1, ref);
      if (!encrypted) return failedBeforeSubmission();
      const stored = JSON.parse(decrypt(encrypted));
      credentials = { email: stored.email, password: decrypt(stored.password) };
      return await runCancellation(job.data.service, credentials, job);
    } catch {
      // Raw browser/decryption errors must not enter Redis results or application logs.
      return job.data.operationState === 'submitting' ? needsReview() : failedBeforeSubmission();
    } finally {
      credentials = null;
      // Credentials were consumed atomically before browser work; TTL covers crashes before that.
    }
  };
}

module.exports = { createProcessor, TAKE_CREDENTIALS };

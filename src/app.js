const express = require('express');
const cors = require('cors');
const path = require('path');
const { rateLimit } = require('express-rate-limit');
const { encrypt } = require('./utils/crypto');
const { checkAdminPassword, issueAdminToken, verifyToken, requireAdmin } = require('./utils/auth');
const { isSupported, normalizeService } = require('./scripts');
const { corsOrigins } = require('./config');

const isNonEmptyString = (v, max = 256) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

// `queue` is injected so tests can run without Redis.
function createApp(queue) {
  const app = express();
  app.disable('x-powered-by');

  // Only listed origins may call the API from a browser. Empty list = none.
  const origins = corsOrigins();
  app.use(cors({ origin: origins.length ? origins : false }));
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(path.join(__dirname, '../public')));

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // Brute-force protection on the password endpoint.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again later.' },
  });

  app.post('/api/auth/token', loginLimiter, (req, res) => {
    if (!checkAdminPassword(req.body?.password)) return res.status(401).json({ error: 'Invalid password' });
    res.json({ token: issueAdminToken() });
  });

  app.post('/api/cancel', verifyToken, async (req, res) => {
    const { service, credentials, userId, billingSource } = req.body || {};
    if (!isNonEmptyString(service, 64) || !isNonEmptyString(userId, 128)) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    if (billingSource === 'apple' || billingSource === 'google') {
      return res.status(422).json({
        error: 'manual_required',
        message: `${billingSource === 'apple' ? 'Apple' : 'Google Play'} subscriptions must be cancelled on your device.`,
      });
    }
    if (!isSupported(service)) {
      return res.status(422).json({ error: 'manual_required', message: `No script for ${service} yet — cancel manually.` });
    }
    if (!isNonEmptyString(credentials?.email) || !isNonEmptyString(credentials?.password, 1024)) {
      return res.status(400).json({ error: 'Credentials required' });
    }

    try {
      const job = await queue.addCancelJob({
        service: normalizeService(service),
        credentials: { email: credentials.email, password: encrypt(credentials.password) },
        userId,
        billingSource: billingSource || null,
        requestedAt: new Date().toISOString(),
      });
      res.json({ jobId: job.id, status: 'queued', message: `Cancellation queued for ${service}.` });
    } catch (err) {
      console.error('Queue failed:', err.message);
      res.status(500).json({ error: 'Queue failed' });
    }
  });

  app.get('/api/status/:jobId', verifyToken, async (req, res) => {
    const s = await queue.getJobStatus(req.params.jobId);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  });

  app.get('/api/admin/jobs', requireAdmin, async (req, res) => res.json(await queue.getAllJobs()));

  return app;
}

module.exports = { createApp };

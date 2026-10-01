require('dotenv').config();

const WEAK_PASSWORDS = new Set(['changeme', 'changeme123', 'password', 'admin', 'admin123']);

// Fails fast on missing or weak secrets so a misconfigured server never starts.
function validateConfig(env = process.env) {
  const errors = [];

  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters.');
  }

  const pw = env.ADMIN_PASSWORD || '';
  if (pw.length < 16 || WEAK_PASSWORDS.has(pw.toLowerCase())) {
    errors.push('ADMIN_PASSWORD must be at least 16 characters and not a default value.');
  }

  if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY || '')) {
    errors.push('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).');
  }

  return errors;
}

function assertConfig(env = process.env) {
  const errors = validateConfig(env);
  if (errors.length) {
    console.error('Invalid configuration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
}

function corsOrigins(env = process.env) {
  return (env.CORS_ORIGIN || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

module.exports = { validateConfig, assertConfig, corsOrigins };

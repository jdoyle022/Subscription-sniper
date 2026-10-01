require('./setup-env');
const test = require('node:test');
const assert = require('node:assert');
const { validateConfig, corsOrigins } = require('../src/config');

const good = { JWT_SECRET: 'x'.repeat(64), ADMIN_PASSWORD: 'a-long-random-password', ENCRYPTION_KEY: 'ab'.repeat(32) };

test('accepts strong config', () => {
  assert.deepStrictEqual(validateConfig(good), []);
});

test('rejects the old default admin password', () => {
  assert.strictEqual(validateConfig({ ...good, ADMIN_PASSWORD: 'changeme123' }).length, 1);
});

test('rejects short secrets and a non-hex encryption key', () => {
  assert.strictEqual(validateConfig({ JWT_SECRET: 'short', ADMIN_PASSWORD: 'short', ENCRYPTION_KEY: 'z'.repeat(32) }).length, 3);
});

test('parses CORS origins', () => {
  assert.deepStrictEqual(corsOrigins({ CORS_ORIGIN: ' https://a.com, https://b.com ,' }), ['https://a.com', 'https://b.com']);
  assert.deepStrictEqual(corsOrigins({}), []);
});

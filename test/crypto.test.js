require('./setup-env');
const test = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt } = require('../src/utils/crypto');

test('round-trips text', () => {
  const enc = encrypt('hunter2 ✓');
  assert.notStrictEqual(enc, 'hunter2 ✓');
  assert.strictEqual(decrypt(enc), 'hunter2 ✓');
});

test('uses a fresh IV each time', () => {
  assert.notStrictEqual(encrypt('same'), encrypt('same'));
});

test('rejects tampered ciphertext', () => {
  const [iv, tag, data] = encrypt('secret').split(':');
  const flipped = (parseInt(data[0], 16) ^ 1).toString(16) + data.slice(1);
  assert.throws(() => decrypt(`${iv}:${tag}:${flipped}`));
});

test('refuses to run with a bad key', () => {
  const saved = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'x'.repeat(32);
  try {
    assert.throws(() => encrypt('x'), /64 hex/);
  } finally {
    process.env.ENCRYPTION_KEY = saved;
  }
});

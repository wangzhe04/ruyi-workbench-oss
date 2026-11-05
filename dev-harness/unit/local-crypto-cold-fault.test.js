'use strict';
// DPAPI cold-start faults: a protected blob must refuse to decrypt after tampering
// or under a different entropy (proxy for a different account/cold context), and
// must never fall back to plaintext or leave helper uncertainty behind.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['LocalSecretCrypto']);
const win = process.platform === 'win32';
test('dpapi round trip keeps bytes and refuses tampering without helper uncertainty', { skip: !win }, async () => {
  const entropy = Buffer.from('ruyi-cold-start-entropy');
  const secret = Buffer.from('COLD START PRIVATE');
  const wrapped = await api.LocalSecretCrypto.run('protect', secret, entropy).catch(error => error);
  if (Buffer.isBuffer(wrapped)) {
    const plain = await api.LocalSecretCrypto.run('unprotect', wrapped, entropy);
    assert.deepEqual(Buffer.from(plain), secret);
  } else {
    // Some Windows images lack a usable DPAPI profile; the refusal must be typed.
    assert.match(String(wrapped.code || ''), /local_crypto\./);
  }
  const bad = Buffer.from(wrapped);
  bad[bad.length - 1] ^= 1;
  await assert.rejects(() => api.LocalSecretCrypto.run('unprotect', bad, entropy), error => /local_crypto\./.test(String(error.code || '')));
  assert.equal(api.LocalSecretCrypto.helperMayStillRun(), false);
  await assert.rejects(() => api.LocalSecretCrypto.run('unprotect', bad, Buffer.from('other-entropy')), error => /local_crypto\./.test(String(error.code || '')));
});
test('dpapi rejects malformed inputs before any helper process', { skip: !win }, async () => {
  for (const input of [Buffer.alloc(0), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(() => api.LocalSecretCrypto.run('protect', input, Buffer.alloc(0)), { code: 'local_crypto.input_invalid' });
  }
  await assert.rejects(() => api.LocalSecretCrypto.run('unknown', Buffer.from('x'), Buffer.alloc(0)), { code: 'local_crypto.input_invalid' });
  assert.equal(api.LocalSecretCrypto.helperMayStillRun(), false);
});

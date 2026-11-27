'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const contract = require('../../ruyi-workbench/semantic-runtime/gemma2-source/embeddinggemma2-live-contract.cjs');
const { ASSETS } = require('../../ruyi-workbench/semantic-runtime/gemma2-profile-validation.cjs');

test('resident thread policy honors two-core and desktop CPU budgets', () => {
  assert.deepEqual([1, 2, 7, 8, 11, 12, 32].map(contract.threadCount), [2, 2, 2, 3, 3, 4, 4]);
  assert.equal(Object.hasOwn(contract.SPEC, 'intraOpNumThreads'), false);
});

test('space identity follows the model, tokenizer and graph while allowing runtime rebinding', t => {
  const assets = Object.entries(ASSETS).map(([path, [bytes, sha256]]) => ({ path, bytes, sha256 }));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemma-space-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  function lockFor(runtimeVersion, tokenizerVersion) {
    const bytes = JSON.stringify({ packages: {
      'node_modules/onnxruntime-node': { version: runtimeVersion },
      'node_modules/@huggingface/tokenizers': { version: tokenizerVersion }
    } });
    fs.writeFileSync(path.join(runtimeRoot, 'package-lock.json'), bytes);
    return { assets, spec: contract.SPEC, runtimeRoot, packageLockSha256: contract.hash(bytes) };
  }
  const lock = lockFor('1.30.0', '0.2.0');
  const space = contract.vectorSpaceId(lock);
  const scorer = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'), 'utf8');
  const api = vm.runInNewContext(scorer + '\nSemanticRetrieval;', { require, Date });
  assert.equal(api.vectorSpaceFor(api.windowPolicy.CONTRACT.modelFingerprint), space);
  assert.equal(api.vectorSpaceFor('unknown-fingerprint'), null);
  assert.match(space, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.vectorSpaceId({ ...lock, assets: assets.slice().reverse(), node: { sha256: 'new' } }), space);
  for (const field of assets.filter(asset => asset.path !== 'README.md')) {
    const changed = assets.map(asset => asset === field ? { ...asset, sha256: crypto.createHash('sha256').update('altered').digest('hex') } : asset);
    assert.notEqual(contract.vectorSpaceId({ ...lock, assets: changed }), space, field.path);
  }
  assert.notEqual(contract.vectorSpaceId({ ...lock, spec: { ...lock.spec, pooling: 'other' } }), space);
  assert.notEqual(contract.vectorSpaceId(lockFor('1.31.0', '0.2.0')), space);
  assert.notEqual(contract.vectorSpaceId(lockFor('1.30.0', '0.3.0')), space);
  assert.throws(() => contract.vectorSpaceId(lock), { code: 'EG2_DEPENDENCY_LOCK_INTEGRITY' });
});

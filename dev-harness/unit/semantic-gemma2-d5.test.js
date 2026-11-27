'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const contract = require('../../ruyi-workbench/semantic-runtime/gemma2-source/embeddinggemma2-live-contract.cjs');
const { ASSETS } = require('../../ruyi-workbench/semantic-runtime/gemma2-profile-validation.cjs');

test('resident thread policy honors two-core and desktop CPU budgets', () => {
  assert.deepEqual([1, 2, 7, 8, 11, 12, 32].map(contract.threadCount), [2, 2, 2, 3, 3, 4, 4]);
  assert.equal(Object.hasOwn(contract.SPEC, 'intraOpNumThreads'), false);
});

test('space identity follows the model, tokenizer and graph while allowing runtime rebinding', () => {
  const assets = Object.entries(ASSETS).map(([path, [bytes, sha256]]) => ({ path, bytes, sha256 }));
  const lock = { assets, spec: contract.SPEC };
  const space = contract.vectorSpaceId(lock);
  assert.match(space, /^sha256:[a-f0-9]{64}$/);
  assert.equal(contract.vectorSpaceId({ ...lock, assets: assets.slice().reverse(), node: { sha256: 'new' } }), space);
  for (const field of assets.filter(asset => asset.path !== 'README.md')) {
    const changed = assets.map(asset => asset === field ? { ...asset, sha256: crypto.createHash('sha256').update('altered').digest('hex') } : asset);
    assert.notEqual(contract.vectorSpaceId({ ...lock, assets: changed }), space, field.path);
  }
  assert.notEqual(contract.vectorSpaceId({ ...lock, spec: { ...lock.spec, pooling: 'other' } }), space);
});

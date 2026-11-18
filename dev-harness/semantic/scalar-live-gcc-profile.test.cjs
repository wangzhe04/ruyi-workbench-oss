'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { create } = require('./scalar-live-gcc-profile.cjs');

test('GCC profile constructs without starting a model and exposes separate owner identities', async () => {
  const p = create();
  assert.equal(p.kind, 'native-research');
  assert.equal(p.encoder.descriptor().state, 'cold');
  assert.equal(p.encoder.stats().starts, 0);
  assert.equal(p.scalarHost.stats().starts, 0);
  assert.deepEqual(p.ownedIdentities(), { coarse: null, scalar: null });
  assert.ok(p.bindings.some(row => row.file.endsWith('gcc-native-profile-lock.json')));
  assert.equal((await p.encoder.stop()).workerExited, true);
  assert.equal((await p.scalarHost.stop()).workerExited, true);
});
test('coarse cancellation preserves falsy reason without starting native inference', async () => {
  for (const reason of [0, false, '']) {
    const p = create(), controller = new AbortController(); controller.abort(reason);
    let actual = Symbol('not-thrown');
    try { await p.encoder.encode(['synthetic'], { role: 'query', signal: controller.signal }); } catch (error) { actual = error; }
    assert.equal(actual, reason);
    assert.equal(p.encoder.stats().starts, 0);
    assert.equal((await p.encoder.stop()).workerExited, true);
  }
});
test('scalar cancellation preserves falsy reason and does not create an owner', async () => {
  const p = create(), controller = new AbortController(); controller.abort(0);
  let actual = Symbol('not-thrown');
  try { await p.scalarHost.prepare({ deadline: Date.now() + 5000, signal: controller.signal }); } catch (error) { actual = error; }
  assert.equal(actual, 0); assert.equal(p.scalarHost.stats().starts, 0);
  assert.equal((await p.scalarHost.stop()).workerExited, true);
});

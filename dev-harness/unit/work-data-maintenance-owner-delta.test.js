'use strict';
// Precise owner delta: maintenance status must name every open owner and expose a
// monotonic admitted/released delta, not just aggregate counts.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { loadServerInternals } = require('../lib/server-internals');
test('maintenance status names each open owner and keeps an exact delta', async () => {
  const api = loadServerInternals(['WorkDataMaintenance']);
  const maintenance = api.WorkDataMaintenance.create({ owns: () => true, snapshot: () => ({ dirty: 0, busy: {} }) });
  const before = maintenance.status();
  assert.deepEqual(before.owners.open, []);
  assert.equal(before.owners.delta, 0);
  await maintenance.fresh('demo-owner', async () => {
    const live = maintenance.status();
    assert.equal(live.owners.open.length, 1);
    assert.equal(live.owners.open[0].kind, 'demo-owner');
    assert.equal(live.owners.delta, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  const after = maintenance.status();
  assert.deepEqual(after.owners.open, []);
  assert.equal(after.owners.delta, 0);
  assert.equal(after.owners.admittedTotal, 1);
  assert.equal(after.owners.releasedTotal, 1);
});
test('tracked writers appear in the owner ledger until they settle', async () => {
  const api = loadServerInternals(['WorkDataMaintenance']);
  const maintenance = api.WorkDataMaintenance.create({ owns: () => true, snapshot: () => ({ dirty: 0, busy: {} }) });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  maintenance.track(pending);
  const during = maintenance.status();
  assert.equal(during.owners.open.some(row => row.kind === 'writer'), true);
  assert.equal(during.owners.delta, 1);
  release();
  await pending;
  const settled = maintenance.status();
  assert.equal(settled.owners.open.length, 0);
  assert.equal(settled.owners.delta, 0);
});

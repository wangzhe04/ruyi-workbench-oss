'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/run-health.js')).href);

test('run faults coexist without changing business status; released resources clear symmetrically', async () => {
  const { runFaults } = await load();
  const run = { status: 'running', live: true, persistenceDegraded: true, nodes: [{ id: 'idle', idleAborted: true }, { id: 'wait', status: 'waiting_resource', resourceBlockers: [{ group: 'cpu' }] }] };
  const before = JSON.stringify(run);
  assert.deepEqual(runFaults(run), [{ kind: 'persistence' }, { kind: 'idle', nodeId: 'idle' }, { kind: 'resource', count: 1, nodeId: 'wait' }]);
  assert.equal(JSON.stringify(run), before);
  run.persistenceDegraded = false; run.nodes[0].idleAborted = false; run.nodes[1].resourceBlockers = [];
  assert.deepEqual(runFaults(run), []);
  run.nodes[1].resourceBlockers = [{ group: 'cpu' }]; run.live = false;
  assert.deepEqual(runFaults(run), [], 'historical resource waits do not claim a live blocker');
});

test('successful read timestamps do not churn DOM signatures; failure and recovery do', async () => {
  const { readQualitySignature, hasReadFailure } = await load();
  const quality = { state: 'ok', lastSuccessAt: 1, perRun: { run: { state: 'ok', lastSuccessAt: 1 } } };
  const original = readQualitySignature(quality);
  quality.lastSuccessAt = 2; quality.perRun.run.lastSuccessAt = 2;
  assert.equal(readQualitySignature(quality), original);
  quality.perRun.run.state = 'stale';
  assert.equal(hasReadFailure(quality), true);
  assert.notEqual(readQualitySignature(quality), original);
  quality.perRun.run.state = 'ok';
  assert.equal(hasReadFailure(quality), false);
  assert.equal(readQualitySignature(quality), original);
});

test('snapshot validation permits historical absence of live but rejects missing business/node identity and mistyped flags', async () => {
  const { validRunSnapshot, validRunList, validRunEvents } = await load();
  const historical = { id: 'r', status: 'interrupted', nodes: [{ id: 'n', status: 'failed' }] };
  assert.equal(validRunSnapshot(historical), true);
  for (const row of [{ id: 'r', nodes: [] }, { ...historical, nodes: [null] }, { ...historical, nodes: [{ id: '', status: 'failed' }] }, { ...historical, live: 'true' }]) assert.equal(validRunSnapshot(row), false);
  for (const field of [{ live: 'true' }, { paused: 1 }, { persistenceDegraded: 'false' }, { eventSeq: -1 }]) assert.equal(validRunList({ ok: true, runs: [{ id: 'r', status: 'running', eventSeq: 1, live: true, ...field }] }, false), false);
  assert.equal(validRunEvents({ ok: true, events: [null] }), false);
  assert.equal(validRunEvents({ ok: false, events: [{ seq: 2, type: 'node_start', nodeId: 'n' }] }), false);
});

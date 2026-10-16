'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-health-unit-'));
process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const { loadServerInternals } = require('../lib/server-internals');
const srv = loadServerInternals(['agentRunHealth', 'missionRunDigest', 'missionHealthRuns', 'buildMissionCard', 'overlayMissionCard', 'pretenderLiveOverlayRevision', 'pretenderIndexRuntime', 'turnSettlers', 'activeChildren', 'activeAgentRuns', 'RUYI_EVENTS', 'saveAgentRun', 'PRETENDER_INDEX_SCHEMA'], { withEval: true });
after(() => { srv.activeAgentRuns.clear(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('ruyi-steward-health-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
const make = (id = 'run_abcd') => ({ id, sessionId: 'sess_abcdef', status: 'running', createdAt: '2026-10-16T01:00:00Z', updatedAt: '2026-10-16T01:00:00Z', eventSeq: 1, nodes: [{ id: 'idle', status: 'failed' }, { id: 'wait', status: 'waiting_resource', resourceBlockers: [] }], taskPool: [] });

test('raw runs and bounded mission health projection have identical fault decisions across the complete flag grid', async () => {
  const { runFaults } = await import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/run-health.js')).href);
  for (const live of [false, true]) for (const persistence of [false, true]) for (const idle of [false, true]) for (const nodeIdle of [false, true]) for (const blocked of [false, true]) {
    const run = make(); run.persistenceDegraded = persistence; run.idleAborted = idle; run.nodes[0].idleAborted = nodeIdle; run.nodes[1].resourceBlockers = blocked ? [{ group: 'test', privateNote: 'DO_NOT_PROJECT' }] : [];
    if (live) srv.activeAgentRuns.set(run.id, { run }); else srv.activeAgentRuns.delete(run.id);
    const digest = srv.missionRunDigest(run);
    assert.deepEqual(runFaults(digest), runFaults({ ...run, live }));
    assert.ok(!JSON.stringify(digest).includes('DO_NOT_PROJECT'));
    assert.ok(!Object.hasOwn(digest, 'nodes'));
  }
  srv.activeAgentRuns.clear();
});

test('health cards keep the actual newest persisted run and every live run, without changing the legacy lastRun selection', async () => {
  const newest = make('run_beef'); newest.createdAt = '2026-10-16T03:00:00Z';
  const older = make(); older.persistenceDegraded = true;
  srv.activeAgentRuns.set(older.id, { run: older }); srv.activeAgentRuns.set(newest.id, { run: newest });
  try {
    const head = { id: older.sessionId, title: 'Health projection', createdAt: older.createdAt, updatedAt: older.updatedAt };
    const card = await srv.buildMissionCard(head, [newest, older], { persistent: true, interventions: [] });
    assert.deepEqual(card.healthRuns.map(run => run.id), [newest.id]);
    assert.equal(card.healthRuns[0].live, false); assert.ok(!Object.hasOwn(card, 'execution'));
    assert.equal(card.lastRun.id, older.id, 'do not change existing business-state evidence in the health slice');
    const overlay = srv.overlayMissionCard({ sessionId: head.id, card, interventions: [] });
    assert.equal(overlay.healthRuns.length, 2);
    assert.equal(overlay.healthRuns.find(run => run.id === older.id).health.persistenceDegraded, true);
    assert.equal(overlay.execution, null);
    assert.equal(srv.PRETENDER_INDEX_SCHEMA, 8, 'old regenerable cards must rebuild their new fields');
  } finally { srv.activeAgentRuns.clear(); }
});

test('live ETag changes for fault appearance and recovery even when status, eventSeq and updatedAt stay unchanged', () => {
  const run = make(); srv.activeAgentRuns.set(run.id, { run });
  try {
    const healthy = srv.pretenderLiveOverlayRevision(run.sessionId);
    run.persistenceDegraded = true; const degraded = srv.pretenderLiveOverlayRevision(run.sessionId);
    assert.notEqual(degraded, healthy);
    run.persistenceDegraded = false; assert.equal(srv.pretenderLiveOverlayRevision(run.sessionId), healthy);
    run.nodes[1].resourceBlockers = [{ group: 'test' }]; assert.notEqual(srv.pretenderLiveOverlayRevision(run.sessionId), healthy);
  } finally { srv.activeAgentRuns.clear(); }
});

test('live ETag and actual overlay include startup and queued ownership before any child exists, globally and per session', () => {
  const sid = 'sess_abfeed'; const previousIndex = srv.pretenderIndexRuntime.value;
  try {
    srv.pretenderIndexRuntime.value = { sessions: [{ sessionId: sid }] };
    const idle = [srv.pretenderLiveOverlayRevision(sid), srv.pretenderLiveOverlayRevision()];
    const owner = { driverRunId: 'driver-A', phase: 'starting' }; srv.turnSettlers.set(sid, owner);
    assert.equal(srv.activeChildren.has(sid), false, 'the admission exists before any engine child');
    let previous = idle;
    for (const phase of ['starting', 'queued', 'running', 'stopping']) {
      owner.phase = phase;
      const current = [srv.pretenderLiveOverlayRevision(sid), srv.pretenderLiveOverlayRevision()];
      assert.notEqual(current[0], previous[0]); assert.notEqual(current[1], previous[1]);
      const card = srv.overlayMissionCard({ sessionId: sid, card: { sessionId: sid, healthRuns: [] }, interventions: [] });
      assert.equal(card.execution.driverRunId, owner.driverRunId); assert.equal(card.execution.phase, phase);
      previous = current;
    }
    owner.driverRunId = 'driver-B';
    assert.notEqual(srv.pretenderLiveOverlayRevision(sid), previous[0]); assert.notEqual(srv.pretenderLiveOverlayRevision(), previous[1]);
    srv.turnSettlers.delete(sid);
    assert.deepEqual([srv.pretenderLiveOverlayRevision(sid), srv.pretenderLiveOverlayRevision()], idle);
  } finally { srv.turnSettlers.delete(sid); srv.pretenderIndexRuntime.value = previousIndex; }
});

test('snapshot-save health transitions publish existing thread.state, and observer failures cannot mask write results', async () => {
  const run = make('run_fade'); run.nodes = []; srv.activeAgentRuns.set(run.id, { run });
  let events = 0;
  let unsubscribe = () => {};
  const observer = (name, data) => { if (name === 'thread.state' && data.sessionId === run.sessionId) { events += 1; throw new Error('observer failure'); } };
  try {
    await srv.saveAgentRun(run);
    unsubscribe = srv.RUYI_EVENTS.subscribe(observer);
    srv.__eval('globalThis.__healthAtomicWriter = atomicWriteJson; atomicWriteJson = async () => { throw new Error("forced snapshot failure"); };');
    for (let n = 0; n < 3; n += 1) await assert.rejects(srv.saveAgentRun(run), /forced snapshot failure/);
    assert.equal(run.persistenceDegraded, true); assert.equal(events, 1);
    srv.__eval('atomicWriteJson = globalThis.__healthAtomicWriter; delete globalThis.__healthAtomicWriter;');
    await srv.saveAgentRun(run);
    assert.equal(run.persistenceDegraded, false); assert.equal(events, 2);
    run.idleAborted = true; await srv.saveAgentRun(run); assert.equal(events, 3, 'same-status idle abort wakes global readers');
  } finally {
    srv.__eval('if (globalThis.__healthAtomicWriter) { atomicWriteJson = globalThis.__healthAtomicWriter; delete globalThis.__healthAtomicWriter; }');
    unsubscribe(); srv.activeAgentRuns.clear();
  }
});

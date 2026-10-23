'use strict';
// Generated runtime, real Windows DPAPI, isolated synthetic journals. No key or
// codec stubs; source-unit tests separately control I/O faults and stat collisions.
const path = require('node:path'), repo = process.env.RUYI_AUX_JOURNAL_REPO || path.resolve(__dirname, '..');
require(path.join(repo, 'dev-harness/lib/self-isolate-home'));
const fs = require('node:fs'), os = require('node:os'), assert = require('node:assert/strict');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-aux-journals-e2e-'));
Object.assign(process.env, require(path.join(repo, 'dev-harness/lib/release-checks')).releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const { loadServerInternals } = require(path.join(repo, 'dev-harness/lib/server-internals'));
const t = require(path.join(repo, 'dev-harness/lib/harness')).createRunner('AUX JOURNALS WORK DATA');
const names = ['readConfig', 'writeConfig', 'workDataKeys', 'paths', 'WorkDataJournals', 'atomicWriteJson',
  'stewardInboxPath', 'stewardInboxJournal', 'stewardReadInboxText', 'stewardReadInboxRows', 'stewardAppendInboxRows',
  'stewardInboxCounts', 'stewardLoadState', 'stewardTickOnce', 'stewardRuntime', 'stewardCursorPath',
  'stewardDecisionsPath', 'stewardDecisionJournal', 'stewardAppendDecision', 'stewardPreflightDecision', 'stewardReadDecisionsText',
  'stewardToolHandler', 'stewardMemoryPanelClear', 'stewardMemoryPath', 'agentRunEventsFile', 'agentRunEventsJournal',
  'appendAgentRunEvent', 'flushAgentRunEvents', 'syncRunEventSeq', 'readAgentRunEvents', 'EventStreamHooks',
  'pretenderIndexRuntime', 'stopStewardInbox', 'stopScheduler'];
const runtimes = [], load = () => { const api = loadServerInternals(names); runtimes.push(api); return api; };
const privateError = error => String(error?.code || '').startsWith('work_data');
async function toggle(api, enabled) {
  const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; config.stewardEnabledV1 = true;
  await api.writeConfig(config);
}
const row = (inboxSeq, summary) => ({ inboxSeq, kind: 'done', sessionId: 'sess_aux', seq: inboxSeq,
  at: '2020-01-01T00:00:00.000Z', payload: { summary }, count: 1 });
(async () => {
  const api = load(); await toggle(api, false);
  const off = row(1, 'OFF ORIGINAL BYTE 中文😀'); await api.stewardAppendInboxRows([off]);
  assert.equal(fs.readFileSync(api.stewardInboxPath(), 'utf8'), JSON.stringify(off) + '\n');
  const decision = api.stewardAppendDecision({ tool: 'synthetic_completed_action', args: { note: 'OFF DECISION' } });
  await api.stewardPreflightDecision();
  assert.equal(fs.readFileSync(api.stewardDecisionsPath(), 'utf8'), JSON.stringify(decision) + '\n');
  const run = { id: 'run_aux_dpapi', sessionId: 'sess_aux', eventSeq: 40 };
  api.appendAgentRunEvent(run, { type: 'node_progress', data: { note: 'OFF EVENT' } }); await api.flushAgentRunEvents(run.id);
  assert.equal(JSON.parse(fs.readFileSync(api.agentRunEventsFile(run.sessionId, run.id), 'utf8')).seq, 41);
  t.ok(true, 'OFF preserves original inbox and decision JSON bytes and event business sequence');
  if (process.platform !== 'win32') { console.log('SKIP real DPAPI auxiliary journal lifecycle: Windows only'); return; }
  await toggle(api, true); await api.workDataKeys.ensure();
  const large = 'AUX-PRIVATE-CONTENT-' + '盒😀'.repeat(950000);
  await api.stewardAppendInboxRows([row(2, large)]);
  const largeDecision = api.stewardAppendDecision({ tool: 'synthetic_completed_action', args: { opaque: large } }); await api.stewardPreflightDecision();
  api.appendAgentRunEvent(run, { type: 'run_end', data: { opaque: large } }); await api.flushAgentRunEvents(run.id);
  const files = [api.stewardInboxPath(), api.stewardDecisionsPath(), api.agentRunEventsFile(run.sessionId, run.id)];
  const sealed = files.map(file => fs.readFileSync(file));
  for (const bytes of sealed) { assert.equal(bytes.includes(Buffer.from('AUX-PRIVATE-CONTENT-')), false); assert.equal(JSON.parse(bytes.toString('utf8').trimEnd().split('\n').at(-1)).w, 3); }
  assert.ok(sealed[0].length > 8 * 1024 * 1024); assert.equal(largeDecision.seq, 2); assert.equal(run.eventSeq, 42);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); const cold = load();
  const inbox = await cold.stewardReadInboxText(); assert.equal(inbox.droppedHead, false); assert.equal((await cold.stewardReadInboxRows()).at(-1).payload.summary, large);
  assert.equal((await cold.stewardReadDecisionsText()).droppedHead, false);
  assert.equal(JSON.parse((await cold.stewardReadDecisionsText()).text.split('\n').filter(Boolean).at(-1)).args.opaque, large);
  const recoveredRun = { ...run, eventSeq: 0 }; await cold.syncRunEventSeq(recoveredRun); assert.equal(recoveredRun.eventSeq, 42);
  assert.equal((await cold.readAgentRunEvents(run.sessionId, run.id, 41, 50)).events[0].data.opaque, large);
  await cold.stewardLoadState(); const seen = [...cold.stewardRuntime.seen], seq = cold.stewardRuntime.inboxSeq;
  t.ok(true, 'real DPAPI and cold runtime restore large Unicode records; windows use plaintext bytes despite wire size above 8 MiB');

  const keyFile = path.join(cold.paths.data, 'work-data-key-v1.json'); for (const runtime of runtimes) runtime.workDataKeys.clear();
  fs.renameSync(keyFile, keyFile + '.missing');
  try {
    for (const read of [() => cold.stewardReadInboxRows(), () => cold.stewardInboxCounts(), () => cold.stewardLoadState(),
      () => cold.stewardTickOnce(), () => cold.stewardReadDecisionsText(), () => cold.readAgentRunEvents(run.sessionId, run.id, 0, 50),
      () => cold.syncRunEventSeq(recoveredRun), () => cold.stewardMemoryPanelClear('clear')]) await assert.rejects(read, { code: 'work_data_key.absent' });
    let effects = 0;
    const tool = cold.stewardToolHandler('steward_thread_prioritize', async () => { effects++; return { ok: true }; });
    assert.equal((await tool({ sessionId: 'sess_aux' }, { session: { kind: 'steward' }, trigger: 'user' })).error, 'work_data_key.absent'); assert.equal(effects, 0);
    const receipt = cold.stewardAppendDecision({ tool: 'already_completed', args: {} });
    await assert.rejects(() => cold.stewardPreflightDecision(), { code: 'work_data_key.absent' }); assert.equal(receipt.seq, 0);
    cold.appendAgentRunEvent(run, { type: 'after_completed_effect' }); await cold.flushAgentRunEvents(run.id); assert.equal(run.eventSeq, 42);
    assert.equal(cold.stewardRuntime.inboxSeq, seq); assert.deepEqual([...cold.stewardRuntime.seen], seen);
    files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), sealed[index])); assert.equal(fs.existsSync(cold.stewardMemoryPath()), false);
  } finally { fs.renameSync(keyFile + '.missing', keyFile); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  t.ok(true, 'warm missing key blocks readers, tick, seq recovery and decision-producing tools before effects; failed completed receipts never replay');

  const reads = [() => cold.stewardReadInboxRows(), () => cold.stewardReadDecisionsText(), () => cold.readAgentRunEvents(run.sessionId, run.id, 0, 50)];
  const journals = [cold.stewardInboxJournal(), cold.stewardDecisionJournal(), cold.agentRunEventsJournal(run.sessionId, run.id)];
  const keyBytes = fs.readFileSync(keyFile), otherInstance = JSON.parse(keyBytes); otherInstance.instanceId = 'f'.repeat(32);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.writeFileSync(keyFile, JSON.stringify(otherInstance));
  try {
    for (let index = 0; index < files.length; index++) { await assert.rejects(reads[index], privateError); await assert.rejects(() => journals[index].preflight(), privateError); assert.deepEqual(fs.readFileSync(files[index]), sealed[index]); }
  } finally { fs.writeFileSync(keyFile, keyBytes); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  t.ok(true, 'a different current instance cannot authorize any warm journal body or append');
  for (let index = 0; index < files.length; index++) {
    const damaged = sealed[index].toString('utf8').replace(/("ciphertext":")([A-Za-z0-9+/])/, (_, prefix, char) => prefix + (char === 'A' ? 'B' : 'A'));
    assert.notEqual(damaged, sealed[index].toString('utf8')); fs.writeFileSync(files[index], damaged);
    try { await assert.rejects(reads[index], privateError); await assert.rejects(() => journals[index].preflight(), privateError); assert.equal(fs.readFileSync(files[index], 'utf8'), damaged); }
    finally { fs.writeFileSync(files[index], sealed[index]); }
    fs.writeFileSync(files[index], sealed[index].subarray(0, sealed[index].length - 1));
    try { await reads[index](); await assert.rejects(() => journals[index].preflight(), { code: 'work_data_journal.sealed_tail_uncommitted' }); }
    finally { fs.writeFileSync(files[index], sealed[index]); }
    assert.equal(fs.existsSync(files[index] + '.corrupt'), false);
  }
  t.ok(true, 'tampered committed envelopes hard fail; complete authenticated no-LF tails stay readable and are never silently repaired away');

  await toggle(cold, false);
  for (let index = 0; index < files.length; index++) { await reads[index](); await assert.rejects(() => journals[index].preflight(), { code: 'work_data_journal.downgrade_refused' }); assert.deepEqual(fs.readFileSync(files[index]), sealed[index]); }
  t.ok(true, 'OFF can read existing sealed journals and refuses downgrade before appending or repairing any bytes');
  await toggle(cold, true);
  assert.equal(await cold.EventStreamHooks.archiveAgentRunEvents(run.sessionId, run.id), true);
  const eventFile = files[2], archive = fs.readFileSync(eventFile + '.gz'); assert.equal(fs.existsSync(eventFile), false);
  assert.equal(JSON.parse(archive.toString('utf8').split('\n')[0]).workData, 3); assert.equal(archive.includes(Buffer.from('AUX-PRIVATE-CONTENT-')), false);
  cold.workDataKeys.clear(); const archiveCold = load();
  assert.equal((await archiveCold.readAgentRunEvents(run.sessionId, run.id, 41, 50)).events[0].data.opaque, large);
  for (const runtime of runtimes) runtime.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.missing');
  try { await assert.rejects(() => archiveCold.readAgentRunEvents(run.sessionId, run.id, 0, 50), { code: 'work_data_key.absent' }); assert.deepEqual(fs.readFileSync(eventFile + '.gz'), archive); }
  finally { fs.renameSync(keyFile + '.missing', keyFile); for (const runtime of runtimes) runtime.workDataKeys.clear(); }
  t.ok(true, 'real binary gzip archive is read back and compared before source retirement; cold fallback requires the real DPAPI authority');
})().catch(error => { t.fail(error?.stack || String(error)); }).finally(() => {
  for (const api of runtimes) { api.stopStewardInbox(); api.stopScheduler(); clearTimeout(api.pretenderIndexRuntime.verifyTimer); clearTimeout(api.pretenderIndexRuntime.persistTimer); api.workDataKeys.clear(); }
  assert.equal(path.dirname(root), base); assert.ok(path.basename(root).startsWith('ruyi-aux-journals-e2e-')); fs.rmSync(root, { recursive: true, force: true }); t.done();
});

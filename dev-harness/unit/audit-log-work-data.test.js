'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), fsp = require('node:fs/promises');
const { auditFixture } = require('../lib/audit-log-fixture');

test('OFF original JSON bytes, single oversized row and captured midnight file day survive queued writes', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  let unlock; f.state.onConfig = () => new Promise(resolve => { unlock = resolve; });
  f.api.logEvent({ kind: 'first', value: 'SECRET FIRST' });
  const firstTime = f.state.now;
  f.state.now = '2026-10-25T00:00:00.000Z';
  const large = { kind: 'large', value: '字'.repeat(900000) };
  f.api.logEvent(large); const flushing = f.api.flushWorkbenchLogs();
  while (!unlock) await new Promise(resolve => setImmediate(resolve));
  f.state.onConfig = null; unlock(); await flushing;
  assert.equal(await fsp.readFile(f.file('2026-10-24'), 'utf8'), JSON.stringify({ ts: firstTime, kind: 'first', value: 'SECRET FIRST' }) + '\n');
  assert.equal(await fsp.readFile(f.file('2026-10-25'), 'utf8'), JSON.stringify({ ts: f.state.now, ...large }) + '\n');
  assert.equal(f.state.acquires, 0);
  assert.equal((await f.api.readLogTailSnapshot(10)).count, 0); // giant record exceeds existing 2 MiB tail window.
});

test('queued batches preserve all OFF rows without adding a row cap and keep codec work bounded', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  for (let i = 0; i < 150; i++) f.api.logEvent({ kind: 'number', i, value: '字'.repeat(7000) });
  await f.api.flushWorkbenchLogs();
  const rows = (await fsp.readFile(f.file(), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.i), Array.from({ length: 150 }, (_, i) => i));
  f.state.appendBatches.forEach(batch => { assert.ok(batch.length <= 64); assert.ok(batch.length === 1 || batch.reduce((a, b) => a + b + 1, 0) <= 1024 * 1024); });
});

test('logger ALS suppresses only own config recursion; concurrent business log remains visible', async t => {
  const f = auditFixture(t); let unlock;
  f.state.onConfig = async () => { f.api.logEvent({ kind: 'recursive', value: 'MUST NOT STORE' }); await new Promise(resolve => { unlock = resolve; }); };
  f.api.logEvent({ kind: 'first' });
  while (!unlock) await new Promise(resolve => setImmediate(resolve));
  f.api.logEvent({ kind: 'business' }); f.state.onConfig = null; unlock();
  await f.api.flushWorkbenchLogs();
  const audit = await f.api.readWorkbenchAudit(10);
  assert.deepEqual(Array.from(audit, row => row.type), ['first', 'business']); assert.equal(f.state.acquires, f.state.releases);
});

test('flush barriers capture their own submitted prefix and do not wait for later writes in the same writev', async t => {
  const f = auditFixture(t); f.state.enabled = false; let unlockFirst, unlockFuture, configCalls = 0;
  f.state.onConfig = () => { configCalls++; return new Promise(resolve => { if (configCalls === 1) unlockFirst = resolve; else unlockFuture = resolve; }); };
  f.api.logEvent({ kind: 'prefix' }); while (!unlockFirst) await new Promise(resolve => setImmediate(resolve));
  const first = f.api.flushWorkbenchLogs(); f.api.logEvent({ kind: 'future' }); const second = f.api.flushWorkbenchLogs();
  unlockFirst(); await first;
  assert.equal(JSON.parse((await fsp.readFile(f.file(), 'utf8')).trim()).kind, 'prefix');
  while (!unlockFuture) await new Promise(resolve => setImmediate(resolve));
  f.state.onConfig = null; unlockFuture(); await second;
  assert.equal((await f.api.readLogTailSnapshot(10)).count, 2);
});

test('writer failures remain fire-and-forget, both readers fail, diagnostics contain code only, later authenticated success recovers', async t => {
  const f = auditFixture(t); f.state.enabled = false; f.state.failPlain = true;
  assert.doesNotThrow(() => f.api.logEvent({ kind: 'lost', value: 'SECRET payload' }));
  const failures = await Promise.allSettled([f.api.flushWorkbenchLogs(), f.api.flushWorkbenchLogs()]);
  failures.forEach(item => { assert.equal(item.status, 'rejected'); assert.equal(item.reason.code, 'work_data_audit.write_failed'); });
  await assert.rejects(f.api.readLogTailSnapshot(10), { code: 'work_data_audit.write_failed' });
  assert.deepEqual(f.state.diagnostics, ['work_data_audit.write_failed\n']);
  f.state.failPlain = false; f.api.logEvent({ kind: 'healthy' }); await f.api.flushWorkbenchLogs();
  assert.equal((await f.api.readWorkbenchAudit(10))[0].type, 'healthy');
});

test('unknown config choice never turns logging OFF and cannot recurse', async t => {
  const f = auditFixture(t); f.state.enabled = false; f.state.degraded = true;
  f.state.onConfig = async () => f.api.logEvent({ kind: 'nested_config_failure' });
  f.api.logEvent({ kind: 'sensitive' });
  await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_journal.switch_unavailable' });
  assert.equal(fs.existsSync(f.file()), false); assert.equal(f.state.diagnostics.length, 1);
});

test('full audit and metrics keep filter-before-limit beyond 2 MiB tail and skip bad legacy rows', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  await fsp.writeFile(f.file(), '{bad\n' + JSON.stringify({ kind: 'intervention', source: 'test', ts: f.state.now }) + '\n' + JSON.stringify({ kind: 'mission_start', value: 'x'.repeat(2300000) }) + '\n' + JSON.stringify({ kind: 'last' }) + '\n');
  const audit = await f.api.readWorkbenchAudit(1, { kinds: new Set(['intervention']) });
  assert.equal(audit.length, 1); assert.equal(audit[0].type, 'intervention');
  const metrics = await f.api.buildOpsMetrics(7); assert.equal(metrics.interventions.total, 1); assert.equal(metrics.missions.started, 1);
});

test('encrypted Unicode log roundtrip, current wrong instance/missing key, OFF downgrade and sealed no-LF retention refusal', async t => {
  const f = auditFixture(t);
  f.api.logEvent({ kind: 'intervention', source: 'test', value: 'SECRET😀'.repeat(300000) }); await f.api.flushWorkbenchLogs();
  const raw = await fsp.readFile(f.file()); assert.equal(raw.includes(Buffer.from('SECRET')), false);
  const audit = await f.api.readWorkbenchAudit(10); assert.equal(audit.length, 1); assert.equal(audit[0].detail.value.length, 'SECRET😀'.repeat(300000).length);
  f.state.keyError = Object.assign(Error('gone'), { code: 'work_data_key.absent' }); await assert.rejects(f.api.buildOpsMetrics(30), { code: 'work_data_key.absent' });
  await assert.rejects(f.api.readLogTailSnapshot(10), { code: 'work_data_key.absent' });
  f.state.keyError = null; f.state.instance = 'b'.repeat(32); await assert.rejects(f.api.readWorkbenchAudit(10), error => String(error.code).startsWith('work_data'));  f.state.instance = null;
  f.state.enabled = false; await assert.rejects(f.api.workbenchAuditJournal(f.file()).preflight(), { code: 'work_data_journal.downgrade_refused' });
  f.state.enabled = true; f.state.now = '2020-01-01T00:00:00.000Z'; f.api.logEvent({ kind: 'old' }); await f.api.flushWorkbenchLogs();
  await fsp.truncate(f.file(), (await fsp.stat(f.file())).size - 1);
  assert.equal((await f.api.readWorkbenchAudit(10, { maxFiles: 7 })).length, 2);
  await assert.rejects(f.api.sweepLogsStore({ logsKeepDays: 7 }, { freedBytes: 0, actions: [] }), { code: 'work_data_journal.sealed_tail_uncommitted' });
  assert.equal(fs.existsSync(f.file()), true);
});

test('stable tail proof rejects same-stat valid replacement and UI read never clears a recovery gate', async t => {
  const f = auditFixture(t); f.api.logEvent({ kind: 'one' }); await f.api.flushWorkbenchLogs();
  const snapshot = await f.api.readLogTailSnapshot(10, { stable: true });
  const journal = f.api.workbenchAuditJournal(f.file());
  await journal.replace(['{"kind":"two"}'], () => {});
  await assert.rejects(snapshot.check(), error => String(error.code).startsWith('work_data') || error.code === 'privacy.export_source_changed');
  f.state.failAppend = true; f.state.failTruncate = true;
  await assert.rejects(journal.append(['{"kind":"partial"}', JSON.stringify({ value: 'z'.repeat(200000) })], () => {}), { code: 'work_data_journal.recovery_required' });
  f.state.failAppend = false; f.state.failTruncate = false;
  await f.api.readLogTailSnapshot(10); assert.equal(journal.recoveryPending(), true);
  await f.api.recoverWorkbenchAudit(journal); assert.equal(journal.recoveryPending(), false);
  assert.equal((await f.api.readWorkbenchAudit(10)).filter(row => row.type === 'partial').length, 1);
});


test('one day recovering cannot erase a different failed day from the logger barrier', async t => {
  const f = auditFixture(t); f.state.enabled = false; f.state.failPlain = true;
  f.state.now = '2026-10-23T23:59:59.000Z'; f.api.logEvent({ kind: 'failed_a' });
  await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_audit.write_failed' });
  f.state.now = '2026-10-24T00:00:00.000Z'; f.api.logEvent({ kind: 'failed_b' });
  await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_audit.write_failed' });
  f.state.failPlain = false; f.api.logEvent({ kind: 'healthy_b' });
  await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_audit.write_failed' });
  await assert.rejects(f.api.readLogTailSnapshot(10), { code: 'work_data_audit.write_failed' });
  f.state.now = '2026-10-23T23:59:59.000Z'; f.api.logEvent({ kind: 'healthy_a' }); await f.api.flushWorkbenchLogs();
  assert.equal((await f.api.readWorkbenchAudit(10, { maxFiles: 7 })).length, 2);
});

test('retention preserves a first or later invalid reserved torn ciphertext suffix', async t => {
  for (const prefix of ['', '{"kind":"legacy"}\n']) {
    const f = auditFixture(t); f.state.now = '2020-01-01T00:00:00.000Z';
    f.api.logEvent({ kind: 'old' }); await f.api.flushWorkbenchLogs();
    const raw = await fsp.readFile(f.file(), 'utf8'); await fsp.writeFile(f.file(), prefix + raw.slice(0, -20));
    const before = await fsp.readFile(f.file()), result = { freedBytes: 0, actions: [] };
    await assert.rejects(f.api.sweepLogsStore({ logsKeepDays: 7 }, result), { code: 'work_data_journal.sealed_tail_uncommitted' });
    assert.deepEqual(await fsp.readFile(f.file()), before); assert.equal(result.actions.length, 0); assert.equal(result.freedBytes, 0);
  }
});


test('key lifecycle failures use a 503 audit source boundary for both reading and asynchronous proof revalidation', async t => {
  const f = auditFixture(t); f.api.logEvent({ kind: 'proof' }); await f.api.flushWorkbenchLogs();
  const snapshot = await f.api.readLogTailSnapshot(10, { stable: true });
  f.state.keyError = Object.assign(Error('absent'), { code: 'work_data_key.absent', apiCode: 'work_data_key.absent' });
  for (const read of [() => f.api.readLogTailSnapshot(10), () => f.api.readWorkbenchAudit(10), () => f.api.buildOpsMetrics(7), snapshot.check])
    await assert.rejects(read, { code: 'work_data_key.absent', apiCode: 'work_data_key.absent', statusCode: 503 });
});


test('retention mutation admission refuses OFF sealed sources and unresolved recovery even when every current row is valid', async t => {
  const f = auditFixture(t); f.state.now = '2020-01-01T00:00:00.000Z';
  f.api.logEvent({ kind: 'old' }); await f.api.flushWorkbenchLogs(); const original = await fsp.readFile(f.file());
  f.state.enabled = false;
  await assert.rejects(f.api.sweepLogsStore({ logsKeepDays: 7 }, { freedBytes: 0, actions: [] }), { code: 'work_data_journal.downgrade_refused' });
  assert.deepEqual(await fsp.readFile(f.file()), original); f.state.enabled = true;
  f.state.failAppend = true; f.state.failTruncate = true;
  const journal = f.api.workbenchAuditJournal(f.file());
  await assert.rejects(journal.append(['{"kind":"partial"}', JSON.stringify({ value: 'z'.repeat(200000) })], () => {}), { code: 'work_data_journal.recovery_required' });
  f.state.failAppend = false; f.state.failTruncate = false;
  await fsp.writeFile(f.file(), original); assert.equal(journal.recoveryPending(), true);
  await assert.rejects(f.api.sweepLogsStore({ logsKeepDays: 7 }, { freedBytes: 0, actions: [] }), { code: 'work_data_journal.recovery_required' });
  assert.deepEqual(await fsp.readFile(f.file()), original); assert.equal(journal.recoveryPending(), true);
});


test('retention rechecks OFF mutation admission after an authenticated read proof even with a frozen complete stat', async t => {
  const f = auditFixture(t); f.state.enabled = false; f.state.now = '2020-01-01T00:00:00.000Z';
  const sealed = JSON.stringify({ w: 2, e: f.shared.WorkDataCrypto.seal('{"kind":"external"}', f.master,
    { purpose: 'audit', instanceId: 'a'.repeat(32), schema: 2, scopeId: '2020-01-01', recordId: 'audit-log:0', seq: 0 }) }) + '\n';
  await fsp.writeFile(f.file(), 'x'.repeat(Buffer.byteLength(sealed) - 1) + '\n');
  f.state.freezeFile = f.file(); f.state.frozenStat = await fsp.stat(f.file(), { bigint: true });
  const originalRead = f.context.readWorkbenchLogFile;
  f.context.readWorkbenchLogFile = async (...args) => {
    const proof = await originalRead(...args), check = proof.check;
    return { ...proof, check: async () => { await check(); await fsp.writeFile(f.file(), sealed); } };
  };
  await assert.rejects(f.api.sweepLogsStore({ logsKeepDays: 7 }, { freedBytes: 0, actions: [] }), { code: 'work_data_journal.downgrade_refused' });
  assert.equal(await fsp.readFile(f.file(), 'utf8'), sealed); assert.equal(f.state.acquires, 0);
});


test('audit switch waits for the current configuration recovery write chain and any same-tick replacement before rereading config', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  let releaseFirst, releaseRecovery, reads = 0;
  f.context.configWriteChain = new Promise(resolve => { releaseFirst = resolve; });
  f.state.onConfig = async () => { reads++; };
  f.api.logEvent({ kind: 'config_recovered' }); const flushing = f.api.flushWorkbenchLogs();
  f.context.configWriteChain = new Promise(resolve => { releaseRecovery = resolve; });
  try {
    releaseFirst(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(fs.existsSync(f.file()), false);
    releaseRecovery(); await flushing;
    assert.equal(reads, 1); assert.equal((await f.api.readLogTailSnapshot(10)).count, 1);
  } finally { releaseFirst(); releaseRecovery(); await flushing.catch(() => {}); }
});


test('read-only audit switch accepts BOM/ordinary legacy defaults and never invokes config recovery or backup writes', async t => {
  for (const raw of ['\uFEFF{"workDataEncryptionV1":false}', '{"legacyOption":1}']) {
    const f = auditFixture(t); f.state.configRaw = raw;
    const prev = require('node:path').join(f.dir, 'config.json.prev'), corrupt = require('node:path').join(f.dir, 'config.json.corrupt');
    await fsp.writeFile(prev, 'PREVIOUS CONFIG'); await fsp.writeFile(corrupt, 'CORRUPT CONFIG');
    f.api.logEvent({ kind: 'read_only' }); await f.api.flushWorkbenchLogs();
    assert.equal((await f.api.readLogTailSnapshot(10)).count, 1); assert.equal(f.state.acquires, 0);
    assert.equal(await fsp.readFile(prev, 'utf8'), 'PREVIOUS CONFIG'); assert.equal(await fsp.readFile(corrupt, 'utf8'), 'CORRUPT CONFIG');
  }
});

test('read-only audit switch refuses missing/invalid/empty configuration and invalid explicit work-data consent without OFF fallback', async t => {
  for (const raw of ['', ' ', 'not-json', 'null', '[]', '{}', '{"workDataEncryptionV1":"false"}', '{"workDataEncryptionV1":0}']) {
    const f = auditFixture(t); f.state.configRaw = raw;
    f.api.logEvent({ kind: 'must_not_write' });
    await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_journal.switch_unavailable' });
    assert.equal(fs.existsSync(f.file()), false); assert.equal(f.state.acquires, 0);
  }
  const f = auditFixture(t); f.state.configError = Object.assign(Error('missing config'), { code: 'ENOENT' });
  await assert.rejects(f.api.workbenchAuditJournal(f.file()).preflight(), { code: 'work_data_journal.switch_unavailable' });
  assert.equal(fs.existsSync(f.file()), false); assert.equal(f.state.acquires, 0);
});

test('read-only switch uses normalized privacy recovery state and existing degraded guard', async t => {
  const f = auditFixture(t); f.state.configRaw = '{"privacyModeV1":"broken","workDataEncryptionV1":false}';
  f.context.normalizeConfig = raw => ({ config: { ...raw, privacyPolicyRecoveryRequiredV1: true } });
  await assert.rejects(f.api.workbenchAuditJournal(f.file()).preflight(), { code: 'work_data_journal.switch_unavailable' });
  f.context.configDegraded = true; let reads = 0; f.state.onConfig = async () => { reads++; };
  await assert.rejects(f.api.workbenchAuditJournal(f.file()).preflight(), { code: 'work_data_journal.switch_unavailable' });
  assert.equal(reads, 0); assert.equal(f.state.acquires, 0);
});

test('read-only switch refuses generation/chain/vault changes and a credential-import journal appearing during its read', async t => {
  for (const change of ['generation', 'chain', 'vault', 'import']) {
    const f = auditFixture(t);
    if (change === 'vault') { let calls = 0; f.context.PrivacyCore = { configHooks: { stateStamp: async () => ++calls === 1 ? 'before' : 'after' } }; }
    f.state.onConfig = async () => {
      if (change === 'generation') f.context.configReadGeneration++;
      if (change === 'chain') f.context.configWriteChain = Promise.resolve();
      if (change === 'import') await fsp.writeFile(require('node:path').join(f.dir, 'credential-import-v1.json'), 'pending');
    };
    await assert.rejects(f.api.workbenchAuditJournal(f.file()).preflight(), { code: 'work_data_journal.switch_unavailable' });
    assert.equal(f.state.acquires, 0); assert.equal(fs.existsSync(f.file()), false);
  }
});

test('audit switch waits for its mutator before write admission and until post-write publication', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  let releaseMutator, reads = 0, flushed = false;
  f.context.configMutateChain = new Promise(resolve => { releaseMutator = resolve; });
  f.state.onConfig = async () => { reads++; };
  // applyConfigPatch logs inside its mutator, before writeConfigAtomic replaces
  // configWriteChain. The old, already-resolved write chain is not a barrier.
  f.api.logEvent({ kind: 'config_providers_shrunk' });
  const flushing = f.api.flushWorkbenchLogs().then(() => { flushed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(flushed, false); assert.equal(fs.existsSync(f.file()), false);
    f.context.configWriteChain = Promise.resolve(); f.context.configReadGeneration++;
    // The physical write has finished; configEmitWritten still belongs to the
    // pending mutator and must publish before the audit samples its generation.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(flushed, false);
    f.context.configReadGeneration++; releaseMutator(); await flushing;
    assert.equal(reads, 1);
    const rows = (await fsp.readFile(f.file(), 'utf8')).trimEnd().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.kind), ['config_providers_shrunk']);
    assert.equal(f.state.diagnostics.length, 0);
  } finally { releaseMutator(); await flushing.catch(() => {}); }
});

test('audit switch waits for a queued replacement mutator without accepting its old committed policy', async t => {
  const f = auditFixture(t); f.state.enabled = false;
  let releaseFirst, releaseSecond, reads = 0;
  f.context.configMutateChain = new Promise(resolve => { releaseFirst = resolve; });
  f.state.onConfig = async () => { reads++; };
  f.api.logEvent({ kind: 'config_providers_cleared' }); const flushing = f.api.flushWorkbenchLogs();
  f.context.configMutateChain = new Promise(resolve => { releaseSecond = resolve; });
  try {
    releaseFirst(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0); assert.equal(fs.existsSync(f.file()), false);
    releaseSecond(); await flushing;
    assert.equal(reads, 1); assert.equal(f.state.diagnostics.length, 0);
  } finally { releaseFirst(); releaseSecond(); await flushing.catch(() => {}); }
});

test('one concurrent configuration revision change retries the same audit batch against current policy', async t => {
  for (const change of ['generation', 'write', 'mutate']) {
    const f = auditFixture(t); f.state.enabled = false; let reads = 0;
    f.state.onConfig = async () => {
      if (++reads !== 1) return;
      if (change === 'generation') f.context.configReadGeneration++;
      if (change === 'write') f.context.configWriteChain = Promise.resolve();
      if (change === 'mutate') f.context.configMutateChain = Promise.resolve();
      f.state.enabled = true;
    };
    f.api.logEvent({ kind: 'config_changed', value: 'PRIVATE RETRIED EVENT' }); await f.api.flushWorkbenchLogs();
    assert.equal(reads, 2); assert.equal(f.state.diagnostics.length, 0);
    assert.equal((await fsp.readFile(f.file(), 'utf8')).includes('PRIVATE RETRIED EVENT'), false);
    const rows = await f.api.readWorkbenchAudit(10);
    assert.equal(rows.length, 1); assert.equal(rows[0].type, 'config_changed');
  }
});

test('audit policy retries are bounded and corrupt policy, pending import or vault changes never qualify', async t => {
  const moving = auditFixture(t); let movingReads = 0;
  moving.state.onConfig = async () => { movingReads++; moving.context.configReadGeneration++; };
  moving.api.logEvent({ kind: 'unstable' });
  await assert.rejects(moving.api.flushWorkbenchLogs(), { code: 'work_data_journal.switch_unavailable' });
  assert.equal(movingReads, 3); assert.equal(fs.existsSync(moving.file()), false);
  for (const fault of ['invalid', 'import', 'vault']) {
    const f = auditFixture(t); let reads = 0;
    if (fault === 'invalid') f.state.configRaw = '{broken';
    if (fault === 'vault') { let stamp = 0; f.context.PrivacyCore = { configHooks: { stateStamp: async () => String(++stamp) } }; }
    f.state.onConfig = async () => {
      reads++; f.context.configReadGeneration++;
      if (fault === 'import') await fsp.writeFile(require('node:path').join(f.dir, 'credential-import-v1.json'), 'pending');
    };
    f.api.logEvent({ kind: 'invalid_policy' });
    await assert.rejects(f.api.flushWorkbenchLogs(), { code: 'work_data_journal.switch_unavailable' });
    assert.equal(reads, 1); assert.equal(fs.existsSync(f.file()), false);
  }
});

'use strict';
// Source-concatenated runtime so this focused test can run before generated artifacts
// are rebuilt. The integration E2E drives the generated server separately.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-work-journals-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), root));
const appDir = path.resolve(__dirname, '../../ruyi-workbench/app'), src = path.join(appDir, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const names = ['workDataKeys', 'readConfig', 'writeConfig', 'createSession', 'appendIntervention', 'readInterventionsWithMeta', 'readInterventions', 'compactInterventionJournal',
  'appendMissionChangeRecord', 'readMissionChangesWithMeta', 'transitionInterventionState', 'markInterruptedInterventions',
  'interventionWriteChains', 'missionChangeWriteChains', 'sessionWriteChains'];
const mod = new Module(path.join(appDir, 'server.js'), module); mod.filename = path.join(appDir, 'server.js'); mod.paths = Module._nodeModulePaths(appDir);
mod._compile(manifest.modules.map(item => fs.readFileSync(path.join(src, item.file), 'utf8')).join('\n') + '\nmodule.exports.__journalTest = {' + names.join(',') + '};', mod.filename);
const api = mod.exports.__journalTest;
const journal = (sid, kind) => path.join(root, 'sessions', sid + '.' + kind + '.ndjson');
const read = (sid, kind) => fs.readFileSync(journal(sid, kind), 'utf8');
const toggle = async enabled => { const config = await api.readConfig(); config.workDataEncryptionV1 = enabled; await api.writeConfig(config); };
const iv = (id, patch = {}) => ({ id, type: 'permission', status: 'pending', requestedAt: '2026-10-23T00:00:00Z', input: 'SYNTHETIC-PRIVATE-COMMAND', ...patch });
const change = seq => ({ seq, type: 'progress', detail: { note: 'SYNTHETIC-PRIVATE-CHANGE' } });
const workError = error => String(error.code || '').startsWith('work_data');
after(async () => {
  for (let i = 0; i < 3; i++) await Promise.all([...api.interventionWriteChains.values(), ...api.missionChangeWriteChains.values(), ...api.sessionWriteChains.values()].map(value => value.catch(() => {})));
  api.workDataKeys.clear(); assert.equal(path.dirname(root), tempBase); fs.rmSync(root, { recursive: true, force: true });
});

test('OFF journal appends preserve exact plaintext bytes and create no work-data key', async () => {
  await toggle(false); const session = await api.createSession({ title: 'journal off', cwd: root });
  const row = iv('off-row'); assert.equal(await api.appendIntervention(session.id, row), true);
  assert.equal(read(session.id, 'interventions'), JSON.stringify(row) + '\n');
  await api.appendMissionChangeRecord(session.id, change(1));
  assert.equal(read(session.id, 'changes'), JSON.stringify(change(1)) + '\n');
  assert.equal(fs.existsSync(path.join(root, 'work-data-key-v1.json')), false);
});

test('ON journals append independently authenticated ordinals without rewriting legacy prefixes', { skip: process.platform !== 'win32' && 'DPAPI only' }, async () => {
  await toggle(false); const session = await api.createSession({ title: 'journal mixed', cwd: root });
  await api.appendIntervention(session.id, iv('legacy'));
  const legacy = read(session.id, 'interventions');
  await toggle(true); await api.workDataKeys.ensure();
  await api.appendIntervention(session.id, iv('sealed'));
  const first = read(session.id, 'interventions'); assert.ok(first.startsWith(legacy));
  assert.equal(JSON.parse(first.trim().split('\n')[1]).e.seq, 1);
  await api.appendIntervention(session.id, iv('sealed', { status: 'denied', interventionVersion: 1 }));
  const second = read(session.id, 'interventions'); assert.ok(second.startsWith(first));
  assert.equal(JSON.parse(second.trim().split('\n')[2]).e.seq, 2);
  assert.equal((await api.readInterventions(session.id)).find(row => row.id === 'sealed').status, 'denied');
  assert.ok(!second.slice(legacy.length).includes('SYNTHETIC-PRIVATE-COMMAND'));
  await api.appendMissionChangeRecord(session.id, change(7));
  assert.equal(JSON.parse(read(session.id, 'changes').trim()).e.seq, 0, 'physical ordinal is independent of business revision');
  const changes = await api.readMissionChangesWithMeta(session.id, 7);
  assert.equal(changes.records[0].seq, 7); assert.equal(changes.degraded, false);
});

test('encrypted journals reject tampering, cross-kind copies, reordering and missing keys without changing authority', { skip: process.platform !== 'win32' && 'DPAPI only' }, async () => {
  await toggle(true); await api.workDataKeys.ensure();
  const session = await api.createSession({ title: 'journal binding', cwd: root });
  await api.appendIntervention(session.id, iv('first')); await api.appendIntervention(session.id, iv('second'));
  const file = journal(session.id, 'interventions'), original = fs.readFileSync(file, 'utf8'), lines = original.trim().split('\n');
  const other = await api.createSession({ title: 'journal other', cwd: root });
  fs.writeFileSync(journal(other.id, 'interventions'), original);
  await assert.rejects(api.readInterventions(other.id), workError);
  fs.writeFileSync(journal(session.id, 'changes'), lines[0] + '\n');
  await assert.rejects(api.readMissionChangesWithMeta(session.id, 1), workError);
  for (const altered of [lines.slice().reverse().join('\n') + '\n', original.replace('"w":2', '"w":3'), '{"w":2,"e":null}\n']) {
    fs.writeFileSync(file, altered);
    await assert.rejects(api.readInterventions(session.id), workError);
    await assert.rejects(api.compactInterventionJournal(session.id, { force: true }), workError);
    assert.notEqual(await api.appendIntervention(session.id, iv('must-not-append')), true);
    assert.equal(fs.readFileSync(file, 'utf8'), altered);
  }
  fs.writeFileSync(file, original); api.workDataKeys.clear();
  const key = path.join(root, 'work-data-key-v1.json'); fs.renameSync(key, key + '.away');
  try {
    await assert.rejects(api.readInterventions(session.id), workError);
    assert.notEqual(await api.appendIntervention(session.id, iv('missing-key')), true);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { fs.renameSync(key + '.away', key); }
  await toggle(false);
  assert.notEqual(await api.appendIntervention(session.id, iv('downgrade')), true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('long encrypted torn tails repair at the last complete LF and compaction preserves CAS state', { skip: process.platform !== 'win32' && 'DPAPI only' }, async () => {
  await toggle(true); await api.workDataKeys.ensure();
  const session = await api.createSession({ title: 'journal tail', cwd: root });
  await api.appendIntervention(session.id, iv('one'));
  const prefix = read(session.id, 'interventions');
  fs.appendFileSync(journal(session.id, 'interventions'), '{"w":2,"e":' + 'x'.repeat(170000));
  assert.equal(await api.appendIntervention(session.id, iv('two')), true);
  const repaired = read(session.id, 'interventions'); assert.ok(repaired.startsWith(prefix));
  assert.equal(repaired.trim().split('\n').length, 2);
  const result = await api.transitionInterventionState(session.id, 'one', 0, 'allowed', { action: () => 'done', buildResponse: () => ({ ok: true, receipt: 'receipt-once' }), idempotencyKey: 'once' });
  assert.equal(result.ok, true);
  const before = await api.readInterventions(session.id), compacted = await api.compactInterventionJournal(session.id, { force: true });
  assert.equal(compacted.compacted, true); assert.deepEqual(await api.readInterventions(session.id), before);
  assert.ok(read(session.id, 'interventions').trim().split('\n').every((line, index) => JSON.parse(line).e.seq === index));
  let executed = false;
  await api.transitionInterventionState(session.id, 'one', 0, 'allowed', { action: () => { executed = true; } });
  assert.equal(executed, false);
});

test('cached append authority is bound to the unlocked instance/key and encode failures never repair the tail', { skip: process.platform !== 'win32' && 'DPAPI only' }, async () => {
  await toggle(true); await api.workDataKeys.ensure();
  const session = await api.createSession({ title: 'journal credential cache', cwd: root });
  await api.appendIntervention(session.id, iv('primed'));
  const target = journal(session.id, 'interventions'), original = fs.readFileSync(target, 'utf8');
  const keyFile = path.join(root, 'work-data-key-v1.json'); api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.old');
  try {
    await api.workDataKeys.ensure(); // a valid different instance/master, not merely a missing key
    assert.notEqual(await api.appendIntervention(session.id, iv('new-key')), true);
    assert.equal(fs.readFileSync(target, 'utf8'), original);
    await assert.rejects(api.readInterventions(session.id), workError);
  } finally { api.workDataKeys.clear(); fs.unlinkSync(keyFile); fs.renameSync(keyFile + '.old', keyFile); }
  const torn = original + '{"w":2,"e":' + 'x'.repeat(90000); fs.writeFileSync(target, torn);
  assert.notEqual(await api.appendIntervention(session.id, iv('too-big', { input: 'x'.repeat(1024 * 1024 + 1) })), true);
  assert.equal(fs.readFileSync(target, 'utf8'), torn, 'failed encoding cannot remove even the uncommitted suffix');
  assert.equal(await api.appendIntervention(session.id, iv('valid-after-failure')), true);
  assert.ok(fs.readFileSync(target, 'utf8').startsWith(original));
});

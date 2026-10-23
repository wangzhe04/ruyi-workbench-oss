'use strict';
require('./lib/self-isolate-home');
// Generated runtime, actual DPAPI and isolated disk journals. The six crash
// windows reload a new module/key set before normal boot reconciliation.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('WORK DATA SESSION JOURNALS'), tempBase = path.resolve(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempBase, 'ruyi-session-journals-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), root));
const names = ['workDataKeys', 'readConfig', 'writeConfig', 'createSession', 'appendIntervention', 'readInterventions', 'readInterventionsWithMeta',
  'compactInterventionJournal', 'appendMissionChangeRecord', 'readMissionChangesWithMeta', 'transitionInterventionState', 'markInterruptedInterventions',
  'interventionWriteChains', 'missionChangeWriteChains', 'sessionWriteChains'];
const api = loadServerInternals(names);
const file = (sid, kind) => path.join(root, 'sessions', sid + '.' + kind + '.ndjson');
const read = (sid, kind) => fs.readFileSync(file(sid, kind), 'utf8');
const toggle = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on; await api.writeConfig(config); };
const row = (id, patch = {}) => ({ id, type: 'permission', status: 'pending', requestedAt: '2026-10-23T00:00:00Z', input: 'PRIVATE-JOURNAL-COMMAND', ...patch });
const change = seq => ({ seq, type: 'progress', detail: { text: 'PRIVATE-CHANGE-NOTE' } });
const workError = error => String(error.code || '').startsWith('work_data');
const modules = [api];
async function check(label, work) { try { await work(); t.ok(true, label); } catch (error) { t.fail(label + ': ' + error.stack); } }
async function drain() { for (let i = 0; i < 3; i++) for (const loaded of modules) await Promise.all([...loaded.interventionWriteChains.values(), ...loaded.missionChangeWriteChains.values(), ...loaded.sessionWriteChains.values()].map(value => value.catch(() => {}))); }
(async () => {
  try {
    await toggle(false);
    const legacy = await api.createSession({ title: 'Synthetic legacy journal', cwd: root });
    await api.appendIntervention(legacy.id, row('legacy'));
    await api.appendMissionChangeRecord(legacy.id, change(1));
    const legacyIv = read(legacy.id, 'interventions'), legacyChange = read(legacy.id, 'changes');
    t.ok(legacyIv === JSON.stringify(row('legacy')) + '\n' && legacyChange === JSON.stringify(change(1)) + '\n', 'OFF preserves exact append bytes in both journals');
    t.ok(!fs.existsSync(path.join(root, 'work-data-key-v1.json')), 'OFF creates no work-data key');
    if (process.platform !== 'win32') { console.log('SKIP encrypted journal lifecycle requires Windows DPAPI; record codec is covered cross-platform'); return; }
    await toggle(true); await api.workDataKeys.ensure();
    await check('ON resumes both legacy journals with sealed append-only tails and normal readers', async () => {
      assert.equal(await api.appendIntervention(legacy.id, row('on')), true);
      await api.appendMissionChangeRecord(legacy.id, change(2));
      assert.ok(read(legacy.id, 'interventions').startsWith(legacyIv)); assert.ok(read(legacy.id, 'changes').startsWith(legacyChange));
      assert.equal(JSON.parse(read(legacy.id, 'interventions').trim().split('\n')[1]).e.seq, 1);
      assert.equal(JSON.parse(read(legacy.id, 'changes').trim().split('\n')[1]).e.seq, 1);
      assert.equal((await api.readInterventions(legacy.id)).length, 2);
      assert.equal((await api.readMissionChangesWithMeta(legacy.id, 2)).degraded, false);
      await api.appendMissionChangeRecord(legacy.id, change(4));
      assert.equal((await api.readMissionChangesWithMeta(legacy.id, 4)).gap.expected, 3, 'head/journal gaps remain visible');
    });
    await check('ON repairs a sealed torn suffix larger than 64 KiB before one authenticated append', async () => {
      const before = read(legacy.id, 'interventions');
      fs.appendFileSync(file(legacy.id, 'interventions'), '{"w":2,"e":' + 'x'.repeat(190000));
      assert.equal(await api.appendIntervention(legacy.id, row('after-tail')), true);
      const after = read(legacy.id, 'interventions'); assert.ok(after.startsWith(before));
      assert.equal(after.trim().split('\n').length, before.trim().split('\n').length + 1);
      assert.equal((await api.readInterventions(legacy.id)).length, 3);
    });
    const cases = [], windows = ['before_applying', 'after_applying', 'before_resolve', 'after_resolve', 'before_terminal', 'after_terminal'];
    await check('all six CAS crash windows preserve the exact execution count and encrypted authority', async () => {
      for (const crashAt of windows) {
        const session = await api.createSession({ title: 'Synthetic ' + crashAt, cwd: root });
        await api.appendIntervention(session.id, row(crashAt)); let executions = 0;
        await assert.rejects(api.transitionInterventionState(session.id, crashAt, 0, 'allowed', { crashAt, action: () => { executions++; return 'done'; } }), /__cas_crash/);
        assert.equal(executions, ['after_resolve', 'before_terminal', 'after_terminal'].includes(crashAt) ? 1 : 0);
        const physical = read(session.id, 'interventions'); assert.ok(!physical.includes('PRIVATE-JOURNAL-COMMAND'));
        assert.ok(physical.trim().split('\n').every((line, ordinal) => JSON.parse(line).e.seq === ordinal));
        cases.push({ sessionId: session.id, crashAt });
      }
    });
    await drain();
    const restarted = loadServerInternals(names); modules.push(restarted);
    await check('restart reconciles pending/applying honestly without replaying a completed action', async () => {
      await restarted.markInterruptedInterventions();
      for (const entry of cases) {
        const current = (await restarted.readInterventions(entry.sessionId)).find(item => item.id === entry.crashAt);
        assert.equal(current.status, entry.crashAt === 'before_applying' ? 'cancelled_restart' : entry.crashAt === 'after_terminal' ? 'allowed' : 'indeterminate');
        let replayed = false;
        await restarted.transitionInterventionState(entry.sessionId, entry.crashAt, 0, 'allowed', { action: () => { replayed = true; } });
        assert.equal(replayed, false);
      }
    });
    await check('compaction re-seals new physical ordinals while retaining every terminal state and version', async () => {
      const id = cases.find(item => item.crashAt === 'after_terminal').sessionId;
      const before = await restarted.readInterventions(id), result = await restarted.compactInterventionJournal(id, { force: true });
      assert.equal(result.compacted, true); assert.deepEqual(await restarted.readInterventions(id), before);
      assert.ok(read(id, 'interventions').trim().split('\n').every((line, ordinal) => JSON.parse(line).e.seq === ordinal));
    });
    await check('missing keys reject CAS/append/compaction and preserve both journal files byte-for-byte', async () => {
      const beforeIv = read(legacy.id, 'interventions'), beforeChanges = read(legacy.id, 'changes');
      for (const loaded of modules) loaded.workDataKeys.clear();
      const key = path.join(root, 'work-data-key-v1.json'); fs.renameSync(key, key + '.away');
      try {
        await assert.rejects(api.readInterventions(legacy.id), workError);
        await assert.rejects(api.readMissionChangesWithMeta(legacy.id, 4), workError);
        await assert.rejects(api.compactInterventionJournal(legacy.id, { force: true }), workError);
        let executed = false;
        await assert.rejects(api.transitionInterventionState(legacy.id, 'on', 0, 'allowed', { action: () => { executed = true; } }), workError);
        assert.equal(executed, false); assert.notEqual(await api.appendIntervention(legacy.id, row('missing')), true);
        await assert.rejects(api.appendMissionChangeRecord(legacy.id, change(5)), workError);
        assert.equal(read(legacy.id, 'interventions'), beforeIv); assert.equal(read(legacy.id, 'changes'), beforeChanges);
      } finally { fs.renameSync(key + '.away', key); }
    });
  } finally {
    await drain(); for (const loaded of modules) loaded.workDataKeys.clear();
    assert.equal(path.dirname(root), tempBase); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());

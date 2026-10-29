'use strict';
// ROOT SERIAL / Windows Node24. Actual product modules construct an owned claim
// under a real OS owner and deliberately exit 73; this is not a captured natural
// production cold-worker crash. The generated server runs the actual explicit
// doctor command, DPAPI/full snapshot/native flush and subsequent normal serve.
// Plain and encrypted sources recover with maintenanceOutcome=unknown. Invalid
// or missing source keys and a matching result with a bad backup refuse without
// replay, target activation or a manufactured completion result. Ordinary files
// and settled empty special stores only; no whole M3-3/3.1 acceptance claim.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const core = require('./lib/work-data-production-upload-core'), restore = require('./work-data-production-restore.e2e'), upload = require('./work-data-production-upload.e2e');
const { bindTarget, createProducer, sourceProof } = require('./lib/work-data-owned-claim-fixture.js');
const { releaseEnvironment } = require('./lib/release-checks'), { snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const PASSWORD = 'SYNTHETIC owned-source seed only 2026', SESSION = 'sess_restore_synthetic';
const AUTHORITY0 = { generation: 0, id: null, mode: 'plain', sha256: null };
const keys = value => Object.keys(value).sort().join(',');
function sameBytesAndIdentity(file, row) { const got = core.read(file).row; for (const key of ['bytes', 'sha256', 'dev', 'ino']) assert.equal(got[key], row[key], file + ': ' + key); }
async function runActual(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 0, 'permanent E2E uses the current complete product build');
  const runner = require('./lib/harness').createRunner('WORK DATA OWNED SOURCE RECOVERY');
  if (process.platform !== 'win32') { console.log('SKIP Windows native owned-source recovery E2E'); runner.done(); return { skipped: true }; }
  assert.equal(Number(process.versions.node.split('.')[0]), 24); require('./lib/self-isolate-home');
  const harness = __dirname, target = bindTarget(harness, __filename), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-owned-source-')), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  const world = restore.createWorld({ root, evidence, target, harness, releaseEnvironment, snapshotProcessTable, ownDescendants, getFreePort }), producers = [];
  world.openJournal();
  function fixture(label) {
    const f = world.fixture(label), orphan = path.join(f.targets, 'unresolved-synthetic-target'); fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, 'sentinel.txt'), 'SYNTHETIC unknown target; preserve exact bytes', { flag: 'wx' });
    fs.writeFileSync(path.join(f.backups, 'unrelated.keep'), 'SYNTHETIC unrelated backup; preserve exact bytes', { flag: 'wx' });
    return f;
  }
  function sideState(f, claimRoot) {
    const names = fs.readdirSync(f.temp).filter(name => /^ruyi-work-data-(?:handoff|activation|upload)-/.test(name) && path.join(f.temp, name).toLowerCase() !== claimRoot.toLowerCase()).sort();
    const preference = path.join(f.home, '.ruyi', 'boot-root-v1.json');
    return { backups: core.inventory(f.backups, { directoryMetadata: true }), targets: core.inventory(f.targets, { directoryMetadata: true }),
      otherTemp: names.map(name => ({ name, tree: core.inventory(path.join(f.temp, name), { directoryMetadata: true }) })),
      preference: fs.existsSync(preference) ? core.read(preference).row : null };
  }
  function state(f) { const claimRoot = path.dirname(world.claimFile(f)); return { source: core.inventory(f.base, { directoryMetadata: true }), side: sideState(f, claimRoot), claim: core.inventory(claimRoot, { directoryMetadata: true }) }; }
  async function owned(f, parent, label, { id = crypto.randomBytes(24).toString('hex'), operation = 'restore', ownedAt = new Date().toISOString() } = {}) {
    const producer = createProducer({ world, target, harness, root, evidence, label }); producers.push(producer);
    const produced = await producer.run({ f, parent, id, operation, ownedAt }); producer.assertClosed();
    world.checked(label + ': a Job-owned actual producer dies with this owned claim and both original PIDs absent');
    return produced;
  }
  async function startSource(f, label, expectedAuthority, expectedResult, { seedLegacy = false } = {}) {
    world.ctx.phase = label;
    const business = [path.join(f.base, 'sessions', SESSION + '.json')];
    if (expectedAuthority.generation > 0) {
      const active = path.join(f.base, '.work-data', 'generations', expectedAuthority.id);
      business.push(path.join(f.base, '.work-data', 'active-v1.json'), path.join(active, 'work-data-key-v1.json'), path.join(active, 'sessions', SESSION + '.json'));
    }
    if (expectedResult) business.push(path.join(f.base, '.work-data', 'maintenance-result-v1.json'));
    // world.fixture deliberately supplies a legacy inline-messages session. Only
    // the two first seed GETs perform its existing load_migrate -> v2 lifecycle;
    // doctor and every later normal boot start from the normalized byte baseline.
    let legacy = null;
    if (seedLegacy) {
      assert.ok(label === 'plain-seed' || label === 'encrypted-seed');
      assert.deepEqual(expectedAuthority, AUTHORITY0); assert.equal(expectedResult, null); assert.equal(business.length, 1);
      legacy = core.read(business[0]); const value = JSON.parse(legacy.bytes);
      assert.equal(keys(value), 'createdAt,cwd,id,messages,private,title,updatedAt'); assert.deepEqual(value.messages, []);
    }
    const pins = business.map(file => core.read(file).row), handle = world.spawnServe(f, label, await getFreePort('127.0.0.1'));
    await handle.spawned; const ref = await world.readyWarm(handle, f); await world.manager.captureNativeBirths(handle);
    const status = await world.waitWorkerReady(ref);
    assert.deepEqual(status.authority, expectedAuthority); assert.equal(status.job, null); assert.deepEqual(status.lastResult, expectedResult);
    assert.ok((await world.sessionIds(ref)).includes(SESSION));
    const read = await upload.makeHttp({ port: ref.port, token: ref.token }, '/api/sessions/' + SESSION, undefined, { guard: world.healthy });
    assert.equal(read.status, 200); assert.equal(read.value?.ok, true); assert.equal(read.value?.session?.id, SESSION);
    assert.equal(read.value?.session?.title, 'Synthetic restore session'); assert.ok(Array.isArray(read.value?.session?.messages));
    if (seedLegacy) {
      const { messages, ...original } = JSON.parse(legacy.bytes), expected = { ...original, schemaVersion: 1, turnSeq: 0,
        attachments: [], todos: [], mission: null, skills: [], memories: [], memoriesExplicit: false, memoryExclusions: [],
        storageVersion: 2, messageCount: 0, providerHistoryCount: 0 };
      const normalized = core.read(business[0]); assert.deepEqual(normalized.bytes, Buffer.from(JSON.stringify(expected, null, 2)));
      const bodies = ['messages', 'provider'].map(kind => core.read(path.join(f.base, 'sessions', SESSION + '.' + kind + '.ndjson')));
      for (const body of bodies) assert.equal(body.row.bytes, 0);
      // OFF's original-byte v1bak is best effort and a later complete v2 read may
      // retire it. If retained here, it must still be the exact legacy bytes.
      const backupFile = business[0] + '.v1bak', backup = fs.existsSync(backupFile) ? core.read(backupFile) : null;
      if (backup) assert.deepEqual(backup.bytes, legacy.bytes);
      world.checkpoint(label + '-normalized-session-baseline', { kind: 'seed-legacy-to-v2-before-recovery',
        legacy: legacy.row, normalized: normalized.row, bodies: bodies.map(body => body.row), backup: backup?.row || null });
    } else for (const pin of pins) core.samePinned(core.read(pin.file).row, pin);
    world.assertNoIntent(f, label); return ref;
  }
  async function refuseBoot(f, produced, label) {
    world.ctx.phase = label; const before = state(f), handle = world.spawnServe(f, label, await getFreePort('127.0.0.1'));
    await handle.spawned; assert.deepEqual(await world.manager.waitClose(handle, 60000), { code: 1, signal: null });
    await world.manager.certifyExpectedRefusal(handle, async () => {
      const after = state(f), previous = new Set(before.side.otherTemp.map(row => row.name));
      assert.deepEqual(after.source, before.source); assert.deepEqual(after.claim, before.claim);
      assert.deepEqual({ ...after.side, otherTemp: after.side.otherTemp.filter(row => previous.has(row.name)) }, before.side);
      // acquireServe allocates custody before jointly acquiring source+upload;
      // inspectBoot refusal deliberately leaves that never-configured empty root.
      // Existing TEMP trees stay exact. This allowance belongs only to serve:
      // the explicit doctor below bypasses bootstrap and still permits no change.
      const additions = after.side.otherTemp.filter(row => !previous.has(row.name));
      assert.ok(additions.length <= 1, 'refused serve may retain at most its one empty custody allocation');
      for (const added of additions) {
        assert.match(added.name, /^ruyi-work-data-upload-[A-Za-z0-9]{6}$/);
        const directory = path.join(f.temp, added.name), stat = fs.lstatSync(directory, { bigint: true });
        assert.equal(path.dirname(directory).toLowerCase(), path.resolve(f.temp).toLowerCase());
        assert.equal(stat.isDirectory(), true); assert.equal(stat.isSymbolicLink(), false);
        assert.equal(stat.reparsePoint === true || typeof stat.reparseTag === 'number' && stat.reparseTag !== 0, false);
        assert.equal(fs.realpathSync.native(directory).toLowerCase(), directory.toLowerCase());
        assert.deepEqual(added.tree.files, []); assert.equal(added.tree.directories.length, 1);
        assert.equal(added.tree.directories[0].file, directory); assert.deepEqual(added.tree.directories[0].entries, []);
        assert.equal(added.tree.directories[0].dev, String(stat.dev)); assert.equal(added.tree.directories[0].ino, String(stat.ino));
        assert.deepEqual(core.inventory(directory, { directoryMetadata: true }), added.tree);
      }
      world.checkpoint(label + '-refused-serve-custody', { kind: 'existing-startup-empty-allocation-residue',
        allocations: additions, scope: 'Refused normal serve only; source doctor still requires exact complete side state.' });
    });
    assert.ok(fs.readFileSync(path.join(evidence, label + '-stderr.log'), 'utf8').includes('work_data_setup.handoff_pending'));
    assert.deepEqual((await world.claimApi(f.temp).inspect({ base: produced.canonical })).receipt, produced.claimBefore.receipt);
    world.checked(label + ': ordinary serve refuses the unknown owned job before touching the source');
  }
  async function doctor(f, produced, label, expectedAuthority, { refuse = false } = {}) {
    world.ctx.phase = label;
    const before = state(f), handle = world.spawnCli(f, label, ['doctor', '--recover-work-data-source']);
    await handle.spawned;
    const terminal = await world.manager.waitClose(handle, 300000);
    const stdout = fs.readFileSync(path.join(evidence, label + '-stdout.log'), 'utf8'), stderr = fs.readFileSync(path.join(evidence, label + '-stderr.log'), 'utf8');
    if (refuse) {
      assert.deepEqual(terminal, { code: 1, signal: null }); assert.equal(stdout.trim(), '');
      assert.ok(stderr.includes('work_data_claim.source_recovery_unverified'));
      await world.manager.certifyExpectedRefusal(handle, async () => assert.deepEqual(state(f), before));
      const after = await world.claimApi(f.temp).inspect({ base: produced.canonical });
      assert.deepEqual(after, produced.claimBefore); core.samePinned(core.read(world.claimFile(f)).row, produced.claimRaw.row);
      world.checked(label + ': doctor refuses and preserves the exact claim, source, targets, backups and other TEMP controls'); return;
    }
    assert.deepEqual(terminal, { code: 0, signal: null }); assert.equal(stderr, '');
    const lines = stdout.trim().split(/\r?\n/); assert.equal(lines.length, 1); const dto = JSON.parse(lines[0]);
    assert.equal(keys(dto), 'authority,diagnostic,id,kind,maintenanceOutcome,schema,sourceProof,sourceReadable');
    assert.equal(dto.schema, 1); assert.equal(dto.kind, 'owned-source-recovery'); assert.equal(dto.id, produced.claimBefore.value.id);
    assert.equal(dto.sourceReadable, true); assert.equal(dto.maintenanceOutcome, 'unknown'); assert.deepEqual(dto.authority, expectedAuthority);
    assert.deepEqual(dto.sourceProof, sourceProof(produced.canonical, before.source));
    const claimRoot = path.dirname(world.claimFile(f));
    assert.equal(keys(dto.diagnostic), 'identity,path,sha256'); assert.equal(path.dirname(dto.diagnostic.path).toLowerCase(), claimRoot.toLowerCase());
    assert.match(path.basename(dto.diagnostic.path), /^unknown-source-v1-[a-f0-9]{48}\.json$/);
    const diagnostic = core.read(dto.diagnostic.path), value = JSON.parse(diagnostic.bytes);
    assert.ok(diagnostic.row.bytes <= 65536); assert.equal(diagnostic.row.sha256, dto.diagnostic.sha256);
    assert.deepEqual({ dev: diagnostic.row.dev, ino: diagnostic.row.ino }, dto.diagnostic.identity);
    assert.equal(keys(value), 'authority,claimBytes,claimReceipt,createdAt,kind,maintenanceOutcome,schema,sourceProof,sourceReadable');
    assert.equal(value.schema, 1); assert.equal(value.kind, 'owned-source-recovery-observation'); assert.equal(value.maintenanceOutcome, 'unknown'); assert.equal(value.sourceReadable, true);
    assert.equal(value.claimBytes, produced.claimRaw.bytes.toString('base64')); assert.deepEqual(Buffer.from(value.claimBytes, 'base64'), produced.claimRaw.bytes);
    // The observed claim owner runs in the harness VM; the durable record is a
    // JSON DTO. Compare its exact data after crossing that serialization boundary.
    assert.deepEqual(value.claimReceipt, JSON.parse(JSON.stringify(produced.claimBefore.receipt))); assert.deepEqual(value.authority, dto.authority); assert.deepEqual(value.sourceProof, dto.sourceProof);
    assert.equal(new Date(value.createdAt).toISOString(), value.createdAt);
    const after = state(f); assert.deepEqual(after.source, before.source); assert.deepEqual(after.side, before.side);
    const expectedFiles = before.claim.files.filter(row => row.file.toLowerCase() !== world.claimFile(f).toLowerCase()).concat(diagnostic.row).sort((a, b) => a.file.localeCompare(b.file));
    assert.deepEqual([...after.claim.files].sort((a, b) => a.file.localeCompare(b.file)), expectedFiles);
    assert.equal(after.claim.directories.length, 1); assert.equal(before.claim.directories.length, 1);
    const beforeDirectory = before.claim.directories[0], afterDirectory = after.claim.directories[0];
    for (const key of ['file', 'dev', 'ino', 'mode', 'nlink']) assert.equal(afterDirectory[key], beforeDirectory[key]);
    assert.deepEqual(afterDirectory.entries, beforeDirectory.entries.filter(name => name !== 'claim-v1.json').concat(path.basename(dto.diagnostic.path)).sort());
    assert.equal((await world.claimApi(f.temp).inspect({ base: produced.canonical })).present, false);
    await world.manager.certifyNaturalExit(handle, { code: 0, signal: null, verify: async () => assert.equal(fs.existsSync(world.claimFile(f)), false) });
    world.checkpoint(label + '-diagnostic', { dto, observation: diagnostic.row, originalClaim: produced.claimRaw.row, constructedCrashWindow: true, operationReplayed: false });
    world.checked(label + ': real doctor returns unknown, durably preserves original claim bytes and retires only the pending name');
  }
  try {
    world.record({ kind: 'fixture-owner', root, nonce: crypto.randomBytes(32).toString('hex'), constructedCrashWindow: true,
      executionInputSha256: target.executionInputSha256, executionInputs: target.boundFiles.length, inputFiles: target.boundFiles });
    const plain = fixture('plain'), initial = await startSource(plain, 'plain-seed', AUTHORITY0, null, { seedLegacy: true });
    await world.manager.cleanupKnown(initial.handle, async () => world.healthy());
    const plainOwned = await owned(plain, initial, 'plain-producer');
    assert.equal(fs.existsSync(path.join(plain.base, '.work-data', 'maintenance-result-v1.json')), false);
    await refuseBoot(plain, plainOwned, 'plain-before-doctor');
    await doctor(plain, plainOwned, 'plain-doctor', AUTHORITY0);
    const plainAfter = await startSource(plain, 'plain-after-doctor', AUTHORITY0, null);
    await world.manager.cleanupKnown(plainAfter.handle, async () => world.healthy());
    world.checked('plain: ordinary serve reacquires the released source and reads the original session after unknown recovery');

    const encrypted = fixture('encrypted'), seed = await startSource(encrypted, 'encrypted-seed', AUTHORITY0, null, { seedLegacy: true });
    const round = await world.runMaintenanceRound(encrypted, seed, { phase: 'encrypted-enable', operation: 'enable',
      body: ({ source }) => ({ operation: 'enable', password: PASSWORD, expectedAuthority: source, backupDirectory: encrypted.backups }),
      verify: async ({ status, jobId, source }) => {
        assert.equal(status.lastResult.id, jobId); assert.equal(status.lastResult.operation, 'enable'); assert.equal(status.lastResult.state, 'published');
        assert.deepEqual(status.lastResult.sourceAuthority, source); assert.deepEqual(status.lastResult.authority, status.authority);
        assert.equal(status.authority.mode, 'encrypted'); assert.equal(status.authority.generation, source.generation + 1); world.assertNoIntent(encrypted, 'encrypted enable'); return {};
      } });
    const saved = round.next.status.lastResult, authority = saved.authority, originalBackup = core.read(saved.backup.path);
    assert.equal(originalBackup.row.sha256, saved.backup.sha256); assert.equal(originalBackup.row.bytes, saved.backup.bytes);
    assert.deepEqual({ dev: originalBackup.row.dev, ino: originalBackup.row.ino }, saved.backup.identity);
    await world.reclaimSuccessor('encrypted-seed', round.next);
    const completed = await owned(encrypted, seed, 'matching-producer', { id: saved.id, operation: saved.operation, ownedAt: saved.finishedAt });
    const tampered = Buffer.from(originalBackup.bytes); tampered[Math.floor(tampered.length / 2)] ^= 1;
    try { fs.writeFileSync(saved.backup.path, tampered); await doctor(encrypted, completed, 'matching-tampered-backup', authority, { refuse: true }); }
    finally { fs.writeFileSync(saved.backup.path, originalBackup.bytes); tampered.fill(0); }
    const hiddenBackup = saved.backup.path + '.synthetic-held';
    try { fs.renameSync(saved.backup.path, hiddenBackup); await doctor(encrypted, completed, 'matching-missing-backup', authority, { refuse: true }); }
    finally { if (fs.existsSync(hiddenBackup)) fs.renameSync(hiddenBackup, saved.backup.path); }
    sameBytesAndIdentity(saved.backup.path, originalBackup.row);
    const completedServe = await startSource(encrypted, 'matching-normal-recovery', authority, saved);
    assert.equal((await world.claimApi(encrypted.temp).inspect({ base: completed.canonical })).present, false);
    await world.manager.cleanupKnown(completedServe.handle, async () => world.healthy());
    world.checked('matching result: missing or tampered backup cannot downgrade to unknown; restored backup permits ordinary completed retirement');

    const unknown = await owned(encrypted, completedServe, 'encrypted-producer'); assert.notEqual(unknown.claimBefore.value.id, saved.id);
    const keyFile = path.join(encrypted.base, '.work-data', 'generations', authority.id, 'work-data-key-v1.json'), originalKey = core.read(keyFile), keyState = JSON.parse(originalKey.bytes);
    assert.equal(typeof keyState.protectedKey, 'string'); assert.ok(keyState.protectedKey.length > 16);
    const at = originalKey.bytes.indexOf(Buffer.from(keyState.protectedKey)); assert.ok(at >= 0);
    const brokenKey = Buffer.from(originalKey.bytes), byte = at + Math.floor(keyState.protectedKey.length / 2); brokenKey[byte] = brokenKey[byte] === 65 ? 66 : 65;
    try { fs.writeFileSync(keyFile, brokenKey); await doctor(encrypted, unknown, 'encrypted-invalid-key', authority, { refuse: true }); }
    finally { fs.writeFileSync(keyFile, originalKey.bytes); brokenKey.fill(0); }
    const hiddenKey = path.join(root, 'synthetic-held-source-key.json');
    try { fs.renameSync(keyFile, hiddenKey); await doctor(encrypted, unknown, 'encrypted-missing-key', authority, { refuse: true }); }
    finally { if (fs.existsSync(hiddenKey)) fs.renameSync(hiddenKey, keyFile); }
    sameBytesAndIdentity(keyFile, originalKey.row); sameBytesAndIdentity(saved.backup.path, originalBackup.row);
    await refuseBoot(encrypted, unknown, 'encrypted-before-doctor');
    await doctor(encrypted, unknown, 'encrypted-doctor', authority);
    const encryptedAfter = await startSource(encrypted, 'encrypted-after-doctor', authority, saved);
    assert.notEqual(encryptedAfter.pid, completedServe.pid); assert.notEqual(saved.id, unknown.claimBefore.value.id);
    await world.manager.cleanupKnown(encryptedAfter.handle, async () => world.healthy());
    world.checked('encrypted: ordinary serve reads the original session; the older valid result never becomes this unknown job completion');
    for (const producer of producers) producer.assertClosed();
    assert.equal(world.manager.hasUnclosed(), false); assert.equal(world.manager.hasUnverifiedSpawn(), false);
    world.checkpoint('result', { schema: 1, checks: world.ctx.checks, inputProof: target.recheck(), constructedCrashWindow: true, operationReplayed: false,
      scope: 'Actual source doctor and subsequent source serve only; no production crash capture, unknown target completion, maintenance replay or whole M3-3 acceptance.' });
    for (const label of world.ctx.checks) runner.ok(true, label);
    console.log('Retained synthetic owned-source recovery evidence ' + root); runner.done(); return { passed: true, root };
  } catch (error) {
    world.latch(error);
    try { world.close(); } catch {}
    for (const producer of producers) try { producer.holdFailure(); } catch {}
    try { fs.writeFileSync(path.join(evidence, 'failure-summary.json'), JSON.stringify({ schema: 1, phase: world.ctx.phase, code: error?.code || 'E2E_FAILURE', stack: String(error?.stack || '') }), { flag: 'wx' }); } catch {}
    console.error('Retained synthetic owned-source recovery evidence ' + root + '; phase=' + world.ctx.phase); process.exitCode = 1; process.exit(1);
  } finally { world.close(); }
}
module.exports = { runActual };
if (require.main === module) runActual().catch(error => { console.error(error); process.exitCode = 1; });

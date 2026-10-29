'use strict';
// ROOT SERIAL / Windows + Node24. A real enable round produces the authority,
// result, encrypted generation and backup. A separate, Job-owned process then
// reconstructs the narrow completed-but-owned crash window with actual product
// modules and native flush, holds the real source owner, and deliberately dies.
// This is a constructed crash window, not an observed production cold crash.
// Two normal boots refuse tampered/missing backups without changing the claim;
// restoring the actual backup allows a normal serve to verify and retire it.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const core = require('./lib/work-data-production-upload-core');
const restore = require('./work-data-production-restore.e2e');
const { bindTarget: bindOwnedTarget, createProducer } = require('./lib/work-data-owned-claim-fixture.js');
const { releaseEnvironment } = require('./lib/release-checks');
const { snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const PASSWORD = 'SYNTHETIC completed-claim recovery only 2026';
function bindTarget() { return bindOwnedTarget(__dirname, __filename); }
function write(file, value) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function sameBytesAndIdentity(file, row) {
  const actual = core.read(file).row;
  for (const key of ['bytes', 'sha256', 'dev', 'ino']) assert.equal(actual[key], row[key], file + ': ' + key);
}

async function runActual(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 0, 'the permanent E2E uses the current complete product build');
  const runner = require('./lib/harness').createRunner('WORK DATA COMPLETED CLAIM RECOVERY');
  if (process.platform !== 'win32') { console.log('SKIP Windows native completed-claim recovery E2E'); runner.done(); return { skipped: true }; }
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  require('./lib/self-isolate-home');
  const target = bindTarget(), harness = __dirname;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-completed-claim-')), evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  const world = restore.createWorld({ root, evidence, target, harness, releaseEnvironment, snapshotProcessTable, ownDescendants, getFreePort });
  world.openJournal();
  const producerFixture = createProducer({ world, target, harness, root, evidence });
  try {
    world.record({ kind: 'fixture-owner', root, nonce: crypto.randomBytes(32).toString('hex'), executionInputSha256: target.executionInputSha256,
      executionInputs: target.boundFiles.length, inputFiles: target.boundFiles, constructedCrashWindow: true });
    const f = world.fixture('completed'), port = await getFreePort('127.0.0.1');
    const initialHandle = world.spawnServe(f, 'initial-serve', port);
    await initialHandle.spawned;
    const initial = await world.readyWarm(initialHandle, f);
    await world.manager.captureNativeBirths(initialHandle); await world.waitWorkerReady(initial);
    const round = await world.runMaintenanceRound(f, initial, {
      phase: 'completed-enable', operation: 'enable',
      body: ({ source }) => ({ operation: 'enable', password: PASSWORD, expectedAuthority: source, backupDirectory: f.backups }),
      verify: async ({ status, jobId, source }) => {
        assert.equal(status.lastResult.id, jobId); assert.equal(status.lastResult.operation, 'enable');
        assert.equal(status.lastResult.state, 'published'); assert.deepEqual(status.lastResult.sourceAuthority, source);
        assert.deepEqual(status.lastResult.authority, status.authority); assert.equal(status.authority.mode, 'encrypted');
        assert.equal(status.authority.generation, source.generation + 1);
        const saved = status.lastResult, backup = core.read(saved.backup.path).row;
        assert.equal(backup.sha256, saved.backup.sha256); assert.equal(backup.bytes, saved.backup.bytes);
        assert.equal(backup.dev, saved.backup.identity.dev); assert.equal(backup.ino, saved.backup.identity.ino);
        world.assertNoIntent(f, 'completed enable');
        return {};
      },
    });
    const saved = round.next.status.lastResult;
    world.checked('a real production enable completes with a verified backup, encrypted authority and durable result');
    await world.reclaimSuccessor('completed-seed', round.next);
    assert.equal(await world.absentByCim(initial.identity), true);
    const resultFile = path.join(f.base, '.work-data', 'maintenance-result-v1.json');
    const resultBefore = core.read(resultFile).row, activeFile = path.join(f.base, '.work-data', 'active-v1.json'), activeBefore = core.read(activeFile).row;
    const originalBackup = core.read(saved.backup.path);
    // The successor has already been reclaimed: read the fixed source session
    // directly, and prove it is served again only after successful recovery.
    const sessionFile = path.join(f.base, 'sessions', 'sess_restore_synthetic.json'), sessionBefore = core.read(sessionFile).row;
    const { canonical, claimBefore } = await producerFixture.run({ f, id: saved.id, operation: saved.operation,
      ownedAt: saved.finishedAt, parent: initial });
    world.checked('the Job-owned producer dies with a persistent owned claim and the OS releases its real source owner');

    async function refusedBoot(label) {
      world.ctx.phase = label;
      const before = core.inventory(f.base, { directoryMetadata: true });
      const backupBefore = core.inventory(f.backups, { directoryMetadata: true });
      world.checkpoint(label + '-before', { data: before, backups: backupBefore, claim: claimBefore });
      const handle = world.spawnServe(f, label, await getFreePort('127.0.0.1'));
      await handle.spawned; const terminal = await world.manager.waitClose(handle, 60000);
      assert.deepEqual(terminal, { code: 1, signal: null });
      await world.manager.certifyExpectedRefusal(handle, async () => {
        assert.deepEqual(core.inventory(f.base, { directoryMetadata: true }), before, 'refusal preserves the entire data root');
        assert.deepEqual(core.inventory(f.backups, { directoryMetadata: true }), backupBefore, 'refusal preserves the backup directory');
        const after = await world.claimApi(f.temp).inspect({ base: canonical });
        assert.equal(after.present, true); assert.deepEqual(after.receipt, claimBefore.receipt); assert.deepEqual(after.value, claimBefore.value);
        core.samePinned(core.read(resultFile).row, resultBefore);
      });
      const stderr = fs.readFileSync(path.join(evidence, label + '-stderr.log'), 'utf8');
      assert.ok(stderr.includes('work_data_claim.recovery_unverified'), 'normal boot names the unverified completed handoff');
      world.checked(label + ': ordinary serve refuses and preserves the exact claim, result and data root');
    }
    world.ctx.phase = 'same-size-tamper';
    const tampered = Buffer.from(originalBackup.bytes); tampered[Math.floor(tampered.length / 2)] ^= 1;
    try { fs.writeFileSync(saved.backup.path, tampered); await refusedBoot('same-size-tamper'); }
    finally { fs.writeFileSync(saved.backup.path, originalBackup.bytes); tampered.fill(0); }
    const hiddenBackup = saved.backup.path + '.synthetic-held';
    try { fs.renameSync(saved.backup.path, hiddenBackup); await refusedBoot('missing-backup'); }
    finally { if (fs.existsSync(hiddenBackup)) fs.renameSync(hiddenBackup, saved.backup.path); }
    sameBytesAndIdentity(saved.backup.path, originalBackup.row);

    world.ctx.phase = 'completed-recovery-boot';
    const recoveredHandle = world.spawnServe(f, 'recovered-serve', await getFreePort('127.0.0.1'));
    await recoveredHandle.spawned;
    const recovered = await world.readyWarm(recoveredHandle, f); await world.manager.captureNativeBirths(recoveredHandle);
    const status = await world.waitWorkerReady(recovered);
    assert.deepEqual(status.authority, saved.authority); assert.deepEqual(status.lastResult, saved); assert.equal(status.job, null);
    assert.equal((await world.claimApi(f.temp).inspect({ base: canonical })).present, false);
    core.samePinned(core.read(resultFile).row, resultBefore); core.samePinned(core.read(activeFile).row, activeBefore);
    sameBytesAndIdentity(saved.backup.path, originalBackup.row); core.samePinned(core.read(sessionFile).row, sessionBefore);
    assert.ok((await world.sessionIds(recovered)).includes('sess_restore_synthetic'));
    world.assertNoIntent(f, 'completed recovery');
    world.checked('ordinary serve strictly verifies the completed result and backup, retires only the owned claim and serves the original session');
    await world.manager.cleanupKnown(recoveredHandle, async () => world.healthy());
    const inputsAfter = target.recheck(); assert.equal(world.manager.hasUnclosed(), false); assert.equal(world.manager.hasUnverifiedSpawn(), false);
    producerFixture.assertClosed();
    world.checkpoint('result', { schema: 1, checks: world.ctx.checks, inputProof: inputsAfter,
      constructedCrashWindow: true, originalProductionMaintenance: true, operationReplayed: false,
      scope: 'Completed owned-claim retirement only; no interrupted-operation resume, C10/C11 cleanup, special portable or whole 3.1 acceptance.' });
    for (const label of world.ctx.checks) runner.ok(true, label);
    console.log('Retained synthetic completed-claim recovery evidence ' + root); runner.done();
    return { passed: true, root };
  } catch (error) {
    world.latch(error);
    try { write(path.join(evidence, 'failure-summary.json'), { schema: 1, phase: world.ctx.phase, code: error?.code || 'E2E_FAILURE', stack: String(error?.stack || '') }); } catch {}
    try { producerFixture.holdFailure(); } catch {}
    console.error('Retained synthetic completed-claim recovery evidence ' + root + '; phase=' + world.ctx.phase);
    process.exitCode = 1;
    // Match the existing production fixtures: unknown ownership is retained;
    // its Job has a bounded hold, and no unrelated PID is killed by this test.
    process.exit(1);
  } finally { world.close(); }
}
module.exports = { bindTarget, runActual };
if (require.main === module) runActual().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
// ROOT SERIAL / Windows + Node24. A real enable round produces the authority,
// result, encrypted generation and backup. A separate, Job-owned process then
// reconstructs the narrow completed-but-owned crash window with actual product
// modules and native flush, holds the real source owner, and deliberately dies.
// This is a constructed crash window, not an observed production cold crash.
// Two normal boots refuse tampered/missing backups without changing the claim;
// restoring the actual backup allows a normal serve to verify and retire it.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const core = require('./lib/work-data-production-upload-core');
const restore = require('./work-data-production-restore.e2e');
const upload = require('./work-data-production-upload.e2e');
const { createProcesses, createStrictStop } = require('./lib/work-data-production-upload-process');
const { releaseEnvironment } = require('./lib/release-checks');
const { snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const PASSWORD = 'SYNTHETIC completed-claim recovery only 2026';
const PRODUCER = path.join(__dirname, 'lib/work-data-completed-claim-producer.cjs');
const SOURCES = ['01g-server-ownership.js', '01v-work-data-manifest.js', '01w-work-data-native-publish.js', '13av-work-data-handoff-claim.js'];

function bindTarget() {
  const original = core.loadProductTarget(__dirname), additions = [__filename, PRODUCER].map(file => core.read(file).row);
  const boundFiles = [...original.boundFiles, ...additions];
  const digest = core.H(Buffer.from(JSON.stringify(boundFiles.map(row => ({ file: core.norm(row.file), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0))));
  return { ...original, boundFiles, executionInputSha256: digest, recheck() {
    original.recheck(); for (const row of additions) core.read(row.file, row);
    return { sameInputs: true, files: boundFiles.length, productSource: true, executionInputSha256: digest };
  } };
}
function write(file, value) { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
async function waitJson(file, milliseconds) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (Date.now() >= deadline) throw Error('synthetic evidence deadline: ' + path.basename(file));
    await pause(25);
  }
}
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
  let keeper = null, keeperDirectory = null;
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
    const canonical = await upload.loadPure(core.read(path.join(target.src, SOURCES[0])).bytes.toString('utf8'), 'ServerOwnership').canonicalRoot(f.base);

    keeperDirectory = path.join(root, 'producer-keeper'); fs.mkdirSync(keeperDirectory);
    keeper = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(harness, 'lib/work-data-production-maintenance-outer-job.ps1')],
      { cwd: harness, env: { ...process.env, RUYI_PM_ROOT: keeperDirectory }, stdio: 'ignore', windowsHide: true });
    keeper.unref(); await waitJson(path.join(keeperDirectory, 'job-ready.json'), 30000);
    const commands = path.join(root, 'producer-commands'); fs.mkdirSync(commands);
    const request = path.join(commands, 'request.json');
    write(request, { base: f.base, temp: f.temp, id: saved.id, operation: saved.operation, finishedAt: saved.finishedAt, port: initial.port,
      parentPid: initial.pid, commands, sources: SOURCES.map(name => core.read(path.join(target.src, name)).row) });
    // The restore world keeps its output handles private. A separate observer
    // owns this added child and pins its actual source before any spawn.
    const producerOutput = Object.fromEntries(['stdout', 'stderr'].map(kind => [kind, fs.openSync(path.join(evidence, 'claim-producer-' + kind + '.log'), 'wx', 0o600)]));
    const producerManager = createProcesses({ record: world.record,
      writeOutput: (_label, kind, bytes) => { fs.writeFileSync(producerOutput[kind], bytes); },
      latch: world.latch, isUnknown: () => world.ctx.unknown,
      beforeStart: () => { world.healthy(); target.recheck(); world.healthy(); },
      snapshotProcessTable, ownDescendants,
      killOwnTree: createStrictStop({ snapshotProcessTable, ownDescendants, latch: world.latch, isUnknown: () => world.ctx.unknown }) });
    const producer = producerManager.start(process.execPath, [PRODUCER, request], { cwd: root, env: f.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, 'claim-producer');
    await producer.spawned;
    const producerReady = await waitJson(path.join(commands, 'producer-ready.json'), 30000);
    assert.equal(producerReady.pid, producerManager.pid(producer));
    const identity = await world.cimIdentity(producerReady.pid);
    write(path.join(keeperDirectory, 'job-target.json'), { schema: 1, pid: identity.pid, cimCreated: identity.created });
    const assigned = await waitJson(path.join(keeperDirectory, 'job-assigned.json'), 30000);
    assert.equal(assigned.pid, identity.pid); assert.equal(assigned.cimCreated, identity.created);
    write(path.join(commands, 'producer-go.json'), { schema: 1, go: true });
    const owned = await waitJson(path.join(commands, 'producer-owned.json'), 180000);
    assert.equal(owned.pid, identity.pid); assert.equal(owned.sourceOwnerHeld, true); assert.equal(owned.realNativeFlush, true);
    const ownerApi = upload.loadPure(core.read(path.join(target.src, SOURCES[0])).bytes.toString('utf8'), 'ServerOwnership');
    let contender = null;
    try { contender = await ownerApi.acquire([canonical]); }
    catch (error) { assert.equal(error.code, 'DATA_ROOT_IN_USE'); }
    if (contender) { await contender.release(); assert.fail('producer must hold the actual OS source owner'); }
    const claimBefore = await world.claimApi(f.temp).inspect({ base: canonical });
    assert.equal(claimBefore.present, true); assert.equal(claimBefore.value.phase, 'owned');
    assert.equal(claimBefore.value.id, saved.id); assert.equal(claimBefore.value.parentPid, initial.pid); assert.equal(claimBefore.value.childPid, identity.pid);
    world.checkpoint('constructed-owned', { owned, claim: claimBefore, identity, oldServeIdentity: initial.identity, constructedCrashWindow: true });
    write(path.join(commands, 'producer-crash.json'), { schema: 1, crash: true });
    const ended = await producerManager.waitClose(producer, 30000);
    assert.deepEqual(ended, { code: 73, signal: null });
    await producerManager.certifyNaturalExit(producer, { code: 73, signal: null, verify: async () => assert.equal(await world.absentByCim(identity), true) });
    for (const fd of Object.values(producerOutput)) { fs.fsyncSync(fd); fs.closeSync(fd); }
    write(path.join(keeperDirectory, 'job-release.json'), { schema: 1, released: true });
    const outer = await waitJson(path.join(keeperDirectory, 'outer-job-result.json'), 60000);
    assert.equal(outer.ok, true); assert.equal(outer.closed, true); assert.deepEqual(outer.survived, []); assert.deepEqual(outer.members, []);
    const keeperDeadline = Date.now() + 20000;
    while (keeper.exitCode === null && Date.now() < keeperDeadline) await pause(25);
    assert.equal(keeper.exitCode, 0);
    world.checkpoint('producer-death', { process: producerManager.inspect(producer), outer, keeperCode: keeper.exitCode });
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
    assert.equal(producerManager.hasUnclosed(), false); assert.equal(producerManager.hasUnverifiedSpawn(), false);
    world.checkpoint('result', { schema: 1, checks: world.ctx.checks, inputProof: inputsAfter,
      constructedCrashWindow: true, originalProductionMaintenance: true, operationReplayed: false,
      scope: 'Completed owned-claim retirement only; no interrupted-operation resume, C10/C11 cleanup, special portable or whole 3.1 acceptance.' });
    for (const label of world.ctx.checks) runner.ok(true, label);
    console.log('Retained synthetic completed-claim recovery evidence ' + root); runner.done();
    return { passed: true, root };
  } catch (error) {
    world.latch(error);
    try { write(path.join(evidence, 'failure-summary.json'), { schema: 1, phase: world.ctx.phase, code: error?.code || 'E2E_FAILURE', stack: String(error?.stack || '') }); } catch {}
    if (keeperDirectory) try { write(path.join(keeperDirectory, 'job-hold.json'), { schema: 1, held: true, reason: 'test-failure' }); } catch {}
    console.error('Retained synthetic completed-claim recovery evidence ' + root + '; phase=' + world.ctx.phase);
    process.exitCode = 1;
    // Match the existing production fixtures: unknown ownership is retained;
    // its Job has a bounded hold, and no unrelated PID is killed by this test.
    process.exit(1);
  } finally { world.close(); }
}
module.exports = { bindTarget, runActual };
if (require.main === module) runActual().catch(error => { console.error(error); process.exitCode = 1; });

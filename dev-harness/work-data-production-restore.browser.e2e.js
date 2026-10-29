'use strict';
// Permanent serial Windows production browser restore acceptance.
// Real settings DOM -> real File octet-stream upload -> real job -> real cold
// owner/native restore/activation -> target DOM. Only the two native folder
// selections are substituted, at that exact route; no work-data HTTP is mocked.
require('./lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const core = require('./lib/work-data-production-upload-core');
const restore = require('./work-data-production-restore.e2e');
const upload = require('./work-data-production-upload.e2e');
const { attachProductionBrowser, safeFailure } = require('./lib/work-data-production-browser-attach.js');
const { releaseEnvironment } = require('./lib/release-checks');
const { snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const PASSWORD = 'SYNTHETIC browser restore package only 2026';
const PACKAGE_ID = 'sess_browser_restore_package', SOURCE_ID = 'sess_restore_synthetic';
async function waitForFact(test, guard, milliseconds, label) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { guard(); if (test()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(label + ' deadline');
}
function bindTarget() {
  const original = core.loadProductTarget(__dirname), publicRoot = path.join(original.repo, 'ruyi-workbench/app/public');
  const publicBefore = core.inventory(publicRoot);
  const extras = [__filename, path.join(__dirname, 'lib/work-data-production-browser-attach.js'),
    ...['browser-fixture.js', 'browser-path.js', 'browser-cleanup.js', 'fake-openai-provider.js'].map(name => path.join(__dirname, 'lib', name))];
  const additions = [...publicBefore.files, ...extras.map(file => core.read(file).row)];
  const boundFiles = [...original.boundFiles, ...additions];
  const digest = core.H(Buffer.from(JSON.stringify(boundFiles.map(row => ({ file: core.norm(row.file), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0))));
  return { ...original, boundFiles, executionInputSha256: digest, recheck() {
    original.recheck(); for (const row of additions) core.read(row.file, row);
    assert.deepEqual(core.inventory(publicRoot), publicBefore);
    return { sameInputs: true, files: boundFiles.length, executionInputSha256: digest, browserAssetsPinned: true };
  } };
}
async function runActual(argv = process.argv.slice(2)) {
  assert.equal(argv.length, 0, 'the permanent acceptance uses the checked-in complete product');
  const runner = require('./lib/harness').createRunner('WORK DATA PRODUCTION RESTORE BROWSER');
  if (process.platform !== 'win32') { console.log('SKIP Windows native browser restore acceptance'); runner.done(); return; }
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const target = bindTarget(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-production-browser-restore-'));
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  const w = restore.createWorld({ root, evidence, target, harness: __dirname, releaseEnvironment, snapshotProcessTable, ownDescendants, getFreePort });
  w.openJournal(); let browser = null, successor = null, initialHandle = null, submissionStarted = false;
  try {
    w.record({ kind: 'fixture-owner', root, inputFiles: target.boundFiles, executionInputSha256: target.executionInputSha256,
      nativeFolderDialogSubstituted: true, workDataHttpSubstituted: false, browserAssetsPinned: true });
    w.ctx.phase = 'browser-source-start';
    const f = w.fixture('browser'), configFile = path.join(f.base, 'config.json');
    const config = core.json(configFile); assert.equal(config.locale, 'en-US', 'the serving DOM assertion uses the fixture English locale');
    config.onboarding = { completedAt: '2026-10-28T00:00:00.000Z', version: 1, skipped: false };
    fs.writeFileSync(configFile, JSON.stringify(config));
    // The later source verification owns browser-source-serve output files.
    const port = await getFreePort('127.0.0.1'), handle = w.spawnServe(f, 'browser-initial-serve', port);
    initialHandle = handle;
    await handle.spawned; const initial = await w.readyWarm(handle, f); await w.manager.captureNativeBirths(handle);
    const ready = await w.waitWorkerReady(initial);
    const recovery = upload.loadPure(core.read(path.join(target.src, '01t-work-data-recovery.js')).bytes.toString('utf8'), 'WorkDataRecovery');
    const normalizedConfig = core.read(configFile).bytes;
    const packageSession = Buffer.from(JSON.stringify({ id: PACKAGE_ID, title: 'Browser package-only synthetic session',
      cwd: '', createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', messages: [] }));
    // Authenticate the same metadata bytes that the real product rebuilds from
    // this package head. No shared startup exception is needed for the index.
    const product = require(target.server), packageHead = JSON.parse(packageSession.toString('utf8'));
    assert.equal(typeof product.sessionMeta, 'function');
    const packageIndexRows = [product.sessionMeta(packageHead, undefined, { committedOnly: true })];
    assert.deepEqual(packageIndexRows.map(row => row.id), [PACKAGE_ID]);
    assert.equal(packageIndexRows.some(row => row.id === SOURCE_ID), false);
    for (const field of ['id', 'title', 'cwd', 'createdAt', 'updatedAt']) assert.equal(packageIndexRows[0][field], packageHead[field]);
    assert.equal(packageIndexRows[0].missionId, packageHead.id);
    assert.equal(packageIndexRows[0].messageCount, packageHead.messages.length);
    const packageIndex = Buffer.from(JSON.stringify(packageIndexRows, null, 2), 'utf8');
    w.record({ kind: 'browser-package-session-index', source: 'product-export-sessionMeta',
      productImportInitialization: 'existing unref shell-idle reaper; no session-write, shell or serve API invoked',
      file: 'sessions/index.json', sessionIds: packageIndexRows.map(row => row.id),
      bytes: packageIndex.length, sha256: core.H(packageIndex), authenticatedPackageFile: true });
    const sealed = Buffer.from(await recovery.seal({ appVersion: '3.0.1', generation: 0, createdAt: '2026-10-28T00:00:00.000Z', directories: ['sessions'],
      keys: [], auxiliaries: [], files: [{ path: 'config.json', data: normalizedConfig, keyRefs: [] },
        { path: 'sessions/' + PACKAGE_ID + '.json', data: packageSession, keyRefs: [] },
        { path: 'sessions/index.json', data: packageIndex, keyRefs: [] }] }, PASSWORD));
    assert.equal(recovery.inspectSealed(sealed.toString('utf8')), true);
    const packageFile = path.join(root, 'synthetic-browser-package.ruyi-backup'); fs.writeFileSync(packageFile, sealed, { flag: 'wx' });
    const targetDirectory = path.join(f.targets, 'restored-by-browser');
    const expectedJob = { operation: 'restore', password: PASSWORD, expectedAuthority: ready.authority,
      backupDirectory: f.backups, targetDirectory };
    w.ctx.phase = 'browser-attach-and-prepare';
    const receiverMarkers = new Map();
    browser = await attachProductionBrowser({ harness: __dirname, root, url: 'http://127.0.0.1:' + initial.port + '/',
      captureReceivedUpload: uploadId => {
        assert.match(uploadId, /^[a-f0-9]{48}$/);
        const custody = w.custodyWithUpload(f, uploadId);
        const captured = core.read(path.join(custody.dir, 'restore-upload-' + uploadId + '.sealed'));
        try {
          const marker = core.read(path.join(custody.dir, 'restore-upload-owner.json'));
          try {
            const value = JSON.parse(marker.bytes);
            assert.equal(value.schema, 1); assert.equal(core.norm(value.base), core.norm(f.base));
            assert.equal(core.norm(value.root), core.norm(custody.dir)); assert.match(value.nonce, /^[a-f0-9]{64}$/);
            receiverMarkers.set(uploadId, { row: marker.row, value });
          } finally { marker.bytes.fill(0); }
          return captured; // New stable-FD read Buffer; never copied from sealed.
        } catch (error) { captured.bytes.fill(0); throw error; }
      },
      directories: [f.backups, f.targets], selectedBytes: sealed, expectedJob, record: w.record, guard: w.healthy });
    await browser.prepare({ packageFile, targetName: path.basename(targetDirectory) });
    w.checked('actual settings handlers select a real File and exact target, with only native folder selection substituted');
    const preRestorePreference = w.assertBootRootPreferenceAbsent(f, 'browser');
    const round = await w.runMaintenanceRound(f, initial, {
      phase: 'browser-restore', operation: 'restore', targetDirectory,
      body: ({ source }) => ({ ...expectedJob, expectedAuthority: source }),
      submit: async (_ref, body) => {
        assert.deepEqual(body.expectedAuthority, expectedJob.expectedAuthority);
        submissionStarted = true;
        return browser.submit(); // Real DOM click, then actual Network 201 + 202 receipts.
      },
      verify: async ({ next, status, jobId, source }) => {
        successor = next;
        assert.deepEqual(status.authority, ready.authority, 'the plain target retains generation-zero authority');
        assert.equal(status.job, null); assert.equal(status.lastResult, null);
        w.assertTargetAuthority({ target: targetDirectory, authority: status.authority, label: 'browser target' });
        const result = w.assertRestoreResult({ f, id: jobId, targetPath: targetDirectory, source, uploaded: sealed });
        // Boot invalidates the package's derived plaintext index. A normal real
        // read waits for listSessions (and any needed rebuild attempt); HTTP 200 does
        // not certify a durable index or completion of all startup work. The
        // original package-file existence and byte checks remain below.
        const targetSessions = await upload.makeHttp(next, '/api/sessions', undefined,
          { guard: w.healthy, timeout: upload.BUDGET.request });
        assert.equal(targetSessions.status, 200); assert.equal(targetSessions.value?.ok, true);
        assert.ok(Array.isArray(targetSessions.value.sessions));
        assert.deepEqual(targetSessions.value.sessions, packageIndexRows);
        w.record({ kind: 'browser-target-session-read', source: 'actual GET /api/sessions',
          status: targetSessions.status, sessionIds: targetSessions.value.sessions.map(row => row.id),
          responseBytes: targetSessions.raw.length, responseSha256: core.H(targetSessions.raw),
          listSessionsReadSettled: true, indexDurabilityCertified: false, wholeStartupCompletionCertified: false });
        const started = await w.assertStartedTarget({ target: targetDirectory, sealed, password: PASSWORD, label: 'browser restore', successor: next, encrypted: false });
        const ids = await w.sessionIds(next); assert.ok(ids.includes(PACKAGE_ID)); assert.equal(ids.includes(SOURCE_ID), false);
        w.assertNoIntent(f, 'browser restore');
        const ownership = upload.loadPure(core.read(path.join(target.src, '01g-server-ownership.js')).bytes.toString('utf8'), 'ServerOwnership');
        const canonical = await ownership.canonicalRoot(targetDirectory);
        // Existence-only waits cannot hold a reader across the product's CAS
        // rename/unlink. The authoritative API is called only after absence.
        const activationFile = path.join(f.temp, 'ruyi-work-data-activation-' + core.H(Buffer.from(canonical, 'utf8')), 'activation-v1.json');
        await waitForFact(() => !fs.existsSync(activationFile), w.healthy, 25000, 'activation consumption');
        assert.equal((await w.claimApi(f.temp).activation.inspect({ base: canonical })).present, false, 'ready activation was consumed');
        const preference = await w.readBootRootPreference({ f, target: targetDirectory, authority: status.authority,
          resultId: jobId, resultSha256: result.row.sha256, name: 'browser', notBefore: preRestorePreference.at });
        const facts = await browser.assertTargetServing(targetDirectory);
        assert.equal(facts.uploads.length, 1); assert.equal(facts.jobs.length, 1); assert.equal(facts.folderChoices.length, 2);
        const observed = facts.uploads[0], uploadId = observed.accepted.uploadId, received = observed.receiver;
        assert.equal(received.uploadId, uploadId); assert.equal(received.source, 'receiver-custody-readback');
        assert.equal(received.bytes, sealed.length); assert.equal(received.sha256, core.H(sealed));
        assert.equal(facts.jobs[0].body.uploadId, uploadId);
        // CDP raw File bytes are supplementary. Never fill this field from the
        // expected buffer or receiver; when available they must also match.
        if (observed.body) { assert.equal(observed.body.bytes, sealed.length); assert.equal(observed.body.sha256, core.H(sealed)); }
        else { assert.equal(observed.body, null); assert.equal(observed.postData.unavailableReason, 'cdp-file-body-not-exposed'); }
        const uploaded = w.custodyWithUpload(f, uploadId);
        const disk = core.read(path.join(uploaded.dir, 'restore-upload-' + uploadId + '.sealed'), received.row);
        try {
          assert.equal(core.norm(disk.row.file), core.norm(received.row.file)); core.samePinned(disk.row, received.row);
          assert.equal(disk.row.sha256, core.H(sealed)); assert.equal(disk.bytes.equals(sealed), true);
        } finally { disk.bytes.fill(0); }
        const marker = receiverMarkers.get(uploadId); assert.ok(marker);
        const currentMarker = core.read(marker.row.file, marker.row); currentMarker.bytes.fill(0);
        const names = fs.readdirSync(uploaded.dir).filter(name => /^handoff-[a-f0-9]{48}-[a-f0-9]{64}\.json$/.test(name));
        assert.equal(names.length, 1, 'one actual handoff binds the admitted upload and restore job');
        const rawHandoff = core.read(path.join(uploaded.dir, names[0])); let handoff;
        try { handoff = JSON.parse(rawHandoff.bytes); } finally { rawHandoff.bytes.fill(0); }
        assert.equal(handoff.schema, 1); assert.equal(handoff.jobId, jobId); assert.equal(handoff.uploadId, uploadId);
        assert.equal(core.norm(handoff.base), core.norm(f.base)); assert.equal(core.norm(handoff.root), core.norm(uploaded.dir));
        assert.equal(core.norm(handoff.file), core.norm(received.row.file)); assert.equal(handoff.bytes, received.bytes);
        assert.equal(handoff.sha256, received.sha256); assert.deepEqual(handoff.identity, { dev: received.row.dev, ino: received.row.ino });
        assert.deepEqual(handoff.marker, { dev: marker.row.dev, ino: marker.row.ino, sha256: marker.row.sha256 });
        assert.equal(handoff.rootNonce, marker.value.nonce);
        const rootStat = fs.lstatSync(uploaded.dir, { bigint: true });
        assert.deepEqual(handoff.rootIdentity, { dev: String(rootStat.dev), ino: String(rootStat.ino) });
        w.checkpoint('browser-restore-network', facts);
        w.checked('real File SHA equals complete independent receiver bytes for the unique uploadId used by native restore, with committed target bytes, consumed activation and reconnected DOM');
        return { result, started, preference, sourcePinsAfter: w.sourcePins(f) };
      },
    });
    // Stop browser polling before either source verification or target reclaim.
    const browserClosed = await browser.close(); browser = null;
    const sourceServe = await w.runSourceServeCheck({ f, target: targetDirectory, targetRef: round.next,
      packagePaths: round.verified.started.packagePaths, expectedAuthority: ready.authority, jobId: round.jobId,
      expectPresent: [SOURCE_ID], expectAbsent: [PACKAGE_ID], label: 'browser' });
    assert.equal(sourceServe.status.lastResult.id, round.jobId);
    core.samePinned(core.read(round.verified.result.resultPath).row, round.verified.result.row);
    for (const pin of round.verified.sourcePinsAfter) core.samePinned(core.read(path.join(f.base, ...pin.relative.split('/'))).row, pin.row);
    core.samePinned(core.read(round.verified.preference.file).row, round.verified.preference.row);
    w.assertNoIntent(f, 'browser source serve'); await w.assertClaimGone(f, 'browser source serve');
    await w.reclaimSuccessor('browser-target', round.next); successor = null;
    const preferenceBoots = [];
    for (const label of ['browser-preference-1', 'browser-preference-2']) {
      preferenceBoots.push(await w.runPreferenceBoot({ f, label, target: targetDirectory, expectedAuthority: ready.authority, jobId: round.jobId,
        expectPresent: [PACKAGE_ID], expectAbsent: [SOURCE_ID], preference: round.verified.preference }));
      core.samePinned(core.read(round.verified.preference.file).row, round.verified.preference.row);
    }
    core.samePinned(core.read(round.verified.result.resultPath).row, round.verified.result.row);
    w.checked('two ordinary isolated serves select the restored target through the unchanged exact boot preference');
    const after = target.recheck(); assert.equal(w.manager.hasUnclosed(), false); assert.equal(w.manager.hasUnverifiedSpawn(), false);
    w.checkpoint('result', { schema: 1, checks: w.ctx.checks, inputProof: after, browserClosed, preferenceBoots,
      nativeFolderDialogSubstituted: true, workDataHttpSubstituted: false, exactlyOneUpload: true, exactlyOneJob: true,
      uploadBodyProof: 'Real File SHA plus complete receiver-custody bytes and native identity; CDP raw File body separately available or unavailable, never substituted.',
      scope: 'One plain native browser restore journey only; encrypted browser matrix, packaged WebView/native folder dialog and whole 3.1 remain separate.' });
    for (const label of w.ctx.checks) runner.ok(true, label);
    console.log('Retained synthetic production browser restore evidence ' + root); runner.done();
  } catch (error) {
    // Native unknown still retains the native scene. The browser is a separate
    // test-owned child: releasing its CDP/pipes and held-child cleanup is safe
    // even after a page assertion or the world's latch has failed.
    const browserAtFailure = Boolean(browser), originalPhase = w.ctx.phase;
    let browserFailure = error.browserFailure || browser?.failureDiagnostic() || null;
    let browserCleanupFailure = null;
    if (browser) {
      try { const cleanup = await browser.close({ failure: true }); browserFailure = { ...browserFailure, cleanup }; }
      catch (cleanupError) { browserCleanupFailure = safeFailure(cleanupError); }
    }
    // Before the submit adapter is entered no work-data mutation was requested.
    // A page-only failure may close this known warm fixture through the existing
    // checked owner. Never bypass a native/world latch or a submitted job.
    let knownWarmCleanup = null;
    if (!submissionStarted && !w.ctx.unknown && initialHandle) {
      try { await w.manager.cleanupKnown(initialHandle, async () => w.healthy()); knownWarmCleanup = { verified: true }; }
      catch (cleanupError) { knownWarmCleanup = { verified: false, error: safeFailure(cleanupError) }; }
    }
    const diagnosis = { phase: originalPhase, error: safeFailure(w.ctx.failure || error),
      browser: browserFailure, browserCleanupFailure, browserAttached: browserAtFailure,
      successorObserved: Boolean(successor), nativeUnknownBeforeCatch: w.ctx.unknown,
      submissionStarted, knownWarmCleanup, rawBodiesOmitted: true };
    w.latch(error);
    try {
      const fd = fs.openSync(path.join(evidence, 'failure-summary.json'), 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(diagnosis, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    } catch {}
    try { console.error('BROWSER-RESTORE-DIAG ' + JSON.stringify({ root, ...diagnosis })); } catch {}
    // Hand retained native actors to the root owner after durable diagnostics.
    // Still-live child pipes must not hold this failed observer open or dispatch
    // another callback against the evidence FDs after their journal is closed.
    try { w.close(); } catch {}
    process.exit(1);
  } finally { w.close(); }
}
module.exports = { bindTarget, runActual };
if (require.main === module) runActual().catch(error => { console.error('BROWSER-RESTORE-DIAG ' + JSON.stringify(safeFailure(error))); process.exitCode = 1; });

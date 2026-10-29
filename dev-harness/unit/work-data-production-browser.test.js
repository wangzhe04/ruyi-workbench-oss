'use strict';
// Evidence and diagnostic contracts only; no server, browser or subprocess starts.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const core = require('../lib/work-data-production-upload-core');
const { requestKind, proveUpload, proveUploadEntries, observedCdp, readMutationReceipt, acceptedJobForTracking, assertFinalEvidence, mutationDiagnostic, captureReceiver, fileBodyUnavailable, receipt, safeFailure } = require('../lib/work-data-production-browser-attach.js');
test('failure diagnosis keeps an actionable source location without values, password, message or raw body', async () => {
  const secret = 'SYNTHETIC password must never reach evidence', body = '{"password":"' + secret + '"}';
  const error = Object.assign(new Error(body), { name: 'AssertionError', code: 'ERR_ASSERTION', actual: secret, expected: body });
  error.stack = 'AssertionError: ' + body + '\n    at submit (C:\\fixture\\work-data-production-browser-attach.js:170:8)';
  assert.deepEqual(safeFailure(error), { errorName: 'AssertionError', code: 'ERR_ASSERTION', operator: null, reason: null,
    location: { file: 'work-data-production-browser-attach.js', line: 170, column: 8 } });
  assert.equal(JSON.stringify(safeFailure(error)).includes(secret), false);
  assert.deepEqual(safeFailure({ name: body, code: body, stack: body }), { errorName: 'UnknownError', code: null, operator: null, reason: null, location: null });
  // Source checks run after the browser is gone. Their e2e filename contains
  // a digit, and exclusive-output collisions must keep code/location safely.
  for (const file of ['work-data-production-restore.e2e.js', 'work-data-production-restore.browser.e2e.js']) {
    const collision = Object.assign(new Error('EEXIST: ' + body), { code: 'EEXIST' });
    collision.stack = 'Error: ' + body + '\n    at openOutput (C:\\fixture\\' + file + ':95:8)';
    assert.deepEqual(safeFailure(collision), { errorName: 'Error', code: 'EEXIST', operator: null, reason: null,
      location: { file, line: 95, column: 8 } });
    assert.equal(JSON.stringify(safeFailure(collision)).includes(secret), false);
  }
  for (const reason of ['click unavailable', 'click has no layout', 'click readiness deadline', 'click target changed before press']) {
    assert.equal(safeFailure(new Error(reason)).reason, reason);
    assert.equal(safeFailure(new Error('Error: ' + reason + '\n    at injected (https://example.invalid/?token=' + secret + ')')).reason, reason);
    assert.equal(safeFailure(new Error(reason + ' ' + secret)).reason, null, 'interpolated values are never whitelisted');
  }
  for (const cause of [new Error('No post data available for the request'),
    Object.assign(new Error(body), { code: -32000 })]) {
    await assert.rejects(observedCdp({ async send() { throw cause; } }, 'Network.getRequestPostData', { requestId: secret }), error => {
      const found = safeFailure(error);
      assert.equal(found.code, 'CDP_COMMAND_FAILED'); assert.equal(found.cdp.method, 'Network.getRequestPostData');
      assert.equal(found.cdp.protocolCode, cause.code ?? null, 'a dropped protocol code stays unavailable');
      assert.equal(found.cdp.reason, cause.code ? null : 'No post data available for the request');
      assert.equal(found.cdp.messageSha256, core.H(Buffer.from(cause.message)));
      assert.equal(found.cdp.messageBytes, Buffer.byteLength(cause.message, 'utf8'));
      assert.equal(fileBodyUnavailable(error), !cause.code, 'only a recognized getter availability error is optional for the File proof');
      assert.equal(JSON.stringify(found).includes(secret), false);
      return true;
    });
  }
  await assert.rejects(observedCdp({ async send() { throw Error('Request content was evicted from inspector cache'); } },
    'Network.getResponseBody', { requestId: secret }), error => {
    assert.equal(safeFailure(error).cdp.reason, 'Request content was evicted from inspector cache');
    assert.equal(fileBodyUnavailable(error), false, 'an evicted response never becomes optional File-body absence');
    return true;
  });
  const metadata = mutationDiagnostic({ kind: 'upload', status: 201, responseFinished: true,
    body: null, accepted: { uploadId: secret }, failed: false, password: secret,
    postData: { hasPostData: true, entries: 1, entriesWithBytes: 0, getterAttempted: true, raw: body, source: secret } });
  assert.equal(metadata.receiptCaptured, true); assert.equal(metadata.bodyCaptured, false, 'HTTP 201 is not wire-body proof');
  assert.equal(metadata.receiverCaptured, false, 'ACK cannot stand in for independent receiver bytes');
  assert.equal(metadata.postData.entriesWithBytes, 0); assert.equal(metadata.postData.source, null);
  assert.equal(JSON.stringify(metadata).includes(secret), false);
});
test('Network classifier accepts only exact same-origin mutation routes without queries', () => {
  const origin = 'http://127.0.0.1:8765';
  assert.equal(requestKind(origin + '/api/work-data/uploads', 'POST', origin), 'upload');
  assert.equal(requestKind(origin + '/api/work-data/jobs', 'POST', origin), 'job');
  for (const url of [origin + '/api/work-data/uploads?x', origin + '/api/work-data/uploads/extra', 'http://evil.example/api/work-data/jobs']) assert.equal(requestKind(url, 'POST', origin), '');
  assert.equal(requestKind(origin + '/api/work-data/jobs', 'GET', origin), '');
});
test('Network and receiver proofs require complete actual bytes; missing CDP bytes never become a synthetic body', async () => {
  const bytes = Buffer.from('{"sealed":"公开合成字节"}');
  assert.equal(proveUpload(bytes.toString('utf8'), bytes).bytes, bytes.length);
  assert.deepEqual(proveUpload(bytes.toString('base64'), bytes, true), proveUpload(bytes.toString('utf8'), bytes));
  const cut = 15, entries = [bytes.subarray(0, cut), bytes.subarray(cut)].map(part => ({ bytes: part.toString('base64') }));
  assert.deepEqual(proveUploadEntries(entries, bytes), proveUpload(bytes.toString('utf8'), bytes));
  for (const value of [undefined, [], [{}], [{ bytes: undefined }], [{ bytes: '!!!!' }], [{ bytes: 'YQ' }],
    [{ bytes: bytes.subarray(1).toString('base64') }], [{ bytes: Buffer.from('x'.repeat(bytes.length)).toString('base64') }]]) {
    assert.throws(() => proveUploadEntries(value, bytes), 'missing, partial or different actual entries must fail');
  }
  assert.throws(() => proveUpload(bytes.toString('base64'), bytes, 'true'));
  assert.throws(() => proveUpload('!!!!', bytes, true));
  assert.throws(() => proveUpload(undefined, bytes)); assert.throws(() => proveUpload('x'.repeat(bytes.length), bytes));
  // An actual stable-FD read, rather than a mocked successful capture DTO.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-browser-receiver-unit-'));
  try {
    const id = 'c'.repeat(48), dir = path.join(root, 'ruyi-work-data-upload-unit'); fs.mkdirSync(dir);
    const file = path.join(dir, 'restore-upload-' + id + '.sealed'); fs.writeFileSync(file, bytes);
    let actual;
    const receiver = await captureReceiver(id, got => { assert.equal(got, id); actual = core.read(file); return actual; }, bytes, root);
    assert.equal(receiver.source, 'receiver-custody-readback'); assert.equal(receiver.sha256, core.H(bytes));
    assert.equal(receiver.row.dev, String(fs.lstatSync(file, { bigint: true }).dev));
    assert.equal(actual.bytes.every(byte => byte === 0), true, 'the actual independent read buffer is cleared');
    assert.equal(bytes.equals(Buffer.from('{"sealed":"公开合成字节"}')), true, 'expected operand stays intact');
    await assert.rejects(captureReceiver(id, undefined, bytes, root));
    await assert.rejects(captureReceiver(id, () => null, bytes, root));
    for (const mutate of [value => { value.row.ino = '0'; }, value => { value.row.sha256 = '0'.repeat(64); },
      value => { value.row.file = path.join(dir, 'restore-upload-' + 'd'.repeat(48) + '.sealed'); },
      value => { value.bytes[0] ^= 1; }]) {
      let bad;
      await assert.rejects(captureReceiver(id, () => { bad = core.read(file); mutate(bad); return bad; }, bytes, root));
      assert.equal(bad.bytes.every(byte => byte === 0), true);
    }
    await assert.rejects(captureReceiver(id, () => ({ bytes, row: receiver.row }), bytes, root), /independent/);
    const observed = mutationDiagnostic({ kind: 'upload', status: 201, receiver, body: null, accepted: { uploadId: id } });
    assert.equal(observed.bodyCaptured, false); assert.equal(observed.receiverCaptured, true);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('ruyi-browser-receiver-unit-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('actual upload/job receipts need valid typed identities and the restore operation', async () => {
  assert.equal(receipt({ ok: true, uploadId: 'a'.repeat(48) }, 'upload').uploadId, 'a'.repeat(48));
  assert.equal(receipt({ ok: true, job: { id: 'b'.repeat(48), operation: 'restore', state: 'queued', retry: false } }, 'job').id, 'b'.repeat(48));
  for (const value of [{ ok: true, uploadId: 'fake' }, { ok: false, uploadId: 'a'.repeat(48) }]) assert.throws(() => receipt(value, 'upload'));
  assert.throws(() => receipt({ ok: true, job: { id: 'b'.repeat(48), operation: 'enable', state: 'queued', retry: false } }, 'job'));
  const upload = { ok: true, uploadId: 'a'.repeat(48) }, job = { ok: true, job: { id: 'b'.repeat(48), operation: 'restore', state: 'queued', retry: false } };
  const client = value => ({ async send(method, params) {
    assert.equal(method, 'Network.getResponseBody'); assert.equal(params.requestId, 'actual-request');
    return { body: JSON.stringify(value), base64Encoded: false };
  } });
  assert.equal((await readMutationReceipt(client(upload), 'upload', 'actual-request', 201)).uploadId, upload.uploadId);
  assert.equal((await readMutationReceipt(client(job), 'job', 'actual-request', 202)).id, job.job.id);
  await assert.rejects(readMutationReceipt(client({}), 'upload', 'actual-request', 201), 'status metadata cannot supply a missing receipt');
  await assert.rejects(readMutationReceipt(client(job), 'job', 'actual-request', 200));
  await assert.rejects(readMutationReceipt({ async send() { throw Error('Request content was evicted from inspector cache'); } },
    'upload', 'actual-request', 201), error => safeFailure(error).cdp.reason === 'Request content was evicted from inspector cache');
  // Tracking the actual ACK and final acceptance are separate phases. These
  // phase judges do not manufacture receiver proof (its real-FD test is above).
  const phases = { uploads: [{ status: 201, responseFinished: true, accepted: null, receiver: null,
    postData: { captureComplete: true, unavailableReason: 'cdp-file-body-not-exposed' } }],
  jobs: [{ status: 202, accepted: receipt(job, 'job'), body: { uploadId: upload.uploadId }, postData: { captureComplete: true } }] };
  assert.equal(acceptedJobForTracking(phases), job.job.id, 'actual ACK can hand native tracking to the original world early');
  assert.throws(() => assertFinalEvidence(phases), 'missing complete 201 receipt and receiver proof cannot pass');
  phases.uploads[0].accepted = receipt(upload, 'upload');
  assert.throws(() => assertFinalEvidence(phases), 'a 201 receipt still cannot replace receiver bytes');
  phases.uploads[0].receiver = { source: 'receiver-custody-readback', uploadId: upload.uploadId };
  assert.equal(assertFinalEvidence(phases), true);
  const deferred = Error('fatal proof failure retained');
  assert.throws(() => assertFinalEvidence(phases, deferred), error => error === deferred, 'pending proof failure must remain fatal even after all ACKs');
  phases.jobs[0].accepted = null;
  assert.equal(acceptedJobForTracking(phases), null, '202 status metadata cannot invent an accepted job id');
  assert.throws(() => assertFinalEvidence(phases));
});

test('actual product metadata import models the existing unref timer without starting actors and derives the authenticated singleton index from its package head', () => {
  require('../lib/self-isolate-home');
  const cp = require('node:child_process'), net = require('node:net'), Module = require('node:module');
  const restore = [], blocked = [];
  const deny = (owner, key) => {
    const original = owner[key];
    owner[key] = () => { blocked.push(key); throw Error('product metadata import attempted an actor'); };
    restore.push(() => { owner[key] = original; });
  };
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) deny(cp, method);
  deny(net.Server.prototype, 'listen'); deny(net.Socket.prototype, 'connect');
  deny(Module._extensions, '.node');
  for (const method of ['setTimeout', 'setImmediate']) deny(globalThis, method);
  // The real import registers one existing shell-idle reaper over its initially
  // empty table. This controlled timer model never executes that callback and
  // is not native/E2E evidence. Every other actor boundary still fails closed.
  const intervals = [], originalInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, milliseconds) => {
    assert.equal(typeof callback, 'function'); assert.equal(milliseconds, 60000);
    const timer = { unreferenced: false, unref() { this.unreferenced = true; return this; } };
    intervals.push(timer); return timer;
  };
  restore.push(() => { globalThis.setInterval = originalInterval; });
  const head = { id: 'sess_browser_restore_package', title: 'Browser package-only synthetic session', cwd: '',
    createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', messages: [] };
  const before = JSON.stringify(head);
  try {
    const product = require('../../ruyi-workbench/app/server.js');
    const rows = [product.sessionMeta(head, undefined, { committedOnly: true })];
    assert.deepEqual(rows.map(row => row.id), [head.id]);
    assert.equal(rows.some(row => row.id === 'sess_restore_synthetic'), false);
    for (const field of ['id', 'title', 'cwd', 'createdAt', 'updatedAt']) assert.equal(rows[0][field], head[field]);
    assert.equal(rows[0].missionId, head.id); assert.equal(rows[0].messageCount, head.messages.length);
    assert.equal(rows[0].kind, 'quick_ask'); assert.equal(rows[0].permissionMode, null);
    assert.equal(JSON.stringify(head), before, 'metadata projection leaves the authenticated head intact');
    assert.deepEqual(product.sessionMeta(head), rows[0], 'idle real listSessions projection has the same bytes');
    const encoded = Buffer.from(JSON.stringify(rows, null, 2), 'utf8');
    assert.deepEqual(JSON.parse(encoded), rows);
    assert.equal(encoded.toString('utf8').endsWith('\n'), false, 'use the actual index writer serialization');
    assert.deepEqual(blocked, [], 'even an internally caught attempt to start an actor is rejected');
    assert.equal(intervals.length, 1); assert.equal(intervals[0].unreferenced, true, 'the sole existing reaper must unref its timer');
  } finally { for (const release of restore.reverse()) release(); }
});

test('actual browser entry failure hands back live or unknown actors after durable guarded diagnosis and synchronous exit', async () => {
  const vm = require('node:vm'), { functionBlock } = require('../lib/source-slice');
  const source = fs.readFileSync(path.join(__dirname, '../work-data-production-restore.browser.e2e.js'), 'utf8');
  const actual = functionBlock(source, 'runActual'); assert.ok(actual.length > 1000);
  for (const fault of ['cleanup-fails', 'unknown-held', 'evidence-log-close-fail']) {
    const events = [], original = Error('SYNTHETIC private original failure'), exit = Error('VM synchronous exit');
    const ctx = { phase: 'initialization', unknown: false, failure: null }, handle = { spawned: Promise.resolve() };
    let diagnostic, cleanupCalls = 0, closes = 0;
    const world = { ctx, openJournal() {}, record() {},
      fixture() { return { base: path.resolve('unused-browser-data') }; },
      spawnServe() { return handle; },
      async readyWarm() { if (fault === 'unknown-held') { ctx.unknown = true; ctx.failure = original; } throw original; },
      healthy() { assert.equal(ctx.unknown, false); },
      manager: { async cleanupKnown(got, guard) {
        assert.equal(got, handle); cleanupCalls++; await guard();
        if (fault === 'cleanup-fails') throw Error('SYNTHETIC cleanup failure');
      } },
      latch(error) { assert.equal(error, original); ctx.unknown = true; ctx.failure ||= error; },
      close() { events.push('journal-close'); if (++closes === 1 && fault === 'evidence-log-close-fail') throw Error('close failure'); },
    };
    const fsModel = { mkdtempSync() { return path.resolve('unused-browser-root'); }, mkdirSync() {},
      openSync(file, flags, mode) { assert.equal(path.basename(file), 'failure-summary.json'); assert.equal(flags, 'wx'); assert.equal(mode, 0o600); events.push('summary-open'); return 42; },
      writeFileSync(file, text) { if (file === 42) { diagnostic = JSON.parse(text); events.push('summary-write'); } },
      fsyncSync(fd) { assert.equal(fd, 42); events.push('summary-sync'); if (fault === 'evidence-log-close-fail') throw Error('fsync failure'); },
      closeSync(fd) { assert.equal(fd, 42); events.push('summary-close'); },
    };
    const entry = vm.runInNewContext('(' + actual + ')', { assert, fs: fsModel, path, __dirname: path.resolve(__dirname, '..'), os: { tmpdir: () => path.resolve('unused-temp') },
      process: { platform: 'win32', versions: { node: '24.0.0' }, exit(code) { assert.equal(code, 1); events.push('exit-1'); throw exit; } },
      require(name) { assert.equal(name, './lib/harness'); return { createRunner: () => ({}) }; },
      bindTarget: () => ({ boundFiles: [] }), restore: { createWorld: () => world },
      core: { json: () => ({ locale: 'en-US' }) }, getFreePort: async () => 54321,
      releaseEnvironment() {}, snapshotProcessTable() {}, ownDescendants() {}, safeFailure,
      console: { error() { events.push('diagnostic-log'); if (fault === 'evidence-log-close-fail') throw Error('console failure'); } },
    });
    await assert.rejects(entry([]), error => error === exit);
    assert.equal(diagnostic.phase, 'browser-source-start'); assert.equal(diagnostic.submissionStarted, false);
    assert.equal(JSON.stringify(diagnostic).includes('private original failure'), false);
    assert.equal(ctx.failure, original, 'secondary cleanup or logging errors never replace the original failure');
    assert.equal(cleanupCalls, fault === 'unknown-held' ? 0 : 1);
    if (fault === 'cleanup-fails') assert.equal(diagnostic.knownWarmCleanup.verified, false);
    if (fault === 'unknown-held') { assert.equal(diagnostic.nativeUnknownBeforeCatch, true); assert.equal(diagnostic.knownWarmCleanup, null); }
    assert.equal(events.filter(event => event === 'exit-1').length, 1);
    assert.ok(events.indexOf('summary-sync') < events.indexOf('journal-close'));
    assert.ok(events.indexOf('summary-close') < events.indexOf('exit-1'));
    assert.ok(events.indexOf('journal-close') < events.indexOf('exit-1'));
  }
});

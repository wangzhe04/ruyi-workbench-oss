'use strict';
// Test-owned browser attached to the existing production restore world.
// Attach a browser to an existing production server; never start a provider or
// another workbench. CDP itself and owned-tree cleanup use the existing owners.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ID = /^[a-f0-9]{48}$/;
const CDP_METHODS = new Set(['Network.enable', 'Network.getRequestPostData', 'Network.getResponseBody']);
const cdpFailures = new WeakMap();
async function observedCdp(client, method, params = {}, timeout = 10000) {
  assert.ok(CDP_METHODS.has(method), 'observed CDP method must be fixed');
  try { return await client.send(method, params, timeout); }
  catch (cause) {
    const originalMessage = String(cause?.message || '');
    const message = originalMessage.split(/\r?\n/, 1)[0].replace(/^Error: /, '');
    const reason = ['No post data available for the request', 'No resource with given id was found',
      'No resource with given identifier found', 'No data found for resource with given identifier',
      'Request content was evicted from inspector cache',
      'CDP socket closed', 'cdp error', "Couldn't read BLOB", "Couldn't encode data"].includes(message) ? message : null;
    // browser-fixture currently drops numeric protocol codes. Do not invent one
    // from a message; preserve a code only if the actual client supplies it.
    const protocolCode = [-32700, -32600, -32601, -32602, -32603, -32000].includes(cause?.code) ? cause.code : null;
    const error = Object.assign(Error('CDP observation command failed'), { code: 'CDP_COMMAND_FAILED' });
    cdpFailures.set(error, Object.freeze({ method, protocolCode, reason,
      messageSha256: hash(originalMessage), messageBytes: Buffer.byteLength(originalMessage, 'utf8') })); throw error;
  }
}
// Error messages/assertion values can contain a password or whole request body.
// Keep an exact source location, safe type/code and operation label instead.
function safeFailure(error) {
  const errorName = ['Error', 'AssertionError', 'TypeError', 'RangeError'].includes(error?.name) ? error.name : 'UnknownError';
  const frame = String(error?.stack || '').split(/\r?\n/).map(line => /(?:^|[\\/])(work-data-production-[a-z0-9.-]+\.(?:js|cjs)):(\d+):(\d+)\)?$/.exec(line)).find(Boolean);
  const code = ['ERR_ASSERTION', 'ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'CDP_COMMAND_FAILED'].includes(error?.code) ? error.code : null;
  const operator = ['strictEqual', 'deepStrictEqual', 'match', 'ok', 'fail'].includes(error?.operator) ? error.operator : null;
  // Only literal fixture diagnostics are eligible; arbitrary CDP/HTTP/assertion
  // messages and their interpolated values never cross into the journal.
  const message = String(error?.message || '').split(/\r?\n/, 1)[0].replace(/^Error: /, '');
  const reason = ['CDP did not supply the actual upload request bytes', 'actual page raised an exception',
    'actual upload is not octet-stream', 'mutation response did not finish', 'browser output bound',
    'browser process snapshot unavailable', 'browser root creation identity changed', 'browser CDP connection deadline',
    'browser cleanup snapshot unavailable', 'browser cleanup root identity unavailable', 'owned browser cleanup request incomplete',
    'actual browser exit and close unobserved', 'browser natural terminal unverified',
    'no sampled browser identity; absence cannot be certified', 'browser absence snapshot unavailable',
    'sampled browser identities absent deadline', 'unknown forbids new test work',
    'click unavailable', 'click has no layout', 'click readiness deadline', 'click target changed before press',
    'actual app ready deadline', 'actual gear menu ready deadline', 'actual settings modal ready deadline',
    'actual restore panel ready deadline', 'backup folder selection deadline', 'target parent selection deadline',
    'CDP observation command failed', 'CDP upload entries unavailable', 'CDP upload entry bytes unavailable',
    'CDP post data encoding invalid', 'CDP base64 bytes invalid'].includes(message) ? message : null;
  const cdp = cdpFailures.get(error);
  return { errorName, code, operator, reason, location: frame ? { file: frame[1], line: Number(frame[2]), column: Number(frame[3]) } : null,
    ...(cdp ? { cdp } : {}) };
}
function requestKind(url, method, origin) {
  let parsed; try { parsed = new URL(url); } catch { return ''; }
  if (parsed.origin !== origin || parsed.search || method !== 'POST') return '';
  return parsed.pathname === '/api/work-data/uploads' ? 'upload'
    : parsed.pathname === '/api/work-data/jobs' ? 'job' : '';
}
function base64Bytes(encoded, maximum) {
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(maximum / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw Error('CDP base64 bytes invalid');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maximum || bytes.toString('base64') !== encoded) { bytes.fill(0); throw Error('CDP base64 bytes invalid'); }
  return bytes;
}
function postDataBytes(postData, maximum, base64Encoded = false) {
  if (typeof postData !== 'string') throw Error('CDP did not supply the actual upload request bytes');
  if (typeof base64Encoded !== 'boolean') throw Error('CDP post data encoding invalid');
  if (base64Encoded) return base64Bytes(postData, maximum);
  assert.ok(Buffer.byteLength(postData, 'utf8') <= maximum, 'CDP request bytes are within the actual body budget');
  return Buffer.from(postData, 'utf8');
}
function uploadProof(bytes, expected) {
  assert.equal(bytes.length, expected.length, 'Network upload byte count');
  assert.equal(hash(bytes), hash(expected), 'Network upload bytes equal the selected sealed File');
  return { bytes: bytes.length, sha256: hash(bytes) };
}
function proveUpload(postData, expected, base64Encoded = false) {
  const bytes = postDataBytes(postData, expected.length, base64Encoded);
  try { return uploadProof(bytes, expected); }
  finally { bytes.fill(0); }
}
function proveUploadEntries(entries, expected) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 4096) throw Error('CDP upload entries unavailable');
  const parts = []; let count = 0, bytes;
  try {
    for (const entry of entries) {
      if (typeof entry?.bytes !== 'string') throw Error('CDP upload entry bytes unavailable');
      const part = base64Bytes(entry.bytes, expected.length - count); parts.push(part); count += part.length;
    }
    bytes = Buffer.concat(parts, count); return uploadProof(bytes, expected);
  } finally { bytes?.fill(0); for (const part of parts) part.fill(0); }
}
function mutationDiagnostic(row) {
  const data = row.postData || {};
  return { kind: row.kind, status: row.status, responseFinished: row.responseFinished === true,
    bodyCaptured: Boolean(row.body), receiverCaptured: Boolean(row.receiver), receiptCaptured: Boolean(row.accepted), failed: row.failed === true,
    postData: { hasPostData: data.hasPostData === true, eventTextPresent: data.eventTextPresent === true,
      entries: Number.isSafeInteger(data.entries) ? data.entries : null,
      entriesWithBytes: Number.isSafeInteger(data.entriesWithBytes) ? data.entriesWithBytes : 0,
      getterAttempted: data.getterAttempted === true, captureComplete: data.captureComplete === true,
      unavailableReason: data.unavailableReason === 'cdp-file-body-not-exposed' ? data.unavailableReason : null,
      unavailableDiagnostic: data.unavailableDiagnostic || null,
      source: ['requestWillBeSent.postDataEntries', 'getRequestPostData.utf8', 'getRequestPostData.base64'].includes(data.source) ? data.source : null },
    observationFailure: row.observationFailure || null };
}
function fileBodyUnavailable(error) {
  const found = cdpFailures.get(error);
  return found?.method === 'Network.getRequestPostData' && ['No post data available for the request',
    'No resource with given id was found', 'No resource with given identifier found',
    'No data found for resource with given identifier'].includes(found.reason);
}
async function captureReceiver(uploadId, captureReceivedUpload, expected, root) {
  assert.match(uploadId, ID); assert.equal(typeof captureReceivedUpload, 'function', 'actual receiver capture is required');
  let captured, overlaps = false;
  try {
    captured = await captureReceivedUpload(uploadId);
    assert.ok(Buffer.isBuffer(captured?.bytes), 'receiver must return the actual read Buffer');
    const bytes = captured.bytes, row = captured.row;
    overlaps = bytes.buffer === expected.buffer && bytes.byteOffset < expected.byteOffset + expected.length
      && expected.byteOffset < bytes.byteOffset + bytes.length;
    assert.equal(overlaps, false, 'receiver read must be independent of the expected Buffer');
    assert.ok(row && path.isAbsolute(row.file));
    assert.equal(path.basename(row.file), 'restore-upload-' + uploadId + '.sealed');
    const relative = path.relative(path.resolve(root), path.resolve(row.file));
    assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'receiver file stays inside the isolated fixture');
    assert.ok(path.basename(path.dirname(row.file)).startsWith('ruyi-work-data-upload-'));
    const stat = fs.lstatSync(row.file, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink()); assert.equal(stat.nlink, 1n);
    assert.equal(fs.realpathSync.native(row.file).toLowerCase(), path.resolve(row.file).toLowerCase());
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'mtimeNs', 'ctimeNs']) {
      assert.match(row[key], /^\d+$/); assert.equal(row[key], String(stat[key]), 'receiver actual native ' + key);
    }
    assert.equal(row.bytes, bytes.length); assert.equal(Number(stat.size), bytes.length);
    assert.equal(row.sha256, hash(bytes)); assert.equal(bytes.equals(expected), true, 'actual receiver bytes equal selected sealed File');
    assert.equal(row.sha256, hash(expected));
    return { uploadId, source: 'receiver-custody-readback', bytes: bytes.length, sha256: hash(bytes), row: { ...row } };
  } finally { if (Buffer.isBuffer(captured?.bytes) && !overlaps) captured.bytes.fill(0); }
}
function receipt(value, kind) {
  assert.equal(value?.ok, true, 'actual HTTP receipt must be successful');
  if (kind === 'upload') { assert.match(value.uploadId, ID); return { uploadId: value.uploadId }; }
  const job = value.job;
  assert.ok(job && job.operation === 'restore'); assert.match(job.id, ID);
  assert.ok(['queued', 'draining', 'preparing', 'ready', 'handoff'].includes(job.state));
  assert.equal(job.retry, false);
  return { id: job.id, operation: job.operation, state: job.state };
}
async function readMutationReceipt(client, kind, requestId, status) {
  const raw = await observedCdp(client, 'Network.getResponseBody', { requestId });
  const bytes = postDataBytes(raw.body, 65536, raw.base64Encoded);
  try {
    assert.equal(status, kind === 'upload' ? 201 : 202, 'actual mutation response status');
    const text = bytes.toString('utf8'); assert.equal(Buffer.from(text).equals(bytes), true, 'receipt strict UTF-8');
    return receipt(JSON.parse(text), kind);
  } finally { bytes.fill(0); }
}
function acceptedJobForTracking(facts) {
  const upload = facts.uploads[0], job = facts.jobs[0];
  if (upload?.status !== 201 || upload.responseFinished !== true || job?.status !== 202 || !job.accepted || !job.body) return null;
  assert.match(job.accepted.id, ID); assert.equal(job.accepted.operation, 'restore'); assert.match(job.body.uploadId, ID);
  return job.accepted.id; // Actual decoded Network 202 receipt, never expected/status-derived.
}
function assertFinalEvidence(facts, pendingProofFailure = null) {
  if (pendingProofFailure) throw pendingProofFailure;
  assert.equal(facts.uploads.length, 1); assert.equal(facts.jobs.length, 1);
  const upload = facts.uploads[0], job = facts.jobs[0];
  assert.match(acceptedJobForTracking(facts) || '', ID);
  assert.equal(upload.failed === true || job.failed === true, false);
  assert.match(upload.accepted?.uploadId || '', ID);
  assert.equal(upload.receiver?.source, 'receiver-custody-readback');
  assert.equal(upload.receiver.uploadId, upload.accepted.uploadId);
  assert.equal(job.body.uploadId, upload.accepted.uploadId);
  assert.equal(upload.postData.captureComplete, true); assert.equal(job.postData.captureComplete, true);
  if (!upload.body) assert.equal(upload.postData.unavailableReason, 'cdp-file-body-not-exposed');
  return true;
}

async function attachProductionBrowser({ harness, root, url, directories, selectedBytes, expectedJob, captureReceivedUpload, record, guard = () => {} }) {
  assert.equal(process.platform, 'win32');
  assert.equal(typeof captureReceivedUpload, 'function', 'actual receiver capture callback is required');
  const { CdpClient, waitForTarget } = require(path.join(harness, 'lib/browser-fixture'));
  const { findBrowserExecutable } = require(path.join(harness, 'lib/browser-path'));
  const { snapshotProcessTable, ownDescendants, killOwnTree } = require('./kill-own-tree');
  const { getFreePort } = require(path.join(harness, 'free-port'));
  assert.ok(Buffer.isBuffer(selectedBytes) && selectedBytes.length > 0 && selectedBytes.length <= 1024 * 1024, 'this first browser case uses a bounded small package');
  const origin = new URL(url).origin, profile = path.join(root, 'ruyi-browser-restore-profile');
  fs.mkdirSync(profile, { recursive: false });
  const browser = findBrowserExecutable(); assert.ok(browser, 'a real browser must exist');
  const debugPort = await getFreePort('127.0.0.1');
  let observationFailure = null, child, cdp, exit = null, close = null, resolveClose, step = 'spawn', cleanupResult = null;
  let action = null, selectedFileProven = false, pendingProofFailure = null, secretClearObservation = null;
  const proofFailure = error => { if (!pendingProofFailure) pendingProofFailure = error; };
  const closed = new Promise(resolve => { resolveClose = resolve; }), events = [], pending = new Set(), requests = new Map();
  const facts = { uploads: [], jobs: [], folderChoices: [], exceptions: 0, postDataUnavailable: 0 };
  const latch = error => { if (!observationFailure) observationFailure = error; };
  const healthy = () => { guard(); if (observationFailure) throw observationFailure; };
  function note(value) { try { record(value); } catch (error) { latch(error); throw error; } }
  function track(work) { const task = Promise.resolve().then(work); pending.add(task); task.catch(latch).finally(() => pending.delete(task)); }
  function snapshot(label) {
    const table = snapshotProcessTable(); if (!Array.isArray(table)) throw Error('browser process snapshot unavailable');
    const tree = ownDescendants(table, child.pid);
    if (!tree.root || initialIdentity && tree.root.created !== initialIdentity.created) throw Error('browser root creation identity changed');
    const rows = [tree.root, ...tree.descendants];
    note({ kind: 'browser-owned-sample', label, rows: rows.map(row => ({ ...row, created: String(row.created) })) });
    return rows;
  }
  let initialIdentity = null, initialRows = [];
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1280,900', '--remote-debugging-port=' + debugPort,
    '--user-data-dir=' + profile, 'about:blank'];
  healthy(); child = cp.spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Every lifecycle/error listener is installed before the first observer IO.
  child.on('spawn', () => { events.push({ event: 'spawn', pid: child.pid }); });
  child.on('error', latch);
  child.on('exit', (code, signal) => { exit = { code, signal }; events.push({ event: 'exit', code, signal }); });
  child.on('close', (code, signal) => { close = { code, signal }; events.push({ event: 'close', code, signal }); resolveClose(close); });
  let outputBytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('error', latch); stream.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 2 * 1024 * 1024) latch(Error('browser output bound')); });
  }
  async function waitUntil(test, milliseconds, label, check = healthy) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { check(); const found = await test(); if (found) return found; await sleep(40); }
    throw Error(label + ' deadline');
  }
  async function waitClosed(milliseconds) {
    if (close) return true;
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  }
  async function closeOwned({ failure = false } = {}) {
    if (cleanupResult) {
      if (failure) { cdp?.close(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
      return cleanupResult;
    }
    step = failure ? 'failure-browser-cleanup' : 'success-browser-close';
    const problems = [], sampled = [...initialRows];
    let existingOwnerCleanup = null, sampledIdentitiesAbsent = false;
    const problem = error => { problems.push(safeFailure(error)); };
    try {
      if (!failure) { healthy(); assert.equal(Boolean(close), false, 'browser must remain alive until explicit close'); }
      // Failure observation is independent of the native world's unknown latch.
      // A missing/changed CIM root forbids claims, but does not turn our held
      // ChildProcess into a foreign PID. killOwnTree checks it is still live.
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try {
          const table = snapshotProcessTable(); if (!Array.isArray(table)) throw Error('browser cleanup snapshot unavailable');
          const tree = ownDescendants(table, child.pid);
          if (!tree.root || initialIdentity && tree.root.created !== initialIdentity.created) throw Error('browser cleanup root identity unavailable');
          sampled.push(tree.root, ...tree.descendants);
        } catch (error) { problem(error); }
      }
      // Browser.close may close its socket before replying. It is a request,
      // never death proof; exit, close and sampled absence below are required.
      if (!close && cdp?.socket?.readyState === 1) {
        try { await cdp.send('Browser.close', {}, 10000); } catch { /* verified below */ }
      }
      if (!await waitClosed(cdp ? 15000 : 1000) && child?.pid && child.exitCode === null && child.signalCode === null) {
        existingOwnerCleanup = killOwnTree(child);
        if (!existingOwnerCleanup || existingOwnerCleanup.error || existingOwnerCleanup.skipped) problem(Error('owned browser cleanup request incomplete'));
        await waitClosed(20000);
      }
      if (!exit || !close) problem(Error('actual browser exit and close unobserved'));
      if (!events.some(row => row.event === 'spawn') || exit?.code !== close?.code || exit?.signal !== close?.signal) problem(Error('browser lifecycle event evidence inconsistent'));
      if (!existingOwnerCleanup && (exit?.code !== 0 || close?.code !== 0 || exit?.signal !== null || close?.signal !== null)) problem(Error('browser natural terminal unverified'));
      if (!sampled.length) problem(Error('no sampled browser identity; absence cannot be certified'));
      else {
        try {
          await waitUntil(() => {
            const table = snapshotProcessTable(); if (!Array.isArray(table)) throw Error('browser absence snapshot unavailable');
            return sampled.every(row => !table.some(now => now.pid === row.pid && now.created === row.created));
          }, 30000, 'sampled browser identities absent', () => {});
          sampledIdentitiesAbsent = true;
        } catch (error) { problem(error); }
      }
    } finally {
      cdp?.close();
      // Release only this observer's socket/pipes even when closure is unproved.
      // This is not a process-death claim and never kills a native restore owner.
      if (failure) { child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); }
    }
    cleanupResult = { events, exit, close, existingOwnerCleanup, sampledIdentitiesAbsent,
      sampledRows: sampled.map(row => ({ ...row, created: String(row.created) })), problems,
      verified: Boolean(exit && close && sampledIdentitiesAbsent && !problems.length),
      wholeTreeContinuousTracing: false, breakawayProcessClosureProven: false };
    if (!failure) {
      healthy(); assert.equal(cleanupResult.verified, true, 'browser close requires actual terminal and sampled absence');
      note({ kind: 'browser-closed', ...cleanupResult });
    }
    return cleanupResult;
  }
  try {
    step = 'attach-target';
    const found = await waitForTarget(debugPort, 'about:blank', child); assert.ok(found.target, found.why || 'browser target');
    healthy(); initialRows = snapshot('after-attach'); initialIdentity = initialRows[0];
    cdp = new CdpClient(found.target.webSocketDebuggerUrl);
    let connectionTimer;
    try { await Promise.race([cdp.connect(), new Promise((_, reject) => { connectionTimer = setTimeout(() => reject(Error('browser CDP connection deadline')), 15000); })]); }
    finally { clearTimeout(connectionTimer); }
    cdp.on('Runtime.exceptionThrown', () => { facts.exceptions++; latch(Error('actual page raised an exception')); });
    cdp.on('Network.requestWillBeSent', event => {
      const kind = requestKind(event.request?.url, event.request?.method, origin); if (!kind) return;
      const contentType = Object.entries(event.request.headers || {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
      if (kind === 'upload' && contentType !== 'application/octet-stream') { latch(Error('actual upload is not octet-stream')); return; }
      const entries = event.request.postDataEntries;
      const row = { kind, requestId: event.requestId, status: null, body: null, accepted: null, failed: null, responseFinished: false,
        postData: { hasPostData: event.request.hasPostData === true, eventTextPresent: typeof event.request.postData === 'string',
          entries: Array.isArray(entries) ? entries.length : null,
          entriesWithBytes: Array.isArray(entries) ? entries.filter(entry => typeof entry?.bytes === 'string').length : 0,
          getterAttempted: false, captureComplete: false, source: null } };
      if (requests.has(event.requestId)) { latch(Error('tracked mutation reused a Network request id')); return; }
      requests.set(event.requestId, row); facts[kind === 'upload' ? 'uploads' : 'jobs'].push(row);
      track(async () => {
        try {
          // https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Network.pdl
          // Official CDP defines these as the actual request's body elements;
          // binary bytes are base64 on JSON transport. Every element is required.
          // File/data-pipe elements may be omitted by Chromium: never fill a gap
          // with the local File/expected buffer. The real getter remains available.
          if (kind === 'upload' && Array.isArray(entries) && entries.length > 0 && entries.every(entry => typeof entry?.bytes === 'string')) {
            row.body = proveUploadEntries(entries, selectedBytes); row.postData.source = 'requestWillBeSent.postDataEntries';
            return;
          }
          row.postData.getterAttempted = true;
          let raw;
          try { raw = await observedCdp(cdp, 'Network.getRequestPostData', { requestId: event.requestId }); }
          catch (error) {
            if (kind !== 'upload' || !fileBodyUnavailable(error)) throw error;
            row.postData.unavailableReason = 'cdp-file-body-not-exposed';
            row.postData.unavailableDiagnostic = safeFailure(error); facts.postDataUnavailable++; return;
          }
          if (kind === 'upload' && raw.postData === '' && (raw.base64Encoded === undefined || raw.base64Encoded === false)) {
            row.postData.unavailableReason = 'cdp-file-body-not-exposed'; facts.postDataUnavailable++; return;
          }
          row.postData.source = raw.base64Encoded === true ? 'getRequestPostData.base64' : 'getRequestPostData.utf8';
          if (kind === 'upload') { row.body = proveUpload(raw.postData, selectedBytes, raw.base64Encoded); return; }
          const bytes = postDataBytes(raw.postData, 16384, raw.base64Encoded);
          let value;
          try { const text = bytes.toString('utf8'); assert.equal(Buffer.from(text).equals(bytes), true, 'actual job body is strict UTF-8'); value = JSON.parse(text); }
          finally { bytes.fill(0); }
          for (const field of ['operation', 'targetDirectory', 'backupDirectory']) assert.equal(value[field], expectedJob[field], 'actual job ' + field);
          assert.deepEqual(value.expectedAuthority, expectedJob.expectedAuthority);
          assert.equal(value.password, expectedJob.password, 'the selected package password reaches the one real job');
          assert.match(value.uploadId, ID);
          // Never persist the password, complete job body, token or raw event.
          row.body = { operation: value.operation, target: value.targetDirectory, uploadId: value.uploadId, passwordMatched: true };
          value.password = '';
        } catch (error) {
          if (!row.observationFailure) row.observationFailure = safeFailure(error);
          if (kind === 'upload') facts.postDataUnavailable++;
          proofFailure(error);
        } finally { row.postData.captureComplete = true; }
      });
    });
    cdp.on('Network.responseReceived', event => {
      const row = requests.get(event.requestId); if (!row) return;
      row.status = event.response.status;
      if (row.status !== (row.kind === 'upload' ? 201 : 202)) latch(Error('actual mutation HTTP status failed'));
    });
    cdp.on('Network.loadingFailed', event => { const row = requests.get(event.requestId); if (row) { row.failed = true; latch(Error('mutation response did not finish')); } });
    cdp.on('Network.loadingFinished', event => {
      const row = requests.get(event.requestId); if (!row) return;
      if (row.responseFinished) { latch(Error('mutation response finished twice')); return; }
      row.responseFinished = true;
      // Issue the body request in this event callback, before another renderer
      // event can invalidate its resource. Only the two exact mutations enter.
      const captured = (async () => {
        try {
          row.accepted = await readMutationReceipt(cdp, row.kind, event.requestId, row.status);
          row.receiptSource = 'Network.getResponseBody';
          note({ kind: 'browser-mutation-receipt', mutation: row.kind, status: row.status,
            accepted: row.accepted, source: row.receiptSource });
          if (row.kind === 'upload') {
            // First opportunity after the real 201; the page may already send
            // its job. This independent read never claims to precede that POST.
            row.receiver = await captureReceiver(row.accepted.uploadId, captureReceivedUpload, selectedBytes, root);
          }
        } catch (error) {
          if (!row.observationFailure) row.observationFailure = safeFailure(error);
          // A receipt proof failure stays fatal at final acceptance. Keep the
          // already-sent job ACK observable so the world can track native actors;
          // no request is retried and no metadata is substituted for a receipt.
          proofFailure(error);
        }
      })();
      track(() => captured);
    });
    // The sole substituted route is the native Windows directory-selection
    // dialog. Every /api/work-data/* request continues to the real server.
    cdp.on('Fetch.requestPaused', event => track(async () => {
      assert.equal(event.request.url, origin + '/api/pick-folder'); assert.equal(event.request.method, 'POST');
      const index = facts.folderChoices.length; assert.ok(index < directories.length, 'no unexpected folder-selection request');
      const folder = directories[index]; facts.folderChoices.push({ index, folder, nativeDialogSubstituted: true });
      note({ kind: 'browser-folder-choice', index, nativeDialogSubstituted: true });
      await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify({ ok: true, path: folder })).toString('base64') });
    }));
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable');
    // Observation budgets only; this never changes or replays the real request.
    // CDP Network.enable documents renderer-external response storage across
    // process navigation. This budget is explicit, not proof of an old failure's
    // cause. This fixture never pauses the renderer before enabling Network.
    const networkObservation = { maxPostDataSize: Math.max(selectedBytes.length, 16384),
      maxResourceBufferSize: 1024 * 1024, maxTotalBufferSize: 16 * 1024 * 1024, enableDurableMessages: true };
    await observedCdp(cdp, 'Network.enable', networkObservation);
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: origin + '/api/pick-folder', requestStage: 'Request' }] });
    await cdp.send('Page.navigate', { url });
    const evaluate = expression => cdp.evaluate(expression);
    // Only fixed selectors/substeps enter diagnostics; never input values or
    // arbitrary DOM text. An ancestor can hide a present, enabled button (the
    // settings item starts inside the hidden gear menu).
    const selectors = new Set(['#appGearBtn', '#openSettingsBtn', '#settingsTabs [data-stab="security"]',
      '#workDataOperation', '#workDataPickBackup', '#workDataPickParent', '#workDataRestoreName',
      '#workDataRestoreFile', '#workDataPassword', '#workDataPasswordConfirm', '#workDataConfirmRestore', '#workDataSubmit']);
    function uiStep(label, selector = null) {
      assert.ok(selector === null || selectors.has(selector), 'diagnostic selector must be fixed');
      step = label; action = selector ? { selector, state: 'waiting' } : null;
      note({ kind: 'browser-ui-step', step, selector });
    }
    const sameRect = (a, b) => a && b && ['left', 'top', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) <= 0.25);
    async function clickState(selector) {
      const expression = `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return{state:'missing'};
        if(e.matches(':disabled')||e.closest('[inert],[aria-disabled="true"]'))return{state:'disabled'};
        for(let v=e;v;v=v.parentElement){const s=getComputedStyle(v);if(v.hidden||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)<=0.01)return{state:'hidden'};}
        e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();
        if(r.width<1||r.height<1)return{state:'no-layout'};const x=r.left+r.width/2,y=r.top+r.height/2;
        if(x<0||y<0||x>=innerWidth||y>=innerHeight)return{state:'outside-viewport'};
        const hit=document.elementFromPoint(x,y);if(hit!==e&&!e.contains(hit))return{state:'obscured'};
        return{state:'ready',rect:{left:r.left,top:r.top,width:r.width,height:r.height},point:{x,y}};})()`;
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, 2000);
      if (result.exceptionDetails) throw Error('click unavailable');
      return result.result?.value;
    }
    async function click(selector) {
      assert.ok(selectors.has(selector), 'click selector must be fixed');
      const deadline = Date.now() + 10000; let prior = null, stable = 0, ready = null;
      while (Date.now() < deadline) {
        healthy(); const found = await clickState(selector);
        action = { selector, state: found.state, ...(found.rect ? { rect: found.rect } : {}) };
        stable = found.state === 'ready' && sameRect(prior?.rect, found.rect) ? stable + 1 : 0;
        prior = found;
        if (stable >= 2) { ready = found; break; }
        await sleep(40);
      }
      if (!ready) throw Error('click readiness deadline');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...ready.point });
      healthy(); const final = await clickState(selector);
      action = { selector, state: final.state, ...(final.rect ? { rect: final.rect } : {}) };
      if (final.state !== 'ready' || !sameRect(ready.rect, final.rect)) throw Error('click target changed before press');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...final.point, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...final.point, button: 'left', clickCount: 1 });
      action = { selector, state: 'clicked' }; note({ kind: 'browser-ui-click', step, selector });
    }
    async function key(key, code) { await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code }); await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code }); }
    async function insert(selector, text) { await click(selector); await cdp.send('Input.insertText', { text }); }
    async function prepare({ packageFile, targetName }) {
      uiStep('app-ready');
      await waitUntil(() => evaluate('document.readyState === "complete" && document.documentElement.lang === "en-US" && window.state?.config?.locale === "en-US" && !!window.state?.config?.onboarding?.completedAt && typeof document.getElementById("appGearBtn")?.onclick === "function" && typeof document.getElementById("openSettingsBtn")?.onclick === "function"'), 30000, 'actual app ready');
      uiStep('open-gear-menu', '#appGearBtn'); await click('#appGearBtn');
      await waitUntil(() => evaluate('document.getElementById("appGearBtn").getAttribute("aria-expanded") === "true" && !document.getElementById("appGearMenu").hidden'), 10000, 'actual gear menu ready');
      uiStep('open-settings', '#openSettingsBtn'); await click('#openSettingsBtn');
      await waitUntil(() => evaluate('!document.getElementById("settingsModal").classList.contains("hidden")'), 10000, 'actual settings modal ready');
      uiStep('open-security-tab', '#settingsTabs [data-stab="security"]'); await click('#settingsTabs [data-stab="security"]');
      uiStep('restore-panel-ready');
      await waitUntil(() => evaluate('!!document.getElementById("workDataOperation") && !document.getElementById("workDataOperation").disabled'), 30000, 'actual restore panel ready');
      uiStep('open-operation-select', '#workDataOperation'); await click('#workDataOperation');
      uiStep('select-restore-end', '#workDataOperation'); await key('End', 35);
      uiStep('select-restore-enter', '#workDataOperation'); await key('Enter', 13);
      assert.equal(await evaluate('document.getElementById("workDataOperation").value'), 'restore');
      uiStep('pick-backup-folder', '#workDataPickBackup'); await click('#workDataPickBackup');
      await waitUntil(() => evaluate('!!document.getElementById("workDataBackupDirectory").value && !document.getElementById("workDataPickParent").disabled'), 30000, 'backup folder selection');
      uiStep('pick-target-parent', '#workDataPickParent'); await click('#workDataPickParent');
      await waitUntil(() => evaluate('!!document.getElementById("workDataRestoreParent").value && !document.getElementById("workDataRestoreName").disabled'), 30000, 'target parent selection');
      uiStep('enter-target-name', '#workDataRestoreName'); await insert('#workDataRestoreName', targetName);
      uiStep('select-real-file', '#workDataRestoreFile');
      const document = await cdp.send('DOM.getDocument', { depth: 0 });
      const input = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#workDataRestoreFile' });
      await cdp.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [packageFile] });
      const selected = await evaluate(`(async()=>{const files=document.getElementById('workDataRestoreFile').files;const file=files[0];const digest=file?await crypto.subtle.digest('SHA-256',await file.arrayBuffer()):null;return{count:files.length,name:file?.name,size:file?.size,sha256:digest?Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''):null};})()`);
      assert.equal(selected.count, 1); assert.equal(selected.name, path.basename(packageFile)); assert.equal(selected.size, selectedBytes.length);
      assert.equal(selected.sha256, hash(selectedBytes), 'the browser selected File has the sealed bytes SHA-256');
      selectedFileProven = true;
      note({ kind: 'browser-selected-file', ...selected, selection: 'CDP DOM.setFileInputFiles with a real fixture file' });
      uiStep('enter-package-password', '#workDataPassword'); await insert('#workDataPassword', expectedJob.password);
      uiStep('confirm-package-password', '#workDataPasswordConfirm'); await insert('#workDataPasswordConfirm', expectedJob.password);
      uiStep('confirm-restore-target', '#workDataConfirmRestore'); await click('#workDataConfirmRestore');
      uiStep('restore-submit-enabled', '#workDataSubmit');
      assert.equal(await evaluate('document.getElementById("workDataSubmit").disabled'), false);
    }
    async function submit() {
      uiStep('real-upload-and-job', '#workDataSubmit');
      healthy(); assert.equal(facts.uploads.length, 0); assert.equal(facts.jobs.length, 0);
      await click('#workDataSubmit');
      // Start against the selected source form immediately after the real click,
      // before awaiting any ACK. The still-selected File excludes an empty newly
      // mounted target form; missing controls throw instead of falling back.
      secretClearObservation = { stage: 'source-form-after-click-before-ack', startedBeforeJobAck: !facts.jobs[0]?.accepted,
        complete: false, verified: false };
      const secretsCleared = (async () => {
        try {
          assert.equal(secretClearObservation.startedBeforeJobAck, true, 'secret-clear observation starts before the job ACK');
          assert.equal(await evaluate('document.getElementById("workDataRestoreFile").files.length === 1 && !document.getElementById("workDataPassword").value && !document.getElementById("workDataPasswordConfirm").value'), true);
          secretClearObservation.verified = true;
        }
        catch (error) { proofFailure(error); }
        finally { secretClearObservation.complete = true; }
      })();
      track(() => secretsCleared);
      note({ kind: 'browser-secret-clear-observation', ...secretClearObservation });
      try { await waitUntil(() => acceptedJobForTracking(facts), 60000, 'actual upload and job receipts'); }
      catch (error) { throw pendingProofFailure || error; }
      assert.equal(facts.uploads.length, 1); assert.equal(facts.jobs.length, 1);
      note({ kind: 'browser-native-tracking-ack', jobId: facts.jobs[0].accepted.id, source: 'Network.getResponseBody',
        evidencePending: pending.size > 0 || Boolean(pendingProofFailure) || !facts.uploads[0].receiver,
        finalAcceptance: false });
      return facts.jobs[0].accepted.id;
    }
    async function assertTargetServing(target) {
      step = 'target-serving-dom';
      await waitUntil(() => evaluate('document.getElementById("workDataProgress")?.textContent.includes("The restored target is now serving")'), 120000, 'actual browser reconnects to restored target');
      assert.equal(await evaluate(`document.getElementById('workDataProgress').textContent.includes(${JSON.stringify(target)})`), true);
      await Promise.all([...pending]); healthy(); assertFinalEvidence(facts, pendingProofFailure);
      return facts;
    }
    return { prepare, submit, assertTargetServing, close: closeOwned, facts, evaluate,
      failureDiagnostic: () => ({ step, action, networkObservation, secretClearObservation,
        pendingProofFailure: pendingProofFailure ? safeFailure(pendingProofFailure) : null,
        acceptedJob: facts.jobs[0]?.accepted ? { ...facts.jobs[0].accepted, source: facts.jobs[0].receiptSource, status: facts.jobs[0].status } : null,
        preparation: { folderChoices: facts.folderChoices.length, selectedFileProven },
        mutationRequests: { uploads: facts.uploads.length, jobs: facts.jobs.length },
        mutations: [...facts.uploads, ...facts.jobs].map(mutationDiagnostic),
        observationFailure: observationFailure ? safeFailure(observationFailure) : null, cleanup: cleanupResult }) };
  } catch (error) {
    latch(error);
    const failedStep = step;
    // Attach can fail before returning the public handle. Its private owner
    // still has the actual ChildProcess, and must attempt bounded cleanup here.
    const cleanup = await closeOwned({ failure: true });
    error.browserFailure = { step: failedStep, pid: child?.pid || null, events, profile, error: safeFailure(error), cleanup };
    throw error;
  }
}
module.exports = { attachProductionBrowser, requestKind, proveUpload, proveUploadEntries, observedCdp, readMutationReceipt, acceptedJobForTracking, assertFinalEvidence, mutationDiagnostic, captureReceiver, fileBodyUnavailable, receipt, safeFailure };

'use strict';
// Manual lifecycle fixture. All GUI observations/input belong to root's Sky
// session. This program never inspects, injects or operates a window.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { createRunner } = require('./harness');
const { releaseEnvironment } = require('./release-checks');
const { startFakeProvider } = require('./fake-openai-provider');
const { killOwnTree } = require('./kill-own-tree');
const { getFreePort } = require('../free-port');
const { observeHeldChild, knownClosed, knownCleanup, retainProviderStartup, waitWithin } = require('./external-bots-c2/actual-http-fixture.cjs');
const { assertSameDirectory } = require('./external-bots-c2/sealed-observer.cjs');
const { retainUnknownOwners } = require('./offline-package-retention.cjs');
const BUDGET = Object.freeze({ startup: 120000, ui: 600000, close: 90000, cleanup: 45000 });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hashFile = file => sha(fs.readFileSync(file));
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]; assert.ok(['--stage', '--output', '--expected-server-sha'].includes(key) && !Object.hasOwn(values, key), 'explicit unique fixture arguments required');
    assert.ok(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')); values[key] = argv[i + 1];
  }
  for (const key of ['--stage', '--output']) assert.ok(typeof values[key] === 'string' && path.isAbsolute(values[key]), key + ' must be absolute');
  assert.match(values['--expected-server-sha'] || '', /^[a-f0-9]{64}$/i);
  return { stage: path.resolve(values['--stage']), output: path.resolve(values['--output']), expectedServerSha: values['--expected-server-sha'].toLowerCase() };
}
function assertUiCompletion(marker, nonce, readyAt) {
  assert.ok(marker && marker.schema === 1 && marker.nonce === nonce && marker.observer === '@oai/sky', 'root Sky completion identity required');
  for (const key of ['guiLoaded', 'settingsRead', 'normalClose', 'closedObserved']) assert.equal(marker[key], true, 'actual Sky ' + key + ' observation required');
  assert.ok(typeof marker.skyWindowId === 'string' && marker.skyWindowId.length > 0, 'opaque Sky-returned window identity required');
  const times = ['loadedAt', 'settingsReadAt', 'closeRequestedAt', 'closedObservedAt'].map(key => Date.parse(marker[key]));
  assert.ok(times.every(Number.isFinite) && times[0] >= readyAt && times.every((value, i) => !i || value >= times[i - 1]), 'ordered actual UI observations after fixture READY required');
  assert.ok(Array.isArray(marker.evidenceFiles) && marker.evidenceFiles.length > 0 && marker.evidenceFiles.every(file => typeof file === 'string' && path.isAbsolute(file)), 'archived Sky evidence files required');
  return times;
}
function assertAbortMarker(marker, nonce) {
  assert.ok(marker && typeof marker === 'object' && !Array.isArray(marker)
    && Object.keys(marker).sort().join(',') === 'nonce,reason,schema'
    && marker.schema === 1 && marker.nonce === nonce, 'explicit owned Desktop abort identity required');
  assert.ok(typeof marker.reason === 'string' && marker.reason === marker.reason.trim()
    && marker.reason.length > 0 && marker.reason.length <= 1000 && !/[\x00-\x1f\x7f]/.test(marker.reason), 'explicit bounded abort reason required');
  return marker;
}
function assertNormalClosure(desktop, native, nonce, marker, expected) {
  assert.ok(knownCleanup(desktop) && !desktop.killReceipt && desktop.facts.exit.code === 0 && desktop.facts.exit.signal === null,
    'original Desktop must exit zero normally with close and original stdout/stderr EOF');
  assert.ok(native && native.schema === 1 && native.kind === 'ORIGINAL_BACKEND_HANDLE_SIGNALED' && native.nonce === nonce
    && native.originalHandleSignaled === true && native.handleDisposed === true && native.timedOut === false && native.exitCode === 0,
  'original backend handle must actually signal with exit zero, never timeout/forced teardown');
  for (const key of ['serverPid', 'nativeCreated', 'cimCreated']) assert.equal(native[key], expected[key], 'same original native owner ' + key);
  assert.ok(Date.parse(native.signaledAt) >= Date.parse(marker.closeRequestedAt), 'backend original handle must signal after the recorded normal GUI close action');
}
async function until(read, deadline, label) {
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await pause(100); }
  throw Error(label + ': caller deadline');
}
const readOptional = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

async function qualify(options, runner = createRunner('OFFLINE DESKTOP QUALIFICATION')) {
  assert.equal(process.platform, 'win32', 'actual Windows Desktop qualification required');
  const { stage, output, expectedServerSha } = options;
  assert.ok(fs.lstatSync(stage).isDirectory() && !fs.lstatSync(stage).isSymbolicLink());
  assertSameDirectory(stage, fs.realpathSync.native(stage));
  assert.ok(!fs.existsSync(output) || fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink() && !fs.readdirSync(output).length, 'output must be new or empty');
  for (const [parent, child] of [[stage, output], [output, stage]]) {
    const relative = path.relative(parent, child); assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'stage and output must be disjoint');
  }
  fs.mkdirSync(output, { recursive: true });
  const physicalOutput = fs.realpathSync.native(output), physicalStage = fs.realpathSync.native(stage);
  for (const [parent, child] of [[physicalStage, physicalOutput], [physicalOutput, physicalStage]]) {
    const relative = path.relative(parent, child); assert.ok(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'physical stage and output must be disjoint');
  }
  const nonce = crypto.randomBytes(16).toString('hex'), startedAt = Date.now();
  fs.writeFileSync(path.join(output, 'desktop-owner.json'), JSON.stringify({ nonce, stage }), { flag: 'wx' });
  const report = { schema: 1, status: 'RUNNING', stage, output, startedAt: new Date(startedAt).toISOString(), nonce, budgetsMs: BUDGET,
    harness: { node: process.version, entrySha256: hashFile(__filename), nativeObserverSha256: hashFile(path.join(__dirname, 'offline-desktop-process-observer.ps1')) },
    inputs: [], actors: [], checks: [], bounds: ['root performs all GUI observation/input using @oai/sky; this fixture has no window automation',
      'Desktop launches bundled Node app/server.js; Ruyi.exe is an inventoried sibling, not the GUI backend',
      'normal zero exit and original pipe EOF plus original backend native-handle signal only',
      'IsProcessInJob means any Job, not attribution/enumeration of the Desktop Job or all WebView2 descendant kernel exits',
      'timeouts retain the original owners and remain UNKNOWN/RED even after late closure'] };
  const save = () => fs.writeFileSync(path.join(output, 'desktop-qualification.json'), JSON.stringify(report, null, 2) + '\n');
  const emit = value => console.log(JSON.stringify(value));
  const check = label => { runner.ok(true, label); report.checks.push({ label, passed: true }); save(); };
  const actors = [], cleanupErrors = [];
  let desktop, observer, providerOwner, fake, nativeReady, nativeFinal, primary, marker, readyAt, retained;
  let phase = 'input', forcedCleanup = false;
  const abortFile = path.join(output, 'abort.json');
  let abortRequest, abortFailure, abortKillAttempted = false, notifyAbort;
  const abortNotice = new Promise(resolve => { notifyAbort = resolve; });
  const abortAware = work => Promise.race([work, abortNotice.then(error => { throw error; })]);
  const observedUntil = (read, deadline, label) => until(() => { if (abortFailure) throw abortFailure; return read(); }, deadline, label);
  const monitorAbort = () => {
    try {
      if (!abortRequest && fs.existsSync(abortFile)) {
        const stat = fs.lstatSync(abortFile);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 4096
          && fs.realpathSync.native(abortFile) === path.join(physicalOutput, 'abort.json'), 'owned regular abort marker required');
        abortRequest = assertAbortMarker(JSON.parse(fs.readFileSync(abortFile, 'utf8')), nonce);
        report.explicitAbort = { ...abortRequest, observedAt: new Date().toISOString(), teardownOnly: true };
        abortFailure = Object.assign(Error('explicit root Desktop test abort: ' + abortRequest.reason), { code: 'DESKTOP_QUALIFICATION_ABORT' });
        notifyAbort(abortFailure);
      }
      if (abortRequest && desktop?.facts.spawn && !abortKillAttempted) {
        abortKillAttempted = true;
        if (!knownClosed(desktop) && !desktop.facts.exit && desktop.child.exitCode === null && desktop.child.signalCode === null) {
          forcedCleanup = true; desktop.killReceipt = killOwnTree(desktop.child);
          report.explicitAbort.killReceipt = desktop.killReceipt;
        }
      }
    } catch (error) {
      if (!abortFailure) { abortFailure = error; report.abortControlError = error.message; notifyAbort(error); }
    }
  };
  // No timeout triggers teardown. Only the nonce-bound explicit root marker may
  // kill the still-held original Desktop tree; the native observer is never killed.
  const abortTimer = setInterval(monitorAbort, 100);
  const held = (file, argv, env, role) => {
    const child = cp.spawn(file, argv, { cwd: stage, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const row = observeHeldChild(child, role, { stdio: ['ignore', 'pipe', 'pipe'] }); row.logErrors = [];
    for (const name of ['stdout', 'stderr']) child[name].on('data', bytes => { try { fs.appendFileSync(path.join(output, role + '-' + name + '.log'), bytes); } catch (error) { row.logErrors.push(error.message); } });
    actors.push(row); report.actors = actors.map(value => value.facts); return row;
  };
  const stopOriginalHelper = async (row, deadline = Date.now() + BUDGET.cleanup) => {
    if (!knownClosed(row)) {
      if (row.facts.spawn && row.child.exitCode === null && row.child.signalCode === null) { row.killReceipt = killOwnTree(row.child); forcedCleanup = true; }
      await waitWithin(row.closed, deadline, 'original helper cleanup');
    }
    assert.ok(knownCleanup(row));
  };
  try {
    for (const relative of ['RuyiDesktop.exe', 'Ruyi.exe', 'WebView2Loader.dll', 'runtime/node/node.exe', 'app/server.js', 'tools/verify-media-artifacts.cjs']) {
      const file = path.join(stage, relative), before = fs.lstatSync(file, { bigint: true });
      assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
      report.inputs.push({ path: relative, bytes: Number(before.size), sha256: hashFile(file) });
      const after = fs.lstatSync(file, { bigint: true }); for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key]);
    }
    assert.equal(report.inputs.find(row => row.path === 'app/server.js').sha256, expectedServerSha);
    assert.ok(fs.existsSync(path.join(stage, 'LOCAL-MEDIA-QUALIFICATION.txt')), 'explicit Full-local stage required');
    check('fresh qualification binds actual Desktop/EXE/loader/Node/server/verifier bytes to the selected Full-local stage');
    phase = 'provider';
    providerOwner = retainProviderStartup(startFakeProvider({ handler() { throw Error('GUI load/settings-only fixture must not start a model turn'); } }), value => { fake = value; },
      (type, value) => { report.provider = { type, value }; save(); }, Date.now() + BUDGET.startup + BUDGET.ui + BUDGET.close + BUDGET.cleanup);
    await abortAware(waitWithin(providerOwner.started, Date.now() + BUDGET.startup, 'original local fake provider startup'));
    const data = path.join(output, 'data'), home = path.join(output, 'profile'), work = path.join(output, 'workspace');
    for (const dir of [data, work]) fs.mkdirSync(dir);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:SystemRoot|SystemDrive|WINDIR|Path|PATHEXT|ComSpec|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
    const env = { ...releaseEnvironment(home, data, inherited), RUYI_TEST_HOOKS: '0', NODE_OPTIONS: '', RUYI_DESKTOP_QUALIFICATION_NONCE: nonce, PORT: String(await getFreePort()) };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 14, activeProvider: 'desktop-fixture', engineMode: 'interactive', permissionMode: 'default',
      privacyModeV1: 'off', credentialEncryptionV1: false, workDataEncryptionV1: false, defaultWorkspace: work,
      providers: [{ id: 'desktop-fixture', label: 'Local Desktop qualification', type: 'openai-compat', baseUrl: fake.url, apiKey: '', model: 'fixture', models: [{ id: 'fixture', label: 'Fixture' }] }],
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, autoImportKimiCodeMcp: false, enableMcpDropIn: false, externalMcpServers: [],
      schedulerEnabledV1: false, stewardEnabledV1: false, stewardThreadBriefV1: false, missionAutoContinue: false, desktopMcp: { enabled: false, autodetect: false },
      onboarding: { completedAt: new Date().toISOString(), version: 1, skipped: false } }), { flag: 'wx' });
    phase = 'Desktop startup';
    desktop = held(path.join(stage, 'RuyiDesktop.exe'), [], env, 'original-desktop');
    save();
    const startupDeadline = Date.now() + BUDGET.startup;
    const runtime = await abortAware(observedUntil(async () => {
      assert.ok(!desktop.facts.error && !desktop.facts.exit, 'original Desktop refused/exited before readiness');
      const value = readOptional(path.join(data, 'runtime.json'));
      if (!value?.pid || value.port !== Number(env.PORT) || !value.token || !value.overlayId) return null;
      try { const response = await fetch('http://127.0.0.1:' + value.port + '/health', { signal: AbortSignal.timeout(2000) });
        const body = await response.json(); return response.status === 200 && body.overlayId === value.overlayId && value; } catch { return null; }
    }, startupDeadline, 'original Desktop backend runtime/health'));
    const api = async (route, body) => {
      const response = await fetch('http://127.0.0.1:' + runtime.port + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-wcw-token': runtime.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200, 'actual owned API ' + route); return response.json();
    };
    const bootstrap = await api('/api/bootstrap', {}), status = await api('/api/status'), metrics = await api('/api/metrics');
    assert.equal(bootstrap.token, runtime.token); assert.equal(metrics.pid, runtime.pid); assert.equal(status.overlayId, runtime.overlayId);
    assertSameDirectory(status.dataRoot, data); assert.equal(status.isPkg, false);
    assert.equal(fs.realpathSync.native(status.exePath).toLowerCase(), fs.realpathSync.native(path.join(stage, 'app/server.js')).toLowerCase());
    assert.equal(status.config.workDataEncryptionV1, false);
    report.backend = { pid: runtime.pid, desktopPid: desktop.child.pid, port: runtime.port, overlayId: runtime.overlayId,
      tokenSha256: sha(Buffer.from(runtime.token)), exePath: status.exePath, isPkg: status.isPkg, dataRoot: status.dataRoot, node: metrics.node };
    check('original Desktop exposes exact isolated backend health/runtime/token/overlay/status and bundled-Node source route');
    phase = 'native original backend handle';
    const nativeDeadline = Date.now() + BUDGET.cleanup + BUDGET.ui + BUDGET.close;
    const job = { schema: 1, nonce, stage, output, driverPid: process.pid, desktopPid: desktop.child.pid, serverPid: runtime.pid,
      desktopExe: path.join(stage, 'RuyiDesktop.exe'), serverExe: path.join(stage, 'runtime/node/node.exe'), deadlineUtc: new Date(nativeDeadline).toISOString() };
    const jobFile = path.join(output, 'native-observer-job.json'); fs.writeFileSync(jobFile, JSON.stringify(job), { flag: 'wx' });
    observer = held(path.join(env.SystemRoot || env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'offline-desktop-process-observer.ps1'), '-JobFile', jobFile], env, 'original-native-observer');
    save();
    nativeReady = await abortAware(observedUntil(() => { assert.ok(!desktop.facts.exit && !desktop.facts.error && !observer.facts.exit && !observer.facts.error, 'original actor exited before native hold');
      return readOptional(path.join(output, 'native-observer-ready.json')); }, Math.min(startupDeadline + BUDGET.cleanup, Date.now() + BUDGET.cleanup), 'native original handle ready'));
    assert.ok(nativeReady.kind === 'ORIGINAL_BACKEND_HANDLE_HELD' && nativeReady.nonce === nonce && nativeReady.serverPid === runtime.pid
      && nativeReady.desktopPid === desktop.child.pid && nativeReady.driverPid === process.pid && nativeReady.inAnyJob === true);
    assert.match(nativeReady.nativeCreated, /^[1-9][0-9]+$/); assert.match(nativeReady.cimCreated, /^[1-9][0-9]+$/);
    report.nativeReady = nativeReady;
    check('native observer holds the original C#-spawned backend handle after exact parent/path/two-birth checks');
    readyAt = Date.now(); report.readyAt = new Date(readyAt).toISOString();
    const controlFile = path.join(output, 'ui-complete.json');
    const ready = { kind: 'READY', stage, output, nonce, desktopPid: desktop.child.pid, serverPid: runtime.pid, port: runtime.port, readyAt: report.readyAt,
      controlFile, abortFile, explicitAbortFields: { schema: 1, nonce, reason: '<explicit root test teardown reason; always RED>' }, inputs: report.inputs, guiActions: ['root @oai/sky selects the newly returned window identity', 'observe loaded workbench', 'read normal Settings without privacy/security changes', 'normal X/AltF4 close, then observe absence'],
      completionFields: { schema: 1, nonce, observer: '@oai/sky', skyWindowId: '<opaque returned ID>', guiLoaded: true, settingsRead: true, normalClose: true, closedObserved: true,
        loadedAt: '<ISO time>', settingsReadAt: '<ISO time>', closeRequestedAt: '<ISO time before normal close action>', closedObservedAt: '<ISO time>', evidenceFiles: ['<absolute archived Sky observation JSON inside output>'] } };
    fs.writeFileSync(path.join(output, 'READY.json'), JSON.stringify(ready, null, 2), { flag: 'wx' }); emit(ready); save();
    phase = 'root Sky GUI observations';
    marker = await abortAware(observedUntil(() => readOptional(controlFile), readyAt + BUDGET.ui, 'root Sky completion marker'));
    assertUiCompletion(marker, nonce, readyAt);
    report.gui = { ...marker, evidenceFiles: marker.evidenceFiles.map(file => {
      const stat = fs.lstatSync(file), relative = path.relative(physicalOutput, fs.realpathSync.native(file));
      assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Sky evidence must be archived inside the owned output');
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); return { path: file, bytes: stat.size, sha256: hashFile(file) };
    }) };
    check('root Sky records actual loaded GUI, read-only Settings and observed normal window close');
    phase = 'original normal closure';
    const closeDeadline = Date.now() + BUDGET.close;
    await abortAware(waitWithin(desktop.closed, closeDeadline, 'original Desktop close and pipe EOF'));
    nativeFinal = await abortAware(observedUntil(() => readOptional(path.join(output, 'native-observer-final.json')), closeDeadline, 'same original backend native handle signal'));
    await abortAware(waitWithin(observer.closed, closeDeadline, 'original native observer close and pipe EOF'));
    assertNormalClosure(desktop, nativeFinal, nonce, marker, nativeReady);
    assert.ok(knownCleanup(observer) && !observer.killReceipt && observer.facts.exit.code === 0 && observer.facts.exit.signal === null);
    assert.equal(fake.requests.length, 0); assert.equal(fake.errors.length, 0);
    assert.ok(actors.every(row => row.logErrors.length === 0));
    report.nativeFinal = nativeFinal;
    check('original Desktop and original held backend both exit zero normally, with genuine close/EOF and native signal proof');
    for (const row of report.inputs) assert.equal(hashFile(path.join(stage, row.path)), row.sha256, 'qualification input unchanged: ' + row.path);
    check('Desktop GUI acceptance does not mutate the selected stage inputs');
    report.status = 'PASS';
  } catch (error) {
    primary = error; report.status = 'UNKNOWN'; report.firstFailure = { phase, error: error.stack || String(error), at: new Date().toISOString() };
    try { save(); } catch (diagnostic) { cleanupErrors.push(diagnostic); report.firstFailure.diagnosticError = diagnostic.message; }
    emit({ kind: 'UNKNOWN', output, phase, error: error.message, desktopPid: desktop?.child.pid || null, retainingOriginalObjects: true,
      instruction: 'root may finish normal GUI close using Sky; no PID-only teardown or late success is inferred' });
    // Keep exact original owners. A timeout never turns normal-close acceptance
    // into forced cleanup or drops the original native handle observer.
    if (desktop && !knownClosed(desktop)) await desktop.closed;
    if (observer && !knownClosed(observer)) await observer.closed;
    nativeFinal ||= readOptional(path.join(output, 'native-observer-final.json'));
    report.nativeFinal = nativeFinal || null;
    report.status = nativeFinal?.originalHandleSignaled === true ? 'RED_ORIGINAL_FAILURE_RETAINED' : 'UNKNOWN_BACKEND_HANDLE_PROOF_UNAVAILABLE';
  } finally {
    report.actors = actors.map(row => ({ ...row.facts, killReceipt: row.killReceipt, knownCleanup: Boolean(knownCleanup(row)) }));
    if (providerOwner) {
      try { await waitWithin(providerOwner.requestClose(), Date.now() + BUDGET.cleanup, 'original provider close'); }
      catch (error) {
        cleanupErrors.push(error); report.status = 'UNKNOWN';
        retained = retainUnknownOwners({ actors: [], provider: providerOwner, deadline: Date.now() + BUDGET.cleanup,
          stop: stopOriginalHelper, note: value => { report.providerRetention = value; save(); } });
      }
    }
    monitorAbort(); clearInterval(abortTimer);
    if (abortFailure && primary !== abortFailure) cleanupErrors.push(abortFailure);
    if (abortFailure && report.status === 'PASS') report.status = 'RED_EXPLICIT_ABORT_OR_INVALID_MARKER';
    report.forcedCleanup = forcedCleanup; report.finishedAt = new Date().toISOString();
    try { save(); } catch (error) { cleanupErrors.push(error); report.status = 'RED_REPORT_PERSIST_FAILED'; }
  }
  if (cleanupErrors.length) primary = new AggregateError([...(primary ? [primary] : []), ...cleanupErrors],
    'Desktop qualification failed or cleanup/report persistence failed', { cause: primary || cleanupErrors[0] });
  if (primary) { runner.fail(primary.stack || String(primary)); if (retained) await retained.promise; }
  return report;
}
if (require.main === module) {
  const runner = createRunner('OFFLINE DESKTOP QUALIFICATION');
  Promise.resolve().then(() => qualify(parseArgs(process.argv.slice(2)), runner)).catch(error => runner.fail(error.stack || String(error))).finally(() => runner.done());
}
module.exports = { BUDGET, parseArgs, assertUiCompletion, assertAbortMarker, assertNormalClosure, qualify };

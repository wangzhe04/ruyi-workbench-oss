'use strict';

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const execute = require('node:util').promisify(execFile);
const { releaseEnvironment } = require('./release-checks.js');
const { fixedSpawnCommandLine } = require('./work-data-production-upload-process.js');
const { processRows, sameProcess, processIdentity } = require('./windows-lifetime-processes.cjs');
const { requestJson } = require('./lifetime-loopback-json.cjs');

const powershell = path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const windowScript = path.resolve(__dirname, '../fixtures/desktop-app-window.ps1');

async function script(file, args = []) {
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
    { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  return stdout.trim();
}

async function until(label, ms, sample) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await sample(deadline);
    if (value && Date.now() <= deadline) return value;
    await delay(100);
  }
  throw Error(label + ' timed out');
}

async function build(workbench, stage) {
  for (const dir of ['desktop', 'app', 'config', 'resources', 'semantic-runtime']) {
    fs.cpSync(path.join(workbench, dir), path.join(stage, dir), { recursive: true });
  }
  const runtime = path.join(stage, 'runtime', 'node');
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtime, 'node.exe'));
  await script(path.join(stage, 'desktop/build-desktop.ps1'));
  return path.join(stage, 'RuyiDesktop.exe');
}

function launch(dir, exe, profile, lockHash) {
  const data = path.join(dir, 'data');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:SystemRoot|WINDIR|ComSpec|PATH|PATHEXT|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)));
  const env = releaseEnvironment(path.join(dir, 'home'), data, inherited);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    configSchema: 14, locale: 'en-US', semanticRetrievalV1: true, workDataEncryptionV1: false,
    engineMode: 'print', claudePath: process.execPath, kimiPath: process.execPath,
    stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
    importAgentInstructions: false, includeWorkbenchMcp: false, externalMcpServers: [],
    desktopMcp: { enabled: false, autodetect: false }, providers: [], defaultWorkspace: dir
  }));
  Object.assign(env, {
    WCW_TEST_NO_NET_ANCHORS: '1', RUYI_SEMANTIC_BACKEND: 'gemma2', RUYI_SEMANTIC_GEMMA2_ROOT: profile,
    RUYI_SEMANTIC_GEMMA2_LOCK_SHA256: lockHash, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--force-renderer-accessibility'
  });
  const child = spawn(exe, [], { cwd: path.dirname(exe), env, stdio: 'ignore' });
  const app = { exe, data, child };
  child.once('error', error => { app.error = error; });
  child.once('close', (code, signal) => { app.exit = { code, signal }; });
  return app;
}

function running(app) {
  if (app.error) throw app.error;
  assert.ok(!app.exit && app.child.exitCode === null && app.child.signalCode === null, 'original desktop is running');
}

async function status(runtime, timeoutMs) {
  const url = 'http://127.0.0.1:' + runtime.port;
  const res = await requestJson(url, runtime.token, '/api/status', undefined, timeoutMs);
  assert.equal(res.status, 200);
  assert.ok(['ready', 'loading'].includes(res.value.semanticRuntime?.state), 'real model is available');
  return res.value.semanticRuntime.state;
}

async function windowInfo(app, close) {
  const args = ['-OwnerPid', String(app.child.pid), '-Created', app.nativeCreated, '-Image', app.exe];
  if (close) return script(windowScript, [...args, '-CloseWindow', app.window.hwnd]);
  return JSON.parse(await script(windowScript, args));
}

async function ready(app, model, homeRoot, previousHomes) {
  const runtimeFile = path.join(app.data, 'runtime.json');
  const runtime = await until('desktop service startup', 45000, () => {
    running(app);
    return fs.existsSync(runtimeFile) && JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  });
  assert.equal(runtime.host, '127.0.0.1');
  assert.ok(Number.isSafeInteger(runtime.pid) && runtime.pid > 0);
  await until('real model warmup', 30000, async deadline => {
    running(app);
    return await status(runtime, Math.max(1, deadline - Date.now())) === 'ready';
  });
  const serviceRows = await processRows([runtime.pid], runtime.pid);
  const service = serviceRows.find(row => row.pid === runtime.pid);
  assert.equal(service?.parent, app.child.pid, 'runtime belongs to this desktop');
  assert.equal(service.image.toLowerCase(), path.join(path.dirname(app.exe), 'runtime/node/node.exe').toLowerCase());
  const expected = fixedSpawnCommandLine(model.node.file, [model.workerFile]).toLowerCase();
  const workers = serviceRows.filter(row => row.parent === runtime.pid &&
    row.image?.toLowerCase() === model.node.file.toLowerCase() && row.commandLine.toLowerCase() === expected);
  assert.equal(workers.length, 1, 'exact pinned Gemma worker is a child of the owned service');

  const ownerPid = app.child.pid;
  // WebView2 appends its own EBWebView directory to the shell's userDataFolder.
  const webProfile = path.join(app.data, 'desktop/EBWebView/EBWebView').toLowerCase();
  const { owner, browser } = await until('owned WebView browser', 30000, async () => {
    running(app);
    const rows = await processRows([ownerPid], ownerPid);
    const owner = rows.find(row => row.pid === ownerPid);
    assert.equal(owner?.image.toLowerCase(), app.exe.toLowerCase());
    assert.equal(owner.parent, process.pid);
    const browsers = rows.filter(row => row.parent === ownerPid && path.basename(row.image || '').toLowerCase() === 'msedgewebview2.exe' &&
      [...row.commandLine.matchAll(/--user-data-dir=(?:"([^"]+)"|(\S+))/gi)].some(match =>
        (match[1] || match[2]).toLowerCase() === webProfile));
    assert.ok(browsers.length <= 1, 'unique WebView browser on this private profile');
    return browsers.length && { owner, browser: browsers[0] };
  });
  app.nativeCreated = owner.nativeCreated;
  app.window = await until('visible workbench document in the production window', 30000, async () => {
    running(app);
    const win = await windowInfo(app);
    return win.hwnd !== '0' && win.title.endsWith('Ruyi Workbench') &&
      win.documents.some(doc => /Ruyi Workbench|如意工作台/i.test(doc.name) && doc.origin === 'http://127.0.0.1:' + runtime.port) && win;
  });
  const homes = fs.readdirSync(homeRoot).filter(name => !previousHomes.includes(name));
  assert.equal(homes.length, 1);
  app.home = homes[0];
  app.runtime = runtime;
  app.originals = [owner, service, workers[0], browser].map(processIdentity);
}

async function stop(app, abrupt, homeRoot) {
  running(app);
  if (abrupt) assert.ok(app.child.kill(), 'terminate only the originally launched desktop');
  else await windowInfo(app, true);
  const exit = await until('desktop exit', 60000, () => app.exit);
  assert.deepEqual(exit, abrupt ? { code: null, signal: 'SIGTERM' } : { code: 0, signal: null });
  await until('original desktop, service, model and WebView browser exit', 20000, async () => {
    const rows = await processRows(app.originals.map(row => row.pid));
    return app.originals.every(original => !rows.some(row => sameProcess(row, original)));
  });
  const homeRetained = fs.existsSync(path.join(homeRoot, app.home));
  if (!abrupt) assert.equal(homeRetained, false, 'graceful shutdown removes its private model home');
  return { exit, homeRetained };
}

async function verifyActive(app, homeRoot) {
  running(app);
  assert.equal(await status(app.runtime, 5000), 'ready', 'original listener reports ready on its first sample');
  const rows = await processRows(app.originals.map(row => row.pid));
  assert.ok(app.originals.every(original => rows.some(row => sameProcess(row, original))));
  assert.deepEqual(await windowInfo(app), app.window, 'same window and loaded document');
  assert.ok(fs.existsSync(path.join(homeRoot, app.home)), 'original private model home still present');
}

async function run({ workbench, dual, ownerExit, resources }) {
  const source = process.env.RUYI_TEST_GEMMA2_ROOT;
  assert.ok(source && path.isAbsolute(source), 'RUYI_TEST_GEMMA2_ROOT must be an absolute verified profile');
  const lock = fs.readFileSync(path.join(source, 'asset-lock.json'));
  const model = JSON.parse(lock), lockHash = createHash('sha256').update(lock).digest('hex');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-desktop-app-'));
  console.log('Desktop application evidence: ' + dir);
  const profile = path.join(dir, 'model'), homeRoot = path.join(profile, 'resident-homes');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'asset-lock.json'), lock);
  const exe = await build(workbench, path.join(dir, 'package'));
  const apps = [];
  const evidence = { exeSha256: createHash('sha256').update(fs.readFileSync(exe)).digest('hex'), dual, ownerExit, apps: [] };
  const record = () => fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n');
  try {
    for (const name of dual ? ['A', 'B'] : ['A']) {
      const previousHomes = apps.map(app => app.home);
      const app = launch(path.join(dir, name), exe, profile, lockHash);
      apps.push(app);
      await ready(app, model, homeRoot, previousHomes);
      evidence.apps.push({ name, port: app.runtime.port, window: app.window, originals: app.originals, modelHome: app.home });
      record();
    }
    const [a, b] = apps;
    if (dual) {
      assert.notEqual(a.window.hwnd, b.window.hwnd);
      assert.notEqual(a.runtime.port, b.runtime.port);
      assert.ok(a.runtime.token !== b.runtime.token);
      assert.equal(new Set(apps.flatMap(app => app.originals.map(row => row.pid))).size, 8);
    }
    await verifyActive(a, homeRoot);
    const observed = new Map();
    const resourceScript = path.resolve(__dirname, '../fixtures/desktop-resource-snapshot.ps1');
    if (resources) {
      const { sampleTree } = require('./desktop-resource-samples.cjs');
      evidence.resources = {
        scope: 'Single warmed desktop and creation-bound descendants present at the sample times',
        workingSet: 'Sum of per-process resident bytes; shared pages can be counted in several processes',
        privateCommit: 'Sum of per-process private committed bytes',
        cpu: 'Cumulative user and kernel time in 100ns ticks for each sampled process',
        availablePhysical: 'System-wide available bytes sampled immediately after the process counter collection',
        samples: []
      };
      const samples = evidence.resources.samples;
      // No UI, status or model request is made during this idle window.
      for (let i = 0; i < 3; i++) {
        if (i) await delay(33000);
        running(a);
        const snapshot = JSON.parse(await script(resourceScript));
        samples.push(sampleTree(snapshot, a.originals, observed));
        record();
      }
      evidence.resources.idleWindowMs = Number(BigInt(samples[2].tick) - BigInt(samples[0].tick)) / 10000;
      assert.ok(evidence.resources.idleWindowMs >= 65000, 'at least 65s between counter samples');
      await verifyActive(a, homeRoot);
    }
    evidence.apps[0].closed = await stop(a, ownerExit, homeRoot);
    if (resources) {
      const verified = await until('all sampled desktop descendants exit', 20000, async () => {
        // Confirm disappearance via Win32_Process independently of the PerfProc sampler.
        const pids = [...new Set([process.pid, ...Array.from(observed.values(), row => row.pid)])];
        const live = await processRows(pids);
        assert.ok(live.some(row => row.pid === process.pid), 'closure query includes its live controller');
        const remaining = [...observed.values()].some(row => live.some(current =>
          current.pid === row.pid && BigInt(current.created) === BigInt(row.born) / 10n * 10n));
        return !remaining && { sampledUtc: new Date().toISOString(), exitedIdentities: observed.size };
      });
      evidence.apps[0].closed.resourceTree = verified;
    }
    record();
    if (dual) {
      await verifyActive(b, homeRoot);
      evidence.survivorReady = true;
      evidence.apps[1].closed = await stop(b, false, homeRoot);
    }
    assert.deepEqual(fs.readdirSync(homeRoot), evidence.apps[0].closed.homeRetained ? [a.home] : []);
    record();
    // Keep the receipt and model-home evidence. The private install and per-window
    // profiles (including service tokens) are only useful when the run fails.
    const root = fs.realpathSync(dir);
    for (const item of [path.dirname(exe), ...apps.map(app => path.dirname(app.data))]) {
      assert.equal(path.dirname(fs.realpathSync(item)), root, 'cleanup is confined to the fixture root');
      fs.rmSync(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  } catch (error) {
    evidence.failure = error.message;
    // Every reference is our own direct ChildProcess. Never target a PID discovered during observation.
    const stops = await Promise.allSettled(apps.map(async app => {
      if (app.exit || !app.child.pid) return;
      if (app.child.exitCode === null && app.child.signalCode === null && !app.child.kill()) {
        throw Error('Could not terminate fixture desktop ' + app.child.pid);
      }
      await until('fixture desktop ' + app.child.pid + ' close', 15000, () => app.exit);
    }));
    evidence.cleanupFailures = stops.filter(stop => stop.status === 'rejected').map(stop => stop.reason.message);
    for (const message of evidence.cleanupFailures) console.error(message);
    try { record(); }
    catch (writeError) { console.error('Could not save desktop failure receipt: ' + writeError.message); }
    throw error;
  }
}

module.exports = { run };

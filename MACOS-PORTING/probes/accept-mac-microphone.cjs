'use strict';
// Authorized physical microphone UI acceptance. Recording starts only from the normal
// composer button. All audio stays in this fixture and its loopback fake ASR provider.
require('../../dev-harness/lib/self-isolate-home');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { fixtureChildEnv } = require('../../dev-harness/lib/fixture-home');
const { killOwnTree, snapshotProcessTable } = require('../../dev-harness/lib/kill-own-tree');
const { startFakeProvider } = require('../../dev-harness/lib/fake-openai-provider');
const wb = path.resolve(__dirname, '../../ruyi-workbench');

async function installPhysicalCaptureMonitor() {
  const devices = navigator.mediaDevices;
  const original = devices.getUserMedia;
  const originalFetch = window.fetch;
  const trace = { requests: [], uploads: [], sends: 0,
    supportedTypes: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
      .filter(type => MediaRecorder.isTypeSupported(type)) };
  let closed = false;
  let pending = 0;
  // Retain MediaDevices while its native method is instrumented, as in media e2e.
  window.__physicalCaptureMonitor = { devices, original, trace };
  const output = document.createElement('output');
  output.style.cssText = 'display:block;max-width:80vw;white-space:pre-wrap';
  const finish = document.createElement('button');
  finish.textContent = '完成短录音验收';
  const render = () => {
    output.textContent = JSON.stringify(trace);
    const phase = document.getElementById('composerVoiceBtn')?.dataset.state;
    finish.disabled = pending > 0 || !trace.requests.length
      || !['idle', 'error'].includes(phase)
      || trace.requests.some(record => record.state === 'requesting' || record.state === 'capturing');
  };
  devices.getUserMedia = async function (constraints) {
    // Retry refused permission, but allow only one successful capture. WebKit can
    // retain its reported active state after stopping, before a new KVO edge exists.
    if (closed || trace.requests.some(record => record.state !== 'rejected')) {
      throw new DOMException('Acceptance capture already requested', 'AbortError');
    }
    const record = { constraints, state: 'requesting', requestedAtUnixMs: Date.now() };
    trace.requests.push(record);
    pending++;
    render();
    let stream;
    let normalStop;
    let releaseStop;
    let trackWatch;
    const release = () => {
      clearTimeout(normalStop);
      clearTimeout(releaseStop);
      clearInterval(trackWatch);
    };
    try {
      // Native capture-state observation enforces the independent deadline.
      record.nativeRequested = true;
      stream = await original.call(devices, constraints);
      const started = performance.now();
      record.resolvedAtUnixMs = Date.now();
      record.state = 'capturing';
      record.stops = [];
      // Arrange release before any instrumentation that could throw.
      normalStop = setTimeout(() => {
        const button = document.getElementById('composerVoiceBtn');
        if (button?.getAttribute('aria-pressed') === 'true') button.click();
      }, 1100);
      releaseStop = setTimeout(() => stream.getTracks().forEach(track => track.stop()), 1300);
      trackWatch = setInterval(() => {
        if (!stream.getTracks().every(track => track.readyState === 'ended')) return;
        record.stops.push(performance.now() - started);
        record.releasedAtUnixMs = Date.now();
        record.state = 'released';
        release();
        render();
      }, 20);
      render();
      return stream;
    } catch (error) {
      if (stream) stream.getTracks().forEach(track => track.stop());
      release();
      record.state = 'rejected';
      record.error = error.name;
      record.message = error.message;
      render();
      throw error;
    } finally {
      pending--;
      render();
    }
  };
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    if (/\/api\/(chat\/stream|steer|steward\/(message|act))/.test(url)) trace.sends++;
    if (url.startsWith('/api/audio/transcribe')) {
      pending++;
      render();
      return originalFetch.call(this, input, init).then(response => {
        trace.uploads.push({ ok: response.ok, status: response.status });
        return response;
      }).finally(() => { pending--; render(); });
    }
    return originalFetch.call(this, input, init);
  };
  const bar = document.createElement('section');
  bar.style.cssText = 'position:fixed;top:72px;left:12px;z-index:99999;background:#202b42;color:white;padding:12px';
  bar.append(finish, output);
  document.body.append(bar);
  const phaseWatch = setInterval(render, 100);
  render();
  await new Promise(resolve => { finish.onclick = resolve; });
  closed = true;
  clearInterval(phaseWatch);
  window.dispatchEvent(new Event('ruyi:host-suspend'));
  const button = document.getElementById('composerVoiceBtn');
  for (const id of ['composerVoiceBtn', 'stewardComposerVoice']) {
    const microphone = document.getElementById(id);
    if (microphone) microphone.disabled = true;
  }
  devices.getUserMedia = original;
  window.fetch = originalFetch;
  trace.input = document.getElementById('promptInput')?.value;
  trace.buttonState = button?.dataset.state;
  const completed = trace.requests.filter(record => record.state === 'released');
  trace.passed = pending === 0 && trace.buttonState === 'idle' && completed.length > 0 && trace.sends === 0
    && completed.every(record => record.stops.length > 0 && record.stops.every(ms => ms > 0 && ms <= 3000))
    && trace.uploads.length === completed.length && trace.uploads.every(upload => upload.ok)
    && String(trace.input).includes('P4 本机短录音验收完成');
  return trace;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-physical-microphone-'));
  const fixture = fixtureChildEnv({ perTest: true });
  const data = path.join(fixture.home, 'data');
  const workspace = path.join(fixture.home, '短录音工作区');
  for (const directory of [data, workspace]) fs.mkdirSync(directory);
  const uploads = [];
  const report = path.join(root, 'report.json');
  const bundle = path.join(wb, 'dist/Ruyi.app');
  const binary = path.join(bundle, 'Contents/MacOS/RuyiDesktop');
  let nativeOwner;
  let serviceOwner;
  function rememberOwners() {
    if (nativeOwner && serviceOwner) return;
    let nativePID;
    try { nativePID = JSON.parse(fs.readFileSync(report, 'utf8')).nativePID; } catch { return; }
    const table = snapshotProcessTable();
    const app = table?.find(row => row.pid === nativePID);
    if (!app) return;
    if (!nativeOwner) {
      const info = cp.spawnSync('/bin/ps', ['-p', String(nativePID), '-o', 'command='], { encoding: 'utf8' });
      if (!String(info.stdout || '').trim().startsWith(binary + ' --acceptance-report ' + report + ' ')) return;
      nativeOwner = app;
    }
    if (app.created !== nativeOwner.created) return;
    let servicePID;
    try { servicePID = JSON.parse(fs.readFileSync(path.join(data, 'runtime.json'), 'utf8')).pid; } catch { return; }
    const service = table.find(row => row.pid === servicePID);
    if (service?.ppid === nativeOwner.pid && service.created >= nativeOwner.created) serviceOwner = service;
  }
  function signalOwner(owner, signal) {
    if (!owner) return false;
    const before = snapshotProcessTable()?.find(row => row.pid === owner.pid);
    if (before?.created !== owner.created) return false;
    const current = snapshotProcessTable()?.find(row => row.pid === owner.pid);
    // LaunchServices reparents the App. Its unique report argv establishes ownership,
    // and the recorded child relationship establishes service ownership. Recheck each
    // creation identity before signalling either recorded process, including retries.
    if (current?.created !== owner.created) return false;
    try { process.kill(owner.pid, signal); return true; } catch { return false; }
  }
  async function waitForOwners(timeoutMs) {
    if (!nativeOwner) return false;
    const end = Date.now() + timeoutMs;
    do {
      const table = snapshotProcessTable();
      if (table && [nativeOwner, serviceOwner].filter(Boolean)
        .every(owner => !table.some(row => row.pid === owner.pid && row.created === owner.created))) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < end);
    return false;
  }
  let provider;
  let child;
  let timer;
  try {
    const build = JSON.parse(fs.readFileSync(path.join(bundle, 'Contents/Resources/build.json'), 'utf8'));
    const sourceFiles = [...Object.keys(build.sourceFingerprint).map(file => path.join(wb, file)),
      __filename, path.join(wb, 'app/server.js'), path.join(wb, 'app/public/js/composer-voice.js')];
    const fingerprints = Object.fromEntries(sourceFiles.map(file => [path.relative(wb, file),
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
    if (!Object.entries(build.sourceFingerprint).every(([file, digest]) => fingerprints[file] === digest)) {
      throw new Error('Rebuild the development App before physical acceptance');
    }
    fs.writeFileSync(path.join(root, 'native-build.json'), JSON.stringify(build, null, 2));
    fs.writeFileSync(path.join(root, 'source-fingerprint.json'), JSON.stringify(fingerprints, null, 2));
    provider = await startFakeProvider({ fallback(request, response) {
      if (request.method !== 'POST' || !request.url.endsWith('/audio/transcriptions')) {
        response.writeHead(404); response.end(); return;
      }
      (async () => {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) throw new Error('Physical fixture upload exceeded limit');
          chunks.push(chunk);
        }
        const form = await new Response(Buffer.concat(chunks), { headers: {
          'content-type': request.headers['content-type'],
        } }).formData();
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Missing recorded audio');
        const bytes = Buffer.from(await file.arrayBuffer());
        const pcmBytes = bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF'
          && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.toString('ascii', 12, 16) === 'fmt '
          && bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1
          && bytes.readUInt16LE(22) === 1 && bytes.readUInt32LE(24) === 16000
          && bytes.readUInt16LE(32) === 2 && bytes.readUInt16LE(34) === 16
          && bytes.toString('ascii', 36, 40) === 'data'
          && bytes.readUInt32LE(4) === bytes.length - 8
          && bytes.readUInt32LE(40) === bytes.length - 44 ? bytes.length - 44 : 0;
        const durationMs = pcmBytes / 32;
        const validPcm = pcmBytes > 0 && pcmBytes % 2 === 0 && durationMs <= 3000;
        const target = path.join(root, 'capture-' + (uploads.length + 1) + '-' + path.basename(file.name));
        fs.writeFileSync(target, bytes);
        uploads.push({ file: target, mime: file.type, bytes: bytes.length, validPcm, durationMs,
          nonzeroSignal: validPcm && bytes.subarray(44).some(value => value !== 0),
          sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ text: 'P4 本机短录音验收完成' }));
      })().catch(error => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error.message }));
      });
    } });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: require(path.join(wb, 'app/server')).CONFIG_SCHEMA,
      defaultWorkspace: workspace, workspaces: [{ path: workspace }],
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
      onboarding: { completedAt: '2026-11-08T00:00:00Z', version: 1, skipped: false },
      providers: [{ id: 'physical-fixture', name: 'Loopback fake ASR', baseUrl: provider.url + '/v1',
        apiKey: 'fixture-only', models: [{ id: 'fixture-asr', caps: ['asr'] }] }],
      asrProviderId: 'physical-fixture', asrModel: 'fixture-asr', asrFixMode: 'off',
    }));
    const script = path.join(root, 'monitor.js');
    fs.writeFileSync(script, 'return await (' + installPhysicalCaptureMonitor.toString() + ')();');
    const launchEnvironment = { HOME: fixture.home, USERPROFILE: fixture.home,
      LOCALAPPDATA: fixture.env.LOCALAPPDATA, APPDATA: fixture.env.APPDATA,
      RUYI_HOME: data, RUYI_NODE_PATH: process.execPath, PATH: '/usr/bin:/bin' };
    const launchArgs = ['-n', '-W', '-a', bundle,
      ...Object.entries(launchEnvironment).flatMap(([key, value]) => ['--env', key + '=' + value]),
      '--args', '--acceptance-report', report, '--acceptance-script', script,
      '--acceptance-auto-quit', '--acceptance-microphone-deadline'];
    child = cp.spawn('/usr/bin/open', launchArgs, {
        env: { ...process.env, ...fixture.env, RUYI_HOME: data, RUYI_NODE_PATH: process.execPath },
        cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      });
    console.log('Physical microphone fixture ' + root);
    child.stderr.on('data', value => process.stderr.write(value));
    let quitting = false;
    timer = setInterval(() => {
      rememberOwners();
      if (fs.existsSync(report)) fs.writeFileSync(path.join(root, 'uploads.json'), JSON.stringify(uploads, null, 2));
      if (!quitting && fs.existsSync(path.join(root, 'quit.txt'))) quitting = signalOwner(nativeOwner, 'SIGTERM');
    }, 100);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    fs.writeFileSync(path.join(root, 'uploads.json'), JSON.stringify(uploads, null, 2));
    const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
    const nativeDurations = (result?.microphoneCaptureEvents || []).filter(event => typeof event.observedDurationMs === 'number');
    const nativeStops = (result?.microphoneCaptureEvents || []).filter(event => event.action === 'tracks_released_stop_completed');
    const passed = result?.page?.additional?.passed === true && uploads.length > 0
      && result.microphoneCaptureLimitFired === false && result.microphoneCaptureStopping === false
      && result.microphoneCaptureState === 0 && nativeDurations.length > 0
      && result.microphoneCaptureEvents.some(event => event.state === 1)
      && nativeDurations.every(event => event.observedDurationMs > 0)
      && nativeStops.length === uploads.length
      && nativeStops.every(event => event.elapsedMs > 0 && event.elapsedMs <= 3000)
      && uploads.length === result.page.additional.uploads.length
      && uploads.every(upload => upload.validPcm && upload.nonzeroSignal);
    console.log(JSON.stringify({ ...exit, passed, nativeDurations, nativeStops, uploads }));
    process.exitCode = exit.code === 0 && passed ? 0 : 1;
  } finally {
    clearInterval(timer);
    rememberOwners();
    const ownerDeadline = Date.now() + 2000;
    while (!nativeOwner && Date.now() < ownerDeadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      rememberOwners();
    }
    signalOwner(nativeOwner, 'SIGTERM');
    let complete = await waitForOwners(10000);
    if (!complete && nativeOwner) {
      signalOwner(nativeOwner, 'SIGKILL');
      signalOwner(serviceOwner, 'SIGTERM');
      complete = await waitForOwners(8500);
    }
    if (!complete && nativeOwner) {
      signalOwner(serviceOwner, 'SIGKILL');
      complete = await waitForOwners(1000);
    }
    fs.writeFileSync(path.join(root, 'cleanup.json'), JSON.stringify({
      complete, scope: nativeOwner ? 'tracked-processes' : 'not_verified',
      nativePID: nativeOwner?.pid, servicePID: serviceOwner?.pid,
    }, null, 2));
    await killOwnTree(child);
    if (provider) await provider.close();
    if (!complete) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

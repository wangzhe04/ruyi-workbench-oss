'use strict';
require('./lib/self-isolate-home.js');
// Actual WKWebView media recording using an oscillator, never the physical microphone.
// Physical permission recovery and the authorized <=3s microphone check are separate UI gates.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { startFakeProvider } = require('./lib/fake-openai-provider');
const { buildMacDesktop } = require('../ruyi-workbench/tools/build-macos-desktop');
const t = createRunner('MACOS DESKTOP MEDIA');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-native-media-'));
const wb = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child;
let provider;
async function until(fn, timeout = 90000) {
  const end = Date.now() + timeout;
  do { if (await fn()) return; await sleep(80); } while (Date.now() < end);
  throw new Error('Media acceptance timed out');
}
function pcmRms(bytes) {
  let squared = 0;
  const count = Math.floor(bytes.length / 2);
  for (let index = 0; index < count; index++) squared += (bytes.readInt16LE(index * 2) / 32768) ** 2;
  return Math.sqrt(squared / Math.max(1, count));
}

// Serialized into the actual WKWebView by the native acceptance inspector.
async function nativeMediaChecks() {
  const voice = await import('/js/composer-voice.js');
  const net = await import('/js/net.js');
  const { state } = await import('/js/state.js');
  const assertions = [];
  let stage = 'initializing';
  const check = (value, label) => assertions.push({ ok: Boolean(value), label });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitForPhase(predicate) {
    const end = Date.now() + 12000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('media phase timeout ' + JSON.stringify({
        stage, phase: handle.phase(), text: input.value, requests, notes, captures: captures.length,
        asrStream: state.config.asrStreamProviderId, asr: state.config.asrProviderId,
      }));
      await wait(30);
    }
  }
  const NativeRecorder = globalThis.MediaRecorder;
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const supported = types.filter(type => NativeRecorder.isTypeSupported(type));
  check(voice.composerVoiceCapable() && supported.length > 0, 'real WKWebView supports a known recording container');
  check(NativeRecorder.isTypeSupported('audio/mp4'), 'real WKWebView supports MP4/AAC fallback');
  function Mp4Recorder(stream, options) { return new NativeRecorder(stream, options); }
  Mp4Recorder.isTypeSupported = type => type === 'audio/mp4' && NativeRecorder.isTypeSupported(type);
  globalThis.MediaRecorder = Mp4Recorder;
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const context = new Ctx();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  const mediaDevices = navigator.mediaDevices;
  const originalMedia = mediaDevices.getUserMedia;
  const captures = [];
  let denied = false;
  const syntheticMedia = async () => {
    if (denied) throw new DOMException('fixture refusal', 'NotAllowedError');
    const stream = destination.stream.clone();
    captures.push(stream);
    return stream;
  };
  mediaDevices.getUserMedia = syntheticMedia;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;background:white';
  const input = document.createElement('textarea');
  const anchor = document.createElement('button');
  host.append(input, anchor);
  document.body.append(host);
  const requests = [];
  const notes = [];
  let openGate = null;
  let lateDeletes = 0;
  const lateStreamId = 'a'.repeat(32);
  const handle = voice.createComposerVoice({ state, input: () => input, anchor: () => anchor,
    notify: text => notes.push(text),
    request: async (url, options) => {
      if (url === '/api/audio/stream/sessions' && openGate) return openGate.promise;
      if (url === '/api/audio/stream/sessions/' + lateStreamId && options.method === 'DELETE') {
        lateDeletes += 1;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('/api/audio/transcribe')) {
        requests.push({ url, type: options.headers['content-type'], bytes: options.body.size });
      }
      return net.apiRaw(url, options);
    },
  });
  handle.sync();
  const button = host.querySelector('.composer-voice');
  function reset() { input.value = '前缀后缀'; input.setSelectionRange(2, 2); }
  async function record() {
    stage = 'record start ' + captures.length;
    if (navigator.mediaDevices.getUserMedia !== syntheticMedia) throw new Error('synthetic media override was lost');
    reset();
    button.click();
    await waitForPhase(() => handle.phase() === 'recording' || handle.phase() === 'error');
    check(handle.phase() === 'recording', 'normal composer starts actual MP4 MediaRecorder');
    if (handle.phase() !== 'recording') return;
    await wait(1100);
    stage = 'record stop ' + captures.length + ' phase ' + handle.phase();
    button.click();
    await waitForPhase(() => handle.phase() === 'idle' || handle.phase() === 'error');
  }
  try {
    await record();
    check(input.value === '前缀P4媒体转写后缀', 'actual MP4 recording decodes to WAV and fills at the caret');
    check(requests[0]?.type === 'audio/wav' && requests[0]?.url.endsWith('voice.wav') && requests[0]?.bytes > 44,
      'normal MP4 path uploads nonempty WAV through the existing ASR endpoint');
    check(captures.at(-1).getTracks().every(track => track.readyState === 'ended'),
      'normal stop releases all synthetic capture tracks');
    const offline = globalThis.OfflineAudioContext;
    const webkitOffline = globalThis.webkitOfflineAudioContext;
    globalThis.OfflineAudioContext = undefined;
    globalThis.webkitOfflineAudioContext = undefined;
    try { await record(); }
    finally { globalThis.OfflineAudioContext = offline; globalThis.webkitOfflineAudioContext = webkitOffline; }
    check(requests[1]?.type === 'audio/mp4' && requests[1]?.url.endsWith('voice.m4a') && input.value === '前缀P4媒体转写后缀',
      'decode failure retains actual MP4 bytes, content type and m4a filename');
    const before = requests.length;
    denied = true;
    stage = 'denial';
    reset();
    button.click();
    await waitForPhase(() => handle.phase() === 'error');
    check(input.value === '前缀后缀' && requests.length === before && notes.at(-1) === 'composer.voice.error.deniedMac',
      'Mac refusal gives recovery guidance without upload or draft mutation');
    denied = false;
    await record();
    check(handle.phase() === 'idle' && requests.length === before + 1,
      'same composer retries successfully after microphone refusal');
    reset();
    button.click();
    await waitForPhase(() => handle.phase() === 'recording');
    handle.cancel();
    await wait(150);
    check(requests.length === before + 1 && captures.at(-1).getTracks().every(track => track.readyState === 'ended'),
      'cancel discards the current segment and releases capture tracks');

    const configured = await net.api('/api/config', { method: 'POST', body: JSON.stringify({
      asrStreamProviderId: 'p4-media', asrStreamModel: 'fixture-stream', asrFixMode: 'off',
    }) });
    state.config = configured.config;
    const NativeContext = globalThis.AudioContext;
    const contexts = [];
    function TrackedContext() {
      const audioContext = new NativeContext();
      contexts.push(audioContext);
      return audioContext;
    }
    globalThis.AudioContext = TrackedContext;
    try {
      reset();
      button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      await waitForPhase(() => input.value.includes('P4临时'));
      check(requests.length === before + 1, 'actual WebKit PCM streaming uses the stream transport without segment uploads');
      button.click();
      await waitForPhase(() => handle.phase() === 'idle');
      check(input.value === '前缀P4流式定稿后缀', 'real WebKit ScriptProcessor PCM reaches the loopback stream and finish fills the final text');
      check(contexts.every(audioContext => audioContext.state === 'closed')
        && captures.at(-1).getTracks().every(track => track.readyState === 'ended'),
        'stream finish closes AudioContext and stops capture tracks');
      reset();
      button.click();
      await waitForPhase(() => input.value.includes('P4临时'));
      handle.cancel();
      await wait(150);
      check(input.value === '前缀后缀' && contexts.every(audioContext => audioContext.state === 'closed'),
        'stream cancellation removes pending text and closes its audio context');

      function FailingContext() {
        const audioContext = new TrackedContext();
        audioContext.createScriptProcessor = () => { throw new Error('fixture processor failure'); };
        audioContext.createAnalyser = () => { throw new Error('fixture analyser failure'); };
        return audioContext;
      }
      globalThis.AudioContext = FailingContext;
      reset();
      button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      handle.cancel();
      await waitForPhase(() => contexts.every(audioContext => audioContext.state === 'closed'));
      check(notes.includes('composer.voice.error.streamFallback'), 'stream initialization failure falls back to segment recording');
      check(contexts.every(audioContext => audioContext.state === 'closed'),
        'failed stream and VAD initialization close all partially built AudioContexts');
    } finally { globalThis.AudioContext = NativeContext; }

    const segmentConfig = await net.api('/api/config', { method: 'POST', body: JSON.stringify({
      asrStreamProviderId: '', asrStreamModel: '',
    }) });
    state.config = segmentConfig.config;
    const NativeOffline = globalThis.OfflineAudioContext;
    const analyserPrototype = globalThis.AnalyserNode.prototype;
    const originalAnalyse = analyserPrototype.getFloatTimeDomainData;
    const originalNow = performance.now.bind(performance);
    let offset = 0;
    let releaseDecode;
    function DelayedOffline(...args) {
      const offlineContext = new NativeOffline(...args);
      const decode = offlineContext.decodeAudioData.bind(offlineContext);
      offlineContext.decodeAudioData = bytes => new Promise((resolve, reject) => {
        releaseDecode = () => decode(bytes).then(resolve, reject);
      });
      return offlineContext;
    }
    globalThis.OfflineAudioContext = DelayedOffline;
    analyserPrototype.getFloatTimeDomainData = samples => samples.fill(0.5);
    performance.now = () => originalNow() + offset;
    try {
      stage = 'cancel during decode';
      reset();
      button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      await wait(1100);
      offset = voice.COMPOSER_VOICE_SEGMENT_MAX_MS + 1000;
      await waitForPhase(() => Boolean(releaseDecode));
      check(handle.phase() === 'recording', 'continuous speech crosses the maximum segment duration without stopping capture');
      handle.cancel();
      await releaseDecode();
      await wait(200);
      check(requests.length === before + 1 && input.value === '前缀后缀',
        'cancel during segment decode prevents a later ASR upload');
    } finally {
      analyserPrototype.getFloatTimeDomainData = originalAnalyse;
      performance.now = originalNow;
      globalThis.OfflineAudioContext = NativeOffline;
    }

    releaseDecode = null;
    globalThis.OfflineAudioContext = DelayedOffline;
    try {
      stage = 'suspend while transcribing';
      reset(); button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      await wait(1100);
      button.click();
      await waitForPhase(() => Boolean(releaseDecode));
      globalThis.dispatchEvent(new Event('ruyi:host-suspend'));
      await releaseDecode(); await wait(150);
      check(handle.phase() === 'idle' && requests.length === before + 1 && input.value === '前缀后缀',
        'host suspension during final decode discards pending transcription without upload or draft mutation');
    } finally { globalThis.OfflineAudioContext = NativeOffline; }

    const pendingStops = [];
    function DelayedStopRecorder(stream, options) {
      const next = new NativeRecorder(stream, options);
      const add = next.addEventListener.bind(next);
      next.addEventListener = (name, listener, options) => {
        if (name === 'stop') add(name, event => pendingStops.push(() => listener.call(next, event)), options);
        else add(name, listener, options);
      };
      return next;
    }
    DelayedStopRecorder.isTypeSupported = Mp4Recorder.isTypeSupported;
    globalThis.MediaRecorder = DelayedStopRecorder;
    try {
      stage = 'late recorder stop';
      reset(); button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      handle.cancel();
      await waitForPhase(() => pendingStops.length === 1);
      const oldStop = pendingStops.shift();
      button.click();
      await waitForPhase(() => handle.phase() === 'recording');
      const fresh = captures.at(-1);
      oldStop(); await wait(50);
      check(handle.phase() === 'recording' && fresh.getTracks().every(track => track.readyState === 'live'),
        'a retired recorder stop event cannot close the next recording');
      handle.cancel();
      await waitForPhase(() => pendingStops.length === 1);
      pendingStops.shift()();
    } finally { globalThis.MediaRecorder = Mp4Recorder; }

    stage = 'late stream initialization';
    const streamConfig = state.config;
    let resolveOpen;
    openGate = { promise: new Promise(resolve => { resolveOpen = resolve; }) };
    state.config = { ...streamConfig, asrStreamProviderId: 'p4-media', asrStreamModel: 'fixture-stream' };
    const priorCaptures = captures.length;
    reset(); button.click();
    await waitForPhase(() => captures.length === priorCaptures + 1 && handle.phase() === 'starting');
    const pendingCapture = captures.at(-1);
    handle.cancel();
    check(pendingCapture.getTracks().every(track => track.readyState === 'ended'),
      'cancelling a suspended stream-open request immediately releases acquired microphone tracks');
    state.config = streamConfig;
    button.click();
    await waitForPhase(() => handle.phase() === 'recording');
    const newCapture = captures.at(-1);
    resolveOpen(new Response(JSON.stringify({ ok: true, id: lateStreamId }), { headers: { 'content-type': 'application/json' } }));
    openGate = null;
    await waitForPhase(() => lateDeletes === 1);
    check(handle.phase() === 'recording' && newCapture.getTracks().every(track => track.readyState === 'live'),
      'late stream initialization deletes only its own upstream session and preserves the new recording');
    handle.cancel();
  } finally {
    handle.cancel();
    mediaDevices.getUserMedia = originalMedia;
    globalThis.MediaRecorder = NativeRecorder;
    oscillator.stop();
    destination.stream.getTracks().forEach(track => track.stop());
    await context.close();
    host.remove();
  }
  return { assertions, supported, requests };
}

(async () => {
  try {
    const voice = require(path.join(wb, 'app/public/js/composer-voice.js'));
    const environment = types => ({ isSecureContext: true, navigator: { mediaDevices: { getUserMedia() {} } },
      MediaRecorder: { isTypeSupported: type => types.includes(type) } });
    ok(voice.composerVoiceRecordingType(environment(['audio/mp4', voice.COMPOSER_VOICE_MIME])) === voice.COMPOSER_VOICE_MIME,
      'existing WebM/Opus remains preferred when available');
    ok(voice.composerVoiceRecordingType(environment(['audio/mp4'])) === 'audio/mp4'
      && voice.composerVoiceCapable(environment(['audio/mp4'])), 'MP4-only WebKit can expose the normal microphone entry');
    ok(!voice.composerVoiceCapable(environment([])) && !voice.composerVoiceCapable({ ...environment(['audio/mp4']), isSecureContext: false }),
      'unsupported formats and insecure origins remain unavailable');
    if (process.platform !== 'darwin') { console.log('SKIP actual WKWebView media requires macOS'); return; }
    const uploads = [];
    const streamSessions = new Map();
    const streamEvents = [];
    const streamAudio = [];
    provider = await startFakeProvider({ fallback(req, res) {
      const streamRoute = req.url.match(/^\/v1\/stream\/sessions(?:\/([0-9a-f]{32})(?:\/(audio|finish))?)?$/);
      if (streamRoute) {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
          if (!streamRoute[1]) {
            const id = crypto.randomBytes(16).toString('hex');
            streamSessions.set(id, 0); streamEvents.push('open');
            json({ id, sampleRate: 16000 }); return;
          }
          const id = streamRoute[1];
          if (req.method === 'DELETE') {
            streamSessions.delete(id); streamEvents.push('delete');
            res.writeHead(204); res.end(); return;
          }
          const count = (streamSessions.get(id) || 0) + Buffer.concat(chunks).length;
          if (streamRoute[2] === 'audio') {
            streamAudio.push(Buffer.concat(chunks));
            streamSessions.set(id, count); streamEvents.push('audio');
            json({ partial: 'P4临时', finals: [] }); return;
          }
          streamSessions.delete(id); streamEvents.push('finish');
          json({ finals: [{ text: 'P4流式定稿', startMs: 0, endMs: Math.round(count / 32) }] });
        });
        return;
      }
      if (req.method !== 'POST' || !req.url.endsWith('/audio/transcriptions')) {
        res.writeHead(404); res.end(); return;
      }
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const bytes = Buffer.concat(chunks);
        uploads.push(bytes);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'P4媒体转写' }));
      });
    } });
    const fixture = fixtureChildEnv({ perTest: true });
    const data = path.join(fixture.home, 'data');
    const workspace = path.join(fixture.home, '媒体工作区');
    fs.mkdirSync(data); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      configSchema: require(path.join(wb, 'app/server')).CONFIG_SCHEMA, defaultWorkspace: workspace,
      workspaces: [{ path: workspace }], stewardEnabledV1: false, schedulerEnabledV1: false,
      autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
      providers: [{ id: 'p4-media', name: 'Loopback fixture', baseUrl: provider.url + '/v1', apiKey: 'fixture',
        models: [{ id: 'fixture-asr', caps: ['asr'] }, { id: 'fixture-stream', caps: ['asr-stream'] }] }],
      asrProviderId: 'p4-media', asrModel: 'fixture-asr', asrFixMode: 'off',
    }));
    const script = path.join(root, 'media.js');
    fs.writeFileSync(script, 'return await (' + nativeMediaChecks.toString() + ')();');
    const bundle = process.env.RUYI_DESKTOP_TEST_APP || buildMacDesktop(path.join(root, '媒体验收.app'));
    const report = path.join(root, 'report.json');
    child = cp.spawn(path.join(bundle, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report,
      '--acceptance-script', script, '--acceptance-auto-quit'], {
      env: { ...process.env, ...fixture.env, RUYI_HOME: data, RUYI_NODE_PATH: process.execPath }, cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', value => { output = (output + value).slice(-8000); });
    await until(() => child.exitCode !== null || child.signalCode !== null);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    ok(child.exitCode === 0 && result.state === 'ready', 'native media acceptance exits normally ' + JSON.stringify(result.state) + output);
    const checks = result.page?.additional?.assertions || [];
    for (const assertion of checks) ok(assertion.ok, assertion.label);
    ok(checks.length >= 24, 'native media acceptance returned all required assertions');
    console.log('ASR fixture uploads ' + JSON.stringify(uploads.map(bytes => ({
      filename: bytes.toString('latin1').match(/filename="([^"]+)"/)?.[1], bytes: bytes.length,
      mp4: bytes.includes(Buffer.from('ftyp')),
    }))));
    ok(uploads.length === 3, 'only three completed recordings reach the loopback ASR provider (received ' + uploads.length + ')');
    const wav = uploads[0];
    const riff = wav?.indexOf(Buffer.from('RIFF')) ?? -1;
    ok(riff >= 0 && wav.toString('ascii', riff + 8, riff + 12) === 'WAVE'
      && wav.readUInt16LE(riff + 22) === 1 && wav.readUInt32LE(riff + 24) === 16000
      && wav.readUInt16LE(riff + 34) === 16, 'loopback provider receives real 16kHz mono 16-bit WAV');
    const wavSamples = riff >= 0 ? wav.subarray(riff + 44, riff + 44 + wav.readUInt32LE(riff + 40)) : Buffer.alloc(0);
    ok(pcmRms(wavSamples) > 0.01, 'decoded WAV contains the non-silent synthetic signal');
    ok(uploads[1]?.includes(Buffer.from('ftyp')) && uploads[1]?.includes(Buffer.from('filename="voice.m4a"')),
      'fallback multipart contains actual MP4 container bytes and matching filename');
    ok(streamEvents.includes('audio') && streamEvents.filter(event => event === 'finish').length === 1,
      'actual WebKit PCM blocks and finalization reach the loopback streaming provider');
    ok(pcmRms(Buffer.concat(streamAudio)) > 0.01, 'stream PCM contains the non-silent synthetic signal');
    ok(streamSessions.size === 0 && streamEvents.filter(event => event === 'delete').length === 2,
      'stream cancel and initialization failure delete their upstream sessions');
    console.log('Native media reports ' + root);
  } finally { await killOwnTree(child); if (provider) await provider.close(); }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());

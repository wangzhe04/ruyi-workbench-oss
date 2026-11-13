'use strict';
require('./lib/self-isolate-home.js');
// Native lifecycle signals simulate the NSWorkspace callbacks. The backend is actually
// SIGSTOP/SIGCONT suspended. Physical system sleep and real login registration are UI gates.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { buildMacDesktop } = require('../ruyi-workbench/tools/build-macos-desktop');
const t = createRunner('MACOS DESKTOP LIFECYCLE');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-desktop-lifecycle-'));
const wb = path.resolve(__dirname, '../ruyi-workbench');
const children = [];
let pausedService;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await sleep(50); } while (Date.now() < deadline);
  throw new Error('Lifecycle condition timed out');
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function identity(pid) { return snapshotProcessTable()?.find(row => row.pid === pid); }
function sameProcess(record) {
  const current = record && identity(record.pid);
  return current && current.created === record.created;
}
function resumeOwnedService() {
  if (sameProcess(pausedService)) process.kill(pausedService.pid, 'SIGCONT');
  pausedService = null;
}
function treeFixture(name, main) {
  const pidFile = path.join(root, name + '.json');
  const descendantPidFile = path.join(root, name + '-descendant.json');
  const descendant = path.join(root, name + '-descendant.cjs');
  const wrapper = path.join(root, name + '.cjs');
  // Bounded fixture lifetime also recovers a failed cleanup assertion without targeting
  // detached PIDs. The cleanup assertions below have a shorter 15-second deadline.
  fs.writeFileSync(descendant, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(descendantPidFile)}, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(0), 60000);
`);
  fs.writeFileSync(wrapper, `const cp = require('node:child_process');
const fs = require('node:fs');
const child = cp.spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, ppid: process.ppid, child: child.pid }));
setTimeout(() => process.exit(0), 60000).unref();
${main}`);
  return { wrapper, pidFile, descendantPidFile };
}

async function lifecyclePage(finishOnSuspend = false) {
  const { createComposerVoice } = await import('/js/composer-voice.js');
  const { createEventStream } = await import('/js/event-stream.js');
  const net = await import('/js/net.js');
  const { state } = await import('/js/state.js');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const context = new AudioContext();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  oscillator.connect(destination);
  oscillator.start();
  const mediaDevices = navigator.mediaDevices;
  const originalMedia = mediaDevices.getUserMedia;
  const streams = [];
  let releasePending;
  let cancelledBeforeRelease = false;
  mediaDevices.getUserMedia = async () => {
    const stream = destination.stream.clone();
    streams.push(stream);
    if (streams.length === 2) await new Promise(resolve => { releasePending = resolve; });
    return stream;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;background:white';
  document.body.append(host);
  const voices = [];
  const inputs = [];
  let uploads = 0;
  for (let index = 0; index < 2; index++) {
    const input = document.createElement('textarea'); input.value = 'P4 未发送草稿';
    const anchor = document.createElement('button'); host.append(input, anchor); inputs.push(input);
    const voice = createComposerVoice({ state, input: () => input, anchor: () => anchor, notify() {},
      request: async () => { uploads += 1; return new Response('{}', { status: 500 }); },
    });
    voice.sync(); voices.push(voice);
  }
  let aborts = 0;
  const cursors = [];
  const client = createEventStream({
    requestImpl: async (url, options) => {
      cursors.push(options.headers['last-event-id'] || '');
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('id: p4:1\nevent: fixture\ndata: {}\n\n'));
        options.signal.addEventListener('abort', () => {
          aborts += 1; controller.error(new DOMException('fixture stop', 'AbortError'));
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  client.start();
  const buttons = host.querySelectorAll('.composer-voice');
  globalThis.addEventListener('ruyi:host-suspend', () => {
    cancelledBeforeRelease = voices[1].phase() === 'idle';
    setTimeout(() => releasePending(), 50);
  }, { once: true });
  buttons[0].click();
  const deadline = Date.now() + 10000;
  while (voices[0].phase() !== 'recording' || client.stats().lastEventId !== 'p4:1') {
    if (Date.now() > deadline) throw new Error('synthetic lifecycle setup failed');
    await wait(25);
  }
  buttons[1].click();
  globalThis.addEventListener(finishOnSuspend ? 'ruyi:host-suspend' : 'ruyi:host-wake', async () => {
    await wait(300);
    const snapshot = {
      ended: streams[0].getTracks().every(track => track.readyState === 'ended'),
      late: streams[1].getTracks().every(track => track.readyState === 'ended'),
      cancelledBeforeRelease,
      idle: voices.every(voice => voice.phase() === 'idle'),
      draft: inputs.every(input => input.value === 'P4 未发送草稿'),
      connects: client.stats().connects, cursor: cursors.at(-1), aborts, uploads,
    };
    const prefix = finishOnSuspend ? 'P4_CLOSE ' : 'P4_WAKE ';
    await net.api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: prefix + JSON.stringify(snapshot) }) });
    client.stop();
    voices.forEach(voice => voice.cancel());
    mediaDevices.getUserMedia = originalMedia;
    oscillator.stop(); destination.stream.getTracks().forEach(track => track.stop());
    await context.close(); host.remove();
  }, { once: true });
  return { recording: voices[0].phase(), pending: voices[1].phase() };
}

(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native lifecycle requires macOS'); return; }
    const bundle = process.env.RUYI_DESKTOP_TEST_APP || buildMacDesktop(path.join(root, '生命周期.app'));
    const fixture = fixtureChildEnv({ perTest: true });
    const data = path.join(fixture.home, 'data');
    const workspace = path.join(fixture.home, '生命周期工作区');
    fs.mkdirSync(data); fs.mkdirSync(workspace);
    const clockFile = path.join(root, 'clock.txt');
    const clock = Math.floor(Date.now() / 60000) * 60000;
    fs.writeFileSync(clockFile, String(clock));
    const script = path.join(root, 'page.js');
    fs.writeFileSync(script, 'return await (' + lifecyclePage.toString() + ')();');
    const config = {
      configSchema: require(path.join(wb, 'app/server')).CONFIG_SCHEMA,
      defaultWorkspace: workspace, workspaces: [{ path: workspace }], permissionMode: 'bypass', engineMode: 'print',
      activeProvider: '', stewardEnabledV1: false, schedulerEnabledV1: true,
      autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [],
      providers: [{ id: 'fixture-asr', name: 'Fixture only', baseUrl: 'http://127.0.0.1:1/v1',
        models: [{ id: 'fixture', caps: ['asr'] }] }], asrProviderId: 'fixture-asr', asrModel: 'fixture',
    };
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
    function launch(name, extra = [], overrides = {}) {
      const report = path.join(root, name + '.json');
      const child = cp.spawn(path.join(bundle, 'Contents/MacOS/RuyiDesktop'), ['--acceptance-report', report, ...extra], {
        env: { ...process.env, ...fixture.env, RUYI_HOME: data, RUYI_NODE_PATH: process.execPath,
          WCW_SCHEDULER_CLOCK_FILE: clockFile, WCW_SCHEDULER_TICK_MS: '40', ...overrides }, cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stderr.on('data', () => {});
      return { child, report };
    }
    const app = launch('wake', ['--acceptance-script', script, '--acceptance-system-events']);
    const ready = await until(() => {
      const report = read(app.report);
      if (report?.state === 'failed') throw new Error(JSON.stringify(report));
      return report?.state === 'ready' && report;
    }, 90000);
    ok(ready.backgroundOnClose && Number.isInteger(ready.loginStartupStatus), 'native lifecycle reports default background behavior and actual login service status');
    ok(ready.page.additional.recording === 'recording' && ready.page.additional.pending === 'starting',
      'actual WKWebView has one active synthetic capture and one pending synthetic permission result');
    const runtime = read(path.join(data, 'runtime.json'));
    const api = async (route, method = 'GET', body) => {
      const response = await fetch(ready.url.slice(0, -1) + route, { method,
        headers: { 'content-type': 'application/json', 'x-wcw-token': runtime.token },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return response.json();
    };
    const at = new Date(clock + 60000);
    const schedule = { kind: 'once', date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`,
      at: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
    const late = await api('/api/scheduler/tasks', 'POST', { title: 'P4 late', schedule,
      payload: { kind: 'reminder', text: 'fixture' }, policy: { onMissed: 'run-once-late', graceMinutes: 30 } });
    const skip = await api('/api/scheduler/tasks', 'POST', { title: 'P4 skip', schedule,
      payload: { kind: 'reminder', text: 'fixture' }, policy: { onMissed: 'skip' } });
    ok(late.ok && skip.ok, 'normal scheduler API creates late-run and skip policy fixtures');
    app.child.kill('SIGUSR1');
    await until(() => read(app.report)?.sleepEvents === 1);
    pausedService = identity(ready.servicePID);
    ok(pausedService && pausedService.ppid === app.child.pid, 'backend suspension uses the exact currently owned native child identity');
    if (!pausedService || pausedService.ppid !== app.child.pid) throw new Error('service ownership mismatch');
    process.kill(pausedService.pid, 'SIGSTOP');
    fs.writeFileSync(clockFile, String(clock + 10 * 60000));
    await sleep(1800);
    resumeOwnedService();
    app.child.kill('SIGUSR2');
    await until(() => read(app.report)?.wakeValidated === true);
    const awakened = read(app.report);
    ok(awakened.servicePID === ready.servicePID && awakened.sleepEvents === 1 && awakened.wakeEvents === 1,
      'wake validates the same owned backend without starting a second service');
    const snapshot = await until(async () => {
      const sessions = await api('/api/sessions');
      const session = sessions.sessions?.find(row => row.title.startsWith('P4_WAKE '));
      return session && JSON.parse(session.title.slice('P4_WAKE '.length));
    });
    ok(snapshot.ended && snapshot.late && snapshot.idle && snapshot.cancelledBeforeRelease,
      'native suspend stops active tracks and discards late permission acquisition');
    ok(snapshot.draft && snapshot.uploads === 0, 'suspend preserves unsent drafts and sends no recording');
    ok(snapshot.connects === 2 && snapshot.cursor === 'p4:1' && snapshot.aborts === 1,
      'native wake reconnects SSE once with the existing replay cursor');
    const fires = () => {
      try { return fs.readFileSync(path.join(data, 'scheduler/fires-v1.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
      catch { return []; }
    };
    await until(() => fires().filter(row => row.phase === 'reconciled').length >= 2);
    const results = fires().filter(row => row.phase === 'reconciled');
    ok(results.filter(row => row.taskId === late.task.id && row.outcome === 'succeeded' && row.mode === 'late').length === 1,
      'suspended backend resumes a missed reminder exactly once under run-once-late policy');
    ok(results.filter(row => row.taskId === skip.task.id && row.outcome === 'skipped').length === 1,
      'suspended backend preserves skip policy for a missed reminder');
    app.child.kill('SIGUSR2');
    await until(() => read(app.report)?.wakeEvents === 2 && read(app.report)?.wakeValidated);
    await sleep(200);
    ok(fires().filter(row => row.phase === 'registered' && row.taskId === late.task.id).length === 1,
      'repeated wake does not duplicate a settled reminder');
    app.child.kill('SIGTERM');
    await until(() => app.child.exitCode !== null);
    ok(!identity(ready.servicePID), 'normal native quit reclaims the resumed backend');

    const close = launch('close', ['--acceptance-toggle-background', '--acceptance-close-window']);
    await until(() => close.child.exitCode !== null, 90000);
    const closed = read(close.report);
    ok(close.child.exitCode === 0 && closed?.state === 'ready' && closed.backgroundOnClose === false && !identity(closed.servicePID),
      'normal menu handler persists close-to-quit and closing the window reclaims the backend');
    const persisted = launch('persisted', ['--acceptance-close-window']);
    await until(() => persisted.child.exitCode !== null, 90000);
    ok(read(persisted.report)?.backgroundOnClose === false && persisted.child.exitCode === 0,
      'close-to-quit preference survives a native App restart');

    const closeScript = path.join(root, 'close-page.js');
    fs.writeFileSync(closeScript, 'return await (' + lifecyclePage.toString() + ')(true);');
    for (const action of ['close-window', 'hide', 'minimize']) {
      const extra = ['--acceptance-script', closeScript, '--acceptance-' + action];
      if (action === 'close-window') extra.push('--acceptance-toggle-background');
      const suspended = launch('suspend-' + action, extra);
      const suspendedReady = await until(() => read(suspended.report)?.state === 'ready' && read(suspended.report), 90000);
      const suspendedRuntime = read(path.join(data, 'runtime.json'));
      const captured = await until(async () => {
        const response = await fetch(suspendedReady.url + 'api/sessions', { headers: { 'x-wcw-token': suspendedRuntime.token } });
        const body = await response.json();
        const session = body.sessions?.find(row => row.title.startsWith('P4_CLOSE '));
        return session && JSON.parse(session.title.slice('P4_CLOSE '.length));
      });
      ok(captured.ended && captured.late && captured.idle && captured.cancelledBeforeRelease && captured.draft && captured.uploads === 0,
        action + ' native action stops capture and discards a later permission result while preserving the draft');
      // Remove the fixture report session so the next action cannot consume an earlier result.
      const sessions = await (await fetch(suspendedReady.url + 'api/sessions', { headers: { 'x-wcw-token': suspendedRuntime.token } })).json();
      for (const session of sessions.sessions.filter(row => row.title.startsWith('P4_CLOSE '))) {
        await fetch(suspendedReady.url + 'api/sessions/' + session.id, { method: 'DELETE',
          headers: { 'x-wcw-token': suspendedRuntime.token } });
      }
      suspended.child.kill('SIGTERM');
      await until(() => suspended.child.exitCode !== null);
    }

    for (const mode of ['normal', 'host-crash']) {
      const mcp = treeFixture(mode + '-mcp', 'require(' + JSON.stringify(path.resolve(__dirname, 'fake-mcp.js')) + ');');
      const cli = treeFixture(mode + '-cli', `process.stdout.write(JSON.stringify({
  type: 'system', subtype: 'init', session_id: 'fixture', tools: [], model: 'fake',
}) + '\\n');
setInterval(() => {}, 1000);`);
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...config, schedulerEnabledV1: false,
        externalMcpServers: [{ id: 'p4-tree', label: 'P4 fixture', command: process.execPath, args: [mcp.wrapper], enabled: true }],
      }));
      const treeApp = launch(mode, [], { WCW_FAKE_CLAUDE: cli.wrapper });
      const treeReady = await until(() => read(treeApp.report)?.state === 'ready' && read(treeApp.report), 90000);
      const treeRuntime = read(path.join(data, 'runtime.json'));
      const headers = { 'content-type': 'application/json', 'x-wcw-token': treeRuntime.token };
      const health = await (await fetch(treeReady.url + 'api/mcp/connectors/health', {
        method: 'POST', headers, body: JSON.stringify({ id: 'p4-tree' }),
      })).json();
      ok(health.ok && health.health.status === 'ok', mode + ' real backend connects the fixture MCP server');
      const controller = new AbortController();
      const turn = fetch(treeReady.url + 'api/chat/stream', { method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ message: 'P4 owned lifecycle fixture', cwd: workspace }),
      }).then(response => response.text()).catch(() => '');
      try {
        await until(() => [mcp.pidFile, mcp.descendantPidFile, cli.pidFile, cli.descendantPidFile].every(file => read(file)?.pid));
        const records = [mcp.pidFile, mcp.descendantPidFile, cli.pidFile, cli.descendantPidFile].map(file => identity(read(file).pid));
        const table = snapshotProcessTable();
        const descendants = ownDescendants(table, treeApp.child.pid).descendants;
        ok(records.every(record => record && descendants.some(row => row.pid === record.pid && row.created === record.created)),
          mode + ' MCP and active CLI each own a live descendant in the native App tree');
        treeApp.child.kill(mode === 'normal' ? 'SIGTERM' : 'SIGKILL');
        await until(() => treeApp.child.exitCode !== null || treeApp.child.signalCode !== null);
        await until(() => !identity(treeReady.servicePID) && records.every(record => !sameProcess(record)), 15000);
        ok(!identity(treeReady.servicePID) && records.every(record => !sameProcess(record)),
          mode + ' App termination reclaims its service and complete MCP/CLI fixture trees');
      } finally { controller.abort(); await turn; }
    }
    console.log('Native lifecycle reports ' + root);
  } finally {
    resumeOwnedService();
    for (const child of children) await killOwnTree(child);
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done());

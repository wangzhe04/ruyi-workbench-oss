'use strict';
require('./lib/self-isolate-home');
// Listen-only target-process capture. An independent MCP injects demonstrations into our own receiver.
// This tests the real event tap and ordinary recording/replay entries with deterministic synthetic input.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS MANUAL RECORD');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-manual-'));
process.env.RUYI_HOME = path.join(root, 'data');
const reports = [], results = [], clients = [], pendingCalls = [];
const activeCalls = new Set(), nativeHelpers = new Set();
const clientIdentities = new Map();
let fixture, blockedWorker, blockedIdentity, runtime, clipboardSeeded = false;
async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Owned manual recording fixture timed out');
}
async function command(text) {
  const offset = reports.length;
  fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function call(client, name, args = {}) {
  const result = await trackedCall(client, name, args);
  results.push({ owner: clients.indexOf(client), name, result });
  return result;
}
function trackedCall(client, name, args, timeout) {
  const active = { client, requestId: client._nextId };
  activeCalls.add(active);
  active.promise = client.callTool(name, args, timeout).finally(() => activeCalls.delete(active));
  return active.promise;
}
async function stopClientInputs() {
  const outstanding = [...activeCalls];
  for (const active of outstanding) {
    try { active.client._notify('notifications/cancelled', { requestId: active.requestId, reason: 'manual fixture cleanup' }); }
    catch (error) { t.fail('cooperative input cleanup ' + error.message); }
  }
  if (outstanding.length) {
    await Promise.race([Promise.allSettled(outstanding.map(active => active.promise)),
      new Promise(resolve => setTimeout(resolve, 15000))]);
  }
  // Stop only native workers proven to descend from our live MCP owners. Give
  // SIGTERM/EOF cleanup and the native watchdog time before supervisor SIGKILL.
  const table = snapshotProcessTable();
  if (!table && clients.some(client => client.child)) throw new Error('Cannot inspect owned native workers before cleanup');
  const workers = [];
  for (const client of clients) {
    if (!client.child || client.child.exitCode !== null || client.child.signalCode !== null) continue;
    const identity = clientIdentities.get(client);
    if (!identity || !table.some(row => row.pid === identity.pid && row.created === identity.created))
      throw new Error('MCP owner identity changed before native cleanup');
    for (const row of ownDescendants(table, client.child.pid).descendants) {
      const invocation = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
      if (![...nativeHelpers].some(helper => invocation === helper + ' --input-session')) continue;
      const current = snapshotProcessTable()?.find(candidate => candidate.pid === row.pid && candidate.created === row.created);
      if (!current) continue;
      try { process.kill(row.pid, 'SIGTERM'); workers.push(row); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  if (workers.length) await until(() => {
    const current = snapshotProcessTable();
    return current && workers.every(worker => !current.some(row => row.pid === worker.pid && row.created === worker.created));
  }, 15000);
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    const state = await until(async () => {
      const value = await command('state');
      return !value.leftHeld && !value.hidShift && !value.hidLeft && value.modifierFlags === 0 ? value : null;
    }, 3000);
    results.push({ name: 'cleanup-input-state', result: state });
    t.ok(true, 'cooperative MCP cleanup confirms balanced receiver and HID state before force cleanup');
  }
}
async function stopBlockedWorker() {
  if (!blockedWorker || blockedWorker.exitCode !== null || blockedWorker.signalCode !== null) return;
  const current = snapshotProcessTable()?.find(row => row.pid === blockedWorker.pid && row.created === blockedIdentity?.created);
  const invocation = cp.spawnSync('/bin/ps', ['-p', String(blockedWorker.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
  if (!current || invocation !== blockedWorker.spawnfile + ' --input-session') throw new Error('Blocked worker identity changed before cleanup');
  process.kill(blockedWorker.pid, 'SIGTERM');
  try {
    await until(async () => {
      const state = await command('state');
      return !state.leftHeld && !state.hidShift && !state.hidLeft && state.modifierFlags === 0;
    }, 3000);
  } catch (error) {
    // Give the native frame watchdog its full opportunity to release ownership before forced cleanup.
    await until(() => blockedWorker.exitCode !== null || blockedWorker.signalCode !== null, 15000).catch(() => killOwnTree(blockedWorker));
    throw error;
  }
  killOwnTree(blockedWorker);
  await until(() => blockedWorker.exitCode !== null || blockedWorker.signalCode !== null);
}
function key(type, keycode, at_us, flags = 0, extra = {}) {
  return { type, keycode, at_us, flags, keyboard_type: 91, ...(type === 'flags' ? {} : { repeat: 0 }), ...extra };
}
function typing(codes, texts) {
  return codes.flatMap((code, index) => [key('key_down', code, index * 80000, 0, texts ? { unicode: texts[index] } : {}),
    key('key_up', code, index * 80000 + 40000)]);
}
function chord(code, modifier, flags) {
  return [key('flags', modifier, 0, flags), key('key_down', code, 80000, flags),
    key('key_up', code, 120000, flags), key('flags', modifier, 180000)];
}
function combine(...groups) {
  const events = [];
  let offset = 0;
  for (const group of groups) {
    events.push(...group.map(event => ({ ...event, at_us: event.at_us + offset })));
    offset = events.at(-1).at_us + 80000;
  }
  return events;
}
function pointer(type, point, at_us, extra = {}) {
  return { type, ...point, at_us, flags: 0, button: 0, click_state: 1, pressure: 0, delta_x: 0, delta_y: 0, ...extra };
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP manual event recording requires macOS'); return; }
    const helper = process.env.RUYI_P5_MANUAL_HELPER || buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const testing = buildMacAutomationHelper({ output: path.join(root, 'blocked-sequence-helper'), testing: true });
    nativeHelpers.add(helper); nativeHelpers.add(testing);
    for (const failure of ['create', 'register']) {
      const failed = cp.spawnSync(testing, ['--input-session'], { env: { ...fixtureChildEnv(), RUYI_TEST_SESSION_MONITOR_FAILURE: failure },
        input: JSON.stringify({ id: 1, version: 1, op: 'window.list' }) + '\n', encoding: 'utf8', timeout: 5000 });
      t.ok(!failed.error && failed.status === 70 && !failed.stdout.trim(),
        `native session monitor ${failure} failure exits instead of retaining a stopped worker`);
    }
    const failedWatcher = cp.spawn(testing, ['--input-session'], { env: { ...fixtureChildEnv(), RUYI_TEST_SESSION_MONITOR_FAILURE: 'wait' },
      stdio: ['pipe', 'ignore', 'ignore'] });
    try {
      // Keep the pipe open so a normal EOF cannot win before the injected error.
      await until(() => failedWatcher.exitCode !== null || failedWatcher.signalCode !== null, 5000);
      t.ok(failedWatcher.exitCode === 70, 'native monitor wait error exits while its input pipe remains open');
    } finally { killOwnTree(failedWatcher); }
    function nativeContract(op, args = {}) {
      const run = cp.spawnSync(testing, [], { input: JSON.stringify({ version: 1, op, ...args }), encoding: 'utf8', timeout: 5000 });
      return JSON.parse(run.stdout);
    }
    const allocation = nativeContract('test_release_allocation');
    const subtypes = nativeContract('test_pointer_subtypes');
    t.ok(subtypes.cases.length === 50 && subtypes.cases.every(row => row.matched) && subtypes.pressure_association_refused,
      'native pointer capture preserves default and mouse-touch fields and refuses tablet or unknown subtypes');
    t.ok(allocation.cleanup_refused === true && allocation.ownership_retained === true && allocation.permission_ownership_retained === true && allocation.cross_tool_blocked === true,
      'native release failures retain ownership and block subsequent writes across tool families');
    const stoppedMutations = nativeContract('test_stopped_mutations');
    t.ok(stoppedMutations.results.length === 18 && stoppedMutations.results.every(row => !row.result.ok
      && row.result.code === 'input_cancelled' && row.result.action_sent === false && row.result.outcome === 'not_dispatched'),
      'a stopped native session refuses every input, clipboard, window, launch, AX and recording mutation');
    t.ok(nativeContract('test_validate_sequence', { events: typing([0]).map(event => ({ ...event, flags: 0x20000000 })) }).ok === true,
      'native portable rows preserve bounded raw flag bits from current macOS');
    const missingScrollPrefix = { type: 'scroll', at_us: 0, flags: 0, x: 0, y: 0, continuous: true,
      delta: [1, 2, 0], fixed: [1.25, 2.5, 0], point: [5, 10, 0], phase: 2, momentum: 0, scroll_count: 1 };
    for (const events of [[key('key_up', 0, 0)], [missingScrollPrefix, { ...missingScrollPrefix, at_us: 10000, phase: 4 }],
      [key('flags', 56, 0, (1 << 17) | 2), key('flags', 56, 10000, 2)]]) {
      const refused = nativeContract('test_validate_sequence', { events });
      t.ok(refused.ok === false && refused.code === 'invalid_args', 'native preflight refuses an unmatched or contradictory gesture before dispatch');
    }
    const productionFixture = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'test_release_allocation' }), encoding: 'utf8', timeout: 5000 });
    t.ok(JSON.parse(productionFixture.stdout).code === 'invalid_args', 'production helper excludes testing-only release injection');
    const productionSubtypes = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'test_pointer_subtypes' }), encoding: 'utf8', timeout: 5000 });
    t.ok(JSON.parse(productionSubtypes.stdout).code === 'invalid_args', 'production helper excludes testing-only pointer generation');
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    if (!status.manualRecordReady || !status.inputSequenceReady) {
      if (process.env.RUYI_P5_MANUAL_REQUIRED === '1') t.fail('manual acceptance requires an authorized unlocked desktop and current native backend');
      else console.log('SKIP manual recording requires current listening and input authorization');
      return;
    }
    const binary = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-DRUYI_MANUAL_FIXTURE=1', '-DRUYI_RECORD_FIXTURE=1', '-mmacosx-version-min=14.0', '-framework', 'AppKit',
      '-framework', 'ApplicationServices', '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', binary],
    { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    fixture = cp.spawn(binary, [], { env: { ...fixtureChildEnv(), RUYI_P5_CLIPBOARD_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        reports.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime']);
    runtime = S.ProcessRuntime;
    async function startClient(dataName, hidden = '') {
      const client = new S.McpStdioClient({ id: 'ai-computer-control',
        command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'), args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
        env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, dataName),
          ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: hidden, RUYI_MACOS_AUTOMATION_HELPER: helper } });
      clients.push(client);
      await client.start();
      const identity = snapshotProcessTable()?.find(row => row.pid === client.child.pid);
      if (!identity) throw new Error('Cannot retain the manual MCP owner identity');
      clientIdentities.set(client, identity);
      return client;
    }
    await startClient('acc-0');
    await startClient('acc-1');
    const [recorder, peer] = clients;
    t.ok(clients.every(client => ['input_sequence', 'record_start', 'record_stop', 'macro_run'].every(name => client.listTools().some(tool => tool.name === name))),
      'ordinary stdio discovery exposes source-bound event sequences and manual recording');
    async function target(client) {
      const listed = await call(client, 'list_windows');
      const row = listed.windows.find(window => window.pid === fixture.pid && window.handle === ready.id);
      if (!row) throw new Error('Owned manual recording window is missing');
      return row.target;
    }
    let bound = await target(recorder), peerBound = await target(peer);
    await call(recorder, 'focus_window', { target: bound });
    const seed = await command('seed-clipboard');
    clipboardSeeded = seed.clipboardSnapshot;
    t.ok(clipboardSeeded && seed.clipboardPreserved, 'manual fixture snapshots the original clipboard before seeding owned formats');
    if (!clipboardSeeded) throw new Error('Cannot preserve the pre-test clipboard');
    const scenarios = [
      { name: 'raw Pinyin composition', source: 'source-pinyin', events: typing([45, 34, 4, 0, 31, 49]), expected: '你好' },
      { name: 'ASCII override on another keycode', events: typing([0], ['z']), expected: 'z', unicode: 'z' },
      { name: 'emoji override', events: typing([0], ['😀']), expected: '😀', unicode: '😀' },
      { name: 'Shift Unicode override', events: chord(0, 56, 1 << 17).map(event => event.type === 'key_down' ? { ...event, unicode: 'z' } : event), expected: 'z', unicode: 'z' },
      { name: 'raw Shift shortcut', events: chord(0, 56, 1 << 17), expected: 'A' },
      { name: 'Option dead-key composition', events: combine(chord(14, 58, 1 << 19), typing([14])), expected: 'é' },
      { name: 'overlapping keys and autorepeat', events: [key('key_down', 0, 0), key('key_down', 1, 80000),
        key('key_down', 0, 160000, 0, { repeat: 1 }), key('key_up', 0, 240000), key('key_up', 1, 320000)], expected: 'as', repeat: true },
      { name: 'copy then paste from the replay clipboard', events: combine(typing([0], ['示范']), chord(0, 55, 1 << 20),
        chord(8, 55, 1 << 20), typing([124]), chord(9, 55, 1 << 20)), expected: '示范示范', clipboard: '示范' },
    ];
    let lastRecording, savedRecording;
    for (const scenario of scenarios) {
      const selected = await command(scenario.source || 'source-abc');
      await new Promise(resolve => setTimeout(resolve, 200));
      await command('focus-text');
      await command('clear-neutral');
      if (scenario.clipboard) await command('clipboard-track ' + Buffer.from(scenario.clipboard).toString('base64'));
      const input_source = { id: selected.inputSource, type: scenario.source ? 'TISTypeKeyboardInputMode' : 'TISTypeKeyboardLayout' };
      const started = await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
      const sent = await call(peer, 'input_sequence', { target: peerBound, input_source, events: scenario.events });
      await new Promise(resolve => setTimeout(resolve, 200));
      const stopped = await call(recorder, 'record_stop', scenario.name === 'ASCII override on another keycode' ? { save_as: 'manual ascii' } : {});
      const before = await command('state');
      const recording = stopped.recording;
      if (stopped.path) savedRecording = { path: stopped.path, recording };
      t.ok(started.ok && sent.ok && stopped.complete && recording.schema === 2 && recording.source === 'native_window_events'
        && recording.actions.every(action => action.op === 'input.sequence'), `${scenario.name} captured a complete portable event stream`);
      if (!stopped.complete) throw new Error(JSON.stringify(stopped));
      t.ok(before.text === scenario.expected && !before.marked, `${scenario.name} reached its expected committed text before replay`);
      const captured = recording.actions.flatMap(action => action.events);
      if (scenario.unicode) t.ok(captured.some(event => event.unicode === scenario.unicode), `${scenario.name} retains its Unicode override`);
      if (scenario.repeat) t.ok(captured.some(event => event.repeat === 1), 'autorepeat remains an explicit event inside the held-key sequence');
      await command('clear-neutral');
      const replay = await call(recorder, 'macro_run', { recording, target: bound });
      await new Promise(resolve => setTimeout(resolve, 200));
      const after = await command('state');
      t.ok(replay.ok && after.text === before.text && !after.marked && !after.leftHeld && after.modifierFlags === 0,
        `${scenario.name} replays through macro_run with released input and identical committed text`);
      lastRecording = recording;
    }
    const cold = await startClient('acc-0');
    const listed = await call(cold, 'macro_list');
    const savedMacro = listed.macros.find(macro => macro.name === 'manual ascii');
    t.ok(savedMacro?.valid && savedMacro.source === 'native_window_events' && savedRecording?.path === savedMacro.path,
      'a cold MCP reads the saved schema2 manual recording through macro_list');
    const savedDocument = JSON.parse(fs.readFileSync(savedRecording.path, 'utf8'));
    const coldTarget = await target(cold);
    await command('focus-text');
    await command('clear-neutral');
    const coldReplay = await call(cold, 'macro_run', { recording: savedDocument, target: coldTarget });
    t.ok(coldReplay.ok && (await command('state')).text === 'z', 'the saved manual recording replays from a cold MCP with a fresh native target');
    const hidden = await startClient('acc-hidden', 'input_sequence');
    const hiddenTarget = await target(hidden);
    const beforeHidden = await command('state');
    const hiddenReplay = await call(hidden, 'macro_run', { recording: savedDocument, target: hiddenTarget });
    const hiddenBatch = await call(hidden, 'batch_actions', { actions: [{ tool: 'input_sequence', args: {
      events: typing([0], ['x']), input_source: savedDocument.input_source, target: hiddenTarget } }] });
    const afterHidden = await command('state');
    t.ok(!hidden.listTools().some(tool => tool.name === 'input_sequence') && !hiddenReplay.ok && hiddenReplay.code === 'tool_unavailable'
      && !hiddenBatch.ok && JSON.stringify(beforeHidden.counts) === JSON.stringify(afterHidden.counts),
      'a registry-hidden input_sequence is unavailable through discovery, saved macro replay and nested batch actions');
    await command('focus-pad');
    let point = { x: Math.round(ready.pad.x + 100), y: Math.round(ready.pad.y + 60) };
    const input_source = { id: 'com.apple.keylayout.ABC', type: 'TISTypeKeyboardLayout' };
    const scroll = (phase, momentum, at_us) => ({ type: 'scroll', ...point, at_us, flags: 0, continuous: true,
      delta: [2, -3, 0], fixed: [2.25, -3.5, 0], point: [9, -14, 0], phase, momentum, scroll_count: 1 });
    const gestures = combine([key('flags', 56, 0, 1 << 17), pointer('mouse_down', point, 80000, { flags: 1 << 17 }),
      pointer('drag', { x: point.x + 30, y: point.y + 20 }, 160000, { flags: 1 << 17, delta_x: 30, delta_y: 20 }),
      pointer('mouse_up', { x: point.x + 30, y: point.y + 20 }, 240000, { flags: 1 << 17 }), key('flags', 56, 300000)],
    [scroll(1, 0, 0), scroll(2, 0, 80000), scroll(4, 0, 160000), scroll(0, 1, 240000), scroll(0, 2, 320000), scroll(0, 3, 400000)],
    [pointer('mouse_down', point, 0), pointer('mouse_up', point, 40000),
      pointer('mouse_down', point, 100000, { click_state: 2 }), pointer('mouse_up', point, 140000, { click_state: 2 })],
    [pointer('mouse_down', point, 0, { subtype: 3 }),
      pointer('drag', { x: point.x + 10, y: point.y + 10 }, 80000, { subtype: 3, delta_x: 10, delta_y: 10 }),
      pointer('mouse_up', { x: point.x + 10, y: point.y + 10 }, 160000, { subtype: 3 }),
      pointer('move', point, 240000, { subtype: 3 })]);
    const isolatedModifier = await call(peer, 'input_sequence', { target: peerBound, input_source, events: gestures.slice(0, 5) });
    const modifierReleased = await until(async () => {
      const state = await command('state');
      return !state.leftHeld && !state.hidShift && !state.hidLeft && state.modifierFlags === 0 ? state : null;
    });
    t.ok(isolatedModifier.ok && Math.abs(modifierReleased.cursorX - (point.x + 30)) <= 2
      && Math.abs(modifierReleased.cursorY - (point.y + 20)) <= 2,
      'a standalone modified drag restores HID and combined modifiers without moving the cursor');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    const sentGestures = await call(peer, 'input_sequence', { target: peerBound, input_source, events: gestures });
    const gestureRecording = await call(recorder, 'record_stop');
    const captured = gestureRecording.recording.actions.flatMap(action => action.events);
    t.ok(sentGestures.ok && gestureRecording.complete && captured.some(event => event.type === 'drag' && event.flags & (1 << 17)),
      'manual modified drag preserves button ownership, path and held Shift');
    t.ok(captured.some(event => event.type === 'scroll' && event.continuous && event.fixed[1] === -3.5)
      && captured.some(event => event.momentum === 3) && captured.some(event => event.click_state === 2),
      'continuous dual-axis scrolling, momentum termination and double-click state survive capture');
    t.ok(['mouse_down', 'drag', 'mouse_up', 'move'].every(type => captured.some(event => event.type === type && event.subtype === 3)),
      'mouse-touch click, drag, release and movement retain subtype through the real target event tap');
    const pointerReplay = await call(recorder, 'macro_run', { recording: gestureRecording.recording, target: bound });
    const pointerState = await command('state');
    t.ok(pointerReplay.ok && !pointerState.leftHeld && pointerState.modifierFlags === 0, 'recorded pointer gestures replay and release their owned inputs');
    const poisoned = JSON.parse(JSON.stringify(lastRecording));
    poisoned.actions.at(-1).events.push(key('key_up', 0, 4900000));
    const beforeInvalid = await command('state');
    const invalid = await call(recorder, 'macro_run', { recording: poisoned, target: bound });
    const afterInvalid = await command('state');
    t.ok(!invalid.ok && invalid.code === 'recording_invalid' && JSON.stringify(beforeInvalid.counts) === JSON.stringify(afterInvalid.counts),
      'a malformed final event rejects the entire recording before any prefix is replayed');
    const obstructed = JSON.parse(JSON.stringify(lastRecording));
    obstructed.actions = [
      { op: 'input.sequence', at: 0, ended: .04, events: typing([0], ['z']) },
      { op: 'input.sequence', at: .5, ended: .5, events: [pointer('move', point, 0)] }
    ];
    await command('floating');
    const beforeCovered = await command('state');
    const coveredReplay = await call(recorder, 'macro_run', { recording: obstructed, target: bound });
    const afterCovered = await command('state');
    t.ok(!coveredReplay.ok && ['target_occluded', 'target_hit_unconfirmed'].includes(coveredReplay.code)
      && JSON.stringify(beforeCovered.counts) === JSON.stringify(afterCovered.counts),
      'an occluded pointer in the final chunk rejects the whole macro before its first keyboard chunk');
    await command('focus-pad');
    const unmoved = JSON.stringify(gestureRecording.recording);
    const moved = await command('record-move');
    bound = await target(recorder);
    peerBound = await target(peer);
    const movedReplay = await call(recorder, 'macro_run', { recording: gestureRecording.recording, target: bound });
    t.ok(movedReplay.ok && JSON.stringify(gestureRecording.recording) === unmoved,
      'all native sequence points follow the fresh moved window without mutating the recording');
    point = { x: Math.round(moved.pad.x + 100), y: Math.round(moved.pad.y + 60) };
    for (const nested of [false, true]) {
      await command('focus-pad');
      peerBound = await target(peer);
      const beforeCancel = await command('state');
      const auditOffset = (await call(peer, 'audit_tail', { n: 100 })).records.length;
      const held = [key('flags', 56, 0, 1 << 17), key('key_down', 0, 40000, 1 << 17),
        pointer('mouse_down', point, 80000, { flags: 1 << 17 }),
        pointer('mouse_up', point, 1500000, { flags: 1 << 17 }), key('key_up', 0, 1600000, 1 << 17),
        key('flags', 56, 1700000), key('key_down', 1, 1800000), key('key_up', 1, 1900000)];
      const sequenceArgs = { events: held, target: peerBound, input_source };
      const requestId = peer._nextId;
      let pendingResult;
      pendingCalls.push(trackedCall(peer, nested ? 'macro_run' : 'input_sequence', nested
        ? { steps: [{ tool: 'input_sequence', args: sequenceArgs }], delay_ms: 0 } : sequenceArgs, 60000)
        .then(result => {
          pendingResult = result;
          results.push({ owner: clients.indexOf(peer), name: nested ? 'pending-macro_run' : 'pending-input_sequence', requestId, result });
          return result;
        }).catch(error => ({ error: String(error) })));
      await until(async () => {
        if (pendingResult && !pendingResult.ok) throw new Error('Held-input request refused before receipt: ' + JSON.stringify(pendingResult));
        return (await command('state')).counts.left_down > (beforeCancel.counts.left_down || 0);
      });
      if (process.env.RUYI_P5_MANUAL_CLEANUP_FAULT === (nested ? 'nested' : 'direct')) throw new Error('Injected held-request cleanup failure');
      peer._notify('notifications/cancelled', { requestId, reason: 'owned held-input acceptance' });
      const cancelled = await until(async () => (await call(peer, 'audit_tail', { n: 100 })).records.slice(auditOffset)
        .find(row => row.tool === 'input_sequence' && row.cancelled));
      const afterCancel = await until(async () => {
        const state = await command('state');
        return !state.leftHeld && state.modifierFlags === 0 && state.counts.key_up > (beforeCancel.counts.key_up || 0) ? state : null;
      });
      t.ok(cancelled.ok === false && cancelled.action_sent === true && cancelled.outcome === 'unconfirmed'
        && !afterCancel.leftHeld && afterCancel.modifierFlags === 0 && afterCancel.counts.key_up > (beforeCancel.counts.key_up || 0),
        `${nested ? 'nested macro' : 'direct sequence'} cooperative cancellation audits dispatch and releases its held key and button`);
      await new Promise(resolve => setTimeout(resolve, 2100));
      const settled = await command('state');
      t.ok(JSON.stringify(settled.counts) === JSON.stringify(afterCancel.counts),
        `${nested ? 'nested macro' : 'direct sequence'} cancellation posts no delayed suffix after cleanup`);
      const audit = await call(peer, 'audit_tail', { n: 100 });
      t.ok(audit.records.slice(auditOffset).filter(row => row.tool === 'input_sequence' && row.cancelled).length === 1,
        'each cancelled sequence persists exactly one native-tool audit record');
    }
    await command('focus-pad');
    for (const stopMode of ['signal', 'EOF']) {
      blockedWorker = cp.spawn(testing, ['--input-session'], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      const nativeReplies = [];
      let nativeBuffer = '';
      blockedWorker.stdout.on('data', chunk => {
        nativeBuffer += chunk;
        let end;
        while ((end = nativeBuffer.indexOf('\n')) >= 0) {
          nativeReplies.push(JSON.parse(nativeBuffer.slice(0, end)));
          nativeBuffer = nativeBuffer.slice(end + 1);
        }
      });
      blockedWorker.stderr.resume();
      blockedWorker.stdin.write(JSON.stringify({ id: 1, version: 1, op: 'window.list' }) + '\n');
      const nativeList = await until(() => nativeReplies.find(reply => reply.id === 1));
      blockedIdentity = snapshotProcessTable()?.find(row => row.pid === blockedWorker.pid);
      if (!blockedIdentity) throw new Error('Cannot retain the blocked worker creation identity');
      const blockedTarget = nativeList.windows.find(window => window.pid === fixture.pid && window.handle === ready.id).target;
      const beforeBlocked = await command('state');
      const heldEvents = [key('flags', 56, 0, 1 << 17), key('key_down', 0, 40000, 1 << 17),
        pointer('mouse_down', point, 80000, { flags: 1 << 17 }), pointer('mouse_up', point, 1500000, { flags: 1 << 17 }),
        key('key_up', 0, 1600000, 1 << 17), key('flags', 56, 1700000)];
      blockedWorker.stdin.write(JSON.stringify({ id: 2, version: 1, op: 'test_stall_sequence', target: blockedTarget, input_source, events: heldEvents }) + '\n');
      await until(async () => (await command('state')).counts.left_down > (beforeBlocked.counts.left_down || 0));
      const invocation = cp.spawnSync('/bin/ps', ['-p', String(blockedWorker.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
      if (invocation !== testing + ' --input-session' || blockedWorker.exitCode !== null) throw new Error('Owned blocked worker identity changed');
      if (stopMode === 'signal') process.kill(blockedWorker.pid, 'SIGTERM');
      else blockedWorker.stdin.end();
      const releasedWhileBlocked = await until(async () => {
        const state = await command('state');
        return !state.leftHeld && !state.hidLeft && !state.hidShift && state.modifierFlags === 0
          && state.counts.key_up > (beforeBlocked.counts.key_up || 0) ? state : null;
      }, 2000);
      t.ok(blockedWorker.exitCode === null && blockedWorker.signalCode === null && releasedWhileBlocked.counts.left_up > (beforeBlocked.counts.left_up || 0),
        `${stopMode} releases owned keys, pointer and HID modifiers while the native main thread remains blocked`);
      t.ok(Math.abs(releasedWhileBlocked.cursorX - point.x) <= 2 && Math.abs(releasedWhileBlocked.cursorY - point.y) <= 2,
        `${stopMode} blocked-main cleanup preserves the current cursor position`);
      await stopBlockedWorker();
    }
    await command('source-pinyin');
    const wrongSource = await call(recorder, 'macro_run', { recording: lastRecording, target: bound });
    t.ok(!wrongSource.ok && wrongSource.code === 'input_source_changed', 'a real keyboard-source switch rejects replay before any input');
    await command('source-abc');
    await command('focus-pad');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    await command('source-pinyin');
    const changedDuringRecording = await call(recorder, 'record_stop', { save_as: 'incomplete source switch' });
    t.ok(!changedDuringRecording.complete && changedDuringRecording.recording.end_reason === 'input_source_changed'
      && changedDuringRecording.save_error && !changedDuringRecording.path,
      'an actual input-source switch during recording invalidates its buffer and refuses saving');
    await command('source-abc');
    await command('focus-pad');
    peerBound = await target(peer);
    const beforeHeldStop = await command('state');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    const demonstrating = call(peer, 'input_sequence', { target: peerBound, input_source,
      events: [pointer('mouse_down', point, 0), pointer('mouse_up', point, 1200000)] });
    await until(async () => (await command('state')).counts.left_down > (beforeHeldStop.counts.left_down || 0));
    const heldStop = await call(recorder, 'record_stop', { save_as: 'incomplete held input' });
    t.ok(!heldStop.complete && heldStop.recording.end_reason === 'incomplete_input_sequence' && heldStop.save_error && !heldStop.path,
      'collecting a demonstration while its button remains held marks it incomplete and refuses saving');
    const demonstrationEnded = await demonstrating;
    const afterHeldStop = await command('state');
    t.ok(demonstrationEnded.ok && !afterHeldStop.leftHeld && !afterHeldStop.hidLeft,
      'stopping capture leaves the independent demonstrator to release its own button');
    await command('source-abc');
    await command('focus-pad');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    await call(recorder, 'mouse_click', { target: bound, ...point });
    const mixed = await call(recorder, 'record_stop');
    t.ok(!mixed.complete && mixed.recording.end_reason === 'mixed_automation', 'same-worker automation invalidates a manual demonstration');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    await command('steal-focus');
    await new Promise(resolve => setTimeout(resolve, 200));
    const changedFocus = await call(recorder, 'record_stop');
    t.ok(!changedFocus.complete && changedFocus.recording.end_reason === 'focus_changed', 'leaving the exact foreground window invalidates manual recording');
    await command('focus-text');
    await call(recorder, 'record_start', { target: bound, source: 'native_window_events' });
    await command('secure-on');
    const secure = await call(recorder, 'record_stop');
    await command('secure-off');
    t.ok(!secure.complete && secure.recording.end_reason === 'secure_input', 'real Secure Event Input invalidates a manual recording');
    const diagnostic = await call(recorder, 'diagnostics');
    t.ok(diagnostic.capabilities['desktop.recording'].manualReady && diagnostic.capabilities['desktop.input_sequence'].ready,
      'diagnostics report independent manual-listening and sequence replay readiness');
    await command('clipboard-track ' + Buffer.from('示范').toString('base64'));
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (blockedWorker && blockedWorker.exitCode === null && blockedWorker.signalCode === null) {
      await stopBlockedWorker().catch(error => t.fail('blocked helper cleanup ' + error.message));
    }
    await stopClientInputs().catch(async error => {
      t.fail('owned MCP input cleanup ' + error.message);
      // Even an observation failure must not immediately preempt native cleanup.
      await new Promise(resolve => setTimeout(resolve, 15000));
    });
    for (const client of clients) {
      if (!client.child) continue;
      const child = client.child;
      if (!client.dead) await call(client, 'audit_tail', { n: 100 }).catch(error => t.fail('final native audit receipt ' + error.message));
      client.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned manual MCP and native worker cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      try {
        await command('secure-off');
        fixture.stdin.write('quit\n');
        await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000);
      } catch { killOwnTree(fixture); }
    }
    await Promise.allSettled(pendingCalls);
    if (fixture) t.ok(reports.some(report => report.event === 'input-source-restore' && report.restored), 'owned fixture conditionally restores its original keyboard source');
    if (clipboardSeeded) t.ok(reports.some(report => report.event === 'clipboard-restore' && report.restored), 'owned manual fixture restores the original clipboard on exit');
    if (process.env.RUYI_P5_MANUAL_EVIDENCE) {
      const evidence = path.resolve(process.env.RUYI_P5_MANUAL_EVIDENCE);
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, reports }, null, 2) + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();

'use strict';
require('./lib/self-isolate-home');
// Real native controlled-input recording and fresh-target replay in a self-owned receiver.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS RECORD');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-record-'));
process.env.RUYI_HOME = path.join(root, 'data');
let fixture, client, runtime, clipboardSeeded = false;
const reports = [], results = [];
async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Controlled recording receiver timed out');
}
async function command(text) {
  const offset = reports.length;
  fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function call(name, args = {}) {
  const result = await client.callTool(name, args);
  results.push({ name, result });
  return result;
}
function center(bounds) { return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }; }
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native Mac controlled recording'); return; }
    const helper = process.env.RUYI_P5_RECORD_HELPER || buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    if (!status.recordReady) {
      if (process.env.RUYI_P5_RECORD_REQUIRED === '1') t.fail('record acceptance requires authorized unlocked desktop and recording backend');
      else console.log('SKIP native controlled recording requires current desktop authorization');
      return;
    }
    const binary = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-DRUYI_RECORD_FIXTURE=1', '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      '-framework', 'Carbon', path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', binary],
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
    client = new S.McpStdioClient({ id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['record_start', 'record_stop', 'macro_list', 'macro_run'].every(name => names.includes(name)),
      'normal stdio registry exposes native controlled recording, collection and replay');
    async function target() {
      const listed = await call('list_windows');
      const row = listed.windows.find(window => window.pid === fixture.pid && window.handle === ready.id);
      if (!row) throw new Error('Owned recording window missing');
      return row.target;
    }
    let bound = await target();
    await call('focus_window', { target: bound });
    await command('focus-text');
    const seed = await command('seed-clipboard');
    clipboardSeeded = seed.clipboardSnapshot;
    t.ok(seed.clipboardSnapshot && seed.clipboardPreserved, 'recording fixture snapshots the pre-test clipboard before seeding owned formats');
    if (!clipboardSeeded) throw new Error('Cannot preserve the pre-test clipboard');
    const sample = '如意受控录制 中文😀';
    await command('clipboard-track ' + Buffer.from(sample).toString('base64'));
    const invalidStart = await call('record_start', { target: bound, max_seconds: true });
    t.ok(!invalidStart.ok, 'public recording start rejects boolean duration before native state creation');
    const started = await call('record_start', { target: bound, max_seconds: 60 });
    const duplicate = await call('record_start', { target: bound });
    t.ok(started.ok && started.source === 'controlled_native_requests' && !duplicate.ok && duplicate.code === 'recording_exists',
      'one native worker owns exactly one bounded controlled recording');
    await call('get_mouse_position');
    await call('hotkey', { target: bound, keys: ['cmd', 'a'] });
    const typed = await call('type_text', { target: bound, text: sample + '\n', interval: 0 });
    const pad = center(ready.pad);
    await call('mouse_click', { target: bound, ...pad });
    await call('mouse_move', { target: bound, ...pad, duration: .02 });
    await call('mouse_scroll', { target: bound, ...pad, clicks: 2, direction: 'horizontal' });
    await call('mouse_drag', { target: bound, start_x: pad.x - 30, start_y: pad.y, end_x: pad.x + 30, end_y: pad.y, duration: .05 });
    const selfReplay = await call('macro_run', { recording: {
      schema: 1, platform: 'darwin', coordinate_space: 'macos_global_points', source: 'controlled_native_requests',
      complete: true, end_reason: 'stopped', application: { bundle_id: '', executable: binary }, bounds: bound.bounds, actions: []
    }, target: bound });
    t.ok(!selfReplay.ok && selfReplay.code === 'recording_exists', 'native binding refuses replay while a recording is pending');
    const badName = await call('record_stop', { save_as: '../outside' });
    const stopped = await call('record_stop', { save_as: '受控宏' });
    const recording = stopped.recording;
    const received = await command('state');
    t.ok(typed.ok && received.text === sample + '\n' && received.clipboardPreserved && !received.leftHeld && !received.modifierFlags,
      'recorded native text and pointer input reaches the owned receiver and preserves all clipboard formats');
    t.ok(!badName.ok && stopped.ok && stopped.complete && stopped.count === 6
      && recording.actions.map(action => action.op).join(',') === 'keyboard.chord,keyboard.text,mouse.click,mouse.move,mouse.scroll,mouse.drag',
      'collection preserves six semantic actions and excludes queries and internal paste events');
    t.ok(recording.actions[1].text === sample && recording.actions[1].enters === 1 && recording.actions[1].paste
      && !JSON.stringify(recording).includes(bound.ref) && !JSON.stringify(recording).includes('process_start'),
      'recording keeps Chinese body and trailing Enter semantics while omitting expired native window references');
    const listed = await call('macro_list');
    t.ok(fs.existsSync(stopped.path) && listed.macros.some(macro => macro.name === '受控宏' && macro.valid && macro.steps === 6),
      'atomic internal save is readable through the normal macro-list entry point');
    await command('focus-text');
    await command('record-move');
    bound = await target();
    const replay = await call('macro_run', { recording, target: bound });
    const replayState = await command('state');
    t.ok(replay.ok && replay.completed >= 7 && replay.failed === 0 && replayState.text === sample + '\n'
      && replayState.counts.left_down === received.counts.left_down * 2 && replayState.clipboardPreserved,
      'fresh-target replay remaps a moved window and reproduces exact text, Enter and pointer reception');
    const poisoned = JSON.parse(JSON.stringify(recording));
    poisoned.actions[5] = { op: 'keyboard.chord', at: poisoned.actions[5].at, ended: poisoned.actions[5].ended, keys: ['unknown-key'] };
    const badReplay = await call('macro_run', { recording: poisoned, target: bound });
    const badState = await command('state');
    t.ok(!badReplay.ok && badState.counts.left_down === replayState.counts.left_down,
      'native whole-record chord preflight refuses an invalid suffix before any prefix input');
    const badUnicode = JSON.parse(JSON.stringify(recording));
    badUnicode.actions[5] = { op: 'keyboard.text', at: badUnicode.actions[5].at, ended: badUnicode.actions[5].ended,
      text: 'a' + '\u0301'.repeat(25), paste: false, interval: 0, enters: 0 };
    const unicodeReplay = await call('macro_run', { recording: badUnicode, target: bound });
    t.ok(!unicodeReplay.ok && (await command('state')).counts.left_down === badState.counts.left_down,
      'native whole-record Unicode preflight refuses oversized grapheme suffix before prefix input');
    await call('record_start', { target: bound });
    await call('press_key', { target: bound, key: 'unknown-key' });
    const failed = await call('record_stop');
    t.ok(!failed.complete && failed.recording.end_reason === 'input_failed' && failed.count === 0,
      'failed native dispatch invalidates its recording without saving a misleading complete prefix');
    await call('record_start', { target: bound });
    await command('cover');
    const focusStopped = await call('record_stop', { save_as: 'interrupted' });
    t.ok(!focusStopped.complete && focusStopped.recording.end_reason === 'focus_changed' && focusStopped.save_error && !focusStopped.path,
      'changed foreground ends the native recording and refuses persistence');
    await command('focus-text');
    await call('record_start', { target: bound, max_seconds: 1 });
    await new Promise(resolve => setTimeout(resolve, 1100));
    const expired = await call('record_stop');
    t.ok(!expired.complete && expired.recording.end_reason === 'deadline', 'native recording expires at its bounded deadline');
    await call('record_start', { target: bound });
    await command('secure-on');
    const secureStopped = await call('record_stop');
    const secureStart = await call('record_start', { target: bound });
    await command('secure-off');
    t.ok(!secureStopped.complete && secureStopped.recording.end_reason === 'secure_input' && !secureStart.ok && secureStart.code === 'secure_input',
      'real owned Secure Event Input terminates an active recording and blocks a new start');
    await call('record_start', { target: bound });
    await command('record-resize');
    const geometry = await call('record_stop');
    bound = await target();
    const resizedReplay = await call('macro_run', { recording, target: bound });
    t.ok(!geometry.complete && geometry.recording.end_reason === 'window_changed' && !resizedReplay.ok && resizedReplay.code === 'window_changed',
      'changed geometry terminates recording and incompatible replay before input');
    const interruptedReplay = await call('macro_run', { recording: expired.recording, target: bound });
    t.ok(!interruptedReplay.ok && interruptedReplay.code === 'recording_invalid', 'ordinary macro entry refuses interrupted recorded documents');
    await call('record_start', { target: bound, max_seconds: 60 });
    for (let i = 0; i < 101; i++) await call('press_key', { target: bound, key: 'escape' });
    const capacity = await call('record_stop');
    t.ok(!capacity.complete && capacity.count === 100 && capacity.recording.end_reason === 'capacity',
      'native buffer stops at 100 semantic actions and identifies its incomplete capacity prefix');
    const diagnostic = await call('diagnostics');
    t.ok(!diagnostic.unsupported_modules.record && diagnostic.capabilities['desktop.recording'].ready
      && diagnostic.capabilities['desktop.recording'].source === 'controlled_native_requests',
      'diagnostics and discovery report the exact native recording source and readiness');
    const absent = await call('record_stop');
    t.ok(!absent.ok && absent.code === 'recording_absent', 'collected recording state cannot be consumed a second time');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (client?.child) {
      const child = client.child;
      client.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned recording MCP and native worker cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      try {
        await command('secure-off');
        fixture.stdin.write('quit\n');
        await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000);
      } catch { killOwnTree(fixture); }
    }
    if (clipboardSeeded) t.ok(reports.some(report => report.event === 'clipboard-restore' && report.restored),
      'owned fixture restores the pre-test clipboard on exit');
    if (process.env.RUYI_P5_RECORD_EVIDENCE) {
      const evidence = path.resolve(process.env.RUYI_P5_RECORD_EVIDENCE);
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, reports }, null, 2) + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();

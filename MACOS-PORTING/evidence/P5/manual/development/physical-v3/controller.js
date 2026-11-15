'use strict';
// One-time physical acceptance controller. No keyboard/pointer injection occurs during capture.
const worktree = '/tmp/ruyi-p5-manual-worktree';
require(worktree + '/dev-harness/lib/self-isolate-home');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { fixtureChildEnv } = require(worktree + '/dev-harness/lib/fixture-home');
const { killOwnTree } = require(worktree + '/dev-harness/lib/kill-own-tree');
const { loadServerInternals } = require(worktree + '/dev-harness/lib/server-internals');
const { McpStdioClient, ProcessRuntime } = loadServerInternals(['McpStdioClient', 'ProcessRuntime']);
const evidence = process.env.RUYI_P5_HUMAN_EVIDENCE;
if (!evidence) throw new Error('Set a new evidence directory');
fs.mkdirSync(evidence, { recursive: false });
fs.copyFileSync(__filename, path.join(evidence, 'controller.js'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-human-'));
process.env.RUYI_HOME = path.join(root, 'home');
const reports = [], operations = [], calls = [];
let receiver, client, captureActive = false, outcome = { status: 'running', kind: 'physical user demonstration' };
function save() { fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ...outcome, reports, operations, calls }, null, 2) + '\n'); }
async function until(read, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Physical demonstration timed out');
}
async function command(value) {
  operations.push({ at: new Date().toISOString(), phase: captureActive ? 'capture' : 'outside-capture', command: value });
  const offset = reports.length; receiver.stdin.write(value + '\n');
  return until(() => reports.slice(offset).find(row => row.event === value));
}
async function call(name, args = {}) {
  const row = { at: new Date().toISOString(), phase: captureActive ? 'capture' : 'outside-capture', name, args };
  calls.push(row); save(); row.result = await client.callTool(name, args, 90000); save(); return row.result;
}
(async () => {
  try {
    const original = fs.readFileSync(worktree + '/dev-harness/fixtures/macos-input-window.m', 'utf8');
    const addition = '    if ([command hasPrefix:@"human-title "]) primary.title = [command substringFromIndex:12];\n';
    const pointerLog = `    if (event.CGEvent && [@[@(NSEventTypeMouseMoved), @(NSEventTypeLeftMouseDown), @(NSEventTypeLeftMouseUp), @(NSEventTypeLeftMouseDragged)] containsObject:@(event.type)]) {
        CGEventRef raw = event.CGEvent;
        NSDictionary *details = @{@"event":@"raw-pointer", @"type":@(CGEventGetType(raw)),
          @"subtype":@(CGEventGetIntegerValueField(raw, kCGMouseEventSubtype)),
          @"button":@(CGEventGetIntegerValueField(raw, kCGMouseEventButtonNumber)),
          @"pressure":@(CGEventGetDoubleValueField(raw, kCGMouseEventPressure)),
          @"associated_events_mask":@(event.type == NSEventTypeMouseMoved ? 0 : event.associatedEventsMask),
          @"click_state":@(CGEventGetIntegerValueField(raw, kCGMouseEventClickState)),
          @"x":@(CGEventGetLocation(raw).x), @"y":@(CGEventGetLocation(raw).y), @"flags":@(CGEventGetFlags(raw))};
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:details options:0 error:nil];
        puts([[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding].UTF8String); fflush(stdout);
    }
`;
    const modified = original.replace('static void Command(NSString *command) {\n', 'static void Command(NSString *command) {\n' + addition)
      .replace('    [super sendEvent:event];\n', pointerLog + '    [super sendEvent:event];\n');
    if (modified === original) throw new Error('Cannot add the fixture title command');
    fs.writeFileSync(path.join(evidence, 'receiver-original.m'), original);
    fs.writeFileSync(path.join(evidence, 'receiver.m'), modified);
    fs.copyFileSync(worktree + '/dev-harness/fixtures/macos-clipboard-fixture.h', path.join(evidence, 'macos-clipboard-fixture.h'));
    const binary = path.join(root, 'receiver');
    const compile = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-DRUYI_MANUAL_FIXTURE=1', '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      '-framework', 'Carbon', path.join(evidence, 'receiver.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (compile.status !== 0) throw new Error(compile.stderr);
    receiver = cp.spawn(binary, [], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    receiver.stdout.on('data', chunk => {
      buffer += chunk;
      let end; while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    receiver.stderr.resume();
    const ready = await until(() => reports.find(row => row.event === 'ready'));
    const repo = worktree + '/mcp/ai-computer-control';
    client = new McpStdioClient({ id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON,
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: repo + '/src', WCW_DATA_DIR: path.join(root, 'data'),
        ACC_TOOLSETS: 'desktop,macro', RUYI_MACOS_AUTOMATION_HELPER: '/tmp/ruyi-p5-manual-native-helper' } });
    await client.start();
    await command('source-pinyin'); await command('clear-neutral'); await command('focus-text');
    await command('human-title 如意 P5：准备录制，请稍候');
    let listed = await call('list_windows');
    let target = listed.windows.find(row => row.pid === receiver.pid && row.handle === ready.id)?.target;
    if (!target) throw new Error('Cannot bind physical fixture');
    const focus = await call('focus_window', { target });
    if (!focus.ok) throw new Error(JSON.stringify(focus));
    const before = await command('state');
    const positioned = await call('mouse_move', { target, x: Math.round(before.pad.x + before.pad.width / 2),
      y: Math.round(before.pad.y + before.pad.height / 2) });
    if (!positioned.ok) throw new Error(JSON.stringify(positioned));
    const started = await call('record_start', { target, source: 'native_window_events', max_seconds: 300 });
    if (!started.ok) throw new Error(JSON.stringify(started));
    captureActive = true; outcome.captureStartedAt = new Date().toISOString();
    await command('human-title 录制中：直接输入“你好”，再从当前光标在蓝色区拖动并松手');
    save(); console.log('PHYSICAL CAPTURE READY');
    let signature, stableSince = Date.now();
    const demonstrated = await until(async () => {
      const state = await command('state');
      const next = JSON.stringify([state.counts, state.cursorX, state.cursorY, state.hidFlags]);
      if (next !== signature) { signature = next; stableSince = Date.now(); }
      return state.text.trim() === '你好' && !state.marked && !state.leftHeld && !state.hidLeft && !state.hidShift
        && state.modifierFlags === 0 && state.counts.dragged > (before.counts.dragged || 0)
        && Date.now() - stableSince >= 600 ? state : null;
    }, 285000);
    const collected = await call('record_stop', { save_as: 'physical pinyin and drag' });
    captureActive = false; outcome.captureEndedAt = new Date().toISOString();
    await command('human-title 录制已停止，正在自动回放，请暂勿操作');
    if (!collected.complete || !collected.path) throw new Error(JSON.stringify(collected));
    fs.copyFileSync(collected.path, path.join(evidence, 'saved-recording.json'));
    outcome.demonstrated = demonstrated;
    await command('clear-neutral'); await command('focus-text');
    listed = await call('list_windows');
    target = listed.windows.find(row => row.pid === receiver.pid && row.handle === ready.id)?.target;
    const replay = await call('macro_run', { recording: collected.recording, target });
    const replayed = await until(async () => {
      const state = await command('state');
      return state.text === demonstrated.text && !state.marked && !state.leftHeld && !state.hidLeft && state.modifierFlags === 0
        && state.counts.dragged > demonstrated.counts.dragged ? state : null;
    });
    if (!replay.ok) throw new Error(JSON.stringify(replay));
    outcome = { ...outcome, status: 'replay_passed_cleanup_pending', replayed, recordingPath: collected.path,
      captureContainsInjectedCalls: calls.some(row => row.phase === 'capture' && row.name !== 'record_stop'),
      captureFixtureCommands: [...new Set(operations.filter(row => row.phase === 'capture').map(row => row.command))] };
    await command('human-title 验证通过：实体输入已录制并成功回放'); save();
  } catch (error) { outcome = { ...outcome, status: 'failed', error: error.stack || String(error) }; process.exitCode = 1; }
  finally {
    const cleanupErrors = [];
    if (captureActive && client) { try { await call('record_stop'); } catch (error) { cleanupErrors.push(String(error)); } captureActive = false; }
    try {
      if (client?.child) {
        const child = client.child; client.kill(); outcome.mcpCleanup = await ProcessRuntime.waitForCleanup(child, 3000);
        if (!outcome.mcpCleanup || outcome.mcpCleanup.incomplete) throw new Error('MCP cleanup unconfirmed');
      }
    } catch (error) { cleanupErrors.push(String(error)); }
    try {
      if (receiver && receiver.exitCode === null && receiver.signalCode === null) {
        receiver.stdin.write('quit\n');
        await until(() => receiver.exitCode !== null || receiver.signalCode !== null, 5000).catch(error => { killOwnTree(receiver); throw error; });
      }
      outcome.receiverExit = receiver ? { code: receiver.exitCode, signal: receiver.signalCode } : null;
      outcome.sourceRestore = reports.find(row => row.event === 'input-source-restore');
      if (receiver && (receiver.exitCode !== 0 || !outcome.sourceRestore?.restored)) throw new Error('Receiver/source cleanup unconfirmed');
    } catch (error) { cleanupErrors.push(String(error)); }
    outcome.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length) { outcome.status = 'failed'; process.exitCode = 1; }
    else if (outcome.status === 'replay_passed_cleanup_pending') outcome.status = 'passed';
    save(); fs.rmSync(root, { recursive: true, force: true });
    if (outcome.status === 'passed') console.log('PHYSICAL RECORD AND REPLAY: ALL PASS');
    console.log(JSON.stringify({ status: outcome.status, evidence, error: outcome.error, cleanupErrors }));
  }
})();

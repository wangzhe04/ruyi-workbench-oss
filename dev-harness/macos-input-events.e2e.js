'use strict';
require('./lib/self-isolate-home');
// Production ACC -> native worker -> controlled AppKit event receiver.
// RUYI_P5_INPUT_REQUIRED=1 makes unavailable AX/event permission or locked desktop a failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS INPUT EVENTS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-events-'));
process.env.RUYI_HOME = path.join(root, 'data');
const reports = [];
let fixture, client, runtime, launched, watchdogWorker;
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Controlled event receiver timed out');
}
async function command(text) {
  const offset = reports.length;
  fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function observed() { return command('state'); }
async function trackClipboard(text) { await command('clipboard-track ' + Buffer.from(text, 'utf8').toString('base64')); }
async function runWatchdog(testing) {
  const stalledText = 'P5 owned watchdog fixture ' + process.pid;
  await trackClipboard(stalledText);
  const watchdogStarted = Date.now();
  watchdogWorker = cp.spawn(testing, ['--input-session'], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  watchdogWorker.stdout.resume(); watchdogWorker.stderr.resume();
  watchdogWorker.stdin.write(JSON.stringify({ id: 1, version: 1, op: 'test_stall_clipboard', text: stalledText }) + '\n');
  const temporary = await until(async () => { const state = await observed(); return state.temporaryClipboardOwned && state; }, 5000);
  t.ok(temporary.temporaryClipboardOwned, 'blocked native fixture owns a tracked temporary clipboard version');
  if (process.env.RUYI_P5_WATCHDOG_FAIL_AFTER_WRITE === '1') throw new Error('Injected premature watchdog-fixture failure');
  await until(() => watchdogWorker.exitCode !== null || watchdogWorker.signalCode !== null, 15000);
  const watchdogState = await observed();
  t.ok(watchdogWorker.exitCode === 70 && Date.now() - watchdogStarted < 15000,
    'production reader watchdog terminates a blocked native main thread within its fixed deadline');
  t.ok(watchdogState.clipboardPreserved, 'watchdog restores the owned all-format clipboard snapshot from its cleanup thread');
}
function point(bounds) { return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }; }
function diagnostic(label, value) { if (!value.ok) console.log(label + ' ' + JSON.stringify(value)); }
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac input event backend'); return; }
    const helper = buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const testing = buildMacAutomationHelper({ output: path.join(root, 'testing-helper'), testing: true });
    const stateRun = cp.spawnSync(testing, [], { input: JSON.stringify({ version: 1, op: 'test_input_state' }), encoding: 'utf8', timeout: 5000 });
    const stateContract = JSON.parse(stateRun.stdout);
    t.ok(stateRun.status === 0 && stateContract.admitted && stateContract.active_write_retained
      && stateContract.stopped_write_refused && stateContract.prior_snapshot_retained && stateContract.invalid_pointer_refused,
      'native clipboard transaction rejects admission after stop and retains an active owned snapshot');
    t.ok(stateContract.allocation_failure_preserved && stateContract.stopped_key_refused
      && stateContract.stopped_pointer_refused && stateContract.stopped_post_cancelled,
      'stop wins keyboard, chord, pointer and wheel admission with typed cancellation while ordinary post failures remain input_failed');
    const prodState = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'test_input_state' }), encoding: 'utf8', timeout: 5000 });
    t.ok(JSON.parse(prodState.stdout).code === 'invalid_args', 'production helper excludes the input-state test protocol');
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    if (!status.inputReady) {
      if (process.env.RUYI_P5_INPUT_REQUIRED === '1') t.fail('real events require Accessibility, event-post permission and an unlocked desktop');
      else console.log('SKIP controlled input until Accessibility/event posting are authorized and the desktop is unlocked');
      return;
    }
    const binary = path.join(root, 'event-fixture');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (built.status !== 0) throw new Error(built.stderr);
    const watchdogOnly = process.env.RUYI_P5_WATCHDOG_ONLY === '1';
    fixture = cp.spawn(binary, watchdogOnly ? ['--clipboard-only'] : [], {
      env: { ...fixtureChildEnv(), RUYI_P5_CLIPBOARD_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
      }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    if (watchdogOnly) {
      const seed = await command('seed-clipboard');
      t.ok(seed.clipboardSnapshot && seed.clipboardPreserved, 'nonactivating fixture preserves the pre-test clipboard before its owned seed');
      if (!seed.clipboardSnapshot) throw new Error('Cannot preserve the pre-test clipboard');
      await runWatchdog(testing);
      return;
    }
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'auditBridgedWriteCoverage']);
    runtime = S.ProcessRuntime;
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    client = new S.McpStdioClient({ id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['type_text', 'press_key', 'hotkey', 'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'scroll_at',
      'get_mouse_position', 'launch_application'].every(name => names.includes(name)), 'actual MCP discovers ready native input and application tools');
    t.ok(S.auditBridgedWriteCoverage(names).uncovered.length === 0, 'new input registrations preserve live file-write checkpoint coverage');
    const windows = await client.callTool('list_windows', {});
    const row = windows.windows.find(window => window.pid === fixture.pid && window.handle === ready.id);
    if (!row) throw new Error('Controlled event receiver window was not observed');
    let target = row.target;
    async function stopWorkerAfter(eventName, action) {
      const offset = reports.length;
      const pending = action();
      try {
        await until(() => reports.slice(offset).some(report => report.event === eventName));
        const table = snapshotProcessTable();
        const descendants = table ? ownDescendants(table, client.child.pid).descendants : [];
        const worker = descendants.find(row => {
          const command = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
          return command === helper + ' --input-session';
        });
        if (!worker) throw new Error('Owned persistent native worker was not observed ' + JSON.stringify({ root: client.child.pid,
          descendants: descendants.map(row => ({ pid: row.pid, ppid: row.ppid, name: row.name })) }));
        const current = snapshotProcessTable()?.find(row => row.pid === worker.pid && row.created === worker.created);
        const invocation = cp.spawnSync('/bin/ps', ['-p', String(worker.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
        if (!current || invocation !== helper + ' --input-session') throw new Error('Owned worker identity changed before controlled stop');
        process.kill(worker.pid, 'SIGTERM');
        const result = await pending;
        await until(() => !snapshotProcessTable()?.some(row => row.pid === worker.pid && row.created === worker.created));
        return result;
      } finally {
        await pending;
        await observed();
      }
    }
    async function refreshTarget() {
      const windows = await client.callTool('list_windows', {});
      target = windows.windows.find(window => window.pid === fixture.pid && window.handle === ready.id).target;
    }
    const focus = await client.callTool('focus_window', { target });
    t.ok(focus.ok && focus.foreground_verified, 'input starts with the exact owned window in foreground');
    const invalid = await client.callTool('hotkey', { keys: 'cmd++', target });
    t.ok(!invalid.ok && invalid.code === 'invalid_args', 'empty chord components are refused before input');
    const unknown = await client.callTool('press_key', { key: 'unknown-key', target });
    t.ok(!unknown.ok && unknown.code === 'invalid_args', 'unknown Mac key is refused before input');
    const initialState = await observed();
    const typed = await client.callTool('type_text', { text: 'abc', target, interval: 0.01 });
    diagnostic('Type diagnostic', typed);
    const typedState = await until(async () => { const state = await observed(); return state.text === 'abc' && state; });
    t.ok(typed.ok && typed.method === 'typewrite' && typedState.counts.key_down > (initialState.counts.key_down || 0),
      'short text reaches the real AppKit editor through keyboard events');
    const select = await client.callTool('hotkey', { keys: ['cmd', 'a'], target });
    const directChinese = await client.callTool('type_text', { text: '直接中文😀', use_clipboard: false, interval: 0, target });
    diagnostic('Unicode diagnostic', directChinese);
    const directState = await until(async () => { const state = await observed(); return state.text === '直接中文😀' && state; });
    t.ok(select.ok && directChinese.ok && directState.text === '直接中文😀', 'Cmd+A and direct Unicode events preserve Chinese and surrogate pairs');
    const seeded = await command('seed-clipboard');
    t.ok(seeded.clipboardSnapshot && seeded.clipboardPreserved, 'fixture saves the current clipboard immediately before seeding its own image and private format');
    if (!seeded.clipboardSnapshot) throw new Error('Cannot safely seed the controlled clipboard');
    await client.callTool('hotkey', { keys: 'cmd+a', target });
    const sample = '第一行 中文😀\nsecond line';
    await trackClipboard(sample);
    const pasted = await client.callTool('type_text', { text: sample, target });
    diagnostic('Paste diagnostic', pasted);
    const pasteState = await until(async () => { const state = await observed(); return state.text === sample && state; });
    t.ok(pasted.ok && pasted.method === 'clipboard' && pasted.route === 'non_ascii' && pasteState.text === sample,
      'automatic Chinese multiline route uses real Cmd+V and preserves text verbatim');
    t.ok(pasted.restore === 'done' && pasteState.clipboardPreserved, 'Cmd+V restores the prior image and private clipboard bytes');
    await client.callTool('hotkey', { keys: 'cmd+a', target });
    await trackClipboard('搜索词');
    const enter = await client.callTool('type_text', { text: '搜索词\n', target });
    const enterState = await until(async () => { const state = await observed(); return state.text === '搜索词\n' && state; });
    t.ok(enter.ok && enter.trailing_enter === 1 && enterState.text === '搜索词\n', 'auto-pasted single-line trailing newline becomes a real Enter');
    await client.callTool('hotkey', { keys: 'cmd+a', target });
    await command('change-on-paste');
    await trackClipboard('受控并发剪贴板测试');
    const changedPaste = await client.callTool('type_text', { text: '受控并发剪贴板测试', target });
    const changedState = await observed();
    t.ok(changedPaste.ok && changedPaste.restore === 'skipped_changed' && changedState.clipboardChanged,
      'clipboard changed by another writer during paste is preserved');
    await command('seed-clipboard');
    await client.callTool('hotkey', { keys: 'cmd+a', target });
    await command('observe-paste');
    await trackClipboard('中途停止粘贴');
    const stoppedPaste = await stopWorkerAfter('paste-observed', () => client.callTool('type_text', { text: '中途停止粘贴', target }));
    const stoppedPasteState = await observed();
    diagnostic('Stopped paste diagnostic', stoppedPaste);
    t.ok(!stoppedPaste.ok && stoppedPaste.code === 'input_cancelled' && stoppedPaste.action_sent
      && stoppedPaste.restore === 'done' && stoppedPasteState.clipboardPreserved,
      'SIGTERM during real Cmd+V unwinds and restores the owned all-format clipboard snapshot');
    t.ok(stoppedPasteState.modifierFlags === 0, 'stopped paste leaves no synthetic modifier held');
    await refreshTarget();
    await runWatchdog(testing);
    const padPoint = point(ready.pad);
    await command('focus-pad');
    const beforeMouse = await observed();
    const moved = await client.callTool('mouse_move', { ...padPoint, duration: 0.15, target });
    diagnostic('Mouse move diagnostic', moved);
    const position = await client.callTool('get_mouse_position', {});
    t.ok(moved.ok && moved.reached && Math.abs(position.x-padPoint.x) <= 2 && Math.abs(position.y-padPoint.y) <= 2,
      'logical-point pointer movement is confirmed by an independent cursor observation');
    const clicked = await client.callTool('mouse_click', { ...padPoint, clicks: 2, interval: 0.1, target });
    diagnostic('Click diagnostic', clicked);
    const right = await client.callTool('mouse_click', { ...padPoint, button: 'right', target });
    const middle = await client.callTool('mouse_click', { ...padPoint, button: 'middle', target });
    const afterClick = await observed();
    t.ok(clicked.ok && afterClick.counts.left_down - (beforeMouse.counts.left_down || 0) === 2
      && afterClick.counts.left_down === afterClick.counts.left_up, 'double click reaches the owned view with balanced button events');
    t.ok(right.ok && middle.ok && afterClick.counts.right_down === afterClick.counts.right_up
      && afterClick.counts.middle_down === afterClick.counts.middle_up, 'right and middle clicks reach the receiver and release their buttons');
    const scroll = await client.callTool('mouse_scroll', { ...padPoint, clicks: -3, target });
    const horizontal = await client.callTool('mouse_scroll', { ...padPoint, clicks: 2, direction: 'horizontal', target });
    const afterScroll = await observed();
    diagnostic('Scroll diagnostic', scroll); diagnostic('Horizontal diagnostic', horizontal);
    t.ok(scroll.ok && horizontal.ok && afterScroll.counts.vertical_scroll > 0 && afterScroll.counts.horizontal_scroll > 0,
      'vertical and horizontal wheel events reach the correct owned view');
    const drag = await client.callTool('mouse_drag', { start_x: padPoint.x-80, start_y: padPoint.y,
      end_x: padPoint.x+80, end_y: padPoint.y, duration: 0.3, target });
    diagnostic('Drag diagnostic', drag);
    const afterDrag = await observed();
    t.ok(drag.ok && drag.reached && afterDrag.counts.dragged > 0 && afterDrag.counts.left_down === afterDrag.counts.left_up,
      'drag stays in the exact target and releases the owned button');
    const outside = await client.callTool('mouse_click', { x: -99999, y: -99999, target });
    const afterOutside = await observed();
    t.ok(!outside.ok && outside.code === 'point_outside_target' && afterOutside.counts.left_down === afterDrag.counts.left_down,
      'off-target coordinates are refused before any click');
    await command('floating');
    const floatingClick = await client.callTool('mouse_click', { ...padPoint, target });
    const floatingState = await observed();
    t.ok(!floatingClick.ok && floatingClick.code === 'target_occluded' && floatingState.counts.left_down === afterOutside.counts.left_down,
      'an AX-hidden same-process floating panel cannot intercept a click intended for the bound window');
    await command('focus-pad');
    await command('cover');
    const beforeRefused = await observed();
    const wrongFocus = await client.callTool('type_text', { text: 'MUST NOT TYPE', target });
    const covered = await client.callTool('mouse_click', { ...padPoint, target });
    const afterRefused = await observed();
    t.ok(!wrongFocus.ok && wrongFocus.code === 'focus_changed' && afterRefused.text === beforeRefused.text,
      'changed same-process focus refuses keyboard input without editing the prior target');
    t.ok(!covered.ok && afterRefused.counts.left_down === beforeRefused.counts.left_down,
      'covered target refuses the mouse action before clicking');
    await command('focus-pad');
    await command('steal-focus');
    const interrupted = await client.callTool('mouse_drag', { start_x: padPoint.x-80, start_y: padPoint.y,
      end_x: padPoint.x+80, end_y: padPoint.y, duration: 1, target });
    const interruptedState = await observed();
    t.ok(!interrupted.ok && interrupted.action_sent && interrupted.outcome === 'unconfirmed', 'focus change during a real drag reports its partial side effect');
    t.ok(interruptedState.counts.left_down === interruptedState.counts.left_up, 'interrupted drag releases its owned button');
    await command('focus-pad');
    await until(async () => {
      const windows = await client.callTool('list_windows', {});
      const active = await client.callTool('get_active_window', {});
      return active.window?.handle === ready.id && !windows.windows.some(window => window.pid === fixture.pid && window.handle !== ready.id);
    });
    const recovery = await client.callTool('mouse_click', { ...padPoint, target });
    diagnostic('Recovery diagnostic', recovery);
    t.ok(recovery.ok, 'input works again after focus recovery and partial-action cleanup');
    await command('observe-drag');
    const stoppedDrag = await stopWorkerAfter('drag-observed', () => client.callTool('mouse_drag', {
      start_x: padPoint.x-80, start_y: padPoint.y, end_x: padPoint.x+80, end_y: padPoint.y, duration: 1, target }));
    const stoppedDragState = await observed();
    diagnostic('Stopped drag diagnostic', stoppedDrag);
    t.ok(!stoppedDrag.ok && stoppedDrag.code === 'input_cancelled' && stoppedDrag.action_sent,
      'SIGTERM during a real drag reports the already-posted partial action');
    t.ok(!stoppedDragState.leftHeld && stoppedDragState.counts.left_down === stoppedDragState.counts.left_up,
      'native worker stop releases the owned drag button in the actual desktop session');
    await refreshTarget();
    const missing = await client.callTool('launch_application', { path: path.join(root, 'missing.app') });
    t.ok(!missing.ok && missing.code === 'application_not_found', 'unresolvable application produces a typed failure');
    const app = path.join(root, 'Controlled Input.app');
    const contents = path.join(app, 'Contents'); fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.copyFileSync(binary, path.join(contents, 'MacOS', 'InputFixture'));
    fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict>'
      + '<key>CFBundleExecutable</key><string>InputFixture</string><key>CFBundleIdentifier</key><string>org.ruyi.p5.input.fixture.' + process.pid + '</string>'
      + '<key>CFBundleName</key><string>P5 Controlled Input</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    const signed = cp.spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app], { encoding: 'utf8', timeout: 10000 });
    if (signed.status !== 0) throw new Error(signed.stderr);
    const launch = await client.callTool('launch_application', { path: app, args: '--launch-only', ready_timeout: 2 });
    diagnostic('Launch diagnostic', launch);
    if (launch.pid) launched = { pid: launch.pid, start: launch.process_start };
    // LaunchServices resolves application URLs; Foundation can spell /private/tmp as /tmp.
    // Compare the actual existing directory identity rather than its incoming spelling.
    const requestedPath = fs.realpathSync.native(app);
    const actualPath = typeof launch.path === 'string' ? fs.realpathSync.native(launch.path) : null;
    console.log('INFO LaunchServices path identity ' + JSON.stringify({ requested: app, returned: launch.path, requestedPath, actualPath }));
    t.ok(launch.ok && launch.success && launch.pid > 1 && launch.process_start && actualPath === requestedPath && launch.launched_via === 'LaunchServices',
      'LaunchServices starts the controlled app and confirms actual bundle and process identity');
    t.ok(launch.ready && launch.window.pid === launch.pid && launch.window.target.ref, 'application readiness includes an actually observed window target');
    if (launch.pid) await until(() => !snapshotProcessTable()?.some(row => row.pid === launch.pid), 6000);
    t.ok(!launch.pid || !snapshotProcessTable()?.some(row => row.pid === launch.pid), 'launched fixture terminates on its own bounded timer');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (watchdogWorker) {
      if (watchdogWorker.exitCode === null && watchdogWorker.signalCode === null) killOwnTree(watchdogWorker);
      await until(() => watchdogWorker.exitCode !== null || watchdogWorker.signalCode !== null, 5000)
        .catch(error => t.fail('Watchdog fixture cleanup ' + error.message));
      if (watchdogWorker.exitCode === null && watchdogWorker.signalCode === null) {
        // Keep the fixture's original clipboard snapshot alive until the owned
        // writer has actually exited, including a failed first cleanup attempt.
        const exited = new Promise(resolve => watchdogWorker.once('exit', resolve));
        killOwnTree(watchdogWorker);
        await exited;
      }
      t.ok(watchdogWorker.exitCode !== null || watchdogWorker.signalCode !== null,
        'owned watchdog writer is reaped before final clipboard ownership observation');
    }
    if (client?.child) {
      const child = client.child; client.kill(); const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned input MCP and native worker cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      await observed().catch(error => t.fail('Clipboard ownership refresh ' + error.message));
      fixture.stdin.write('quit\n');
      await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 3000).catch(() => killOwnTree(fixture));
    }
    if (reports.some(report => report.event === 'seed-clipboard' && report.clipboardSnapshot))
      t.ok(reports.some(report => report.event === 'clipboard-restore' && report.restored), 'fixture restores the pre-test clipboard after its last controlled content');
    if (fixture) t.ok(fixture.exitCode !== null || fixture.signalCode !== null, 'owned input receiver is reaped');
    if (launched) t.ok(!snapshotProcessTable()?.some(row => row.pid === launched.pid), 'LaunchServices fixture has no remaining process');
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();

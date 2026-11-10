'use strict';
require('./lib/self-isolate-home');
// P5-02 first cut. Mutations target only a self-owned AppKit window.
// The fixture keeps the prior clipboard in native memory and restores it when its last owned write is current.
// RUYI_P5_INPUT_EXPIRY_TEST=1 also waits for the real five-minute reference TTL.
// RUYI_P5_INPUT_REQUIRED=1 requires an unlocked desktop with AX and screen permission.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS WINDOW CLIPBOARD');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-input-'));
process.env.RUYI_HOME = path.join(root, 'data');
const events = [];
let fixture, client, foreignClient, runtime;
async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Controlled fixture condition timed out');
}
async function clipboardVersion(value) {
  const command = 'clipboard-expect ' + value;
  fixture.stdin.write(command + '\n');
  await until(() => events.find(event => event.event === command));
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac window/clipboard backend'); return; }
    const helper = buildMacAutomationHelper({ output: path.join(root, 'automation-helper') });
    const invalidFrames = [null, { id: true, version: 1, op: 'window.list' },
      { id: 1.5, version: 1, op: 'window.list' }, { id: 2, version: true, op: 'window.list' },
      { id: 3, version: 1, op: 'window.list', unexpected: true }];
    const sessionProtocol = cp.spawnSync(helper, ['--input-session'], {
      input: invalidFrames.map(frame => JSON.stringify(frame)).join('\n') + '\n', encoding: 'utf8', timeout: 5000 });
    const rejectedFrames = sessionProtocol.stdout.trim().split('\n').map(line => JSON.parse(line));
    t.ok(sessionProtocol.status === 0 && rejectedFrames.length === invalidFrames.length
      && rejectedFrames.every(frame => frame.ok === false && frame.code === 'invalid_args'),
      'native input session rejects malformed frames and exits cleanly on EOF');
    const oversized = cp.spawnSync(helper, ['--input-session'], { input: 'x'.repeat(65537), encoding: 'utf8', timeout: 5000 });
    t.ok(oversized.status === 65 && !oversized.stdout, 'native session bounds an unterminated input frame');
    const status = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const state = JSON.parse(status.stdout);
    if (!state.ready || !state.windowReady || !state.clipboardReady) {
      if (process.env.RUYI_P5_INPUT_REQUIRED === '1') t.fail('real input acceptance requires AX and screen permission and an unlocked desktop');
      else console.log('SKIP controlled window/clipboard acceptance until AX and screen permission are granted and desktop is unlocked');
      return;
    }
    const binary = path.join(root, 'fixture');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-capture-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (built.status !== 0) throw new Error(built.stderr);
    let pending = '';
    fixture = cp.spawn(binary, [], { env: { ...fixtureChildEnv(), RUYI_P5_CLIPBOARD_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    fixture.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        events.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
      }
    });
    fixture.stderr.resume();
    const ready = await until(() => events.find(event => event.event === 'ready'));
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'auditBridgedWriteCoverage']);
    runtime = S.ProcessRuntime;
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const connection = { id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } };
    client = new S.McpStdioClient(connection);
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['list_windows', 'get_active_window', 'focus_window', 'move_window', 'resize_window', 'minimize_window',
      'maximize_window', 'close_window', 'get_clipboard', 'set_clipboard', 'get_clipboard_image', 'set_clipboard_image']
      .every(name => names.includes(name)), 'ready Mac window and clipboard tools are discovered through real MCP');
    t.ok(S.auditBridgedWriteCoverage(names).uncovered.length === 0, 'all live clipboard file writers retain checkpoint coverage');
    const listed = await client.callTool('list_windows', {});
    let row = listed.windows.find(window => window.handle === ready.id && window.pid === fixture.pid);
    t.ok(listed.ok && row && row.target.process_start && row.target.bounds.width > 0, 'actual window observation returns process start identity and bounds');
    if (!row) throw new Error('Owned window missing');
    const unknown = await client.callTool('focus_window', { target: { ...row.target, ref: 'another-worker-ref' } });
    t.ok(!unknown.ok && unknown.code === 'target_stale', 'unknown worker reference is refused before mutation');
    for (const field of ['pid', 'handle']) {
      for (const value of [true, row.target[field] + 0.5]) {
        const invalid = await client.callTool('focus_window', { target: { ...row.target, [field]: value } });
        t.ok(!invalid.ok && invalid.code === 'target_invalid', field + ' rejects boolean and fractional identity ' + String(value));
      }
    }
    const stale = await client.callTool('focus_window', { target: { ...row.target, process_start: '0:0' } });
    t.ok(!stale.ok && stale.code === 'target_stale', 'stale process identity is refused before window mutation');
    const original = row.target;
    const focused = await client.callTool('focus_window', { target: row.target });
    if (!focused.ok) console.log('Focus diagnostic ' + JSON.stringify(focused));
    t.ok(focused.ok && focused.foreground_verified, 'bound fixture window acquires verified foreground focus');
    const active = await client.callTool('get_active_window', {});
    t.ok(active.ok && active.window.handle === ready.id && active.window.pid === fixture.pid, 'active-window query agrees with the bound target');
    fixture.stdin.write('overlap\n');
    await until(() => events.find(event => event.event === 'overlap'));
    const other = await until(async () => {
      const overlapping = await client.callTool('list_windows', {});
      return overlapping.windows?.find(window => window.pid === fixture.pid && window.title === 'P5 Distinct Overlap');
    }, 3000);
    const otherFocus = other && await client.callTool('focus_window', { target: other.target });
    const primaryFocus = await client.callTool('focus_window', { target: row.target });
    const primaryActive = await client.callTool('get_active_window', {});
    if (!otherFocus?.ok || !primaryFocus.ok || primaryActive.window?.handle !== ready.id)
      console.log('Overlap diagnostic ' + JSON.stringify({ otherFocus, primaryFocus,
        active: { ok: primaryActive.ok, code: primaryActive.code, handle: primaryActive.window?.handle } }));
    t.ok(otherFocus?.ok && primaryFocus.ok && primaryActive.window?.handle === ready.id,
      'overlapping same-process windows keep distinct exact foreground identities');
    t.ok(other.x === row.x && other.y === row.y && other.width === row.width && other.height === row.height,
      'overlapping fixture windows have identical actual bounds and distinct titles');
    foreignClient = new S.McpStdioClient({ ...connection,
      env: { ...connection.env, WCW_DATA_DIR: path.join(root, 'foreign-acc-data') } });
    await foreignClient.start();
    const foreignRef = await foreignClient.callTool('focus_window', { target: row.target });
    t.ok(!foreignRef.ok && foreignRef.code === 'target_stale', 'a second live native worker cannot consume another worker reference');
    const foreignChild = foreignClient.child; foreignClient.kill();
    const foreignClean = await runtime.waitForCleanup(foreignChild, 3000);
    t.ok(foreignClean && !foreignClean.incomplete, 'foreign-reference MCP fixture cleanup is confirmed');
    foreignClient = null;
    const moved = await client.callTool('move_window', { target: row.target, x: row.x + 30, y: row.y + 30 });
    if (!moved.ok) console.log('Move diagnostic ' + JSON.stringify(moved));
    t.ok(moved.ok && moved.matched && moved.window.x === row.x + 30 && moved.window.y === row.y + 30, 'move verifies actual logical-point position');
    row = moved.window || row;
    const oldGeometry = await client.callTool('focus_window', { target: original });
    t.ok(!oldGeometry.ok && oldGeometry.code === 'window_changed', 'old geometry is refused after a real window move');
    const resized = await client.callTool('resize_window', { target: row.target, width: 720, height: 500 });
    if (!resized.ok) console.log('Resize diagnostic ' + JSON.stringify(resized));
    t.ok(resized.ok && resized.matched && resized.window.width === 720 && resized.window.height === 500, 'resize verifies actual window dimensions');
    row = resized.window || row;
    const max = await client.callTool('maximize_window', { target: row.target });
    if (!max.ok) console.log('Maximize diagnostic ' + JSON.stringify(max));
    t.ok(max.ok && max.matched, 'maximize fits the observed display work area');
    row = max.window || row;
    const minimized = await client.callTool('minimize_window', { target: row.target });
    if (!minimized.ok) console.log('Minimize diagnostic ' + JSON.stringify(minimized));
    t.ok(minimized.ok && minimized.matched, 'minimize confirms the actual accessibility state');
    row = minimized.window || row;
    fixture.stdin.write('reject-close\n');
    await until(() => events.find(event => event.event === 'reject-close'));
    const refusedClose = await client.callTool('close_window', { target: row.target });
    t.ok(!refusedClose.ok && refusedClose.code === 'window_action_unconfirmed' && refusedClose.action_sent
      && refusedClose.outcome === 'unconfirmed', 'minimized window refusal cannot be reported as a successful close');
    fixture.stdin.write('allow-close\n');
    await until(() => events.find(event => event.event === 'allow-close'));
    const restored = await client.callTool('focus_window', { target: row.target });
    if (!restored.ok) console.log('Restore diagnostic ' + JSON.stringify(restored));
    t.ok(restored.ok && restored.foreground_verified, 'focus restores the same minimized window identity');
    row = restored.window || row;
    if (process.env.RUYI_P5_INPUT_EXPIRY_TEST === '1') {
      const expiredTarget = row.target;
      console.log('Waiting for actual five-minute native window-reference expiry');
      await new Promise(resolve => setTimeout(resolve, 302000));
      const expired = await client.callTool('focus_window', { target: expiredTarget });
      t.ok(!expired.ok && expired.code === 'target_stale', 'real idle reference TTL rejects the old window target');
      const observed = await client.callTool('list_windows', {});
      row = observed.windows.find(window => window.handle === ready.id && window.pid === fixture.pid);
      t.ok(row && row.target.ref !== expiredTarget.ref, 'fresh observation replaces the expired reference for the same actual window');
    }
    t.ok(ready.clipboardSnapshot, 'fixture can preserve all prior clipboard types within its capacity limit');
    if (ready.clipboardSnapshot) {
      const sample = '第一行 中文😀\nsecond line';
      const written = await client.callTool('set_clipboard', { text: sample });
      t.ok(written.ok && written.length === [...sample].length, 'Unicode clipboard write reports character count');
      await clipboardVersion(written.change_count);
      const read = await client.callTool('get_clipboard', {});
      t.ok(read.ok && read.text === sample && !read.has_image, 'system clipboard text round-trips through the production tool');
      const imagePath = path.join(root, 'sample.png');
      fs.writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP8//8/AwMDEwMYAAAkBgMBXaJOiAAAAABJRU5ErkJggg==', 'base64'));
      const imageWrite = await client.callTool('set_clipboard_image', { path: imagePath });
      t.ok(imageWrite.ok && imageWrite.width === 2 && imageWrite.height === 2, 'native image clipboard write reports decoded dimensions');
      await clipboardVersion(imageWrite.change_count);
      const imageRead = await client.callTool('get_clipboard_image', { max_width: 1 });
      t.ok(imageRead.ok && imageRead.has_image && imageRead.width === 1 && imageRead.original_width === 2 && imageRead.image_base64,
        'image clipboard read preserves original dimensions and scales only its returned image');
      const savedPath = path.join(root, 'saved.png');
      const imageSaved = await client.callTool('get_clipboard_image', { save_path: savedPath });
      t.ok(imageSaved.ok && fs.existsSync(savedPath) && imageSaved.width === 2, 'clipboard image saves a full-resolution PNG through the normal path');
      const protectedRead = await client.callTool('get_clipboard_image', { save_path: '/System/ruyi-p5-clipboard-never-write.png' });
      t.ok(!protectedRead.ok && protectedRead.code === 'path_protected', 'protected clipboard destination is refused before native observation');
    }
    const closed = await client.callTool('close_window', { target: row.target });
    t.ok(closed.ok && closed.matched, 'close confirms the owned window becomes unavailable');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const ownedClient of [foreignClient, client]) {
      if (!ownedClient?.child) continue;
      const child = ownedClient.child; ownedClient.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned MCP subtree cleanup is confirmed');
    }
    if (fixture) {
      if (fixture.exitCode === null && fixture.signalCode === null) {
        fixture.stdin.write('quit\n');
        await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 3000).catch(() => killOwnTree(fixture));
      }
      const restored = events.find(event => event.event === 'clipboard-restore');
      if (events.find(event => event.event === 'ready')?.clipboardSnapshot)
        t.ok(restored?.restored, 'native fixture restores the original clipboard after its last owned write');
      t.ok(fixture.exitCode !== null || fixture.signalCode !== null, 'controlled native fixture exits after acceptance');
    }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();

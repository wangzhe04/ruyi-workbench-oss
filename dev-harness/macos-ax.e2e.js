'use strict';
require('./lib/self-isolate-home');
// Real production MCP -> native AX -> self-owned AppKit controls. Never touches the clipboard.
// RUYI_P5_AX_REQUIRED=1 requires AX permission. RUYI_P5_AX_EXPIRY_TEST=1 waits for the actual 60-second TTL.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS AX');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-ax-'));
process.env.RUYI_HOME = path.join(root, 'data');
let fixture, client, foreign, runtime;
const reports = [];
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Controlled accessibility condition timed out');
}
async function command(text) {
  const offset = reports.length; fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function call(name, args) {
  const result = await client.callTool(name, args);
  if (!result.ok) throw new Error(name + ' ' + JSON.stringify(result));
  return result;
}
function flatten(node) { return [node, ...(node.children || []).flatMap(flatten)]; }
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac native AX backend'); return; }
    const helper = buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    if (!JSON.parse(probe.stdout).axReady) {
      if (process.env.RUYI_P5_AX_REQUIRED === '1') t.fail('AX acceptance requires Accessibility and an unlocked desktop');
      else console.log('SKIP authorize Accessibility and unlock the desktop for real AX acceptance');
      return;
    }
    const binary = path.join(root, 'ax-fixture');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', path.join(__dirname, 'fixtures/macos-ax-window.m'), '-o', binary],
    { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    fixture = cp.spawn(binary, [], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', bytes => {
      buffer += bytes; let end;
      while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    const testing = buildMacAutomationHelper({ output: path.join(root, 'testing-helper'), testing: true });
    const contract = { version: 1, op: 'test_ax_state', pid: fixture.pid, handle: ready.id };
    const stateRun = cp.spawnSync(testing, [], { input: JSON.stringify(contract), encoding: 'utf8', timeout: 8000 });
    const state = JSON.parse(stateRun.stdout);
    t.ok(stateRun.status === 0 && state.expired && state.bounded && state.retained && state.denied_reset
      && state.locked_reset && state.provider_reset && state.fresh_after_recovery,
    'controlled native lifecycle clears window and element refs immediately on denied/locked states and enforces capacity/TTL');
    const excluded = cp.spawnSync(helper, [], { input: JSON.stringify(contract), encoding: 'utf8', timeout: 3000 });
    t.ok(JSON.parse(excluded.stdout).code === 'invalid_args', 'production helper excludes the AX state fixture protocol');
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'auditBridgedWriteCoverage']); runtime = S.ProcessRuntime;
    const connection = { id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop,uia', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } };
    client = new S.McpStdioClient(connection); await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['ui_inspect', 'ui_find', 'ui_invoke'].every(name => names.includes(name)), 'real tools/list discovers all ready native AX tools');
    t.ok(S.auditBridgedWriteCoverage(names).uncovered.length === 0, 'native AX registration preserves file checkpoint coverage');
    const diag = await call('diagnostics', {});
    t.ok(diag.capabilities['desktop.accessibility'].ready && diag.optional.uia && !diag.unsupported_modules.uia,
      'diagnostics identifies the ready AXUIElement backend separately from Windows UIA packages');
    const rows = await call('list_windows', {});
    const row = rows.windows.find(window => window.pid === fixture.pid && window.handle === ready.id);
    if (!row) throw new Error('Controlled AX window missing');
    const target = row.target;
    await call('focus_window', { target });
    const tree = await call('ui_inspect', { target, max_depth: 8, max_nodes: 100 });
    const nodes = flatten(tree.tree);
    t.ok(tree.nodes >= 8 && nodes.some(node => node.automation_id === 'apply' && node.type === 'AXButton' && node.element_ref),
      'real AX traversal reports native roles, exact identifiers and private element references');
    t.ok(nodes.filter(node => node.bounds).every(node => Number.isFinite(node.center[0]) && Number.isFinite(node.center[1]))
      && tree.coordinate_space === 'macos_global_points', 'element geometry uses finite global logical-point bounds and centers');
    const limited = await call('ui_inspect', { target, max_depth: 0, max_nodes: 100 });
    t.ok(limited.nodes === 1 && limited.truncated && limited.truncated_by.includes('max_depth'), 'depth-limited tree explicitly reports unvisited children');
    const capped = await call('ui_inspect', { target, max_depth: 8, max_nodes: 1 });
    t.ok(capped.nodes === 1 && capped.truncated && capped.truncated_by.includes('max_nodes'), 'node limit is enforced before visiting further elements');
    const invalid = await client.callTool('ui_inspect', { target, max_depth: 21 });
    t.ok(!invalid.ok && invalid.code === 'invalid_args', 'out-of-range traversal depth is refused');
    async function find(identifier, extra = {}) {
      const result = await call('ui_find', { target, automation_id: identifier, ...extra });
      if (result.count !== 1) throw new Error('Expected one owned control ' + identifier + ' ' + JSON.stringify(result));
      return result.matches[0];
    }
    const draft = await find('draft');
    const focused = await call('ui_invoke', { target, element_ref: draft.element_ref, action: 'focus' });
    t.ok(focused.confirmed && focused.verification === 'attribute_readback', 'native AX focus is confirmed by the element attribute');
    const sample = 'AX 直接赋值 中文😀';
    const written = await call('ui_invoke', { target, element_ref: draft.element_ref, action: 'set_value', text: sample });
    const textState = await command('state');
    t.ok(written.confirmed && textState.text === sample, 'AXValue write preserves Chinese and surrogate pairs with exact receiver readback');
    const area = await find('text-area');
    const areaWrite = await call('ui_invoke', { target, element_ref: area.element_ref, action: 'set_value', text: sample });
    t.ok(area.value_settable && areaWrite.confirmed && (await command('state')).areaText === sample,
      'standard NSTextView writable AXValue supports confirmed text edits without an AXEnabled attribute');
    const readonly = await find('readonly-area');
    const refusedValue = await client.callTool('ui_invoke', { target, element_ref: readonly.element_ref, action: 'set_value', text: 'must stay unchanged' });
    t.ok(!readonly.value_settable && !refusedValue.ok && !refusedValue.action_sent && (await command('state')).readonlyText === 'read-only fixture',
      'read-only NSTextView refuses AXValue mutation before sending an action');
    let apply = await find('apply');
    const pressed = await call('ui_invoke', { target, element_ref: apply.element_ref });
    const applied = await command('state');
    t.ok(pressed.action_sent && pressed.confirmed === null && pressed.outcome === 'unconfirmed'
      && applied.applied === 1 && applied.result === sample, 'AXPress reports acceptance while the receiver independently confirms its actual effect');
    const duplicate = await call('ui_find', { target, name: 'duplicate', control_type: 'Button' });
    t.ok(duplicate.count === 2 && duplicate.matches[0].element_ref !== duplicate.matches[1].element_ref,
      'same-label controls remain separate explicit references');
    const second = duplicate.matches.find(node => node.automation_id === 'duplicate-two');
    await call('ui_invoke', { target, element_ref: second.element_ref });
    const duplicates = await command('state');
    t.ok(duplicates.duplicateOne === 0 && duplicates.duplicateTwo === 1, 'explicit reference invokes only the intended duplicate control');
    const disabled = await find('disabled');
    const refusedDisabled = await client.callTool('ui_invoke', { target, element_ref: disabled.element_ref });
    t.ok(disabled.enabled === false && !refusedDisabled.ok && refusedDisabled.code === 'element_not_actionable' && !refusedDisabled.action_sent,
      'disabled element is reported and refused before any action');
    const checkbox = await find('toggle');
    const toggled = await call('ui_invoke', { target, element_ref: checkbox.element_ref, action: 'toggle' });
    t.ok(toggled.confirmed && (await command('state')).toggle, 'checkbox toggle is confirmed by AX and the actual control state');
    const disclosure = await find('disclosure');
    const expanded = await call('ui_invoke', { target, element_ref: disclosure.element_ref, action: 'expand' });
    t.ok(expanded.confirmed && (await command('state')).expanded, 'supported AXExpanded setter confirms actual expansion');
    const collapsed = await call('ui_invoke', { target, element_ref: disclosure.element_ref, action: 'collapse' });
    t.ok(collapsed.confirmed && !(await command('state')).expanded, 'supported AXExpanded setter confirms actual collapse');
    const unsupported = await client.callTool('ui_invoke', { target, element_ref: apply.element_ref, action: 'expand' });
    t.ok(!unsupported.ok && unsupported.code === 'element_unsupported' && !unsupported.action_sent, 'unsupported pattern is refused before mutation');
    foreign = new S.McpStdioClient({ ...connection, env: { ...connection.env, WCW_DATA_DIR: path.join(root, 'foreign-data') } });
    await foreign.start();
    const foreignRows = await foreign.callTool('list_windows', {});
    const foreignTarget = foreignRows.windows.find(window => window.pid === fixture.pid && window.handle === ready.id).target;
    const foreignRef = await foreign.callTool('ui_invoke', { target: foreignTarget, element_ref: apply.element_ref });
    t.ok(!foreignRef.ok && foreignRef.code === 'element_stale' && !foreignRef.action_sent, 'a second live native session refuses another session element reference');
    await command('alternate');
    const wrongFocus = await client.callTool('ui_invoke', { target, element_ref: apply.element_ref });
    t.ok(!wrongFocus.ok && wrongFocus.code === 'focus_changed' && !wrongFocus.action_sent && (await command('state')).applied === 1,
      'same-process foreground change refuses the old window element before input');
    await command('focus');
    await until(async () => {
      const active = await client.callTool('get_active_window', {});
      return active.ok && active.window.pid === fixture.pid && active.window.handle === ready.id;
    });
    await command('move');
    await until(async () => {
      const observed = await client.callTool('ui_find', { target, automation_id: 'apply' });
      return observed.ok && observed.count === 1 && observed.matches[0].bounds.x !== apply.bounds.x;
    });
    const moved = await client.callTool('ui_invoke', { target, element_ref: apply.element_ref });
    if (!moved.ok) console.log('Moved element diagnostic ' + JSON.stringify(moved));
    t.ok(!moved.ok && moved.code === 'element_changed' && !moved.action_sent, 'changed element geometry invalidates the observed action signature');
    apply = await find('apply');
    await command('replace');
    const stale = await client.callTool('ui_invoke', { target, element_ref: apply.element_ref });
    t.ok(!stale.ok && ['element_stale', 'element_unsupported'].includes(stale.code) && !stale.action_sent,
      'removed element cannot be rebound to its same-label same-identifier replacement');
    apply = await find('apply');
    await call('ui_invoke', { target, element_ref: apply.element_ref });
    t.ok((await command('state')).applied === 2, 'fresh observation can act on the replacement control');
    const ghost = await find('ghost');
    await command('hide-ghost');
    const detached = await client.callTool('ui_invoke', { target, element_ref: ghost.element_ref });
    t.ok(!detached.ok && detached.code === 'element_stale' && !detached.action_sent && (await command('state')).ghostPressed === 0,
      'retained AX object with an old parent is refused after its parent stops listing it');
    const scrolledOut = await find('scrolled-out');
    t.ok(scrolledOut.offscreen && scrolledOut.visibility === 'outside_clip', 'screen-intersecting element outside its scroll viewport is reported outside the ancestor clip');
    const visible = await call('ui_find', { target, automation_id: 'scrolled-out', visible_only: true });
    t.ok(visible.count === 0, 'visible-only search excludes the clipped scroll child');
    const clipped = await client.callTool('ui_invoke', { target, element_ref: scrolledOut.element_ref });
    t.ok(!clipped.ok && clipped.code === 'element_not_actionable' && !clipped.action_sent && (await command('state')).applied === 2,
      'clipped scroll child cannot invoke its otherwise supported action');
    const menu = await call('ui_find', { target, scope: 'menu_bar', name: 'P5 Fixture Menu', control_type: 'MenuBarItem' });
    if (menu.count !== 1) throw new Error('Controlled menu missing ' + JSON.stringify(menu));
    await call('ui_invoke', { target, element_ref: menu.matches[0].element_ref });
    const item = await call('ui_find', { target, scope: 'menu_bar', name: 'Fixture Action', control_type: 'MenuItem', visible_only: true });
    if (item.count !== 1) throw new Error('Controlled menu item missing ' + JSON.stringify(item));
    await call('ui_invoke', { target, element_ref: item.matches[0].element_ref });
    const menuState = await until(async () => { const state = await command('state'); return state.menuInvoked === 1 && state; });
    t.ok(menuState.menuInvoked === 1, 'process-bound menu-bar observation and AXPress reach the real menu action');
    await command('stall');
    const began = Date.now();
    const stalled = await client.callTool('ui_inspect', { target, max_depth: 8 });
    const stalledMs = Date.now() - began;
    t.ok(!stalled.ok && stalled.code === 'accessibility_timeout' && !stalled.action_sent && stalledMs < 5000,
      'a real stalled accessibility provider fails within the bounded read deadline without mutation metadata');
    await command('unstall');
    if (process.env.RUYI_P5_AX_EXPIRY_TEST === '1') {
      const idle = await find('apply');
      console.log('Waiting for actual 60-second AX reference expiry');
      await new Promise(resolve => setTimeout(resolve, 62000));
      const expired = await client.callTool('ui_invoke', { target, element_ref: idle.element_ref });
      t.ok(!expired.ok && expired.code === 'element_stale' && !expired.action_sent, 'actual idle TTL expires the AX reference while its window reference remains valid');
      t.ok((await find('apply')).element_ref !== idle.element_ref, 'fresh observation creates a new element reference after expiry');
    }
    if (process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, 'ax.json'), JSON.stringify({ status: JSON.parse(probe.stdout), tree,
        actualState: await command('state'), stalledProvider: { code: stalled.code, elapsedMs: stalledMs } }, null, 2) + '\n');
    }
  } catch (error) {
    t.fail(error.stack || String(error));
    if (fixture && client?.child) {
      const state = await command('state').catch(() => null);
      const active = await client.callTool('get_active_window', {}).catch(() => null);
      console.log('Failure focus observation ' + JSON.stringify({ fixtureActive: state?.active, fixtureKeyWindow: state?.keyWindow,
        active: active && { ok: active.ok, code: active.code, pid: active.window?.pid, handle: active.window?.handle } }));
    }
  }
  finally {
    for (const connection of [foreign, client]) {
      if (!connection?.child) continue;
      const child = connection.child; connection.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned AX MCP and native worker cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.write('quit\n');
      try { await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000); }
      catch {
        killOwnTree(fixture);
        await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 3000).catch(error => t.fail(error.message));
      }
    }
    if (fixture) t.ok(fixture.exitCode !== null || fixture.signalCode !== null, 'owned accessibility provider exits after acceptance');
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();

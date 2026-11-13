'use strict';
require('./lib/self-isolate-home');
// RUYI_P5_FINDER_REQUIRED=1 opts into the shared Finder scenario. Requires no existing AXWindow.
// Closes only a freshly proved owned folder window, and leaves all uncertain state available for review.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { loadServerInternals } = require('./lib/server-internals');
const { snapshotProcessTable } = require('./lib/kill-own-tree');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS AX FINDER');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-finder-'));
const folder = path.join(root, 'Ruyi P5 Finder 中文 ' + process.pid);
process.env.RUYI_HOME = path.join(root, 'data');
let client, runtime, baseline, owned, verifier, finderBirth, launched = false, cleaned = false;
function evidence(name, value) {
  if (!process.env.RUYI_P5_EVIDENCE) return;
  fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, name + '.json'), JSON.stringify(value, null, 2) + '\n');
}
async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Finder fixture observation timed out');
}
async function call(name, args = {}) {
  const result = await client.callTool(name, args);
  if (!result.ok) throw new Error(name + ' ' + JSON.stringify(result));
  return result;
}
function snapshot() {
  const run = cp.spawnSync(verifier, [], { encoding: 'utf8', timeout: 8000 });
  if (run.status !== 0) throw new Error('Finder identity observation failed ' + run.stdout + run.stderr);
  return JSON.parse(run.stdout);
}
function flatten(node) { return [node, ...(node.children || []).flatMap(flatten)]; }
function prove(state, row) {
  const windows = state.windows.filter(window => window.role === 'AXWindow');
  const added = state.cgWindows.filter(window => !baseline.cgWindows.some(prior => prior.handle === window.handle));
  if (state.pid !== baseline.pid || snapshotProcessTable()?.find(process => process.pid === state.pid)?.created !== finderBirth
      || windows.length !== 1 || added.length !== 1 || added[0].handle !== row.handle)
    throw new Error('Finder window ownership changed');
  if (added[0].title !== row.title || added[0].bounds.X !== row.x || added[0].bounds.Y !== row.y
      || added[0].bounds.Width !== row.width || added[0].bounds.Height !== row.height)
    throw new Error('Finder WindowServer identity or geometry changed');
  const nodes = flatten(windows[0].tree);
  const expected = ['P5 child 中文', 'P5 proof.txt'].map(name => fs.realpathSync(path.join(folder, name))).sort();
  const actual = nodes.filter(node => node.url).map(node => fs.realpathSync(fileURLToPath(node.url))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
      || windows[0].tree.AXTitle !== path.basename(folder) || row.title !== path.basename(folder))
    throw new Error('Finder public content URLs do not match the exact controlled files');
  if (nodes.some(node => node.AXRole === 'AXTabGroup' || node.tabCount > 1))
    throw new Error('Finder fixture has additional or uncertain tabs');
  return { document: windows[0].document, actualContentPaths: actual, tabGroupObserved: false };
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac selected Finder scenario'); return; }
    if (process.env.RUYI_P5_FINDER_REQUIRED !== '1') { console.log('SKIP opt in with RUYI_P5_FINDER_REQUIRED=1 on an otherwise windowless Finder'); return; }
    verifier = path.join(root, 'finder-identity');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-finder-identity.m'), '-o', verifier], { encoding: 'utf8', timeout: 60000 });
    if (built.status !== 0) throw new Error(built.stderr);
    baseline = snapshot();
    finderBirth = snapshotProcessTable()?.find(process => process.pid === baseline.pid)?.created;
    if (!finderBirth) throw new Error('Cannot observe Finder process creation identity');
    evidence('baseline', baseline);
    if (baseline.windows.some(window => window.role !== 'AXScrollArea')
        || baseline.cgWindows.some(window => window.onScreen || window.title))
      throw new Error('Finder fixture requires no existing content windows, including hidden or minimized windows');
    t.ok(true, 'public AXWindows and all-space WindowServer baseline exclude existing Finder content windows');
    const helper = buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime']); runtime = S.ProcessRuntime;
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    client = new S.McpStdioClient({ id: 'ai-computer-control',
      command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop,uia', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    fs.mkdirSync(folder);
    fs.mkdirSync(path.join(folder, 'P5 child 中文'));
    fs.writeFileSync(path.join(folder, 'P5 proof.txt'), 'owned Finder fixture\n');
    launched = true;
    const opened = cp.spawnSync('/usr/bin/open', ['-a', '/System/Library/CoreServices/Finder.app', folder],
      { env: fixtureChildEnv(), encoding: 'utf8', timeout: 5000 });
    if (opened.status !== 0) throw new Error('Finder folder open failed ' + opened.stderr);
    let geometry = '', stableSince = 0;
    owned = await until(async () => {
      const row = (await call('list_windows')).windows.find(item => item.pid === baseline.pid && item.title === path.basename(folder));
      if (!row) return null;
      const current = JSON.stringify([row.handle, row.process_start, row.target.bounds]);
      if (current !== geometry) { geometry = current; stableSince = Date.now(); return null; }
      return Date.now() - stableSince >= 300 ? row : null;
    });
    const initial = snapshot();
    const identity = prove(initial, owned);
    evidence('owned-identity', { initial, identity, window: owned });
    t.ok(true, 'new Finder window exposes the exact controlled content file URIs and no additional tab surface');
    function rejects(changed) {
      try { prove(changed, owned); return false; }
      catch { return true; }
    }
    const wrongContent = structuredClone(initial);
    flatten(wrongContent.windows.find(window => window.role === 'AXWindow').tree).find(node => node.url).url =
      flatten(initial.windows.find(window => window.role === 'AXWindow').tree).filter(node => node.url)[1].url;
    t.ok(rejects(wrongContent), 'ownership verifier rejects a duplicate URL in place of the exact controlled content set');
    const additionalWindow = structuredClone(initial);
    additionalWindow.windows.push(initial.windows.find(window => window.role === 'AXWindow'));
    t.ok(rejects(additionalWindow), 'ownership verifier rejects an additional Finder content window');
    const uncertainTabs = structuredClone(initial);
    uncertainTabs.windows.find(window => window.role === 'AXWindow').tree.children.push({ AXRole: 'AXTabGroup' });
    t.ok(rejects(uncertainTabs), 'ownership verifier rejects a tab group even when its AXTabs count is unavailable');
    const multipleTabs = structuredClone(initial);
    multipleTabs.windows.find(window => window.role === 'AXWindow').tree.tabCount = 2;
    t.ok(rejects(multipleTabs), 'ownership verifier rejects multiple publicly reported tabs');
    if (process.env.RUYI_P5_FINDER_FAIL_AFTER_OBSERVE === '1') throw new Error('Injected Finder fixture failure after ownership observation');
    const focused = await call('focus_window', { target: owned.target });
    owned = focused.window;
    const tree = await call('ui_inspect', { target: owned.target, max_depth: 20, max_nodes: 1000 });
    evidence('tree', tree);
    t.ok(!tree.truncated && tree.nodes > 1, 'real Finder exposes a complete bounded AX tree for the owned folder');
    const views = await call('ui_find', { target: owned.target, control_type: 'AXRadioButton', visible_only: true, max_depth: 20 });
    const nativeViews = flatten(initial.windows.find(window => window.role === 'AXWindow').tree)
      .filter(node => node.AXRole === 'AXRadioButton');
    const nextView = views.matches.find(node => node.enabled && node.actions.includes('AXPress')
      && nativeViews.some(native => native.AXDescription === node.name && native.selectedValue === 0));
    if (!nextView) throw new Error('Finder exposes no unselected actionable view button');
    const invoked = await call('ui_invoke', { target: owned.target, element_ref: nextView.element_ref });
    const selected = await until(() => {
      const fresh = snapshot();
      prove(fresh, owned);
      return flatten(fresh.windows.find(window => window.role === 'AXWindow').tree)
        .find(node => node.AXRole === 'AXRadioButton' && node.AXDescription === nextView.name && node.selectedValue === 1);
    });
    const afterAction = snapshot();
    prove(afterAction, owned);
    evidence('action', { selectedView: nextView.name, invoked, selected, afterAction });
    t.ok(invoked.action_sent && selected.selectedValue === 1,
      'Finder AXPress changes the owned folder view with independent native AXValue state readback');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (owned && client) {
      try {
        const rows = await call('list_windows');
        const current = rows.windows.find(row => row.pid === owned.pid && row.process_start === owned.process_start && row.handle === owned.handle);
        if (!current) throw new Error('Owned Finder window is no longer observable for cleanup');
        prove(snapshot(), current);
        const closed = await call('close_window', { target: current.target });
        const final = await until(() => {
          const state = snapshot();
          return !state.windows.some(window => window.role === 'AXWindow') && state.cgWindows.every(window =>
            baseline.cgWindows.some(prior => prior.handle === window.handle)) && state;
        });
        cleaned = closed.matched && final.pid === baseline.pid;
        evidence('cleanup', { cleaned, final });
        t.ok(cleaned, 'only the proved Finder window closes and the shared Finder process survives');
      } catch (error) { t.fail('Finder cleanup ' + error.message); }
    }
    if (client?.child) {
      const child = client.child; client.kill();
      const result = await runtime.waitForCleanup(child, 3000);
      t.ok(result && !result.incomplete, 'Finder scenario MCP and native helper exit completely');
    }
    if (!launched || cleaned) fs.rmSync(root, { recursive: true, force: true });
    else t.fail('Finder ownership could not be re-proved, fixture retained at ' + root);
    t.done();
  }
})();

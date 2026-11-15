'use strict';
require('./lib/self-isolate-home');
// Real Mac observe -> guarded act_and_verify -> visible receiver counter -> macro/AX/OCR observation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS OBSERVE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-observe-'));
process.env.RUYI_HOME = path.join(root, 'data');
let fixture, client, runtime;
const reports = [], results = [];
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Owned composed fixture condition timed out');
}
async function command(text) {
  const offset = reports.length; fixture.stdin.write(text + '\n');
  return until(() => reports.slice(offset).find(report => report.event === text));
}
async function call(name, args) {
  const started = Date.now();
  console.log('INFO native call start ' + name);
  const result = await client.callTool(name, args);
  const elapsed_ms = Date.now() - started;
  console.log('INFO native call end ' + name + ' ' + elapsed_ms + 'ms');
  const clean = JSON.parse(JSON.stringify(result, (key, value) => ['image', 'image_base64'].includes(key) ? undefined : value));
  results.push({ name, elapsed_ms, result: clean });
  if (!result.ok) console.log(name + ' expected/actual failure ' + JSON.stringify(clean));
  return result;
}
function region(bounds) { return [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(','); }
function center(bounds) { return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }; }
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native Mac composed observations'); return; }
    const helper = process.env.RUYI_P5_COMPOSED_HELPER || buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const probe = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const status = JSON.parse(probe.stdout);
    if (!status.ready || !status.inputReady) {
      if (process.env.RUYI_P5_COMPOSED_REQUIRED === '1') t.fail('composed acceptance requires authorized unlocked desktop');
      else console.log('SKIP authorize the current desktop for composed observations');
      return;
    }
    const binary = path.join(root, 'fixture');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-ocr-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    const synthetic = path.join(root, 'synthetic.png');
    const image = cp.spawnSync(binary, ['--image', synthetic], { env: fixtureChildEnv(), timeout: 5000 });
    if (image.status !== 0) throw new Error('Cannot build owned warm-up image');
    fixture = cp.spawn(binary, [], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', bytes => {
      buffer += bytes; let end;
      while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime']); runtime = S.ProcessRuntime;
    client = new S.McpStdioClient({ id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop,uia,ocr,observe,macro', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['observe', 'act_and_verify', 'batch_actions', 'macro_run'].every(name => names.includes(name)), 'normal Mac registry exposes composed observation, verification and macro replay');
    const warm = await call('ocr_image', { path: synthetic });
    if (!warm.ok) throw new Error(JSON.stringify(warm));
    const listed = await call('list_windows', {});
    const target = listed.windows.find(row => row.pid === fixture.pid && row.handle === ready.id)?.target;
    if (!target) throw new Error('Owned composed window missing');
    await call('focus_window', { target });
    const observed = await call('observe', { target, max_width: 400 });
    t.ok(observed.ok && observed.screenshot.image && observed.ocr_words.some(word => word.text === 'COUNTS'), 'one real observation combines encoded pixels and OCR of the owned counter');
    t.ok(observed.uia_elements.some(element => element.type === 'AXButton' && element.element_ref)
      && observed.uia_scope.target.ref === target.ref, 'the same observation carries bound native AX references');
    t.ok(observed.coordinate_space === 'macos_global_points' && observed.screenshot.origin.x === target.bounds.x
      && observed.screenshot.scale === observed.screenshot.width / observed.screenshot.logical_bounds.width
      && observed.screenshot.scale_y === observed.screenshot.height / observed.screenshot.logical_bounds.height,
      'observed image mapping preserves actual origin and both logical-point scales');
    const textOnly = await call('observe', { target, include_screenshot: false, include_uia: false });
    t.ok(textOnly.ok && !textOnly.screenshot && textOnly.ocr_words.some(word => word.text === 'COUNTS'), 'text-only observation keeps shared native OCR without returning encoded pixels');
    const button = center(ready.buttons[0].bounds);
    const acted = await call('act_and_verify', { target, action: { type: 'click', ...button }, region: region(ready.counterBounds),
      settle_ms: 300, save_shots: true, return_image: 'diff' });
    const state = await command('state');
    t.ok(acted.ok && acted.action_result.action_sent && state.counts[0] === 1 && state.counts[1] === 0,
      'guarded verification dispatches exactly one click and the intended receiver counts it');
    t.ok(acted.effect_observed && acted.changed_pixels > 0 && acted.changed_ratio_full > 0 && acted.confirmed === null
      && acted.full_scope === 'captured_target_window', 'pixel verification reports a real counter change with explicit target-window scope');
    t.ok(fs.existsSync(acted.before_path) && fs.existsSync(acted.after_path) && acted.image
      && acted.scale > 0 && acted.scale_y > 0 && acted.origin, 'requested evidence and cropped diff carry usable image-coordinate metadata');
    const noop = await call('act_and_verify', { target, action: { type: 'key', key: 'escape' },
      region: region(ready.counterBounds), settle_ms: 50 });
    t.ok(noop.ok && !noop.effect_observed && noop.changed_pixels === 0 && noop.confirmed === null
      && noop.shots_reason === 'no_change' && fs.existsSync(noop.before_path), 'a real no-change key observation keeps its evidence and semantic uncertainty');
    const next = center(ready.buttons[1].bounds);
    const macro = await call('macro_run', { delay_ms: 0, steps: [
      { tool: 'act_and_verify', args: { target, action: { type: 'click', ...next }, region: region(ready.counterBounds), settle_ms: 200 } },
      { tool: 'wait', args: { seconds: .02 } },
      { tool: 'observe', args: { target, max_width: 300, include_uia: false } },
      { tool: 'ocr_find_text', args: { target, text: 'COUNTS 1 1 0' } }
    ] });
    const macroState = await command('state');
    t.ok(macro.ok && macro.completed === 4 && macro.failed === 0 && macroState.counts.join(',') === '1,1,0'
      && macro.results[3].result.found, 'live macro replay composes guarded action, shared observation and OCR state readback');
    t.ok(macro.image && macro.width === 300 && macro.origin.x === target.bounds.x && macro.scale_y > 0
      && macro.lifted_images[0].tool === 'observe', 'nested macro image lifting preserves the actual encoded frame geometry');
    const immediate = await call('act_and_verify', { target,
      action: { type: 'click', ...center(ready.buttons[2].bounds) }, region: region(ready.counterBounds), settle_ms: 0 });
    t.ok(immediate.ok && immediate.changed_pixels > 0 && immediate.effect_observed
      && (await command('state')).counts.join(',') === '1,1,1',
      'zero settle budget still reports the immediately observed counter change');
    const stopped = await call('batch_actions', { actions: [
      { tool: 'act_and_verify', args: { action: { type: 'click', ...next } } },
      { tool: 'mouse_click', args: { target, ...next } }
    ] });
    t.ok(!stopped.ok && stopped.failed === 1 && stopped.completed === 0 && (await command('state')).counts.join(',') === '1,1,1',
      'a missing target stops the batch before the following mutation');
    await command('other');
    const refused = await call('act_and_verify', { target, action: { type: 'click', ...button } });
    t.ok(!refused.ok && (await command('state')).counts.join(',') === '1,1,1', 'changed foreground refuses composed input without changing either receiver counter');
    const diagnostic = await call('diagnostics', {});
    t.ok(!diagnostic.unsupported_modules.observe && !diagnostic.unsupported_modules.act_and_verify
      && !diagnostic.unsupported_modules.batch, 'diagnostics agrees with the implemented composed backends');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (client?.child) {
      const child = client.child; client.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned composed MCP and worker cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.write('quit\n');
      try { await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000); }
      catch { killOwnTree(fixture); }
    }
    if (process.env.RUYI_P5_COMPOSED_EVIDENCE) {
      const evidence = path.resolve(process.env.RUYI_P5_COMPOSED_EVIDENCE); fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, reports }, null, 2) + '\n');
    }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();

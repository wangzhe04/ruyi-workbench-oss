'use strict';
require('./lib/self-isolate-home');
// Real MCP -> Vision / OpenCV -> native guarded input -> self-owned AppKit receiver.
// RUYI_P5_OCR_REQUIRED=1 makes desktop authorization mandatory. No clipboard operations.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS OCR');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-ocr-'));
process.env.RUYI_HOME = path.join(root, 'data');
let fixture, client, runtime;
const reports = [], results = [];
async function until(read, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Owned OCR fixture condition timed out');
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
  results.push({ name, elapsed_ms, result: { ...result, image: undefined } });
  if (!result.ok) console.log(name + " failure " + JSON.stringify(result));
  return result;
}
function inside(point, bounds) {
  return point[0] >= bounds.x && point[0] <= bounds.x + bounds.width
    && point[1] >= bounds.y && point[1] <= bounds.y + bounds.height;
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP native Mac OCR and visual acceptance'); return; }
    const helper = process.env.RUYI_P5_OCR_HELPER || buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const binary = path.join(root, 'ocr-fixture');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-ocr-window.m'), '-o', binary], { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    const image = path.join(root, 'synthetic.png');
    const generated = cp.spawnSync(binary, ['--image', image], { env: fixtureChildEnv(), timeout: 5000 });
    if (generated.status !== 0) throw new Error('Could not generate the owned OCR image');
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime', 'auditBridgedWriteCoverage']); runtime = S.ProcessRuntime;
    client = new S.McpStdioClient({ id: 'ai-computer-control',
      command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop,ocr,vision', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } });
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['ocr_image', 'ocr_available_languages'].every(name => names.includes(name)), 'local OCR tools are registered independently of desktop input');
    t.ok(S.auditBridgedWriteCoverage(names).uncovered.length === 0, 'new observations preserve file checkpoint coverage');
    const languages = await call('ocr_available_languages', {});
    t.ok(languages.ok && languages.backend === 'Vision' && languages.languages.some(language => language.tag === 'zh-Hans')
      && languages.languages.some(language => language.tag === 'en-US'), 'installed offline Vision exposes Chinese and English language tags');
    const recognized = await call('ocr_image', { path: image });
    t.ok(recognized.ok && recognized.text.includes('INVOICE 42') && recognized.text.includes('中文测试')
      && recognized.text.includes('Total $42.50'), 'real native OCR preserves mixed Chinese, English and monetary punctuation');
    if (!recognized.ok) throw new Error(JSON.stringify(recognized));
    t.ok(recognized.width === 1000 && recognized.height === 300 && recognized.coordinate_space === 'image_pixels'
      && recognized.image_orientation === 'decoded_pixels_up', 'local image coordinates and raw decoded orientation are explicit');
    t.ok(recognized.words.some(word => word.text === '中') && recognized.words.some(word => word.text === '文')
      && recognized.words.some(word => word.text === '$42.50'), 'Unicode tokenization splits CJK characters and preserves non-CJK punctuation');
    t.ok(recognized.words.every(word => word.width > 0 && word.height > 0 && word.left >= 0 && word.top >= 0
      && word.left + word.width <= 1000 && word.top + word.height <= 300
      && word.center[0] === word.left + word.width / 2 && word.center[1] === word.top + word.height / 2), 'native token rectangles and centers remain inside image pixels');
    const link = path.join(root, 'linked.png'); fs.symlinkSync(image, link);
    const linked = await call('ocr_image', { path: link });
    t.ok(linked.ok && linked.text === recognized.text, 'ordinary image symlinks read the same validated opened file');
    const unsupported = await call('ocr_image', { path: image, lang: 'definitely-unsupported' });
    t.ok(!unsupported.ok && unsupported.code === 'ocr_language_unsupported' && unsupported.available_languages.includes('zh-Hans'), 'unsupported language fails with bounded installed-language details');
    const invalidPath = path.join(root, 'invalid.png'); fs.writeFileSync(invalidPath, 'not an image');
    const invalid = await call('ocr_image', { path: invalidPath });
    t.ok(!invalid.ok && invalid.code === 'ocr_image_invalid', 'invalid local image fails explicitly');
    const nonregular = await call('ocr_image', { path: '/dev/null' });
    t.ok(!nonregular.ok && nonregular.code === 'ocr_capacity', 'non-regular image input is refused without blocking');
    const status = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    const capability = JSON.parse(status.stdout);
    if (!capability.ready || !capability.inputReady) {
      if (process.env.RUYI_P5_OCR_REQUIRED === '1') t.fail('desktop acceptance requires screen/input authorization and unlocked desktop');
      else console.log('SKIP authorize desktop access for live OCR and visual clicks');
      return;
    }
    t.ok(['ocr_screen', 'ocr_find_text', 'ocr_click', 'find_template', 'find_all_templates', 'vision_click', 'wait_for_image']
      .every(name => names.includes(name)), 'ready screen OCR and OpenCV tools appear in real tools/list');
    fixture = cp.spawn(binary, [], { env: fixtureChildEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', bytes => {
      buffer += bytes; let end;
      while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    fixture.stderr.resume();
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    const windows = await call('list_windows', {});
    const row = windows.windows.find(window => window.pid === fixture.pid && window.handle === ready.id);
    if (!row) throw new Error('Owned OCR window missing');
    const target = row.target;
    const focus = await call('focus_window', { target });
    if (!focus.ok) throw new Error(JSON.stringify(focus));
    const b = ready.content;
    const region = [Math.ceil(b.x), Math.ceil(b.y), Math.floor(b.width), Math.floor(b.height)].join(',');
    const screen = await call('ocr_screen', { region });
    t.ok(screen.ok && screen.text.includes('INVOICE 42') && screen.text.includes('中文测试')
      && screen.coordinate_space === 'macos_global_points', 'ScreenCaptureKit and Vision read the owned bilingual window in logical points');
    t.ok(screen.words.every(word => inside(word.center, b)) && screen.source_pixel_scale.x >= 1
      && screen.source_pixel_scale.y >= 1, 'actual capture dimensions map both OCR axes into the logical capture bounds');
    const found = await call('ocr_find_text', { text: '中文保存', target });
    t.ok(found.ok && found.found && found.count === 1 && inside([found.center.x, found.center.y], ready.buttons[2].bounds), 'Chinese phrase location maps into the actual receiver button');
    const missing = await call('ocr_find_text', { text: 'NO_SUCH_OWNED_LABEL_999', region });
    t.ok(missing.ok && missing.found === false, 'text miss remains a successful observation with no input');
    const candidates = await call('ocr_click', { text: 'Save Draft', target, return_candidates: true });
    t.ok(candidates.ok && candidates.count === 2 && candidates.clicked === null, 'duplicate English labels remain two explicit OCR candidates');
    const ambiguous = await call('ocr_click', { text: 'Save Draft', target });
    t.ok(!ambiguous.ok && ambiguous.code === 'ocr_ambiguous' && (await command('state')).counts.every(count => count === 0), 'ambiguous OCR text is refused before native input');
    const chosen = await call('ocr_click', { text: 'Save Draft', target, nth: 1 });
    const chosenState = await command('state');
    t.ok(chosen.ok && chosen.confirmed === null && chosen.verification === 'native_events_posted'
      && chosenState.counts[0] === 0 && chosenState.counts[1] === 1, 'explicit OCR choice posts guarded input and only the second receiver counter changes');
    const chinese = await call('ocr_click', { text: '中文保存', target });
    const chineseState = await command('state');
    t.ok(chinese.ok && chineseState.counts[2] === 1 && !chineseState.leftHeld && chineseState.modifiers === 0,
      'unique Chinese OCR click reaches the receiver and releases native input state');
    const button = ready.buttons[0].bounds;
    const snap = await call('screenshot_region', { x: Math.round(button.x + button.width / 2 - 80),
      y: Math.round(button.y + button.height / 2 - 16), width: 160, height: 32, max_width: 0 });
    if (!snap.ok) throw new Error(JSON.stringify(snap));
    const template = path.join(root, 'button-template.png'); fs.writeFileSync(template, Buffer.from(snap.image, 'base64'));
    const all = await call('find_all_templates', { template_path: template, confidence: .99, region });
    t.ok(all.ok && all.matches_total === 2 && all.matches.every(match => ready.buttons.slice(0, 2).some(control => inside(match.center, control.bounds))), 'bounded OpenCV worker finds both owned template occurrences with logical-point centers');
    const capped = await call('find_all_templates', { template_path: template, confidence: .99, region, max_results: 1 });
    t.ok(capped.ok && capped.count === 1 && capped.matches_total === 2 && capped.truncated, 'response truncation preserves the full template match count');
    const query = await call('vision_click', { template_path: template, threshold: .99, region, multiscale: false, click: false });
    t.ok(query.ok && query.found && query.count === 2 && !query.clicked, 'template observation needs no input target');
    const denied = await call('vision_click', { template_path: template, threshold: .99, target, multiscale: false });
    t.ok(!denied.ok && denied.code === 'vision_ambiguous', 'duplicate template input requires explicit selection');
    const clicked = await call('vision_click', { template_path: template, threshold: .99, target, multiscale: false, nth: 1 });
    const final = await command('state');
    t.ok(clicked.ok && clicked.confirmed === null && final.counts.reduce((sum, count) => sum + count, 0) === 3
      && !final.leftHeld && final.modifiers === 0, 'template-selected native click changes exactly one receiver counter and releases input');
    const waited = await call('wait_for_image', { template_path: template, confidence: .99, region, timeout: 1 });
    t.ok(waited.ok && waited.found, 'asynchronous template polling returns an observed match through the Mac worker');
    await command('other');
    const wrongFocus = await call('ocr_click', { text: '中文保存', target });
    t.ok(!wrongFocus.ok && ['target_changed', 'window_not_found'].includes(wrongFocus.code), 'changed active owned window refuses OCR input before recognition');
    await command('front');
    const diagnostic = await call('diagnostics', {});
    t.ok(diagnostic.capabilities['desktop.ocr'].ready && diagnostic.capabilities['desktop.template_matching'].ready
      && diagnostic.optional.cv2 && !diagnostic.unsupported_modules.ocr
      && !diagnostic.unsupported_modules.vision, 'real diagnostics reports ready Vision and OpenCV backends');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (client?.child) {
      const child = client.child; client.kill();
      const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'owned visual MCP and helper cleanup is confirmed');
    }
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      fixture.stdin.write('quit\n');
      try { await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 5000); }
      catch { killOwnTree(fixture); }
    }
    if (process.env.RUYI_P5_OCR_EVIDENCE) {
      const evidence = path.resolve(process.env.RUYI_P5_OCR_EVIDENCE); fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, reports }, null, 2) + '\n');
      for (const name of ['synthetic.png', 'button-template.png']) {
        if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(evidence, name));
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
    t.done();
  }
})();

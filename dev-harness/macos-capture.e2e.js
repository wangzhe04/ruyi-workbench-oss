'use strict';
require('./lib/self-isolate-home');
// P5-01 real ScreenCaptureKit + ACC stdio + native workbench screenshot entry points.
// A self-owned four-colour window supplies pixel evidence. Full-screen frames remain temporary.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { decodePng } = require('./lib/png-grid');
const { loadServerInternals } = require('./lib/server-internals');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS CAPTURE');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-capture-'));
process.env.RUYI_HOME = path.join(root, 'data');
let fixture, client;
const reports = [];
const evidence = {};
async function until(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Condition timed out');
}
function colourAt(image, x, y, expected) {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return expected.every((value, index) => Math.abs(image.pixels[offset + index] - value) < 30);
}
function checkPattern(result, content, label) {
  const image = decodePng(Buffer.from(result.image || result.image_base64, 'base64'));
  const points = [[30,30,[255,0,0]], [content.width-30,30,[0,255,0]],
    [30,content.height-30,[0,0,255]], [content.width-30,content.height-30,[255,255,0]]];
  const matches = points.map(([x,y,expected]) => colourAt(image,
    (content.x + x - result.origin.x) * result.scale,
    (content.y + y - result.origin.y) * result.scale_y, expected));
  t.ok(matches.every(Boolean), label + ' maps all four logical-point markers to the correct image pixels');
  if (!matches.every(Boolean) && process.env.RUYI_P5_EVIDENCE && ['window','covered-window'].includes(label)) {
    fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE,label+'-failed.png'),Buffer.from(result.image || result.image_base64,'base64'));
  }
  evidence[label] = { width: result.width, height: result.height, origin: result.origin,
    scale: result.scale, scale_y: result.scale_y, matches };
}

(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP ScreenCaptureKit requires macOS'); return; }
    const helper = buildMacAutomationHelper({ output: path.join(root, 'automation-helper') });
    const S = loadServerInternals(['MacDesktopAutomation', 'MacDesktopAutomationHooks', 'McpStdioClient',
      'ProcessRuntime', 'defaultConfig', 'toolCall', 'buildOpenAiTools', 'adaptiveCatalogForMcp', 'auditBridgedWriteCoverage']);
    S.MacDesktopAutomationHooks.helperPath = () => helper;
    const state = await S.MacDesktopAutomation.capabilitySnapshot();
    evidence.capture = state;
    t.ok(state.supported && state.installed, 'native capture component installs independently of authorization');
    if (!state.ready) {
      const rejected = await S.MacDesktopAutomation.request({ op: 'capture', region: [0,0,8,8] });
      t.ok(!rejected.ok && ['permission_denied','session_locked'].includes(rejected.code), 'unavailable desktop returns an explicit failure');
      if (process.env.RUYI_P5_CAPTURE_REQUIRED === '1') t.fail('real capture acceptance requires screen permission and an unlocked desktop');
      else console.log('SKIP real capture until Screen Recording is granted and desktop is unlocked');
      return;
    }
    const binary = path.join(root, 'capture-fixture');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-capture-window.m'), '-o', binary], { encoding:'utf8', timeout:60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    let output = '', errors = '';
    fixture = cp.spawn(binary, [], { stdio:['pipe','pipe','pipe'], env: fixtureChildEnv() });
    fixture.stdout.on('data', bytes => {
      output += bytes;
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0,end); output = output.slice(end+1);
        try { reports.push(JSON.parse(line)); } catch { errors += line; }
      }
    });
    fixture.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4000); });
    const ready = await until(() => reports.find(report => report.event === 'ready'));
    evidence.fixture = ready;
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const python = process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python');
    client = new S.McpStdioClient({ id:'ai-computer-control', command:python,
      args:['-X','utf8','-m','ai_computer_control.server'], cwd:repo,
      env:{ ...fixtureChildEnv(), PYTHONPATH:path.join(repo,'src'), WCW_DATA_DIR:path.join(root,'acc-data'),
        ACC_TOOLSETS:'desktop,vision', ACC_HIDE_TOOLS:'', RUYI_MACOS_AUTOMATION_HELPER:helper } });
    await client.start();
    const names = client.listTools().map(tool => tool.name);
    t.ok(['screenshot','screenshot_region','window_screenshot','get_screen_info','list_monitors'].every(name => names.includes(name)),
      'real ACC tools/list advertises the ready Mac capture backend');
    t.ok(!names.includes('mouse_click') && !names.includes('ui_inspect'), 'later P5 backends stay absent');
    t.ok(S.auditBridgedWriteCoverage(names).uncovered.length === 0, 'live capture writers retain checkpoint coverage');
    const info = await client.callTool('get_screen_info',{});
    t.ok(info.ok && info.authorization === 'granted' && info.coordinate_space === 'macos_global_points',
      'live display query reports permission and logical-point coordinate space');
    evidence.displays = info;
    const region = `${ready.content.x},${ready.content.y},${ready.content.width},${ready.content.height}`;
    const captured = await client.callTool('screenshot',{region,max_width:333});
    t.ok(captured.ok && captured.width === 333 && captured.source_pixel_scale.x === info.primary.scale,
      'real region capture preserves native backing scale while returning a thumbnail');
    checkPattern(captured, ready.content, 'region');
    const window = await client.callTool('window_screenshot',{title_substring:ready.title,max_width:0});
    t.ok(window.ok && window.window_id === ready.id && window.pid === fixture.pid, 'window capture binds the actual fixture window and owner');
    checkPattern(window, ready.content, 'window');
    const regionArgs = {x:ready.content.x,y:ready.content.y,width:ready.content.width,height:ready.content.height,max_width:0};
    const directRegion = await client.callTool('screenshot_region',regionArgs);
    checkPattern(directRegion,ready.content,'region-full-resolution');
    for (const monitor of [String(info.primary.index),'all']) {
      const screen = await client.callTool('screenshot',{monitor,max_width:428});
      t.ok(screen.ok && screen.width === 428, 'real monitor capture works for ' + monitor);
      checkPattern(screen,ready.content,'monitor-'+monitor);
    }
    const clipped = await client.callTool('screenshot',{region:'-8,-8,32,32',max_width:0});
    t.ok(clipped.ok && clipped.clipped && clipped.origin.x === 0 && clipped.origin.y === 0
      && clipped.logical_bounds.width === 24 && clipped.logical_bounds.height === 24, 'partial overflow is clipped in logical points');
    for (const args of [{region:'-99999,-99999,8,8'}, {monitor:'9999'}, {region:'0,0,0,10'}]) {
      const failed = await client.callTool('screenshot',args);
      t.ok(!failed.ok && !failed.image, 'invalid or off-display capture fails without an image: '+JSON.stringify(args));
    }
    const missing = await client.callTool('window_screenshot',{title_substring:'Ruyi no such controlled window 82e2'});
    t.ok(!missing.ok && missing.code === 'window_not_found', 'missing window returns a typed failure');
    fixture.stdin.write('cover\n'); await until(() => reports.find(report=>report.event==='cover'));
    const covered = await client.callTool('window_screenshot',{title_substring:ready.title,max_width:333});
    checkPattern(covered,ready.content,'covered-window');
    const file = path.join(root,'中文 空格','window.png');
    const saved = await client.callTool('window_screenshot',{title_substring:ready.title,output_path:file});
    t.ok(saved.ok && fs.existsSync(file) && saved.scale === info.primary.scale && saved.scale_y === info.primary.scale,
      'full-resolution window PNG is saved with logical-to-image scale');
    const config = {...S.defaultConfig(), permissionMode:'bypass',allowDesktopTools:true, defaultWorkspace:root,
      workspaces:[{path:root}]};
    const caps = {runtime: await S.ProcessRuntime.capabilitySnapshot()};
    t.ok(S.buildOpenAiTools(config,caps).some(tool=>tool.function.name==='desktop_screenshot'), 'Provider catalog offers ready native screenshot');
    const outputPath = path.join(root,'native.png');
    const native = await S.toolCall('desktop_screenshot',{outputPath},{config,session:{cwd:root}});
    t.ok(native.ok && fs.existsSync(outputPath) && native.coordinate_space==='macos_global_points', 'normal native screenshot entry point saves a real PNG');
    const off = await S.toolCall('desktop_screenshot',{outputPath:path.join(root,'disabled.png')},
      {config:{...config,allowDesktopTools:false},session:{cwd:root}});
    t.ok(!off.ok && off.code==='tool-disabled' && !fs.existsSync(path.join(root,'disabled.png')), 'global desktop switch blocks native dispatch');
    const sessionOff = await S.toolCall('desktop_screenshot',{}, {config,session:{cwd:root,desktopTools:false}});
    t.ok(!sessionOff.ok && sessionOff.code==='tool-disabled', 'session desktop override blocks native dispatch');
    fixture.stdin.write('minimize\n'); await until(()=>reports.find(report=>report.event==='minimize'));
    const minimized = await client.callTool('window_screenshot',{title_substring:ready.title});
    t.ok(!minimized.ok && ['window_not_visible','window_not_found'].includes(minimized.code), 'minimized window fails without restoring or changing focus');
    fixture.stdin.write('restore\n'); await until(()=>reports.find(report=>report.event==='restore'));
    const restored = await client.callTool('window_screenshot',{title_substring:ready.title,max_width:333});
    t.ok(restored.ok,'restoring the controlled window recovers capture');
    fixture.stdin.write('duplicate\n'); await until(()=>reports.find(report=>report.event==='duplicate'));
    const ambiguous = await client.callTool('window_screenshot',{title_substring:ready.title});
    t.ok(!ambiguous.ok && ambiguous.code==='window_ambiguous' && ambiguous.candidates.length===2, 'equal window titles are refused with candidates');
    evidence.windowAmbiguity = {ok:ambiguous.ok,code:ambiguous.code,count:ambiguous.candidates?.length};
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    if (client?.child) {
      const child = client.child; client.kill();
      await until(()=>child.exitCode!==null || child.signalCode!==null,5000).catch(error=>t.fail(error.message));
      t.ok(child.exitCode!==null || child.signalCode!==null,'owned ACC process exits after cleanup');
    }
    if (fixture) {
      if (fixture.exitCode===null && fixture.signalCode===null) {
        fixture.stdin.write('quit\n');
        await until(()=>fixture.exitCode!==null || fixture.signalCode!==null,3000).catch(()=>killOwnTree(fixture));
      }
      t.ok(fixture.exitCode!==null || fixture.signalCode!==null,'controlled AppKit window exits after acceptance');
    }
    if (process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE,{recursive:true});
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE,'capture.json'),JSON.stringify(evidence,null,2)+'\n');
    }
    fs.rmSync(root,{recursive:true,force:true}); t.done();
  }
})();

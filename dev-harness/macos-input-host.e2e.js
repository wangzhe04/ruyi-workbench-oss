'use strict';
require('./lib/self-isolate-home');
// LaunchServices Ruyi.app -> owned workbench -> normal HTTP invoke -> real ACC -> native input worker.
// RUYI_P5_APP_COMPOSED=1 verifies shared-frame observation, action verification and macro readback.
// RUYI_P5_APP_RECORD=1 verifies native controlled recording and fresh-target replay.
// RUYI_P5_APP_MANUAL=1 verifies App-origin listen-only recording with an independent synthetic demonstrator.
// RUYI_P5_APP_VISUAL=1 verifies Vision OCR and OpenCV clicks against the owned bilingual receiver.
// All injected events target a self-owned fixture. RUYI_P5_APP_PASTE=1 also verifies guarded Cmd+V.
// RUYI_P5_APP_EXIT_FAILURE=1 forces an owned App crash after input and expects one injected failure.
// RUYI_P5_APP_AX=1 also exercises native AX queries and confirmed AXValue writes through the normal App route.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const { prepareMacHost, prepareMacAcc } = require('./lib/macos-host-fixture');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS INPUT HOST');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-input-host-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
let fixture, launcher, owned, ownedTree = [];
let manualPeer, manualRuntime, manualControl, manualControlError, manualBefore;
let stopManualControl = false;
let appExecutable, acceptanceReport, serviceInvocation = '';
let runtime;
let beforeApp = new Set();
const paste = process.env.RUYI_P5_APP_PASTE === '1';
const forceAppExit = process.env.RUYI_P5_APP_EXIT_FAILURE === '1';
const ax = process.env.RUYI_P5_APP_AX === '1';
const recording = process.env.RUYI_P5_APP_RECORD === '1';
const manual = process.env.RUYI_P5_APP_MANUAL === '1';
const pointerProfile = process.env.RUYI_P5_APP_POINTER_PROFILE || 'exact';
const composed = process.env.RUYI_P5_APP_COMPOSED === '1';
const visual = composed || process.env.RUYI_P5_APP_VISUAL === '1';
const events = [];
async function until(read, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Controlled App input acceptance timed out');
}
async function fixtureCommand(command = 'state') {
  const offset = events.length; fixture.stdin.write(command + '\n');
  return until(() => events.slice(offset).find(event => event.event === command), 3000);
}
function observeOwnedApp(report) {
  if (!launcher || !appExecutable || !acceptanceReport) return;
  const table = snapshotProcessTable();
  if (!table) throw new Error('Cannot observe the App process identities');
  const candidates = table.filter(row => row.pid === report?.nativePID || !beforeApp.has(row.pid + '/' + row.created));
  for (const row of candidates) {
    const command = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout;
    if (!command.startsWith(appExecutable + ' ') || !command.includes('--acceptance-report ' + acceptanceReport + ' ')) continue;
    owned = row;
    for (const member of [row, ...ownDescendants(table, row.pid).descendants]) {
      if (!ownedTree.some(prior => member.pid === prior.pid && member.created === prior.created)) ownedTree.push(member);
      if (!serviceInvocation) {
        const invocation = cp.spawnSync('/bin/ps', ['-p', String(member.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout.trim();
        if (runtime && invocation.includes(path.join(runtime.workbenchRoot, 'app/server.js') + ' serve ')) serviceInvocation = invocation;
      }
    }
  }
}
function remainingOwned() {
  if (!ownedTree.length) return [];
  const current = snapshotProcessTable();
  if (!current) throw new Error('Cannot verify the App process table during cleanup');
  return current.filter(row => ownedTree.some(prior => row.pid === prior.pid && row.created === prior.created));
}
async function cleanupOwned() {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const row of remainingOwned()) {
      const stillOwned = snapshotProcessTable()?.some(current => current.pid === row.pid && current.created === row.created);
      if (stillOwned) {
        try { process.kill(row.pid, signal); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    try {
      await until(() => remainingOwned().length === 0, 5000);
      return;
    } catch (error) {
      if (signal === 'SIGKILL') throw error;
    }
  }
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac App input launch chain'); return; }
    if (manual && (recording || visual || ax || paste || forceAppExit)) throw new Error('Select the manual App scenario by itself');
    if (!['exact', 'standard_mouse'].includes(pointerProfile) || (!manual && pointerProfile !== 'exact')) throw new Error('Select a supported manual pointer profile');
    const helper = (manual && process.env.RUYI_P5_MANUAL_HELPER) || (recording && process.env.RUYI_P5_RECORD_HELPER) || (visual && process.env.RUYI_P5_OCR_HELPER)
      || buildMacAutomationHelper({ output: path.join(root, 'input-helper') });
    if (manual) {
      const state = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
      if (JSON.parse(state.stdout).locked) { t.fail('App manual acceptance requires an unlocked desktop'); return; }
    }
    const receiver = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      ...(manual ? ['-DRUYI_MANUAL_FIXTURE=1', '-framework', 'Carbon'] : []),
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, visual ? 'fixtures/macos-ocr-window.m' : 'fixtures/macos-input-window.m'), '-o', receiver], { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
    const ocrImage = path.join(root, 'ocr-image.png');
    if (visual) {
      const image = cp.spawnSync(receiver, ['--image', ocrImage], { env: fixtureChildEnv(), timeout: 5000 });
      if (image.status !== 0) throw new Error('Cannot generate owned App OCR image');
    }
    fixture = cp.spawn(receiver, [], { env: { ...fixtureChildEnv(), ...(paste ? { RUYI_P5_CLIPBOARD_FIXTURE: '1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    fixture.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        events.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1);
      }
    });
    fixture.stderr.resume();
    const ready = await until(() => events.find(event => event.event === 'ready'), 10000);
    runtime = prepareMacHost(root);
    const bundle = runtime.bundle;
    const executable = path.join(bundle, 'Contents/MacOS/RuyiDesktop');
    const report = path.join(root, 'report.json');
    appExecutable = executable; acceptanceReport = report;
    const script = path.join(root, 'script.js');
    const acc = prepareMacAcc(root, runtime);
    const { repo, python } = acc;
    const isolated = fixtureChildEnv();
    const manualMarkers = Object.fromEntries(['prepare', 'prepared', 'ready', 'done', 'collected', 'cleared'].map(name => [name, path.join(root, 'manual-' + name + '.json')]));
    const accEnv = { HOME: isolated.HOME, USERPROFILE: isolated.USERPROFILE, LOCALAPPDATA: isolated.LOCALAPPDATA,
      APPDATA: isolated.APPDATA, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ...(process.env.DYLD_FRAMEWORK_PATH ? { DYLD_FRAMEWORK_PATH: process.env.DYLD_FRAMEWORK_PATH } : {}),
      ...(process.env.DYLD_LIBRARY_PATH ? { DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH } : {}),
      ...(acc.pythonPath ? { PYTHONPATH: acc.pythonPath } : {}), WCW_DATA_DIR: path.join(root, 'acc-data'),
      ACC_TOOLSETS: manual ? 'desktop,macro,filesystem' : composed ? 'desktop,uia,ocr,observe,macro' : recording ? 'desktop,macro' : visual ? 'desktop,ocr,vision' : ax ? 'desktop,uia' : 'desktop', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper };
    const schema = require('../ruyi-workbench/app/server').CONFIG_SCHEMA;
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: schema, permissionMode: 'bypass',
      defaultWorkspace: root, workspaces: [{ path: root }], allowDesktopTools: true, allowCommandTools: true,
      providers: [], schedulerEnabledV1: false, stewardEnabledV1: false, includeWorkbenchMcp: false,
      autoImportClaudeCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [{ id: 'ai-computer-control', label: 'Controlled ACC', command: python,
        args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo, env: accEnv, enabled: true }] }));
    const sample = manual ? '你好' : '如意 App 输入链 中文😀';
    if (paste) {
      const seed = await fixtureCommand('seed-clipboard');
      t.ok(seed.clipboardSnapshot && seed.clipboardPreserved, 'App paste fixture preserves the pre-test clipboard before seeding owned formats');
      if (!seed.clipboardSnapshot) throw new Error('Cannot preserve the pre-test clipboard');
      await fixtureCommand('clipboard-track ' + Buffer.from(sample, 'utf8').toString('base64'));
    }
    const pad = visual ? null : { x: Math.round(ready.pad.x + ready.pad.width / 2), y: Math.round(ready.pad.y + ready.pad.height / 2) };
    fs.writeFileSync(script, `const {api}=await import('/js/net.js');
const invoke=async(name,args={})=>{
  const reply=await api('/api/tools/tool_invoke_exec',{method:'POST',body:JSON.stringify({name:'ai_computer_control__'+name,arguments:args})});
  return reply.result;
};
let diag=await invoke('diagnostics');
const directoryDeadline=Date.now()+15000;
while(!diag.ok && diag.code==='unknown-tool' && Date.now()<directoryDeadline){
  await new Promise(resolve=>setTimeout(resolve,100));
  diag=await invoke('diagnostics');
}
const capabilities=diag.capabilities?.['desktop.capture'];
if(!capabilities || (${ax} ? !capabilities.axReady : !capabilities.inputReady)) return {capabilities,diagOK:diag.ok,diag,unavailable:true};
if(${manual}&&!diag.capabilities?.['desktop.recording']?.manualReady) return {capabilities,manualCapabilities:diag.capabilities?.['desktop.recording'],unavailable:true};
const warm=${visual}?await invoke('ocr_image',{path:${JSON.stringify(ocrImage)}}):null;
const listed=await invoke('list_windows');
const row=listed.windows?.find(window=>window.pid===${fixture.pid}&&window.handle===${ready.id});
if(!row) return {capabilities,error:'owned_window_missing'};
const focused=await invoke('focus_window',{target:row.target});
if(${manual} && focused.ok){
  const markers=${JSON.stringify(manualMarkers)};
  const mark=async(name)=>{
    const value=await invoke('write_file',{path:markers[name],content:'ready'});
    if(!value.ok) throw new Error('Manual App marker write failed '+name);
  };
  const waitMarker=async(name)=>{
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      if((await invoke('read_file',{path:markers[name]})).ok) return;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    throw new Error('Manual App marker timed out '+name);
  };
  await mark('prepare');
  await waitMarker('prepared');
  const started=await invoke('record_start',{target:row.target,source:'native_window_events',max_seconds:30,pointer_profile:${JSON.stringify(pointerProfile)}});
  if(!started.ok) return {capabilities,focused,manual:{capabilities:diag.capabilities?.['desktop.recording'],started}};
  await mark('ready');
  await waitMarker('done');
  const collected=await invoke('record_stop',{save_as:'App手动示范宏'});
  await mark('collected');
  await waitMarker('cleared');
  const current=await invoke('get_active_window');
  const replayed=collected.complete&&current.ok?await invoke('macro_run',{recording:collected.recording,target:current.window.target}):null;
  const listed=await invoke('macro_list');
  const audit=await invoke('audit_tail',{n:100});
  return {capabilities,focused,manual:{capabilities:diag.capabilities?.['desktop.recording'],started,collected,replayed,listed,audit}};
}
if(${composed} && focused.ok){
  const observed=await invoke('observe',{target:row.target,max_width:400});
  const b=${JSON.stringify(ready.buttons?.[2]?.bounds || {})};
  const region=${JSON.stringify(ready.counterBounds ? [ready.counterBounds.x, ready.counterBounds.y, ready.counterBounds.width, ready.counterBounds.height].map(Math.round).join(',') : '')};
  const acted=await invoke('act_and_verify',{target:row.target,action:{type:'click',x:b.x+b.width/2,y:b.y+b.height/2},region,settle_ms:200,return_image:'diff'});
  const replayed=await invoke('macro_run',{delay_ms:0,steps:[
    {tool:'observe',args:{target:row.target,max_width:300,include_uia:false}},
    {tool:'wait',args:{seconds:.02}},
    {tool:'ocr_find_text',args:{target:row.target,text:'COUNTS 0 0 1'}}
  ]});
  return {capabilities,focused,composed:{warm,observed,acted,replayed}};
}
if(${visual} && focused.ok){
  const found=await invoke('ocr_find_text',{text:'中文保存',target:row.target});
  const chinese=await invoke('ocr_click',{text:'中文保存',target:row.target});
  const b=${JSON.stringify(ready.buttons?.[0]?.bounds || {})};
  const shot=await invoke('screenshot_region',{x:Math.round(b.x+b.width/2-80),y:Math.round(b.y+b.height/2-16),width:160,height:32,max_width:0});
  const templates=shot.ok?await invoke('find_all_templates',{template_b64:shot.image,confidence:.99,region:[row.x,row.y,row.width,row.height].join(',')}):null;
  const templateClick=templates?.ok?await invoke('vision_click',{template_b64:shot.image,threshold:.99,multiscale:false,target:row.target,nth:1}):null;
  return {capabilities,focused,visual:{warm,found,chinese,templates,templateClick}};
}
const recordStarted=${recording}&&focused.ok?await invoke('record_start',{target:row.target,max_seconds:30}):null;
if(${recording}&&recordStarted?.ok){
  await invoke('mouse_click',{target:row.target,...${JSON.stringify(ready.editor ? { x: Math.round(ready.editor.x + ready.editor.width / 2), y: Math.round(ready.editor.y + ready.editor.height / 2) } : {})}});
  await invoke('hotkey',{target:row.target,keys:['cmd','a']});
}
const typed=!${ax}&&focused.ok?await invoke('type_text',{text:${JSON.stringify(sample)},target:row.target,use_clipboard:${paste},interval:0}):null;
let ax=null;
if(${ax} && focused.ok){
  const found=await invoke('ui_find',{target:row.target,control_type:'AXTextArea',max_results:2});
  const element=found.count===1?found.matches[0]:null;
  const written=element?await invoke('ui_invoke',{target:row.target,element_ref:element.element_ref,action:'set_value',text:'App AX fixture baseline'}):null;
  const restored=written?.ok?await invoke('ui_invoke',{target:row.target,element_ref:element.element_ref,action:'set_value',text:${JSON.stringify(sample)}}):null;
  ax={foundCount:found.count,element,written,restored};
}
const clicked=typed?.ok?await invoke('mouse_click',{...${JSON.stringify(pad)},target:row.target}):null;
const scrolled=clicked?.ok?await invoke('mouse_scroll',{...${JSON.stringify(pad)},target:row.target,clicks:-2}):null;
const collected=${recording}&&recordStarted?.ok?await invoke('record_stop',{save_as:'App受控宏'}):null;
const current=${recording}&&collected?.complete?await invoke('get_active_window'):null;
const replayed=current?.ok?await invoke('macro_run',{recording:collected.recording,target:current.window.target}):null;
return {capabilities,focused,typed,clicked,scrolled,ax,recording:${recording}?{started:recordStarted,collected,replayed}:null};`);
    const env = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_NODE_PATH: process.execPath };
    const launchEnv = { HOME: env.HOME, USERPROFILE: env.USERPROFILE, LOCALAPPDATA: env.LOCALAPPDATA, APPDATA: env.APPDATA,
      RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_NODE_PATH: process.execPath };
    if (manual) {
      const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime']);
      manualRuntime = S.ProcessRuntime;
      manualPeer = new S.McpStdioClient({ id: 'ai-computer-control', command: python,
        args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
        env: { ...accEnv, WCW_DATA_DIR: path.join(root, 'peer-data'), ACC_TOOLSETS: 'desktop,macro' } });
      await manualPeer.start();
      const waitForMarker = name => until(() => {
        if (stopManualControl) throw new Error('Manual App controller stopped');
        return fs.existsSync(manualMarkers[name]);
      }, 30000);
      manualControl = (async () => {
        await waitForMarker('prepare');
        const selected = await fixtureCommand('source-pinyin');
        await fixtureCommand('clear-neutral');
        await fixtureCommand('focus-text');
        fs.writeFileSync(manualMarkers.prepared, JSON.stringify({ source: selected.inputSource }));
        await waitForMarker('ready');
        const listed = await manualPeer.callTool('list_windows', {});
        const peerTarget = listed.windows.find(window => window.pid === fixture.pid && window.handle === ready.id)?.target;
        if (!peerTarget) throw new Error('Independent App demonstrator cannot observe its receiver');
        const demonstrated = [45, 34, 4, 0, 31, 49].flatMap((keycode, index) => [
          { type: 'key_down', keycode, keyboard_type: 91, repeat: 0, flags: 0, at_us: index * 80000 },
          { type: 'key_up', keycode, keyboard_type: 91, repeat: 0, flags: 0, at_us: index * 80000 + 40000 }
        ]);
        if (pointerProfile === 'standard_mouse') {
          const at = demonstrated.at(-1).at_us + 80000;
          const point = { x: Math.round(ready.pad.x + 100), y: Math.round(ready.pad.y + 60) };
          for (const [type, offset, dx, dy, pressure] of [['mouse_down', 0, 0, 0, 1], ['drag', 80000, 20, 10, 1], ['mouse_up', 160000, 20, 10, 0]])
            demonstrated.push({ type, at_us: at + offset, x: point.x + dx, y: point.y + dy, flags: 0, button: 0,
              click_state: 1, pressure, delta_x: type === 'drag' ? dx : 0, delta_y: type === 'drag' ? dy : 0,
              source_subtype: 3, associated_events_mask: (2 ** 34) + 70 });
        }
        const sent = await manualPeer.callTool('input_sequence', { target: peerTarget,
          input_source: { id: selected.inputSource, type: 'TISTypeKeyboardInputMode' }, events: demonstrated, pointer_profile: pointerProfile });
        if (!sent.ok) throw new Error('Independent App demonstration failed ' + JSON.stringify(sent));
        manualBefore = await until(async () => {
          const state = await fixtureCommand('state');
          return state.text === sample && !state.marked ? state : null;
        }, 5000);
        fs.writeFileSync(manualMarkers.done, JSON.stringify({ text: manualBefore.text, marked: manualBefore.marked }));
        await waitForMarker('collected');
        await fixtureCommand('clear-neutral');
        await fixtureCommand('focus-text');
        fs.writeFileSync(manualMarkers.cleared, 'ready');
      })().catch(error => { manualControlError = error; });
    }
    beforeApp = new Set((snapshotProcessTable() || []).map(row => row.pid + '/' + row.created));
    launcher = cp.spawn('/usr/bin/open', ['-n', '-W', '-a', bundle,
      ...Object.entries(launchEnv).flatMap(([key, value]) => ['--env', key + '=' + value]),
      '--args', '--workbench-root', runtime.workbenchRoot, '--acceptance-report', report, '--acceptance-script', script,
      ...(forceAppExit ? [] : ['--acceptance-auto-quit'])],
    { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    launcher.stdout.resume(); launcher.stderr.on('data', chunk => console.log('INFO LaunchServices ' + String(chunk).trim()));
    const result = await until(() => {
      if (manualControlError) throw manualControlError;
      const value = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
      observeOwnedApp(value);
      if (!value) return null;
      if (value.state === 'failed') throw new Error(JSON.stringify(value));
      return value.state === 'ready' && value;
    }, visual ? 100000 : 45000);
    const extra = result.page.additional;
    if (manualControl && !extra.unavailable && extra.manual?.started?.ok) await manualControl;
    if (manualControlError) throw manualControlError;
    if (manual && (extra.unavailable || !extra.manual?.started?.ok || !extra.manual?.collected?.complete || !extra.manual?.replayed?.ok)) {
      if (process.env.RUYI_P5_EVIDENCE) {
        fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
        fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, 'manual-host-error.json'), JSON.stringify(extra, null, 2) + '\n');
      }
      throw new Error('App manual chain failed ' + JSON.stringify(extra));
    }
    const state = manual ? await until(async () => {
      const current = await fixtureCommand();
      return current.text === sample && !current.marked && !current.leftHeld && current.modifierFlags === 0 ? current : null;
    }, 5000) : await fixtureCommand();
    if (process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, manual ? 'manual-host.json' : composed ? 'composed-host.json' : recording ? 'record-host.json' : visual ? 'visual-host.json' : 'input-host.json'), JSON.stringify({ nativePID: result.nativePID,
        servicePID: result.servicePID, launch: 'LaunchServices', serviceInvocation, ...runtime, ...extra,
        manualDemonstration: manual ? { kind: 'independent synthetic input through a real event tap', before: manualBefore } : null,
        observedProcesses: ownedTree.map(row => ({ pid: row.pid, ppid: row.ppid, created: row.created.toString() })),
        receiver: { textMatches: state.text === sample, counts: state.counts, pad: state.pad,
          leftHeld: state.leftHeld, modifierFlags: visual ? state.modifiers : state.modifierFlags, clipboardPreserved: state.clipboardPreserved } }, null, 2) + '\n');
    }
    t.ok(result.nativePID > 0 && result.servicePID > 0, 'LaunchServices Ruyi App owns the actual workbench service');
    t.ok(serviceInvocation.includes(path.join(runtime.workbenchRoot, 'app/server.js') + ' serve '),
      'the authorized App launches the isolated server whose bytes match this exact candidate');
    t.ok(owned?.pid === result.nativePID && ownedTree.some(row => row.pid === result.servicePID),
      'App and service process identities were observed before shutdown');
    if (!(ax ? extra.capabilities?.axReady : extra.capabilities?.inputReady)) console.log('App input readiness ' + JSON.stringify(extra));
    t.ok(extra.capabilities?.windowAuthorization === 'granted' && (ax ? extra.capabilities.axReady :
      extra.capabilities.inputReady && extra.capabilities.eventAuthorization === 'granted'),
    ax ? 'App-launched ACC has actual Accessibility authorization for native AX' : 'App-launched ACC has its own actual Accessibility and event authorization');
    t.ok(extra.focused?.ok && extra.focused.foreground_verified, 'normal App HTTP tool route focuses the exact owned receiver');
    if (!ax && !visual && !manual) t.ok(extra.typed?.ok && extra.typed.method === (paste ? 'clipboard' : 'typewrite'),
      paste ? 'normal App HTTP tool route sends Chinese through Cmd+V' : 'normal App HTTP tool route sends Chinese Unicode events');
    if (paste && !ax) t.ok(extra.typed?.restore === 'done' && state.clipboardPreserved, 'App Cmd+V restores the prior image and private clipboard formats');
    if (ax) {
      t.ok(extra.capabilities?.axReady, 'App-origin native AX backend reports actual ready authorization');
      t.ok(extra.ax?.foundCount === 1 && extra.ax.element.element_ref, 'normal App HTTP route resolves the exact owned AX text area');
      t.ok(extra.ax?.written?.confirmed && extra.ax?.restored?.confirmed && state.text === sample,
        'App-origin AXValue writes change and restore the real receiver with confirmed readback');
    }
    if (!ax && !visual && !manual) {
      t.ok(extra.clicked?.ok && extra.scrolled?.ok, 'App launch chain sends guarded pointer and wheel events');
      t.ok(state.text === sample && state.counts.key_down > 0, 'real receiver confirms the App-originated Chinese text');
      t.ok(state.counts.left_down === (recording ? 4 : 1) && state.counts.left_up === (recording ? 4 : 1) && state.counts.vertical_scroll > 0,
        'real receiver confirms the App-originated balanced click and wheel events');
    }
    if (manual) {
      t.ok(extra.manual?.capabilities?.manualReady && extra.manual.capabilities.listenAuthorization === 'granted',
        'the real App identity has listening and input readiness for manual recording');
      t.ok(extra.manual?.started?.source === 'native_window_events' && extra.manual.collected?.complete
        && extra.manual.collected.recording.schema === (pointerProfile === 'standard_mouse' ? 3 : 2) && extra.manual.collected.path,
        pointerProfile === 'standard_mouse' ? 'the normal App HTTP route captures and saves a complete schema3 standard projection'
          : 'the normal App HTTP route captures and saves a complete schema2 event demonstration');
      t.ok(extra.manual?.replayed?.ok && manualBefore?.text === sample && !manualBefore.marked
        && state.text === sample && !state.marked,
        'the App clears and replays raw Pinyin events to the same committed Chinese text');
      t.ok(extra.manual?.listed?.macros?.some(macro => macro.name === 'App手动示范宏' && macro.valid && macro.source === 'native_window_events'),
        'the App macro catalog reads its saved manual recording');
      t.ok(['record_start', 'record_stop', 'input_sequence'].every(name => extra.manual?.audit?.records?.some(row => row.tool === name && row.ok)),
        'App-origin recording, collection and native sequence replay keep their actual audit rows');
      if (pointerProfile === 'standard_mouse') {
        t.ok(extra.manual.collected.recording.pointer_profile === 'standard_mouse'
          && extra.manual.collected.recording.replay_scope === 'keyboard_and_standard_mouse'
          && extra.manual.collected.excluded_features.includes('pressure_gestures'),
          'App schema3 explicitly marks standard projection scope and excluded pressure gestures');
        t.ok(state.counts.dragged >= 2 && state.counts.left_down === 2 && state.counts.left_up === 2,
          'App standard projection captures and replays a real balanced pointer drag');
      }
    }
    if (recording) {
      t.ok(extra.recording?.started?.source === 'controlled_native_requests' && extra.recording.collected?.complete
        && extra.recording.collected.count === 5 && extra.recording.collected.path,
        'actual App HTTP route records and atomically saves five successful native input semantics');
      t.ok(extra.recording?.replayed?.ok && extra.recording.replayed.completed >= 5 && extra.recording.replayed.failed === 0
        && state.text === sample && state.counts.vertical_scroll === 2,
        'actual App macro route rebinds a fresh window and reproduces Chinese text and balanced receiver events');
    }
    if (visual && !composed) {
      t.ok(extra.visual?.warm?.ok && extra.visual.warm.text.includes('中文测试'), 'normal App HTTP route recognizes the local bilingual image with Vision');
      t.ok(extra.capabilities?.ready && extra.visual?.found?.found, 'App-origin ScreenCaptureKit and Vision resolve the owned Chinese button');
      t.ok(extra.visual?.chinese?.ok && extra.visual.chinese.confirmed === null && state.counts[2] === 1,
        'App-origin OCR click changes the actual Chinese receiver counter');
      t.ok(extra.visual?.templates?.matches_total === 2 && extra.visual.templateClick?.ok
        && state.counts[0] === 0 && state.counts[1] === 1, 'App-origin OpenCV matching and explicit selection change only the intended duplicate counter');
    }
    if (composed) {
      t.ok(extra.composed?.warm?.ok && extra.composed.observed?.screenshot?.image
        && extra.composed.observed.uia_elements.some(element => element.element_ref),
      'normal App route combines shared screenshot/OCR and native AX metadata');
      t.ok(extra.composed?.acted?.ok && extra.composed.acted.effect_observed && state.counts[2] === 1
        && extra.composed.acted.confirmed === null, 'App-origin guarded action changes the visible counter with measured pixel evidence');
      t.ok(extra.composed?.replayed?.completed === 3 && extra.composed.replayed.results[2].result.found,
        'normal App macro route observes the actual changed counter through OCR');
      t.ok(extra.composed?.replayed?.image && extra.composed.replayed.scale_y > 0
        && extra.composed.replayed.origin, 'App macro image lifting preserves both coordinate axes and origin');
    }
    t.ok(!state.leftHeld && (visual ? state.modifiers : state.modifierFlags) === 0,
      'App input leaves actual button and modifier state released');
    if (forceAppExit) {
      if (!owned || !remainingOwned().some(row => row.pid === owned.pid)) throw new Error('Cannot verify the App before controlled crash');
      process.kill(owned.pid, 'SIGKILL');
      await until(() => !remainingOwned().some(row => row.pid === owned.pid), 3000);
      const remnants = remainingOwned();
      t.ok(remnants.length > 0, 'controlled App crash leaves observed service descendants for failure cleanup');
      throw new Error('Injected App-exit cleanup fixture failure');
    }
    await until(() => launcher.exitCode !== null || launcher.signalCode !== null, 10000);
    t.ok(launcher.exitCode === 0, 'LaunchServices waiter exits normally after App self-termination');
    await until(() => !snapshotProcessTable()?.some(row => ownedTree.some(prior => row.pid === prior.pid && row.created === prior.created)), 5000);
    t.ok(true, 'observed App, service, ACC and helper identities are absent after App shutdown');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    stopManualControl = true;
    if (manualPeer?.child) {
      const child = manualPeer.child;
      manualPeer.kill();
      const cleaned = await manualRuntime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'independent App demonstrator and its native worker are reaped');
    }
    if (manualControl) await manualControl;
    let appCleaned = false;
    try { observeOwnedApp(); await cleanupOwned(); appCleaned = true; }
    catch (error) { t.fail('App subtree cleanup ' + error.message); }
    if (ownedTree.length) t.ok(appCleaned, 'all observed App subtree identities are reaped on the final cleanup path');
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) killOwnTree(launcher);
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      await fixtureCommand().catch(error => t.fail('App clipboard ownership refresh ' + error.message));
      fixture.stdin.write('quit\n');
      await until(() => fixture.exitCode !== null || fixture.signalCode !== null, 3000).catch(() => killOwnTree(fixture));
    }
    if (fixture) t.ok(fixture.exitCode !== null || fixture.signalCode !== null, 'self-owned App event receiver is reaped');
    if (paste && events.some(event => event.event === 'seed-clipboard' && event.clipboardSnapshot))
      t.ok(events.some(event => event.event === 'clipboard-restore' && event.restored), 'App paste fixture restores its pre-test clipboard snapshot');
    if (manual && events.some(event => event.event === 'source-pinyin'))
      t.ok(events.some(event => event.event === 'input-source-restore' && event.restored), 'App manual fixture restores its original keyboard source');
    if (appCleaned && t.failures === 0) fs.rmSync(root, { recursive: true, force: true });
    else if (appCleaned) console.log('INFO Failed App fixture retained at ' + root);
    else t.fail('Owned App processes remain. Isolated evidence retained at ' + root);
    t.done();
  }
})();

'use strict';
require('./lib/self-isolate-home');
// LaunchServices Ruyi.app -> owned workbench -> normal HTTP invoke -> real ACC -> native input worker.
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
const { buildMacDesktop } = require('../ruyi-workbench/tools/build-macos-desktop');
const t = createRunner('MACOS INPUT HOST');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-input-host-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
let fixture, launcher, owned, ownedTree = [];
const paste = process.env.RUYI_P5_APP_PASTE === '1';
const forceAppExit = process.env.RUYI_P5_APP_EXIT_FAILURE === '1';
const ax = process.env.RUYI_P5_APP_AX === '1';
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
    const helper = buildMacAutomationHelper({ output: path.join(root, 'input-helper') });
    const receiver = path.join(root, 'receiver');
    const compiled = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', receiver], { encoding: 'utf8', timeout: 60000 });
    if (compiled.status !== 0) throw new Error(compiled.stderr);
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
    const existing = path.resolve(__dirname, '../ruyi-workbench/dist/Ruyi.app');
    const bundle = process.env.RUYI_DESKTOP_TEST_APP || (fs.existsSync(existing) ? existing : buildMacDesktop(path.join(root, 'Ruyi.app')));
    const executable = path.join(bundle, 'Contents/MacOS/RuyiDesktop');
    const report = path.join(root, 'report.json');
    const script = path.join(root, 'script.js');
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const python = process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python');
    const isolated = fixtureChildEnv();
    const accEnv = { HOME: isolated.HOME, USERPROFILE: isolated.USERPROFILE, LOCALAPPDATA: isolated.LOCALAPPDATA,
      APPDATA: isolated.APPDATA, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      ...(process.env.DYLD_FRAMEWORK_PATH ? { DYLD_FRAMEWORK_PATH: process.env.DYLD_FRAMEWORK_PATH } : {}),
      ...(process.env.DYLD_LIBRARY_PATH ? { DYLD_LIBRARY_PATH: process.env.DYLD_LIBRARY_PATH } : {}),
      PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
      ACC_TOOLSETS: ax ? 'desktop,uia' : 'desktop', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper };
    const schema = require('../ruyi-workbench/app/server').CONFIG_SCHEMA;
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: schema, permissionMode: 'bypass',
      defaultWorkspace: root, workspaces: [{ path: root }], allowDesktopTools: true, allowCommandTools: true,
      providers: [], schedulerEnabledV1: false, stewardEnabledV1: false, includeWorkbenchMcp: false,
      autoImportClaudeCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false },
      externalMcpServers: [{ id: 'ai-computer-control', label: 'Controlled ACC', command: python,
        args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo, env: accEnv, enabled: true }] }));
    const sample = '如意 App 输入链 中文😀';
    if (paste) {
      const seed = await fixtureCommand('seed-clipboard');
      t.ok(seed.clipboardSnapshot && seed.clipboardPreserved, 'App paste fixture preserves the pre-test clipboard before seeding owned formats');
      if (!seed.clipboardSnapshot) throw new Error('Cannot preserve the pre-test clipboard');
      await fixtureCommand('clipboard-track ' + Buffer.from(sample, 'utf8').toString('base64'));
    }
    const pad = { x: Math.round(ready.pad.x + ready.pad.width / 2), y: Math.round(ready.pad.y + ready.pad.height / 2) };
    fs.writeFileSync(script, `const {api}=await import('/js/net.js');
const invoke=async(name,args={})=>{
  const reply=await api('/api/tools/tool_invoke_exec',{method:'POST',body:JSON.stringify({name:'ai_computer_control__'+name,arguments:args})});
  return reply.result;
};
const diag=await invoke('diagnostics');
const capabilities=diag.capabilities?.['desktop.capture'];
if(!capabilities || (${ax} ? !capabilities.axReady : !capabilities.inputReady)) return {capabilities,diagOK:diag.ok,unavailable:true};
const listed=await invoke('list_windows');
const row=listed.windows?.find(window=>window.pid===${fixture.pid}&&window.handle===${ready.id});
if(!row) return {capabilities,error:'owned_window_missing'};
const focused=await invoke('focus_window',{target:row.target});
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
return {capabilities,focused,typed,clicked,scrolled,ax};`);
    const env = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_NODE_PATH: process.execPath };
    const launchEnv = { HOME: env.HOME, USERPROFILE: env.USERPROFILE, LOCALAPPDATA: env.LOCALAPPDATA, APPDATA: env.APPDATA,
      RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data, RUYI_NODE_PATH: process.execPath };
    launcher = cp.spawn('/usr/bin/open', ['-n', '-W', '-a', bundle,
      ...Object.entries(launchEnv).flatMap(([key, value]) => ['--env', key + '=' + value]),
      '--args', '--acceptance-report', report, '--acceptance-script', script,
      ...(forceAppExit ? [] : ['--acceptance-auto-quit'])],
    { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    launcher.stdout.resume(); launcher.stderr.resume();
    const result = await until(() => {
      const value = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
      const table = snapshotProcessTable();
      for (const row of table?.filter(row => row.pid === value?.nativePID) || []) {
        const command = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout;
        if (command.startsWith(executable + ' ') && command.includes('--acceptance-report ' + report + ' ')) {
          owned = row;
          for (const member of [row, ...ownDescendants(table, row.pid).descendants]) {
            if (!ownedTree.some(prior => member.pid === prior.pid && member.created === prior.created)) ownedTree.push(member);
          }
        }
      }
      if (!value) return null;
      if (value.state === 'failed') throw new Error(JSON.stringify(value));
      return value.state === 'ready' && value;
    });
    const extra = result.page.additional;
    const state = await fixtureCommand();
    if (process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, 'input-host.json'), JSON.stringify({ nativePID: result.nativePID,
        servicePID: result.servicePID, launch: 'LaunchServices', ...extra,
        observedProcesses: ownedTree.map(row => ({ pid: row.pid, ppid: row.ppid, created: row.created.toString() })),
        receiver: { textMatches: state.text === sample, counts: state.counts, pad: state.pad,
          leftHeld: state.leftHeld, modifierFlags: state.modifierFlags, clipboardPreserved: state.clipboardPreserved } }, null, 2) + '\n');
    }
    t.ok(result.nativePID > 0 && result.servicePID > 0, 'LaunchServices Ruyi App owns the actual workbench service');
    t.ok(owned?.pid === result.nativePID && ownedTree.some(row => row.pid === result.servicePID),
      'App and service process identities were observed before shutdown');
    if (!(ax ? extra.capabilities?.axReady : extra.capabilities?.inputReady)) console.log('App input readiness ' + JSON.stringify(extra));
    t.ok(extra.capabilities?.windowAuthorization === 'granted' && (ax ? extra.capabilities.axReady :
      extra.capabilities.inputReady && extra.capabilities.eventAuthorization === 'granted'),
    ax ? 'App-launched ACC has actual Accessibility authorization for native AX' : 'App-launched ACC has its own actual Accessibility and event authorization');
    t.ok(extra.focused?.ok && extra.focused.foreground_verified, 'normal App HTTP tool route focuses the exact owned receiver');
    if (!ax) t.ok(extra.typed?.ok && extra.typed.method === (paste ? 'clipboard' : 'typewrite'),
      paste ? 'normal App HTTP tool route sends Chinese through Cmd+V' : 'normal App HTTP tool route sends Chinese Unicode events');
    if (paste && !ax) t.ok(extra.typed?.restore === 'done' && state.clipboardPreserved, 'App Cmd+V restores the prior image and private clipboard formats');
    if (ax) {
      t.ok(extra.capabilities?.axReady, 'App-origin native AX backend reports actual ready authorization');
      t.ok(extra.ax?.foundCount === 1 && extra.ax.element.element_ref, 'normal App HTTP route resolves the exact owned AX text area');
      t.ok(extra.ax?.written?.confirmed && extra.ax?.restored?.confirmed && state.text === sample,
        'App-origin AXValue writes change and restore the real receiver with confirmed readback');
    }
    if (!ax) {
      t.ok(extra.clicked?.ok && extra.scrolled?.ok, 'App launch chain sends guarded pointer and wheel events');
      t.ok(state.text === sample && state.counts.key_down > 0, 'real receiver confirms the App-originated Chinese text');
      t.ok(state.counts.left_down === 1 && state.counts.left_up === 1 && state.counts.vertical_scroll > 0,
        'real receiver confirms the App-originated balanced click and wheel events');
    }
    t.ok(!state.leftHeld && state.modifierFlags === 0, 'App input leaves actual button and modifier state released');
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
    let appCleaned = false;
    try { await cleanupOwned(); appCleaned = true; }
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
    if (appCleaned) fs.rmSync(root, { recursive: true, force: true });
    else t.fail('Owned App processes remain. Isolated evidence retained at ' + root);
    t.done();
  }
})();

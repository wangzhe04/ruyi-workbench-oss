'use strict';
require('./lib/self-isolate-home');
// Selected real application scenarios. All documents, pages and browser profiles are fixture-owned.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./lib/kill-own-tree');
const { loadServerInternals } = require('./lib/server-internals');
const { CdpClient, waitForTarget } = require('./lib/browser-fixture');
const { findBrowserExecutable } = require('./lib/browser-path');
const { getFreePort } = require('./free-port');
const { buildMacAutomationHelper } = require('../ruyi-workbench/tools/build-macos-automation-helper');
const t = createRunner('MACOS INPUT APPS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-p5-apps-'));
process.env.RUYI_HOME = path.join(root, 'data');
let client, runtime, textLauncher, textIdentity, browser, cdp, server, clipboard;
let registerTextEdit;
const textIdentities = new Map();
const browserIdentities = new Map();
const browserProfile = path.join(root, 'profile');
const reports = [];
async function until(read, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Selected application condition timed out');
}
async function call(name, args = {}) {
  const result = await client.callTool(name, args);
  if (!result.ok) throw new Error(name + ' ' + JSON.stringify(result));
  return result;
}
async function focusStableWindow(match) {
  let geometry = '', stableSince = 0;
  return until(async () => {
    const listed = await call('list_windows');
    const row = listed.windows.find(match);
    if (!row) return null;
    const current = JSON.stringify([row.handle, row.pid, row.process_start, row.target.bounds]);
    if (current !== geometry) { geometry = current; stableSince = Date.now(); return null; }
    if (Date.now() - stableSince < 250) return null;
    const focused = await client.callTool('focus_window', { target: row.target });
    // This precondition error is returned before the native action. Observe a
    // new target if an application's startup layout changes again.
    if (!focused.ok && focused.code === 'window_changed' && !focused.action_sent && !focused.acted) {
      geometry = ''; return null;
    }
    if (!focused.ok) throw new Error('focus_window ' + JSON.stringify(focused));
    return focused.window;
  });
}
async function clipboardCommand(command = 'state') {
  const offset = reports.length; clipboard.stdin.write(command + '\n');
  return until(() => reports.slice(offset).find(report => report.event === command), 3000);
}
async function stopTextEdit() {
  if (registerTextEdit && textLauncher && !textIdentities.size) {
    await until(() => {
      registerTextEdit();
      return textIdentities.size || textLauncher.exitCode !== null || textLauncher.signalCode !== null;
    });
  }
  for (const identity of textIdentities.values()) {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const current = snapshotProcessTable()?.find(row => row.pid === identity.pid && row.created === identity.created);
      if (!current) break;
      try { process.kill(current.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      try {
        await until(() => !snapshotProcessTable()?.some(row => row.pid === current.pid && row.created === current.created), 3000);
        break;
      } catch (error) { if (signal === 'SIGKILL') throw error; }
    }
  }
}
function trackBrowser() {
  const rows = snapshotProcessTable();
  if (!rows) throw new Error('Cannot observe the owned browser process table');
  const roots = browserIdentities.size ? [...browserIdentities.values()] : rows.filter(row => row.pid === browser.pid);
  if (!roots.length) throw new Error('Browser exited before its creation identity could be registered');
  for (const prior of roots) {
    if (!rows.some(row => row.pid === prior.pid && row.created === prior.created)) continue;
    browserIdentities.set(prior.pid + '/' + prior.created, prior);
    for (const row of ownDescendants(rows, prior.pid).descendants)
      browserIdentities.set(row.pid + '/' + row.created, row);
  }
}
function remainingBrowser() {
  const rows = snapshotProcessTable();
  if (!rows) throw new Error('Cannot verify owned browser cleanup');
  return rows.filter(row => browserIdentities.has(row.pid + '/' + row.created));
}
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP Mac selected input applications'); return; }
    const helper = buildMacAutomationHelper({ output: path.join(root, 'helper') });
    const status = cp.spawnSync(helper, [], { input: JSON.stringify({ version: 1, op: 'status' }), encoding: 'utf8', timeout: 5000 });
    if (!JSON.parse(status.stdout).inputReady) {
      if (process.env.RUYI_P5_INPUT_REQUIRED === '1') t.fail('Selected input apps require an unlocked desktop and Accessibility/event authorization');
      else console.log('SKIP selected app input until Accessibility/event posting are authorized');
      return;
    }
    const repo = path.resolve(__dirname, '../mcp/ai-computer-control');
    const S = loadServerInternals(['McpStdioClient', 'ProcessRuntime']); runtime = S.ProcessRuntime;
    const connection = { id: 'ai-computer-control', command: process.env.RUYI_ACC_PYTHON || path.join(repo, '.venv/bin/python'),
      args: ['-X', 'utf8', '-m', 'ai_computer_control.server'], cwd: repo,
      env: { ...fixtureChildEnv(), PYTHONPATH: path.join(repo, 'src'), WCW_DATA_DIR: path.join(root, 'acc-data'),
        ACC_TOOLSETS: 'desktop', ACC_HIDE_TOOLS: '', RUYI_MACOS_AUTOMATION_HELPER: helper } };
    client = new S.McpStdioClient(connection);
    await client.start();
    const note = path.join(root, 'P5 TextEdit ' + process.pid + '.txt');
    fs.writeFileSync(note, 'controlled baseline\n');
    const before = new Set(snapshotProcessTable().map(row => row.pid));
    const textExecutable = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit';
    registerTextEdit = () => {
      for (const row of snapshotProcessTable() || []) {
        if (before.has(row.pid)) continue;
        const command = cp.spawnSync('/bin/ps', ['-p', String(row.pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }).stdout;
        if (command.startsWith(textExecutable + ' ') && command.includes('-RuyiP5Fixture ' + root))
          textIdentities.set(row.pid + '/' + row.created, row);
      }
    };
    textLauncher = cp.spawn('/usr/bin/open', ['-n', '-W', '-a', '/System/Applications/TextEdit.app', note,
      '--args', '-ApplePersistenceIgnoreState', 'YES', '-RuyiP5Fixture', root], { env: fixtureChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    textLauncher.stdout.resume(); textLauncher.stderr.resume();
    await until(() => {
      registerTextEdit();
      return textIdentities.size || textLauncher.exitCode !== null || textLauncher.signalCode !== null;
    });
    if (!textIdentities.size) throw new Error('TextEdit launch ended without a registered fixture process');
    if (process.env.RUYI_P5_TEXTEDIT_FAIL_BEFORE_OBSERVE === '1') throw new Error('Injected TextEdit pre-observation fixture failure');
    let textWindow = await until(async () => {
      registerTextEdit();
      const listed = await call('list_windows');
      return listed.windows.find(window => window.title.includes(path.basename(note)) && !before.has(window.pid));
    });
    textIdentity = [...textIdentities.values()].find(row => row.pid === textWindow.pid);
    if (!textIdentity) throw new Error('TextEdit window does not match the registered process invocation');
    t.ok(textIdentity && !before.has(textIdentity.pid), 'TextEdit document belongs to a newly created fixture process');
    textWindow = await focusStableWindow(window => window.pid === textIdentity.pid && window.handle === textWindow.handle);
    await call('hotkey', { keys: 'cmd+a', target: textWindow.target });
    const documentText = 'P5 TextEdit 中文😀\n第二行';
    const typed = await call('type_text', { text: documentText, use_clipboard: false, interval: 0, target: textWindow.target });
    await call('hotkey', { keys: 'cmd+s', target: textWindow.target });
    await until(() => fs.readFileSync(note, 'utf8') === documentText);
    t.ok(typed.method === 'typewrite' && fs.readFileSync(note, 'utf8') === documentText,
      'real TextEdit consumes Chinese Unicode events and Cmd+S saves the exact owned UTF-8 document');
    const closed = await call('close_window', { target: textWindow.target });
    t.ok(closed.matched, 'saved TextEdit fixture window closes with verified AX absence');
    await stopTextEdit();
    await until(() => textLauncher.exitCode !== null || textLauncher.signalCode !== null);
    t.ok(!snapshotProcessTable().some(row => row.pid === textIdentity.pid && row.created === textIdentity.created),
      'only the observed new TextEdit process is reaped');

    const receiver = path.join(root, 'clipboard-fixture');
    const built = cp.spawnSync('/usr/bin/xcrun', ['clang', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror',
      '-mmacosx-version-min=14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices',
      path.join(__dirname, 'fixtures/macos-input-window.m'), '-o', receiver], { encoding: 'utf8', timeout: 60000 });
    if (built.status !== 0) throw new Error(built.stderr);
    clipboard = cp.spawn(receiver, ['--clipboard-only'], { env: { ...fixtureChildEnv(), RUYI_P5_CLIPBOARD_FIXTURE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    clipboard.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { reports.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
    });
    clipboard.stderr.resume();
    await until(() => reports.find(report => report.event === 'ready'));
    const seeded = await clipboardCommand('seed-clipboard');
    t.ok(seeded.clipboardSnapshot && seeded.clipboardPreserved, 'nonactivating fixture preserves the pre-browser clipboard');
    if (!seeded.clipboardSnapshot) throw new Error('Cannot preserve the pre-browser clipboard');
    const pageTitle = 'Ruyi P5 Chromium ' + process.pid;
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>' + pageTitle + '</title>'
        + '<style>body{margin:40px;font:18px sans-serif}main{width:2800px;height:6000px}textarea{display:block;width:640px;height:160px}button{margin-top:30px;width:300px;height:60px}</style>'
        + '<main><h1>P5 controlled page</h1><textarea id="draft" autofocus></textarea><button id="apply">Apply</button><pre id="result"></pre></main>'
        + '<script>window.events={clicks:0};document.querySelector("#apply").addEventListener("click",event=>{events.clicks++;events.trusted=event.isTrusted;document.querySelector("#result").textContent=document.querySelector("#draft").value});'
        + 'addEventListener("wheel",event=>{events.wheel={trusted:event.isTrusted,x:event.deltaX,y:event.deltaY}});</script>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port + '/';
    const executable = findBrowserExecutable();
    if (!executable) throw new Error('Set RUYI_E2E_BROWSER to an installed Chromium executable');
    const debugPort = await getFreePort();
    browser = cp.spawn(executable, ['--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
      '--disable-background-networking', '--use-mock-keychain', '--password-store=basic', '--window-size=1200,850',
      '--user-data-dir=' + browserProfile, '--remote-debugging-port=' + debugPort, url],
    { env: fixtureChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    browser.stdout.resume(); browser.stderr.resume();
    trackBrowser();
    const found = await waitForTarget(debugPort, url, browser);
    if (!found.target) throw new Error(found.why);
    trackBrowser();
    t.ok(browserIdentities.size > 1 && fs.existsSync(browserProfile), 'browser and descendant creation identities belong to the controlled profile');
    cdp = new CdpClient(found.target.webSocketDebuggerUrl); await cdp.connect();
    const version = await cdp.send('Browser.getVersion');
    const chromeWindow = await focusStableWindow(window => window.pid === browser.pid && window.title.includes(pageTitle));
    const activeChrome = await call('get_active_window');
    t.ok(activeChrome.window.handle === chromeWindow.handle && activeChrome.window.pid === browser.pid,
      'active-window query agrees with the actual Chromium window despite decorated AX titles');
    await until(() => cdp.evaluate('document.activeElement?.id === "draft"'));
    const draft = 'Chromium 中文粘贴😀\n第二行';
    await clipboardCommand('clipboard-track ' + Buffer.from(draft, 'utf8').toString('base64'));
    const pasted = await call('type_text', { text: draft, target: chromeWindow.target });
    await until(async () => await cdp.evaluate('document.querySelector("#draft").value') === draft);
    const board = await clipboardCommand();
    t.ok(pasted.method === 'clipboard' && pasted.restore === 'done' && board.clipboardPreserved,
      'real Chromium consumes multiline Chinese Cmd+V and preserves prior clipboard formats');
    const button = await cdp.evaluate('(()=>{const r=document.querySelector("#apply").getBoundingClientRect();return {x:Math.round(screenX+r.x+r.width/2),y:Math.round(screenY+outerHeight-innerHeight+r.y+r.height/2)}})()');
    const clicked = await call('mouse_click', { ...button, target: chromeWindow.target });
    await until(() => cdp.evaluate('events.clicks===1 && events.trusted===true'));
    t.ok(clicked.reached && await cdp.evaluate('document.querySelector("#result").textContent') === draft,
      'native logical-point click reaches the Chromium DOM as a trusted event');
    await call('mouse_scroll', { ...button, clicks: -4, target: chromeWindow.target });
    await until(() => cdp.evaluate('scrollY>0 && events.wheel?.trusted===true'));
    t.ok(await cdp.evaluate('scrollY>0'), 'real Chromium scroll position confirms native vertical wheel direction');
    await call('mouse_scroll', { ...button, clicks: 3, direction: 'horizontal', target: chromeWindow.target });
    await until(() => cdp.evaluate('scrollX>0 && events.wheel?.trusted===true && Math.abs(events.wheel.x)>0'));
    t.ok(await cdp.evaluate('scrollX>0'), 'real Chromium scroll position confirms positive horizontal wheel input moves right');
    const mirror = await cdp.send('Target.createTarget', { url: url + '?mirror', newWindow: true });
    const mirrorWindow = await cdp.send('Browser.getWindowForTarget', { targetId: mirror.targetId });
    await cdp.send('Browser.setWindowBounds', { windowId: mirrorWindow.windowId, bounds: {
      left: chromeWindow.x, top: chromeWindow.y, width: chromeWindow.width, height: chromeWindow.height } });
    const coveredRow = await until(async () => {
      const listed = await call('list_windows');
      return listed.windows.find(window => window.pid === browser.pid && window.handle !== chromeWindow.handle
        && window.title.includes(pageTitle) && window.x === chromeWindow.x && window.y === chromeWindow.y
        && window.width === chromeWindow.width && window.height === chromeWindow.height);
    });
    await until(async () => !await cdp.evaluate('document.hasFocus()'));
    t.ok(coveredRow.handle !== chromeWindow.handle, 'two real Chromium windows have the same title and exact observed geometry');
    const priorClient = client.child; client.kill();
    const priorClean = await runtime.waitForCleanup(priorClient, 3000);
    t.ok(priorClean && !priorClean.incomplete, 'prior input reference session is fully reaped before the ambiguity check');
    client = new S.McpStdioClient(connection); await client.start();
    const freshRows = await call('list_windows');
    const coveredTarget = freshRows.windows.find(window => window.pid === browser.pid && window.handle === chromeWindow.handle);
    const refused = await client.callTool('focus_window', { target: coveredTarget.target });
    t.ok(!refused.ok && ['window_unsupported', 'window_ambiguous'].includes(refused.code)
      && !refused.action_sent && !refused.acted && !await cdp.evaluate('document.hasFocus()'),
      'fresh decorated-title binding refuses equal-geometry Chromium ambiguity before any focus action');
    if (process.env.RUYI_P5_EVIDENCE) {
      fs.mkdirSync(process.env.RUYI_P5_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.RUYI_P5_EVIDENCE, 'selected-apps.json'), JSON.stringify({ textEdit: { pid: textIdentity.pid,
        ownDocumentExact: true, closed: true }, chromium: { executable, product: version.product, pid: browser.pid,
        windowTitle: chromeWindow.title, bounds: chromeWindow.target.bounds, clipboardRestored: board.clipboardPreserved,
        trustedClick: true, scrollY: await cdp.evaluate('scrollY'), scrollX: await cdp.evaluate('scrollX'),
        ambiguousRebindRefused: true } }, null, 2) + '\n');
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    let browserClean = true;
    if (cdp) cdp.close();
    if (browser) {
      try { trackBrowser(); } catch (error) { browserClean = false; t.fail(error.message); }
    }
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      killOwnTree(browser); await until(() => browser.exitCode !== null || browser.signalCode !== null).catch(error => t.fail(error.message));
    }
    if (browserIdentities.size) {
      try {
        for (const prior of remainingBrowser()) {
          if (!remainingBrowser().some(row => row.pid === prior.pid && row.created === prior.created)) continue;
          try { process.kill(prior.pid, 'SIGKILL'); }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        await until(() => remainingBrowser().length === 0);
        t.ok(remainingBrowser().length === 0, 'all recorded browser and descendant identities are absent before profile removal');
      } catch (error) { browserClean = false; t.fail('Browser cleanup ' + error.message); }
    }
    await stopTextEdit().catch(error => t.fail('TextEdit cleanup ' + error.message));
    if (textIdentities.size) t.ok(!snapshotProcessTable()?.some(row => [...textIdentities.values()].some(prior => row.pid === prior.pid && row.created === prior.created)),
      'all early-registered TextEdit process identities are absent on final cleanup');
    if (textLauncher && textLauncher.exitCode === null && textLauncher.signalCode === null) killOwnTree(textLauncher);
    if (client?.child) {
      const child = client.child; client.kill(); const cleaned = await runtime.waitForCleanup(child, 3000);
      t.ok(cleaned && !cleaned.incomplete, 'selected-app input MCP and native worker cleanup is confirmed');
    }
    if (clipboard && clipboard.exitCode === null && clipboard.signalCode === null) {
      await clipboardCommand().catch(error => t.fail('Clipboard ownership refresh ' + error.message));
      clipboard.stdin.write('quit\n');
      await until(() => clipboard.exitCode !== null || clipboard.signalCode !== null, 3000).catch(() => killOwnTree(clipboard));
    }
    if (reports.some(report => report.event === 'seed-clipboard' && report.clipboardSnapshot))
      t.ok(reports.some(report => report.event === 'clipboard-restore' && report.restored), 'selected-app fixture restores the pre-test clipboard');
    if (server) await new Promise(resolve => server.close(resolve));
    if (browserClean) {
      fs.rmSync(root, { recursive: true, force: true });
      if (browserIdentities.size) t.ok(!fs.existsSync(browserProfile), 'controlled browser profile is removed after its processes exit');
    } else t.fail('Browser cleanup evidence retained at ' + root);
    t.done();
  }
})();

require('./lib/self-isolate-home.js');
'use strict';
// P3-03: real Chromium/Playwright through production MCP. Every URL/profile/cache
// belongs to the fixture; no default browser, real forms, accounts, or downloads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const http = require('http');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { McpStdioClient, killAllMcpClients } = require('../ruyi-workbench/app/server.js');
const t = createRunner('MACOS BROWSER RUNTIME');
const { ok } = t;
const acc = path.resolve(__dirname, '../mcp/ai-computer-control');
const python = process.env.RUYI_ACC_PYTHON || path.join(acc, '.venv/bin/python');
const sourceCache = process.env.RUYI_BROWSER_CACHE_SOURCE || '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await test()) return true; await sleep(50); }
  return false;
}
const jsonFetch = async (url, options = {}) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + url);
  return response.json();
};
const readFixtureDraft = url => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  const timer = setTimeout(() => { socket.close(); reject(new Error('fixture CDP read timed out')); }, 5000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
    params: { expression: "document.querySelector('#draft').value", returnByValue: true } })));
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data); if (value.id !== 1) return;
    clearTimeout(timer); socket.close(); resolve(value.result?.result?.value);
  });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('fixture CDP socket failed')); });
});

(async () => {
  if (process.platform !== 'darwin') { console.log('SKIP macOS browser runtime'); t.done(); return; }
  if (!fs.existsSync(python) || !sourceCache || !fs.existsSync(sourceCache)) {
    if (process.env.RUYI_BROWSER_REQUIRED === '1') t.fail('Prepare ACC Playwright and RUYI_BROWSER_CACHE_SOURCE before offline acceptance');
    else console.log('SKIP set RUYI_BROWSER_CACHE_SOURCE and install the browser test runtime; RUYI_BROWSER_REQUIRED=1 makes this mandatory');
    t.done(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-browser-mcp-'));
  const cache = path.join(root, 'cache 空格'); fs.mkdirSync(cache);
  for (const name of fs.readdirSync(sourceCache).filter(n => /^chromium-\d+$|^ffmpeg-\d+$/.test(n)))
    cp.execFileSync('/bin/cp', ['-cR', path.join(sourceCache, name), path.join(cache, name)]);
  const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp);
  const sharedFile = path.join(root, 'sentinel.txt'); fs.writeFileSync(sharedFile, 'Shared file tools still work');
  const baseEnv = { ...fixtureChildEnv(), ACC_TOOLSETS: 'browser,filesystem', ACC_BROWSER_MODE: 'bundled',
    ACC_BROWSER_HEADLESS: '1', ACC_BROWSER_EXECUTABLE: '', PLAYWRIGHT_BROWSERS_PATH: cache,
    TMPDIR: tmp, WCW_DATA_DIR: path.join(root, 'acc'), PYTHONUTF8: '1' };
  if (process.env.RUYI_ACC_INSTALLED_ONLY === '1') delete baseEnv.PYTHONPATH;
  else baseEnv.PYTHONPATH = path.join(acc, 'src');
  const clients = [], externalProcesses = [];
  const makeClient = (extra = {}, args = ['-X', 'utf8', '-m', 'ai_computer_control.server']) => {
    const client = new McpStdioClient({ id: 'browser-fixture-' + clients.length, command: python, args,
      cwd: acc, env: { ...baseEnv, ...extra } });
    clients.push(client); return client;
  };
  const call = async (client, name, args = {}) => {
    const value = await client.callTool(name, args, 30000);
    if (!value.ok) throw new Error(name + ': ' + JSON.stringify(value));
    return value;
  };
  const closeByEof = async client => {
    const child = client.child; child.stdin.end();
    if (!await until(() => child.exitCode !== null || child.signalCode !== null, 15000))
      throw new Error('MCP did not shut down after stdio EOF');
    if (child.exitCode !== 0) throw new Error('MCP shutdown failed with ' + child.exitCode);
  };
  const processes = () => cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean).map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const ownedSnapshot = parent => {
    const rows = processes(); const ids = new Set([parent]);
    for (let pass = 0; pass < rows.length; pass++) {
      const old = ids.size; for (const row of rows) if (ids.has(row.ppid)) ids.add(row.pid);
      if (ids.size === old) break;
    }
    return rows.filter(row => row.pid !== parent && ids.has(row.pid));
  };
  const gone = rows => {
    const current = new Map(processes().map(row => [row.pid, row.command]));
    return rows.every(row => current.get(row.pid) !== row.command);
  };
  const profilePaths = rows => [...new Set(rows.map(row => /--user-data-dir=([^\s]+)/.exec(row.command)?.[1]).filter(Boolean))];
  const submissions = [];
  const html = (title, body) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><style>body{font:20px sans-serif;max-width:760px;margin:60px auto;background:#f5f8fc;color:#173254}input,button{font:inherit;padding:10px;margin:10px}button{background:#2f5597;color:white;border:0}</style>' + body;
  const fixture = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/submit' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { submissions.push(new URLSearchParams(body).get('name')); res.end(html('提交成功', '<h1>本地表单提交成功</h1><p id="result">如意浏览器测试</p>')); });
    } else if (req.url === '/workbench') res.end(html('如意 Ruyi Workbench', '<h1>保留工作台</h1><input id="draft" value="未提交草稿">'));
    else if (req.url === '/second') res.end(html('第二页', '<h1 id="second">第二个离线页面</h1>'));
    else res.end(html('Mac浏览器验收', '<h1>Mac 浏览器运行时验收</h1><form method="post" action="/submit"><label>姓名<input id="name" name="name"></label><button id="submit">提交本地表单</button></form>'));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + fixture.address().port;
  const summaries = {};
  let screenshot;
  try {
    const client = makeClient(); await client.start();
    const before = await call(client, 'browser_backend_status'); summaries.before = before;
    ok(before.installed && before.runtimeInstalled && !before.ready && before.executable.startsWith(cache),
      'prepared cache is resolved by the SDK; installed binary alone is not reported ready');
    await call(client, 'browser_open', { url: base });
    const active = await call(client, 'browser_backend_status'); summaries.active = active;
    ok(active.ready && active.profileIsolation === 'ephemeral-owned', 'bundled Chromium attaches with its own ephemeral profile');
    const owned = ownedSnapshot(client.child.pid);
    const browserOwned = owned.filter(row => row.command.includes(cache) || row.command.includes(fs.realpathSync(cache)) || row.command.includes('/playwright/driver/'));
    const profiles = profilePaths(owned);
    ok(profiles.length > 0 && profiles.every(p => fs.existsSync(p) && fs.realpathSync(p).startsWith(fs.realpathSync(tmp) + path.sep)),
      'actual Chromium command line uses fixture-only user-data-dir paths');
    ok(browserOwned.some(row => row.command.includes('--user-data-dir=')), 'cleanup observations include the actual browser process, not only its driver');
    await call(client, 'browser_type', { selector: '#name', text: '如意浏览器测试' });
    await call(client, 'browser_click', { selector: '#submit' });
    const result = await call(client, 'browser_get_text', { selector: '#result' });
    ok(result.text === '如意浏览器测试' && submissions.length === 1 && submissions[0] === '如意浏览器测试',
      'real browser fills and submits a Chinese form only to the local fixture');
    screenshot = await call(client, 'browser_screenshot');
    const pixels = Buffer.from(screenshot.image, 'base64');
    ok(pixels.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && screenshot.width <= 1280 && screenshot.height > 100,
      'real page screenshot returns a valid bounded PNG');
    await call(client, 'browser_open', { url: base + '/second', new_tab: false });
    const back = await call(client, 'browser_navigate', { action: 'back' });
    ok(back.url.endsWith('/submit'), 'browser back navigation preserves the local history');
    await call(client, 'browser_navigate', { action: 'forward' });
    await call(client, 'browser_open', { url: base, new_tab: true });
    const tabs = await call(client, 'browser_list_tabs');
    const second = tabs.tabs.find(tab => tab.url === base + '/second');
    await call(client, 'browser_switch_tab', { index: second.index });
    ok((await call(client, 'browser_get_text', { selector: '#second' })).text === '第二个离线页面',
      'tabs can be listed and switched without losing their page state');
    const offlinePort = await getFreePort();
    const offline = await client.callTool('browser_open', { url: 'http://127.0.0.1:' + offlinePort }, 15000);
    ok(!offline.ok && /CONNECTION_REFUSED|ERR_CONNECTION|net::/.test(offline.error), 'unavailable local site returns an actual navigation error');
    const closed = await call(client, 'browser_close');
    const processesGone = await until(() => gone(browserOwned));
    const profilesGone = await until(() => profiles.every(p => !fs.existsSync(p)));
    console.log('OWNED_CLOSE=' + JSON.stringify({ closed, processesGone, profilesGone,
      remaining: processes().filter(row => browserOwned.some(before => before.pid === row.pid && before.command === row.command)) }));
    ok(closed.closed && processesGone && profilesGone,
      'browser_close removes owned Chromium/driver processes and temporary profiles');
    ok(!(await call(client, 'browser_backend_status')).ready, 'closed backend no longer claims readiness');
    await call(client, 'browser_open', { url: base });
    const eofOwned = ownedSnapshot(client.child.pid), eofProfiles = profilePaths(eofOwned);
    await closeByEof(client);
    ok(await until(() => gone(eofOwned)) && await until(() => eofProfiles.every(p => !fs.existsSync(p))),
      'stdio EOF lifespan closes the owned browser, driver and profile without browser_close');

    const managed = makeClient({ ACC_BROWSER_MODE: 'managed' }); await managed.start();
    const managedTarget = await call(managed, 'browser_backend_status'); summaries.managed = managedTarget;
    if (managedTarget.runtimeInstalled) {
      await call(managed, 'browser_open', { url: base + '/second' });
      const managedOwned = ownedSnapshot(managed.child.pid);
      const appRoot = managedTarget.executable.split('.app/')[0] + '.app/';
      const managedRuntime = managedOwned.filter(row => row.command.includes(appRoot) || row.command.includes('/playwright/driver/'));
      const managedProfiles = profilePaths(managedOwned);
      ok((await call(managed, 'browser_get_text', { selector: '#second' })).text === '第二个离线页面' &&
         managedProfiles.length > 0 && managedProfiles.every(p => fs.realpathSync(p).startsWith(fs.realpathSync(tmp) + path.sep)),
        'auto-discovered installed Mac Chromium also launches with an isolated fixture profile');
      await call(managed, 'browser_close');
      ok(await until(() => gone(managedRuntime)) && await until(() => managedProfiles.every(p => !fs.existsSync(p))),
        'installed-browser automation cleans only its owned runtime and profile');
    } else console.log('SKIP managed-mode live case: no installed compatible Mac Chromium app');
    await closeByEof(managed);

    const missing = makeClient({ PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'missing-cache') }); await missing.start();
    const absent = await call(missing, 'browser_backend_status');
    const refused = await missing.callTool('browser_open', { url: base });
    ok(!absent.runtimeInstalled && !absent.ready && !refused.ok && /missing|not executable/.test(refused.error),
      'missing offline browser cache reports the real dependency gap without downloading');
    ok((await call(missing, 'read_file', { path: sharedFile })).content === 'Shared file tools still work',
      'browser runtime failure does not disable unrelated shared file tools');
    ok(!fs.existsSync(path.join(root, 'missing-cache')), 'failed runtime lookup creates no browser cache');
    await closeByEof(missing);
    const noPackage = makeClient({}, ['-X', 'utf8', '-c', "import sys;sys.modules['playwright']=None;from ai_computer_control.server import main;main()"]);
    await noPackage.start();
    const pkg = await noPackage.callTool('browser_open', { url: base });
    ok(!pkg.ok && pkg.code === 'browser.package_missing', 'absent Playwright package returns a precise failure while MCP remains available');
    await closeByEof(noPackage);

    // An independently started CDP browser acts as the user-owned session.
    const externalProfile = path.join(root, 'external-profile'); fs.mkdirSync(externalProfile);
    const sentinel = path.join(externalProfile, 'do-not-delete.txt'); fs.writeFileSync(sentinel, 'user-owned profile sentinel');
    const external = cp.spawn(before.executable, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      // Like Playwright's owned launches, never prompt for the user's Mac keychain.
      // Without this, a fresh standalone Chrome can block before local navigation.
      '--password-store=basic', '--use-mock-keychain', '--disable-extensions', '--disable-background-networking',
      '--no-startup-window', '--user-data-dir=' + externalProfile], { env: baseEnv, stdio: ['ignore','ignore','ignore'] });
    externalProcesses.push(external);
    const portFile = path.join(externalProfile, 'DevToolsActivePort');
    if (!await until(() => fs.existsSync(portFile))) throw new Error('controlled CDP browser did not publish its endpoint');
    const cdpBase = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const original = await jsonFetch(cdpBase + '/json/new?' + base + '/workbench', { method: 'PUT' });
    if (!await until(async () => {
      try { return await readFixtureDraft(original.webSocketDebuggerUrl) === '未提交草稿'; }
      catch { return false; }
    })) throw new Error('controlled CDP page did not become ready');
    const cdp = makeClient({ ACC_BROWSER_MODE: 'cdp', ACC_BROWSER_CDP_URL: cdpBase }); await cdp.start();
    await call(cdp, 'browser_type', { selector: '#draft', text: '保留未提交文本' });
    await call(cdp, 'browser_close');
    ok((await jsonFetch(cdpBase + '/json/list')).some(tab => tab.id === original.id),
      'CDP read/type followed by close never closes an existing unowned page');
    const preserved = await call(cdp, 'browser_open', { url: base + '/second', new_tab: false });
    ok(preserved.preservedWorkbench && preserved.newTab, 'connected Workbench page is preserved even when new_tab=false');
    await call(cdp, 'browser_open', { url: base, new_tab: true });
    const cdpTabs = await call(cdp, 'browser_list_tabs');
    const originalTab = cdpTabs.tabs.find(tab => tab.url === base + '/workbench');
    await call(cdp, 'browser_switch_tab', { index: originalTab.index });
    const detaching = await call(cdp, 'browser_close');
    const remaining = await jsonFetch(cdpBase + '/json/list');
    console.log('CDP_REMAINING=' + JSON.stringify(remaining.map(tab => ({ id: tab.id, type: tab.type, url: tab.url }))));
    const pageTargets = remaining.filter(tab => tab.type === 'page');
    ok(!detaching.closed && pageTargets.length === 1 && pageTargets[0].id === original.id && fs.readFileSync(sentinel, 'utf8') === 'user-owned profile sentinel',
      'CDP close removes every owned tab and preserves the original page and profile sentinel');
    const guarded = await cdp.callTool('browser_execute_js', { script: "document.querySelector('#draft').value" });
    ok(!guarded.ok && /Workbench/.test(guarded.error), 'Workbench JavaScript credential/data guard remains enforced');
    ok(await readFixtureDraft(original.webSocketDebuggerUrl) === '保留未提交文本',
      'independent fixture-only CDP check confirms the original page retained its unsaved form state');
    await closeByEof(cdp);
    ok(external.exitCode === null && external.signalCode === null, 'MCP shutdown detaches from CDP without terminating the external browser');
    if (process.env.RUYI_BROWSER_ARTIFACT_DIR) {
      const parent = path.resolve(process.env.RUYI_BROWSER_ARTIFACT_DIR); fs.mkdirSync(parent, { recursive: true });
      const output = fs.mkdtempSync(path.join(parent, 'browser-'));
      fs.writeFileSync(path.join(output, 'page.png'), pixels);
      fs.writeFileSync(path.join(output, 'runtime.json'), JSON.stringify({ ...summaries, screenshot: { width: screenshot.width, height: screenshot.height }, submissions }, null, 2));
      console.log('ARTIFACT_DIR=' + output);
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    for (const client of clients) client.kill();
    killAllMcpClients();
    for (const proc of externalProcesses) await killOwnTree(proc);
    await new Promise(resolve => fixture.close(resolve));
    ok(await until(() => processes().every(row => !row.command.includes(cache) && !row.command.includes(fs.realpathSync(cache)))),
      'all fixture Chromium processes are gone after final cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
  t.done();
})();

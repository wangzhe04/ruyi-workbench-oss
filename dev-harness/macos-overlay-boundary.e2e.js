'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const { createRunner } = require('./lib/harness');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('MACOS OVERLAY BOUNDARY');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-overlay-mac-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
process.env.RUYI_HOME = path.join(root, 'loader-data');
const realFetch = global.fetch;
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  try {
    if (process.platform !== 'darwin') { console.log('SKIP requires macOS platform routes'); return; }
    const { CONFIG_SCHEMA } = loadServerInternals(['CONFIG_SCHEMA']);
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: CONFIG_SCHEMA, defaultWorkspace: root,
      stewardEnabledV1: false, schedulerEnabledV1: false, autoImportClaudeCodeMcp: false,
      includeWorkbenchMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [], providers: [] }));
    const calls = path.join(root, 'powershell-called');
    const preload = path.join(root, 'no-powershell.cjs');
    fs.writeFileSync(preload, `const cp=require('child_process'),fs=require('fs');const original=cp.execFile;cp.execFile=function(command,args,options,callback){if(/^powershell(?:\\.exe)?$/i.test(command)){fs.writeFileSync(${JSON.stringify(calls)},command);return original.call(this,process.execPath,['-e','process.exit(99)'],options,callback)}return original.apply(this,arguments)};`);
    const port = await getFreePort();
    const base = 'http://127.0.0.1:' + port;
    child = cp.spawn(process.execPath, ['--require', preload, path.resolve(__dirname, '../ruyi-workbench/app/server.js'), 'serve', '--port', String(port)], {
      cwd: root, env: { ...process.env, ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { output = (output + b).slice(-12000); });
    const deadline = Date.now() + 30000;
    let healthy = false;
    while (!healthy && Date.now() < deadline) {
      try { healthy = (await (await realFetch(base + '/health', { signal: AbortSignal.timeout(500) })).json()).ok; } catch { /* starting */ }
      if (!healthy) await sleep(50);
    }
    if (!healthy) throw new Error(output);
    const token = (await (await realFetch(base + '/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).token;
    if (!token) throw new Error('bootstrap token missing');
    const headers = { 'content-type': 'application/json', 'x-wcw-token': token };
    const zipPath = path.join(root, 'fixture.zip'); fs.writeFileSync(zipPath, 'fixture');
    for (const action of ['precheck', 'apply', 'rollback']) {
      const denied = await realFetch(base + '/api/overlay/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zipPath }) });
      t.ok(denied.status === 403, action + ' retains authentication before platform rejection');
      const response = await realFetch(base + '/api/overlay/' + action, { method: 'POST', headers, body: JSON.stringify({ zipPath, force: true }) });
      const result = await response.json();
      t.ok(response.status === 501 && result.error?.code === 'overlay.platform_unsupported', action + ' rejects Windows overlay on Mac with an explicit platform error');
    }
    t.ok(!fs.existsSync(calls) && !fs.existsSync(path.join(data, 'overlay-tool')), 'rejected operations launch no PowerShell and create no extraction/cache directory');
    t.ok((await realFetch(base + '/api/overlay/status')).status === 403, 'read-only overlay status retains token authentication');
    const status = await (await realFetch(base + '/api/overlay/status', { headers })).json();
    t.ok(status.ok && status.supported === false && status.platform === 'darwin' && status.backups.length === 0, 'status truthfully advertises unavailable overlay support');

    // Execute the real frontend module with a minimal DOM and the real HTTP status.
    const nodes = new Map();
    for (const id of ['ovPickBtn','ovPrecheckBtn','ovApplyBtn','ovRollbackBtn','ovRefreshBtn','ovCurrent','ovCurrentHint','ovAudit','ovPreviewBox']) nodes.set(id, { disabled: false, style: {}, textContent: '' });
    global.document = { getElementById: id => nodes.get(id), documentElement: {}, querySelectorAll: () => [], querySelector: () => ({ content: token }) };
    global.window = { dispatchEvent() {} };
    let requestCount = 0, overrideStatus;
    global.fetch = async (url, options) => {
      if (url instanceof URL && url.protocol === 'file:') return new Response(fs.readFileSync(fileURLToPath(url)), { headers: { 'content-type': 'application/json' } });
      requestCount++;
      if (overrideStatus) return new Response(JSON.stringify(overrideStatus), { headers: { 'content-type': 'application/json' } });
      return realFetch(new URL(String(url), base), options);
    };
    const js = path.resolve(__dirname, '../ruyi-workbench/app/public/js');
    const { setLocale } = await import(pathToFileURL(path.join(js, 'i18n.js')).href);
    const { createSettingsOperationsDomain } = await import(pathToFileURL(path.join(js, 'settings-operations.js')).href);
    await setLocale('zh-CN');
    const ops = createSettingsOperationsDomain(); ops.bindSettingsOperations();
    const buttons = ['ovPickBtn','ovPrecheckBtn','ovApplyBtn','ovRollbackBtn'].map(id => nodes.get(id));
    t.ok(buttons.every(b => b.disabled), 'update controls start disabled until support is known');
    await ops.refreshOverlayStatus();
    t.ok(buttons.every(b => b.disabled) && nodes.get('ovCurrentHint').textContent.includes('macOS'), 'Mac update panel disables all actions and explains the platform limit');
    const before = requestCount; for (const button of buttons) await button.onclick();
    t.ok(requestCount === before, 'programmatic clicks cannot submit unsupported update operations');
    await setLocale('en-US'); await ops.refreshOverlayStatus();
    t.ok(nodes.get('ovCurrentHint').textContent === 'Windows overlay updates are unavailable on macOS.', 'unsupported update hint is localized in English');
    overrideStatus = { ok: true, supported: true, current: null, backups: [], audit: [] };
    await ops.refreshOverlayStatus();
    t.ok(!nodes.get('ovPickBtn').disabled && !nodes.get('ovPrecheckBtn').disabled && !nodes.get('ovRollbackBtn').disabled && nodes.get('ovApplyBtn').disabled, 'supported hosts enable selection/precheck/rollback while keeping apply gated by precheck');
    t.ok((await (await realFetch(base + '/health')).json()).ok, 'platform rejection leaves the service healthy');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    global.fetch = realFetch;
    if (child) { killOwnTree(child); if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve)); }
    fs.rmSync(root, { recursive: true, force: true }); t.done();
  }
})();

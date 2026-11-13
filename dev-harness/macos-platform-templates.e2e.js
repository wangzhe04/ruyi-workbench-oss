require('./lib/self-isolate-home.js');
'use strict';
// P3-04: real Workbench + ACC capabilities/listing; no public websites or UI actions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { createRunner } = require('./lib/harness');
const repo = path.resolve(__dirname, '..');
const acc = path.join(repo, 'mcp/ai-computer-control');
const srv = require('../ruyi-workbench/app/server.js');
const t = createRunner('MACOS PLATFORM TEMPLATES');
const { ok } = t;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const pb = requires => srv.normalizePlaybook({ id: 'test', title: 'Test', promptTemplate: 'test', requires });
  const evaluation = (requires, dm) => srv.evalPlaybookAvailability(pb(requires), { desktopMcp: dm });
  const shared = { present: true, desktopAutomation: { supported: false, installed: false }, ocr: { supported: false, installed: false },
    browser: { mode: 'system', installed: true, supported: false, runtimeInstalled: false, ready: false } };
  ok(evaluation(['desktopMcp'], shared).available, 'shared ACC connection still enables shared document workflows');
  for (const key of ['desktopAutomation', 'ocr']) {
    const result = evaluation(['desktopMcp', key], shared);
    ok(!result.available && result.status === 'unavailable' && result.missingCaps.includes(key),
      key + ' explicitly unavailable on Mac even when shared ACC is connected');
  }
  ok(!evaluation(['browserControl'], shared).available, 'system URL handoff does not enable form filling on Mac');
  const windows = { ...shared, desktopAutomation: { supported: true, installed: true } };
  ok(evaluation(['browserControl'], windows).available && evaluation(['browserControl'], windows).status === 'unknown',
    'Windows installed desktop path may be attempted without claiming verified readiness');
  for (const key of ['desktopAutomation', 'ocr']) {
    const dm = { ...shared, [key]: { supported: true, installed: true, ready: null, authorization: 'unknown' } };
    ok(evaluation([key], dm).available && evaluation([key], dm).status === 'unknown',
      key + ' installation does not upgrade unknown authorization/readiness');
    ok(!evaluation([key], { ...dm, [key]: { ...dm[key], authorization: 'denied', ready: false } }).available,
      key + ' denied authorization blocks the workflow');
    ok(evaluation([key], { ...dm, [key]: { ...dm[key], ready: true } }).status === 'available',
      key + ' actual readiness can establish availability');
  }
  ok(!evaluation(['browserControl'], { ...windows, desktopAutomation: { ...windows.desktopAutomation, authorization: 'denied', ready: false } }).available,
    'denied desktop authorization blocks the Windows system-browser path');
  const prepared = { ...shared, browser: { mode: 'bundled', supported: true, installed: true, runtimeInstalled: true, ready: false } };
  const attempt = evaluation(['browserControl'], prepared);
  ok(attempt.available && attempt.status === 'unknown', 'prepared DOM runtime may be started but is not reported verified/attached');
  ok(!evaluation(['browserControl'], { ...prepared, browser: { ...prepared.browser, runtimeInstalled: false } }).available,
    'missing browser binary blocks form workflow');
  ok(!evaluation(['browserControl'], { ...prepared, browser: { ...prepared.browser, installed: false } }).available,
    'missing Playwright package blocks form workflow');
  ok(evaluation(['browserControl'], { ...prepared, browser: { ...prepared.browser, ready: true } }).status === 'available',
    'attached DOM runtime is reported available');
  ok(evaluation(['browserControl'], { ...prepared, browser: { ...prepared.browser, mode: 'cdp', runtimeInstalled: null } }).status === 'unknown',
    'unattached external CDP remains unknown instead of claiming reachability');
  ok(evaluation(['browserControl'], { ...prepared, browser: { ...prepared.browser, runtimeInstalled: null, probeFailed: true } }).status === 'unknown',
    'a failed SDK probe is unknown rather than proof of a missing browser binary');
  ok(!evaluation(['desktopAutomation'], undefined).available && evaluation(['desktopAutomation'], undefined).status === 'unknown',
    'missing capability snapshot is not upgraded to an implemented desktop backend');
  const macHint = srv.buildBrowserAutomationHint({ browserAutomation: { mode: 'system' } }, 'darwin');
  const winHint = srv.buildBrowserAutomationHint({ browserAutomation: { mode: 'system' } }, 'win32');
  ok(/only requests URL handoff/.test(macHint) && /not implemented/.test(macHint) && /accessibilityLimited/.test(winHint),
    'platform hints preserve Windows fallback and explain the Mac handoff boundary');
  if (process.platform === 'darwin') for (const locale of ['zh-CN', 'en-US']) {
    const config = srv.normalizeConfig({ locale, browserAutomation: { mode: 'system' } }).config;
    const text = srv.buildVolatileParts({}, [{ function: { name: 'office_open' } }], { desktopMcp: { present: true, toolCount: 43 } }, config);
    ok(/browser_backend_status/.test(text) && !/wait_for_window_idle|ocr_find_text/.test(text),
      locale + ' provider prompt uses shared Mac capability text without prescribing Windows UI automation');
  }
  if (process.platform !== 'darwin') { console.log('SKIP real Mac Workbench/ACC template probe'); t.done(); return; }
  const python = process.env.RUYI_ACC_PYTHON || path.join(acc, '.venv/bin/python');
  const cache = process.env.RUYI_BROWSER_CACHE_SOURCE || '';
  if (!fs.existsSync(python) || !cache || !fs.existsSync(cache)) {
    if (process.env.RUYI_TEMPLATES_REQUIRED === '1') t.fail('Prepare ACC/Playwright and RUYI_BROWSER_CACHE_SOURCE');
    else console.log('SKIP real template probe needs prepared ACC/browser cache');
    t.done(); return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-templates-'));
  try {
    for (const scenario of ['system', 'missing', 'prepared']) {
      const data = path.join(root, scenario); fs.mkdirSync(data);
      const browserCache = scenario === 'prepared' ? cache : path.join(data, 'absent-cache');
      const env = { ...fixtureChildEnv(), RUYI_HOME: data, WIN_CLAUDE_WORKBENCH_HOME: data,
        PYTHONPATH: path.join(acc, 'src'), WCW_DATA_DIR: path.join(data, 'acc'), ACC_TOOLSETS: 'office,browser,filesystem',
        PLAYWRIGHT_BROWSERS_PATH: browserCache, WCW_TEST_NO_NET_ANCHORS: '1', PYTHONUTF8: '1' };
      fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
        configSchema: 7, version: '3.0.1', providers: [], autoImportClaudeCodeMcp: false,
        includeWorkbenchMcp: false, enableMcpDropIn: false, externalMcpServers: [],
        desktopMcp: { enabled: true, autodetect: false, command: python, args: ['-m', 'ai_computer_control.server'], cwd: acc },
        browserAutomation: { mode: scenario === 'system' ? 'system' : 'bundled' },
      }));
      const port = await getFreePort();
      const child = cp.spawn(process.execPath, [path.join(repo, 'ruyi-workbench/app/server.js'), 'serve', '--port', String(port)],
        { env, cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', value => { errors = (errors + value).slice(-12000); });
      let token = '';
      const get = async route => {
        const response = await fetch('http://127.0.0.1:' + port + route, { headers: token ? { 'x-wcw-token': token } : {}, signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(route + ': HTTP ' + response.status);
        return response.json();
      };
      try {
        let healthy = false;
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          try { healthy = (await get('/health')).ok; } catch { /* await local startup */ }
          if (healthy) break;
          if (child.exitCode !== null) throw new Error('Workbench exited: ' + errors);
          await sleep(100);
        }
        if (!healthy) throw new Error('Workbench startup timed out: ' + errors);
        token = (await (await fetch('http://127.0.0.1:' + port + '/api/bootstrap', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: '{}' })).json()).token;
        const caps = await get('/api/capabilities');
        const list = await get('/api/playbooks');
        const books = list.playbooks;
        const find = id => books.find(book => book.id === id);
        ok(caps.desktopMcp.present && caps.desktopMcp.toolCount > 0, scenario + ': actual shared ACC registered through Workbench');
        ok(find('merge-excel').available && find('pdf-summarize').available, scenario + ': shared Office workflows remain available');
        ok(!find('desktop-open-app').available && !find('ocr-scan').available, scenario + ': actual listing disables unsupported desktop/OCR workflows');
        const form = find('web-form-fill');
        const browser = caps.desktopMcp.browser;
        if (scenario === 'prepared') ok(browser.installed && browser.runtimeInstalled && !browser.ready && form.available && form.status === 'unknown',
          'prepared: live SDK cache probe allows startup but preserves unverified status');
        else ok(!form.available && !browser.ready && (scenario === 'system' ? browser.mode === 'system' : browser.runtimeInstalled === false),
          scenario + ': actual backend facts prevent unsupported form workflow');
        ok(books.length === 16 && books.every(book => typeof book.status === 'string'), scenario + ': all 16 templates remain visible with capability reasons/status');
        if (scenario === 'system') {
          const update = await fetch('http://127.0.0.1:' + port + '/api/config', { method: 'POST',
            headers: { 'content-type': 'application/json', 'x-wcw-token': token },
            body: JSON.stringify({ browserAutomation: { mode: 'bundled' } }), signal: AbortSignal.timeout(30000) });
          if (!update.ok) throw new Error('browser target update failed: HTTP ' + update.status);
          const changed = await get('/api/capabilities');
          ok(changed.desktopMcp.browser.mode === 'bundled' && changed.desktopMcp.browser.runtimeInstalled === false,
            'changing the browser target invalidates cached capability facts without a forced probe');
        }
      } finally { await killOwnTree(child); }
    }
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  t.done();
})();

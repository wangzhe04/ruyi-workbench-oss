#!/usr/bin/env node
'use strict';

// Wave 80 Preview C1 hard gate: 75c-scale mission data in a real Edge/Chrome process.
// Budgets are local engineering gates, matching ec-d-performance.e2e.js rather than product claims.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SESSION_COUNT = 300;
const VISIBLE_CARD_COUNT = 200;
const FIRST_PAINT_CARD_COUNT = 40;
const STARTUP_BUDGET_MS = 1500;
const VIEW_SWITCH_P95_BUDGET_MS = 200;
const STARTUP_RUNS = 3;
const SWITCH_SAMPLES = 30;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

function browserPath() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file)) || '';
}

function request(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-json response */ }
        resolve({ status: response.statusCode, body, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForHttp(port, pathname, predicate, attempts = 140) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, pathname);
    if (result && predicate(result)) return result;
    await sleep(60);
  }
  return null;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] || 0;
}

function seedScaleDataset(home) {
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  for (let i = 0; i < SESSION_COUNT; i++) {
    const id = 'sess_preview_perf_' + String(i).padStart(3, '0');
    const createdAt = new Date(Date.UTC(2026, 6, 31, 8, 0, i)).toISOString();
    const complete = i % 2 === 0;
    const mission = {
      goal: `Scale task ${i}: verify the Preview performance contract with stable projection data`,
      createdAt,
      updatedAt: createdAt,
      autoMode: 'off',
      changeSeq: i + 1,
      milestones: [
        { id: 'm1', desc: 'seed projection', status: complete ? 'done' : 'pending', evidence: complete ? 'fixture' : '', check: null },
        { id: 'm2', desc: 'measure browser', status: complete ? 'done' : 'pending', evidence: complete ? 'fixture' : '', check: null },
      ],
      budget: { maxAutoTurns: 10, maxTokens: 100000 },
      spent: { autoTurns: i % 8, tokens: i * 17 },
      stall: { lastSignature: '', sameCount: 0 },
      result: complete
        ? { status: 'complete', finishedAt: createdAt }
        : { status: 'stopped', finishedAt: createdAt, reason: 'scale fixture' },
    };
    const head = {
      schemaVersion: 4,
      storageVersion: 2,
      id,
      missionId: id,
      kind: 'mission',
      title: `Scale task ${String(i).padStart(3, '0')}`,
      summary: '',
      cwd: path.join(ROOT, 'fixtures', 'workspace-' + (i % 12)),
      pinned: false,
      createdAt,
      updatedAt: createdAt,
      turnSeq: 2,
      messageCount: 0,
      providerHistoryCount: 0,
      mission,
    };
    fs.writeFileSync(path.join(sessions, id + '.json'), JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(sessions, id + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(sessions, id + '.provider.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(sessions, id + '.interventions.ndjson'), '', 'utf8');
  }
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      });
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
      throw new Error(detail);
    }
    return result.result && result.result.value;
  }
  close() { try { this.socket?.close(); } catch { /* ignore */ } }
}

async function waitForTarget(debugPort, appUrl) {
  for (let i = 0; i < 180; i++) {
    const result = await request(debugPort, '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

async function waitForEval(cdp, expression, attempts = 360) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload swaps execution context */ }
    await sleep(20);
  }
  return null;
}

async function waitForPreviewReady(cdp, previousTimeOrigin) {
  return waitForEval(cdp, `(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const main = document.getElementById('previewMain');
    const seals = document.querySelectorAll('#previewMissionDock .preview-seal');
    const ready = performance.timeOrigin !== ${Number(previousTimeOrigin) || 0}
      && document.readyState === 'complete'
      && document.documentElement.getAttribute('data-shell-mode') === 'preview'
      && main?.dataset.view === 'home'
      && seals.length >= ${FIRST_PAINT_CARD_COUNT}
      && !!window.state?.status;
    return ready ? {
      timeOrigin: performance.timeOrigin,
      interactiveMs: performance.now(),
      domInteractiveMs: navigation?.domInteractive || 0,
      responseEndMs: navigation?.responseEnd || 0,
      loadEventEndMs: navigation?.loadEventEnd || 0,
      sealCount: seals.length,
      resourceCount: performance.getEntriesByType('resource').length,
      apiTimings: performance.getEntriesByType('resource')
        .filter(entry => entry.name.includes('/api/'))
        .map(entry => ({ name: new URL(entry.name).pathname, start: entry.startTime, duration: entry.duration })),
    } : null;
  })()`);
}

const VIEW_SWITCH_MEASURE = `(async () => {
  const samples = [];
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const measure = async (id, expected) => {
    const button = document.getElementById(id);
    const main = document.getElementById('previewMain');
    const start = performance.now();
    button.click();
    await frame();
    main.getBoundingClientRect();
    if (main.dataset.view !== expected) throw new Error('Preview view did not switch to ' + expected);
    return performance.now() - start;
  };
  for (let i = 0; i < 6; i++) {
    await measure('previewArchiveBtn', 'archive');
    await measure('previewHomeBtn', 'home');
  }
  for (let i = 0; i < ${SWITCH_SAMPLES}; i++) {
    samples.push(await measure(i % 2 ? 'previewHomeBtn' : 'previewArchiveBtn', i % 2 ? 'home' : 'archive'));
  }
  return samples;
})()`;

(async () => {
  const appPort = await getFreePort();
  const debugPort = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-preview-perf-'));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'profile');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 9,
    version: '2.4.0',
    permissionMode: 'default',
    theme: 'dark',
    uiMode: 'simple',
    defaultWorkspace: ROOT,
    includeWorkbenchMcp: false,
  }), 'utf8');
  seedScaleDataset(home);

  let server = null;
  let browser = null;
  let cdp = null;
  try {
    server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
      cwd: WB,
      env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
      windowsHide: true,
      stdio: 'ignore',
    });
    const healthy = await waitForHttp(appPort, '/health', result => result.status === 200);
    ok(Boolean(healthy), 'A1 75c-scale workbench started');
    const executable = browserPath();
    ok(Boolean(executable), 'A2 Edge/Chrome found');
    if (!healthy || !executable) throw new Error('performance prerequisites unavailable');

    const appUrl = `http://127.0.0.1:${appPort}/`;
    const browserArgs = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1',
      '--window-size=1440,1000', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile,
    ];
    if (/msedge\.exe$/i.test(executable)) browserArgs.push('--edge-skip-compat-layer-relaunch');
    browserArgs.push(appUrl);
    browser = cp.spawn(executable, browserArgs, { windowsHide: true, stdio: 'ignore' });
    const target = await waitForTarget(debugPort, appUrl);
    ok(Boolean(target), 'A3 CDP page target available');
    if (!target) throw new Error('CDP target unavailable');
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const classicReady = await waitForEval(cdp, `(() => window.state?.status
      && window.state?.sessions?.length === ${SESSION_COUNT}
      && !!window.state?.currentSession?.id
      && document.getElementById('messages')?.getAttribute('aria-busy') !== 'true'
      && typeof document.getElementById('cfgShellMode')?.onchange === 'function'
      && document.documentElement.getAttribute('data-shell-mode') === 'classic')()`);
    ok(Boolean(classicReady), 'B1 classic default fully hydrates before the settings opt-in');
    ok(fs.existsSync(path.join(home, 'sessions', '.pretender', 'projection-index.json')),
      'B2 background Mission projection warm completes during classic hydration');
    await cdp.evaluate("localStorage.setItem('wcw.shellMode', 'preview')");

    const startup = [];
    let previousTimeOrigin = await cdp.evaluate('performance.timeOrigin');
    for (let i = 0; i < STARTUP_RUNS; i++) {
      await cdp.send('Page.reload', { ignoreCache: true });
      const metrics = await waitForPreviewReady(cdp, previousTimeOrigin);
      if (metrics) {
        startup.push(metrics);
        previousTimeOrigin = metrics.timeOrigin;
        console.log(`SAMPLE ${i + 1} ` + JSON.stringify(metrics));
      }
    }
    ok(startup.length === STARTUP_RUNS, `B3 captured ${STARTUP_RUNS}/${STARTUP_RUNS} Preview cold-navigation samples`);
    const startupMs = startup.map(sample => sample.interactiveMs);
    const startupMax = startupMs.length ? Math.max(...startupMs) : Infinity;
    ok(startup.length === STARTUP_RUNS && startupMax < STARTUP_BUDGET_MS,
      `B4 Preview first interactive max < ${STARTUP_BUDGET_MS}ms (samples ${startupMs.map(ms => ms.toFixed(1)).join(', ')}ms)`);
    const completeDock = await waitForEval(cdp, `(() => document.querySelectorAll('#previewMissionDock .preview-seal').length === ${VISIBLE_CARD_COUNT})()`);
    ok(Boolean(completeDock),
      `B5 first ${FIRST_PAINT_CARD_COUNT} cards paint synchronously and all ${VISIBLE_CARD_COUNT} complete incrementally`);

    const dockCache = await cdp.evaluate(`(async () => {
      const first = document.querySelector('#previewMissionDock .preview-seal');
      document.getElementById('previewArchiveBtn').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.getElementById('previewHomeBtn').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return first === document.querySelector('#previewMissionDock .preview-seal');
    })()`);
    ok(dockCache === true, 'C1 unchanged 200-card dock keeps its DOM instead of rebuilding on view switches');

    const switchSamples = await cdp.evaluate(VIEW_SWITCH_MEASURE);
    const switchP95 = percentile(switchSamples || [], 0.95);
    ok(Array.isArray(switchSamples) && switchSamples.length === SWITCH_SAMPLES,
      `C2 captured ${SWITCH_SAMPLES} Preview view-switch samples`);
    ok(switchP95 < VIEW_SWITCH_P95_BUDGET_MS,
      `C3 Preview view-switch P95 < ${VIEW_SWITCH_P95_BUDGET_MS}ms (got ${switchP95.toFixed(1)}ms)`);

    const responsive = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 500 });
      const result = await cdp.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => {
        const dock = document.querySelector('.preview-dock');
        const action = document.getElementById('previewClassicBtn');
        const main = document.getElementById('previewMain');
        resolve({
          width: innerWidth,
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
          dockContainsAction: action.getBoundingClientRect().right <= dock.getBoundingClientRect().right + 1,
          mainVisible: main.getBoundingClientRect().width > 250 && main.getBoundingClientRect().height > 400,
        });
      })))`);
      responsive.push(result);
    }
    ok(responsive.every(item => item.noPageOverflow && item.dockContainsAction && item.mainVisible),
      'D1 Preview walkthrough stays usable without page overflow at 1440, 768, and 390 CSS px');

    const last = startup[startup.length - 1] || {};
    console.log('METRICS ' + JSON.stringify({
      datasetMissions: SESSION_COUNT,
      visibleCards: VISIBLE_CARD_COUNT,
      startupMs: startupMs.map(ms => Number(ms.toFixed(1))),
      startupMaxMs: Number(startupMax.toFixed(1)),
      viewSwitchP95Ms: Number(switchP95.toFixed(1)),
      resourceCount: last.resourceCount,
      responsiveWidths: responsive.map(item => item.width),
      incrementalRenderGate: 'pretender-task-sheet.e2e.js C5',
    }));
  } catch (error) {
    console.log('ERROR ' + (error && error.stack || error));
    fail += 1;
  } finally {
    if (cdp) cdp.close();
    killTree(browser);
    killTree(server);
    await sleep(300);
    stopRuyiTestBrowsers(profile);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
    console.log(`\nPRETENDER PREVIEW PERFORMANCE E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
    process.exitCode = fail ? 1 : 0;
  }
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

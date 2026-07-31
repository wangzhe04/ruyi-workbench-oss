#!/usr/bin/env node
'use strict';

// 第76波真实浏览器 E2E：经典默认、设置开启、localStorage 跨刷新、三种瓷章表现由真实
// /api/missions + Intervention 投影驱动、主台单视图切换、Preview 内一键回经典。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
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

async function waitForHttp(port, pathname, predicate, attempts = 100) {
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

function seedMission(home, suffix, title, mode, updatedOffset) {
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const id = 'sess_preview_' + suffix;
  const createdAt = new Date(Date.UTC(2026, 6, 31, 10, 0, updatedOffset)).toISOString();
  const done = mode === 'done';
  const head = {
    schemaVersion: 4,
    storageVersion: 2,
    id,
    missionId: id,
    kind: 'mission',
    title,
    summary: '',
    cwd: ROOT,
    pinned: false,
    createdAt,
    updatedAt: createdAt,
    turnSeq: done ? 2 : 1,
    messageCount: 0,
    providerHistoryCount: 0,
    mission: {
      goal: title + ' goal',
      createdAt,
      updatedAt: createdAt,
      autoMode: mode === 'running' ? 'until-done' : 'off',
      changeSeq: updatedOffset + 1,
      milestones: [
        { id: 'm1', desc: 'first', status: done ? 'done' : 'pending', evidence: done ? 'verified' : '', check: null },
        { id: 'm2', desc: 'second', status: done ? 'done' : 'pending', evidence: done ? 'verified' : '', check: null },
      ],
      budget: { maxAutoTurns: 10, maxTokens: 100000 },
      spent: { autoTurns: done ? 2 : 1, tokens: done ? 1200 : 400 },
      stall: { lastSignature: '', sameCount: 0 },
      result: done ? { status: 'complete', finishedAt: createdAt } : null,
    },
  };
  fs.writeFileSync(path.join(sessions, id + '.json'), JSON.stringify(head, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessions, id + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessions, id + '.provider.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessions, id + '.interventions.ndjson'), '', 'utf8');
  return { id, createdAt };
}

function seedProjectionDataset(home) {
  const running = seedMission(home, 'running', '运行任务', 'running', 1);
  const needs = seedMission(home, 'needs', '待决任务', 'needs', 2);
  const done = seedMission(home, 'done', '完成任务', 'done', 3);
  const intervention = {
    id: 'iv_preview_needs',
    missionId: needs.id,
    sessionId: needs.id,
    type: 'question',
    status: 'pending',
    requestedAt: needs.createdAt,
    interventionVersion: 0,
    question: 'choose',
    options: [{ id: 'yes', label: 'Yes' }],
    allowMultiple: false,
    allowOther: false,
    expiresAt: '',
  };
  fs.writeFileSync(path.join(home, 'sessions', needs.id + '.interventions.ndjson'), JSON.stringify(intervention) + '\n', 'utf8');
  return { running: running.id, needs: needs.id, done: done.id };
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
  close() { try { this.socket && this.socket.close(); } catch { /* ignore */ } }
}

async function waitForTarget(debugPort, appUrl) {
  for (let i = 0; i < 160; i++) {
    const result = await request(debugPort, '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

async function waitForEval(cdp, expression, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload swaps execution context */ }
    await sleep(30);
  }
  return null;
}

const appPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-pretender-shell-'));
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
  ok(Boolean(healthy), 'A1 workbench started');
  const ids = seedProjectionDataset(home);
  const executable = browserPath();
  ok(Boolean(executable), 'A2 Edge/Chrome found');
  if (!healthy || !executable) throw new Error('browser prerequisites unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A3 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const classicReady = await waitForEval(cdp, `(() => {
    const html = document.documentElement;
    const classic = document.querySelector('.app-shell');
    const preview = document.getElementById('previewShell');
    const select = document.getElementById('cfgShellMode');
    const chip = document.getElementById('modelChip');
    const settings = document.getElementById('openSettingsBtn');
    if (!classic || !preview || !select || !chip || !chip.title
      || !window.state || !window.state.status
      || typeof settings.onclick !== 'function' || typeof select.onchange !== 'function') return null;
    return {
      mode: html.getAttribute('data-shell-mode'),
      stored: localStorage.getItem('wcw.shellMode'),
      classicDisplay: getComputedStyle(classic).display,
      previewDisplay: getComputedStyle(preview).display,
      select: select.value,
      promptEnabled: !document.getElementById('promptInput').disabled,
    };
  })()`);
  ok(classicReady && classicReady.mode === 'classic' && classicReady.stored === null && classicReady.select === 'classic',
    'B1 fresh profile defaults to classic without writing a preference');
  ok(classicReady && classicReady.classicDisplay !== 'none' && classicReady.previewDisplay === 'none' && classicReady.promptEnabled,
    'B2 classic shell remains interactive and Preview stays hidden');

  const openedFromSettings = await cdp.evaluate(`(() => {
    document.getElementById('openSettingsBtn').click();
    const modal = document.getElementById('settingsModal');
    const select = document.getElementById('cfgShellMode');
    const visibleBefore = !modal.classList.contains('hidden');
    select.value = 'preview';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { visibleBefore, closedAfter: modal.classList.contains('hidden'), mode: document.documentElement.getAttribute('data-shell-mode'), stored: localStorage.getItem('wcw.shellMode') };
  })()`);
  ok(openedFromSettings && openedFromSettings.visibleBefore && openedFromSettings.closedAfter
    && openedFromSettings.mode === 'preview' && openedFromSettings.stored === 'preview',
    'C1 settings switch enables/persists Preview and closes the obsolete settings surface');

  const projection = await waitForEval(cdp, `(() => {
    const seals = [...document.querySelectorAll('#previewMissionDock .preview-seal')];
    if (seals.length !== 3 || document.getElementById('previewMain').dataset.view !== 'task-sheet') return null;
    return {
      modes: Object.fromEntries(seals.map(node => [node.dataset.missionId, { state: node.dataset.missionState, tone: node.dataset.dockTone }])),
      needs: document.getElementById('previewNeedsValue').textContent,
      mainDisplay: getComputedStyle(document.getElementById('previewShell')).display,
      classicDisplay: getComputedStyle(document.querySelector('.app-shell')).display,
      status: document.getElementById('previewShellStatus').textContent,
    };
  })()`);
  ok(projection && projection.modes[ids.running]?.state === 'running' && projection.modes[ids.running]?.tone === 'active',
    'C2 real running projection -> running fact + active porcelain seal');
  ok(projection && projection.modes[ids.needs]?.state === 'needs_you' && projection.modes[ids.needs]?.tone === 'attention',
    'C3 real pending Intervention -> needs_you fact + attention porcelain seal');
  ok(projection && projection.modes[ids.done]?.state === 'done' && projection.modes[ids.done]?.tone === 'quiet',
    'C4 real completed Mission -> done fact + quiet porcelain seal');
  ok(projection && projection.needs === '1' && projection.mainDisplay === 'grid' && projection.classicDisplay === 'none',
    'C5 four-fact bar reports one pending item and shells are mutually exclusive');
  if (process.env.RUYI_PREVIEW_SCREENSHOT_DIR) {
    const shotDir = path.resolve(process.env.RUYI_PREVIEW_SCREENSHOT_DIR);
    fs.mkdirSync(shotDir, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`new Promise(resolve => {
        document.documentElement.setAttribute('data-theme', '${theme}');
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })`);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(shotDir, `preview-shell-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
    await cdp.evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
  }

  await cdp.evaluate(`(() => {
    const seal = document.querySelector('.preview-seal[data-mission-id="${ids.needs}"]');
    seal.click();
    return true;
  })()`);
  const selected = await waitForEval(cdp, `(() => {
    const selectedSeal = document.querySelector('.preview-seal[data-mission-id="${ids.needs}"]');
    if (document.getElementById('previewMain').dataset.view !== 'task-sheet') return null;
    return {
      missionId: document.getElementById('previewMain').dataset.missionId,
      view: document.getElementById('previewMain').dataset.view,
      state: document.querySelector('#previewMain .preview-state-pill').dataset.missionState,
      pressed: selectedSeal.getAttribute('aria-pressed'),
    };
  })()`);
  ok(selected && selected.missionId === ids.needs && selected.view === 'task-sheet' && selected.state === 'needs_you' && selected.pressed === 'true',
    'D1 dock click switches the single main-view container with accessible selection state');

  await cdp.send('Page.reload', { ignoreCache: true });
  const restored = await waitForEval(cdp, `(() => {
    const seals = document.querySelectorAll('#previewMissionDock .preview-seal');
    if (seals.length !== 3) return null;
    return {
      mode: document.documentElement.getAttribute('data-shell-mode'),
      stored: localStorage.getItem('wcw.shellMode'),
      select: document.getElementById('cfgShellMode').value,
      classicDisplay: getComputedStyle(document.querySelector('.app-shell')).display,
      previewDisplay: getComputedStyle(document.getElementById('previewShell')).display,
    };
  })()`);
  ok(restored && restored.mode === 'preview' && restored.stored === 'preview' && restored.select === 'preview'
    && restored.classicDisplay === 'none' && restored.previewDisplay === 'grid',
    'D2 Preview preference restores before/through reload and control stays synchronized');

  const fallback = await cdp.evaluate(`(() => {
    document.getElementById('previewClassicBtn').click();
    return {
      mode: document.documentElement.getAttribute('data-shell-mode'),
      stored: localStorage.getItem('wcw.shellMode'),
      select: document.getElementById('cfgShellMode').value,
      classicDisplay: getComputedStyle(document.querySelector('.app-shell')).display,
      previewDisplay: getComputedStyle(document.getElementById('previewShell')).display,
      classicTitle: document.getElementById('sessionTitle').textContent,
    };
  })()`);
  ok(fallback && fallback.mode === 'classic' && fallback.stored === 'classic' && fallback.select === 'classic'
    && fallback.classicDisplay !== 'none' && fallback.previewDisplay === 'none' && fallback.classicTitle,
    'D3 Preview dock returns to the intact classic layout and persists the fallback');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nPRETENDER SHELL E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

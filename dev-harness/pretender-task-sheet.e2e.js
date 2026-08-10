#!/usr/bin/env node
'use strict';

// 第77波真实浏览器 E2E：四旅程投影、经典 renderer 原样复用、长历史重量窗口、cursor/usage、
// 多 Agent 摘要、Quick Ask 逃生，以及真实 provider SSE 在 Preview 容器的焦点/滚动/主线程稳定性。
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
  ].find(file => fs.existsSync(file)) || '';
}

function request(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null; try { json = JSON.parse(body); } catch { /* non-json */ }
        resolve({ status: response.statusCode, body, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForHttp(port, pathname, predicate, attempts = 120) {
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

function writeSession(home, head, messages = []) {
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, head.id + '.json'), JSON.stringify(head, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessions, head.id + '.messages.ndjson'), messages.map(row => JSON.stringify(row)).join('\n') + (messages.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(sessions, head.id + '.provider.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessions, head.id + '.interventions.ndjson'), '', 'utf8');
}

function seedJourneys(home) {
  const sessionId = 'sess_wave77_sheet';
  const quickId = 'sess_wave77_quick';
  const heavyId = 'sess_wave77_heavy';
  const createdAt = '2026-07-31T08:00:00.000Z';
  const updatedAt = '2026-07-31T12:00:00.000Z';
  const messages = [];
  for (let turn = 1; turn <= 85; turn++) {
    const stamp = new Date(Date.parse(createdAt) + turn * 1000).toISOString();
    messages.push({ role: 'user', content: `历史问题 ${turn}`, createdAt: stamp, turnSeq: turn });
    const assistant = {
      role: 'assistant', engine: 'openai', providerId: 'fake', model: 'fake-model',
      content: turn % 10 === 0 ? `## 回合 ${turn}\n\n\`\`\`js\nconst turn = ${turn};\n\`\`\`` : `历史答复 ${turn}：已核对现场记录。`,
      createdAt: stamp, turnSeq: turn,
    };
    if (turn === 85) {
      assistant.toolCalls = [{ id: 'tool_wave77', name: 'file_read', input: { path: 'src/main.js' }, result: { ok: true, content: 'sample' }, isError: false }];
      assistant.turnSummary = {
        turnSeq: turn,
        filesChanged: [{ path: 'src/main.js', op: 'modify', revertible: true, entrySeq: 1 }],
        artifacts: [{ path: 'reports/result.md', kind: 'document' }],
        commands: [{ name: 'npm test' }],
        irreversible: [{ kind: 'exec', name: 'publish-preview', detail: 'fixture only', ok: true }],
      };
    }
    messages.push(assistant);
  }
  writeSession(home, {
    schemaVersion: 4, storageVersion: 2, id: sessionId, missionId: sessionId, kind: 'mission',
    title: '第77波任务单', summary: '长任务原始镜头', cwd: ROOT, pinned: false,
    createdAt, updatedAt, turnSeq: 85, messageCount: messages.length, providerHistoryCount: 0,
    mission: {
      goal: '验证原始消息、结果、台账和班组游标', createdAt, updatedAt, autoMode: 'off', changeSeq: 91,
      milestones: [
        { id: 'm1', desc: '读取历史', status: 'done', evidence: '170 rows', check: null },
        { id: 'm2', desc: '等待确认', status: 'pending', evidence: '', check: null },
      ],
      budget: { maxAutoTurns: 100, maxTokens: 500000 }, spent: { autoTurns: 85, tokens: 15000 },
      stall: { lastSignature: '', sameCount: 0 },
      result: { status: 'stopped', how: 'fixture', finishedAt: updatedAt, unfinished: [{ id: 'm2', desc: '等待确认', status: 'pending' }] },
    },
  }, messages);
  writeSession(home, {
    schemaVersion: 4, storageVersion: 2, id: quickId, missionId: quickId, kind: 'quick_ask',
    title: '速问逃生舱', summary: '', cwd: ROOT, pinned: false, createdAt, updatedAt: '2026-07-31T09:00:00.000Z',
    turnSeq: 0, messageCount: 0, providerHistoryCount: 0,
  });
  const heavyMessages = Array.from({ length: 40 }, (_, index) => ({
    role: 'user', content: `超长历史 ${index} ` + 'history-payload '.repeat(1600),
    createdAt: new Date(Date.parse(createdAt) + index * 1000).toISOString(), turnSeq: index + 1,
  }));
  writeSession(home, {
    schemaVersion: 4, storageVersion: 2, id: heavyId, missionId: heavyId, kind: 'quick_ask',
    title: '经典长历史性能夹具', summary: '', cwd: ROOT, pinned: false, createdAt,
    updatedAt: '2026-07-31T14:00:00.000Z', turnSeq: 40, messageCount: heavyMessages.length, providerHistoryCount: 0,
  }, heavyMessages);

  const intervention = {
    id: 'iv_wave77_question', missionId: sessionId, sessionId, type: 'question', status: 'pending',
    requestedAt: updatedAt, interventionVersion: 0, question: 'continue?', options: [{ id: 'yes', label: 'Yes' }],
    allowMultiple: false, allowOther: false, expiresAt: '',
  };
  fs.writeFileSync(path.join(home, 'sessions', sessionId + '.interventions.ndjson'), JSON.stringify(intervention) + '\n', 'utf8');

  const runDir = path.join(home, 'agent-runs', sessionId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run_abcd77.json'), JSON.stringify({
    schemaVersion: 4, id: 'run_abcd77', sessionId, status: 'succeeded', createdAt, updatedAt,
    completedAt: updatedAt, concurrency: 2, taskPool: [], messages: [], poolPolicy: 'manual', poolAutoCap: 3,
    eventSeq: 77, totalTokens: 4200, costUsd: 0.42, nodes: [{ id: 'n1', status: 'succeeded' }, { id: 'n2', status: 'succeeded' }],
  }), 'utf8');

  const usageDir = path.join(home, 'usage');
  fs.mkdirSync(usageDir, { recursive: true });
  fs.writeFileSync(path.join(usageDir, '2026-07.jsonl'), JSON.stringify({
    ts: updatedAt, sessionId, kind: 'main', inTok: 10000, outTok: 5000, cost: 1.25, currency: 'USD', estimated: false,
  }) + '\n', 'utf8');
  return { sessionId, quickId, heavyId, messageCount: messages.length };
}

async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    for await (const _ of req) { /* drain body */ }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    for (let index = 0; index < 240; index++) {
      const content = `SSE-${String(index).padStart(3, '0')} ` + '长输出'.repeat(80) + '\n';
      sse({ choices: [{ index: 0, delta: { role: index === 0 ? 'assistant' : undefined, content }, finish_reason: null }] });
      await sleep(8);
    }
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 18000, total_tokens: 19200 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message; try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
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
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result && result.result.value;
  }
  close() { try { this.socket?.close(); } catch { /* ignore */ } }
}

async function waitForTarget(port, appUrl) {
  for (let i = 0; i < 180; i++) {
    const result = await request(port, '/json/list');
    const target = result?.json?.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

async function waitForEval(cdp, expression, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; } catch { /* context swap */ }
    await sleep(30);
  }
  return null;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wave77-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
let ids = null;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', permissionMode: 'bypass', theme: 'dark', uiMode: 'simple',
  defaultWorkspace: ROOT, includeWorkbenchMcp: false, activeProvider: 'fake', engineMode: 'interactive',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');

let provider = null, server = null, browser = null, cdp = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, '/health', result => result.status === 200)), 'A1 workbench + fake provider started');
  // Seed after boot: boot intentionally terminalizes stale pending Interventions and may reconcile old runs.
  // The fixture represents live data created during this process lifetime, matching the user journey.
  ids = seedJourneys(home);
  const executable = browserPath();
  ok(Boolean(executable), 'A2 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1600,1100',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A3 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  const classicHeavy = await waitForEval(cdp, `(() => {
    if (window.state?.currentSession?.id !== '${ids.heavyId}') return null;
    const box = document.getElementById('messages');
    const rows = box?.querySelectorAll('[data-message-key]').length || 0;
    if (!rows) return null;
    return { rows, earlier: !!box.querySelector('.load-earlier-wrap'), total: window.state.currentSession.messages.length };
  })()`);
  ok(classicHeavy && classicHeavy.total === 40 && classicHeavy.rows === 12 && classicHeavy.earlier,
    'A4 classic chat content-weight window engages for 40 huge messages below the old 150-row threshold');

  const boot = await waitForEval(cdp, `(() => {
    const select = document.getElementById('cfgShellMode');
    if (!window.state?.status || typeof select?.onchange !== 'function') return null;
    select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  ok(Boolean(boot), 'B1 Preview enabled through the persisted shell control');

  const openedSheet = await waitForEval(cdp, `(() => {
    const main = document.getElementById('previewMain');
    const seal = document.querySelector('.preview-seal[data-mission-id="${ids.sessionId}"]');
    if (main?.dataset.view !== 'home' || !seal) return null;
    seal.click();
    return true;
  })()`);
  ok(Boolean(openedSheet), 'B1 dispatch home opens the requested authoritative Mission through its porcelain seal');

  const rawLensOpened = await waitForEval(cdp, `(() => {
    const tab = document.querySelector('.preview-lens-tab.lens-raw');
    if (!tab || tab.disabled) return null;
    if (tab.getAttribute('aria-selected') !== 'true') tab.click();
    return tab.getAttribute('aria-selected') === 'true';
  })()`);
  ok(Boolean(rawLensOpened), 'B2 expert raw lens is selected explicitly for renderer and long-history checks');

  const sheet = await waitForEval(cdp, `(() => {
    const main = document.getElementById('previewMain');
    const raw = document.getElementById('previewRawMessages');
    if (main?.dataset.view !== 'task-sheet' || main.dataset.missionId !== '${ids.sessionId}' || !raw) return null;
    const panels = [...document.querySelectorAll('.preview-intake-panel')];
    return {
      renderer: raw.dataset.renderer,
      rows: raw.querySelectorAll('[data-message-key]').length,
      hasEarlier: !!raw.querySelector('.preview-load-earlier'),
      markdown: !!raw.querySelector('.bubble.md'),
      tool: !!raw.querySelector('.tool-card'),
      actions: raw.querySelectorAll('.msg-actions').length,
      turnActions: raw.querySelectorAll('.turn-summary,.artifact-chips').length,
      cursor: document.querySelector('.preview-cursor')?.textContent || '',
      metrics: [...document.querySelectorAll('.preview-task-metric-value')].map(node => node.textContent),
      panels: panels.map(node => ({ kind: node.dataset.kind, value: node.querySelector('strong')?.textContent || '', copy: node.textContent })),
      dockIds: [...document.querySelectorAll('.preview-seal')].map(node => node.dataset.sessionId),
      duplicateIds: [...document.querySelectorAll('[id]')].map(node => node.id).filter((id, index, all) => all.indexOf(id) !== index),
      sections: [...document.querySelectorAll('.preview-task-sheet > [data-section]')].map(node => node.dataset.section),
      processOpen: document.querySelector('.preview-process-details')?.open === true,
      lensCount: document.querySelectorAll('.preview-lens-tab').length,
      progressItems: document.querySelectorAll('.preview-progress-item').length,
    };
  })()`);
  ok(sheet && sheet.renderer === 'chat-static-renderer' && sheet.markdown && sheet.tool && sheet.actions === 0 && sheet.turnActions === 0,
    'B3 raw worksite reuses classic Markdown/tool cards in readonly mode');
  ok(sheet && sheet.rows <= 120 && sheet.rows >= 12 && sheet.hasEarlier, 'B4 170-message journey opens inside the weighted tail window with reachable history');
  ok(sheet && sheet.cursor.includes('85') && sheet.metrics.some(value => value.includes('USD 1.25')) && sheet.metrics.includes('1'),
    'B5 long-task cursor, usage cost/token facts, and one team run reach the header');
  ok(sheet && sheet.panels.length === 3 && sheet.panels.some(panel => panel.kind === 'needs' && panel.value === '1')
    && sheet.panels.some(panel => panel.kind === 'results' && /停工|Stop/.test(panel.value))
    && sheet.panels.some(panel => panel.kind === 'ledger' && panel.copy.includes('77')),
    'B6 single-task result, pending item, changes/irreversible, and multi-Agent event cursor reach the intake desk');
  if (!(sheet && sheet.panels.length === 3 && sheet.panels.some(panel => panel.kind === 'needs' && panel.value === '1')
    && sheet.panels.some(panel => panel.kind === 'results' && /停工|Stop/.test(panel.value))
    && sheet.panels.some(panel => panel.kind === 'ledger' && panel.copy.includes('77')))) console.log('INFO B5 panels=' + JSON.stringify(sheet && sheet.panels));
  ok(sheet && sheet.dockIds.includes(ids.sessionId) && !sheet.dockIds.includes(ids.quickId) && !sheet.dockIds.includes(ids.heavyId), 'B7 Quick Ask stays outside the task dock');
  ok(sheet && sheet.duplicateIds.length === 0, 'B8 scoped raw renderer creates no duplicate DOM ids across the two shells');
  ok(sheet && JSON.stringify(sheet.sections) === JSON.stringify(['status', 'outcome']) && sheet.processOpen === false,
    'B9 Wave 100 task sheet exposes status/outcome/process hierarchy and keeps stopped process collapsed');
  ok(sheet && sheet.lensCount === 2 && sheet.progressItems === 2,
    'B10 merged worksite/raw lenses and explainable acceptance rows replace the old three-lens counter');

  if (process.env.RUYI_PREVIEW_SCREENSHOT_DIR) {
    const shotDir = path.resolve(process.env.RUYI_PREVIEW_SCREENSHOT_DIR);
    fs.mkdirSync(shotDir, { recursive: true });
    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`new Promise(resolve => { document.documentElement.setAttribute('data-theme', '${theme}'); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 240))); })`);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(shotDir, `preview-task-sheet-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 720, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`new Promise(resolve => { document.documentElement.setAttribute('data-theme', '${theme}'); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 240))); })`);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(shotDir, `preview-task-sheet-${theme}-960.png`), Buffer.from(capture.data, 'base64'));
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`new Promise(resolve => { document.documentElement.setAttribute('data-theme', '${theme}'); requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 240))); })`);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      fs.writeFileSync(path.join(shotDir, `preview-task-sheet-${theme}-390.png`), Buffer.from(capture.data, 'base64'));
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
    if (Number(process.env.RUYI_PREVIEW_VISUAL_HOLD_MS) > 0) {
      console.log(`VISUAL_URL ${appUrl}`);
      await sleep(Math.min(300000, Number(process.env.RUYI_PREVIEW_VISUAL_HOLD_MS)));
    }
  }

  const started = await cdp.evaluate(`(async () => {
    document.querySelector('.preview-task-actions .ghost').click();
    for (let i = 0; i < 400 && (document.documentElement.getAttribute('data-shell-mode') !== 'classic'
      || window.state?.currentSession?.id !== '${ids.sessionId}'); i++) await new Promise(r => setTimeout(r, 10));
    const input = document.getElementById('promptInput');
    if (!input || window.state?.currentSession?.id !== '${ids.sessionId}') return false;
    window.__wave77Gaps = []; window.__wave77Last = performance.now();
    window.__wave77Timer = setInterval(() => { const now = performance.now(); window.__wave77Gaps.push(now - window.__wave77Last); window.__wave77Last = now; }, 16);
    input.value = 'stream a long answer'; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sendBtn').click();
    for (let i = 0; i < 200 && !window.state.streaming; i++) await new Promise(r => setTimeout(r, 10));
    const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 400; i++) {
      const rawTab = document.querySelector('.preview-lens-tab.lens-raw');
      if (rawTab && !rawTab.disabled) {
        const process = document.querySelector('.preview-process-details');
        if (process) process.open = true;
        if (rawTab.getAttribute('aria-selected') !== 'true') rawTab.click();
        return window.state.streaming;
      }
      await new Promise(r => setTimeout(r, 10));
    }
    return false;
  })()`);
  ok(started === true, 'C1 real classic composer starts one provider stream, then switches to Preview without a second stream');

  const liveReady = await waitForEval(cdp, `(() => {
    const raw = document.getElementById('previewRawMessages');
    const live = raw?.querySelector('[data-preview-live="true"] .bubble');
    if (!raw || !live || live.textContent.length < 3000) return null;
    raw.scrollTop = 0; raw.focus();
    window.__wave77LiveChars = live.textContent.length;
    return { chars: live.textContent.length, top: raw.scrollTop, focused: document.activeElement === raw };
  })()`);
  ok(liveReady && liveReady.focused && liveReady.top === 0, 'C2 active stream replays into the raw lens and establishes a user-owned top scroll/focus anchor');

  const liveGrowth = await waitForEval(cdp, `(() => {
    const raw = document.getElementById('previewRawMessages');
    const live = raw?.querySelector('[data-preview-live="true"] .bubble');
    if (!live || live.textContent.length < (window.__wave77LiveChars || 0) + 5000) return null;
    return { top: raw.scrollTop, focused: document.activeElement === raw, chars: live.textContent.length };
  })()`);
  ok(liveGrowth && liveGrowth.focused && liveGrowth.top < 8, 'C3 SSE growth preserves focus and does not drag an upward reader back to the bottom');
  if (!(liveGrowth && liveGrowth.focused && liveGrowth.top < 8)) console.log('INFO C3 growth=' + JSON.stringify(liveGrowth));

  const settled = await waitForEval(cdp, `(() => {
    const raw = document.getElementById('previewRawMessages');
    if (window.state.streaming || raw?.querySelector('[data-preview-live="true"]')) return null;
    const rows = [...(raw?.querySelectorAll('[data-message-key]') || [])].filter(row => !row.dataset.previewLive);
    const last = rows[rows.length - 1]?.querySelector('.bubble');
    if (!last || !last.textContent.includes('SSE-239')) return null;
    clearInterval(window.__wave77Timer);
    return {
      focused: document.activeElement === raw,
      top: raw.scrollTop,
      plain: last.classList.contains('plain'),
      maxGap: Math.max(0, ...(window.__wave77Gaps || [])),
      rows: raw.querySelectorAll('[data-message-key]').length,
    };
  })()`, 700);
  if (!settled) {
    const diagnostic = await cdp.evaluate(`(() => {
      const raw = document.getElementById('previewRawMessages');
      const rows = [...(raw?.querySelectorAll('[data-message-key]') || [])];
      return { streaming: window.state?.streaming, live: !!raw?.querySelector('[data-preview-live="true"]'), rows: rows.length,
        last: rows[rows.length - 1]?.textContent?.slice(-80) || '', focused: document.activeElement?.id || document.activeElement?.className || '', top: raw?.scrollTop };
    })()`);
    console.log('INFO C settled=' + JSON.stringify(diagnostic));
  }
  ok(settled && settled.focused && settled.top < 60, 'C4 terminal Session reconciliation keeps the raw-lens focus and reading anchor');
  if (!(settled && settled.focused && settled.top < 60)) console.log('INFO C4 settled=' + JSON.stringify(settled));
  ok(settled && settled.plain && settled.maxGap < 750, `C5 >48k answer uses bounded plain settle and event-loop max gap stays <750ms (actual ${settled?.maxGap || 'n/a'}ms)`);
  ok(settled && settled.rows <= 120, 'C6 long output does not disable the history window after terminal refresh');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser); killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser lock */ }
  console.log(`\nPRETENDER TASK SHEET E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

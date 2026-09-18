'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
/*
 * EC-D performance gate: real Edge/Chrome, zero npm dependencies.
 *
 * The numbers are local engineering budgets, not hardware-independent product claims:
 *   - baseline-session first interactive: every cold navigation < 1500ms
 *   - main-view and tool-view switch P95: < 200ms
 *
 * CDP is used instead of --dump-dom so the gate can observe app boot completion, force layout,
 * wait for painted frames, and measure repeated interactions in the real browser process.
 */
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
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

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;
function request(port, pathname, method = 'GET') {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: 1500 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve({ status: response.statusCode, json: JSON.parse(body) }); }
        catch { resolve({ status: response.statusCode, body }); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
async function waitFor(port, pathname, predicate, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, pathname);
    if (result && predicate(result)) return result;
    await sleep(50);
  }
  return null;
}
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}
function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] || 0;
}
function buildBaselineSession(home) {
  const messages = [];
  for (let turnSeq = 1; turnSeq <= 30; turnSeq++) {
    messages.push({
      role: 'user',
      content: `基准问题 ${turnSeq}：请给出简洁结论和下一步。`,
      turnSeq,
      createdAt: new Date(Date.now() - (31 - turnSeq) * 60000).toISOString(),
    });
    messages.push({
      role: 'assistant',
      engine: 'openai',
      providerId: 'benchmark',
      model: 'local-benchmark',
      content: `基准回答 ${turnSeq}。这里是用于首屏渲染的稳定文本，不访问任何外部服务。`,
      segments: [{ type: 'text', text: `基准回答 ${turnSeq}。这里是用于首屏渲染的稳定文本，不访问任何外部服务。` }],
      turnSeq,
      createdAt: new Date(Date.now() - (31 - turnSeq) * 60000 + 1000).toISOString(),
    });
  }
  const session = {
    id: 'sess_ecdperformance01',
    schemaVersion: 1,
    turnSeq: 30,
    title: 'EC-D 基准会话',
    summary: '',
    pinned: false,
    cwd: home,
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date().toISOString(),
    claudeSessionId: null,
    messages,
    providerHistory: [],
    attachments: [],
    todos: [],
  };
  const sessions = path.join(home, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, session.id + '.json'), JSON.stringify(session, null, 2), 'utf8');
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id || !this.pending.has(message.id)) return;
        const { resolve: done, reject: failPending } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) failPending(new Error(message.error.message || JSON.stringify(message.error)));
        else done(message.result || {});
      });
      socket.addEventListener('close', () => {
        for (const { reject: failPending } of this.pending.values()) failPending(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result && result.result.value;
  }
  close() {
    try { this.socket && this.socket.close(); } catch { /* ignore */ }
  }
}

async function waitForTarget(debugPort, appUrl) {
  for (let i = 0; i < 120; i++) {
    const list = await request(debugPort, '/json/list');
    const targets = list && Array.isArray(list.json) ? list.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}
async function waitForInteractive(cdp, previousTimeOrigin = 0) {
  const expression = `(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    // 121-K5：#modelChip 退役 —— 「可交互」的判据换成线程头那组 chip 已经建出来了
    // （js/thread-head.js 在 bind 时 mount 的三枚 .steward-chip，静态 HTML 里 #threadChips 是空的）。
    const chip = document.querySelector('#threadChips .steward-chip');
    const input = document.getElementById('promptInput');
    const messages = document.getElementById('messages');
    const ready = performance.timeOrigin !== ${Number(previousTimeOrigin)}
      && document.readyState === 'complete'
      && !!chip && !!input && !input.disabled
      && !!messages && messages.getAttribute('aria-busy') !== 'true';
    const resources = performance.getEntriesByType('resource');
    return {
      ready,
      timeOrigin: performance.timeOrigin,
      interactiveMs: performance.now(),
      domInteractiveMs: navigation ? navigation.domInteractive : 0,
      loadEventMs: navigation ? navigation.loadEventEnd : 0,
      resourceCount: resources.length,
      cssCount: resources.filter(entry => /\\/css\\/.*\\.css(?:$|\\?)/.test(entry.name)).length,
      jsCount: resources.filter(entry => /\\/(?:app|js\\/[^/]+)\\.js(?:$|\\?)/.test(entry.name)).length,
      transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      resourceDurationMs: resources.reduce((max, entry) => Math.max(max, entry.responseEnd || 0), 0),
    };
  })()`;
  for (let i = 0; i < 300; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value && value.ready) return value;
    } catch { /* execution context is briefly unavailable during reload */ }
    await sleep(10);
  }
  return null;
}

const MAIN_VIEW_MEASURE = `(async () => {
  const samples = [];
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const measure = async (id, expected) => {
    const button = document.getElementById(id);
    const pane = document.querySelector('.chat-pane');
    const start = performance.now();
    button.click();
    await frame();
    pane.getBoundingClientRect();
    if (pane.dataset.mainView !== expected) throw new Error('main view did not switch to ' + expected);
    return performance.now() - start;
  };
  for (let i = 0; i < 4; i++) {
    await measure('mainViewTabCanvas', 'canvas');
    await measure('mainViewTabChat', 'chat');
  }
  for (let i = 0; i < ${SWITCH_SAMPLES}; i++) {
    samples.push(await measure(i % 2 ? 'mainViewTabChat' : 'mainViewTabCanvas', i % 2 ? 'chat' : 'canvas'));
  }
  return samples;
})()`;

const TOOL_VIEW_MEASURE = `(async () => {
  const samples = [];
  const names = ['files', 'artifacts', 'changes', 'agent-runs', 'usage', 'audit'];
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  for (let i = 0; i < ${SWITCH_SAMPLES}; i++) {
    const name = names[i % names.length];
    const button = document.querySelector('.tool-pane .tool-tabs button[data-tab="' + name + '"]');
    const start = performance.now();
    button.click();
    await frame();
    document.querySelector('.tool-pane').getBoundingClientRect();
    if (!button.classList.contains('active')) throw new Error('tool view did not switch to ' + name);
    samples.push(performance.now() - start);
  }
  return samples;
})()`;

(async () => {
  const appPort = await getFreePort();
  const debugPort = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ecd-perf-'));
  const home = path.join(root, 'home');
  const profile = path.join(root, 'browser-profile');
  fs.mkdirSync(home);
  buildBaselineSession(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 9,
    version: '2.1.0',
    permissionMode: 'bypass',
    theme: 'dark',
    uiMode: 'simple',
    // 121 波 K0（34 号文 §8.4）：stewardEnabledV1 默认翻成 true、首开默认落管家视角。本件量的是
    // 【经典壳】的冷启动与视图切换预算（基线是按经典壳定的），显式关掉管家，别让口径悄悄换成另一个壳。
    stewardEnabledV1: false,
  }), 'utf8');

  const server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home },
    windowsHide: true,
  });
  let browser = null;
  let cdp = null;
  try {
    // 121-治抖动（2026-09-12 换机器实测）：这是「服务起得来」的门，不是本件量的指标。全新 HOME 首启在
    // 装了 Python 但没装 mcp 包的机器上要 6.5 s（01-config detectDesktopMcp 三次 python 探针各 ~1.7 s），
    // 默认 100 次 × (请求 + 50ms) ≈ 5–6 s 的预算必红。门放到 ~20 s；探针阻塞登记为产品债。
    const ready = await waitFor(appPort, '/health', result => result.status === 200, 400);
    ok(Boolean(ready), 'EC-D benchmark server started');
    const executable = browserPath();
    ok(Boolean(executable), 'EC-D benchmark found Edge/Chrome');
    if (!ready || !executable) throw new Error('performance prerequisites unavailable');

    const appUrl = `http://127.0.0.1:${appPort}/`;
    const browserArgs = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--force-device-scale-factor=1',
      '--window-size=1440,1000',
      '--remote-debugging-port=' + debugPort,
      '--user-data-dir=' + profile,
    ];
    if (/msedge\.exe$/i.test(executable)) browserArgs.push('--edge-skip-compat-layer-relaunch');
    browserArgs.push(appUrl);
    browser = cp.spawn(executable, browserArgs, { windowsHide: true, stdio: 'ignore' });

    const target = await waitForTarget(debugPort, appUrl);
    ok(Boolean(target), 'CDP page target available');
    if (!target) throw new Error('CDP target unavailable');
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    const startup = [];
    // Warm-up: let the browser process/renderer finish one-time init (V8 JIT, font/network stack).
    // That first load measures browser cold-start, not Workbench navigation, so it is not part of the
    // cold-navigation budget. Every sampled run below is still an ignoreCache:true cold-cache navigation.
    let metrics = await waitForInteractive(cdp);
    for (let i = 0; i < STARTUP_RUNS; i++) {
      const previous = metrics && metrics.timeOrigin || 0;
      await cdp.send('Page.reload', { ignoreCache: true });
      metrics = await waitForInteractive(cdp, previous);
      if (metrics) startup.push(metrics);
    }
    ok(startup.length === STARTUP_RUNS, `captured ${STARTUP_RUNS}/${STARTUP_RUNS} cold interactive samples`);
    const startupMs = startup.map(sample => sample.interactiveMs);
    const startupMax = startupMs.length ? Math.max(...startupMs) : Infinity;
    ok(startup.length === STARTUP_RUNS && startupMax < STARTUP_BUDGET_MS,
      `first interactive max < ${STARTUP_BUDGET_MS}ms (samples ${startupMs.map(ms => ms.toFixed(1)).join(', ')}ms)`);

    const mainSamples = await cdp.evaluate(MAIN_VIEW_MEASURE);
    const mainP95 = percentile(mainSamples || [], 0.95);
    ok(Array.isArray(mainSamples) && mainSamples.length === SWITCH_SAMPLES,
      `captured ${SWITCH_SAMPLES} main-view switch samples`);
    ok(mainP95 < VIEW_SWITCH_P95_BUDGET_MS,
      `main-view switch P95 < ${VIEW_SWITCH_P95_BUDGET_MS}ms (got ${mainP95.toFixed(1)}ms)`);

    const toolSamples = await cdp.evaluate(TOOL_VIEW_MEASURE);
    const toolP95 = percentile(toolSamples || [], 0.95);
    ok(Array.isArray(toolSamples) && toolSamples.length === SWITCH_SAMPLES,
      `captured ${SWITCH_SAMPLES} tool-view switch samples`);
    ok(toolP95 < VIEW_SWITCH_P95_BUDGET_MS,
      `tool-view switch P95 < ${VIEW_SWITCH_P95_BUDGET_MS}ms (got ${toolP95.toFixed(1)}ms)`);

    const last = startup[startup.length - 1] || {};
    console.log('METRICS ' + JSON.stringify({
      startupMs: startupMs.map(ms => Number(ms.toFixed(1))),
      startupMaxMs: Number(startupMax.toFixed(1)),
      mainViewP95Ms: Number(mainP95.toFixed(1)),
      toolViewP95Ms: Number(toolP95.toFixed(1)),
      resourceCount: last.resourceCount,
      cssCount: last.cssCount,
      jsCount: last.jsCount,
      transferBytes: last.transferBytes,
      resourceDurationMs: Number((last.resourceDurationMs || 0).toFixed(1)),
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
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock; harmless */ }
    console.log('\nEC-D PERFORMANCE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

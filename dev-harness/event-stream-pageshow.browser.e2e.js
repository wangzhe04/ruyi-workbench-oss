#!/usr/bin/env node
'use strict';

// 真实浏览器 E2E（治抖动那批 · 34 号文 §13.6 登记④ ／ §14 末条）：bfcache `pageshow` 后
// 事件流【不自动重连】。
//
// 病根（public/js/event-stream.js `bind()`）：`pagehide` 一律 `stop()`（`started=false`、
// 中止在飞的连接）——这一半是对的（真正的收摊信号，文件头注 ③）。但 bfcache 把页面【冻结】
// 而不是销毁：用户前进/后退回到这个页面时触发的是 `pageshow`（`event.persisted === true`），
// JS 堆原样解冻，`started` 却还停在 `pagehide` 时钉的 `false`——没有任何监听器再调 `start()`，
// 于是壳还在屏幕上，推送这条线永远死着，只能刷新才能救回来（K2b 交付记录 §13.6 原话）。
//
// 只改 event-stream.js 一处：`bind()` 里补一个 `pageshow` 监听器，`event.persisted` 为真就
// 调 `start()`——复用既有的 `connect()`/退避路径，不写第二条重连逻辑。
//
// 验证手法：真实的 bfcache 冻结/解冻在无头 CDP 里没有确定性触发点，所以按浏览器自己的事件
// 形状构造合成事件（`new PageTransitionEvent('pagehide'|'pageshow', { persisted: true })`）
// 直接派给 window——这与浏览器真实派发给页面监听器的事件形状逐字相同（`persisted` 是这两个
// 事件唯一携带的业务字段），派发路径（`window.dispatchEvent`）与真实触发路径对监听器而言
// 不可区分。
//
// 断言：① 先建立一条正常连接（首屏只有一条 `/api/events/stream` 请求，同 event-stream-client
// 的 A8b）；② 派 `pagehide(persisted:true)` 模拟被冻结进 bfcache；③ 派 `pageshow(persisted:true)`
// 模拟从 bfcache 恢复；④ 随后【恰有一次】新的 `/api/events/stream` 请求（不多不少 —— 多了说明
// 重复 start，比如 sync() 的去抖窗口又叠了一次）；⑤ 这条新连接是真活的，不只是发出去一个
// 请求就完了：管家直接开一条线程（`/api/steward/act` 直调 `steward_thread_new`，不经模型），
// 断言左栏在 ≤2 s 内出现这一行（走的是 `thread.created` 推送帧，不是兜底轮询——兜底节拍拉到
// 120 s，2 s 内不可能是轮询捞到的）。
//
// 判定行：`EVENT STREAM PAGESHOW BROWSER E2E: ALL PASS`。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');
const { findBrowserExecutable } = require('./lib/browser-path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '重连之后管家开的这一条';
const RECONNECT_BUDGET_MS = 3000;   // pageshow 之后新连接该多快发出去（既有 connect() 是同步调用，没有退避门槛）
const ROW_BUDGET_MS = 2000;         // 新线程进左栏的延迟预算（推送口径，§6.3 同档 1 s 的 2 倍余量）
const POLL_MS = 120000;             // 拉满：观察窗内轮询不该贡献任何一次命中

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 30000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* non-json */ } resolve({ status: response.statusCode, text, json }); });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(100);
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

// fake provider：本件全程走 steward_thread_new 直调（不经模型），provider 只用来让 boot
// 能顺利拉一次 /models（若有）；不需要真的支持任何对话形状。
function startProvider(port) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if ((req.url || '').includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"data":[{"id":"fake-model"}]}');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.logs = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.method === 'Runtime.consoleAPICalled' || message.method === 'Runtime.exceptionThrown') {
          try { this.logs.push(JSON.stringify(message.params).slice(0, 400)); } catch { /* ignore */ }
          return;
        }
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
  for (let i = 0; i < 200; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}
async function waitForEval(cdp, expression, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; }
    catch { /* reload swaps execution context */ }
    await sleep(50);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.config) return null;
  if (document.documentElement.getAttribute('data-shell-mode') !== 'steward') return null;
  if (!document.getElementById('stewardStatusLine')) return null;
  return { ready: true };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-event-stream-pageshow-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: home, includeWorkbenchMcp: false, killOnDisconnect: false,
  autoImportClaudeCodeMcp: false, subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: POLL_MS,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  stewardProviderId: 'fake', stewardModel: 'fake-model', stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 2000,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
let browser = null;
let cdp = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started');
  let token = '';
  for (let i = 0; i < 300 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');
  if (!token) throw new Error('token unavailable');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A3 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A4 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  // 页面侧仪器：只需要一份 fetch 日志（数 /api/events/stream 发了几次）与一个左栏行探针。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const log = [];
      window.__ruyiFetchLog = () => log.slice();
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        let url = '';
        try { url = typeof input === 'string' ? input : String((input && input.url) || ''); } catch (e) { url = ''; }
        log.push({ url: url, at: Date.now() });
        return nativeFetch.call(window, input, init);
      };
    })();`,
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'A5 首屏落管家视角且骨架就位');

  const streamCountExpr = `window.__ruyiFetchLog().filter(row => row.url.indexOf('/api/events/stream') >= 0).length`;
  const initialCount = await waitForEval(cdp, `${streamCountExpr} > 0 ? ${streamCountExpr} : null`);
  ok(initialCount === 1, `A6 首屏只建了【一条】事件流连接（boot 末尾才 start；实测 ${initialCount}）`);

  // ── 合成 bfcache 冻结/恢复 ──────────────────────────────────────────────────────
  // 真实浏览器派给 window 的 pagehide/pageshow 就长这个形状（PageTransitionEvent，唯一
  // 业务字段是 persisted）；派发路径（dispatchEvent）对监听器而言与浏览器原生触发不可区分。
  const dispatchedHide = await cdp.evaluate(
    `(window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })), true)`);
  ok(dispatchedHide === true, 'B1 已派 pagehide(persisted:true)（模拟被冻结进 bfcache）');
  await sleep(300);   // 给 stop() 的 abort 一点时间落地

  const beforeShow = await cdp.evaluate(streamCountExpr);
  const dispatchedShow = await cdp.evaluate(
    `(window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })), true)`);
  ok(dispatchedShow === true, 'B2 已派 pageshow(persisted:true)（模拟从 bfcache 恢复）');

  const reconnected = await waitForEval(cdp, `${streamCountExpr} > ${beforeShow} ? ${streamCountExpr} : null`,
    Math.ceil(RECONNECT_BUDGET_MS / 50));
  ok(reconnected === beforeShow + 1,
    `B3 pageshow(persisted) 之后【恰有一次】新的 /api/events/stream 请求（修前：0——事件流永远死着，只能刷新页面才能救回来；实测 ${reconnected == null ? beforeShow : reconnected}，起点 ${beforeShow}）`);

  // ── 新连接是真活的：管家直接开一条线程，靠 thread.created 推送帧上左栏，不是轮询捞到的 ──
  // stewardPollMs 拉满到 120000ms，ROW_BUDGET_MS(2000ms) 内不可能是兜底轮询命中。
  const created = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: THREAD_TITLE, cwd: home, brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  const sid = created && created.json && created.json.result && created.json.result.sessionId;
  ok(Boolean(sid), `C1 管家开出线程（${sid || '失败'}）`);
  if (!sid) throw new Error('steward thread fixture unavailable');

  const rowUp = await waitForEval(cdp, `(() => {
    const rows = [...document.querySelectorAll('#railList .steward-board-thread')];
    return rows.some(node => {
      const label = node.querySelector('.steward-board-thread-title');
      return label && String(label.textContent || '').indexOf(${JSON.stringify(THREAD_TITLE)}) >= 0;
    }) ? 1 : null;
  })()`, Math.ceil(ROW_BUDGET_MS / 50));
  ok(Boolean(rowUp),
    `C2 重连之后【推送仍在正常工作】：管家新开的线程在 ${ROW_BUDGET_MS}ms 内出现在左栏（走 thread.created 帧，兜底节拍拉满到 ${POLL_MS}ms，这个窗口内轮询不可能命中）`);
} catch (error) {
  fail += 1;
  console.log('FAIL 夹具异常: ' + (error && error.message ? error.message : String(error)));
  if (cdp && cdp.logs.length) console.log('# 页面日志 tail: ' + cdp.logs.slice(-4).join(' | '));
} finally {
  try { cdp && cdp.close(); } catch { /* ignore */ }
  killTree(browser);
  try { await stopRuyiTestBrowsers(profile); } catch { /* ignore */ }
  killTree(server);
  try { provider && provider.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(fail === 0 ? 'EVENT STREAM PAGESHOW BROWSER E2E: ALL PASS' : `EVENT STREAM PAGESHOW BROWSER E2E: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);

// ─────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION（真跑过：改动 → 记红 → 还原）：
// 把 event-stream.js `bind()` 里新加的
//   `if (globalThis.addEventListener) globalThis.addEventListener('pageshow', event => { if (event && event.persisted) start(); });`
// 这一行注释掉（还原成修前：只有 pagehide 监听器，没有 pageshow 监听器）→ 见交付记录里
// 记的实测：B3 红（reconnected 停在 beforeShow，60 次×50ms 轮询后仍是 null）、C2 跟着红
// （左栏永远等不到那一行——事件流真的死透了，不是巧合绿）。还原后两条復绿。
// ─────────────────────────────────────────────────────────────────────────────
})();

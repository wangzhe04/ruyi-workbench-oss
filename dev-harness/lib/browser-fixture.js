'use strict';
// 128d(48 号文 §1):真浏览器件的公共夹具 —— 起假 provider、起隔离家目录的工作台、起无头 Edge/Chrome、
// CDP 客户端(单命令看门狗 ＋ readyState 闸 ＋ 事件订阅)、收尸只杀自己的树。
//
// 为什么要有它:在它之前,每件浏览器测试各自复制一份 CdpClient/startProvider/killTree(27 份,见
// process-safety.static 的 CDP_OWNERS)—— 128c 修「socket 关了静默挂死」与「taskkill /T 撞号」就得改 27 处。
// 新件一律用这里的,不再复制第 28 份。
//
// run-all 的约定:开浏览器的件要拿一个属于自己的 profile 根(107-F9b)。run-all 按件的源码认「开不开浏览器」——
// 源码里有 `--user-data-dir=` 或 require 了本文件。profile 一律建在 os.tmpdir() 下(run-all 装的范围把它指到本件的根)。
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('../free-port.js');
const { stopRuyiTestBrowsers } = require('./browser-cleanup');
const { findBrowserExecutable } = require('./browser-path');
const { killOwnTree } = require('./kill-own-tree');

const ROOT = path.resolve(__dirname, '..', '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CDP_COMMAND_TIMEOUT_MS = 90000;

function request(port, method, pathname, body, token, timeoutMs = 30000) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}

// 假 provider:`script(ctx)` 决定这一发怎么回。ctx = { body, messages, answered(有 tool 结果), sse, text, toolCall, stop }。
// 不给 script 时每一发都只回一句「好。」。
async function startProvider(port, script) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => { try { res.write('data: ' + JSON.stringify(value) + '\n\n'); } catch { /* client gone */ } };
    const ctx = {
      body, messages,
      answered: messages.some(m => m && m.role === 'tool'),
      sse,
      text: t => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: t }, finish_reason: null }] }),
      toolCall: (name, args, id = 'call_' + name) => {
        sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args || {}) } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      },
      stop: () => {
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
      },
    };
    try {
      if (typeof script === 'function') await script(ctx);
      else { ctx.text('好。'); ctx.stop(); }
    } catch { /* 脚本自己的错不该让 provider 挂住 */ }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.listeners = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.method) {
          for (const fn of this.listeners.get(message.method) || []) { try { fn(message.params || {}); } catch { /* listener */ } }
          return;
        }
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'cdp error'));
        else pending.resolve(message.result || {});
      });
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  // 单命令看门狗(36 号文 §5.2):无头浏览器偶发中途整个没了,没有这只狗 evaluate 会永远挂着。
  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 命令超时(' + timeoutMs + ' ms):' + method + ' —— 浏览器多半已经没了'));
      }, timeoutMs);
      const settle = fn => value => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result && result.result.value;
  }
  close() { try { this.socket && this.socket.close(); } catch { /* ignore */ } }
}

async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(80);
  }
  return null;
}

async function waitForTarget(debugPort, appUrl) {
  for (let i = 0; i < 300; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

// 首屏就绪:config 到了、外框在、视角分段钮已绑上。
const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('appFrame')) return null;
  const button = document.querySelector('#lensSeg [data-lens]');
  if (!button || typeof button.onclick !== 'function') return null;
  return { ready: true };
})()`;

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 起一整套:假 provider ＋ 工作台(隔离家目录、随机端口)＋ 无头浏览器 ＋ CDP。
//   opts.prefix     临时根前缀(必须以 ruyi- 开头 —— run-all 的全局收尸按这个认测试浏览器)
//   opts.config     叠在基础配置上的键(基础配置:假 provider、管家开、onboarding 已完成、includeWorkbenchMcp 关)
//   opts.provider   假 provider 的脚本(见 startProvider)
//   opts.width/height 窗口尺寸(默认 1280×900)
//   opts.prepare    浏览器起来之前调一次:async ({ request, token, work, home, appPort }) => {}(建线程、跑回合)
//   opts.ok         断言函数(夹具自己的前置步骤也记成 PASS/FAIL 行)
//   opts.serverEnv  叠在工作台子进程环境上的键(128f-③:测试口 WCW_TEST_* 与 TMP 之类;家目录那几个键不许覆盖)
async function startBrowserFixture(opts = {}) {
  const ok = typeof opts.ok === 'function' ? opts.ok : () => {};
  const prefix = String(opts.prefix || 'ruyi-bfx-');
  if (!prefix.startsWith('ruyi-')) throw new Error('fixture prefix must start with ruyi- (run-all reaps test browsers by it)');
  const width = opts.width || 1280;
  const height = opts.height || 900;
  const appPort = await getFreePort();
  const providerPort = await getFreePort();
  const debugPort = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const profile = path.join(root, 'profile');
  for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
  const config = {
    configSchema: 12,
    activeProvider: 'fake',
    engineMode: 'interactive',
    permissionMode: 'default',
    theme: 'dark',
    locale: 'zh-CN',
    defaultWorkspace: work,
    includeWorkbenchMcp: false,
    autoImportClaudeCodeMcp: false,
    stewardEnabledV1: true,
    stewardPollMs: 120000,
    stewardVisitIdleMinutes: 60,
    onboarding: { completedAt: '2026-09-13T00:00:00.000Z', version: 1, skipped: false },
    providers: [{
      id: 'fake', label: 'Fake', type: 'openai-compat',
      baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
      models: [{ id: 'fake-model', label: 'Fake' }],
    }],
    ...(opts.config || {}),
  };
  for (const [k, v] of Object.entries(opts.config || {})) if (v === undefined) delete config[k];
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config), 'utf8');

  const fx = {
    root, home, work, profile, appPort, providerPort, debugPort, token: '',
    provider: null, server: null, browser: null, cdp: null,
    exceptions: [], consoleErrors: [],
    request: (method, pathname, body, timeoutMs) => request(appPort, method, pathname, body, fx.token, timeoutMs),
  };
  fx.close = async ({ keepRoot = false } = {}) => {
    if (fx.cdp) fx.cdp.close();
    killTree(fx.browser);
    try { stopRuyiTestBrowsers(profile); } catch { /* best effort */ }
    killTree(fx.server);
    if (fx.provider) await new Promise(resolve => fx.provider.close(resolve));
    await sleep(300);
    if (!keepRoot) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ } }
  };

  fx.provider = await startProvider(providerPort, opts.provider);
  fx.server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, ...(opts.serverEnv || {}), RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  const up = await waitForHttp(appPort, 'GET', '/health', result => result.status === 200);
  ok(Boolean(up), 'F0 工作台起来了');
  if (!up) throw new Error('workbench did not start');
  for (let i = 0; i < 80 && !fx.token; i++) {
    try { fx.token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { fx.token = ''; }
    if (!fx.token) await sleep(100);
  }
  ok(Boolean(fx.token), 'F0b runtime token 可读');
  if (typeof opts.prepare === 'function') await opts.prepare(fx);

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'F0c 找到 Edge/Chrome');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  fx.browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'F0d 浏览器 target 可连');
  if (!target) throw new Error('CDP target unavailable');
  fx.cdp = new CdpClient(target.webSocketDebuggerUrl);
  await fx.cdp.connect();
  // 页面上的未捕获异常与 console.error 一律记下来 —— 「渲染出来了」不等于「没在后台炸」。
  fx.cdp.on('Runtime.exceptionThrown', p => {
    const d = p.exceptionDetails || {};
    fx.exceptions.push(String((d.exception && d.exception.description) || d.text || 'exception').split('\n')[0].slice(0, 240));
  });
  fx.cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type !== 'error') return;
    fx.consoleErrors.push((p.args || []).map(a => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ').slice(0, 240));
  });
  await fx.cdp.send('Page.enable');
  await fx.cdp.send('Runtime.enable');
  await fx.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  fx.evaluate = expression => fx.cdp.evaluate(expression);
  fx.waitForEval = async (expression, attempts = 800) => {
    for (let i = 0; i < attempts; i++) {
      try {
        const value = await fx.cdp.evaluate(expression);
        if (value) return value;
      } catch (error) {
        if (String(error && error.message).indexOf('CDP') >= 0) throw error;
      }
      await sleep(40);
    }
    return null;
  };
  fx.resize = async (w, h) => {
    await fx.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    return fx.cdp.evaluate('({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })');
  };
  // 真键盘:rawKeyDown/keyUp(带 char 的键再补一个 char 事件)。modifiers: 8=Shift。
  fx.key = async (key, { code = key, keyCode = 0, modifiers = 0, text = '' } = {}) => {
    await fx.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    if (text) await fx.cdp.send('Input.dispatchKeyEvent', { type: 'char', text, modifiers });
    await fx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  fx.tab = (shift = false) => fx.key('Tab', { keyCode: 9, modifiers: shift ? 8 : 0 });
  fx.enter = () => fx.key('Enter', { keyCode: 13, text: '\r' });
  fx.escape = () => fx.key('Escape', { keyCode: 27 });
  fx.setLens = async lens => {
    await fx.cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return fx.waitForEval(`(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  fx.screenshot = async (clip) => {
    const shot = await fx.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    return Buffer.from(shot.data || '', 'base64');
  };
  ok(Boolean(await fx.waitForEval(READY)), 'F0e 首屏就绪');
  return fx;
}

module.exports = { startBrowserFixture, startProvider, CdpClient, request, waitForHttp, waitForTarget, READY, sleep, WB, ROOT };

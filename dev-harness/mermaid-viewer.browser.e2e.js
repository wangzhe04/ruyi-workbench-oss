#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 换机器：直跑时家目录自隔离（服务启动会从真机 ~/.claude.json 导入 MCP 并同步回真机 CLI 配置，两个方向都要断）

// 2026-09-22 真浏览器 E2E：**mermaid 图表的放大查看**（用户反馈「大图缩在消息栏里看不全，
// 不能点开全屏看或者保存」）。修前大图被 .mermaid-view 的 max-width:100% 压成一团；
// 现在点图或工具条「放大」开全屏灯箱：滚轮缩放（指针为锚）、拖拽平移、「适应窗口」复位，
// Esc／点遮罩／「关闭」退出。
//
// 本件钉这条链的真机面（DOM 桩件 mermaid-render.static.e2e.js 管逻辑，本件管浏览器里真发生）：
//   B1  回复里的 ```mermaid 围栏真渲染成 SVG（vendor 懒加载链路通了 —— 这是
//       ruyi-workbench/app/public/vendor/mermaid.min.js 入库后的第一件真机验证）；
//   B2  工具条五枚：源码 / 复制 / 放大 / 导出 SVG / 导出 PNG；
//   B3  灯箱：点「放大」开出全屏 dialog，里面是同一份 SVG，开箱即「适应窗口」落位；
//   B4  滚轮缩放真改 transform（放大后 scale 变大），「适应窗口」按回去；
//   B5  三只退出的手全灵：Esc、「关闭」按钮、点遮罩；点图本身也能再开。
//
// 2026-10-03 用户反馈「暗色下 mermaid 不好看、有的图生成得有问题、浅色下点开图片后鼠标很容易看不到」，追加：
//   B7c PNG 导出带底色（暗色图是浅字，透明底在白底看图器里看不见）；
//   B8  切换亮暗后已画好的图按新主题重画（修前亮色图原样留在暗底上），切回也收敛；
//   B9  甘特图按栏宽排版、同日刻度不重复、排期外的「今天」线去掉（排期内保留）、网格线用色板线色；
//   B10 浅色下灯箱是压暗的实色幕布 + 实底卡片（修前 46% 白毛玻璃 + 透明底图，光标糊在里面）。
//
// 夹具：确定性 fake provider —— 回答里带一段 ```mermaid 围栏。后端零改动。

(async () => {
const { killOwnTree } = require('./lib/kill-own-tree');
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

const MERMAID_SOURCE = 'flowchart LR\n  A[拼素材] --> B[便宜的 L1]\n  B --> C{够不够?}\n  C -->|够| D[交付]\n  C -->|不够| E[贵的 L2]\n  E --> D';
const ANSWER = '先看一张结构图：\n\n```mermaid\n' + MERMAID_SOURCE + '\n```\n\n图看完了。';

function request(port, method, pathname, body, token, timeoutMs = 20000) {
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

async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(80);
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

// 确定性 provider：一次回答里带一段 ```mermaid 围栏（流式两帧收尾）。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: ANSWER }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
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
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
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
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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

// 预算 800 × 40ms = 32 s（mermaid 懒加载 8s 超时也在预算内）。
async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload 会换执行上下文 */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('threadHead')) return null;
  return { ready: true };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mermaid-viewer-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(root, 'profile');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.4.0',
  activeProvider: 'fake',
  engineMode: 'interactive',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: home,
  includeWorkbenchMcp: false,
  stewardEnabledV1: true,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
const shots = {};

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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A1 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  const created = await request(appPort, 'POST', '/api/sessions', { title: '结构图', cwd: work }, token);
  const sessionId = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sessionId), `A3 线程已建（${sessionId || '失败'}）`);
  if (!sessionId) throw new Error('session fixture unavailable');

  // 打一回合（HTTP 起，浏览器随后打开这条线程看落盘的渲染）。
  const turn = await request(appPort, 'POST', '/api/chat/stream', { sessionId, message: '画一张结构图', cwd: work }, token, 60000);
  ok(Boolean(turn) && turn.status === 200, `A4 回合已跑完（HTTP ${turn && turn.status}）`);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/sessions/' + encodeURIComponent(sessionId),
    result => ((result.json && result.json.session && result.json.session.messages) || [])
      .some(message => message && message.role === 'assistant' && String(message.content || '').includes('```mermaid')), token)),
    'A5 落盘的助手消息里带着 ```mermaid 围栏');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A6 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1600,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A7 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A8 首屏就绪');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const row = document.querySelector('#railList [data-session-id="${sessionId}"]');
    if (row) { (row.querySelector('.steward-board-thread-title') || row).click(); }
    return window.state && window.state.currentSession && window.state.currentSession.id === '${sessionId}' ? 1 : null;
  })()`)), 'A9 打开这条线程');

  /* ═════════ B1 围栏真渲染成 SVG ═════════ */
  const rendered = await waitForEval(cdp, `(() => {
    const view = document.querySelector('#messages .mermaid-view');
    const svg = view && view.querySelector('svg');
    if (!svg) return null;
    return {
      buttons: Array.from(document.querySelectorAll('#messages .mermaid-tools .mermaid-btn')).map(b => b.textContent),
      nodes: svg.querySelectorAll('.node').length,
      hint: Boolean(document.querySelector('#messages .mermaid-hint')),
    };
  })()`);
  ok(Boolean(rendered) && rendered.nodes >= 4,
    `B1 mermaid 围栏真渲染成 SVG（${rendered && rendered.nodes} 个节点；vendor 懒加载链路真机首验）`);
  ok(Boolean(rendered) && rendered.hint === false, 'B1b 零降级提示（不是「图表库未就绪」那一支）');

  /* ═════════ B2 工具条五枚 ═════════ */
  ok(Boolean(rendered) && rendered.buttons.join('|') === '源码|复制|放大|导出 SVG|导出 PNG',
    `B2 工具条 = 源码 / 复制 / 放大 / 导出 SVG / 导出 PNG（实得 ${rendered && rendered.buttons.join('|')}）`);

  /* ═════════ B3 灯箱：开出、同一份 SVG、适应窗口落位 ═════════ */
  await cdp.evaluate(`document.querySelector('#lensSeg [data-lens="classic"]').click(), true`);
  ok(Boolean(await waitForEval(cdp, `(() => document.documentElement.dataset.shellMode === 'classic' && !document.documentElement.dataset.vt ? 1 : null)()`)), 'B3a 工作台视角可见后检查键盘焦点');
  await cdp.evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('#messages .mermaid-tools .mermaid-btn')).find(b => b.textContent === '放大');
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
  const lightbox = await waitForEval(cdp, `(() => {
    const box = document.querySelector('.mermaid-lightbox');
    if (!box) return null;
    const stage = box.querySelector('.mermaid-lightbox-stage');
    const svg = stage && stage.querySelector('svg');
    if (!svg) return null;
    const scaleOf = () => {
      const m = /scale\\(([^)]+)\\)/.exec(stage.style.transform || '');
      return m ? Number(m[1]) : 0;
    };
    box.__scaleOf = scaleOf;
    return {
      role: box.getAttribute('role'),
      modal: box.getAttribute('aria-modal'),
      nodes: svg.querySelectorAll('.node').length,
      scale: scaleOf(),
      controls: Array.from(box.querySelectorAll('.mermaid-lightbox-btn')).map(b => b.textContent),
      visible: typeof box.checkVisibility === 'function' ? box.checkVisibility() : true,
    };
  })()`);
  ok(Boolean(lightbox) && lightbox.role === 'dialog' && lightbox.modal === 'true' && lightbox.visible === true,
    `B3a 「放大」开出全屏灯箱（role=dialog、aria-modal、可见）`);
  ok(Boolean(lightbox) && lightbox.nodes >= 4, `B3b 灯箱里是【同一份】SVG（${lightbox && lightbox.nodes} 个节点）`);
  ok(Boolean(lightbox) && lightbox.scale > 0, `B3c 开箱即「适应窗口」落位（scale=${lightbox && lightbox.scale}）`);
  ok(Boolean(lightbox) && lightbox.controls.join('|') === '＋ 放大|－ 缩小|适应窗口|关闭',
    `B3d 控制条 = 放大 / 缩小 / 适应窗口 / 关闭（实得 ${lightbox && lightbox.controls.join('|')}）`);
  shots.lightbox = path.join(shotDir, 'mermaid-lightbox.png');
  fs.writeFileSync(shots.lightbox, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.lightbox).size > 8000, `B3-shot 灯箱实拍已存（${shots.lightbox}）`);

  /* ═════════ B4 滚轮缩放真改 transform ═════════ */
  const zoomed = await cdp.evaluate(`(() => {
    const box = document.querySelector('.mermaid-lightbox');
    const stage = box.querySelector('.mermaid-lightbox-stage');
    const scaleOf = () => Number((/scale\\(([^)]+)\\)/.exec(stage.style.transform || '') || [0, 0])[1]);
    const before = scaleOf();
    const rect = box.getBoundingClientRect();
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: rect.width / 2, clientY: rect.height / 2, bubbles: true, cancelable: true }));
    const after = scaleOf();
    return { before, after };
  })()`);
  ok(Boolean(zoomed) && zoomed.after > zoomed.before,
    `B4a 滚轮向上 = 放大（scale ${zoomed && zoomed.before} → ${zoomed && zoomed.after}）`);
  const refit = await cdp.evaluate(`(() => {
    const box = document.querySelector('.mermaid-lightbox');
    const stage = box.querySelector('.mermaid-lightbox-stage');
    const scaleOf = () => Number((/scale\\(([^)]+)\\)/.exec(stage.style.transform || '') || [0, 0])[1]);
    const fitBtn = Array.from(box.querySelectorAll('.mermaid-lightbox-btn')).find(b => b.textContent === '适应窗口');
    if (fitBtn) fitBtn.click();
    return { fit: Boolean(fitBtn), scale: scaleOf() };
  })()`);
  ok(Boolean(refit) && refit.fit === true && Math.abs(refit.scale - lightbox.scale) < 0.001,
    `B4b 「适应窗口」按回开箱落位（scale=${refit && refit.scale} ≈ ${lightbox && lightbox.scale}）`);

  /* ═════════ B5 三只退出的手 + 点图再开 ═════════ */
  await cdp.evaluate(`document.querySelector('.mermaid-lightbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  ok((await cdp.evaluate(`(() => !document.querySelector('.mermaid-lightbox'))()`)) === true, 'B5a Esc 退出灯箱');
  await cdp.evaluate(`document.querySelector('#messages .mermaid-view').click(), true`);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('.mermaid-lightbox') ? 1 : null)()`)),
    'B5b 点图本身也能开出灯箱');
  await cdp.evaluate(`(() => {
    const box = document.querySelector('.mermaid-lightbox');
    const closeBtn = Array.from(box.querySelectorAll('.mermaid-lightbox-btn')).find(b => b.textContent === '关闭');
    if (closeBtn) closeBtn.click();
    return Boolean(closeBtn);
  })()`);
  ok((await cdp.evaluate(`(() => !document.querySelector('.mermaid-lightbox'))()`)) === true, 'B5c 「关闭」按钮退出灯箱');
  await cdp.evaluate(`document.querySelector('#messages .mermaid-view').click(), true`);
  await waitForEval(cdp, `(() => document.querySelector('.mermaid-lightbox') ? 1 : null)()`);
  await cdp.evaluate(`(() => {
    const box = document.querySelector('.mermaid-lightbox');
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // target = 遮罩本身 = 点空白处
    return true;
  })()`);
  ok((await cdp.evaluate(`(() => !document.querySelector('.mermaid-lightbox'))()`)) === true, 'B5d 点遮罩空白处退出灯箱');
  const keyboard = await cdp.evaluate(`(() => {
    const trigger = Array.from(document.querySelectorAll('#messages .mermaid-btn')).find(b => b.textContent === '放大');
    trigger.focus(); trigger.click();
    const box = document.querySelector('.mermaid-lightbox');
    const buttons = [...box.querySelectorAll('button')];
    const tab = shiftKey => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey,bubbles:true,cancelable:true}));
    tab(true); const initial = document.activeElement === buttons.at(-1);
    tab(false); const forward = document.activeElement === buttons[0];
    tab(true); const backward = document.activeElement === buttons.at(-1);
    buttons.at(-1).click();
    return { initial, forward, backward, returned: document.activeElement === trigger };
  })()`);
  ok(Object.values(keyboard).every(Boolean), 'B5e Tab/Shift+Tab stay inside viewer; close restores trigger focus ' + JSON.stringify(keyboard));
  const exports = await cdp.evaluate(`(async () => {
    const saved = [];
    const blobs = new Map();
    const create = URL.createObjectURL;
    const click = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = function(blob) { const url = create.call(URL, blob); blobs.set(url, blob); return url; };
    HTMLAnchorElement.prototype.click = function() { const blob = blobs.get(this.href); if (blob) saved.push({ name: this.download, type: blob.type, size: blob.size, blob }); };
    try {
      for (const label of ['导出 SVG', '导出 PNG']) {
        Array.from(document.querySelectorAll('#messages .mermaid-btn')).find(b => b.textContent === label).click();
      }
      for (let i = 0; i < 50 && saved.length < 2; i++) await new Promise(r => setTimeout(r, 100));
      const png = saved.find(item => item.type === 'image/png');
      if (png) {
        const bitmap = await createImageBitmap(png.blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        png.cornerAlpha = ctx.getImageData(0, 0, 1, 1).data[3];
      }
      const svg = saved.find(item => item.name.endsWith('.svg'));
      if (svg) svg.text = await svg.blob.text();
      return saved.map(({ blob, ...rest }) => rest);
    } finally { URL.createObjectURL = create; HTMLAnchorElement.prototype.click = click; }
  })()`);
  ok(exports.some(item => item.name.endsWith('.svg') && item.size > 100), 'B7 SVG export produces a download');
  ok(exports.some(item => item.name.endsWith('.png') && item.type === 'image/png' && item.size > 100), 'B7b PNG export produces a download');
  ok(exports.some(item => item.name.endsWith('.png') && item.cornerAlpha === 255)
    && exports.some(item => item.name.endsWith('.svg') && /background-color:\s*rgb\(26, 36, 54\)/.test(item.text || '')),
    `B7c 导出带图的底色（PNG 角落不透明、SVG 根上写着暗色 --panel-2；实得 alpha=${(exports.find(item => item.name.endsWith('.png')) || {}).cornerAlpha}）`);
  const failures = await cdp.evaluate(`(async () => {
    const { renderMermaidBlocks } = await import('/js/mermaid-runtime.js');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const sources = ['flowchart TD\\n A[unclosed', 'sequenceDiagram\\n Alice->>Bob: hello\\n invalid syntax', 'flowchart LR\\n A-->B'];
    for (const source of sources) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.appendChild(code);
      root.appendChild(pre);
    }
    const count = await renderMermaidBlocks(root);
    const result = {
      count,
      fallback: root.querySelectorAll('[data-mermaid-state="fallback"]').length,
      visibleSources: Array.from(root.querySelectorAll('pre')).filter(p => !p.hidden).length,
      errors: document.querySelectorAll('svg .error-icon, svg .error-text').length,
      hosts: document.querySelectorAll('.mermaid-render-host').length,
    };
    root.remove();
    return result;
  })()`);
  ok(failures.count === 1 && failures.fallback === 2 && failures.visibleSources === 2,
    'B6 invalid diagrams preserve source; subsequent valid diagram still renders');
  ok(failures.errors === 0 && failures.hosts === 0,
    'B6b no leaked syntax-error SVG or temporary render hosts');

  /* ═════════ B8 切换亮暗：已画好的图按新主题重画 ═════════ */
  const themed = await cdp.evaluate(`(async () => {
    const block = document.querySelector('#messages .mermaid-block');
    const fillOf = () => {
      const shape = block.querySelector('.mermaid-view svg .node rect, .mermaid-view svg .node polygon');
      return shape ? getComputedStyle(shape).fill : '';
    };
    const svgBg = () => (block.querySelector('.mermaid-view svg') || { style: {} }).style.backgroundColor || '';
    const settle = async want => {
      for (let i = 0; i < 400; i++) {
        if (block.dataset.mermaidTheme === want && block.dataset.mermaidState === 'ok') return true;
        await new Promise(r => setTimeout(r, 40));
      }
      return false;
    };
    const before = { theme: block.dataset.mermaidTheme, fill: fillOf(), bg: svgBg() };
    document.documentElement.setAttribute('data-theme', 'light');
    const toLight = await settle('light');
    const light = { fill: fillOf(), bg: svgBg() };
    document.documentElement.setAttribute('data-theme', 'dark');
    const toDark = await settle('dark');
    const dark = { fill: fillOf(), bg: svgBg() };
    return { before, toLight, light, toDark, dark };
  })()`);
  ok(themed.before.theme === 'dark' && themed.before.fill === 'rgb(34, 51, 90)' && themed.before.bg === 'rgb(26, 36, 54)',
    `B8a 暗色下节点走工作台色板（填充 ${themed.before.fill}、图底 ${themed.before.bg}；修前是 mermaid 自带的近黑块）`);
  ok(themed.toLight && themed.light.fill === 'rgb(231, 237, 250)' && themed.light.bg === 'rgb(247, 249, 252)',
    `B8b 切到浅色后同一张图按浅色色板重画（填充 ${themed.light.fill}、图底 ${themed.light.bg}）`);
  ok(themed.toDark && themed.dark.fill === 'rgb(34, 51, 90)', `B8c 切回暗色也收敛（填充 ${themed.dark.fill}）`);

  /* ═════════ B9 甘特图：按栏宽排版、刻度去重、排期外的「今天」线去掉 ═════════ */
  const gantt = await cdp.evaluate(`(async () => {
    const { renderMermaidBlocks } = await import('/js/mermaid-runtime.js');
    const host = document.createElement('div');
    host.className = 'md';
    host.style.cssText = 'position:fixed;left:0;top:0;width:900px;z-index:-1';
    document.body.appendChild(host);
    const day = 86400000;
    const iso = ms => new Date(ms).toISOString().slice(0, 10);
    const sources = [
      'gantt\\n  title 整理\\n  dateFormat YYYY-MM-DD\\n  axisFormat %m-%d\\n  section 盘点\\n  扫描 :done, a1, 2020-01-06, 1d\\n  识别 :done, a2, after a1, 1d\\n  section 执行\\n  方案 :active, b1, after a2, 1d\\n  归档 :b2, after b1, 2d\\n  section 收尾\\n  报告 :crit, c1, after b2, 1d',
      'gantt\\n  dateFormat YYYY-MM-DD\\n  axisFormat %m-%d\\n  section 本周\\n  进行中 :active, n1, ' + iso(Date.now() - 2 * day) + ', 5d',
    ];
    for (const source of sources) {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'language-mermaid';
      code.textContent = source;
      pre.appendChild(code);
      host.appendChild(pre);
    }
    const count = await renderMermaidBlocks(host);
    const result = Array.from(host.querySelectorAll('.mermaid-view svg')).map(svg => {
      const line = svg.querySelector('.grid .tick line');
      return {
        labels: Array.from(svg.querySelectorAll('.grid .tick text')).map(text => text.textContent),
        width: svg.viewBox.baseVal.width,
        today: Boolean(svg.querySelector('line.today')),
        grid: line ? getComputedStyle(line).stroke : '',
      };
    });
    host.remove();
    return { count, result };
  })()`);
  const [outOfRange, inRange] = (gantt && gantt.result) || [];
  ok(gantt && gantt.count === 2 && outOfRange && inRange, `B9 两张甘特图都画出来（${gantt && gantt.count}）`);
  const repeated = outOfRange ? outOfRange.labels.filter((label, i, all) => i > 0 && label === all[i - 1]) : ['?'];
  ok(outOfRange && outOfRange.labels.length >= 4 && repeated.length === 0,
    `B9a 刻度不再同日连标两遍（${outOfRange && outOfRange.labels.join(' ')}）`);
  ok(outOfRange && outOfRange.width >= 800, `B9b 按栏宽排版（画布宽 ${outOfRange && outOfRange.width}，栏宽 900；修前离屏宿主不定宽，排成一小条）`);
  ok(outOfRange && outOfRange.today === false && inRange.today === true,
    `B9c 「今天」线：排期外去掉（${outOfRange && outOfRange.today}）、排期内保留（${inRange && inRange.today}）`);
  ok(outOfRange && outOfRange.grid === 'rgb(51, 66, 94)', `B9d 网格线用色板线色而不是继承页面正文色（${outOfRange && outOfRange.grid}）`);

  /* ═════════ B10 浅色下灯箱：压暗幕布 + 实底卡片 ═════════ */
  const lightBox = await cdp.evaluate(`(async () => {
    const block = document.querySelector('#messages .mermaid-block');
    document.documentElement.setAttribute('data-theme', 'light');
    for (let i = 0; i < 400 && !(block.dataset.mermaidTheme === 'light' && block.dataset.mermaidState === 'ok'); i++) {
      await new Promise(r => setTimeout(r, 40));
    }
    block.querySelector('.mermaid-view').click();
    const box = document.querySelector('.mermaid-lightbox');
    const stage = box && box.querySelector('.mermaid-lightbox-stage');
    const svg = stage && stage.querySelector('svg');
    const scrim = box ? getComputedStyle(box).backgroundColor : '';
    const card = stage ? getComputedStyle(stage) : null;
    const result = {
      scrim,
      cursor: box ? getComputedStyle(box).cursor : '',
      card: card ? card.backgroundColor : '',
      pad: card ? card.paddingTop : '',
      svgBg: svg ? svg.style.backgroundColor : '',
    };
    if (box) Array.from(box.querySelectorAll('.mermaid-lightbox-btn')).find(b => b.textContent === '关闭').click();
    document.documentElement.setAttribute('data-theme', 'dark');
    for (let i = 0; i < 400 && !(block.dataset.mermaidTheme === 'dark' && block.dataset.mermaidState === 'ok'); i++) {
      await new Promise(r => setTimeout(r, 40));
    }
    return result;
  })()`);
  const scrimMatch = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(lightBox.scrim || '');
  const scrimAlpha = scrimMatch ? Number(scrimMatch[4] === undefined ? 1 : scrimMatch[4]) : 0;
  const scrimDark = scrimMatch ? Math.max(Number(scrimMatch[1]), Number(scrimMatch[2]), Number(scrimMatch[3])) < 80 : false;
  ok(scrimDark && scrimAlpha >= 0.5, `B10a 浅色下灯箱幕布是压暗的实色（${lightBox.scrim}；修前是 46% 白毛玻璃，白芯光标糊在里面）`);
  ok(lightBox.card === 'rgb(247, 249, 252)' && lightBox.pad === '20px' && lightBox.svgBg === 'rgb(247, 249, 252)',
    `B10b 图落在实底卡片上（卡片 ${lightBox.card}、内边距 ${lightBox.pad}、图底 ${lightBox.svgBg}）`);
  ok(lightBox.cursor === 'grab', `B10c 灯箱仍是抓手光标（${lightBox.cursor}）`);
  console.log(`SHOTS ${shots.lightbox}`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) { try { provider.close(); } catch { /* ignore */ } }
  try { stopRuyiTestBrowsers(profile); } catch { /* ignore */ }
}

console.log(`\nMERMAID VIEWER BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

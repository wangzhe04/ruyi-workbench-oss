#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 第 122 波 L1a 真浏览器 E2E：**用户正在打长输入时，别的线程出事不许掀桌**（36 号文 §2.2；Codex §9 J04）。
//
// 34 号文 §14 ⑧ 记过一笔：quiet-card.browser 里那两句「焦点不动／输入目标不变」的反向验证在单连接
// 夹具下**拦不到东西**（服务端在场门已经把该挡的挡在收件箱外）。本件换一个量法 —— 不去量
// quiet-card.js 内部那两道双保险，而是量**用户那一侧的现场**：手在输入框里打字的当口，另一条
// 线程出事、安静卡真的弹出来了，此时六件事一件都不许变：
//   ① `document.activeElement` 仍是 `#promptInput`；
//   ② 输入框里的字逐字相等（40 字以上）；
//   ③ `state.currentSession.id` 不变（没被换会话）；
//   ④ `data-shell-mode` 不变（没被切视角）；
//   ⑤ 没有新开的浮层／弹窗（`.popover` 与 `.modal:not(.hidden)` 计数不增）；
//   ⑥ 对话区 `#messages` 的 `scrollTop` 不变（安静卡不许把人滚走）。
// 这六条全是**用户能直接看见的东西**，与服务端在场门无关，所以在单连接夹具里也拦得到东西
// （反向验证：在 quiet-card.js 的 mount／renderInto 里加一句 `.focus()` → ① 当场红）。
//
// 触发面按号文写的「fake 引擎失败剧本」＋ 稳定的 needs_you 两条一起下，谁先到算谁：13i 的
// `missionChange.failure → 'failed'` 要线程真有任务账本才落得下来，而普通会话不一定有；
// needs_you 那一路（投影产出、去重键=interventionId）是 quiet-card.browser A2 已经证过的确定路。
// 本件不赌哪一条先来 —— C1 只要求「安静卡真的出现了」，并把实际到的 kind 打出来。
//
// 判定行：`QUIET CARD TYPING BROWSER E2E: ALL PASS`。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
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
const CDP_COMMAND_TIMEOUT_MS = 90000;   // 单条 CDP 命令的看门狗（见 CdpClient.send 的注）
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// 5000 是 13i 收件箱 tick 的下限（clamp(stewardPollMs,5000,120000)）——安静卡吃的是那一拍派出的
// inbox.appended 帧，所以拉到下限（同 quiet-card.browser.e2e.js 的理由）。
const POLL_MS = 5000;
// 40 字以上的长输入（号文：「已输入 40 字」）。故意混中英文与标点：value 比对是逐字的。
const LONG_INPUT = '我正在写一段很长的话，中间夹着 English words 和标点符号，一共远超四十个字符，用来证明安静卡弹出来的时候这一段一个字都没丢。';

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

// 确定性 provider（同 quiet-card.browser.e2e.js 的分流手法，多一条失败剧本）：
//   · 'ask about X'  → 单选 request_user_input（options wait/skip）→ needs_you
//   · 'BOOMHERE'     → HTTP 500 ＋ 错误体 → 回合失败
//   · 其余           → 一段够长的回答（把对话区撑高，⑥ 要它能滚）
async function startProvider(port) {
  const LONG = '这是一段用来把对话区撑高的回答。'.repeat(40);
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] || {};
    const text = last.role === 'user' ? String(last.content || '') : '';
    if (text.indexOf('BOOMHERE') >= 0) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"fake upstream exploded","type":"server_error"}}');
    }
    const askMatch = text.match(/ask about (\w+)/);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    if (askMatch) {
      const key = askMatch[1];
      const args = JSON.stringify({ questions: [{
        id: `q_${key}`, header: key, question: `${key} 那件事要等吗？`, answerMode: 'single',
        options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
      }] });
      frame({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + key, type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: LONG }, finish_reason: null }] });
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
  // 每条 CDP 命令都带自己的看门狗。理由是实测踩到的：本机无头 Edge 偶发**中途整个没了**
  // （PowerShell 数 msedge.exe 归零），而 socket 的 close 事件在那一刻不一定来 —— 没有这只狗的话
  // 一次 evaluate 会永远挂着，直跑时看上去像「卡在某条断言」，run-all 里则要白等满超时。
  send(method, params = {}, timeoutMs = CDP_COMMAND_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error('CDP 命令超时（' + timeoutMs + ' ms）：' + method + ' —— 浏览器多半已经没了'));
      }, timeoutMs);
      const settle = fn => value => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
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

async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch (error) {
      // 导航/reload 会换执行上下文（那种错要吞掉继续轮询）；但 CdpClient 的看门狗错说明浏览器
      // 已经没了 —— 那种要立刻抛出去，不然这里会拿 800 次 × 90 s 慢慢磨。
      if (String(error && error.message).indexOf('CDP') >= 0) throw error;
    }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('quietCardHost')) return null;
  return { ready: true };
})()`;

// 现场快照：六条判据一次读全（外加安静卡实况，便于失败时取证）。
const SCENE = `(() => {
  const host = document.getElementById('quietCardHost');
  const cards = host ? [...host.querySelectorAll('.quiet-card')] : [];
  const input = document.getElementById('promptInput');
  const messages = document.getElementById('messages');
  return {
    active: (document.activeElement && document.activeElement.id) || '',
    value: input ? input.value : null,
    selectionStart: input ? input.selectionStart : -1,
    currentSessionId: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    mode: document.documentElement.getAttribute('data-shell-mode') || '',
    // 「有没有新开浮层」要数【真在屏幕上的那些】：.modal 一族靠 display 收起，
    // 而 .modal:not(.hidden) 这种纯选择器数法在本仓恒为 4（首跑实测），等于没量。
    // （这段注释住在模板串里，所以不许出现反引号 —— 会把串提前收尾。）
    popovers: [...document.querySelectorAll('.popover')].filter(n => n.offsetParent !== null).length,
    modals: [...document.querySelectorAll('.modal')].filter(n => n.offsetParent !== null).length,
    scrollTop: messages ? messages.scrollTop : -1,
    scrollable: messages ? (messages.scrollHeight - messages.clientHeight) : -1,
    cardCount: cards.length,
    cardKinds: cards.map(node => node.dataset.kind + '@' + node.dataset.sessionId),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-quiet-typing-'));
const home = path.join(root, 'home');
const workSeated = path.join(root, 'work-seated');
const workAsk = path.join(root, 'work-ask');
const workBoom = path.join(root, 'work-boom');
for (const dir of [home, workSeated, workAsk, workBoom]) fs.mkdirSync(dir, { recursive: true });
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
  stewardPollMs: POLL_MS,
  stewardMaxParallelThreads: 5,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A0 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A0b runtime token 可读');

  const created = {};
  for (const [key, title, cwd] of [
    ['seated', '手正在这条上打字', workSeated], ['ask', '停在待决的那条', workAsk], ['boom', '炸掉的那条', workBoom],
  ]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    // 交给管家盯 —— 不然它连 watched 都不是，不进这条推送线（§4.1 的 watched 判据）。
    await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created[key])}`, { stewardWatch: true }, token);
  }
  ok(Object.values(created).every(Boolean), `A0c 三条线程已建（${JSON.stringify(created)}）`);
  if (!Object.values(created).every(Boolean)) throw new Error('session fixtures unavailable');

  // 给「坐着的那条」攒两回合长回答：⑥ 的 scrollTop 判据要对话区真的能滚。
  for (let i = 0; i < 3; i++) {
    await request(appPort, 'POST', '/api/chat/stream', { sessionId: created.seated, message: `第 ${i + 1} 问`, cwd: workSeated }, token, 120000);
  }
  ok(Boolean(await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(created.seated)}`,
    result => (((result.json && result.json.session && result.json.session.messages) || []).length) >= 6, token)), 'A0d 「坐着的那条」有三个回合的真内容');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A0e Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  const profile = path.join(root, 'profile');
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A0f browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A0g 首屏就绪（config 到达、安静卡挂点已在 DOM 里）');

  // ── 125 治抖（40 号文 §8.4 ⓪）：视角翻转记录仪 ──────────────────────────────────────────
  // 本件在 2026-09-15 的全量里首跑红过一次：B0「切到工作台视角」明明过了，随后 B1b／B2／B2b 全红，
  // D4 明说「data-shell-mode 仍是 classic（实得 steward）」、焦点在 stewardDrawerTitle —— 也就是
  // 视角在 B0 之后【被谁翻回去了】，于是后面每一条都在错的壳里判。谁翻的、第几毫秒翻的，修前一个
  // 字都没有。装一个 MutationObserver 把每一次翻转连同当时的调用栈记下来，失败时原样打出来 ——
  // 与 124 走查④ 那次 CDP setter 探针同一个手法：先让现场自己说话，再谈修。
  await cdp.evaluate(`(() => {
    if (window.__lensFlips) return true;
    window.__lensFlips = [];
    const t0 = performance.now();
    const root = document.documentElement;
    window.__lensFlips.push({ at: 0, to: root.getAttribute('data-shell-mode') || '', note: '初始' });
    new MutationObserver(records => {
      for (const record of records) {
        if (record.attributeName !== 'data-shell-mode') continue;
        window.__lensFlips.push({ at: Math.round(performance.now() - t0), to: root.getAttribute('data-shell-mode') || '' });
      }
    }).observe(root, { attributes: true, attributeFilter: ['data-shell-mode'] });
    return true;
  })()`);
  const lensFlips = async () => {
    try { return await cdp.evaluate('JSON.stringify(window.__lensFlips || [])'); }
    catch { return '[]'; }
  };

  // 静默时段（notify-policy 默认 22:00–08:00）会让安静卡整个不出 —— 34 号文 §13.17 记过这一笔
  // （121 走查那一轮夜里跑 quiet-card.browser 12 条红就是撞了它）。先把静默窗钉到离此刻 6 小时之外。
  {
    const quietHour = (new Date().getHours() + 6) % 24;
    const pad = n => String(n).padStart(2, '0');
    await cdp.evaluate(`(() => { localStorage.setItem('wcw.notifyPolicy.v1', JSON.stringify({ version: 1, enabled: false, quietStart: '${pad(quietHour)}:00', quietEnd: '${pad(quietHour)}:01' })); return true; })()`);
  }

  // 工作台视角（安静卡只在这个视角出）。
  // 125 治抖：切过去还不算数,要它【待得住】。修前这个循环一看见属性等于目标就返回,而 config 到达
  // 之后 syncStewardShellAvailability 还会补判一次视角 —— 于是「切到工作台」过了,下一拍又被翻回管家,
  // 后面每一条都在错的壳里判(2026-09-15 全量里首跑红的就是这个形状)。改成:切到之后再盯 HOLD_MS,
  // 中途被翻走就当没切成、接着点。**这不是加 sleep 掩盖**:翻转本身仍被上面那台记录仪原样记下来,
  // 失败时连时刻一起打出来。
  const LENS_HOLD_MS = 700;
  const isLens = async lens => Boolean(await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}')()`));
  const setLens = async lens => {
    for (let i = 0; i < 40; i++) {
      if (await isLens(lens)) {
        let held = true;
        for (let waited = 0; waited < LENS_HOLD_MS; waited += 100) {
          await sleep(100);
          if (!(await isLens(lens))) { held = false; break; }
        }
        if (held) return 1;
      }
      await cdp.evaluate(`(() => { const b = document.querySelector('#lensSeg [data-lens="${lens}"]'); if (b) b.click(); return Boolean(b); })()`);
      await sleep(80);
    }
    return null;
  };
  const lensSettled = Boolean(await setLens('classic'));
  ok(lensSettled, `B0 顶栏分段钮切到工作台视角且待得住（安静卡只在这个视角出；视角变迁 ${await lensFlips()}）`);

  // 坐进「seated」那条线程（点左栏那一行 = openSession）。
  const openInWorkbench = async sessionId => {
    for (let i = 0; i < 8; i++) {
      await waitForEval(cdp, `(() => document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title') ? 1 : null)()`, 200);
      await cdp.evaluate(`(() => {
        const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title');
        if (row) row.click();
        return Boolean(row);
      })()`);
      const matched = await waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${sessionId}') ? 1 : null)()`, 100);
      if (matched) return matched;
    }
    return null;
  };
  ok(Boolean(await openInWorkbench(created.seated)), 'B1 已坐在「seated」那条线程上（安静卡的在场门①要它不是出事的那条）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const box = document.getElementById('messages');
    return box && box.scrollHeight - box.clientHeight > 200 ? 1 : null;
  })()`, 400)), 'B1b 对话区真的能滚（scrollHeight − clientHeight > 200）');

  // 现场：滚到中段、焦点落进输入框、真键入 40+ 字。
  await cdp.evaluate(`(() => {
    const box = document.getElementById('messages');
    box.scrollTop = Math.floor((box.scrollHeight - box.clientHeight) / 2);
    const input = document.getElementById('promptInput');
    if (input) input.focus();
    return true;
  })()`);
  await cdp.send('Input.insertText', { text: LONG_INPUT });
  const before = await cdp.evaluate(SCENE);
  ok(before.value === LONG_INPUT && LONG_INPUT.length >= 40,
    `B2 输入框里已经有 ${before.value ? before.value.length : 0} 字（≥40）且逐字就是我们敲进去的那段`);
  ok(before.active === 'promptInput', `B2b 焦点在输入框上（实得 ${before.active}）`);
  ok(before.scrollTop > 20, `B2c 对话区停在中段（scrollTop=${before.scrollTop}）`);
  ok(before.cardCount === 0, `B2d 此刻还没有安静卡（实得 ${before.cardCount}）`);

  /* ═════════ C：另外两条线程出事 → 安静卡弹出来 ═════════ */
  // 失败剧本与 needs_you 一起下，谁先到算谁（见文件头注）。两发都是【别处发起】的回合，
  // 浏览器没挂在它们的流上 —— 这正是管家派活的形状。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.boom, message: 'BOOMHERE 让这条炸掉', cwd: workBoom }, token, 600000);
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.ask, message: 'ask about pending', cwd: workAsk }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.ask);
  }, token)), 'C0 「ask」那条真的停在待决了（服务端事实：排除「没触发」与「触发了但没渲染」）');

  const appeared = await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && host.querySelectorAll('.quiet-card').length > 0 ? 1 : null;
  })()`, 800);
  const after = await cdp.evaluate(SCENE);
  ok(Boolean(appeared), `C1 安静卡真的弹出来了（实得 ${after.cardCount} 张：${JSON.stringify(after.cardKinds)}）`);

  /* ═════════ D：六条现场判据 —— 一件都不许变 ═════════ */
  ok(after.active === 'promptInput', `D1 焦点没被抢走：activeElement 仍是 promptInput（实得「${after.active}」）`);
  ok(after.value === LONG_INPUT, `D2 输入框逐字相等（${after.value === LONG_INPUT ? '相等' : '实得 ' + JSON.stringify(after.value)}）`);
  ok(after.selectionStart === before.selectionStart,
    `D2b 光标位置也没被动过（前 ${before.selectionStart} → 后 ${after.selectionStart}）`);
  ok(after.currentSessionId === created.seated,
    `D3 没被换会话：state.currentSession.id 仍是「seated」（实得 ${after.currentSessionId}）`);
  ok(after.mode === 'classic', `D4 没被切视角：data-shell-mode 仍是 classic（实得 ${after.mode}${after.mode === 'classic' ? '' : '；整趟视角变迁 ' + await lensFlips()}）`);
  ok(before.popovers === 0 && before.modals === 0 && after.popovers === 0 && after.modals === 0,
    `D5 没有新开的浮层／弹窗，而且【本来就一个都没开】（屏幕上可见的 popover ${before.popovers}→${after.popovers}、modal ${before.modals}→${after.modals}）`);
  ok(after.scrollTop === before.scrollTop,
    `D6 对话区没被滚走：scrollTop 前 ${before.scrollTop} → 后 ${after.scrollTop}`);

  // 再等一拍收件箱（5 s 下限），确认这六条不是「卡刚出来那一帧碰巧没事」——合并更新、第二张卡
  // 进来的时候同样不许掀桌。
  await sleep(POLL_MS + 1500);
  const later = await cdp.evaluate(SCENE);
  ok(later.active === 'promptInput' && later.value === LONG_INPUT
    && later.currentSessionId === created.seated && later.mode === 'classic'
    && later.scrollTop === before.scrollTop
    && later.popovers === 0 && later.modals === 0,
    `D7 再过一拍收件箱（现在 ${later.cardCount} 张卡：${JSON.stringify(later.cardKinds)}）六条仍全部成立`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) { try { provider.close(); } catch { /* ignore */ } }
  try { stopRuyiTestBrowsers(path.join(root, 'profile')); } catch { /* ignore */ }
}

console.log(`\nQUIET CARD TYPING BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

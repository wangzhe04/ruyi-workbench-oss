#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）

// 123 波 M2 真浏览器 E2E：安静卡的「稍后」＝真 snooze（37 号文 §3.5；判据第二条）。
//
// 修前那枚「稍后」按下去只是 removeCard()——那件事从此再也不会回来，按钮在说谎。本件钉的是
// 它现在真的排了一条：
//   A 卡出来（工作台、坐在别的线程上、静默窗避开此刻——与 quiet-card.browser 同一套前提）；
//   B 点「稍后」→ 卡收了，**并且** GET /api/scheduler/tasks 真的多出一条 once reminder，
//     payload.sourceRef 的 sessionId／kind 与那张卡逐字对得上、inboxSeq 是它来源那一行的行号；
//   C 把假时钟（WCW_SCHEDULER_CLOCK_FILE）拨过那个时点 → 卡再来一次，kind 是 reminder，
//     文案带「稍后」二字（i18n 在客户端拼，服务端只把 payload.text 原样当那句事实印出来）；
//   D 右上角「×」照旧【只收卡、不进调度器】：任务表条数一条不变。
//
// 反向（已本机独立跑一遍，先破坏 → 看真红 → 还原；不在本文件里自动做，理由同 quiet-card.browser）：
//   把 quiet-card.js 的 snooze() 里那一发 `await api(QUIET_CARD_SNOOZE_PATH, …)` 注掉、直接
//   removeCard(entry.key) —— B1 仍绿（卡确实收了），B2「任务表多出一条」当场红（实得 0 条），
//   C 组连带红（时钟拨过去也没有第二张卡）。这正是修前那个病的形状。
//
// 夹具与 quiet-card.browser.e2e.js 同一套（确定性 fake provider：'ask about X' → 一条单选待决）。
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
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const POLL_MS = 5000;          // 13i 收件箱 tick 的下限（clamp(stewardPollMs,5000,120000)）
const TICK_MS = 200;           // 调度器 tick（WCW_SCHEDULER_TICK_MS）
const SNOOZE_MINUTES = 30;     // 与 01-config 的 quietCardSnoozeMinutes 出厂值同数

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

async function startProvider(port) {
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
    const askMatch = last.role === 'user' ? String(last.content || '').match(/ask about (\w+)/) : null;
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
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的，记下了。' }, finish_reason: null }] });
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
    } catch { /* reload 会换执行上下文 */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('quietCardHost')) return null;
  return { ready: true };
})()`;

const CARDS = `(() => {
  const host = document.getElementById('quietCardHost');
  const cards = host ? [...host.querySelectorAll('.quiet-card')] : [];
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    currentSessionId: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    count: cards.length,
    cards: cards.map(node => ({
      sessionId: node.dataset.sessionId,
      kind: node.dataset.kind,
      line: (node.querySelector('.quiet-card-line') || {}).textContent || '',
      hasLater: Boolean(node.querySelector('.quiet-card-btn-later')),
      hasGo: Boolean(node.querySelector('.quiet-card-btn-go')),
    })),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-quiet-snooze-'));
const home = path.join(root, 'home');
const workSeated = path.join(root, 'work-seated');
const workOther = path.join(root, 'work-other');
const clockFile = path.join(root, 'clock.txt');
for (const dir of [home, workSeated, workOther]) fs.mkdirSync(dir, { recursive: true });
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
// 假时钟从【真实此刻】起步：安静卡那一头按浏览器的真时间算「30 分钟后是几点几分」（本地墙钟），
// 调度器这一头按时钟文件判「到点没有」。两头同源起步，之后只有这里往前拨。
const setClock = ms => fs.writeFileSync(clockFile, String(Math.round(ms)), 'utf8');
setClock(Date.now());

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
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  schedulerEnabledV1: true,
  quietCardSnoozeMinutes: SNOOZE_MINUTES,
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
    env: {
      ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home,
      WCW_SCHEDULER_CLOCK_FILE: clockFile, WCW_SCHEDULER_TICK_MS: String(TICK_MS),
    },
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
  for (const [key, title, cwd] of [['seated', '坐着的那条', workSeated], ['other', '别的线程', workOther]]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created[key])}`, { stewardWatch: true }, token);
  }
  ok(Object.values(created).every(Boolean), `A0c 两条线程已建（${JSON.stringify(created)}）`);
  if (!Object.values(created).every(Boolean)) throw new Error('session fixtures unavailable');

  const listTasks = async () => {
    const result = await request(appPort, 'GET', '/api/scheduler/tasks', null, token);
    return (result && result.json && Array.isArray(result.json.tasks)) ? result.json.tasks : [];
  };
  ok((await listTasks()).length === 0, 'A0c2 起点：定时任务表是空的');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A0d Edge/Chrome found');
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
  ok(Boolean(target), 'A0e browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A0f 首屏就绪（config 到达、安静卡挂点已在 DOM 里）');

  const setLens = async lens => {
    for (let i = 0; i < 40; i++) {
      if (await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}')()`)) return 1;
      await cdp.evaluate(`(() => { const b = document.querySelector('#lensSeg [data-lens="${lens}"]'); if (b) b.click(); return Boolean(b); })()`);
      await sleep(80);
    }
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}' ? 1 : null)()`);
  };
  const openInWorkbench = async sessionId => {
    for (let i = 0; i < 5; i++) {
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
  const snapCards = () => cdp.evaluate(CARDS);

  await waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null)()`, 40);
  await sleep(300);
  ok(Boolean(await setLens('classic')), 'A0g 顶栏分段钮切到工作台视角（后续断言的前提）');
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 2 ? 1 : null)()`)),
    'A0h 左栏两条线程都已渲染');
  // 34 号文 §13.17：notify-policy 的默认静默窗是 22:00–08:00，本件量的是「该出卡时出不出」，
  // 先把静默窗钉到离此刻 6 小时之外的一分钟（与 quiet-card.browser 同一手法）。
  {
    const quietHour = (new Date().getHours() + 6) % 24;
    const pad = n => String(n).padStart(2, '0');
    await cdp.evaluate(`(() => { localStorage.setItem('wcw.notifyPolicy.v1', JSON.stringify({ version: 1, enabled: false, quietStart: '${pad(quietHour)}:00', quietEnd: '${pad(quietHour)}:01' })); return true; })()`);
  }

  /* ═════════ A 卡出来 ═════════ */
  ok(Boolean(await openInWorkbench(created.seated)), 'A1 坐在「seated」那条线程上（安静卡只对【别的】线程出）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.other, message: 'ask about other', cwd: workOther }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.other);
  }, token)), 'A2 线程「other」真的停在待决了（服务端事实）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && host.querySelector('.quiet-card[data-session-id="${created.other}"] .quiet-card-btn-later') ? 1 : null;
  })()`)), 'A3 安静卡出来了，且卡上有「稍后」那枚按钮');

  /* ═════════ B 点「稍后」→ 卡收了 + 表里多一条 once reminder ═════════ */
  const clickedAt = Date.now();
  await cdp.evaluate(`(() => {
    const node = document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"] .quiet-card-btn-later');
    if (node) node.click();
    return Boolean(node);
  })()`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && !host.querySelector('.quiet-card[data-session-id="${created.other}"]') ? 1 : null;
  })()`, 200)), 'B1 卡收了（**成功才收卡**：建不成的话它会留在原地并 toast 一句）');
  const afterSnooze = await waitForHttp(appPort, 'GET', '/api/scheduler/tasks', result => {
    const tasks = (result.json && result.json.tasks) || [];
    return tasks.length === 1;
  }, token, 100);
  const tasks = (afterSnooze && afterSnooze.json && afterSnooze.json.tasks) || [];
  ok(tasks.length === 1, `B2 定时任务表真的多出一条（实得 ${tasks.length} 条）—— 修前这里恒是 0`);
  const task = tasks[0] || {};
  ok(task.schedule && task.schedule.kind === 'once', `B3 它是一条 once（实得 ${task.schedule && task.schedule.kind}）`);
  ok(task.payload && task.payload.kind === 'reminder', `B4 载荷是 reminder（不调模型、永远安全；实得 ${task.payload && task.payload.kind}）`);
  const ref = (task.payload && task.payload.sourceRef) || {};
  ok(ref.sessionId === created.other, `B5 sourceRef.sessionId 指回那张卡的线程（实得 ${ref.sessionId}）`);
  ok(ref.kind === 'needs_you', `B6 sourceRef.kind 指回那张卡的类别（实得 ${ref.kind}）`);
  ok(Number(ref.inboxSeq) > 0, `B7 sourceRef.inboxSeq 指回它来源的那一行收件箱（实得 ${ref.inboxSeq}）`);
  // 到点时刻 = 点下去那一刻 + 30 分钟（分钟粒度，所以允许 ±1 分钟）。
  const dueMs = Date.parse(String(task.nextRunAt || ''));
  const wantMs = clickedAt + SNOOZE_MINUTES * 60000;
  ok(Number.isFinite(dueMs) && Math.abs(dueMs - wantMs) <= 61000,
    `B8 下次触发是 ${SNOOZE_MINUTES} 分钟之后（实得 ${task.nextRunAt}，期望约 ${new Date(wantMs).toISOString()}）`);

  /* ═════════ C 拨过时钟 → 卡再来一次，且文案带「稍后」 ═════════ */
  setClock(wantMs + 90000);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && host.querySelector('.quiet-card[data-kind="reminder"]') ? 1 : null;
  })()`, 400)), 'C1 假时钟拨过那个时点之后，安静卡再来一次（kind 是新类 reminder）');
  const back = await snapCards();
  const card = back.cards.find(c => c.kind === 'reminder') || {};
  ok(String(card.line || '').includes('稍后'),
    `C2 卡上那句话带「稍后」（实得「${card.line}」）`);
  ok(card.sessionId === created.other,
    `C3 它仍然指着原来那条线程（sourceRef 一路带过来的；实得 ${card.sessionId}）`);
  ok(card.hasGo === true, 'C4 有线程可看，所以「去看」这枚按钮在（不属于任何线程的提醒才不画它）');

  /* ═════════ D 「×」只收卡、不进调度器 ═════════ */
  const before = (await listTasks()).length;
  await cdp.evaluate(`(() => {
    const node = document.querySelector('#quietCardHost .quiet-card[data-kind="reminder"] .quiet-card-close');
    if (node) node.click();
    return Boolean(node);
  })()`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && !host.querySelector('.quiet-card[data-kind="reminder"]') ? 1 : null;
  })()`, 200)), 'D1 「×」把卡收了');
  await sleep(600);
  const afterClose = (await listTasks()).length;
  ok(afterClose === before, `D2 「×」不进调度器：任务表条数一条不变（前 ${before} 后 ${afterClose}）`);

  const shot = path.join(shotDir, 'quiet-card-snooze-final.png');
  fs.writeFileSync(shot, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(`SHOT ${shot}`);
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

console.log(`\nQUIET CARD SNOOZE BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';

// 真实浏览器 E2E(第 117 波 117s-G · 27 号文 §11.13.1 ②):
// **管家开的线程正在跑的时候,在【工作台视角】里说话不许把那个回合杀掉。**
//
// 修前(HEAD 97d072c 两次复现、字节相同):经典壳的发送门只认 `activeTurns`(本页自己起的那条流),
// 管家经 stewardLaunchTurn 在服务端起的回合不在里面 —— 于是按发送走的是「新回合」那条路,
// 09-workflow:1347 的 `if (activeChildren.has) stopSession('superseded')` 把跑着的回合就地杀掉:
// `turn_start seq=1 → turn_kill reason:'superseded' → turn_start seq=2`,第一回合只剩用户消息、
// 界面零提示。按钮那时还写着「发送」(updateSendBtn 读 state.streaming,同一个盲区)。
//
// 覆盖(H 段;服务端那一半在 foreign-turn-busy-guard.e2e.js):
//   H1  管家 steward_thread_new 开一条线程,回合在服务端跑起来(fake provider 挂住 ~25s)。
//   H2  焦点栏「在工作台打开」把工作台视角按这条线程打开,「它正在跑(这一回合是在别处起的)」那张卡在屏上。
//   H3  打一句话之后,发送键写的是【插话】而不是【发送】(updateSendBtn 读服务端下发的 relay)。
//   H4  点下去走的是插话那条路:审计里有 intervention/steer;**零 turn_kill**;
//       上游 provider 的那一发请求**没有被中止**(fake provider 自己记着 aborted 次数)。
//   H5  回合自己跑到收尾,插话作为一条 steered 用户消息落盘,并被模型收下(助手正文里带着它)。
//   H6  屏幕上看得到那句插话。
//   H7  回合结束之后再打一句:relay 键没了 → 按钮回到【发送】→ 点下去正常起一个【新】回合。
//
// 夹具与 workbench-thread-head.browser.e2e.js 同一套 CDP 无头驱动;temp HOME、fake provider、
// fake 管家动作面。(121-K5:原来那句写的是 steward-classic-window.e2e.js —— 那枚按钮与它的返回带
// 已整段退役,那一件随之退役。121-K8:注释与断言里的「2.0 视窗」措辞已改成「工作台视角」/
// 「在工作台打开」;**文件名不动** —— 改名会牵连 run-all 的超时表与 route-inventory 产物,
// 那是另一刀的账,不该混在一次措辞清理里。)
// 判定行:`CLASSIC WINDOW LIVE STEER E2E: ALL PASS`。
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
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '管家派出去的活';
const STEER_TEXT = '顺手把编号 QX7 也带上';
// 第一发 provider 请求挂住多久 —— 浏览器要在这段时间里开窗、打字、按下发送。
const SLOW_MS = 25000;

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

// ── fake provider ────────────────────────────────────────────────────────────────────────────
// 管家线程:结构化契约 JSON。线程回合:
//   第一发(还没有 tool 消息、正文里带 SLOW)→ 先流一段,挂住 SLOW_MS,再要一次 file_read
//     —— 要一次工具是为了让回合有【第二次模型调用】:provider 引擎的插话就是在迭代边界 drain 的,
//        单次调用的回合里插话永远进不去,那测的就不是这条路。
//   其余 → 一句话就收,并把最后一条 user 原样回读(插话有没有真进模型,看这句就知道)。
let providerAborted = 0;
let providerCalls = 0;
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    const isSteward = /我是如意/.test(sys);
    const users = messages.filter(m => m && m.role === 'user').map(m => String(m.content || ''));
    const lastUser = users.length ? users[users.length - 1] : '';
    const hasToolMsg = messages.some(m => m && m.role === 'tool');
    providerCalls += 1;
    // 「上游把这一发掐了」的判据用 res 的 close:请求体早就读完了,'aborted' 不会再响;
    // 回合被 stopSession 杀掉时断的是【响应】那一端,只有 res 的 close 抓得住(反向验证时实测)。
    let aborted = false;
    let finished = false;
    res.on('close', () => { if (!finished) { aborted = true; providerAborted += 1; } });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const done = () => { finished = true; try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (!hasToolMsg && /SLOW/.test(lastUser)) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '我开始看这件事了' }, finish_reason: null }] });
      await sleep(SLOW_MS);
      if (aborted) return;
      const args = JSON.stringify({ path: 'probe.txt' });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '回答完毕:' + String(lastUser).slice(0, 60) }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
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
  for (let i = 0; i < 300; i++) {
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
    } catch { /* reload swaps execution context */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  const select = document.getElementById('cfgShellMode');
  if (!select || typeof select.onchange !== 'function') return null;
  // 121-K5：就绪判据从退役的返回带（#stewardReturnBand）换成线程头（#threadHead）——
  // 两者都是「经典壳这一侧的骨架已经画完了」的同一个信号，本件测的东西一个字没变。
  if (!document.getElementById('threadHead') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

const VIEW = `(() => {
  const btn = document.getElementById('sendBtn');
  const relay = (window.state && window.state.sessionRelay) || null;
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    sessionId: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    sendLabel: btn ? btn.textContent.trim() : '',
    relayChannel: relay ? String(relay.channel || '') : '',
    relaySession: relay ? String(relay.sessionId || '') : '',
    liveCard: !!document.querySelector('#messages [data-live="1"]'),
    messagesText: (document.getElementById('messages') || {}).textContent || '',
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-steer-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'probe.txt'), 'probe-ok\n', 'utf8');
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
  killOnDisconnect: false,
  subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: 120000,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  stewardProviderId: 'fake',
  stewardModel: 'fake-model',
  stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500,
  stewardGlobalMaxTurnsPerHour: 2000,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

const logsDir = path.join(home, 'logs');
const sessionsDir = path.join(home, 'sessions');
function auditRows() {
  const out = [];
  for (const f of (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}
const sessionMessages = id => {
  try {
    return fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8').split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

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
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');
  // 管家线程(建它的唯一合法方式)。
  await request(appPort, 'POST', '/api/steward/message', { message: '现在什么情况' }, token);

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
  ok(Boolean(await waitForEval(cdp, READY)), 'A5 应用就绪');
  // 先把浏览器备好再开线程 —— 那个回合只挂 25 秒,别把它耗在冷启动上。
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward'`);

  /* ═════════ H1 管家开一条线程,回合在服务端跑起来 ═════════ */
  const created = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: THREAD_TITLE, cwd: home, brief: { userText: 'SLOW 把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  const sessionId = created && created.json && created.json.result && created.json.result.sessionId;
  ok(Boolean(sessionId), `H1a 管家 steward_thread_new 开出线程(${sessionId || '失败'})`);
  if (!sessionId) throw new Error('steward thread fixture unavailable');
  const liveEnv = await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`,
    r => !!(r.json && r.json.resumable && r.json.resumable.live === true), token);
  ok(Boolean(liveEnv), 'H1b 那个回合在服务端跑起来了(信封 resumable.live === true)');
  ok(Boolean(liveEnv && liveEnv.json && liveEnv.json.relay && liveEnv.json.relay.channel === 'steer'),
    `H1c 信封带出 relay.channel === 'steer'(13h 那条递话阶梯的原判;实测 ${JSON.stringify(liveEnv && liveEnv.json && liveEnv.json.relay)})`);

  /* ═════════ H2 焦点栏 →「在工作台打开」═════════ */
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:open-thread', { detail: { sessionId: '${sessionId}' } })), true`);
  ok(Boolean(await waitForEval(cdp, `document.getElementById('stewardDrawer') && document.getElementById('stewardDrawer').hidden === false`)),
    'H2a 抽屉按这条线程打开');
  await cdp.evaluate(`document.getElementById('stewardDrawerClassicBtn').click(), true`);
  const inClassic = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.mode === 'classic' && view.sessionId === ${JSON.stringify(sessionId)} && view.liveCard ? view : null;
  })()`);
  ok(Boolean(inClassic), 'H2b 工作台视角按这条线程打开,「它正在跑(这一回合是在别处起的)」那张卡在屏上');
  ok(Boolean(inClassic && inClassic.relayChannel === 'steer' && inClassic.relaySession === sessionId),
    `H2c 前端把服务端那条判定收下了(实测 ${inClassic && inClassic.relayChannel}/${inClassic && inClassic.relaySession})`);

  /* ═════════ H3 打字之后按钮写「插话」═════════ */
  await cdp.evaluate(`(() => {
    const ta = document.getElementById('promptInput');
    ta.value = ${JSON.stringify(STEER_TEXT)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const typed = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.sendLabel ? view : null;
  })()`);
  ok(Boolean(typed && typed.sendLabel.includes(zh['chat.steer'])),
    `H3 按下之前按钮写的是「${zh['chat.steer']}」而不是「${zh['chat.send']}」(实测「${typed && typed.sendLabel}」)`);

  /* ═════════ H4 点下去:走插话,不杀回合 ═════════ */
  const killsBefore = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sessionId).length;
  const abortedBefore = providerAborted;
  await cdp.evaluate(`document.getElementById('sendBtn').click(), true`);
  let steerLogged = null;
  for (let i = 0; i < 200; i++) {
    steerLogged = auditRows().find(r => r && r.kind === 'intervention' && r.source === 'steer' && r.sessionId === sessionId);
    if (steerLogged) break;
    await sleep(100);
  }
  ok(Boolean(steerLogged), 'H4a 这一发走的是插话那条路(审计 intervention/source:steer)');
  const killsAfter = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sessionId);
  ok(killsAfter.length === killsBefore,
    `H4b 零 turn_kill —— 那个回合没有被 supersede 掉(实测 ${JSON.stringify(killsAfter.map(k => k.reason))})`);
  ok(providerAborted === abortedBefore,
    `H4c 上游 provider 的那一发请求没有被中止(aborted ${abortedBefore} → ${providerAborted})`);

  /* ═════════ H5/H6 回合跑完,插话进了正文也进了模型,屏幕上看得见 ═════════ */
  const ended = await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(sessionId)}`,
    r => !!(r.json && r.json.ok && !(r.json.resumable && r.json.resumable.live === true)), token, 600);
  ok(Boolean(ended), 'H5a 那个回合自己跑到收尾(没有被打断)');
  // 「不在 activeChildren 里了」比「收尾那一次 saveSession 落了盘」早一点点(实测抓到过一次),
  // 所以这里再等一拍落盘,别拿半截文件去断言。
  let msgs = [];
  for (let i = 0; i < 200; i++) {
    msgs = sessionMessages(sessionId);
    if (msgs.some(m => m && m.role === 'assistant' && String(m.content || '').includes(STEER_TEXT))) break;
    await sleep(100);
  }
  ok(msgs.some(m => m && m.role === 'user' && m.steered === true && String(m.content || '').includes(STEER_TEXT)),
    `H5b 插话作为一条 steered 用户消息落盘(实测 ${JSON.stringify(msgs.filter(m => m && m.steered).map(m => m.content))})`);
  ok(msgs.some(m => m && m.role === 'assistant' && String(m.content || '').includes(STEER_TEXT)),
    `H5c 插话真的进了模型(fake provider 把最后一条 user 原样回读进助手正文;实测 ${JSON.stringify(msgs.filter(m => m && m.role === 'assistant').map(m => String(m.content || '').slice(0, 100)))})`);
  ok(auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sessionId).length === 0,
    'H5d 全程零 turn_kill(修前这里是 reason:"superseded")');
  const painted = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.messagesText.includes(${JSON.stringify(STEER_TEXT)}) ? view : null;
  })()`);
  ok(Boolean(painted), 'H6 屏幕上看得到那句插话');

  /* ═════════ H7 收工之后再说一句:回到「发送」,正常起新回合 ═════════ */
  const idle = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return (!view.liveCard && view.relayChannel === '') ? view : null;
  })()`);
  ok(Boolean(idle), 'H7a 回合结束后活回合卡收起、relay 键也没了(服务端说空闲)');
  await cdp.evaluate(`(() => {
    const ta = document.getElementById('promptInput');
    ta.value = '收工之后再问一句 ZZ9';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const idleTyped = await cdp.evaluate(VIEW);
  ok(Boolean(idleTyped && idleTyped.sendLabel.includes(zh['chat.send'])),
    `H7b 空闲线程上按钮回到「${zh['chat.send']}」(实测「${idleTyped && idleTyped.sendLabel}」)`);
  const seqBefore = msgs.filter(m => m && m.role === 'user' && m.steered !== true).length;
  await cdp.evaluate(`document.getElementById('sendBtn').click(), true`);
  let after = [];
  for (let i = 0; i < 300; i++) {
    after = sessionMessages(sessionId);
    if (after.filter(m => m && m.role === 'user' && m.steered !== true).length > seqBefore
      && after.some(m => m && m.role === 'assistant' && /ZZ9/.test(String(m.content || '')))) break;
    await sleep(100);
  }
  ok(after.filter(m => m && m.role === 'user' && m.steered !== true).length > seqBefore
    && after.some(m => m && m.role === 'assistant' && /ZZ9/.test(String(m.content || ''))),
    'H7c 空闲时照旧起一个【新回合】(这条路一个字没改)');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp && fail) console.log('CONSOLE ' + cdp.logs.slice(-8).join(' | '));
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nCLASSIC WINDOW LIVE STEER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

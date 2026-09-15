#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 真实浏览器 E2E（第 121 波 K6b · 34 号文 §2.6／§5／§2.4／§13.3 ①）：管家视角的【焦点栏】。
//
// K4 把 #stewardDrawer 那个节点搬进了外框栅格的右栏；K6b 把它的【内容】改成焦点卡：
// 卡头 → 元信息一行 → 按五态一段 → 动作行三档。本件证明的是那些「按五态一段」与「四面同色」
// 在真浏览器里【真的成立】，而不是静态锁读出来的字面量。
//
//   B 焦点选择真值表（等你 ＞ 在跑 ＞ 失败 ＞ 最近动静）：纯函数一份 ＋ 真页面一条
//     （纯函数 focusThreadFor 住 steward-board.js，unit/steward-focus-thread.test.js 已经跑过真值表；
//      这里在【页面里】再问它一次是为了证明页面加载的就是那一份，然后再看真行真的落到那一条）
//   C 五态各一段各一断言：
//     C1 等你 → 「它在问你」callout ＋ 候选答案按钮，点一枚 → 服务端那条 pending 真的消失
//     C2 在跑 → 「它正在说」＋ 当前动作行格式 `工具 · 第 N 次调用 · N 秒前有输出`；
//               底部那句提示换成「递给它一句」，递过去的话走 relay 的 steer 通道
//     C3 排队 → 「在等什么」那一段出现（并发上限压到 1，第二条线程只能排队），两枚按钮都在
//     C4 收工 → 「它最后说」＋ 底部提示换成「接着说」
//   D thread.live 帧 → DOM 更新 ≤100 ms（帧的时刻由一条并行 Node SSE 客户端给，同机同钟）
//   E openThread 不抢输入区焦点（§13.7 ⑨）：光标在管家输入框里时，推送换焦点后 activeElement 不变
//   F 四面 data-thread-hue 相同（对话流卡头／焦点卡／左栏行／左栏看板密度行），
//     且同一任务的两条线程同色（§5：色号按任务，线程继承任务色）
//   G dispatchAcceptanceMilestones 接线（§13.3 ①）：管家开出一条新线程之后，那条线程的
//     /api/mission 里 milestones 非空（反向：注释掉 ensureAcceptanceLedger 那一句 → 本组红）
//
// 夹具与 event-stream-client.browser.e2e.js 同一套（temp HOME ＋ 假 OpenAI 兼容 provider ＋
// 无头 Edge/Chrome 的 CDP）。判定行：`FOCUS RAIL BROWSER E2E: ALL PASS`。
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
const PUBLIC = path.join(WB, 'app', 'public');
const zh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const ASK_TITLE = '等你回答的那条';
const RUN_TITLE = '一直在跑的那条';
const DONE_TITLE = '已经收工的那条';
const QUEUE_TITLE = '排在后面的那条';
const LEDGER_TITLE = '管家新开的那条';
const LEDGER_PROMPT = 'OPENTHREAD 帮我盯一下';
const HANG_MS = 180000;         // 「HANGHERE」那一支挂多久（C2/C3/D/E 都要一个一直活着的回合）
const LIVE_PUSH_BUDGET_MS = 100; // §9 K6b 验收：thread.live → DOM ≤100 ms

function request(port, method, pathname, body, token, timeoutMs) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: timeoutMs || 30000,
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

// ── 并行 Node SSE 客户端：【服务端时刻】的唯一来源（与 K2b 那一件逐字同源的读法）──────────
function openStream(port, token) {
  const frames = [];
  const state = { frames, closed: false, status: 0, req: null };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events/stream', method: 'GET',
      headers: { ...(token ? { 'x-wcw-token': token } : {}) },
    }, response => {
      state.status = response.statusCode;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        const at = Date.now();
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!block.trim() || block.startsWith(':')) continue;
          const frame = { id: 0, event: '', data: null, at };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { frame.data = JSON.parse(line.slice(6)); } catch { frame.data = null; } }
          }
          frames.push(frame);
        }
      });
      response.on('end', () => { state.closed = true; });
      resolve(state);
    });
    req.on('error', () => { state.closed = true; resolve(state); });
    state.req = req;
    req.end();
  });
  state.close = () => { try { state.req.destroy(); } catch { /* already gone */ } state.closed = true; };
  return state;
}
async function waitForFrame(stream, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = stream.frames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(20);
  }
}
const serverAtOf = frame => Date.parse((frame && frame.data && frame.data.at) || '');

// ── fake provider ────────────────────────────────────────────────────────────
//   管家会话：默认一句收；带 OPENTHREAD 的那一发在契约里写一条【真的 steward_thread_new】——
//            服务端 13p stewardExecuteActions 会拿 args 去跑它，回执里的 sessionId 是真开出来的
//            那条线程。G 组要的正是前端那条「回合真开出线程 → 立账本」的接线
//            （executedThreadSessionId 只认 result.ok===true 的那几个开线程工具）。
//   线程带 HANGHERE：先攒一段字，静一下再要一次 file_read（>500 ms 的空窗是 thread.live
//            节流表要的），随后挂住持续吐字 —— C2/C3/D/E 要一个一直活着的回合。
//   线程带 ASKME：request_user_input（注册 pending question ＝「等你」）。
//   其余：一句话收工。
let probeFile = '';
let ledgerWork = '';
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
    const lastUser = [...messages].reverse().find(m => m && m.role === 'user');
    const userText = String((lastUser && lastUser.content) || '');
    const toolMsgs = messages.filter(m => m && m.role === 'tool').map(m => String(m.content || ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const delta = text => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      const opening = /OPENTHREAD/.test(userText);
      // actions 是【真执行】的（13p stewardExecuteActions 拿 args 去调 13k），不是回执占位：
      // 第一版只写了 result 没写 args，服务端照样去跑 steward_thread_new，缺 brief.userText 直接
      // invalid_request，前端那条判据（只认 ok===true）于是恒空 —— G 组白等（实测）。
      const contract = {
        say: opening ? '开好了，它这就去办。' : '看过了。',
        why: '总览',
        acts: [],
        actions: opening
          // 刻意【不传 cwd】：117w-W1 的三态里第 ② 态（省略 → 在 Ruyi 根下派生子工作区）。
          // 传 root/work-ledger 那种 defaultWorkspace 之外的目录会被 stewardValidateCwd 判
          // invalid_request（实测：※ 回执写着「新开线程 —— invalid_request」，线程一条没开出来）。
          ? [{ tool: 'steward_thread_new', args: { title: LEDGER_TITLE, brief: { userText: LEDGER_PROMPT } } }]
          : [],
      };
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(contract) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (/ASKME/.test(userText) && !toolMsgs.length) {
      const args = JSON.stringify({ questions: [{ header: '框架', question: '用哪个框架?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_q1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    if (/HANGHERE/.test(userText)) {
      if (!toolMsgs.length) {
        for (let i = 0; i < 6; i++) { delta(`第${i + 1}段：我在看这件事。`); await sleep(300); }
        await sleep(900);   // >500 ms 空窗：带工具名那一帧才过得了 thread.live 的节流
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: probeFile }) } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        return done();
      }
      const rounds = Math.round(HANG_MS / 2500);
      for (let i = 0; i < rounds; i++) { delta(`挂着的第${i + 1}段：它还在一行行地往下说。`); await sleep(2500); }
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    delta('收工了，结论在这儿。');
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

// 焦点卡的快照：只读 DOM（textContent／dataset／hidden），不碰任何模块私有状态。
const CARD = `(() => {
  const text = id => { const node = document.getElementById(id); return node ? String(node.textContent || '').trim() : ''; };
  const shown = id => { const node = document.getElementById(id); return Boolean(node) && node.hidden === false; };
  const head = document.getElementById('stewardDrawerHead');
  return {
    focusId: (document.getElementById('stewardSide') || { dataset: {} }).dataset.focusId || '',
    hue: head ? (head.dataset.threadHue || '') : '',
    title: text('stewardDrawerTitle'),
    crumb: text('stewardDrawerCrumb'),
    crumbShown: shown('stewardDrawerCrumb'),
    state: (document.getElementById('stewardDrawerState') || { dataset: {} }).dataset.state || '',
    ago: text('stewardDrawerAgo'),
    originShown: shown('stewardDrawerOrigin'),
    askShown: shown('stewardDrawerAsk'),
    askText: text('stewardDrawerAskText'),
    askOptions: [...document.querySelectorAll('#stewardDrawerAskOptions .steward-drawer-reply')].map(node => node.textContent.trim()),
    lastSayHead: text('stewardDrawerLastSayHead'),
    lastSay: text('stewardDrawerLastSayText'),
    acting: text('stewardDrawerActing'),
    actingShown: shown('stewardDrawerActing'),
    actingMono: (() => {
      const node = document.getElementById('stewardDrawerActing');
      return node ? String(getComputedStyle(node).fontFamily || '') : '';
    })(),
    queueShown: shown('stewardDrawerQueue'),
    wait: text('stewardDrawerWait'),
    jump: Boolean(document.getElementById('stewardDrawerJumpBtn')),
    max: Boolean(document.getElementById('stewardDrawerMaxBtn')),
    composerLabel: text('stewardDrawerComposerLabel'),
    primary: [...document.querySelectorAll('#stewardDrawerFoot .steward-drawer-btn.is-primary')].map(node => node.id),
    costNodes: document.querySelectorAll('#stewardDrawerMissionCost').length,
    activeId: document.activeElement ? (document.activeElement.id || '') : '',
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-focus-rail-'));
// 三张 1920 实拍（等你／在跑／收工）—— 交付报告要，也是「按五态一段」在屏幕上真的分得开的凭据。
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
const shots = {};
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
// 每条线程一个工作区：同一个 cwd 会被工作区写锁串起来，那不是「排队」而是「撞锁」，
// C3 要量的是并发位（arbiter），两者的 wait.reason 不是一回事。
const askWork = path.join(root, 'work-ask');
const runWork = path.join(root, 'work-run');
const doneWork = path.join(root, 'work-done');
const queueWork = path.join(root, 'work-queue');
ledgerWork = path.join(root, 'work-ledger');
for (const dir of [askWork, runWork, doneWork, queueWork, ledgerWork]) fs.mkdirSync(dir);
probeFile = path.join(home, 'probe.txt');
fs.writeFileSync(probeFile, '现场看过了。\n', 'utf8');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: home, includeWorkbenchMcp: false, killOnDisconnect: false,
  autoImportClaudeCodeMcp: false, subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: 15000,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  // C3「排队」要的就是这个 1：并发位只有一个，第二条线程只能等（§8.10 的可解释排队）。
  stewardMaxParallelThreads: 1,
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
let stream = null;
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

  stream = openStream(appPort, token);
  await stream.ready;
  ok(stream.status === 200, `A3 并行 Node SSE 客户端连上（服务端时刻的来源；实得 ${stream.status}）`);

  // ── 四条线程：等你／在跑／收工／排队，外加 G 组那条「管家开出来的」──────────────────
  const make = async (title, cwd) => {
    const made = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    const id = (made && made.json && made.json.session && made.json.session.id) || '';
    if (id) await request(appPort, 'POST', '/api/mission', { sessionId: id, action: 'start', goal: title, milestones: [{ id: 'm1', desc: '做完' }] }, token);
    return id;
  };
  const askId = await make(ASK_TITLE, askWork);
  const runId = await make(RUN_TITLE, runWork);
  const doneId = await make(DONE_TITLE, doneWork);
  const queueId = await make(QUEUE_TITLE, queueWork);
  // G 组那一条【由管家在 F/G 那一段真开出来】——本件要证的正是「前端在管家开出线程之后把
  // 账本立起来」，所以它不能是这里预先建好的。
  ok(Boolean(askId && runId && doneId && queueId),
    `A4 四条线程已建（${askId} / ${runId} / ${doneId} / ${queueId}）`);
  if (!askId || !runId || !doneId || !queueId) throw new Error('session fixtures unavailable');

  // 收工那条先跑完一个回合（它得真的「说过话」，收工那一段才有「它最后说」可印）。
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: doneId, message: '说一句就好', cwd: doneWork }, token);
  const doneSettled = await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(doneId)}`, result => {
    const messages = (result.json && result.json.session && result.json.session.messages) || [];
    return messages.some(m => m && m.role === 'assistant' && String(m.content || '').includes('收工了'));
  }, token);
  ok(Boolean(doneSettled), 'A5 收工那条真的跑完了一个回合（「它最后说」有话可印）');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A6 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1920,1080',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A7 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // D 组的仪器：一枚 MutationObserver 在「它正在说」那一行真的变了的【当拍】记时刻。
  // 装在预绘之前 —— 回头再去问是量探询间隔，不是量延迟。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__ruyiLiveMark = 0;
      window.__ruyiLiveWatch = '';
      // G 组的仪器：前端往 /api/mission 发过什么（立账本那一发是 fire-and-forget，
      // 失败也不冒红字，所以必须自己看得见）。
      window.__ruyiMissionCalls = [];
      const rawFetch = window.fetch;
      window.fetch = function (input, init) {
        try {
          const url = String((input && input.url) || input || '');
          if (url.indexOf('/api/mission') >= 0) {
            window.__ruyiMissionCalls.push([(init && init.method) || 'GET', url, String((init && init.body) || '').slice(0, 120)]);
          }
        } catch { /* ignore */ }
        return rawFetch.apply(this, arguments);
      };
      // 当前动作行的【三节形态】只在 tool_use 与 tool_result 之间那一小段成立（04 的累加器在
      // tool_result 上把 tail.tool 清空），本地文件读几毫秒就回来了 —— 回头去问必然扑空。
      // 所以由页面自己在【它真的三节】的那一拍把它抄下来，测试只取这份记录。
      window.__ruyiActing3 = '';
      const tick = () => {
        const acting = document.getElementById('stewardDrawerActing');
        if (acting && !window.__ruyiActing3) {
          const line = String(acting.textContent || '').trim();
          if (line.split(' · ').length === 3) window.__ruyiActing3 = line;
        }
        if (!window.__ruyiLiveWatch || window.__ruyiLiveMark) return;
        const node = document.getElementById('stewardDrawerLastSayText');
        if (node && String(node.textContent || '').indexOf(window.__ruyiLiveWatch) >= 0) window.__ruyiLiveMark = Date.now();
      };
      const start = () => {
        try { new MutationObserver(tick).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true }); }
        catch { /* 老浏览器 */ }
      };
      if (document.documentElement) start();
      else document.addEventListener('DOMContentLoaded', start, { once: true });
    })();`,
  });
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'A8 管家视角就绪');

  /* ═════════ B 焦点选择真值表 ═════════ */
  // 纯函数那一份：页面加载的就是 steward-board.js 那一个 focusThreadFor（真值表 unit 已跑过，
  // 这里只证「页面用的是它」并把三条优先级各走一遍）。
  //
  // 124 走查（用户 2026-09-15 拍板）：第三档从「已停工」改成「最近发生的那一件」——
  // 修前 stopped 没有时效尺，一条昨天停工的线程永远赢过今天刚做完的，右栏于是被钉在旧线程上。
  // 下面 stoppedLoses 那一条就是翻过来的那条（C 停工 2030 / D 做完 2031 → 挑 D），
  // 另加 stoppedWinsWhenNewest 作反向保护：停工【就是】最近那一件时它照样该被挑中。
  const truth = await cdp.evaluate(`(async () => {
    const board = await import('/js/steward-board.js');
    const pick = rows => { const hit = board.focusThreadFor(rows); return hit ? hit.sessionId : ''; };
    const A = { sessionId: 'a', state: 'needs_you', updatedAt: '2020-01-01T00:00:00.000Z' };
    const B = { sessionId: 'b', state: 'running', updatedAt: '2030-01-01T00:00:00.000Z' };
    const C = { sessionId: 'c', state: 'stopped', updatedAt: '2030-01-01T00:00:00.000Z' };
    const D = { sessionId: 'd', state: 'done', updatedAt: '2031-01-01T00:00:00.000Z' };
    return {
      needsYouWins: pick([D, C, B, A]),
      runningNext: pick([D, C, B]),
      stoppedLoses: pick([D, C]),
      stoppedWinsWhenNewest: pick([{ sessionId: 'f', state: 'done', updatedAt: '2029-01-01T00:00:00.000Z' }, C]),
      newestLast: pick([{ sessionId: 'e', state: 'done', updatedAt: '2029-01-01T00:00:00.000Z' }, D]),
      empty: pick([]),
    };
  })()`);
  ok(Boolean(truth) && truth.needsYouWins === 'a' && truth.runningNext === 'b'
    && truth.stoppedLoses === 'd' && truth.stoppedWinsWhenNewest === 'c'
    && truth.newestLast === 'd' && truth.empty === '',
    `B1 焦点真值表（等你 ＞ 在跑 ＞ 最近发生的那一件）在页面加载的那一份 focusThreadFor 上成立（实测 ${JSON.stringify(truth)}）`);

  // 真页面那一条：等你的那条线程一出现，焦点栏就落到它身上。
  await request(appPort, 'POST', '/api/chat/stream', { sessionId: askId, message: 'ASKME 用哪个框架', cwd: askWork }, token);
  const asked = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === askId);
    return Boolean(row && row.asksYou && String(row.asksYou.kind || ''));
  }, token);
  ok(Boolean(asked), 'B2a 服务端那一头：等你的那条真的挂上了待决');
  const onAsk = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return snapshot.focusId === ${JSON.stringify(askId)} ? snapshot : null;
  })()`);
  ok(Boolean(onAsk), `B2 真页面：等你的那条自动成为焦点（实测 focusId=${onAsk && onAsk.focusId}）`);

  /* ═════════ C1 等你那一段 ═════════ */
  ok(Boolean(onAsk) && onAsk.askShown === true && onAsk.askText.length > 0
    && onAsk.askOptions.length >= 2,
    `C1a 等你 → 「它在问你」callout ＋ 候选答案（实测 问「${onAsk && onAsk.askText}」候选 ${JSON.stringify(onAsk && onAsk.askOptions)}）`);
  shots.needsYou = path.join(shotDir, 'k6b-focus-needs-you.png');
  fs.writeFileSync(shots.needsYou, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.needsYou).size > 8000, `C1-shot 等你那一态的 1920 实拍已存（${shots.needsYou}）`);
  ok(Boolean(onAsk) && onAsk.state === 'needs_you' && onAsk.costNodes === 0 && onAsk.originShown === true && onAsk.ago.length > 0,
    `C1b 卡头药丸说「等你」，元信息一行有来源图形与相对时间、**零费用节点**（实测 state=${onAsk && onAsk.state} 来源=${onAsk && onAsk.originShown} 时间「${onAsk && onAsk.ago}」费用节点 ${onAsk && onAsk.costNodes}）`);
  // 点一枚候选答案 → 服务端那条 pending 真的消失（判据取服务端事实，不取按钮自己变没变）。
  await cdp.evaluate(`(() => {
    const button = document.querySelector('#stewardDrawerAskOptions .steward-drawer-reply');
    if (button) button.click();
    return Boolean(button);
  })()`);
  const answered = await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && String(item.sessionId) === askId && String(item.type) === 'question');
  }, token);
  ok(Boolean(answered), 'C1c 点候选答案 → 服务端那条 pending question 真的消失（不是按钮自己变了个样）');

  /* ═════════ C2 在跑那一段 ＋ D 推送延迟 ＋ E 不抢焦点 ═════════ */
  // 先把焦点钉到在跑那条【再】点火：当前动作行的三节形态只活在 tool_use 与 tool_result 之间，
  // 焦点晚一步过去就只剩两节（第一版实测「第 1 次调用 · 1 秒前有输出」）。
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(runId)} } })), true`);
  await waitForEval(cdp, `(() => { const s = ${CARD}; return s.focusId === ${JSON.stringify(runId)} ? s : null; })()`);
  // **不 await**：这一发要挂住三分钟（C2/C3/D/E 都要一个一直活着的回合）。await 会在 30 s 的
  // 客户端超时上把连接掐掉，回合跟着没了 —— 第一版就是这么写的，C2/C3/D 四条全空（实测）。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: runId, message: 'HANGHERE 一直说', cwd: runWork }, token, 600000);
  const runningRow = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === runId);
    return Boolean(row && row.activeTurn === true);
  }, token);
  ok(Boolean(runningRow), 'C2-0 服务端那一头：在跑那条真的活着（行上 activeTurn 为真）');
  const onRun = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return (snapshot.focusId === ${JSON.stringify(runId)} && snapshot.lastSayHead === ${JSON.stringify(String(zh['stewardShell.drawer.liveSay'] || ''))}) ? snapshot : null;
  })()`);
  ok(Boolean(onRun), `C2a 在跑 → 标题换成「它正在说」（实测「${onRun && onRun.lastSayHead}」）`);
  // 底部那句提示由【行上的五态】说了算（renderStateSections 那一张表），行到齐可能比 liveTail 晚
  // 一拍 —— 读同一张快照会偶发红（实测一次「直接对这个会话说」）。等它到齐再读。
  const runLabel = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return (snapshot.focusId === ${JSON.stringify(runId)}
      && snapshot.composerLabel === ${JSON.stringify(String(zh['stewardShell.drawer.composerLabelLive'] || ''))}) ? snapshot : null;
  })()`);
  ok(Boolean(runLabel),
    `C2b 底部那句提示换成「递给它一句」（实测「${(runLabel || onRun || {}).composerLabel}」）`);
  // 当前动作行：`工具 · 第 N 次调用 · N 秒前有输出`，等宽字体。三节都读服务端 liveTail。
  const acting = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return snapshot.actingShown ? snapshot : null;
  })()`);
  // 三节形态由页面自己在那一拍抄下（见注入脚本的头注：tool_result 一到 tail.tool 就空了）。
  const acting3 = await waitForEval(cdp, `window.__ruyiActing3 || null`, 600);
  const actingParts = String(acting3 || '').split(' · ');
  const callsRe = new RegExp('^' + String(zh['stewardShell.drawer.actingCalls'] || '').replace('{{n}}', '\\d+') + '$');
  const sinceRe = new RegExp('^' + String(zh['stewardShell.drawer.actingSince'] || '').replace('{{n}}', '\\d+') + '$');
  ok(Boolean(acting3) && actingParts.length === 3
    && callsRe.test(actingParts[1]) && sinceRe.test(actingParts[2])
    && Boolean(acting) && /mono|Consolas|Cascadia|Courier/i.test(acting.actingMono),
    `C2c 当前动作行格式是「工具 · 第 N 次调用 · N 秒前有输出」且等宽（实测「${acting3}」font=${acting && acting.actingMono}）`);
  ok(Boolean(acting3) && actingParts[0] !== '' && !/^[A-Za-z_]+$/.test(actingParts[0])
    && actingParts[0].indexOf('file_read') < 0,
    `C2d 第一节说的是【工具人话】，不是工具 id（实测「${actingParts[0]}」）`);
  shots.running = path.join(shotDir, 'k6b-focus-running.png');
  fs.writeFileSync(shots.running, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.running).size > 8000, `C2-shot 在跑那一态的 1920 实拍已存（${shots.running}）`);

  // E：光标停在管家输入框里时，推送换焦点【不许】把它抢走（§13.7 ⑨）。
  await cdp.evaluate(`(() => { const input = document.getElementById('stewardComposerInput'); if (input) input.focus(); return true; })()`);
  const beforeFocus = await cdp.evaluate(`document.activeElement ? (document.activeElement.id || '') : ''`);
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(doneId)} } })), true`);
  // 等到【切片真的落了】那一帧再读：openThread 先画一帧「读取中…」，那一帧上说什么都不算数。
  const swappedWhileTyping = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return (snapshot.focusId === ${JSON.stringify(doneId)} && snapshot.lastSay.indexOf('收工了') >= 0) ? snapshot : null;
  })()`);
  const afterFocus = await cdp.evaluate(`document.activeElement ? (document.activeElement.id || '') : ''`);
  ok(beforeFocus === 'stewardComposerInput' && Boolean(swappedWhileTyping) && afterFocus === 'stewardComposerInput',
    `E1 焦点在管家输入框里时换焦点不抢光标（§13.7 ⑨；换焦点前「${beforeFocus}」→ 后「${afterFocus}」，焦点线程已经换成收工那条）`);

  /* ═════════ C4 收工那一段（焦点此刻就在它身上）═════════ */
  ok(Boolean(swappedWhileTyping)
    && swappedWhileTyping.lastSayHead === String(zh['stewardShell.drawer.lastSay'] || '')
    && swappedWhileTyping.lastSay.indexOf('收工了') >= 0
    && swappedWhileTyping.actingShown === false,
    `C4a 收工 → 标题是「它最后说」、引文是它真说过的话、当前动作行收起（实测「${swappedWhileTyping && swappedWhileTyping.lastSayHead}」／「${swappedWhileTyping && swappedWhileTyping.lastSay}」）`);
  // 底部那句提示由【行上的五态】说了算（renderStateSections 那一张表），行到齐可能比切片晚一拍。
  const doneLabel = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return (snapshot.focusId === ${JSON.stringify(doneId)}
      && snapshot.composerLabel === ${JSON.stringify(String(zh['stewardShell.drawer.composerLabelDone'] || ''))}) ? snapshot : null;
  })()`);
  ok(Boolean(doneLabel),
    `C4b 底部那句提示换成「接着说」（实测「${(doneLabel || swappedWhileTyping || {}).composerLabel}」）`);
  ok(Boolean(swappedWhileTyping) && JSON.stringify(swappedWhileTyping.primary) === JSON.stringify(['stewardDrawerClassicBtn']),
    `C4c 动作行只有一枚主动作，且是「在工作台打开」（§2.6；实测 ${JSON.stringify(swappedWhileTyping && swappedWhileTyping.primary)}）`);
  shots.done = path.join(shotDir, 'k6b-focus-done.png');
  fs.writeFileSync(shots.done, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.done).size > 8000, `C4-shot 收工那一态的 1920 实拍已存（${shots.done}）`);

  /* ═════════ D thread.live → DOM ≤100 ms ═════════ */
  // 焦点先回到在跑那条，再挑一帧还没上屏的 thread.live 当靶子：先 arm 再等帧，顺序反了量的
  // 就是「我们回头去问的时刻」。
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(runId)} } })), true`);
  await waitForEval(cdp, `(() => { const s = ${CARD}; return s.focusId === ${JSON.stringify(runId)} ? s : null; })()`);
  const seen = new Set(stream.frames.filter(f => f.event === 'thread.live').map(f => f.id));
  await cdp.evaluate(`(window.__ruyiLiveMark = 0, window.__ruyiLiveWatch = '__ARMED__', true)`);
  const liveFrame = await waitForFrame(stream, f => f.event === 'thread.live' && f.data
    && f.data.sessionId === runId && !seen.has(f.id) && String(f.data.textTail || '').trim(), 40000);
  ok(Boolean(liveFrame), `D0 服务端真的又送出了一帧 thread.live（tail ${liveFrame ? String(liveFrame.data.textTail).slice(-18) : '无'}）`);
  if (liveFrame) {
    // 靶子取那一帧尾巴的最后 12 个字：焦点卡只显示末尾 ≤3 句，末 12 字一定在里面。
    const needle = String(liveFrame.data.textTail).trim().slice(-12);
    await cdp.evaluate(`(window.__ruyiLiveWatch = ${JSON.stringify(needle)}, window.__ruyiLiveMark = 0, (() => {
      const node = document.getElementById('stewardDrawerLastSayText');
      if (node && String(node.textContent || '').indexOf(${JSON.stringify(needle)}) >= 0) window.__ruyiLiveMark = Date.now();
      return true;
    })())`);
    let mark = 0;
    for (let i = 0; i < 200 && !mark; i++) {
      mark = Number(await cdp.evaluate('window.__ruyiLiveMark || 0').catch(() => 0));
      if (!mark) await sleep(10);
    }
    const lag = mark ? mark - serverAtOf(liveFrame) : Infinity;
    ok(Boolean(mark) && lag <= LIVE_PUSH_BUDGET_MS,
      `D1 thread.live 帧 → 焦点卡「它正在说」更新 ${Number.isFinite(lag) ? lag : '∞'} ms ≤ ${LIVE_PUSH_BUDGET_MS}（§9 K6b 验收）`);
  }

  /* ═════════ C3 排队那一段 ═════════ */
  // 并发位只有 1，在跑那条一直挂着 —— 第二条线程只能排队，wait 由服务端一处算出。
  request(appPort, 'POST', '/api/chat/stream', { sessionId: queueId, message: 'HANGHERE 排我后面', cwd: queueWork }, token, 600000);
  const queuedRow = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === queueId);
    return Boolean(row && row.wait && String(row.wait.label || ''));
  }, token);
  ok(Boolean(queuedRow), 'C3a 服务端那一头：第二条线程真的在等（wait 有 label）');
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(queueId)} } })), true`);
  const onQueue = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return (snapshot.focusId === ${JSON.stringify(queueId)} && snapshot.queueShown) ? snapshot : null;
  })()`);
  ok(Boolean(onQueue) && onQueue.wait.length > 0 && onQueue.jump === true && onQueue.max === true,
    `C3b 排队 → 「在等什么」那一段出现、说得出等什么，「插队」「并发上限」两枚都在（实测「${onQueue && onQueue.wait}」）`);

  /* ═════════ F 四面同色 ＋ G 里程碑接线 ═════════ */
  // 先把那两条挂着的回合停掉：并发位只有 1（C3 要的那个 1），**管家自己那一回合也要排队** ——
  // 不停就等于让 F/G 两组在队尾干等（第一版实测：F1 空、G1 零条里程碑）。
  for (const id of [runId, queueId]) await request(appPort, 'POST', '/api/stop', { sessionId: id }, token);
  await waitForHttp(appPort, 'GET', '/api/steward/arbiter', result => {
    const running = (result.json && Array.isArray(result.json.running)) ? result.json.running : [];
    const queued = (result.json && Array.isArray(result.json.queue)) ? result.json.queue : [];
    return running.length === 0 && queued.length === 0;
  }, token, 200);
  // 对话流那一面：让管家开一次口（OPENTHREAD 那一发同时也是 G 组的扳机），卡头就长出来了。
  const sent = await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    if (!input) return { sent: false, why: 'no input' };
    if (input.disabled) return { sent: false, why: 'disabled' };
    input.focus();
    input.value = 'OPENTHREAD 帮我盯一下';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { sent: true, why: '' };
  })()`);
  ok(Boolean(sent) && sent.sent === true, `F0 那句话真的发出去了（实测 ${JSON.stringify(sent)}）`);
  // 等管家那一回合落地：它的话上屏了，才谈得上「卡头长出来了」。
  const stewardSaid = await waitForEval(cdp, `(() => {
    const rows = [...document.querySelectorAll('#stewardFeed .steward-msg-ruyi .steward-say')].map(node => node.textContent.trim());
    return rows.some(text => text.indexOf('开好了') >= 0) ? rows.slice(-3) : null;
  })()`, 600);
  ok(Boolean(stewardSaid), `F0b 管家那一回合落地（实测 ${JSON.stringify(stewardSaid)}）`);
  // 管家【真的】开出了一条线程（服务端事实）：按标题在投影里找它的 id。
  const openedRow = await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const rows = (result.json && result.json.missions) || [];
    return rows.some(row => row && String(row.title || row.displayTitle || '') === LEDGER_TITLE);
  }, token, 200);
  const ledgerSessionId = String((((openedRow && openedRow.json && openedRow.json.missions) || [])
    .find(row => row && String(row.title || row.displayTitle || '') === LEDGER_TITLE) || {}).sessionId || '');
  const whyLines = await cdp.evaluate(`[...document.querySelectorAll('#stewardFeed .steward-why-line')].map(n => n.textContent.trim()).slice(-4)`).catch(() => null);
  const allTitles = await request(appPort, 'GET', '/api/missions?limit=200', null, token);
  ok(Boolean(ledgerSessionId),
    `F0c 管家真的开出了那条线程（${ledgerSessionId || '失败'}；※ 回执 ${JSON.stringify(whyLines)}；投影里的标题 ${JSON.stringify((((allTitles && allTitles.json) || {}).missions || []).map(r => r.title || r.displayTitle))}）`);
  if (!ledgerSessionId) throw new Error('steward-opened thread unavailable');
  const hues = await waitForEval(cdp, `(async () => {
    const conv = await import('/js/steward-conversation.js');
    const feed = document.querySelector('#stewardFeed .steward-msg[data-thread=' + JSON.stringify(${JSON.stringify(ledgerSessionId)}) + ']');
    if (!feed) return null;
    if (!feed.dataset.threadHue) return null;
    const railRow = document.querySelector('#railList .steward-board-thread[data-session-id=' + JSON.stringify(${JSON.stringify(ledgerSessionId)}) + ']');
    if (!railRow) return null;
    document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ledgerSessionId)} } }));
    const head = document.getElementById('stewardDrawerHead');
    return {
      feed: feed.dataset.threadHue || '',
      rail: railRow.dataset.threadHue || '',
      card: head ? (head.dataset.threadHue || '') : '',
      registry: String(conv.stewardThreadHueFor(${JSON.stringify(ledgerSessionId)})),
    };
  })()`);
  ok(Boolean(hues) && hues.feed !== '' && hues.feed === hues.rail && hues.feed === hues.registry,
    `F1 对话流卡头与左栏行是同一个号，且逐字等于那张登记表发的号（实测 ${JSON.stringify(hues)}）`);
  const cardHue = await waitForEval(cdp, `(() => {
    const snapshot = ${CARD};
    return snapshot.focusId === ${JSON.stringify(ledgerSessionId)} ? snapshot : null;
  })()`);
  ok(Boolean(cardHue) && cardHue.hue !== '' && Boolean(hues) && cardHue.hue === hues.feed,
    `F2 焦点卡也是同一个号（实测 焦点卡=${cardHue && cardHue.hue} 对话流=${hues && hues.feed}）`);
  // 第四面：左栏切到【看板密度】之后，那一行仍然是同一个号（同一枚卡基元、同一张表）。
  await cdp.evaluate(`(() => { const button = document.getElementById('railBoardBtn'); if (button) button.click(); return true; })()`);
  const boardHue = await waitForEval(cdp, `(() => {
    const frame = document.querySelector('.app-frame');
    if (!frame || !frame.classList.contains('rail-board')) return null;
    const row = document.querySelector('#railList .steward-board-thread[data-session-id=' + JSON.stringify(${JSON.stringify(ledgerSessionId)}) + ']');
    return row ? { hue: row.dataset.threadHue || '', board: true } : null;
  })()`);
  ok(Boolean(boardHue) && boardHue.board === true && Boolean(hues) && boardHue.hue === hues.feed,
    `F3 左栏看板密度那一行也是同一个号（第四面；实测 ${boardHue && boardHue.hue} vs ${hues && hues.feed}）`);

  /* ═════════ G 里程碑接线 ═════════ */
  // 管家那一回合的 actions 里带着一条【已执行】的 steward_thread_new（executedThreadSessionId
  // 认的就是它），于是前端该在那一刻把验收账本立起来。判据取【服务端事实】：那条线程的
  // /api/mission 里 milestones 非空。反向：注释掉 ensureAcceptanceLedger 那一句 → 本条红。
  const ledger = await waitForHttp(appPort, 'GET', `/api/mission?sessionId=${encodeURIComponent(ledgerSessionId)}`, result => {
    const milestones = (result.json && result.json.mission && result.json.mission.milestones) || [];
    return milestones.length > 0;
  }, token, 200);
  // 红的时候把「前端到底发过什么」打出来 —— 立账本那一发是 fire-and-forget、失败不冒红字，
  // 没有这一行就只能靠猜（第一版的 G 组就是这么卡了两轮）。只读，不写。
  if (!ledger) {
    const calls = await cdp.evaluate('JSON.stringify(window.__ruyiMissionCalls || [])').catch(() => '[]');
    console.log('#   诊断 前端发过的 /api/mission =', String(calls).slice(0, 600));
  }
  const milestones = (ledger && ledger.json && ledger.json.mission && ledger.json.mission.milestones) || [];
  ok(milestones.length >= 2 && milestones.every(item => item && String(item.desc || '').trim()),
    `G1 管家新开任务之后 /api/mission 的 milestones 非空且每条都有说法（§13.3 ①；实测 ${milestones.length} 条：${milestones.map(m => String(m.desc).slice(0, 12)).join(' | ')}）`);
  // companion：目标存的是【用户原话】，验收另行措辞（thread-facts.js 的头注原话）。
  const goal = String((ledger && ledger.json && ledger.json.mission && ledger.json.mission.goal) || '');
  ok(goal.indexOf(LEDGER_PROMPT) >= 0 && !milestones.some(m => String(m.desc || '').indexOf(LEDGER_PROMPT) >= 0),
    `G2 目标是用户原话、验收另行措辞（不是把任务再抄一遍；实测 goal「${goal}」）`);
} catch (error) {
  fail += 1;
  console.log('ERROR ' + (error && error.stack ? error.stack : error));
} finally {
  if (cdp) cdp.close();
  if (stream) stream.close();
  killTree(browser);
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  try { stopRuyiTestBrowsers(); } catch { /* best effort */ }
}

console.log(fail === 0 ? 'FOCUS RAIL BROWSER E2E: ALL PASS' : `FOCUS RAIL BROWSER E2E: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
})();

#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 换机器：直跑时家目录自隔离（服务启动会从真机 ~/.claude.json 导入 MCP 并同步回真机 CLI 配置，两个方向都要断）

// 第 124 波 P2 真浏览器 E2E，2026-09-22 用户拍板改写：**委托书横幅已退役，折叠块保留**。
//
// 退役的口径（用户原话）：「委托书本身删掉吧，会话中会有委托消息历史保留的记录」。
// 线程头下那条 #threadCommission 横幅整条拆除；委托内容本来就留在历史第一条消息里，
// 气泡内那个 <details class="brief-fence"> 折叠块（132a）是它现在【唯一】的界面形态。
// 本件按四组事实钉这个形态：
//
//   A11 管家开的线程上 #threadCommission 【不在 DOM 里】（退役不回潮的真机面）；
//   B9  第一条消息 = 用户原话 + 折叠的管家补充：气泡正文【只有】原话、围栏标签不上屏、
//       默认合上；**改的是显示、不是数据** —— state 里那条消息仍是整段原件
//      （回退／检查点／复制读的都是它，这条最要紧）；
//   B10 折叠块是活的：点 summary 开合两灵，展开时逐字的管家补充在屏上；开合按【线程】记
//      （换走再换回来还开着 —— 用户是明确要求看它的，再折回去就是跟他对着干）；
//   B8  长会话：消息窗真起作用（第一条在窗外）时，「展开全部」之后折叠块仍完好
//      （它跟着 renderCurrentSession 走，窗口怎么裁都不该把它弄丢）。
//
// 服务端事实（A5/A6/A6b）原样保留：brief.userText 逐字落盘、supplement 有「验收项」、
// 管家递的那一回合先跑完 —— 折叠块印的就是这份盘上数据。
//
// 夹具：确定性 fake provider；线程 S 由 `POST /api/steward/act` 的 steward_thread_new 开出来
// （与 one-workbench-frame.browser 同一条既有路径，不需要假管家模型）；线程 U 由用户自己建。
// 后端零改动。

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

// 用户原话：带一个 emoji（气泡正文逐字比对时，UTF-16 代理对不许被劈开）。
const USER_TEXT = '把三份季度报表放一起比一比，把口径不一致的地方列出来，最后给我一页结论 📊，别只丢一堆数字给我';
const THREAD_U = '我自己开的';   // 没有委托书的对照组
const BULK_CHARS = 40000;        // 每条灌水回答的长度（8 轮 ≈ 320k 字 > 消息窗 220k 的渲染预算）
const BULK_TURNS = 8;            // 轮数：16 条消息 > 最短尾窗 12 条，第一条因此必然落在窗外
const POLL_MS = 120000;          // 兜底节拍拉满：本件不测节拍

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

// 确定性 provider：一句短回答收尾即可（本件不测回合内容）。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    // 请求体里带 'bulk' → 吐一段 BULK_CHARS 长的回答。B8 要把消息窗（turn-narrative.js 的
    // MESSAGE_WINDOW_RENDER_BUDGET = 220 000 字、最短尾窗 12 条）真的顶开。
    const content = raw.includes('bulk') ? '数'.repeat(BULK_CHARS) : '好的，我先看这三份。';
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });
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

// 预算 800 × 40ms = 32 s（与同族浏览器件同一个数：并行全量下几个无头浏览器抢 CPU）。
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
  if (!document.querySelector('#threadChips [data-chip="engine"]')) return null;
  return { ready: true };
})()`;

// 第一条消息（委托书原件）的折叠块快照：只读 DOM 与公开属性，一个模块私有状态都不碰。
const FIRST = `(() => {
  const row = document.querySelector('#messages [data-message-key]');
  if (!row) return null;
  const bubble = row.querySelector('.bubble');
  const fence = bubble && bubble.querySelector('details.brief-fence');
  const bubbleText = bubble ? Array.from(bubble.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('') : '';
  return {
    commissioned: row.classList.contains('is-commissioned'),
    bubbleText,
    hasFence: Boolean(fence), fenceOpen: fence ? fence.open : null,
    fenceBody: fence ? (fence.querySelector('.brief-fence-body') || {}).textContent || '' : '',
    // 合上的 <details> 里子元素的计算样式仍是 block（内容槽不渲染而已）—— 量有没有盒子，不量 display。
    bodyShown: fence ? (() => { const el = fence.querySelector('.brief-fence-body'); return typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0; })() : null,
    screenHasTag: (bubble ? bubble.textContent : '').includes('<steward-brief'),
    storedChars: ((window.state.currentSession.messages || [])[0] || {}).content.length,
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-commission-'));
const home = path.join(root, 'home');
const workU = path.join(root, 'work-u');
const profile = path.join(root, 'profile');
for (const dir of [home, workU]) fs.mkdirSync(dir, { recursive: true });
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

// 截图落点：默认在夹具临时目录，设了 RUYI_SHOT_DIR 就落到那里（交付报告与走查要贴这两张）。
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

  // 用户自己开的那条（对照组：没有委托书）。
  const userThread = await request(appPort, 'POST', '/api/sessions', { title: THREAD_U, cwd: workU }, token);
  const idU = userThread && userThread.json && userThread.json.session && userThread.json.session.id;
  ok(Boolean(idU), `A3 用户自己开的线程已建（${idU || '失败'}）`);

  // 管家开的那条：走既有的 /api/steward/act → steward_thread_new（13k 在这一刻落 session.brief）。
  const dispatched = await request(appPort, 'POST', '/api/steward/act', {
    act: {
      kind: 'tool', tool: 'steward_thread_new',
      args: {
        // **省掉 cwd**（13k stewardValidateCwd 的三态之 ①）→ 在 Ruyi 根下派生一条属于这条线程
        // 自己的子工作区。不写 cwd: home：cwd 写锁按目录串行，而管家会话的 cwd 就是数据根 home，
        // 同目录时这条线程的回合会一直排在管家后面等锁（实测 B8 灌水那几发全是 409
        // session.turn_busy_elsewhere）。也不能自己编一个临时目录：表外的 cwd 会被直接拒。
        title: '三份报表对表',
        brief: {
          userText: USER_TEXT,
          goal: '找出三份季度报表之间口径不一致的地方',
          acceptance: ['三份都读到，逐项列出口径差异', '结论一页以内，先说结论再给依据'],
          constraints: ['只读这三份文件，不要联网'],
        },
      },
    },
  }, token);
  const idS = dispatched && dispatched.json && dispatched.json.result && dispatched.json.result.sessionId;
  ok(Boolean(idS), `A4 管家开出线程（${idS || '失败'}）`);
  if (!idS || !idU) throw new Error('thread fixtures unavailable');

  // 服务端落盘的那一份 —— 折叠块的判据以【它】为准，不以界面自说为准。
  const headS = await waitForHttp(appPort, 'GET', `/api/sessions/${encodeURIComponent(idS)}`,
    result => Boolean(result.json && result.json.session && result.json.session.brief
      && String(result.json.session.brief.userText || '')), token);
  const briefOnDisk = headS && headS.json && headS.json.session && headS.json.session.brief;
  ok(Boolean(briefOnDisk && briefOnDisk.userText === USER_TEXT),
    'A5 服务端落盘的 brief.userText 就是用户原话逐字（13k 的铁律 ①）');
  ok(Boolean(briefOnDisk && String(briefOnDisk.supplement || '').includes('验收项')),
    'A6 落盘的 brief.supplement 里有「验收项」那几行（06i buildStewardBrief 拼的）');
  const supplementOnDisk = String((briefOnDisk && briefOnDisk.supplement) || '');
  const threadCwd = String((headS && headS.json && headS.json.session && headS.json.session.cwd) || home);
  // 管家那一发（stewardLaunchTurn 递的委托书）必须先跑完：回合还挂着时，同一条线程上后面
  // 每一次 /api/chat/stream 都是 409 session.turn_busy_elsewhere（B8 的灌水就栽在这儿）。
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/sessions/' + encodeURIComponent(idS),
    result => ((result.json && result.json.session && result.json.session.messages) || [])
      .some(message => message && message.role === 'assistant'), token)),
    'A6b 管家递的那一回合已经跑完（线程上有了第一条助手消息）');

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A7 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1600,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A8 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A9 首屏就绪（config 真到达、线程头与那组 chip 已挂上）');

  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  const openThread = async sessionId => {
    await cdp.evaluate(`(() => {
      const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sessionId}"] .steward-board-thread-title');
      if (row) row.click();
      return true;
    })()`);
    return waitForEval(cdp, `(() => (window.state && window.state.currentSession
      && window.state.currentSession.id === '${sessionId}') ? 1 : null)()`);
  };
  const clickSummary = () => cdp.evaluate(`(() => {
    const summary = document.querySelector('#messages [data-message-key] details.brief-fence > summary');
    if (summary) summary.click();
    return Boolean(summary);
  })()`);

  await setLens('classic');
  ok(Boolean(await openThread(idS)), 'A10 工作台视角打开管家开的那条线程');

  /* ═════════ A11 横幅已退役 ═════════ */
  ok((await cdp.evaluate(`(() => document.getElementById('threadCommission') === null)()`)) === true,
    'A11 委托书横幅不在 DOM 里（2026-09-22 退役：委托内容留在历史第一条消息里）');

  /* ═════════ B9 第一条消息 = 用户原话 + 折叠的管家补充 ═════════ */
  shots.fold = path.join(shotDir, 'thread-commission-fold.png');
  fs.writeFileSync(shots.fold, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.fold).size > 8000, `B9-shot 折叠块实拍已存（${shots.fold}）`);
  const first = await cdp.evaluate(FIRST);
  ok(Boolean(first) && first.commissioned === true && first.bubbleText === USER_TEXT,
    `B9a 第一条气泡正文【只有】用户原话（实得 ${JSON.stringify(first && first.bubbleText)}）`);
  ok(Boolean(first) && first.hasFence === true && first.fenceOpen === false && first.bodyShown === false && first.screenHasTag === false,
    `B9b 管家补充收在折叠块里、默认合上、围栏标签不上屏（实得 ${JSON.stringify(first && { hasFence: first.hasFence, fenceOpen: first.fenceOpen, bodyShown: first.bodyShown, screenHasTag: first.screenHasTag })}）`);
  ok(Boolean(first) && first.storedChars > USER_TEXT.length && first.fenceBody === supplementOnDisk,
    `B9c **改的是显示、不是数据**：state 里那条消息仍是整段原件（${first && first.storedChars} 字），折叠块里是逐字的补充`);

  /* ═════════ B10 折叠块是活的：开合两灵、按线程记 ═════════ */
  ok((await clickSummary()) === true, 'B10a summary 可点');
  const afterOpen = await cdp.evaluate(FIRST);
  ok(Boolean(afterOpen) && afterOpen.fenceOpen === true && afterOpen.bodyShown === true
    && afterOpen.fenceBody.includes('验收项') && afterOpen.screenHasTag === false,
    `B10b 点开 summary：折叠块打开、逐字的管家补充在屏上、围栏标签仍不上屏（实得 ${JSON.stringify(afterOpen && { fenceOpen: afterOpen.fenceOpen, bodyShown: afterOpen.bodyShown })}）`);
  await clickSummary();
  const afterClose = await cdp.evaluate(FIRST);
  ok(Boolean(afterClose) && afterClose.fenceOpen === false && afterClose.bodyShown === false,
    `B10c 再点一下收得回去（实得 ${JSON.stringify(afterClose && { fenceOpen: afterClose.fenceOpen, bodyShown: afterClose.bodyShown })}）`);
  // 按【线程】记：在这条线程上把它打开，换走再换回来还开着（用户是明确要求看它的）。
  await clickSummary();
  ok(Boolean(await openThread(idU)), `B10d 切到用户自己开的那条线程（${idU}）`);
  ok(Boolean(await openThread(idS)), 'B10e 换回管家开的那条');
  const remembered = await cdp.evaluate(FIRST);
  ok(Boolean(remembered) && remembered.fenceOpen === true,
    `B10f 换走再换回来，这条线程上已展开的管家补充仍然开着（实得 fenceOpen=${remembered && remembered.fenceOpen}）`);
  await clickSummary();   // 合上，给 B8 一个确定的初始态

  /* ═════════ B8 长会话：消息窗真起作用时，「展开全部」后折叠块仍完好 ═════════ */
  const bulkStatuses = [];
  for (let i = 0; i < BULK_TURNS; i++) {
    const turn = await request(appPort, 'POST', '/api/chat/stream', { sessionId: idS, message: 'bulk ' + i, cwd: threadCwd }, token, 600000);
    bulkStatuses.push(turn ? String(turn.status) + ':' + String(turn.text || '').slice(0, 120).replace(/\s+/g, ' ') : 'null');
  }
  if (process.env.RUYI_DEBUG_BULK) console.log('BULK ' + JSON.stringify(bulkStatuses, null, 1));
  const grown = await request(appPort, 'GET', '/api/sessions/' + encodeURIComponent(idS), null, token);
  const grownCount = grown && grown.json && grown.json.session ? (grown.json.session.messages || []).length : 0;
  ok(grownCount >= BULK_TURNS * 2, `B8a 线程 S 已灌到 ${grownCount} 条消息`);
  // 换走再换回来，让中栏重新取一份会话（灌水是经 HTTP 做的，浏览器手里那份是旧的）。
  await openThread(idU);
  ok(Boolean(await openThread(idS)), 'B8b 重新打开线程 S');
  const firstMessageProbe = JSON.stringify(USER_TEXT);
  const windowed = await waitForEval(cdp, `(() => {
    const box = document.getElementById('messages');
    if (!box) return null;
    const rows = box.querySelectorAll('[data-message-key]');
    if (!rows.length) return null;
    return {
      rows: rows.length,
      total: (window.state.currentSession.messages || []).length,
      hasLoadEarlier: Boolean(box.querySelector('.load-earlier')),
      firstShown: (rows[0].textContent || '').includes(${firstMessageProbe}),
    };
  })()`);
  ok(Boolean(windowed) && windowed.hasLoadEarlier === true && windowed.firstShown === false,
    `B8c 消息窗真的起作用了：画了 ${windowed && windowed.rows} / 共 ${windowed && windowed.total} 条，第一条（委托书原件）在窗外`);
  // 横幅已经不在了，到达第一条的路就是窗口自带的「展开全部」。
  await cdp.evaluate(`(() => { const btn = document.querySelector('#messages .load-earlier.load-all'); if (btn) btn.click(); return Boolean(btn); })()`);
  const reached = await waitForEval(cdp, `(() => {
    const row = document.querySelector('#messages [data-message-key]');
    return row && (row.textContent || '').includes(${firstMessageProbe}) ? 1 : null;
  })()`);
  ok(Boolean(reached), 'B8d 「展开全部」后第一条（委托书原件）回到屏上');
  const firstLong = await cdp.evaluate(FIRST);
  ok(Boolean(firstLong) && firstLong.commissioned === true && firstLong.bubbleText === USER_TEXT
    && firstLong.hasFence === true && firstLong.fenceBody === supplementOnDisk,
    `B8e 长会话里折叠块仍完好：原话逐字、补充逐字（实得 ${JSON.stringify(firstLong && { commissioned: firstLong.commissioned, hasFence: firstLong.hasFence })}）`);
  console.log(`SHOTS ${shots.fold}`);
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

console.log(`\nTHREAD COMMISSION BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 换机器：直跑时家目录自隔离（服务启动会从真机 ~/.claude.json 导入 MCP 并同步回真机 CLI 配置，两个方向都要断）

// 第 124 波 P2 真浏览器 E2E：**委托书带**（40 号文 §2 ②「我当初交办的是什么？」）。
//
// 用户的处境：管家替他开了一条线程，他在工作台视角点开它，想知道「我当初交办的到底是什么」。
// 修前线程头下面第一条系统消息位是空的 —— 交办的原话混在第一条用户消息里，长会话里它连
// 画都不画（消息窗只画尾窗）。本件按七组事实钉这条带：
//
//   B1 管家开的线程上委托书带在场，**目标那一格逐字等于用户原话**（不是摘要、不是标题）；
//   B2 默认折叠：正文 hidden、aria-expanded=false，折叠行上是一句摘录（≤ 43 字，含省略号）；
//   B3 **位置**：它排在 #missionBar／#autonomyBar／#stepBar／#messages 全部之前（「第一条」）——
//      按运行期 compareDocumentPosition 量，不是按 HTML 源码里的字符串下标；
//   B4 展开之后管家补充**逐字等于服务端落盘的 brief.supplement**（零二次解析的可观测面：
//      「验收项：」那几行原样在屏上）；
//   B5 「看原件」：点下去，这条线程的第一条消息拿到 .is-revealed，且它的正文里**同时**有
//      用户原话与 `<steward-brief added-by="steward">` 围栏 —— 那才是真原件（委托书带印的是
//      拆开的两段，原件是管家真正递给线程的那一整段）；
//   B6 用户自己开的线程（没有 brief）整条带不出现 —— 不画「暂无委托书」那种等重灰字；
//   B7 换线程回来时收回折叠态（展开与否是【那一条】线程的读法，不跟着人跑）。
//
// 124 走查 B（用户 2026-09-15 三选一）追加 **B9 组**：委托书带展开之后，它印的那两段与紧挨着
// 的第一条用户消息是【同一段话】（那条消息本来就是管家递过去的原件），两份并排等于把同一句话
// 说两遍。现在第一条默认折成一行，点「看原件」才展开。B9c 钉的是最要紧的那一条：**折的是显示、
// 不是数据** —— state 里那条消息仍是整段原件（回退／检查点／复制读的都是它）。
// B9e 钉「按线程记」：在这条线程上请出来过的原件，换走再换回来还开着（与带本身刻意不同）。
//
// 反向（交付报告里逐条记实得）：
//   · 把 index.html 里 #threadCommission 整段挪到 #missionBar 之后 → B3 红；
//   · 把 goal.textContent 改成 threadCommissionGist(brief.userText) → B1 红；
//   · 把 revealOriginalMessage 里的 expandMessageWindowFully() 拔掉 → 长会话那一支 B5 红。
//
// 夹具：确定性 fake provider；线程 S 由 `POST /api/steward/act` 的 steward_thread_new 开出来
// （与 one-workbench-frame.browser 同一条既有路径，不需要假管家模型）；线程 U 由用户自己建。
// 后端零改动。

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

// 用户原话：故意长过折叠行的 42 字上限（B2 要看见省略号），且带一个 emoji（摘录按字符切，
// 不按 UTF-16 码元 —— 切错会把它劈成两半）。
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
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
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
    // MESSAGE_WINDOW_RENDER_BUDGET = 220 000 字、最短尾窗 12 条）真的顶开 —— 只有窗口真起作用时，
    // 「看原件」里那步 expandMessageWindowFully() 才是必需的，反向拔掉它才有东西可红。
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

// 委托书带快照：只读 DOM 与公开属性，一个模块私有状态都不碰。
const BAND = `(() => {
  const byId = id => document.getElementById(id);
  const band = byId('threadCommission');
  const body = byId('threadCommissionBody');
  const toggle = byId('threadCommissionToggle');
  // 「排在谁之前」按运行期文档序量：DOCUMENT_POSITION_FOLLOWING(4) ＝ 那一个排在 band 之后。
  const after = ['missionBar', 'autonomyBar', 'stepBar', 'messages'].map(id => {
    const node = byId(id);
    return { id, present: Boolean(node), following: node ? Boolean(band.compareDocumentPosition(node) & 4) : null };
  });
  return {
    sessionId: (window.state && window.state.currentSession && window.state.currentSession.id) || '',
    present: Boolean(band),
    hidden: band ? band.hidden : null,
    open: band ? (band.dataset.open || '') : '',
    bodyHidden: body ? body.hidden : null,
    expanded: toggle ? toggle.getAttribute('aria-expanded') : '',
    gist: (byId('threadCommissionGist') || {}).textContent || '',
    when: (byId('threadCommissionWhen') || {}).textContent || '',
    goal: (byId('threadCommissionGoal') || {}).textContent || '',
    supplement: (byId('threadCommissionSupplement') || {}).textContent || '',
    supplementHidden: byId('threadCommissionSupplementField') ? byId('threadCommissionSupplementField').hidden : null,
    runner: (byId('threadCommissionRunner') || {}).textContent || '',
    runnerHidden: byId('threadCommissionRunner') ? byId('threadCommissionRunner').hidden : null,
    originalHidden: byId('threadCommissionOriginal') ? byId('threadCommissionOriginal').hidden : null,
    after,
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

  // 服务端落盘的那一份 —— B1／B4 的判据以【它】为准，不以界面自说为准。
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

  await setLens('classic');
  ok(Boolean(await openThread(idS)), 'A10 工作台视角打开管家开的那条线程');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const band = document.getElementById('threadCommission');
    return band && band.hidden === false ? 1 : null;
  })()`)), 'A11 委托书带已上屏');

  const collapsed = await cdp.evaluate(BAND);
  shots.collapsed = path.join(shotDir, 'thread-commission-collapsed.png');
  fs.writeFileSync(shots.collapsed, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.collapsed).size > 8000, `B2-shot 折叠态实拍已存（${shots.collapsed}）`);

  /* ═════════ B1 目标逐字 ═════════ */
  ok(collapsed.goal === USER_TEXT,
    `B1 目标那一格逐字等于用户原话（${collapsed.goal.length} 字 / 期望 ${USER_TEXT.length}）`);

  /* ═════════ B2 默认折叠 ＋ 摘录 ═════════ */
  ok(collapsed.bodyHidden === true && collapsed.expanded === 'false',
    'B2a 默认折叠（正文 hidden、aria-expanded=false）');
  // 尺子按【码点】量：原话里那个 📊 在 UTF-16 里占两格，用 .length 量会把 42+省略号 数成 44。
  // 实现（threadCommissionGist）本来就是按码点切的 —— 这条断言修前是判据对、尺子错。
  const gistChars = [...collapsed.gist].length;
  ok(gistChars > 0 && gistChars <= 43 && collapsed.gist.endsWith('…')
    && USER_TEXT.startsWith(collapsed.gist.slice(0, -1)),
    `B2b 折叠行是一句摘录且带省略号（「${collapsed.gist}」，${gistChars} 码点）`);
  ok(collapsed.when.length > 0, `B2c 折叠行上说得出「什么时候交办的」（「${collapsed.when}」）`);

  /* ═════════ B3 位置：它是线程头下第一条 ═════════ */
  const misplaced = (collapsed.after || []).filter(row => row.present && row.following !== true).map(row => row.id);
  ok(misplaced.length === 0,
    `B3 它排在 ${(collapsed.after || []).filter(r => r.present).map(r => '#' + r.id).join('／')} 全部之前${misplaced.length ? '（实得排在 ' + misplaced.join('／') + ' 之后）' : ''}`);

  /* ═════════ B4 展开：管家补充逐字 ═════════ */
  await cdp.evaluate(`document.getElementById('threadCommissionToggle').click(), true`);
  const opened = await cdp.evaluate(BAND);
  shots.opened = path.join(shotDir, 'thread-commission-open.png');
  fs.writeFileSync(shots.opened, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ok(fs.statSync(shots.opened).size > 8000, `B4-shot 展开态实拍已存（${shots.opened}）`);
  ok(opened.bodyHidden === false && opened.expanded === 'true' && opened.open === '1', 'B4a 点一下就展开');
  ok(opened.supplementHidden === false && opened.supplement === supplementOnDisk,
    `B4b 管家补充逐字等于服务端落盘的那一份（${opened.supplement.length} 字 / 期望 ${supplementOnDisk.length}）`);
  ok(opened.supplement.includes('验收项') && opened.supplement.includes('约束'),
    'B4c 「验收怎么算」原样在屏上（零二次解析的可观测面）');
  ok(opened.runnerHidden === false && opened.runner.includes('如意管家'),
    `B4d 「谁在跑」说得出来（「${opened.runner}」）`);

  /* ═════════ B9 124 走查 B：原件默认折成一行 ═════════
     用户 2026-09-15 三选一选了 B。病灶在 B4-shot 那张实拍里一眼可见：委托书带展开之后，
     它印的那两段与紧挨着的第一条用户消息是同一段话。现在第一条默认折起，点「看原件」才展开。 */
  const folded = await cdp.evaluate(`(() => {
    const row = document.querySelector('#messages [data-message-key]');
    if (!row) return null;
    const bubble = row.querySelector('.bubble');
    return {
      hasClass: row.classList.contains('is-original-folded'),
      hint: row.dataset.foldedHint || '',
      bubbleShown: bubble ? getComputedStyle(bubble).display !== 'none' : null,
      // 折的是显示不是数据：这条消息的正文在 state 里一个字都没少。
      storedChars: ((window.state.currentSession.messages || [])[0] || {}).content.length,
    };
  })()`);
  ok(Boolean(folded) && folded.hasClass === true && folded.bubbleShown === false,
    `B9a 第一条消息默认折起来了（气泡不显示；实得 ${JSON.stringify(folded)}）`);
  ok(Boolean(folded) && folded.hint.length > 0,
    `B9b 折起来那一行有话说，不是一片空白（实得「${folded && folded.hint}」）`);
  ok(Boolean(folded) && folded.storedChars > USER_TEXT.length,
    `B9c **折的是显示、不是数据**：state 里那条消息仍是整段原件（${folded && folded.storedChars} 字 > 原话 ${USER_TEXT.length} 字）`);

  /* ═════════ B5 看原件 ═════════ */
  ok(opened.originalHidden === false, 'B5a 「看原件」按钮在场（落点注入链通了）');
  await cdp.evaluate(`document.getElementById('threadCommissionOriginal').click(), true`);
  const revealed = await waitForEval(cdp, `(() => {
    const row = document.querySelector('#messages .message.is-revealed');
    if (!row) return null;
    return { text: row.textContent || '' };
  })()`);
  ok(Boolean(revealed), 'B5b 第一条消息拿到 .is-revealed（真的跳过去了）');
  ok(Boolean(revealed) && revealed.text.includes(USER_TEXT),
    'B5c 原件里有用户原话逐字');
  ok(Boolean(revealed) && revealed.text.includes('<steward-brief added-by="steward">'),
    'B5d 原件里有管家补充那道围栏 —— 它才是真正递给线程的那一整段（委托书带印的是拆开的两段）');
  // B9d：点完「看原件」，那一行真的展开了。**必须量计算样式**——textContent 不认 CSS，
  // 上面 B5c/B5d 在折叠态下也会绿，拿它们证不了「展开了」。
  const unfolded = await cdp.evaluate(`(() => {
    const row = document.querySelector('#messages [data-message-key]');
    const bubble = row && row.querySelector('.bubble');
    return row ? { hasClass: row.classList.contains('is-original-folded'), bubbleShown: bubble ? getComputedStyle(bubble).display !== 'none' : null } : null;
  })()`);
  ok(Boolean(unfolded) && unfolded.hasClass === false && unfolded.bubbleShown === true,
    `B9d 点完「看原件」那一行真的展开了（气泡显示；实得 ${JSON.stringify(unfolded)}）`);

  /* ═════════ B6 没有委托书的线程整条带不出现 ═════════ */
  // 换线程【留在工作台视角】点左栏行 —— 同一次点击在管家视角下是「打开抽屉」
  // （steward-board.js 的 `if (isStewardMode()) return openThread(id)`），中栏不会跟着换。
  ok(Boolean(await openThread(idU)), `B6a 切到用户自己开的那条线程（${idU}）`);
  const onUser = await cdp.evaluate(BAND);
  ok(onUser.hidden === true && onUser.sessionId === idU,
    `B6 用户自己开的线程上整条带 hidden（实得 hidden=${onUser.hidden}，当前线程 ${onUser.sessionId}）`);

  /* ═════════ B7 换回来时收回折叠态 ═════════ */
  ok(Boolean(await openThread(idS)), `B7a 换回管家开的那条（${idS}）`);
  const back = await cdp.evaluate(BAND);
  // B9e：展开状态按【线程】记 —— 在这条线程上请出来过的原件，换走再换回来还开着。
  // 与委托书带本身【刻意不同】（带换线程会收回折叠态）：带是常驻的答案，原件是用户专门点开的证据，
  // 再给他折回去就是跟他对着干。这条同时也钉住「不是全局布尔」——它是按 sessionId 记的。
  const refolded = await cdp.evaluate(`(() => {
    const row = document.querySelector('#messages [data-message-key]');
    return row ? row.classList.contains('is-original-folded') : null;
  })()`);
  ok(refolded === false, `B9e 换走再换回来，这条线程上已请出来的原件仍然开着（实得 folded=${refolded}）`);
  ok(back.hidden === false && back.bodyHidden === true && back.expanded === 'false' && back.sessionId === idS,
    `B7 换线程回来时委托书收回折叠态（实得 hidden=${back.hidden} bodyHidden=${back.bodyHidden} expanded=${back.expanded}，当前线程 ${back.sessionId}）`);
  /* ═════════ B8 长会话：委托书带还在，「看原件」仍然到得了第一条 ═════════
     这一组才是 revealOriginalMessage 里那步 expandMessageWindowFully() 的存在理由 ——
     短会话上把它拔掉 B5 照样绿（第一条本来就画着），只有窗口真起作用时它才是必需的。 */
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
  const bandLong = await cdp.evaluate(BAND);
  ok(bandLong.hidden === false && bandLong.goal === USER_TEXT,
    'B8d 委托书带不受消息窗影响 —— 它读的是会话头上的 brief，不是那条被窗口丢掉的消息');
  await cdp.evaluate(`document.getElementById('threadCommissionOriginal').click(), true`);
  const reachedLong = await waitForEval(cdp, `(() => {
    const row = document.querySelector('#messages .message.is-revealed');
    return row && (row.textContent || '').includes(${firstMessageProbe}) ? 1 : null;
  })()`);
  ok(Boolean(reachedLong),
    'B8 长会话里「看原件」仍然到得了第一条（窗口先全展开再滚过去）—— 拔掉 expandMessageWindowFully 这一条红');
  console.log(`SHOTS ${shots.collapsed} ${shots.opened}`);
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

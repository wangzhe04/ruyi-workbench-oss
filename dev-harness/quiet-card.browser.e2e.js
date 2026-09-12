#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 121 波 K6a 真浏览器 E2E：安静卡（34 号文 §4.3「在场信号与打扰纪律」／§2.6）。
//
// 钉的是「安静卡只在【工作台且非当前会话】出现」这句话能不能兑现，全部读 DOM、真端点，一个模块
// 私有状态都不碰：
//   A 三种在场状态各一断言 —— 坐在该线程上（工作台，就是当前会话）→ 无卡；工作台坐在别的线程 →
//     有卡；管家视角 → 无卡且今天的收件箱行为不变（GET /api/missions 那一行的 wait 仍然照旧变化）；
//   B 候选答案按钮点下去 ＝ 那条线程的待决被回答（服务端事实：GET /api/interventions 里那条
//     pending 消失）；
//   C 「去看」＝ state.currentSession.id 换成它，且 data-shell-mode 仍是 classic（不切视角）；
//   D 同线程同类 5 分钟内第二条 → 仍是一张卡（DOM 数 .quiet-card ＝ 1，只是计数与文案更新）；
//   E 静默时段（quietStart／quietEnd 覆盖此刻）→ 不出卡。
//
// 反向验证三处都已【本机独立跑一遍】（先破坏、看真红、再还原；不在本文件里自动做——会把生产文件
// 写脏，与 32 号文 §4 纪律 4 的「先复原再验证」相悖，本文件只钉「正常状态下的真值」）。实测结果
// 与派单稿设想的不完全一样,如实记：
//   ① 把 quiet-card.js 的「shellModeOf() !== 'classic'」删掉 → 全绿，A3b 仍然 PASS。不是判据没用，
//      是这一路本来就【双保险】：服务端在场门③（13i stewardApplyPresenceGate）在管家视角这一支
//      根本不会给事件打 quiet:true——单浏览器/单 SSE 连接场景下，客户端永远收不到需要这道判据
//      拦的帧，红不了。多标签页各自不同 lens 时才轮到它，不在本件夹具范围内。
//   ② 把「sessionId === currentSessionId()」删掉 → 同样全绿。理由同① 的另一半：服务端在场门①
//      直接把「坐在这条线程上」的事件挡在收件箱外（不入箱，谈不上派 inbox.appended），前端这道
//      门在单连接场景下也拦不到东西——它和①一样是「防将来在场信号少判一次」的双保险，不是本波
//      唯一防线。
//   ③ 把 isQuietTime 那一次调用短路成 false → 真红：E1（静默时段应无卡）从 PASS 转 FAIL（实测
//      卡片列表多出了「quiet」那条会话），还原后复绿。这一条是唯一【纯客户端】的判断（免打扰时段
//      是本机偏好，服务端在场门完全不知道它），本条锁的分量都在这里。
// 结论：①②在当前架构下是安全冗余（服务端已经堵死，前端这句话拿掉也看不出退化），不是摆设——
// 一旦将来在场信号改成别的实现、或多标签页场景纳入夹具，这两句就会成为真正兜底的那一层；③是
// 本波唯一能在单连接夹具里独立证伪的判据，且已证伪过。

//
// 夹具：沿用 workbench-thread-head.browser.e2e.js 的确定性 fake provider 手法（K5 那一件），
// 按【请求体里的标记】分流：'ask about X' → 一条单选 request_user_input（options=[wait,skip]）。
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

// 5000 是 13i 收件箱 tick 的下限（clamp(stewardPollMs,5000,120000)）——本件恰恰要测的就是那一拍
// 收件箱写行之后经 13r 派的 inbox.appended 帧，所以要拉到下限而不是拉满（那是别的件测「兜底轮询
// 拉满，本件不测节拍」时才用的数）。
const POLL_MS = 5000;

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

// 确定性 provider：请求体含 'ask about ' + 关键字 → 单选 request_user_input（options wait/skip）；
// 其余 → 一段短回答。同一路 handler 处理全部会话，用关键字分流即可（与 K5 那一件同一份手法）。
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
    // 判据只看【最后一条消息】，不看「历史里有没有」——本件同一条会话线程要连续问好几轮
    // （D 组的合并测试），每一轮的旧 tool 结果都会一直留在历史里；只有【这一次请求的最后一条】
    // 是不是刚发生的用户提问，才决定这一轮要不要再问一遍。role:'tool' 收尾（continuation）
    // 与 role:'user' 的新提问（fresh ask）因此不会互相污染。
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

// 安静卡快照：只读 DOM。
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
      countBadge: (node.querySelector('.quiet-card-count') || {}).textContent || '',
      hasOptions: node.querySelectorAll('.quiet-card-btn-option').length,
      hasGo: Boolean(node.querySelector('.quiet-card-btn-go')),
      hasLater: Boolean(node.querySelector('.quiet-card-btn-later')),
    })),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-quiet-card-'));
const home = path.join(root, 'home');
const workSeated = path.join(root, 'work-seated');
const workOther = path.join(root, 'work-other');
const workSteward = path.join(root, 'work-steward');
const workGo = path.join(root, 'work-go');
const workQuiet = path.join(root, 'work-quiet');
for (const dir of [home, workSeated, workOther, workSteward, workGo, workQuiet]) fs.mkdirSync(dir, { recursive: true });
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
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
const shots = {};
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
    ['seated', '坐着的那条', workSeated], ['other', '别的线程', workOther],
    ['steward', '管家视角那条', workSteward], ['go', '去看那条', workGo], ['quiet', '静默时段那条', workQuiet],
  ]) {
    const response = await request(appPort, 'POST', '/api/sessions', { title, cwd }, token);
    created[key] = response && response.json && response.json.session && response.json.session.id;
    // 交给管家盯——不然它连 watched 都不是,普通用户会话不进这条推送线(与 §4.1 的 watched 判据一致)。
    await request(appPort, 'PATCH', `/api/sessions/${encodeURIComponent(created[key])}`, { stewardWatch: true }, token);
  }
  ok(Object.values(created).every(Boolean), `A0c 五条线程已建（${JSON.stringify(created)}）`);
  if (!Object.values(created).every(Boolean)) throw new Error('session fixtures unavailable');

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
    // 重试点击：首帧 config 刚到、#lensSeg 可能还没挂上就点了个空（点击器里的 { click(){} } 兜底
    // 会悄悄吞掉这一次）——按「点了没生效就再点一次」而不是赌第一次一定来得及。
    for (let i = 0; i < 40; i++) {
      if (await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}')()`)) return 1;
      await cdp.evaluate(`(() => { const b = document.querySelector('#lensSeg [data-lens="${lens}"]'); if (b) b.click(); return Boolean(b); })()`);
      await sleep(80);
    }
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}' ? 1 : null)()`);
  };
  const openInWorkbench = async sessionId => {
    // 与 workbench-thread-head.browser.e2e.js 同一手法：左栏点该行的标题（K4 的点击语义——单线程
    // 任务一行，点它＝把中栏换成那条线程）。五条线程都在 A0c 一步交给管家盯过，会进左栏索引。
    // 重试点击：左栏偶尔在查询与点击之间重渲（新一拍 /api/missions 回来换了 DOM 节点），单发
    // click() 落在旧节点上不生效——按「点了没生效就用新查到的节点再点一次」而不是赌一次就中。
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

  ok(Boolean(await setLens('classic')), 'A0g 顶栏分段钮切到工作台视角（后续 A1-E 的前提，先在这里钉死不是碰巧）');
  // 已知时序坑（本机实测约 1/3 概率触发，与本刀改动无关，登记见交付报告）：boot 末尾
  // provider-settings.js 的 fillSettings() 只调用【一次】 steward-shell.js 的
  // syncStewardShellAvailability()——它在「没有存过显式非管家偏好」时会自动切回 steward
  // （34 号文 §8.4 拍板③的默认落点）。这一次调用与 A0g 点击classic之间没有互斥：若它排在点击
  // 之后触发，会把刚点好的 classic 悄悄翻回 steward。这里不追那一次时序竞态的根（不在 K6a
  // 范围），改用「按住」的方式绕过——点完之后再观察 2 s，一旦被翻回去就重新点一次，直到稳定。
  {
    let flips = 0;
    for (let i = 0; i < 25; i++) {
      await sleep(80);
      const mode = await cdp.evaluate(`(() => document.documentElement.getAttribute('data-shell-mode'))()`);
      if (mode !== 'classic') { flips += 1; await setLens('classic'); }
    }
    if (flips) console.log(`DEBUG A0g-hold 期间被自动翻回 ${flips} 次，已重新点回 classic`);
  }
  // 左栏五条线程真的渲染出来之后才开始点行——否则 openInWorkbench 会在行还没画出来时就点了个空
  // （偶发：A0g 切完视角那一拍，左栏可能还没吃到第一份 /api/missions）。
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelectorAll('#railList .steward-board-thread').length >= 5 ? 1 : null)()`)),
    'A0h 左栏五条线程都已渲染（后续点行操作的前提）');

  /* ═════════ A1：坐在该线程上 → 无卡 ═════════
     先把「seated」这条线程在工作台打开，再朝它触发一个 needs_you。 */
  ok(Boolean(await openInWorkbench(created.seated)), 'A1a 已坐在「seated」那条线程上');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.seated, message: 'ask about seated', cwd: workSeated }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.seated);
  }, token)), 'A1b 线程「seated」真的停在待决了（服务端事实）');
  await sleep(6500); // 给收件箱 tick(5s 下限)走完至少一拍——这是「不出卡」的反向计时，不是等成功
  const seatedSnap = await snapCards();
  ok(seatedSnap.count === 0, `A1 坐在该线程上时不出安静卡（实测 ${seatedSnap.count} 张）——在场门①`);

  /* ═════════ A2：工作台坐在别的线程 → 有卡 ═════════ */
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.other, message: 'ask about other', cwd: workOther }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.other);
  }, token)), 'A2a0 线程「other」的待决先在服务端真的产生了（排除法：区分「没触发」与「触发了但没渲染」）');
  const otherAppeared = await waitForEval(cdp, `(() => {
    const host = document.getElementById('quietCardHost');
    return host && host.querySelector('.quiet-card[data-session-id="${created.other}"]') ? 1 : null;
  })()`);
  if (!otherAppeared) {
    const debugSnap = await snapCards();
    console.log('DEBUG cardsAtFailure=' + JSON.stringify(debugSnap));
  }
  ok(Boolean(otherAppeared), 'A2a 工作台坐在别的线程时，「other」的待决出了一张安静卡');
  const otherSnap = await snapCards();
  const otherCard = otherSnap.cards.find(c => c.sessionId === created.other);
  ok(Boolean(otherCard) && otherCard.kind === 'needs_you' && otherCard.line.length <= 23 && otherCard.line.includes('…') === (otherCard.line.length > 22),
    `A2b needs_you 印问句前 22 字（实测「${otherCard && otherCard.line}」）`);
  ok(Boolean(otherCard) && otherCard.hasOptions === 2 && otherCard.hasGo && otherCard.hasLater,
    `A2c 卡上有候选答案（2 个）＋「去看」＋「稍后」（实测候选 ${otherCard && otherCard.hasOptions} 个）`);

  /* ═════════ B：候选答案按钮点下去 ＝ 待决被回答（服务端事实）═════════
     按钮存在性单独等一遍再点——卡片在 A2 检查完之后到这里点下去之间理论上可能被一次
     inbox.appended 重渲（clear()+rebuild），直接对着旧引用点会撞上瞬时的 null。 */
  await waitForEval(cdp, `(() => document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"] .quiet-card-btn-option') ? 1 : null)()`, 200);
  await cdp.evaluate(`(() => { const b = document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"] .quiet-card-btn-option'); if (b) b.click(); return Boolean(b); })()`);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return !pending.some(item => item && item.sessionId === created.other);
  }, token)), 'B1 候选答案点下去之后，「other」的待决从 /api/interventions 消失（服务端事实）');
  ok(Boolean(await waitForEval(cdp, `(() => !document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"]') ? 1 : null)()`)),
    'B2 卡片本身也跟着收起（点候选答案即处理完毕，不需要再按「稍后」）');

  /* ═════════ A3：管家视角 → 无卡，且今天的收件箱行为不变 ═════════ */
  await setLens('steward');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.steward, message: 'ask about steward', cwd: workSteward }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.type === 'question' && item.sessionId === created.steward);
  }, token)), 'A3a 线程「steward」的待决已经产生（服务端事实，不受视角影响）');
  await sleep(6500); // 同上：反向计时要盖过至少一拍收件箱 tick
  const stewardSnap = await snapCards();
  ok(stewardSnap.mode === 'steward' && stewardSnap.count === 0,
    `A3b 管家视角下不出安静卡（实测视角 ${stewardSnap.mode}／${stewardSnap.count} 张）——在场门③`);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.steward);
    // row.wait 是 waitReasonFor() 的对象（{reason,label,...}），不是数字——判据看它是不是那一档。
    return Boolean(row) && Boolean(row.wait) && row.wait.reason === 'needs_you';
  }, token)), 'A3c 今天的收件箱行为不变：管家视角下这条线程照常在 /api/missions 里算「等你」（wait.reason===needs_you）');
  await setLens('classic');

  /* ═════════ C：「去看」＝ 换成那条会话，且视角仍是 classic ═════════ */
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.go, message: 'ask about go', cwd: workGo }, token, 600000);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.go}"]') ? 1 : null)()`)),
    'C0 线程「go」的安静卡出现了');
  await waitForEval(cdp, `(() => document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.go}"] .quiet-card-btn-go') ? 1 : null)()`, 200);
  await cdp.evaluate(`(() => { const b = document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.go}"] .quiet-card-btn-go'); if (b) b.click(); return Boolean(b); })()`);
  ok(Boolean(await waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${created.go}'
    && document.documentElement.getAttribute('data-shell-mode') === 'classic') ? 1 : null)()`)),
    'C1 「去看」把中栏换成了那条线程，且视角仍是 classic（不切视角）');
  ok(Boolean(await waitForEval(cdp, `(() => !document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.go}"]') ? 1 : null)()`)),
    'C2 「去看」之后那张卡自己收起（用户已经在看了，不用再提醒）');
  // 现在坐在 go 上了，给它答一下腾出这条线程（不影响后续断言，纯粹收尾干净）。
  const goPending = await request(appPort, 'GET', '/api/interventions?limit=100', null, token);
  const goIv = ((goPending.json && goPending.json.pending) || []).find(item => item.sessionId === created.go);
  if (goIv) {
    await request(appPort, 'POST', '/api/chat/answer', {
      sessionId: created.go, questionId: goIv.id,
      answers: [{ questionId: goIv.questions[0].id, selectedOptionIds: ['wait'] }],
    }, token);
  }
  // 切回坐在「seated」上，让接下来的 D/E 两组测试重新回到「工作台坐别的线程」这个前提。
  await openInWorkbench(created.seated);

  /* ═════════ D：同线程同类 5 分钟内第二条 → 仍是一张卡 ═════════
     用「other」这条线程再触发第二个待决（第一次已经被 B 回答掉，线程空出来了）。回合真正收尾
     （activeTurn 落回 false）之后才能开下一轮，否则第二发 /api/chat/stream 撞上一发还没收尾的
     那个 409（117s-G 那份互斥判据），静默无效。 */
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.other);
    return Boolean(row) && row.activeTurn !== true;
  }, token)), 'D0a 「other」的第一轮真正收尾（activeTurn 落回 false）');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.other, message: 'ask about second', cwd: workOther }, token, 600000);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"]') ? 1 : null)()`)),
    'D0 「other」第二次待决又出了一张卡（新的一次，不是残留）');
  const afterFirst = await snapCards();
  ok(afterFirst.cards.filter(c => c.sessionId === created.other).length === 1, 'D0b 此刻仍只有一张（第一张已在 B 阶段被候选答案收走）');
  // 再触发第三次——这一次在 5 分钟合并窗内，应该【原地更新】而不是新开一张。
  await request(appPort, 'POST', '/api/chat/answer', {
    sessionId: created.other,
    questionId: ((await request(appPort, 'GET', '/api/interventions?limit=100', null, token)).json.pending.find(i => i.sessionId === created.other) || {}).id,
    answers: [{ questionId: 'q_second', selectedOptionIds: ['wait'] }],
  }, token);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.other);
    return Boolean(row) && row.activeTurn !== true;
  }, token)), 'D0c 「other」的第二轮也真正收尾');
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.other, message: 'ask about third', cwd: workOther }, token, 600000);
  await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.sessionId === created.other && item.questionSummary && item.questionSummary.includes('third'));
  }, token);
  // 待决在服务端产生是【即时】的（registerIntervention 直接 emit thread.needs_you），但安静卡吃的
  // 是 inbox.appended——那一帧要等 13i 收件箱 tick（5 s 下限）跑过一拍才会派。等的是【计数变 2】
  // 这件事本身，不是猜一个够长的定长睡眠。
  ok(Boolean(await waitForEval(cdp, `(() => {
    const node = document.querySelector('#quietCardHost .quiet-card[data-session-id="${created.other}"] .quiet-card-count');
    return node && node.textContent === '2' ? 1 : null;
  })()`)), 'D1a 收件箱 tick 跑过一拍后，卡片计数徽标真的变成了 2');
  const merged = await snapCards();
  const otherCards = merged.cards.filter(c => c.sessionId === created.other);
  ok(otherCards.length === 1, `D1 同线程同类 5 分钟内第二条仍是一张卡（DOM 数 .quiet-card[session=other] = ${otherCards.length}）`);
  ok(otherCards[0] && otherCards[0].countBadge === '2', `D2 卡上的计数徽标更新为 2（实测「${otherCards[0] && otherCards[0].countBadge}」）`);

  /* ═════════ E：静默时段 → 不出卡，只更新左栏 ═════════ */
  await cdp.evaluate(`(() => {
    localStorage.setItem('wcw.notifyPolicy.v1', JSON.stringify({ version: 1, enabled: false, quietStart: '00:00', quietEnd: '23:59' }));
    return true;
  })()`);
  request(appPort, 'POST', '/api/chat/stream', { sessionId: created.quiet, message: 'ask about quiethours', cwd: workQuiet }, token, 600000);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/interventions?limit=100', result => {
    const pending = (result.json && result.json.pending) || [];
    return pending.some(item => item && item.sessionId === created.quiet);
  }, token)), 'E0 线程「quiet」的待决已经产生（服务端事实）');
  await sleep(6500); // 同上
  const quietSnap = await snapCards();
  ok(!quietSnap.cards.some(c => c.sessionId === created.quiet),
    `E1 静默时段覆盖此刻时不出安静卡（实测卡片 sessionId 列表 ${JSON.stringify(quietSnap.cards.map(c => c.sessionId))}）`);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === created.quiet);
    return Boolean(row) && Boolean(row.wait) && row.wait.reason === 'needs_you';
  }, token)), 'E2 只更新左栏：左栏取数的 /api/missions 那一行仍然照常算出「等你」（wait.reason===needs_you）');

  shots.final = path.join(shotDir, 'quiet-card-final.png');
  fs.writeFileSync(shots.final, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(`SHOT ${shots.final}`);
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

console.log(`\nQUIET CARD BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

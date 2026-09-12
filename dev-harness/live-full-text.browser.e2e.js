#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 真实浏览器 E2E(第 117 波 117m-A5 · 27 号文 §11.10):经典壳里「在途回合」那张临时气泡。
//
// 用户第六轮走查①「现在点开线程的看全文,还是啥也看不到」。这一件是本切片的【验收点】:
// 起一个【浏览器从没挂过流】的回合(管家派活就是这个形状),再在经典壳里打开这条线程,屏幕上必须
// 真的出现「它正在跑」那张气泡,里面有它这一回合说到现在的正文与正在用的工具;回合一结束,
// 气泡换成真消息,不留残影,表也停掉。
//
// 覆盖:
//   B 活回合:气泡出现、正文是真流出来的、「正在用」有工具名、有「停止」;
//     且此刻 state.currentSession.messages 里【一条助手消息都没有】—— 气泡不是消息,没污染数据面;
//   C 节拍:活着时恰好一处 3000ms 计时器;切去管家壳当拍停表(零后台活动),切回来又起;
//   D 收尾:回合结束后气泡消失、真助手消息落到屏幕上、3000ms 计时器归零。
// 与 steward-drawer.e2e.js 同一套 CDP 无头驱动。
//
// 117o-A7(用户第七轮走查,两张截图对照:「为啥这个查看全文,不能像 2.0 那样显示呢?第二张图是 2.0 的」):
// 这一件的【验收点】升级 —— 屏幕上不能再是一坨纯文本气泡,必须是 2.0 那套真实渲染:可折叠思考块、
// 工具卡(工具名 + 参数那一行 + 完成徽章)、本回合工具索引,而且纯文本兜底那一块要被藏起来
// (同一段话不许出现两遍)。新增 B9-B15。
//
// 117r-D4(用户第八轮走查④「2.0 视窗,为啥在运行时会显示这段对话是在一个框里,而不是普通 2.0 一样」):
// 虚线框与 max-height + overflow:auto 都撤掉之后,在途正文改成把【整页】撑长。新增 S 组守住随之而来的
// 唯一风险 —— 页面高度每 3 秒变一次,视口不许跟着跳:S1 页面真的被撑长了(不再是窗中窗)、S2 这两拍
// 确实在长(否则 S3/S4 是空断言)、S3 滚到中间等两拍原地不动、S4 在底部时继续跟随。
// 为此夹具也改了:HOLD_MS 30s→45s,且挂住的那段窗口改成【持续吐字】(修前是干等,活文本一字不变,
// paintLiveTurnNarrative 的签名判据整拍短路,S 组会变成空断言)。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD = '别处起的回合';
const THINK = '我先想一想:这件事得先看一眼现场,再下结论。';
const FIRST = '第一段:我先看一眼这件事的现场。';
const SECOND = '第二段:看完了,现在我把结论写下来。';
const FINAL = '第三段:这就是全部结论。';
const LIVE_TICK_MS = 3000;      // session-experience.js 的 LIVE_TURN_POLL_MS
// 117r-D4:观察窗从 30s 抬到 45s —— 新增的 S 组要在同一个活回合里滚两次、各等两拍(2×7.5s)。
const HOLD_MS = 45000;          // 回合在「说完第二段」之后还活着的时长(留够 B/S/C 三段断言的窗口)
// 117r-D4:挂住的这段时间里【持续吐字】。修前这一段是干等,活文本一个字都不变,于是
// paintLiveTurnNarrative 的签名判据整拍短路、根本不重绘 —— S 组会变成空断言(反向验证也红不了)。
// 每 2.5s 吐约 800 字(实测这一屏宽度下约 280px 高),比 3s 的轮询快一拍,保证每一拍看到的页面
// 都比上一拍高;吐 GROW_ROUNDS 轮就停(14×800≈11.2k 字,压在 02c 的 LIVE_TURN_SEGMENT_CHARS=12000
// 之下 —— 一旦触顶,服务端会从段的【头部】开始丢字,页面高度反而不再单调增,S 组就不成立了)。
const GROW_STEP_MS = 2500;
const GROW_ROUNDS = 14;
const GROW_LINE = i => `\n第 ${i + 1} 段过程记录:${'它还在一行行地往下说,页面就这样一拍一拍地变长。'.repeat(33)}`;
const SHORT_WAIT = 150;         // 「该发生的当拍就该发生」的等待上限(150×40ms = 6s):失败时不许把活回合的窗口耗光

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 20000,
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
async function waitForHttp(port, method, pathname, predicate, token, attempts = 200) {
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

// 确定性 provider:第一轮先流一段正文再要一次 file_read(read 档,自动放行);第二轮流第二段正文、
// 挂住 HOLD_MS 再说最后一段收尾 —— 那段挂住的时间就是「回合还活着」的观察窗口。
let probeFile = '';
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const answered = messages.some(m => m && m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => { try { res.write('data: ' + JSON.stringify(value) + '\n\n'); } catch { /* client gone */ } };
    const delta = text => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    if (!answered) {
      // 117o-A7:reasoning_content 会被 provider 引擎映射成 thinking_delta,于是账本里有一个 thinking 段,
      // 屏幕上就该出现 2.0 那个可折叠的「思考」块。这是本件新增断言 B10 的数据源。
      sse({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: THINK }, finish_reason: null }] });
      delta(FIRST);
      const args = JSON.stringify({ path: probeFile });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_live_ui', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      delta(SECOND);
      // 117r-D4:HOLD_MS 这段窗口不再是干等 —— 每 GROW_STEP_MS 吐一段,在途正文真的在长,
      // 于是 S 组量到的「页面高度每拍都在变」是真的,不是摆设。
      for (let i = 0; i < GROW_ROUNDS; i++) { await sleep(GROW_STEP_MS); delta(GROW_LINE(i)); }
      await sleep(Math.max(0, HOLD_MS - GROW_ROUNDS * GROW_STEP_MS));
      delta(FINAL);
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    }
    try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ }
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
async function waitForEval(cdp, expression, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; }
    catch { /* reload swaps execution context */ }
    await sleep(40);
  }
  return null;
}

// 121-K4（34 号文 §2.3 末条）：2.0 的会话列表由左栏的任务索引取代 —— 就绪判据跟着换成
// 「左栏 #railList 里真的画出了行」（行是 .steward-board-thread，三面共用的那枚卡基元）。
// 钉的那件事一个字没变：页面真的载完了，而且这条线程在左栏里看得见。
const READY = `(() => {
  if (!document.getElementById('railList') || !window.state || !window.state.status || !window.state.config) return null;
  if (!document.querySelectorAll('#railList .steward-board-thread').length) return null;
  return { ready: true };
})()`;

// 屏幕快照:全部走 textContent / class,不碰任何模块私有状态。
const SNAP = `(() => {
  const box = document.getElementById('messages');
  const row = box ? box.querySelector('[data-live="1"]') : null;
  const text = (node, sel) => { const found = node ? node.querySelector(sel) : null; return found ? found.textContent.trim() : ''; };
  const session = window.state && window.state.currentSession;
  return {
    shellMode: document.documentElement.getAttribute('data-shell-mode'),
    currentId: session ? String(session.id || '') : '',
    hasCard: Boolean(row),
    cardRole: row ? row.className : '',
    title: text(row, '.live-turn-title'),
    body: text(row, '.live-turn-body'),
    tool: text(row, '.live-turn-tool'),
    iter: text(row, '.live-turn-iter'),
    hasStop: Boolean(row && row.querySelector('.live-turn-stop')),
    liveRows: box ? box.querySelectorAll('[data-live="1"]').length : -1,
    realAssistantRows: box ? box.querySelectorAll('.message.assistant:not(.live-turn)').length : -1,
    realAssistantText: box ? [...box.querySelectorAll('.message.assistant:not(.live-turn)')].map(n => n.textContent).join(' ') : '',
    narrative: Boolean(row && row.querySelector('.live-turn-narrative .turn-narrative')),
    thinkingPanels: row ? row.querySelectorAll('.live-turn-narrative .thinking').length : -1,
    toolCards: row ? row.querySelectorAll('.live-turn-narrative .tool-card').length : -1,
    turnRecords: row ? row.querySelectorAll('.live-turn-narrative .turn-record').length : -1,
    toolName: text(row, '.live-turn-narrative .tool-card .tc-name'),
    toolArg: text(row, '.live-turn-narrative .tool-card .tc-arg'),
    toolStatus: text(row, '.live-turn-narrative .tool-card .tc-status'),
    narrativeText: text(row, '.live-turn-narrative'),
    bodyHidden: row && row.querySelector('.live-turn-body') ? row.querySelector('.live-turn-body').hidden : null,
    msgRoles: session && Array.isArray(session.messages) ? session.messages.map(m => m && m.role) : [],
    intervals: window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : [],
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-live-ui-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
probeFile = path.join(home, 'probe.txt');
fs.writeFileSync(probeFile, '现场看过了。', 'utf8');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: home, includeWorkbenchMcp: false, killOnDisconnect: false,
  autoImportClaudeCodeMcp: false,
  // 管家壳要能切过去(C2 要看「离开经典壳当拍停表」);它自己的节拍拉满,免得跟本件的 3000ms 表混。
  stewardEnabledV1: true, stewardPollMs: 120000,
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=200(200×80ms=16s)低于 30 号文 P1-31 建议的 300×同款间隔量级,是「FAIL workbench up」假红的根;默认值被本文件下方的业务断言调用复用,不能整体抬,这里改成显式传 300 只抬这一处(30 号文 P1-31)
  let token = '';
  for (let i = 0; i < 300 && !token; i++) { // 117q:预算 80×100ms=8s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD, cwd: home }, token);
  const sid = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sid), `A3 线程已建(${sid || '失败'})`);
  if (!sid) throw new Error('session fixture unavailable');

  const executable = browserPath();
  ok(Boolean(executable), 'A4 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A5 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 121-K2b(34 号文 §6.2):本件测的是这张气泡的【兜底那一路】—— 3000ms 表、切壳当拍停、切回来又起。
  // K2b 之后事件流一连上,那条路就【故意】不走了(推送比 3 s 一拍快,连着时 liveTurnPollable 直接
  // 为假,C1/C2/C3 会整组变成空断言)。所以这里把那一条路由挡掉,让本件继续钉它本来钉的那件事;
  // 连接正常时那张卡怎么更新,由新件 event-stream-client.browser.e2e.js 的 D0/D1 负责。
  // **只挡这一条路由**:别的请求照走,否则量到的是「整个后端没了」,兜底本身也就无从证明。
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/events/stream*'] });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      // 121 波 K0(34 号文 §8.4):默认入口翻成管家视角,而本件 B/S/C/D 四节测的全是【经典壳】的正文、
      // 阅读位置与节拍(C2 还要「从经典切去管家」才有意义)。壳层偏好在【预绘之前】就写死成 classic ——
      // 这段脚本比 index.html 的预绘脚本更早跑,于是管家壳一次都不进,也就不会在本件那 45 秒的活回合
      // 窗口里插一次到访回合去跟真回合抢同一个 fake provider(实测那样会让 D 组偶发红)。
      // 不自己写 data-shell-mode(唯一写入点是 applyShellMode,steward-shell.static A4 钉着),只写偏好。
      try { localStorage.setItem('wcw.shellMode', 'classic'); } catch (e) { /* storage unavailable */ }
      const live = new Map();
      const nativeSet = window.setInterval;
      const nativeClear = window.clearInterval;
      window.setInterval = function (handler, delay, ...rest) {
        const id = nativeSet.call(window, handler, delay, ...rest);
        live.set(id, Number(delay) || 0);
        return id;
      };
      window.clearInterval = function (id) { live.delete(id); return nativeClear.call(window, id); };
      window.__ruyiLiveIntervals = () => [...live.values()];
    })();`,
  });
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 经典壳载入,侧栏里有这条线程');
  ok(Boolean(await waitForEval(cdp, 'Array.isArray(window.__ruyiLiveIntervals && window.__ruyiLiveIntervals()) ? 1 : null')),
    'A7 计时器探针已装上');
  // 121 波 K0:上面那段预绘前注入把本机偏好写成 classic,这里只做验收 —— 它必须真的生效,
  // 否则 B/S/C/D 四节量的就不是经典壳了(A7b 红 = 那段注入被谁挪走/写错了键)。
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`)),
    'A7b 本机壳层偏好已在预绘前钉成经典(121-K0 起首开默认是管家视角,本件的经典壳判据要自己把偏好定下来)');

  /* ═════════ 起一个【浏览器从没挂过流】的回合 ═════════ */
  // 这才是管家派活的形状:发起方是另一个进程,浏览器这一侧一个字节都没收到过。
  {
    const raw = JSON.stringify({ sessionId: sid, message: '看一眼这件事', cwd: home });
    const req = http.request({
      host: '127.0.0.1', port: appPort, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token },
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.write(raw); req.end();
  }
  const liveOnServer = await waitForHttp(appPort, 'GET', `/api/sessions/${sid}`,
    result => Boolean(result.json && result.json.liveTail && String(result.json.liveTail.full || '')), token);
  ok(Boolean(liveOnServer), 'A8 服务端确认这一回合活着(信封里有 liveTail.full)');

  /* ═════════ B 打开线程:气泡真的出现 ═════════ */
  console.log('── B 经典壳打开这条线程 ──');
  // 121-K4：点的是左栏那一行（同一份 DOM 两视角共用；工作台视角点它＝openSession）。
  await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('#railList .steward-board-thread')]
      .find(node => node.textContent.includes(${JSON.stringify(THREAD)}));
    if (!item) return false;
    item.querySelector('.steward-board-thread-title').click();
    return true;
  })()`);
  // 治抖动那批附带发现(与 4 路超时同一件文件,重跑几次逮到过一次真红):`snapshot.body` 一开始
  // 就是真值 —— 客户端在正文真正流到之前先画一句占位文案(locale `chat.liveTurn.empty`「它还没
  // 说出正文……」),那也是【非空字符串】。原判据「有 body 就算气泡到位」在提示文案先于第一段
  // 真内容渲染出来的那一拍会提前满足,拿到的是占位帧;B3 紧跟着断言正文含 FIRST/SECOND 就假红。
  // 改成等【真内容】到位 —— 与 B3 判的是同一件事,不留中间的假阳性窗口。
  const live = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.hasCard && (snapshot.body.includes(${JSON.stringify(FIRST)}) || snapshot.body.includes(${JSON.stringify(SECOND)})) ? snapshot : null;
  })()`);
  ok(Boolean(live), `B1 屏幕上出现了「它正在跑」那张气泡(修前这里是一片空白)`);
  if (!live) throw new Error('live card never appeared');
  ok(live.currentId === sid, `B1b 打开的就是这条线程(${live.currentId})`);
  ok(live.title.includes('它正在跑'), `B2 气泡标题说清了这一回合是在别处起的(实测「${live.title}」)`);
  ok(live.body.includes(FIRST) || live.body.includes(SECOND),
    `B3 正文是这一回合真流出来的话(实测「${live.body.slice(0, 60)}」)`);
  ok(live.hasStop, 'B4 气泡上有「停止」');
  ok(live.liveRows === 1, `B5 屏幕上只有一张临时气泡(实测 ${live.liveRows} 张)`);
  // 本切片的数据面红线:气泡不是消息。
  ok(!live.msgRoles.includes('assistant'),
    `B6 这一刻 state.currentSession.messages 里一条助手消息都没有(实测 ${JSON.stringify(live.msgRoles)})`);
  ok(live.realAssistantRows === 0,
    `B6b 屏幕上也没有第二张假的「真消息」(实测 ${live.realAssistantRows} 条)`);
  const withTool = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.hasCard && snapshot.tool ? snapshot : null;
  })()`);
  ok(Boolean(withTool && withTool.tool.includes('file_read')),
    `B7 「正在用」写着工具名(实测「${withTool && withTool.tool}」)`);
  ok(Boolean(withTool && withTool.iter.includes('1')), `B8 轮次写着第 1 轮(实测「${withTool && withTool.iter}」)`);

  /* ═════════ 117o-A7:屏幕上必须是 2.0 那套真实渲染,不是一坨纯文本 ═════════ */
  // 这几条才是用户第七轮那两张截图的对照点。修前这张气泡里只有一个 .live-turn-body 纯文本块,
  // 下面每一条都会红。
  const shaped = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return (snapshot.hasCard && snapshot.toolCards > 0 && snapshot.toolStatus) ? snapshot : null;
  })()`);
  ok(Boolean(shaped && shaped.narrative),
    `B9 气泡里是【经典壳同一个渲染器】画出来的叙事容器 .turn-narrative(实测 ${Boolean(shaped && shaped.narrative)})`);
  ok(Boolean(shaped && shaped.thinkingPanels >= 1),
    `B10 屏幕上有可折叠的【思考块】(实测 ${shaped && shaped.thinkingPanels} 个)`);
  ok(Boolean(shaped && shaped.toolCards >= 1),
    `B11 屏幕上有【工具卡】,不是一行「正在用:X」的文字(实测 ${shaped && shaped.toolCards} 张)`);
  ok(Boolean(shaped && shaped.toolName.includes('file_read')),
    `B12 工具卡上写着工具名(实测「${shaped && shaped.toolName}」)`);
  ok(Boolean(shaped && shaped.toolArg.includes('probe')),
    `B13 工具卡上那一行是真参数(与落盘消息的工具卡同一个截断口径;实测「${shaped && shaped.toolArg}」)`);
  ok(Boolean(shaped && shaped.toolStatus && shaped.toolStatus !== '运行中'),
    `B14 工具跑完后卡上是【完成】徽章 —— 结果没下发也照样能诚实标终态(实测「${shaped && shaped.toolStatus}」)`);
  ok(Boolean(shaped && shaped.turnRecords >= 1),
    `B15 「本回合工具」索引卡也在(与落盘消息同源;实测 ${shaped && shaped.turnRecords} 张)`);
  ok(Boolean(shaped && shaped.bodyHidden === true),
    `B16 纯文本兜底那一块被藏起来了 —— 同一段话不会在屏幕上出现两遍(实测 hidden=${shaped && shaped.bodyHidden})`);
  ok(Boolean(shaped && shaped.narrativeText.includes(FIRST)),
    `B17 叙事里就是这一回合真流出来的话(实测「${shaped && shaped.narrativeText.slice(0, 40)}」)`);

  /* ═════════ S 117r-D4:去掉内滚动之后,视口不许跟着页面高度乱跳 ═════════ */
  // 用户第八轮走查④「2.0 视窗,为啥在运行时会显示这段对话是在一个框里,而不是普通 2.0 一样」。
  // 虚线框与 max-height + overflow:auto 撤掉之后,在途正文改成【把整页撑长】,于是每 3 秒一拍的
  // 整份重绘会真的改变 #messages 的 scrollHeight —— 这才是本刀真正的风险(修前那个 max-height 把
  // 高度变化关在盒子里,页面高度不变)。两条断言守住两种阅读姿势:滚上去看历史时原地不动、
  // 在底部时继续跟随。反向验证:把 paintLiveTurnCard() 里那对锚点去掉,S4 当场红。
  console.log('── S 在途刷新时的阅读位置 ──');
  const METRICS = `(() => {
    const box = document.getElementById('messages');
    return box ? { scrollTop: Math.round(box.scrollTop), scrollHeight: box.scrollHeight, clientHeight: box.clientHeight } : null;
  })()`;
  // 阈值 24px 的定法:正文行高约 22px(--fs-md 14px × 1.6 行距),一整行都跳不动才算「原地不动」;
  // 而两拍之间新长出来的正文有好几百 px(S2 把实测值打出来),真出问题时的漂移量远在这条线之上,
  // 所以 24px 既容得下亚像素取整,又不会把真跳漏过去。
  const DRIFT_MAX_PX = 24;
  // 治抖动那批(34 号文 §14 末条 · live-full-text 4 路超时):S 组原来三处都是【固定 sleep 再读一次】——
  // 「两拍 + 半拍余量必然已经长过」这句话只在机器空闲时成立。`--parallel 4/8` 下实测过:provider
  // 子进程与 CDP 往返都会被同跑的其它件挤慢,固定窗口读到的常是「还没来得及长」的那一帧,S2 判
  // 空断言、S3/S4 跟着算不出真漂移(实测过一次整件卡死在这一段,最终撞 120s 硬超时)——不是断言
  // 错,是等待方式错(等的是「时间到了没」,不是「事情发生了没」)。改成【有判据的等】:轮询到
  // scrollHeight 真的比基线大为止,不发生就到点判负,绝不无条件多睡。本件同时进了
  // run-all.js 的 PARALLEL_EXCLUSIVE(排在并行功能桶之后独占跑,见该文件头注新增的一条)——
  // GROW_ROUNDS×GROW_STEP_MS 是硬性的 35s 吐字窗口,独占之后不再有跨件争用,这里的预算只需要
  // 盖住机器自身的抖动余量,不用为「与另外几个 Edge/服务同抢 CPU」兜底。
  const GROW_WAIT_ATTEMPTS = 500;   // 500×40ms=20s:独占跑之后的安全边际(此前空闲单跑 S1/S2/S4 均 <8s)
  // 余量下限 600px 不是拍脑袋:滚到正中间时离底就是余量的一半,必须 >120px 才不落进
  // captureScrollAnchor 的「贴底」判据 —— 否则 S3 量到的是「跟随」而不是「原地不动」,是条假题。
  const tall = await waitForEval(cdp, `(() => {
    const m = ${METRICS};
    return (m && m.scrollHeight - m.clientHeight > 600) ? m : null;
  })()`, GROW_WAIT_ATTEMPTS);
  ok(Boolean(tall), `S1 在途正文把【整页】撑长了(可滚动余量 ${tall ? tall.scrollHeight - tall.clientHeight : 0}px) —— 不再是窗中窗`);
  const readAt = await cdp.evaluate(`(() => {
    const box = document.getElementById('messages');
    box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) / 2);
    return ${METRICS};
  })()`);
  const baselineHeight = readAt ? readAt.scrollHeight : 0;
  const readAfter = await waitForEval(cdp, `(() => {
    const m = ${METRICS};
    return (m && m.scrollHeight > ${baselineHeight}) ? m : null;
  })()`, GROW_WAIT_ATTEMPTS);
  ok(Boolean(readAt && readAfter && readAfter.scrollHeight > readAt.scrollHeight),
    `S2 页面确实变高了(${readAt && readAt.scrollHeight} → ${readAfter && readAfter.scrollHeight}px) —— 否则 S3 是条空断言`);
  const drift = (readAt && readAfter) ? Math.abs(readAfter.scrollTop - readAt.scrollTop) : -1;
  // 反向验证的实测结论(如实记在这里,免得后人高估这条):把 paintLiveTurnCard() 里那对锚点整个拿掉,
  // 这一条【仍然绿】—— 新正文全长在视口【下方】,而 replaceChildren 是一次性替换、中途不强制布局,
  // Chromium 不会把 scrollTop 夹回去,所以「中间」这个姿势本来就不动(实测漂移 0px)。
  // 真正咬住缺锚点的是下面的 S4(无锚点时离底 1247px)。这一条留着的意义是防【将来】的回归:
  // 谁把整份重绘改成「先清空再插入」(中间夹一次布局就会被 clamp),或让内容在视口上方发生变化,
  // 这一条会当场红。两条一起才是完整的守门人。
  ok(drift >= 0 && drift <= DRIFT_MAX_PX,
    `S3 等到页面真的长高了,视口原地不动(漂移 ${drift}px ≤ ${DRIFT_MAX_PX}px)`);
  await cdp.evaluate(`(() => { const box = document.getElementById('messages'); box.scrollTop = box.scrollHeight; return true; })()`);
  const beforeTail = await cdp.evaluate(METRICS);
  const beforeTailHeight = beforeTail ? beforeTail.scrollHeight : 0;
  const tailRead = await waitForEval(cdp, `(() => {
    const m = ${METRICS};
    return (m && m.scrollHeight > ${beforeTailHeight}) ? m : null;
  })()`, GROW_WAIT_ATTEMPTS) || await cdp.evaluate(METRICS);
  const gap = tailRead ? tailRead.scrollHeight - tailRead.scrollTop - tailRead.clientHeight : -1;
  ok(gap >= 0 && gap < 120,
    `S4 等到页面再长高一段之后仍贴着底(离底 ${gap}px < 120px,与 captureScrollAnchor 的同一个判据)`);

  /* ═════════ C 节拍:一处表,离开经典壳当拍停 ═════════ */
  console.log('── C 节拍与零后台活动 ──');
  const ticking = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.intervals.filter(ms => ms === ${LIVE_TICK_MS}).length === 1 ? snapshot : null;
  })()`, SHORT_WAIT);
  ok(Boolean(ticking), `C1 活回合期间恰好一处 ${LIVE_TICK_MS}ms 计时器(实测 ${JSON.stringify((ticking || live).intervals)})`);
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const parked = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.shellMode === 'steward' && snapshot.intervals.filter(ms => ms === ${LIVE_TICK_MS}).length === 0 ? snapshot : null;
  })()`, SHORT_WAIT);
  ok(Boolean(parked), 'C2 切去管家壳后经典壳这张表停掉(零后台活动)');
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'classic';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  // 121-K4-3：点行之前【必须】等属性真的落到 classic —— 切视角现在走 View Transitions，
  // 属性是在 update 回调里写的（比调用那一刻晚一帧）。而左栏行的点击语义是【现问视角】的：
  // 属性还是 steward 时点下去＝换管家焦点，不是在中栏打开它（实测 C3/D1–D4 五条连红）。
  // 这不是产品的时序问题（人点不了那么快），是夹具要等一下。
  await waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null)()`, SHORT_WAIT);
  // 切回来时 openSession 会被「2.0 视窗」那条路重走一遍;这里直接再点一次侧栏,等价且不依赖那条路。
  await cdp.evaluate(`(() => {
    const item = [...document.querySelectorAll('#railList .steward-board-thread')]
      .find(node => node.textContent.includes(${JSON.stringify(THREAD)}));
    if (item) item.querySelector('.steward-board-thread-title').click();
    return true;
  })()`);
  const back = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.shellMode === 'classic' && snapshot.hasCard
      && snapshot.intervals.filter(ms => ms === ${LIVE_TICK_MS}).length === 1 ? snapshot : null;
  })()`, SHORT_WAIT);
  ok(Boolean(back), 'C3 切回经典壳并重开线程后气泡与表都回来了');

  /* ═════════ D 回合结束:气泡换成真消息 ═════════ */
  console.log('── D 回合结束后收尾 ──');
  const settled = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return (!snapshot.hasCard && snapshot.realAssistantRows > 0) ? snapshot : null;
  })()`, 900);
  ok(Boolean(settled), 'D1 回合结束后临时气泡消失,真消息落到屏幕上');
  ok(Boolean(settled && settled.realAssistantText.includes(FINAL)),
    `D2 屏幕上的是这一回合的完整正文(含收尾那句;实测 ${settled && settled.realAssistantText.length} 字)`);
  ok(Boolean(settled && settled.liveRows === 0), `D3 零残影(data-live 节点 ${settled && settled.liveRows} 个)`);
  ok(Boolean(settled && settled.msgRoles.includes('assistant')),
    `D4 这时候正文才进 state.currentSession.messages(实测 ${JSON.stringify(settled && settled.msgRoles)})`);
  const stopped = await waitForEval(cdp, `(() => {
    const snapshot = ${SNAP};
    return snapshot.intervals.filter(ms => ms === ${LIVE_TICK_MS}).length === 0 ? snapshot : null;
  })()`);
  ok(Boolean(stopped), 'D5 回合结束后表自己停了(零后台活动)');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp && fail) console.log('CONSOLE ' + cdp.logs.slice(-6).join(' | '));
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nLIVE FULL TEXT BROWSER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

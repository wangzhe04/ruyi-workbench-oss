#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 真实浏览器 E2E（第 121 波 K7 · 34 号文 §2.3 末段／§2.6 末条／§7.2／§7.3／§8.4／§13.5 ③／§13.13 ②）。
//
// 本刀四件事，全部在真页面上量，读的是 DOM 与服务端事实，一个模块私有状态都不碰：
//   B 口袋（#railPocket）：恰四项、各可 Tab 到、各点一下真的落到对应面板（DOM 上目标可见 ＋
//     aria-selected／.active 的事实）、四枚按钮的文本与 title 零金额；
//   C 「记得的关于你」的「新」角标：24 小时内写过一条 → 出现；只有 48 小时前那条 → 不出现
//     （时间用夹具造，判据是服务端 13g 算的 counts.isNew，客户端不重算窗口）；
//   D 焦点栏「接下来」：零定时任务时整段不画（DOM 断言 hidden）；造五条（三条在未来、一条过去、
//     一条关掉的）→ 恰两行（上限截掉第三条）、按下次触发升序；口袋上的计数是总条数；
//   E ≤980 左栏折成图标栏时口袋只剩图标（短词与计数的盒子为 0×0，按钮与字形还在）；
//   F 右栏「项目与进度」七枚页签在 1920 下 ≤2 行（getBoundingClientRect().top 的集合 ≤2 个），
//     专家档与精简档各量一次；
//   G threadIndexRecent 的设置入口：在设置里改 → 服务端 config 真的变了，且**钳位在服务端**
//     （填 5 回来是 10 —— 客户端不抄第二份 [10,200]），UI 随后回填服务端给的那个数；
//   H 「不加第二条计时器」：口袋接进来之后，页面上 setInterval 的周期集合与既有那几条一致 ——
//     本件只钉「没有以 /api/scheduler/tasks 为目标的新节拍」这一半的可观测面：整个窗口期内
//     那条路由的请求数 ≤ 页面加载次数（打开时一发，此后靠推送与动作），静态那一半由
//     rail-pocket.static 的「setInterval 字面量零命中」钉。
//   I 118a 向导多一步「管家用哪个模型」（§8.4 拍板③）：**全新 HOME** 走完向导 → 落在
//     data-shell-mode="steward"，config.stewardModel 已写、onboarding.completedAt 已写。
//
// 定时任务的读面（GET /api/scheduler/tasks）**123 波 M1 起有生产者了**（37 号文 §3.3：13s 的六条
// 路由 + 01b 六条 token 档；原注写的「119 波零实现、实测 403」是 121-K7 那一刻的事实，A3 已随之翻转）。
// 本件仍然零后端：D 组的五条任务由页内一层 fetch 垫片按 localStorage 里的夹具应答 —— 垫片装在预绘之前
// （addScriptToEvaluateOnNewDocument），与 event-stream-client.browser 那一件的手法逐字同源。
// **没有夹具时垫片放行**，那一路现在走真后端（一张空表），于是 D1「零任务整段不画」量的仍然是
// 真实缺省行为，不是被伪造出来的空 —— 而且比从前更真：从前它量的是「读不到」，现在量的是「真没有」。
//
// 判定行：`RAIL POCKET BROWSER E2E: ALL PASS`
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
const PUBLIC = path.join(WB, 'app', 'public');
const zh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const SCHEDULE_FIXTURE_KEY = '__ruyiScheduleFixture';
const MEMORY_SCHEMA = 1;   // src/13j-steward-tool-base.js 的 STEWARD_MEMORY_SCHEMA
const DAY_MS = 86400000;

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
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 一句话就收的 provider（本件不测回合，只需要一个能起得来的端点）。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的。' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
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
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
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

// 预绘之前装的两件仪器：① /api/scheduler/tasks 的夹具垫片（没有夹具就放行，真 404 照旧）；
// ② 那条路由的请求计数（H 组要「口袋没给它开第二条节拍」这个可观测面）。
const INSTRUMENT = `(() => {
  const nativeFetch = window.fetch;
  window.__ruyiScheduleHits = 0;
  window.fetch = function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : String((input && input.url) || ''); } catch { url = ''; }
    if (url.indexOf('/api/scheduler/tasks') >= 0) {
      window.__ruyiScheduleHits += 1;
      let fixture = null;
      try { fixture = JSON.parse(localStorage.getItem(${JSON.stringify(SCHEDULE_FIXTURE_KEY)}) || 'null'); } catch { fixture = null; }
      if (fixture && Array.isArray(fixture.tasks)) {
        const now = Date.now();
        const tasks = fixture.tasks.map(item => ({
          id: item.id, name: item.name, enabled: item.enabled,
          nextRunAt: new Date(now + Number(item.inMs || 0)).toISOString(),
        }));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, tasks }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
    }
    return nativeFetch.apply(window, arguments);
  };
})();`;

const READY = `(() => {
  if (!window.state || !window.state.config) return null;
  if (document.documentElement.getAttribute('data-shell-mode') !== 'steward') return null;
  if (document.querySelectorAll('#railPocket .rail-pocket-item').length !== 4) return null;
  return { ready: true };
})()`;

// 口袋快照：只读 DOM。
const POCKET = `(() => {
  const items = [...document.querySelectorAll('#railPocket .rail-pocket-item')];
  return items.map(node => ({
    id: node.dataset.pocket || '',
    text: String(node.textContent || '').trim(),
    title: String(node.getAttribute('title') || ''),
    aria: String(node.getAttribute('aria-label') || ''),
    tabIndex: node.tabIndex,
    icons: node.querySelectorAll('svg.ic').length,
    label: String((node.querySelector('.rail-pocket-label') || {}).textContent || ''),
    count: String((node.querySelector('.rail-pocket-n') || {}).textContent || ''),
    badge: String((node.querySelector('.rail-pocket-new') || {}).textContent || ''),
    labelBox: (() => { const n = node.querySelector('.rail-pocket-label'); return n ? [n.offsetWidth, n.offsetHeight] : [-1, -1]; })(),
    box: [node.offsetWidth, node.offsetHeight],
  }));
})()`;

// 「接下来」住在右栏 #stewardSide 里（#stewardFocus 的兄弟）。所以**光看 section.hidden 不够**——
// 右栏自己在「一条线程都没有」时整块 [hidden]（steward-board.js 的 syncNow），那时候即使
// section.hidden===false 用户也一个字看不见。判据因此同时读 offsetParent（真的在屏幕上）。
// K7 实测过这一半：第一版夹具一条线程都不建，D3 在一块隐藏的右栏里量出「两行」并 PASS，
// 而 1920 实拍上右栏根本没画出来。
const UP_NEXT = `(() => {
  const section = document.getElementById('stewardUpNext');
  const rows = [...document.querySelectorAll('#stewardUpNextList .steward-upnext-row')];
  return {
    exists: Boolean(section),
    hidden: section ? section.hidden === true : null,
    visible: Boolean(section) && section.offsetParent !== null,
    sideShown: Boolean(document.getElementById('stewardSide')) && document.getElementById('stewardSide').hidden === false,
    rows: rows.map(node => String(node.textContent || '').trim()),
  };
})()`;

function memoryStore(entries) {
  return JSON.stringify({ schema: MEMORY_SCHEMA, updatedAt: new Date().toISOString(), entries });
}
function memoryEntry(id, agoMs) {
  const at = new Date(Date.now() - agoMs).toISOString();
  return { id, kind: 'preference', text: `夹具记忆 ${id}`, confidence: 0.9, sourceSessionId: '', sourceSeq: 0, createdAt: at, updatedAt: at, lastUsedAt: '', useCount: 0, state: 'active' };
}

function writeConfig(home, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 9, version: '2.4.0', engineMode: 'interactive',
    permissionMode: 'default', theme: 'dark', locale: 'zh-CN',
    defaultWorkspace: home, includeWorkbenchMcp: false, killOnDisconnect: false,
    autoImportClaudeCodeMcp: false, subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 15000, stewardThreadBriefV1: false,
    ...extra,
  }), 'utf8');
}

async function launchBrowser(executable, debugPort, profile, appUrl) {
  return cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1920,1080',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const wizardPort = await getFreePort();
const wizardDebugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rail-pocket-'));
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
const wizardHome = path.join(root, 'wizard-home');
const wizardProfile = path.join(root, 'wizard-profile');
fs.mkdirSync(home);
fs.mkdirSync(wizardHome);
writeConfig(home, {
  activeProvider: 'fake', stewardProviderId: 'fake', stewardModel: 'fake-model', uiMode: 'pro',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
});
// C 组第一半：只有一条【48 小时前】写的记忆 —— 服务端算出来的 counts.isNew 必须是 0。
fs.mkdirSync(path.join(home, 'steward'), { recursive: true });
fs.writeFileSync(path.join(home, 'steward', 'memory-v1.json'), memoryStore([memoryEntry('old-one', 2 * DAY_MS)]), 'utf8');

let provider = null;
let server = null;
let browser = null;
let cdp = null;
let wizardServer = null;
let wizardBrowser = null;
let wizardCdp = null;
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
  // 定时任务的读面今天真的不存在 —— 先把这条事实钉下来（D 组的「零任务」量的是它，不是被伪造的空）。
  // 实测是 403 而不是 404：01b-route-auth 的清册里没有这条路由，未登记的路径一律拒（fail-closed），
  // 拒在鉴权那一层就轮不到 404。读法因此按「不是 200」判 —— 前端那一侧 readScheduleTasks 也正是
  // 「api() 抛错就当零条」，两边对得上。
  // 一条真线程：右栏（#stewardSide）在「一条线程都没有」时整块收起，「接下来」就跟着看不见。
  // D 组要量的是【用户真能看见那两行】，所以夹具先给它一条线程当焦点。
  const seedThread = await request(appPort, 'POST', '/api/sessions', { title: '夹具线程', cwd: home }, token);
  ok(Boolean(seedThread && seedThread.json && seedThread.json.session && seedThread.json.session.id),
    'A2b 造了一条线程（右栏因此有焦点可画 —— 「接下来」跟它同住一栏）');
  // 123-M1（37 号文 §3.3）翻转：这条读面【现在有生产者了】。原来这里钉的是「今天 403，因为
  // 01b-route-auth 的清册里没有这条路由」——那是 121-K7 那一刻的事实，不是产品意图。本波把六条
  // 路由与 13s 的调度器接上之后，它回 200 且 tasks 是一个真数组（空表也算真数据）。
  // D 组要量的仍然是【前端拿到数据之后怎么画】，所以下面那套 localStorage 夹具垫片一字未动
  // （它拦在 window.fetch 上，比真后端更靠前）——本条只是把「后端有没有这个面」的事实钉住。
  const scheduleProbe = await request(appPort, 'GET', '/api/scheduler/tasks', null, token);
  ok(Boolean(scheduleProbe) && scheduleProbe.status === 200
    && scheduleProbe.json && scheduleProbe.json.ok === true && Array.isArray(scheduleProbe.json.tasks),
    `A3 GET /api/scheduler/tasks 有生产者了（123 波 M1；实测 HTTP ${scheduleProbe && scheduleProbe.status}，tasks ${scheduleProbe && scheduleProbe.json && Array.isArray(scheduleProbe.json.tasks) ? scheduleProbe.json.tasks.length + ' 条' : '不是数组'}）`);

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A4 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = await launchBrowser(executable, debugPort, profile, appUrl);
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A5 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 管家视角就绪且口袋已画出四项');

  /* ═════════ B 口袋本体 ═════════ */
  const pocket = await cdp.evaluate(POCKET);
  ok(Array.isArray(pocket) && pocket.length === 4
    && pocket.map(item => item.id).join(',') === 'schedule,decisions,memory,doctor',
    `B1 口袋恰四项、顺序固定（§2.3：定时任务／行动流水／记得的关于你／体检 · 用量；实测 ${JSON.stringify(pocket.map(i => i.id))}）`);
  ok(pocket.every(item => item.icons === 1 && item.label.length > 0),
    `B2 每一项都是「字形 ＋ 短词」（实测 ${JSON.stringify(pocket.map(i => [i.icons, i.label]))}）`);
  const focusable = await cdp.evaluate(`(() => {
    const items = [...document.querySelectorAll('#railPocket .rail-pocket-item')];
    return items.map(node => { node.focus(); return document.activeElement === node; });
  })()`);
  ok(Array.isArray(focusable) && focusable.length === 4 && focusable.every(Boolean),
    `B3 四项各可 Tab 到（.focus() 之后就是 activeElement；实测 ${JSON.stringify(focusable)}）`);
  // 零金额（§7.2）：按钮上看得见的字与 title／aria-label 三处一起扫。
  const MONEY = /¥|\$[0-9]|费用|(?<![A-Za-z])cost(?![A-Za-z])/i;
  const moneyHits = pocket.filter(item => MONEY.test(item.text) || MONEY.test(item.title) || MONEY.test(item.aria));
  ok(moneyHits.length === 0,
    `B4 四枚按钮的文本与 title 零金额（§7.2；实测命中 ${JSON.stringify(moneyHits.map(i => [i.id, i.text, i.title]))}）`);
  ok(pocket[0].label === zh['rail.pocket.schedule'] && pocket[3].label === zh['rail.pocket.doctor'],
    `B5 短词走目录（实测「${pocket[0].label}」「${pocket[3].label}」）`);

  /* ═════════ B6–B9 deep link：点一下真的落到那一面 ═════════ */
  const clickPocket = async id => cdp.evaluate(`(async () => {
    const node = document.querySelector('#railPocket .rail-pocket-item[data-pocket=${JSON.stringify(id)}]');
    if (!node) return null;
    node.click();
    await new Promise(r => setTimeout(r, 120));
    // 慢机器上弹层开合与状态刷新都可能晚几拍：最多再等 1.5 s，等三段之一真的落到位（体检那一条不开管家页，不等）。
    const landedAny = () => ['cfgStewardGroupSchedule', 'cfgStewardGroupMemory', 'cfgStewardGroupDecisions'].some(id => {
      const g = document.getElementById(id); if (!g) return false; const r = g.getBoundingClientRect();
      return r.top >= 0 && (r.top < innerHeight * 0.6 || r.bottom <= innerHeight) && g.contains(document.activeElement);
    });
    if (${JSON.stringify(id)} !== 'doctor') for (let i = 0; i < 15 && !landedAny(); i++) await new Promise(r => setTimeout(r, 100));
    const modal = document.getElementById('settingsModal');
    const tab = document.querySelector('#settingsTabs button[data-stab="steward"]');
    const doctorTab = document.querySelector('#settingsTabs button[data-stab="doctor"]');
    const usageTab = document.querySelector('.tool-pane .tool-tabs button[data-tab="usage"]');
    const visible = elm => Boolean(elm) && elm.offsetParent !== null;
    // 「可见」只说明没被 display:none，走查实测三个入口都停在页首、目标段在 1957 px 之下也照样算「可见」。
    // 这里再量一把真落点：段落顶边进了视口上半部分（或整段都在视口里），且焦点就在这一段里。
    const landed = id => { const g = document.getElementById(id); if (!g) return false; const r = g.getBoundingClientRect();
      return r.top >= 0 && (r.top < innerHeight * 0.6 || r.bottom <= innerHeight) && g.contains(document.activeElement); }; // 末段滚不到顶，整段在视口里也算
    return {
      scheduleLanded: landed('cfgStewardGroupSchedule'),
      memoryLanded: landed('cfgStewardGroupMemory'),
      decisionsLanded: landed('cfgStewardGroupDecisions'),
      settingsOpen: Boolean(modal) && !modal.classList.contains('hidden'),
      stewardTabActive: Boolean(tab) && tab.classList.contains('active'),
      doctorTabActive: Boolean(doctorTab) && doctorTab.classList.contains('active'),
      stewardPanelShown: visible(document.getElementById('stab-steward')),
      doctorPanelShown: visible(document.getElementById('stab-doctor')),
      scheduleGroup: visible(document.getElementById('cfgStewardGroupSchedule')),
      memoryGroup: visible(document.getElementById('cfgStewardGroupMemory')),
      decisionsGroup: visible(document.getElementById('cfgStewardGroupDecisions')),
      powerGroup: visible(document.getElementById('cfgStewardGroupPower')),
      onlyBar: (document.querySelector('#stab-steward > .steward-only-bar') || {}).textContent || '',
      usageTabSelected: Boolean(usageTab) && usageTab.getAttribute('aria-selected') === 'true',
      usageSectionActive: Boolean(document.querySelector('#tab-usage.active')),
      lens: document.documentElement.getAttribute('data-shell-mode') || '',
    };
  })()`);
  const closeSettings = async () => cdp.evaluate(`(() => {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('hidden');
    return true;
  })()`);

  const onSchedule = await clickPocket('schedule');
  ok(Boolean(onSchedule) && onSchedule.settingsOpen && onSchedule.stewardTabActive && onSchedule.scheduleGroup,
    `B6 「定时任务」→ 设置·管家页的定时任务组可见（实测 ${JSON.stringify(onSchedule)}）`);
  ok(Boolean(onSchedule) && onSchedule.scheduleLanded, `B6b 「定时任务」直接落到定时任务那一段（段顶进视口、焦点在段内；修前停在页首「管家总开关」）`);
  // 走查 #6：左栏入口打开的是「只看这一块」—— 其余段落收起，顶上一条说明 ＋「显示全部」。
  ok(Boolean(onSchedule) && !onSchedule.powerGroup && !onSchedule.memoryGroup && !onSchedule.decisionsGroup
    && onSchedule.onlyBar.includes('只看') && onSchedule.onlyBar.includes('显示全部管家设置'),
    `B6c 只看「定时任务」：其余段落收起、顶上有说明与「显示全部」（实测 ${JSON.stringify(onSchedule && { power: onSchedule.powerGroup, memory: onSchedule.memoryGroup, bar: onSchedule.onlyBar })}）`);
  const showAll = await cdp.evaluate(`(() => {
    const btn = document.querySelector('#stab-steward > .steward-only-bar .steward-only-all'); if (!btn) return null;
    btn.click();
    const visible = elm => Boolean(elm) && elm.offsetParent !== null;
    return { power: visible(document.getElementById('cfgStewardGroupPower')), memory: visible(document.getElementById('cfgStewardGroupMemory')), bar: Boolean(document.querySelector('#stab-steward > .steward-only-bar')) };
  })()`);
  ok(Boolean(showAll) && showAll.power && showAll.memory && !showAll.bar, `B6d 点「显示全部管家设置」→ 整页回来（实测 ${JSON.stringify(showAll)}）`);
  await closeSettings();
  await clickPocket('schedule');
  const afterSwitch = await cdp.evaluate(`(() => {
    document.querySelector('#settingsTabs button[data-stab="security"]').click();
    document.querySelector('#settingsTabs button[data-stab="steward"]').click();
    const visible = elm => Boolean(elm) && elm.offsetParent !== null;
    return { power: visible(document.getElementById('cfgStewardGroupPower')), bar: Boolean(document.querySelector('#stab-steward > .steward-only-bar')) };
  })()`);
  ok(Boolean(afterSwitch) && afterSwitch.power && !afterSwitch.bar, `B6e 切走再切回「管家」页签 → 整页（「只看」只活到下一次切页签；实测 ${JSON.stringify(afterSwitch)}）`);
  await closeSettings();
  const onDecisions = await clickPocket('decisions');
  ok(Boolean(onDecisions) && onDecisions.settingsOpen && onDecisions.stewardTabActive && onDecisions.decisionsGroup,
    `B7 「行动流水」→ 设置·管家页的行动流水组可见（实测 stewardTab=${onDecisions && onDecisions.stewardTabActive}）`);
  ok(Boolean(onDecisions) && onDecisions.decisionsLanded, `B7b 「行动流水」直接落到行动流水那一段`);
  await closeSettings();
  const onMemory = await clickPocket('memory');
  ok(Boolean(onMemory) && onMemory.settingsOpen && onMemory.stewardTabActive && onMemory.memoryGroup,
    `B8 「记得的关于你」→ 设置·管家页的记忆组可见（实测 stewardTab=${onMemory && onMemory.stewardTabActive}）`);
  ok(Boolean(onMemory) && onMemory.memoryLanded, `B8b 「记得的关于你」直接落到记忆那一段`);
  await closeSettings();
  // B7c 慢机器复现（Windows CI 上 B7b 的真根）：三块列表的请求还没回包就点「行动流水」。落点那一刻列表都空着，
  // 回包之后列表画出来、段落被挤下去／撑长，末段就停在视口下半截。这里在页面里把那三块列表与 /api/steward/state
  // 的回包压 900 ms —— 管家抽屉的启动也等 state，压了它抽屉就晚开：修前它会把焦点从设置页拽到抽屉标题上（Windows CI 实测）。
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'B7c0 重载之后口袋重新画出四项');
  await cdp.evaluate(`(() => {
    const orig = window.fetch;
    window.fetch = function (input) {
      const url = String((input && input.url) || input);
      const p = orig.apply(this, arguments);
      return /\\/api\\/(steward\\/(memory|decisions|state)|scheduler\\/tasks)/.test(url) ? p.then(r => new Promise(res => setTimeout(() => res(r), 900))) : p;
    };
    return true;
  })()`);
  await clickPocket('decisions');
  await sleep(1800);   // 900 ms 回包 ＋ 重画
  const slowDecisions = await cdp.evaluate(`(() => {
    const g = document.getElementById('cfgStewardGroupDecisions'); if (!g) return null;
    const r = g.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), ih: innerHeight, focusIn: g.contains(document.activeElement), active: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "",
      rows: document.querySelectorAll('#cfgStewardSchedule tr, #cfgStewardSchedule li, #cfgStewardDecisions tr').length };
  })()`);
  ok(Boolean(slowDecisions) && slowDecisions.focusIn && slowDecisions.top >= 0 && (slowDecisions.top < slowDecisions.ih * 0.6 || slowDecisions.bottom <= slowDecisions.ih),
    `B7c 列表晚到之后「行动流水」仍停在那一段（实测 ${JSON.stringify(slowDecisions)}）`);
  await closeSettings();
  const onDoctorSteward = await clickPocket('doctor');
  ok(Boolean(onDoctorSteward) && onDoctorSteward.settingsOpen && onDoctorSteward.doctorTabActive && onDoctorSteward.doctorPanelShown,
    `B9 管家视角「体检 · 用量」→ 设置的体检页（§7.2 两视角两条路的管家那一条；实测 doctorTab=${onDoctorSteward && onDoctorSteward.doctorTabActive}）`);
  await closeSettings();
  // 工作台视角那一条路：右栏「用量」页签。
  await cdp.evaluate(`(() => { document.querySelector('#lensSeg [data-lens="classic"]').click(); return true; })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
  const onDoctorClassic = await clickPocket('doctor');
  ok(Boolean(onDoctorClassic) && onDoctorClassic.lens === 'classic'
    && onDoctorClassic.usageTabSelected && onDoctorClassic.usageSectionActive && !onDoctorClassic.settingsOpen,
    `B10 工作台视角「体检 · 用量」→ 右栏「用量」页签（aria-selected=true ＋ #tab-usage.active，不开设置弹层；实测 ${JSON.stringify(onDoctorClassic)}）`);

  /* ═════════ F 右栏七枚页签 1920 下 ≤2 行 ═════════ */
  const rowsOfTabs = `(() => {
    const buttons = [...document.querySelectorAll('.tool-pane .tool-tabs button')]
      .filter(node => node.offsetParent !== null);
    const tops = [...new Set(buttons.map(node => Math.round(node.getBoundingClientRect().top)))];
    return { visible: buttons.length, rows: tops.length, width: Math.round(document.getElementById('toolPane').getBoundingClientRect().width) };
  })()`;
  const proTabs = await cdp.evaluate(rowsOfTabs);
  ok(Boolean(proTabs) && proTabs.visible === 7 && proTabs.rows <= 2,
    `F1 专家档：右栏 ${proTabs && proTabs.width}px 里七枚页签 ${proTabs && proTabs.rows} 行（§13.13 K8 登记②：折三行归本刀；判据 ≤2）`);
  // 设属性与量放在同一次同步求值里：分两拍的话，应用自己的状态刷新（applyUiMode 按配置写回 pro）可能恰好落在
  // 中间，量到的就是专家档的 7 枚（CI 上实测过一次「看得见的 7 枚」）。
  const simpleTabs = await cdp.evaluate(`(() => { document.documentElement.setAttribute('data-ui-mode', 'simple'); return ${rowsOfTabs}; })()`);
  ok(Boolean(simpleTabs) && simpleTabs.visible === 5 && simpleTabs.rows <= 2,
    `F2 精简档：看得见的 ${simpleTabs && simpleTabs.visible} 枚排 ${simpleTabs && simpleTabs.rows} 行（判据 ≤2）`);
  await cdp.evaluate(`(() => { document.documentElement.setAttribute('data-ui-mode', 'pro'); return true; })()`);
  await sleep(120);

  /* ═════════ G threadIndexRecent 的设置入口（§13.5 登记③）═════════ */
  const setIndexRecent = async value => cdp.evaluate(`(async () => {
    const input = document.getElementById('cfgStewardThreadIndexRecent');
    if (!input) return null;
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    return { value: input.value };
  })()`);
  await cdp.evaluate(`(() => { const m = document.getElementById('settingsModal'); if (m) m.classList.remove('hidden'); return true; })()`);
  const seeded = await cdp.evaluate(`(() => {
    const input = document.getElementById('cfgStewardThreadIndexRecent');
    return input ? { exists: true, value: input.value, min: input.min, max: input.max } : { exists: false };
  })()`);
  ok(Boolean(seeded) && seeded.exists && seeded.value === '30',
    `G1 设置里有那个数字框且播种成缺省 30（实测 ${JSON.stringify(seeded)}）`);
  await setIndexRecent(12);
  const at12 = await waitForHttp(appPort, 'GET', '/api/status', r => Number(r.json && r.json.config && r.json.config.threadIndexRecent) === 12, token, 60);
  ok(Boolean(at12), 'G2 改成 12 → 服务端 config.threadIndexRecent 真的是 12（唯一写口 POST /api/config）');
  // **钳位在服务端**：填 5 回来是 10（客户端不抄第二份 [10,200]，01-config 的 THREAD_INDEX_RECENT_MIN 说了算）。
  await setIndexRecent(5);
  const at5 = await waitForHttp(appPort, 'GET', '/api/status', r => Number(r.json && r.json.config && r.json.config.threadIndexRecent) === 10, token, 60);
  ok(Boolean(at5), 'G3 填 5 → 服务端钳到下限 10（区间只有 src/01-config.js 一份，客户端不重写）');
  const refilled = await waitForEval(cdp, `(() => {
    const input = document.getElementById('cfgStewardThreadIndexRecent');
    return input && input.value === '10' ? { value: input.value } : null;
  })()`, 80);
  ok(Boolean(refilled), `G4 UI 随后回填服务端钳过的那个数（实测 ${refilled && refilled.value}）`);
  await closeSettings();
  await cdp.evaluate(`(() => { document.querySelector('#lensSeg [data-lens="steward"]').click(); return true; })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);

  /* ═════════ D1 「接下来」：零定时任务时整段不画 ═════════ */
  // 123 合并复核（主会话）：`data-shell-mode` 变成 steward 只说明属性写下了，右栏（#stewardSide）
  // 还没露出来 —— steward-board.js 的 enterSteward() 是 fire-and-forget，要 loadMissions()＋
  // loadArbiter() 两趟往返都回来才 syncNow() 把它翻出来。此前这里读得太早，D1 的 sideShown
  // 约 1/3 概率读到 false（本机直跑 3 次红 1 次、run-all 3 次红 2 次；实测
  // {"exists":true,"hidden":true,"visible":false,"sideShown":false,"rows":[]} —— 另外四项都对，
  // 只差它）。与 122-M3 在 one-workbench-frame C1b 抓到的是同一个模具：等它露出来再读。
  await waitForEval(cdp, `(() => { const s = document.getElementById('stewardSide'); return s && s.hidden === false ? 1 : null; })()`);
  const upNextEmpty = await cdp.evaluate(UP_NEXT);
  ok(Boolean(upNextEmpty) && upNextEmpty.exists && upNextEmpty.sideShown === true
    && upNextEmpty.hidden === true && upNextEmpty.visible === false && upNextEmpty.rows.length === 0,
    `D1 零定时任务 → 「接下来」整段不画（§2.6；实测 ${JSON.stringify(upNextEmpty)}）`);
  const pocketNoSchedule = await cdp.evaluate(POCKET);
  ok(pocketNoSchedule[0].count === '',
    `D2 零任务时口袋上的计数也不印（实测「${pocketNoSchedule[0].count}」）`);

  /* ═════════ C 「新」角标：先 48 小时前那条 ═════════ */
  const pocketOldMemory = await cdp.evaluate(POCKET);
  ok(pocketOldMemory[2].badge === '',
    `C1 只有 48 小时前写的那条记忆 → 不出「新」（判据是服务端 13g 的 counts.isNew；实测「${pocketOldMemory[2].badge}」）`);
  const memoryOld = await request(appPort, 'GET', '/api/steward/memory', null, token);
  ok(Boolean(memoryOld) && memoryOld.json && memoryOld.json.counts && memoryOld.json.counts.total === 1 && memoryOld.json.counts.isNew === 0,
    `C1b 服务端那一头：1 条记忆、isNew=0（实测 ${JSON.stringify(memoryOld && memoryOld.json && memoryOld.json.counts)}）`);

  /* ═════════ C2 写一条【刚刚】的记忆 → 角标出现 ═════════ */
  fs.writeFileSync(path.join(home, 'steward', 'memory-v1.json'),
    memoryStore([memoryEntry('old-one', 2 * DAY_MS), memoryEntry('fresh-one', 60000)]), 'utf8');
  const memoryFresh = await waitForHttp(appPort, 'GET', '/api/steward/memory', r => Number(r.json && r.json.counts && r.json.counts.isNew) === 1, token, 60);
  ok(Boolean(memoryFresh), 'C2a 服务端那一头：24 小时内那条把 counts.isNew 抬到 1');
  // D 组的夹具与 C2 一起装（同一次重载生效）：两条在未来、一条已过去、一条关掉的。
  await cdp.evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(SCHEDULE_FIXTURE_KEY)}, JSON.stringify({ tasks: [
      { id: 't-weekly', name: '写周报', enabled: true, inMs: 2 * 3600000 },
      { id: 't-backup', name: '备份工作区', enabled: true, inMs: 30 * 60000 },
      { id: 't-third', name: '第三件事', enabled: true, inMs: 5 * 3600000 },
      { id: 't-past', name: '已经过去的', enabled: true, inMs: -3600000 },
      { id: 't-off', name: '关掉的', enabled: false, inMs: 10 * 60000 }
    ] }));
    return true;
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'C2b 重载之后口袋重新画出四项');
  const pocketFresh = await waitForEval(cdp, `(() => {
    const badge = document.querySelector('#railPocket .rail-pocket-item[data-pocket="memory"] .rail-pocket-new');
    return badge && badge.textContent ? { badge: badge.textContent, title: document.querySelector('#railPocket .rail-pocket-item[data-pocket="memory"]').getAttribute('title') } : null;
  })()`, 120);
  ok(Boolean(pocketFresh) && pocketFresh.badge === zh['rail.pocket.new'],
    `C3 「记得的关于你」出现「新」角标（实测「${pocketFresh && pocketFresh.badge}」，可访问名「${pocketFresh && pocketFresh.title}」）`);

  /* ═════════ D3 「接下来」：造四条 → 恰两行、按下次触发升序 ═════════ */
  const upNextFilled = await waitForEval(cdp, `(() => {
    const rows = [...document.querySelectorAll('#stewardUpNextList .steward-upnext-row')];
    if (rows.length !== 2) return null;
    const snapshot = ${UP_NEXT};
    return snapshot.visible ? snapshot : null;
  })()`, 160);
  ok(Boolean(upNextFilled) && upNextFilled.hidden === false && upNextFilled.visible === true && upNextFilled.rows.length === 2,
    `D3 五条任务（其中三条在未来）→ 「接下来」恰两行（§2.6「最近两条」——第三条被上限截掉；实测 ${JSON.stringify(upNextFilled && upNextFilled.rows)}）`);
  ok(Boolean(upNextFilled) && upNextFilled.rows[0].startsWith('备份工作区') && upNextFilled.rows[1].startsWith('写周报'),
    `D4 按下次触发时间升序（30 分钟那条在 2 小时那条前面），且已过去与关掉的两条都不进（实测 ${JSON.stringify(upNextFilled && upNextFilled.rows)}）`);
  ok(Boolean(upNextFilled) && upNextFilled.rows.every(text => text.includes(' · ')),
    'D5 每行印「名字 · 相对时间」（§2.6 的形状）');
  const pocketWithSchedule = await waitForEval(cdp, `(() => {
    const n = document.querySelector('#railPocket .rail-pocket-item[data-pocket="schedule"] .rail-pocket-n');
    return n && n.textContent ? { count: n.textContent } : null;
  })()`, 120);
  ok(Boolean(pocketWithSchedule) && pocketWithSchedule.count === '5',
    `D6 口袋上的数量＝定时任务总条数（不是「接下来」那两条；实测「${pocketWithSchedule && pocketWithSchedule.count}」）`);

  /* ═════════ H 没给 /api/scheduler/tasks 开第二条节拍 ═════════ */
  const hitsBefore = await cdp.evaluate('window.__ruyiScheduleHits');
  await sleep(12000);   // 抽屉那条兜底表最短 5 s 一拍；12 s 足够跑过两拍
  const hitsAfter = await cdp.evaluate('window.__ruyiScheduleHits');
  ok(hitsAfter === hitsBefore,
    `H1 12 秒静置期内 /api/scheduler/tasks 零新请求（口袋与「接下来」都不挂计时器；实测 ${hitsBefore} → ${hitsAfter}）`);

  /* ═════════ J 右栏抽屉的【边界】：1181 还在栅格里，1180 就成抽屉（§7.3／§10 ⑥）═════════
     整波验收 §10 ⑥ 写的是「1180 宽右栏成抽屉」，可 K4 那一件量的是 1200（还在栅格）与 900
     （已经是抽屉）——**边界那一格没人钉**。补在这里：同一次页面里前后差 1px 各量一次，
     判据是「右栏的左缘有没有被推到布局视口之外」（抽屉态 translateX(100%) 的可观测后果）
     ＋ 顶栏那枚「右栏」钮出没出来。反向：把 layout.css 的 1180 改成 1179 → J2 当场红。 */
  const paneAt = async width => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(220);
    return cdp.evaluate(`(() => {
      const pane = document.getElementById('toolPane');
      const toggle = document.getElementById('appSideToggleBtn');
      const box = pane ? pane.getBoundingClientRect() : null;
      return {
        left: box ? Math.round(box.left) : -1,
        vw: Math.round(document.documentElement.clientWidth),
        toggle: toggle ? getComputedStyle(toggle).display : '',
      };
    })()`);
  };
  await cdp.evaluate(`(() => { document.querySelector('#lensSeg [data-lens="classic"]').click(); return true; })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
  const at1181 = await paneAt(1181);
  ok(Boolean(at1181) && at1181.left < at1181.vw - 100 && at1181.toggle === 'none',
    `J1 1181：右栏仍在栅格里（left=${at1181 && at1181.left} < 视口 ${at1181 && at1181.vw}），顶栏没有「右栏」钮`);
  // 换到抽屉态那一下 transform 是有过渡的（--dur-slow），量早了会读到半路上的位置
  // （K7 实测：220 ms 时 left=1168，差 12px 就是那一帧还没走完）。所以这里【等到位】再判。
  // Windows CI 负载高时 2 s 内一帧都没出（left 停在起点 788）：量之前把右栏自己的过渡 finish() 到终点，
  // 判的就是抽屉态的【终值】而不是动画帧率。
  let at1180 = await paneAt(1180);
  for (let i = 0; i < 40 && at1180 && at1180.left < at1180.vw - 1; i++) {
    await sleep(50);
    at1180 = await cdp.evaluate(`(() => {
      const pane = document.getElementById('toolPane');
      if (pane && pane.getAnimations) pane.getAnimations().forEach(a => { try { a.finish(); } catch {} });
      const toggle = document.getElementById('appSideToggleBtn');
      const box = pane ? pane.getBoundingClientRect() : null;
      return { left: box ? Math.round(box.left) : -1, vw: Math.round(document.documentElement.clientWidth),
        toggle: toggle ? getComputedStyle(toggle).display : '' };
    })()`);
  }
  ok(Boolean(at1180) && at1180.left >= at1180.vw - 1 && at1180.toggle !== 'none',
    `J2 1180：右栏离开栅格、滑到屏幕外等着（left=${at1180 && at1180.left} ≥ 视口 ${at1180 && at1180.vw}），顶栏出「右栏」钮（display=${at1180 && at1180.toggle}）`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(220);
  await cdp.evaluate(`(() => { document.querySelector('#lensSeg [data-lens="steward"]').click(); return true; })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);

  /* ═════════ E ≤980：口袋只剩图标 ═════════ */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(250);
  const narrow = await cdp.evaluate(POCKET);
  ok(Array.isArray(narrow) && narrow.length === 4
    && narrow.every(item => item.icons === 1 && item.box[0] > 0 && item.labelBox[0] === 0 && item.labelBox[1] === 0),
    `E1 ≤980 图标栏：四枚按钮与字形还在、短词的盒子 0×0（§7.3；实测 ${JSON.stringify(narrow.map(i => [i.box, i.labelBox]))}）`);
  ok(narrow.every(item => item.title.length > 0),
    'E2 收起字之后可访问名仍在 title 上（图标不作唯一信号，F5a 纪律）');
  // 走查 #18：图标栏里每一行只剩一颗色点、标题收起 —— 悬停那颗点（行头）要说得出是哪一条。
  const dots = await cdp.evaluate(`[...document.querySelectorAll('#railList .steward-board-thread-head')]
    .filter(h => h.getBoundingClientRect().width > 0)
    .map(h => ({ title: h.title, name: (h.querySelector('.steward-board-thread-title') || {}).textContent || '' }))`);
  ok(Array.isArray(dots) && dots.length > 0 && dots.every(d => d.title && d.title === d.name),
    `E3 ≤980 每颗色点悬停都说得出是哪一条（行头 title＝显示名；实测 ${JSON.stringify(dots)}）`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(250);

  /* ═════════ 两张 1920 实拍 ═════════ */
  const shoot = async (name, expression) => {
    if (expression) { await cdp.evaluate(expression); await sleep(400); }
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(shotDir, name);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('#   screenshot ' + file);
    return file;
  };
  await shoot('k7-steward-1920.png', `(() => { document.querySelector('#lensSeg [data-lens="steward"]').click(); return true; })()`);
  await shoot('k7-classic-1920.png', `(() => { document.querySelector('#lensSeg [data-lens="classic"]').click(); return true; })()`);

  /* ═════════ I 118a 向导多一步「管家用哪个模型」（全新 HOME）═════════ */
  wizardServer = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wizardPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: wizardHome, WIN_CLAUDE_WORKBENCH_HOME: wizardHome, HOME: wizardHome, USERPROFILE: wizardHome },
    windowsHide: true, stdio: 'ignore',
  });
  // 全新 HOME 首启会跑 detectDesktopMcp 那几发 python 探针（§13.10 的产品债），门放到 30 s。
  ok(Boolean(await waitForHttp(wizardPort, 'GET', '/health', r => r.status === 200, undefined, 300)), 'I1 全新 HOME 的 workbench 起来了');
  let wizardToken = '';
  for (let i = 0; i < 300 && !wizardToken; i++) {
    try { wizardToken = JSON.parse(fs.readFileSync(path.join(wizardHome, 'runtime.json'), 'utf8')).token || ''; } catch { wizardToken = ''; }
    if (!wizardToken) await sleep(100);
  }
  const wizardUrl = `http://127.0.0.1:${wizardPort}/`;
  wizardBrowser = await launchBrowser(executable, wizardDebugPort, wizardProfile, wizardUrl);
  const wizardTarget = await waitForTarget(wizardDebugPort, wizardUrl);
  ok(Boolean(wizardTarget), 'I2 向导那一台的 CDP target 就绪');
  if (!wizardTarget) throw new Error('wizard CDP target unavailable');
  wizardCdp = new CdpClient(wizardTarget.webSocketDebuggerUrl);
  await wizardCdp.connect();
  await wizardCdp.send('Runtime.enable');
  // 全新 HOME 首开就是管家视角（K0 的默认入口，§8.4 第一条）。
  const freshLens = await waitForEval(wizardCdp, `(() => {
    if (!window.state || !window.state.config) return null;
    if (document.documentElement.getAttribute('data-shell-mode') !== 'steward') return null;
    return { lens: 'steward' };
  })()`, 600);
  const freshLensActual = await wizardCdp.evaluate(`document.documentElement.getAttribute('data-shell-mode') || ''`);
  ok(Boolean(freshLens) && freshLens.lens === 'steward',
    `I3 全新 HOME 首开落管家视角（K0 的默认入口；实测 ${JSON.stringify(freshLensActual)}）`);
  // 向导今天【不自动弹】：它的入口是工作台首跑卡上那枚「开始引导」（另一条是齿轮菜单里的
  // 「重新打开引导」）。所以先切到工作台把它点开 —— 这样最后那条「落在管家视角」才是**向导干的**，
  // 不是首开默认值蒙对的。
  await wizardCdp.evaluate(`(() => { document.querySelector('#lensSeg [data-lens="classic"]').click(); return true; })()`);
  await waitForEval(wizardCdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
  const wizardOpen = await waitForEval(wizardCdp, `(() => {
    const start = document.querySelector('.onboard-start-guide');
    if (!start) return null;
    if (!document.querySelector('.onboard-wizard')) { start.click(); return null; }
    const rail = [...document.querySelectorAll('.onboard-wiz-rail-item')];
    return rail.length ? { steps: rail.length, labels: rail.map(n => n.textContent) } : null;
  })()`, 600);
  ok(Boolean(wizardOpen) && wizardOpen.steps === 7,
    `I3b 首跑卡的「开始引导」打开向导，步骤条 7 格（§8.4 拍板③：多了「管家用哪个模型」；实测 ${JSON.stringify(wizardOpen)}）`);
  const step = async () => wizardCdp.evaluate(`(async () => {
    const next = document.querySelector('.onboard-wiz-skipstep') || document.querySelector('.onboard-wiz-next');
    if (!next) return null;
    next.click();
    await new Promise(r => setTimeout(r, 200));
    return { title: (document.querySelector('.onboard-wiz-step-title') || {}).textContent || '' };
  })()`);
  await step();   // 语言 → 引擎
  await step();   // 引擎 → 密钥
  await step();   // 密钥（skipStep）→ 管家模型
  const onSteward = await wizardCdp.evaluate(`(() => {
    const input = document.getElementById('onboardStewardModel');
    const cards = [...document.querySelectorAll('.onboard-wiz-steward .onboard-wiz-card')];
    return { hasStep: Boolean(document.querySelector('.onboard-wiz-steward')), input: Boolean(input), cards: cards.length,
      title: (document.querySelector('.onboard-wiz-step-title') || {}).textContent || '' };
  })()`);
  ok(Boolean(onSteward) && onSteward.hasStep && onSteward.input && onSteward.cards === 2,
    `I4 第 4 步就是「管家用哪个模型」（两张卡 ＋ 模型名框；实测 ${JSON.stringify(onSteward)}）`);
  await wizardCdp.evaluate(`(async () => {
    const input = document.getElementById('onboardStewardModel');
    input.value = 'wizard-cheap-model';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof input.onchange === 'function') await input.onchange();
    await new Promise(r => setTimeout(r, 500));
    return true;
  })()`);
  const wroteModel = await waitForHttp(wizardPort, 'GET', '/api/status',
    r => String(r.json && r.json.config && r.json.config.stewardModel) === 'wizard-cheap-model', wizardToken, 80);
  ok(Boolean(wroteModel), 'I5 填的模型名真的落进 config.stewardModel（与设置·管家页同一个字段、同一条写口）');
  await step();   // 管家模型 → 文件夹
  await step();   // 文件夹 → 安全档
  await step();   // 安全档 → 完成
  const finished = await wizardCdp.evaluate(`(async () => {
    const btn = document.querySelector('.onboard-wiz-finish');
    if (!btn) return null;
    await btn.onclick();
    await new Promise(r => setTimeout(r, 600));
    return { lens: document.documentElement.getAttribute('data-shell-mode') || '', open: Boolean(document.querySelector('.onboard-wizard')) };
  })()`);
  ok(Boolean(finished) && finished.open === false,
    `I6 点「完成」之后向导关闭（实测 ${JSON.stringify(finished)}）`);
  // 进向导之前人在【工作台】视角（上面刻意切过去的），所以这一条量的是向导自己把视角切了回来
  // ——不是首开默认值蒙对的。反向：拔掉 onboarding-wizard.js 里 onFinished() 那一行 → 本条红。
  const landed = await waitForEval(wizardCdp,
    `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? { lens: 'steward' } : null`, 200);
  ok(Boolean(landed), `I7 走完向导落在管家视角 data-shell-mode="steward"（§8.4「完成页落在管家视角」；实测 ${JSON.stringify(finished && finished.lens)}）`);
  const record = await waitForHttp(wizardPort, 'GET', '/api/status',
    r => Boolean(r.json && r.json.config && r.json.config.onboarding && r.json.config.onboarding.completedAt), wizardToken, 60);
  ok(Boolean(record), 'I8 onboarding.completedAt 已写（向导真的走完了，不是被跳过）');

  /* ═════════ K 126-M02 记忆面的「已过期」标（真浏览器）═════════ */
  // **放在最末**：本组会重写记忆库，而 C 组的「新」角标判据读的是同一个库 —— 插在中段会把 C 组
  // 搅了（125 波那次「新断言插在中段扰动后面的件」的教训）。用主浏览器 cdp／主服务，不是向导那台。
  // 纪律 13：前端 JS 改了就要有真浏览器件 —— 这一组量的就是「用户到底看不看得见它过期了」。
  {
    const pastIso = new Date(Date.now() - DAY_MS).toISOString();
    const futureIso = new Date(Date.now() + DAY_MS).toISOString();
    fs.writeFileSync(path.join(home, 'steward', 'memory-v1.json'), memoryStore([
      { ...memoryEntry('expired-one', 3 * DAY_MS), expiresAt: pastIso },
      { ...memoryEntry('live-one', 3 * DAY_MS), expiresAt: futureIso },
    ]), 'utf8');
    const onMemoryExpiry = await clickPocket('memory');
    ok(Boolean(onMemoryExpiry) && onMemoryExpiry.memoryGroup, 'K1 记忆组打开');
    const painted = await waitForEval(cdp, `(() => {
      const rowOf = id => document.querySelector('#cfgStewardGroupMemory .steward-memory-item[data-memory-id="' + id + '"]');
      const expiredRow = rowOf('expired-one'), liveRow = rowOf('live-one');
      if (!expiredRow || !liveRow) return null;
      const badge = node => node.querySelector('.steward-memory-expired');
      return {
        rows: document.querySelectorAll('#cfgStewardGroupMemory .steward-memory-item').length,
        expiredBadge: badge(expiredRow) ? badge(expiredRow).textContent : '',
        expiredVisible: badge(expiredRow) ? badge(expiredRow).offsetParent !== null : false,
        expiredTitle: badge(expiredRow) ? badge(expiredRow).title : '',
        liveBadge: badge(liveRow) ? '有' : '没有',
      };
    })()`, 200);
    ok(Boolean(painted) && painted.rows === 2,
      `K2 两条都列在面板上 —— **过期的没被删掉**（实测 ${painted && painted.rows} 行）`);
    ok(Boolean(painted) && painted.expiredBadge === '已过期' && painted.expiredVisible === true,
      `K3 过期那条画出了「已过期」标且真的在屏上（实测「${painted && painted.expiredBadge}」，可见 ${painted && painted.expiredVisible}）`);
    ok(Boolean(painted) && painted.liveBadge === '没有',
      `K4 没过期的那条【没有】这枚标（实测 ${painted && painted.liveBadge}）—— 不是所有条目都印`);
    ok(Boolean(painted) && String(painted.expiredTitle).includes(pastIso),
      `K5 悬停说得出到期时刻（实测 ${String((painted && painted.expiredTitle) || '').slice(0, 60)}）`);
    await closeSettings();
  }
} catch (error) {
  fail += 1;
  console.log('ERROR ' + (error && error.stack ? error.stack : error));
} finally {
  if (cdp) cdp.close();
  if (wizardCdp) wizardCdp.close();
  killTree(browser);
  killTree(wizardBrowser);
  killTree(server);
  killTree(wizardServer);
  if (provider) await new Promise(resolve => provider.close(resolve));
  try { stopRuyiTestBrowsers(); } catch { /* best effort */ }
}

console.log(fail === 0 ? 'RAIL POCKET BROWSER E2E: ALL PASS' : `RAIL POCKET BROWSER E2E: FAIL (${fail})`);
process.exit(fail === 0 ? 0 : 1);
})();

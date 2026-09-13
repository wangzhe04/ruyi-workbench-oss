#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）

// 第 122 波 L1b 真浏览器 E2E：**用户走查第二轮 ＋ 管家视角向导入口 ＋ 齿轮去重 ＋ setLens 同值早退**
// （36 号文 §2.11／§2.12／§2.13／§5.2 登记）。
//
// 四组，每组钉一条「屏幕上真的是那样」的事实：
//   B 管家视角有向导入口（§2.13）：全新一台机器第一次进管家壳，问候行下就有一枚「开始引导」，
//     点它向导真的打开；把 config.onboarding 写成完成之后刷新，那枚按钮消失。
//     ——【号文写的是 renderDigest，执行者证伪】：全新 HOME 第一次到访走的是 renderFirstRun
//     （没有待决、没有焦点、摘要为空 → enterVisit 的 `nothing` 分支），renderDigest 一次都不跑；
//     只钉 renderDigest 等于这枚按钮对新装的人不存在。所以两条路都挂、两条路都钉：
//     B2 是首跑那条，B5 是刷新之后（同一个到访窗口里 newVisit!==true → renderDigest）那条。
//   C chip 菜单文字不横向裁切（§2.11）：权限 chip 菜单里每个 .steward-chip-option-label／-hint
//     的 scrollWidth ≤ clientWidth。病根是 base.css 那条全局 `button { white-space: nowrap }`
//     被 .steward-chip-option（它是个 <button>）继承。反向删 white-space:normal → C 组红。
//   D 齿轮菜单一层七项（§2.12）：#moreMenuBtn 零枚；菜单里 role=menuitem 恰七枚且各看得见、
//     各有人话文案；点「主题」那一项主题真的变；从齿轮钮起连按 Tab 能走遍七项。
//   E 顶栏分段钮的同值早退（§5.2 L1a 登记）：CDP Fetch 扣住 */api/status*，此刻画面按 fail-closed
//     停在工作台；在扣住期间点分段钮「工作台」——修前这一下被 `if (next === currentMode()) return`
//     整个吞掉（applyShellMode 没跑、本机偏好没写），放行后默认落点把画面翻成管家。
//     判据：放行 2 s 后 data-shell-mode 与 localStorage 都还是 classic。
//
// 顺序有讲究：B 要「全新 HOME、没存过视角偏好」，E 会把 classic 存进 localStorage，所以 E 排最后
// （它自己先把那条偏好清掉再 reload）。C／D 夹在中间，都在工作台视角里做。
//
// 与 walkthrough-round1.browser.e2e.js 同一套 CDP 无头驱动；每条 CDP 命令带 90 s 看门狗
// （抄 L1a 的 shell-mode-late-config.browser.e2e.js：本机无头 Edge 偶发中途整个没了，
// 没有这只狗的话一次 evaluate 会永远挂着）。
//
// 判定行：`WALKTHROUGH ROUND2 BROWSER E2E: ALL PASS`。
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
const CDP_COMMAND_TIMEOUT_MS = 90000;   // 单条 CDP 命令的看门狗（见 CdpClient.send 的注）
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '折行那条线程';
const POLL_MS = 120000;                 // 兜底节拍拉满：本件不测节拍，别让它插队重画
const SHELL_MODE_KEY = 'wcw.shellMode'; // shell-mode.js SHELL_MODE_STORAGE_KEY
const HOLD_MS = 1500;                   // E 组扣住 /api/status 多久
const SETTLE_MS = 2000;                 // 放行之后再观察多久（号文：2 s）
const GEAR_ITEMS = ['openSettingsBtn', 'helpMenuBtn', 'helpBtn', 'bulkCleanupBtn', 'themeToggle', 'uiModeToggle', 'capBadge'];

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

// 确定性 provider：一句短回答。本件不测引擎，它只是让配置成立、让线程能建起来。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = payload => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: '好。' }, finish_reason: null }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.handlers = new Map(); }
  on(method, fn) { this.handlers.set(method, fn); }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id) {
          const handler = this.handlers.get(message.method);
          if (handler) { try { handler(message.params || {}); } catch { /* 事件回调出错不许掀翻连接 */ } }
          return;
        }
        if (!this.pending.has(message.id)) return;
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
  // 每条 CDP 命令都带自己的看门狗（36 号文 §5.2 登记）：本机无头 Edge 偶发中途整个没了，而
  // socket 的 close 事件那一刻不一定来 —— 没有这只狗的话一次 evaluate 会永远挂着。
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

async function waitForBlankTarget(debugPort) {
  for (let i = 0; i < 300; i++) {
    const result = await request(debugPort, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page');
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

// 预算 800 × 40 ms = 32 s：并行全量下几个无头浏览器抢 CPU（与同族件同一个数）。
async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch (error) {
      // 导航/reload 会换执行上下文（那种错要吞掉继续轮询）；但看门狗错说明浏览器已经没了。
      if (String(error && error.message).indexOf('CDP') >= 0) throw error;
    }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('railList') || !document.getElementById('appFrame')) return null;
  const button = document.querySelector('#lensSeg [data-lens]');
  if (!button || typeof button.onclick !== 'function') return null;
  return { ready: true };
})()`;

// 管家对话流里那枚「开始引导」（文案复用 onboarding.wizard.start，与工作台空态同一句）。
const ONBOARD_PROBE = `(() => {
  const label = ${JSON.stringify(zh['onboarding.wizard.start'])};
  const feed = document.getElementById('stewardFeed');
  const acts = feed ? [...feed.querySelectorAll('.steward-act')] : [];
  const hit = acts.filter(node => (node.textContent || '').trim() === label);
  const rows = feed ? [...feed.querySelectorAll('.steward-acts')].map(row => row.children.length) : [];
  return {
    feed: Boolean(feed),
    total: acts.length,
    onboarding: hit.length,
    visible: hit.filter(node => node.getBoundingClientRect().width > 4).length,
    perRow: rows,
    texts: acts.map(node => (node.textContent || '').trim()),
    // renderFirstRun 那一支的指纹：三个可点例子（.steward-example）只有它画。
    intro: feed ? feed.querySelectorAll('.steward-example').length === 3 : false,
    examples: feed ? feed.querySelectorAll('.steward-example').length : -1,
    // renderDigest 那一支的指纹：「知道了」那枚 dismiss。
    gotIt: acts.filter(node => (node.textContent || '').trim() === ${JSON.stringify(zh['stewardShell.chat.gotIt'])}).length,
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-walkthrough-r2-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(root, 'profile');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
// **不写 onboarding 字段**：全新一台机器就是这个样子（01-config 洗成 null），B 组要的就是它。
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A1 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  // **B 组开跑时一条线程都不许有**：全新一台机器就是这样，而 enterVisit 只在「没待决、没焦点、
  // 摘要为空」时才走 renderFirstRun 那一支 —— 先建线程的话 visit.focus 就有了，第一屏直接落到
  // renderDigest，renderFirstRun 一次都不跑（第一版就这么写的，reverse 时才看出来它没被覆盖）。
  // C 组要的那条线程留到 B 组做完再建。
  const noThread = await request(appPort, 'GET', '/api/sessions?limit=5', null, token);
  ok(Boolean(noThread) && (((noThread.json && noThread.json.sessions) || []).length === 0),
    `A3 起点是全新 HOME：一条线程都没有（实测 ${((noThread && noThread.json && noThread.json.sessions) || []).length} 条）`);

  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A4 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  // 【先开空白页再导航】：E 组要拦 boot 的第一发 /api/status，所以浏览器不能直接吃 appUrl。
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,960',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForBlankTarget(debugPort);
  ok(Boolean(target), 'A5 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 真鼠标：CSS 的 :hover 与 elementFromPoint 都要真的命中测试，所以点击一律走 CDP Input
  // （.click() 绕过命中测试，测不到「被谁盖住了」这件事）。
  const mouseAt = async (x, y, type) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const realClick = async (x, y) => { await mouseAt(x, y, 'mouseMoved'); await mouseAt(x, y, 'mousePressed'); await mouseAt(x, y, 'mouseReleased'); };
  const clickSelector = async selector => {
    const box = await cdp.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const b = node.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return null;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    })()`);
    if (!box) return false;
    await realClick(box.x, box.y);
    await sleep(140);
    return true;
  };
  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  // 齿轮／盾牌那两块浮层各自记着「我开着没有」，所以【只能靠那枚钮开合】（walkthrough-round1 的
  // 同名函数，理由见那里：从外面写 menu.hidden 会让标记与 DOM 对不上）。
  const toggleMenuUntil = async (buttonSelector, menuSelector, wantOpen) => {
    for (let i = 0; i < 4; i++) {
      const state = await cdp.evaluate(`(() => { const m = document.querySelector(${JSON.stringify(menuSelector)});
        return m ? (m.hidden ? 'closed' : 'open') : 'missing'; })()`);
      if (state === (wantOpen ? 'open' : 'closed')) return true;
      await clickSelector(buttonSelector);
      await sleep(220);
    }
    return false;
  };

  await cdp.send('Page.navigate', { url: appUrl });
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 首屏就绪（config 真到达、外框已挂上）');

  /* ═════════ B 管家视角的向导入口（36 号文 §2.13）═════════
     反向验证：把 renderFirstRun／renderDigest 里那两句 renderActs(row, onboardingActs()) 注掉
               → B2 与 B5 双红。 */
  const landed = await waitForEval(cdp, `(() => {
    const mode = document.documentElement.getAttribute('data-shell-mode') || '';
    return mode ? { mode } : null;
  })()`);
  ok(Boolean(landed) && landed.mode === 'steward',
    `B1 全新 HOME（没存过视角偏好）启动落【管家视角】—— 这枚入口要救的就是这批人（实得 ${landed && landed.mode}）`);

  const firstRun = await waitForEval(cdp, `(() => {
    const probe = ${ONBOARD_PROBE};
    return probe.feed && probe.total ? probe : null;
  })()`, 400) || await cdp.evaluate(ONBOARD_PROBE);
  ok(firstRun && firstRun.intro && firstRun.onboarding === 1 && firstRun.visible === 1,
    `B2 首跑那条（renderFirstRun：自我介绍 ＋ 三个例子）下有且只有一枚「${zh['onboarding.wizard.start']}」且看得见（实测例子 ${firstRun && firstRun.examples} 枚、按钮 ${JSON.stringify(firstRun && firstRun.texts)}）`);
  ok(firstRun && firstRun.perRow.every(n => n <= 2),
    `B2b 每一行按钮仍在 K6b 的 ≤2 预算内（实测每行枚数 ${JSON.stringify(firstRun && firstRun.perRow)}）`);

  const opened = await (async () => {
    await cdp.evaluate(`(() => {
      const label = ${JSON.stringify(zh['onboarding.wizard.start'])};
      const btn = [...document.querySelectorAll('#stewardFeed .steward-act')].find(n => (n.textContent || '').trim() === label);
      if (btn) btn.click();
      return true;
    })()`);
    return waitForEval(cdp, `(() => {
      const bd = document.querySelector('.onboard-wizard-backdrop');
      if (!bd) return null;
      const modal = bd.querySelector('.modal.onboard-wizard');
      return modal ? { role: modal.getAttribute('role'), label: modal.getAttribute('aria-label') } : null;
    })()`, 300);
  })();
  ok(Boolean(opened) && opened.role === 'dialog',
    `B3 点它，首跑向导真的打开了（role=dialog，aria-label「${opened && opened.label}」）`);
  // 用 __close() 收（不是 Esc）：Esc 走 __cancel → markOnboarding({skipped:true})，那会把 B5 想量的
  // 「还没配完」这件事提前改掉。
  await cdp.evaluate(`(() => { const bd = document.querySelector('.onboard-wizard-backdrop'); if (bd && bd.__close) bd.__close(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('.onboard-wizard-backdrop') ? null : 1)()`, 200)),
    'B4 向导关掉了（走 __close，不写 skipped —— 下一组还要量「没配完」）');

  await cdp.send('Page.reload');
  ok(Boolean(await waitForEval(cdp, READY)), 'B5a 刷新后首屏再次就绪');
  const digestRun = await waitForEval(cdp, `(() => {
    const probe = ${ONBOARD_PROBE};
    return probe.feed && probe.total ? probe : null;
  })()`, 400) || await cdp.evaluate(ONBOARD_PROBE);
  ok(digestRun && digestRun.onboarding === 1 && digestRun.visible === 1 && digestRun.gotIt === 1 && !digestRun.intro,
    `B5 同一个到访窗口里刷新走的是【另一支】renderDigest（有「知道了」、没有三个例子），按钮仍在（实测 ${JSON.stringify(digestRun && digestRun.texts)}）`);

  // 把「向导走完了」写进 config（用户真走完向导时 markOnboarding 写的就是这三个字段）。
  const marked = await request(appPort, 'POST', '/api/config',
    { onboarding: { completedAt: new Date().toISOString(), version: 1, skipped: false } }, token);
  ok(Boolean(marked && marked.status === 200), `B6a config.onboarding 写成「已完成」（HTTP ${marked && marked.status}）`);
  await cdp.send('Page.reload');
  ok(Boolean(await waitForEval(cdp, READY)), 'B6b 再刷新后首屏就绪');
  await sleep(800);
  const done = await cdp.evaluate(ONBOARD_PROBE);
  ok(done && done.onboarding === 0,
    `B6 走完向导之后重画，那枚按钮消失（实测剩下的按钮 ${JSON.stringify(done && done.texts)}）`);

  /* ═════════ C chip 菜单文字不横向裁切（36 号文 §2.11）═════════
     反向验证：删 css/views/steward-drawer.css 里 .steward-chip-option 的 white-space: normal
               → C2／C3 红（继承 base.css 那条全局 button nowrap）。 */
  // C／D 组要一条真线程（chip 得有 sessionId 才是可点的）。B 组要求「零线程」，所以到这里才建。
  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD_TITLE, cwd: work }, token);
  const sid = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sid), `C0a 线程已建（${sid}）`);
  if (!sid) throw new Error('session fixture unavailable');
  await cdp.send('Page.reload');
  ok(Boolean(await waitForEval(cdp, READY)), 'C0a2 刷新后首屏就绪（左栏能看见刚建的那条线程）');
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelector('#railList .steward-board-thread[data-session-id="${sid}"]') ? 1 : null)()`, 400)),
    'C0a3 左栏那一行在场');

  ok(Boolean(await setLens('classic')), 'C0 切到工作台视角（线程头那组 chip 住在这一侧）');
  await cdp.evaluate(`(() => {
    const row = document.querySelector('#railList .steward-board-thread[data-session-id="${sid}"] .steward-board-thread-title')
      || document.querySelector('#railList .steward-board-thread[data-session-id="${sid}"]');
    if (row) row.click();
    return true;
  })()`);
  ok(Boolean(await waitForEval(cdp, `(() => (window.state && window.state.currentSession && window.state.currentSession.id === '${sid}') ? 1 : null)()`, 400)),
    'C0b 工作台里打开了那条线程（chip 要有 sessionId 才是可点的）');
  // 打开菜单要【重试】：刚 openSession 那几百毫秒里线程头还在补渲染（renderThreadHead 会把整组
  // chip 连同菜单节点重建一遍），第一下点开的菜单会跟着旧节点一起被换掉。第一版只点一次，
  // 实测偶发 C1 红 —— 那不是产品的问题，是夹具的（与 walkthrough-round1 的 toggleMenuUntil 同一条教训）。
  let chipClicks = 0;
  let menuOpen = null;
  for (let i = 0; i < 5 && !menuOpen; i++) {
    if (!(await clickSelector('#threadChips [data-chip="permission"]'))) { await sleep(300); continue; }
    chipClicks += 1;
    menuOpen = await waitForEval(cdp, `(() => {
      const menu = document.querySelector('#threadChips .steward-chip-menu[data-kind="permission"]');
      return menu && !menu.hidden && menu.querySelectorAll('.steward-chip-option').length >= 4 ? 1 : null;
    })()`, 40);
  }
  ok(chipClicks > 0, `C1a 点得到权限 chip（点了 ${chipClicks} 下）`);
  ok(Boolean(menuOpen), 'C1 权限 chip 菜单展开、四档 ＋「跟随全局」都在');
  const clip = await cdp.evaluate(`(() => {
    const menu = document.querySelector('#threadChips .steward-chip-menu[data-kind="permission"]');
    if (!menu) return null;
    const rows = [...menu.querySelectorAll('.steward-chip-option-label, .steward-chip-option-hint')];
    const over = rows
      .map(node => ({
        cls: node.className,
        text: (node.textContent || '').slice(0, 18),
        ws: getComputedStyle(node).whiteSpace,
        sw: node.scrollWidth, cw: node.clientWidth,
      }))
      .filter(row => row.sw > row.cw);
    const menuBox = menu.getBoundingClientRect();
    return {
      count: rows.length,
      over,
      ws: rows.length ? getComputedStyle(rows[0]).whiteSpace : '',
      menuOverflow: Math.round(menu.scrollWidth - menu.clientWidth),
      menuWidth: Math.round(menuBox.width),
    };
  })()`);
  ok(Boolean(clip) && clip.count >= 8,
    `C2a 菜单里量到 ${clip && clip.count} 个标签／提示节点（四档各两个 ＋「跟随全局」一个）`);
  ok(Boolean(clip) && clip.over.length === 0,
    `C2 每个 .steward-chip-option-label／-hint 都没有横向溢出（scrollWidth ≤ clientWidth；越界的：${JSON.stringify(clip && clip.over)}）`);
  ok(Boolean(clip) && clip.ws === 'normal',
    `C3 计算样式真的是 white-space: normal（不是继承 base.css 那条全局 button nowrap；实得「${clip && clip.ws}」）`);
  ok(Boolean(clip) && clip.menuOverflow <= 1,
    `C4 菜单自己也没被文字撑出横向滚动（scrollWidth − clientWidth = ${clip && clip.menuOverflow}px，宽 ${clip && clip.menuWidth}px）`);
  await cdp.evaluate(`(() => { const b = document.querySelector('#threadChips [data-chip="permission"]'); if (b) b.click(); return true; })()`);
  await sleep(150);

  /* ═════════ D 齿轮菜单一层七项（36 号文 §2.12）═════════
     反向验证：把 #moreMenuBtn 那一行加回 index.html 的齿轮菜单 → ia.e2e ⑥／⑥b 红，本组 D1 也红。 */
  ok(await toggleMenuUntil('#appGearBtn', '#appGearMenu', true), 'D0 齿轮菜单真的展开了');
  // 能力矩阵那一项要等探针回来（renderCapBadge 摘掉 .hidden）才看得见 —— 它是七项里唯一一枚
  // 有「还没准备好」态的，所以等它，别在这里量出一个与产品无关的 6。
  await waitForEval(cdp, `(() => {
    const badge = document.getElementById('capBadge');
    return badge && !badge.classList.contains('hidden') ? 1 : null;
  })()`, 500);
  const gear = await cdp.evaluate(`(() => {
    const menu = document.getElementById('appGearMenu');
    if (!menu) return null;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    return {
      more: document.querySelectorAll('#moreMenuBtn').length,
      ids: items.map(node => node.id),
      hidden: items.filter(node => {
        const b = node.getBoundingClientRect();
        return b.width < 4 || b.height < 4 || getComputedStyle(node).display === 'none';
      }).map(node => node.id),
      blank: items.filter(node => !(node.textContent || '').trim()).map(node => node.id),
      labels: items.map(node => (node.textContent || '').trim()),
    };
  })()`);
  ok(Boolean(gear) && gear.more === 0, `D1 「更多」#moreMenuBtn 零枚（实得 ${gear && gear.more}）`);
  ok(Boolean(gear) && gear.ids.length === 7 && gear.ids.join(',') === GEAR_ITEMS.join(','),
    `D2 齿轮菜单 role=menuitem 恰七枚、顺序＝设置／帮助／快捷键／清理历史／主题／界面／能力矩阵（实得 ${JSON.stringify(gear && gear.ids)}）`);
  ok(Boolean(gear) && gear.hidden.length === 0,
    `D3 七项各自【看得见】（宽高 ≥4px 且 display 非 none；不可见的：${JSON.stringify(gear && gear.hidden)}）`);
  ok(Boolean(gear) && gear.blank.length === 0,
    `D4 七项各有人话文案（主题／界面两项由 syncMoreMenuLabels 补出 .mm-label；空文案的：${JSON.stringify(gear && gear.blank)}） 实测 ${JSON.stringify(gear && gear.labels)}`);

  const themeBefore = await cdp.evaluate(`(() => ({
    attr: document.documentElement.getAttribute('data-theme') || '',
    label: (document.getElementById('mm-theme-label') || {}).textContent || '',
  }))()`);
  ok(await clickSelector('#themeToggle'), 'D5a 点了「主题」那一项');
  const themeAfter = await waitForEval(cdp, `(() => {
    const attr = document.documentElement.getAttribute('data-theme') || '';
    return attr && attr !== ${JSON.stringify(themeBefore.attr)} ? {
      attr, label: (document.getElementById('mm-theme-label') || {}).textContent || '',
    } : null;
  })()`, 200);
  ok(Boolean(themeAfter),
    `D5 点主题项主题【真的变了】（data-theme ${themeBefore.attr} → ${themeAfter && themeAfter.attr}）—— 不再需要先进「更多」那一层`);
  ok(Boolean(themeAfter) && themeAfter.label && themeAfter.label !== themeBefore.label,
    `D5b 这一项自己的文案跟着变（「${themeBefore.label}」→「${themeAfter && themeAfter.label}」）—— applyTheme 的 iconTextBtn 清空按钮之后 syncMoreMenuLabels 补了回来`);
  ok(await toggleMenuUntil('#appGearBtn', '#appGearMenu', true), 'D5c 主题切完菜单还开着（切换是就地的，不该把菜单收掉）');

  // 键盘：从齿轮钮起连按 Tab，七项要一个不落地依次拿到焦点（菜单里没有 tabindex=-1 的死项）。
  await cdp.evaluate(`(() => { const g = document.getElementById('appGearBtn'); if (g) g.focus(); return true; })()`);
  const tabbed = [];
  for (let i = 0; i < 12; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' });
    const at = await cdp.evaluate(`(() => (document.activeElement && document.activeElement.id) || '')()`);
    tabbed.push(at);
    if (GEAR_ITEMS.every(id => tabbed.includes(id))) break;
  }
  ok(GEAR_ITEMS.every(id => tabbed.includes(id)),
    `D6 从齿轮钮起连按 Tab 能走遍七项（${tabbed.length} 下走到的：${JSON.stringify(tabbed)}）`);
  await toggleMenuUntil('#appGearBtn', '#appGearMenu', false);

  /* ═════════ E 顶栏分段钮的同值早退（36 号文 §5.2 登记）═════════
     反向验证：把 app-frame.js setLens 里 `if (next === currentMode()) return next;` 加回去
               → E4／E5 红（放行后画面被默认落点翻成 steward、localStorage 空）。 */
  await cdp.evaluate(`(() => { try { localStorage.removeItem(${JSON.stringify(SHELL_MODE_KEY)}); } catch {} return true; })()`);
  const held = { count: 0, firstAt: 0, releasedAt: 0 };
  cdp.on('Fetch.requestPaused', async params => {
    const requestId = params.requestId;
    const url = String((params.request && params.request.url) || '');
    if (url.indexOf('/api/status') < 0) { try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ } return; }
    held.count += 1;
    if (held.count > 1) { try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ } return; }
    held.firstAt = Date.now();
    setTimeout(async () => {
      held.releasedAt = Date.now();
      try { await cdp.send('Fetch.continueRequest', { requestId }); } catch { /* 已走 */ }
    }, HOLD_MS);
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/status*', requestStage: 'Request' }] });
  await cdp.send('Page.reload');
  for (let i = 0; i < 300 && held.count === 0; i++) await sleep(25);
  ok(held.count >= 1 && held.releasedAt === 0, `E0 /api/status 已被扣住，延迟窗开着（拦到 ${held.count} 发、尚未放行）`);
  // 等分段钮【绑好】而不是只等它在 DOM 里（它是 index.html 的静态节点，页面一到就在；
  // boot 的次序是 initToken → initI18n → bindEvents() → bootData → refreshStatus）。
  ok(Boolean(await waitForEval(cdp, `(() => {
    const b = document.querySelector('#lensSeg [data-lens="classic"]');
    return b && typeof b.onclick === 'function' ? 1 : null;
  })()`, 400)), 'E1a config 还没到，分段钮已经在屏幕上、也已经绑好');
  const duringHold = await cdp.evaluate(`(() => {
    let stored = '';
    try { stored = localStorage.getItem(${JSON.stringify(SHELL_MODE_KEY)}) || ''; } catch { stored = ''; }
    return { mode: document.documentElement.getAttribute('data-shell-mode') || '', stored };
  })()`);
  ok(duringHold.mode === 'classic',
    `E1 扣住期间画面停在【工作台】（预绘写 steward → bind 期 canEnterSteward() 恒 false 回落 classic；实得 ${duringHold.mode}）—— 这就是「同值」的由来`);
  ok(duringHold.stored === '',
    `E1b 此刻本机偏好还是空的（实得「${duringHold.stored}」）—— 默认落点因此会在 config 到达后把画面翻成管家`);

  await cdp.evaluate(`(() => {
    const b = document.querySelector('#lensSeg [data-lens="classic"]');
    if (b) b.click();
    return true;
  })()`);
  await sleep(150);
  const clicked = await cdp.evaluate(`(() => {
    let stored = '';
    try { stored = localStorage.getItem(${JSON.stringify(SHELL_MODE_KEY)}) || ''; } catch { stored = ''; }
    return { mode: document.documentElement.getAttribute('data-shell-mode') || '', stored };
  })()`);
  ok(held.releasedAt === 0, 'E2a 这一下点击确实发生在延迟窗里（/api/status 还扣着）');
  ok(clicked.stored === 'classic',
    `E2 点「工作台」这一下【没有被同值早退吞掉】：本机偏好当场写成 classic（实得「${clicked.stored}」）`);

  ok(Boolean(await waitForEval(cdp, READY, 600)), 'E3a 放行后首屏就绪（config 到了、boot 走完）');
  ok(held.releasedAt > 0 && (held.releasedAt - held.firstAt) >= HOLD_MS - 50,
    `E3b /api/status 真的被扣了 ${held.releasedAt - held.firstAt} ms（≥${HOLD_MS}）`);
  await cdp.send('Fetch.disable');
  await sleep(SETTLE_MS);
  const settled = await cdp.evaluate(`(() => {
    let stored = '';
    try { stored = localStorage.getItem(${JSON.stringify(SHELL_MODE_KEY)}) || ''; } catch { stored = ''; }
    return {
      mode: document.documentElement.getAttribute('data-shell-mode') || '',
      stored,
      pressed: [...document.querySelectorAll('#lensSeg [data-lens]')].map(n => n.dataset.lens + ':' + n.getAttribute('aria-pressed')).join(' '),
    };
  })()`);
  ok(settled.mode === 'classic',
    `E4 放行 ${SETTLE_MS} ms 之后画面【仍然是工作台】（实得 ${settled.mode}）—— 用户那一下点击没有被默认落点翻掉`);
  ok(settled.stored === 'classic', `E5 本机偏好也仍是 classic（实得「${settled.stored}」）`);
  ok(settled.pressed === 'steward:false classic:true',
    `E6 分段钮自己也对到工作台（实得「${settled.pressed}」）`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未捕获异常：' + (error && error.stack || error));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  stopRuyiTestBrowsers();
  killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
}
console.log(fail === 0 ? 'WALKTHROUGH ROUND2 BROWSER E2E: ALL PASS' : `WALKTHROUGH ROUND2 BROWSER E2E: FAILURES ${fail}`);
process.exit(fail === 0 ? 0 : 1);
})();

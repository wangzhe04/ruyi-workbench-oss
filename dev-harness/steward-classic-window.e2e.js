#!/usr/bin/env node
'use strict';

// 第117波 117g 真实浏览器 E2E（27 号文 §5 117g 行 / §8.2 L2′ / §8.6「三处同一控件」）。
// 一个事项容器 M ＋ 一条线程 A。然后：
//   ① 进管家壳 → 打开抽屉 → 点「2.0 视窗」→ data-shell-mode==='classic'、#sessionTitle 是这条会话、
//      返回带可见，带上写着会话名与【事项名】（117h 第 0 步的 missionTitle），带上的 chip 与抽屉的
//      chip 同值（同一份数据、同一个控件工厂）；
//   ② 在带上把权限改成「改文件不问」→ 点「回到管家」→ 抽屉的 chip 显示 acceptEdits（两壳一致）；
//   ③ 头像菜单「整体切到 2.0」→ 经典壳且返回带【不】显示（整体切壳不留返回标记）；
//   ④ 刷新后仍不显示（sessionStorage 里没有标记）。
// 与 steward-drawer.e2e.js 同一套 CDP 无头驱动；后端零改动。
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
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const MISSION_TITLE = '把周报做完';
const THREAD_A = '周报-W36';
const POLL_MS = 120000;

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

async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
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

// 等待预算 800 × 40ms = 32s：并行全量下四个无头浏览器抢 CPU，取数与渲染都会被拉长
// （117g 那件在 --parallel 4 里实测单趟就要一分钟量级）。单跑时用不到这么多，只是留够头寸。
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
  if (!document.getElementById('stewardReturnBand') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

const VIEW = `(() => {
  const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };
  const band = document.getElementById('stewardReturnBand');
  const chipValues = host => [...document.querySelectorAll('#' + host + ' .steward-chip')]
    .map(node => ({ kind: node.dataset.chip, value: (node.querySelector('.steward-chip-value') || {}).textContent || '' }));
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    bandHidden: band ? band.hidden : null,
    bandSession: text('stewardReturnSession'),
    bandMission: text('stewardReturnMission'),
    bandMissionHidden: document.getElementById('stewardReturnMission')
      ? document.getElementById('stewardReturnMission').hidden : null,
    bandChips: chipValues('stewardReturnChips'),
    drawerChips: chipValues('stewardDrawerChips'),
    drawerHidden: document.getElementById('stewardDrawer') ? document.getElementById('stewardDrawer').hidden : null,
    sessionTitle: text('sessionTitle'),
    returnMark: (() => { try { return sessionStorage.getItem('wcw.stewardReturn') || ''; } catch { return 'ERR'; } })(),
    // 117l-B2 ③ 重钉：选择器从 '#stewardHeader .steward-menu-item' 改成 '#stewardAvatarMenu …'。
    // 旧选择器钉的是 117k 当时的挂点（菜单是顶栏的子节点、absolute 锚在顶栏下沿）；用户第五轮
    // 走查 3 指出头像早就跟着最新一条话走了、菜单却还钉在最上面，于是菜单改成按头像 rect 定位的
    // fixed 浮层，挂点必须移出 #stewardStage（它有 backdrop-filter 会给 fixed 造包含块、
    // 还有 overflow:hidden 会切掉菜单）。菜单的 id 与项的类名一个字没改，所以这里换的是【父节点】
    // 而不是断言强度；下面 menuHost/menuPlace 两项 companion 把新挂点与新锚点各钉一遍。
    menuItems: [...document.querySelectorAll('#stewardAvatarMenu .steward-menu-item')].map(node => node.textContent.trim()),
    menuHost: (() => {
      const menu = document.getElementById('stewardAvatarMenu');
      return menu && menu.parentElement ? menu.parentElement.id : '';
    })(),
    menuPlace: (() => {
      const menu = document.getElementById('stewardAvatarMenu');
      const avatar = document.getElementById('stewardAvatar');
      if (!menu || menu.hidden || !avatar) return '';
      const rect = menu.getBoundingClientRect();
      const anchor = avatar.getBoundingClientRect();
      const style = getComputedStyle(menu);
      // 「贴着头像开」的可判定判据：定位是 fixed、左缘对齐头像、且整张纸在头像的上方或下方
      // （±2px 容差给取整）。data-place 是 JS 自己记的那一半，两边对得上才算数。
      const aligned = Math.abs(rect.left - anchor.left) <= 2;
      const below = rect.top >= anchor.bottom - 2;
      const above = rect.bottom <= anchor.top + 2;
      // 拼接而不是模板串：VIEW 本身就住在一条模板串里，里面再写 \${} 会被外层先吃掉。
      return style.position + '|' + (aligned ? 'aligned' : 'off')
        + '|' + (below ? 'below' : (above ? 'above' : 'overlap'))
        + '|' + (menu.dataset.place || '');
    })(),
  };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-classic-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=200(200×80ms=16s)低于 30 号文 P1-31 建议的 300×同款间隔量级,是「FAIL workbench up」假红的根;默认值被本文件下方多处业务断言调用复用,不能整体抬,这里改成显式传 300 只抬这一处(30 号文 P1-31)

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD_A, cwd: home }, token);
  const sessionId = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sessionId), `A3 线程已建（${sessionId || '失败'}）`);
  if (!sessionId) throw new Error('session fixture unavailable');
  await request(appPort, 'POST', '/api/mission', {
    sessionId, action: 'start', goal: '把周报做完',
    milestones: [{ id: 'm1', desc: '拿到数字' }],
  }, token);
  const container = await request(appPort, 'POST', '/api/missions', { title: MISSION_TITLE }, token);
  const missionId = container && container.json && container.json.mission && container.json.mission.missionId;
  await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId }, token);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/missions?limit=200', result => {
    const row = ((result.json && result.json.missions) || []).find(item => item.sessionId === sessionId);
    return Boolean(row && row.missionTitle === MISSION_TITLE);
  }, token)), 'A4 线程挂进事项容器，行上的 missionTitle 已是容器标题');

  const executable = browserPath();
  ok(Boolean(executable), 'A5 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A6 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A7 应用就绪（返回带骨架在 DOM 里）');

  const initial = await cdp.evaluate(VIEW);
  // 121 波 K0 重钉（34 号文 §8.4 拍板③）：本机没存过壳层偏好 + 管家开关开着 = 首开落【管家视角】，
  // 不再是经典壳。判据本身没放宽：返回带仍然必须是收着的（它只在真的走过「2.0 视窗」那条路时才出），
  // 而且这条现在顺带证明了新默认入口在真浏览器里生效（本件的 config 就是 stewardEnabledV1:true）。
  ok(initial.bandHidden === true && initial.mode === 'steward',
    `B0 首开落管家视角（121-K0 默认入口），返回带不显示（没走过 2.0 视窗；实测 mode='${initial.mode}'）`);

  // ── ① 进管家壳 → 打开抽屉 → 「2.0 视窗」 ──────────────────────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward'`);
  await cdp.evaluate(`document.dispatchEvent(new CustomEvent('steward:open-thread', { detail: { sessionId: '${sessionId}' } })), true`);
  const inDrawer = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.drawerHidden === false && view.drawerChips.length === 3 ? view : null;
  })()`);
  ok(Boolean(inDrawer), 'B1 抽屉打开，三个快切 chip 就位');
  if (!inDrawer) throw new Error('drawer did not open');
  const drawerPermissionBefore = inDrawer.drawerChips.find(chip => chip.kind === 'permission').value;
  ok(drawerPermissionBefore === zh['stewardShell.chips.followGlobal'],
    `B1b 抽屉的权限 chip 初始是「跟随全局」（实测「${drawerPermissionBefore}」）`);

  await cdp.evaluate(`document.getElementById('stewardDrawerClassicBtn').click(), true`);
  // 切壳是同步的，选中会话与看板取行都是异步的（openSession 要先取会话；事项名要等看板那批行到手后
  // onRowsChanged 把带子重画一遍）—— 等带子真的填满再取快照。
  const inClassic = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.mode === 'classic' && view.bandHidden === false
      && view.bandSession === ${JSON.stringify(THREAD_A)}
      && view.bandMission === ${JSON.stringify(MISSION_TITLE)} ? view : null;
  })()`) || await cdp.evaluate(VIEW);
  ok(Boolean(inClassic), 'C1 「2.0 视窗」把经典壳按该会话打开，返回带显出来');
  if (!inClassic) throw new Error('classic window did not open');
  ok(inClassic.sessionTitle === THREAD_A, `C1b #sessionTitle 是这条会话（实测「${inClassic.sessionTitle}」）`);
  ok(inClassic.bandSession === THREAD_A, `C2 带上写着会话名（实测「${inClassic.bandSession}」）`);
  ok(inClassic.bandMission === MISSION_TITLE && inClassic.bandMissionHidden === false,
    `C3 带上写着事项名（117h 第 0 步的 missionTitle；实测「${inClassic.bandMission}」）`);
  ok(inClassic.returnMark === sessionId, 'C4 返回标记记在 sessionStorage 里（刷新仍在 2.0 视窗）');
  ok(inClassic.bandChips.length === 3
    && JSON.stringify(inClassic.bandChips.map(chip => chip.kind)) === JSON.stringify(['permission', 'model', 'engine']),
    `C5 带上是同一组快切 chip（权限／模型／引擎；实测 ${JSON.stringify(inClassic.bandChips.map(chip => chip.kind))}）`);
  ok(JSON.stringify(inClassic.bandChips) === JSON.stringify(inDrawer.drawerChips),
    `C6 带上的 chip 与抽屉的 chip 逐字同值（同一份数据；实测 ${JSON.stringify(inClassic.bandChips)}）`);

  // ── ② 在带上改权限 → 回到管家 → 抽屉 chip 一致 ───────────────────────────────
  await cdp.evaluate(`document.querySelector('#stewardReturnChips [data-chip="permission"]').click(), true`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('#stewardReturnChips [data-permission-mode="acceptEdits"]')`)),
    'D1 带上的权限 chip 点开四档菜单');
  await cdp.evaluate(`document.querySelector('#stewardReturnChips [data-permission-mode="acceptEdits"]').click(), true`);
  ok(Boolean(await waitForHttp(appPort, 'GET', `/api/sessions/${sessionId}`,
    result => result.json && result.json.session && result.json.session.permissionMode === 'acceptEdits', token)),
    'D2 改「改文件不问」→ 服务端真的存了（PATCH /api/sessions/:id 那一个写口）');
  ok(Boolean(await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    const chip = view.bandChips.find(item => item.kind === 'permission');
    return chip && chip.value === ${JSON.stringify(zh['stewardShell.permission.acceptEdits.label'])} ? view : null;
  })()`)), 'D2b 带上的 chip 用响应回填');

  await cdp.evaluate(`document.getElementById('stewardReturnBtn').click(), true`);
  const back = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.mode === 'steward' && view.drawerHidden === false ? view : null;
  })()`);
  ok(Boolean(back), 'E1 「回到管家」回管家壳，并把「现在这一件」切到刚看的那条线程');
  const drawerPermissionAfter = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    const chip = view.drawerChips.find(item => item.kind === 'permission');
    return chip && chip.value === ${JSON.stringify(zh['stewardShell.permission.acceptEdits.label'])} ? chip.value : null;
  })()`);
  ok(Boolean(drawerPermissionAfter),
    `E2 抽屉的 chip 显示「改文件不问」（两壳读同一份数据，改哪里都一样；实测「${drawerPermissionAfter}」）`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.returnMark === '' && view.bandHidden === true ? 1 : null;
  })()`)), 'E3 回到管家即结束这趟视窗：标记清掉、带子收起');

  // ── ③ 头像菜单「整体切到 2.0」→ 不留返回带 ───────────────────────────────────
  await cdp.evaluate(`document.getElementById('stewardAvatar').click(), true`);
  const menu = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.menuItems.length ? view : null;
  })()`);
  ok(menu && menu.menuItems.includes(zh['stewardShell.classicWindow.switchWhole']),
    `F1 头像菜单末项是「整体切到 2.0」（实测 ${menu && JSON.stringify(menu.menuItems)}）`);
  // 117l-B2 ③ companion ①：菜单挂在 #stewardShell 上（不是顶栏、不是 body）。
  ok(menu && menu.menuHost === 'stewardShell',
    `F1b companion：菜单节点挂在 #stewardShell（绕开 #stewardStage 的 backdrop-filter 与 overflow:hidden；实测「${menu && menu.menuHost}」）`);
  // 117l-B2 ③ companion ②：贴着【头像】开，且真的在它上方或下方 —— 这正是用户第五轮走查 3
  // 「怎么也得要么在下面要么在上面吧」那一句话的可判定形式。
  ok(menu && /^fixed\|aligned\|(below|above)\|(below|above)$/.test(menu.menuPlace)
    && menu.menuPlace.split('|')[2] === menu.menuPlace.split('|')[3],
    `F1c companion：fixed ＋ 左缘对齐头像 ＋ 开在头像上方或下方，且与 data-place 自述一致（实测「${menu && menu.menuPlace}」）`);
  await cdp.evaluate(`[...document.querySelectorAll('#stewardAvatarMenu .steward-menu-item')]
    .find(node => node.textContent.trim() === ${JSON.stringify(zh['stewardShell.classicWindow.switchWhole'])}).click(), true`);
  const whole = await waitForEval(cdp, `(() => {
    const view = ${VIEW};
    return view.mode === 'classic' ? view : null;
  })()`);
  ok(Boolean(whole), 'F2 「整体切到 2.0」切到经典壳');
  ok(whole && whole.bandHidden === true && whole.returnMark === '',
    'F3 整体切壳【不】留返回带（它不是「按会话开一扇 2.0 视窗」）');

  // ── ④ 刷新后仍不显示 ─────────────────────────────────────────────────────────
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  const reloaded = await cdp.evaluate(VIEW);
  ok(reloaded.mode === 'classic' && reloaded.bandHidden === true && reloaded.returnMark === '',
    'G1 刷新后仍是经典壳、仍不显示返回带（sessionStorage 里本来就没有标记）');
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
  console.log(`\nSTEWARD CLASSIC WINDOW E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

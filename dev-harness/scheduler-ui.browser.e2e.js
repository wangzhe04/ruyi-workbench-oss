#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）

// 123 波 M2 真浏览器 E2E：定时任务的界面侧（37 号文 §3.6；判据第三条）。
//
// 121-K7 把三处入口先立了起来（口袋计数、焦点栏「接下来」、设置页那张只读表），但当时后端零实现
// ——那三处读的都是一条 404，界面上恒是「零条 / 整段不画 / 还没有定时任务」。本件钉的是它们现在
// 真的吃到了数据，以及**两条只有界面能证伪的红线**：
//   J10（补跑要显示成补跑）—— 启动恢复补跑的那一次，徽标必须写「补跑」，不能冒充「准时」；
//   J11（unknown 不判成功）—— 进程崩在半路的那一次，徽标必须写「结果未知，先核对」，不能写「成功」。
//
// 判据：
//   A 建两条 → 口袋角标 2、焦点栏「接下来」两行且【按时间升序】、设置块两行；
//   B 假时钟拨过第一条 → schedule.changed 帧到达之后口袋角标变 1（**零轮询**：本件全程不等
//     任何定时刷新，只等那一帧带来的重画），展开「最近几次」出一行且徽标是「准时」；
//   C J11 —— 崩溃钩子（WCW_SCHEDULER_CRASH_AT=after-register）让服务在登记之后死掉，重启后
//     那一条的徽标是「结果未知，先核对」，**且逐字不等于「成功」那一句**；
//   D J10 —— 错过一个时点之后重启，补跑那一次的徽标带「补跑」，**且不是「准时」**。
//   E 127 波 2-ter S-a —— 新建表单的档位下拉只在「跑一个回合 + 每次开新线程」时出现；真表单提交选「快速模型」
//     → 服务端那一份 target.tier=fast，留「跟随全局」→ target 里没有 tier 键。
//
// 反向（已本机独立跑一遍，先破坏 → 看真红 → 还原；不在本文件里自动做，理由同 quiet-card.browser）：
//   把 steward-settings.js 的 scheduleResultBadge 里 SCHEDULE_OUTCOME_KEYS 那一次查表改成恒取
//   'scheduler.outcome.succeeded'（＝把徽标文案换成成功）→ C1/C2 与 B3 当场红：
//   C1 实得「成功 · 准时」而不是「结果未知，先核对 · 准时」。
//
// 时间全走 §3.4 的假时钟（WCW_SCHEDULER_CLOCK_FILE）：一天与一次崩溃压进十几秒。
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

const TICK_MS = 150;
const MINUTE = 60000;

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
  if (!document.getElementById('railPocket') || !document.getElementById('cfgStewardSchedule')) return null;
  return { ready: true };
})()`;
// 打开设置弹窗并切到「管家」页签（走真实入口：按钮 + 页签按钮，与 steward-settings.e2e 同一手法）。
const OPEN_TAB = `(() => {
  document.getElementById('openSettingsBtn').click();
  const tab = document.querySelector('#settingsTabs button[data-stab="steward"]');
  if (!tab) return null;
  tab.click();
  const panel = document.getElementById('stab-steward');
  return panel && panel.classList.contains('active') ? { open: true } : null;
})()`;
// 三处入口的现场快照（全部读 DOM，一个模块私有状态都不碰）。
const SNAP = `(() => {
  const pocket = document.querySelector('#railPocket [data-pocket="schedule"] .rail-pocket-n');
  const upNext = document.getElementById('stewardUpNext');
  return {
    pocket: pocket ? pocket.textContent : '',
    upNextHidden: upNext ? upNext.hidden : null,
    upNextRows: [...document.querySelectorAll('#stewardUpNextList .steward-upnext-text')].map(node => node.textContent),
    rows: [...document.querySelectorAll('#cfgStewardSchedule .steward-schedule-row')].map(node => ({
      taskId: node.dataset.taskId,
      enabled: node.dataset.enabled,
      name: (node.querySelector('.steward-schedule-name') || {}).textContent || '',
      plan: (node.querySelector('.steward-schedule-plan') || {}).textContent || '',
      when: (node.querySelector('.steward-schedule-when') || {}).textContent || '',
      badge: (node.querySelector('.steward-schedule-badge') || {}).textContent || '',
      outcome: (node.querySelector('.steward-schedule-badge') || {}).dataset ? node.querySelector('.steward-schedule-badge').dataset.outcome : '',
      mode: (node.querySelector('.steward-schedule-badge') || {}).dataset ? node.querySelector('.steward-schedule-badge').dataset.mode : '',
      runs: [...node.querySelectorAll('.steward-schedule-run')].map(run => ({
        text: run.textContent,
        outcome: (run.querySelector('.steward-schedule-badge') || {}).dataset ? run.querySelector('.steward-schedule-badge').dataset.outcome : '',
        mode: (run.querySelector('.steward-schedule-badge') || {}).dataset ? run.querySelector('.steward-schedule-badge').dataset.mode : '',
        hasOpen: Boolean(run.querySelector('.steward-schedule-run-open')),
      })),
    })),
  };
})()`;

const appPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-ui-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const clockFile = path.join(root, 'clock.txt');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
const shotDir = process.env.RUYI_SHOT_DIR && fs.existsSync(process.env.RUYI_SHOT_DIR) ? process.env.RUYI_SHOT_DIR : root;
const setClock = ms => fs.writeFileSync(clockFile, String(Math.round(ms)), 'utf8');
// 起点取【真实此刻】：「接下来」那两行的排序判据在浏览器里算（Date.now()），与调度器读的时钟
// 文件必须同源起步，否则两条一天内的任务在界面上会被当成过去时而整段不画。
const T0 = Date.now();
setClock(T0);
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));

fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.4.0',
  activeProvider: '',
  engineMode: 'interactive',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: work,
  includeWorkbenchMcp: false,
  stewardEnabledV1: true,
  stewardPollMs: 120000,
  schedulerEnabledV1: true,
}), 'utf8');

// 唯一的 spawn 点（fixture-home.static 数的就是它这一处；env 写在实参里，见 scheduler-crash 的头注）。
function spawnWb(crashAt) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: {
      ...process.env,
      RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home,
      WCW_SCHEDULER_CLOCK_FILE: clockFile,
      WCW_SCHEDULER_TICK_MS: String(TICK_MS),
      ...(crashAt ? { WCW_SCHEDULER_CRASH_AT: crashAt } : {}),
    },
    windowsHide: true,
  });
  child.exitInfo = { code: null, done: false };
  child.on('exit', code => { child.exitInfo.code = code; child.exitInfo.done = true; });
  child.stderr.on('data', d => { const s = String(d).trim(); if (s && !/scheduler_test_crash/.test(s)) console.error('[wb!] ' + s); });
  return child;
}
// 一趟里要起三次服务、共用同一个数据根 —— runtime.json 里始终躺着上一个进程的 token，
// 所以按 pid 精确等到【这一个】子进程自己写下的那一份（照抄 scheduler-crash 的头注与写法）。
async function waitToken(child) {
  for (let i = 0; i < 300; i++) {
    let runtime = null;
    try { runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')); } catch { runtime = null; }
    if (runtime && runtime.token && Number(runtime.pid) === Number(child.pid)) return runtime.token;
    await sleep(100);
  }
  return '';
}
async function waitExit(child, budgetMs = 20000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) { if (child.exitInfo.done) return child.exitInfo.code; await sleep(60); }
  return null;
}
// 本地墙钟的 {date, at}（29 号文 §4：只存本地时区语义）。
const onceAt = atMs => {
  const when = new Date(atMs);
  const p2 = n => String(n).padStart(2, '0');
  return { kind: 'once', date: `${when.getFullYear()}-${p2(when.getMonth() + 1)}-${p2(when.getDate())}`, at: `${p2(when.getHours())}:${p2(when.getMinutes())}` };
};

let server = null;
let browser = null;
let cdp = null;
try {
  server = spawnWb('');
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'A0 workbench started');
  let token = await waitToken(server);
  ok(Boolean(token), 'A0b runtime token 可读');

  const create = (title, atMs) => request(appPort, 'POST', '/api/scheduler/tasks', {
    title, schedule: onceAt(atMs), payload: { kind: 'reminder', text: title + '：到点了' },
  }, token);
  const first = await create('先到的那条', T0 + 60 * MINUTE);
  const second = await create('后到的那条', T0 + 120 * MINUTE);
  const firstId = first && first.json && first.json.task && first.json.task.id;
  const secondId = second && second.json && second.json.task && second.json.task.id;
  ok(Boolean(firstId && secondId), `A0c 两条定时任务已建（${firstId} / ${secondId}）`);
  if (!firstId || !secondId) throw new Error('scheduler fixtures unavailable');

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
  ok(Boolean(await waitForEval(cdp, READY)), 'A0f 首屏就绪');
  // 新装默认落管家视角（34 号文 §8.4 拍板③）——「接下来」只在这一侧画，等它落定再量。
  ok(Boolean(await waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null)()`)),
    'A0g 视角是管家（焦点栏「接下来」只在这一侧）');
  const openSettings = async () => waitForEval(cdp, OPEN_TAB, 100);
  ok(Boolean(await openSettings()), 'A0h 设置弹窗的「管家」页签打开了');

  /* ═════════ A 建两条 → 三处入口都吃到真数据 ═════════ */
  ok(Boolean(await waitForEval(cdp, `(() => {
    const node = document.querySelector('#railPocket [data-pocket="schedule"] .rail-pocket-n');
    return node && node.textContent === '2' ? 1 : null;
  })()`)), 'A1 口袋「定时任务」角标是 2（修前它恒是空 —— 那条路由 404）');
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelectorAll('#cfgStewardSchedule .steward-schedule-row').length === 2 ? 1 : null)()`)),
    'A2 设置块两行');
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelectorAll('#stewardUpNextList .steward-upnext-row').length === 2 ? 1 : null)()`)),
    'A3 焦点栏「接下来」两行');
  const snapA = await cdp.evaluate(SNAP);
  ok(snapA.upNextHidden === false && snapA.upNextRows.length === 2
    && snapA.upNextRows[0].includes('先到的那条') && snapA.upNextRows[1].includes('后到的那条'),
    `A4 「接下来」两行【按时间升序】（实得 ${JSON.stringify(snapA.upNextRows)}）`);
  const rowA = snapA.rows.find(r => r.taskId === firstId) || {};
  ok(rowA.plan && rowA.plan === zh['scheduler.describe.once']
    .replace('{{year}}', String(new Date(T0 + 60 * MINUTE).getFullYear()))
    .replace('{{month}}', String(new Date(T0 + 60 * MINUTE).getMonth() + 1))
    .replace('{{day}}', String(new Date(T0 + 60 * MINUTE).getDate()))
    .replace('{{time}}', onceAt(T0 + 60 * MINUTE).at),
    `A5 计划印的是 describeSchedule 那一句人话（实得「${rowA.plan}」）`);
  ok(rowA.badge === zh['settings.steward.schedule.never'], `A6 还没跑过时徽标是「${zh['settings.steward.schedule.never']}」（实得「${rowA.badge}」）`);
  ok(rowA.when && rowA.when.length > 0, `A7 印了下次触发的倒计时（实得「${rowA.when}」）`);

  /* ═════════ B 拨过第一条 → 口袋跟着变 + 展开「最近几次」出「准时」═════════ */
  setClock(T0 + 61 * MINUTE);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const node = document.querySelector('#railPocket [data-pocket="schedule"] .rail-pocket-n');
    return node && node.textContent === '1' ? 1 : null;
  })()`, 500)), 'B1 schedule.changed 帧到达之后口袋角标变 1（零轮询：本件全程不等任何定时刷新）');
  // 40 号文 P0③：设置块【现在订推送了】——不按刷新它也该自己变（修前只在打开页签/按刷新/做完
  // 一个动作这三个时刻刷，而用户此刻正盯着这一页）。先不按键，验它自己更新；再按一次键，验
  // 手动那条路没被推送替掉。仍然零计时器。
  ok(Boolean(await waitForEval(cdp, `(() => {
    const row = document.querySelector('#cfgStewardSchedule .steward-schedule-row[data-task-id="${firstId}"] .steward-schedule-badge');
    return row && row.dataset.outcome === 'succeeded' ? 1 : null;
  })()`)), 'B1b 不按刷新，设置块自己跟着 schedule.changed 变（P0③）');
  await cdp.evaluate(`(() => { document.getElementById('cfgStewardScheduleRefreshBtn').click(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const row = document.querySelector('#cfgStewardSchedule .steward-schedule-row[data-task-id="${firstId}"] .steward-schedule-badge');
    return row && row.dataset.outcome === 'succeeded' ? 1 : null;
  })()`)), 'B2 那一条的上次结果徽标变成「成功」');
  await cdp.evaluate(`(() => {
    const row = document.querySelector('#cfgStewardSchedule .steward-schedule-row[data-task-id="${firstId}"]');
    const buttons = row ? [...row.querySelectorAll('.steward-schedule-act')] : [];
    const runs = buttons.find(node => node.textContent === ${JSON.stringify(zh['settings.steward.schedule.runs'])});
    if (runs) runs.click();
    return Boolean(runs);
  })()`);
  ok(Boolean(await waitForEval(cdp, `(() => {
    const runs = document.querySelectorAll('#cfgStewardSchedule .steward-schedule-row[data-task-id="${firstId}"] .steward-schedule-run');
    return runs.length === 1 ? 1 : null;
  })()`)), 'B3 展开「最近几次」出恰好一行');
  const snapB = await cdp.evaluate(SNAP);
  const runB = ((snapB.rows.find(r => r.taskId === firstId) || {}).runs || [])[0] || {};
  ok(runB.mode === 'ontime' && String(runB.text).includes(zh['scheduler.mode.ontime']),
    `B4 那一行的触发模式是「${zh['scheduler.mode.ontime']}」（实得 mode=${runB.mode} 文案「${runB.text}」）`);

  /* ═════════ C/D 崩溃后的 unknown 与错过之后的补跑 ═════════ */
  // 两条新任务：U 用来造 J11（登记之后进程死掉），L 用来造 J10（错过一个时点之后重启补跑）。
  // **两个时点必须排在「后到的那条」(T0+120 分)之前**：本件第一版把它们放在 200／300 分，
  // 于是带崩溃钩子的那次重启一开机就发现「后到的那条」已经错过 —— 补跑、登记、然后被钩子打死，
  // 死在了错的任务上（U 的徽标于是恒是「还没跑过」）。排在 65／70 分，重启那一刻表里没有别的到点项。
  const uDue = T0 + 65 * MINUTE;
  const lDue = T0 + 70 * MINUTE;
  const uRes = await create('崩在半路的那条', uDue);
  const lRes = await create('错过一次的那条', lDue);
  const uId = uRes && uRes.json && uRes.json.task && uRes.json.task.id;
  const lId = lRes && lRes.json && lRes.json.task && lRes.json.task.id;
  ok(Boolean(uId && lId), `C0 两条新任务已建（${uId} / ${lId}）`);

  killTree(server);
  await waitExit(server);
  // ① 带崩溃钩子重启，时钟停在 U 到点【之前】—— 让它走正常的 ontime 那一支，登记完就死。
  setClock(uDue - 2 * MINUTE);
  server = spawnWb('after-register');
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'C1a 带崩溃钩子的服务起来了');
  setClock(uDue + 1 * MINUTE);
  ok((await waitExit(server)) === 3, 'C1b 服务在【登记之后】被钩子打死（exit 3）');
  // ② 干净重启，时钟越过 L 的时点 —— 恢复要同时做两件事：U 记 unknown、L 排一次补跑。
  setClock(lDue + 1 * MINUTE);
  server = spawnWb('');
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200)), 'C1c 干净重启');
  token = await waitToken(server);
  ok(Boolean(await waitForHttp(appPort, 'GET', '/api/scheduler/tasks', result => {
    const tasks = (result.json && result.json.tasks) || [];
    const u = tasks.find(item => item.id === uId);
    const l = tasks.find(item => item.id === lId);
    return Boolean(u && l && u.state.lastResult === 'unknown' && l.state.lastMode === 'late');
  }, token)), 'C1d 服务端事实：U 记成 unknown、L 的上次触发模式是 late');

  // 页面重连之后重新读一次（服务重启过，直接 reload 比赌 SSE 退避回来更确定）。
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'C2a 页面重载后首屏就绪');
  ok(Boolean(await openSettings()), 'C2b 重新打开「管家」页签');
  ok(Boolean(await waitForEval(cdp, `(() => document.querySelectorAll('#cfgStewardSchedule .steward-schedule-row').length >= 4 ? 1 : null)()`)),
    'C2c 设置块四行都在（跑过的 once 也留在表里 —— 它只是没有下一次了）');
  const snapC = await cdp.evaluate(SNAP);
  const rowU = snapC.rows.find(r => r.taskId === uId) || {};
  const rowL = snapC.rows.find(r => r.taskId === lId) || {};
  ok(rowU.outcome === 'unknown', `C3 J11 界面侧：崩在半路那一条的徽标 data-outcome 是 unknown（实得 ${rowU.outcome}）`);
  ok(String(rowU.badge).includes(zh['scheduler.outcome.unknown']),
    `C4 J11 界面侧：徽标原文是「${zh['scheduler.outcome.unknown']}」（实得「${rowU.badge}」）`);
  ok(!String(rowU.badge).includes(zh['scheduler.outcome.succeeded']),
    `C5 J11 界面侧：**不是**「${zh['scheduler.outcome.succeeded']}」（实得「${rowU.badge}」）`);
  ok(rowL.mode === 'late', `D1 J10 界面侧：补跑那一条的徽标 data-mode 是 late（实得 ${rowL.mode}）`);
  ok(String(rowL.badge).includes(zh['scheduler.mode.late']),
    `D2 J10 界面侧：徽标原文带「${zh['scheduler.mode.late']}」（实得「${rowL.badge}」）`);
  ok(!String(rowL.badge).includes(zh['scheduler.mode.ontime']),
    `D3 J10 界面侧：**不冒充**「${zh['scheduler.mode.ontime']}」（实得「${rowL.badge}」）`);

  /* ═════════ E 127 波 2-ter S-a：新建表单的档位下拉（真表单、真提交，读服务端落盘的那一份）═════════ */
  // 放在最后：前面 A–D 数的是行数与角标，这里多建的两条不能挤进那些计数里。
  const formState = `(() => {
    const block = document.getElementById('cfgStewardScheduleTierBlock');
    const select = document.getElementById('cfgStewardScheduleTier');
    return { hidden: block ? block.hidden : null, options: select ? [...select.options].map(o => o.value) : [],
      label: (block && block.querySelector('label')) ? block.querySelector('label').textContent : '' };
  })()`;
  const setField = (id, value) => `(() => {
    const node = document.getElementById(${JSON.stringify(id)});
    if (!node) return false;
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return node.value === ${JSON.stringify(value)};
  })()`;
  ok(Boolean(await cdp.evaluate(`(() => {
    const form = document.getElementById('cfgStewardScheduleForm');
    if (form && form.hidden) document.getElementById('cfgStewardScheduleNewBtn').click();
    return form && !form.hidden;
  })()`)), 'E0 点「新建」打开表单');
  await cdp.evaluate(setField('cfgStewardSchedulePayloadKind', 'reminder'));
  const eReminder = await cdp.evaluate(formState);
  await cdp.evaluate(setField('cfgStewardSchedulePayloadKind', 'prompt'));
  await cdp.evaluate(setField('cfgStewardScheduleTarget', 'new-session'));
  const ePrompt = await cdp.evaluate(formState);
  await cdp.evaluate(setField('cfgStewardScheduleTarget', 'existing-session'));
  const eExisting = await cdp.evaluate(formState);
  await cdp.evaluate(setField('cfgStewardScheduleTarget', 'new-session'));
  ok(eReminder.hidden === true && ePrompt.hidden === false && eExisting.hidden === true,
    `E1 档位只在「跑一个回合 + 每次开新线程」时出现（实得 reminder=${eReminder.hidden} prompt/new=${ePrompt.hidden} existing=${eExisting.hidden}）`);
  ok(JSON.stringify(ePrompt.options) === JSON.stringify(['', 'strong', 'fast']) && ePrompt.label === zh['settings.steward.schedule.form.tier'],
    `E2 三个选项（跟随全局 / strong / fast）与标签走目录（实得 ${JSON.stringify(ePrompt.options)}「${ePrompt.label}」）`);
  const submitWith = async (title, tier) => {
    await cdp.evaluate(`(() => {
      const form = document.getElementById('cfgStewardScheduleForm');
      if (form && form.hidden) document.getElementById('cfgStewardScheduleNewBtn').click();
      return true;
    })()`);
    await cdp.evaluate(setField('cfgStewardScheduleTitle', title));
    await cdp.evaluate(setField('cfgStewardScheduleKind', 'daily'));
    await cdp.evaluate(setField('cfgStewardScheduleAt', '09:30'));
    await cdp.evaluate(setField('cfgStewardSchedulePayloadKind', 'prompt'));
    await cdp.evaluate(setField('cfgStewardScheduleTarget', 'new-session'));
    await cdp.evaluate(setField('cfgStewardScheduleText', title + '：按计划做一次'));
    await cdp.evaluate(setField('cfgStewardScheduleTier', tier));
    await cdp.evaluate(`(() => { document.getElementById('cfgStewardScheduleSubmitBtn').click(); return true; })()`);
    const listed = await waitForHttp(appPort, 'GET', '/api/scheduler/tasks',
      result => ((result.json && result.json.tasks) || []).some(item => item.title === title), token);
    return listed ? (listed.json.tasks.find(item => item.title === title) || null) : null;
  };
  const fastRow = await submitWith('表单选了快档', 'fast');
  ok(Boolean(fastRow) && fastRow.target && fastRow.target.mode === 'new-session' && fastRow.target.tier === 'fast',
    `E3 表单选「简单任务 · 快速模型」提交 → 服务端那一份 target.tier=fast（实得 ${JSON.stringify(fastRow && fastRow.target)}）`);
  const plainRow = await submitWith('表单跟随全局', '');
  ok(Boolean(plainRow) && JSON.stringify(plainRow.target) === '{"mode":"new-session"}',
    `E4 表单留「跟随全局主端点」→ target 里没有 tier 键（与修前逐字节同形；实得 ${JSON.stringify(plainRow && plainRow.target)}）`);

  const shot = path.join(shotDir, 'scheduler-ui-final.png');
  fs.writeFileSync(shot, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  console.log(`SHOT ${shot}`);
} catch (error) {
  fail += 1;
  console.log('FAIL 未预期异常: ' + (error && error.message ? error.message : String(error)));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  try { stopRuyiTestBrowsers(path.join(root, 'profile')); } catch { /* ignore */ }
}

console.log(`\nSCHEDULER UI BROWSER E2E: ${fail ? 'FAIL (' + fail + ')' : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 第117波 117a/117b 真实浏览器 E2E：视角准入与 fail-closed + avatar 状态。
// 121-K1（34 号文 §2.7／§8.1）：交办台退役，`data-shell-mode` 收成两值 —— 本件随之从「三态并存」
// 改判「两视互斥」，另加一条搬家自己带来的新事实（④：未知/退役偏好落 steward 后本机不留死值）。
//   ① 管家开关关 + 本机偏好写 steward → 加载后回工作台视角、偏好被改回 classic、设置页管家项置灰并给原因；
//   ② 管家开关开 → 选中管家 → 两个同级容器显隐互斥、容器获焦、零 30s 后台轮询税；
//   ③ 管家 → 工作台 → 管家全链路，data-shell-mode 与 localStorage 始终一致（刷新后仍恢复管家）；
//   ④ 本机偏好被写成未知值/已退役的 'preview' → 归一化成 steward 并就地改写偏好（不留死值），
//      管家开关关时仍 fail-closed 到工作台视角；
//   ⑤（117b）进入管家壳时头像态为 idle 且自己的 5s 状态轮询在跑，回工作台后计时器被清；
//   ⑥（117b）输入框聚焦并输入 → listening，清空并失焦 → idle。
// CDP 无头驱动；轮询断言用 addScriptToEvaluateOnNewDocument 包住 setInterval/clearInterval，
// 直接看「30000ms／5000ms 的活计时器还在不在」。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
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
const en = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'en-US.json'), 'utf8'));
const DISABLED_REASONS = [zh['stewardShell.recovery.disabled'], en['stewardShell.recovery.disabled']];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const { findBrowserExecutable } = require('./lib/browser-path');
const browserPath = findBrowserExecutable;

function request(port, pathname) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch { /* non-json response */ }
        resolve({ status: response.statusCode, body, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 117j：预算从 100×60ms(6s) 提到 200×60ms(12s)，与同族另外五件 steward e2e 一致 —— 本件是这一族里
// 唯一一个把预算定在 6 秒的，机器一忙 A1 就随机红。断言本身没放宽：工作台还是必须真的起来。
// （排查时真正的元凶是【单独跑浏览器 e2e 会漏掉 Edge 进程】：run-all 每件跑完会调
//  lib/browser-cleanup.js 的 stopRuyiTestBrowsers 收尸，手工单跑不会 —— 攒到 345 个 msedge 之后
//  冷启动从 4 秒涨到 24～86 秒，看上去就像「服务起不来的回归」。手工连跑记得自己收一次。）
async function waitForHttp(port, pathname, predicate, attempts = 200) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, pathname);
    if (result && predicate(result)) return result;
    await sleep(60);
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
  for (let i = 0; i < 160; i++) {
    const result = await request(debugPort, '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}

async function waitForEval(cdp, expression, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload swaps execution context */ }
    await sleep(30);
  }
  return null;
}

// 应用就绪 = 组合根已绑完事件、status 已到（config 到达才谈得上管家开关）。
const READY = `(() => {
  const select = document.getElementById('cfgShellMode');
  if (!select || typeof select.onchange !== 'function') return null;
  if (!document.getElementById('stewardShell') || !window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

const SHELL_SNAPSHOT = `(() => {
  const select = document.getElementById('cfgShellMode');
  const option = select && select.querySelector('option[value="steward"]');
  const classic = document.querySelector('.app-shell');
  const steward = document.getElementById('stewardShell');
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    stored: localStorage.getItem('wcw.shellMode'),
    select: select ? select.value : '',
    stewardOptionDisabled: option ? option.disabled : null,
    hintHidden: document.getElementById('stewardShellModeHint')?.hidden ?? null,
    classicDisplay: getComputedStyle(classic).display,
    stewardDisplay: getComputedStyle(steward).display,
    previewShellPresent: Boolean(document.getElementById('previewShell')),
    status: document.getElementById('stewardStatus').textContent,
    focused: document.activeElement ? document.activeElement.id : '',
    // 121-K1：30s 那一档曾经是交办台自己的轮询。它随交办台退役，这个数字自此恒为 0 ——
    // 判据从「切走后停掉」变成「全仓再没有这一档后台税」，是收紧不是放宽。
    legacyPollTimers: (window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : []).filter(ms => ms === 30000).length,
    // 117b：管家自己的状态轮询。117j W2-4 重钉：表按 5s 下限起（真要不要拉由 pollStewardTick 自己判，
    // 见 steward-shell.js 那段头注），所以「这是管家的计时器」的身份判据从 config.stewardPollMs
    // 重钉到 5000 —— 不改的话本断言恒为 0，D8 会从「轮询在跑」变成永远失败。
    stewardPollTimers: (window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : []).filter(ms => ms === 5000).length,
    avatarState: document.getElementById('stewardAvatar')?.dataset.state || '',
  };
})()`;

const appPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-shell-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
const configFile = path.join(home, 'config.json');
const writeConfig = stewardEnabledV1 => fs.writeFileSync(configFile, JSON.stringify({
  // 117j 排查 A1「workbench started」偶发红时补上的：不关这个开关，启动时会把【开发机真实的】
  // ~/.claude.json 里那一批 MCP server 导进这个临时 HOME（本机 10 个，其中几个是故意做成挂起/
  // 断连的夹具）。实测它不是这次超时的主因（关掉前后都在 4～7.5 秒之间摆动，主要看机器负载），
  // 但「临时 HOME 的 e2e 去读开发机的真实配置」本身就不该发生 —— v2.5 波已为此立过同一条纪律。
  autoImportClaudeCodeMcp: false,
  configSchema: 9,
  version: '2.4.0',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: ROOT,
  includeWorkbenchMcp: false,
  stewardEnabledV1,
  // 体验走查 #1 之后：一个模型都没接时管家输入框是置灰的（先接模型才能说话）。本件量的是头像态与输入框的
  // 交互（F1 要往输入框里打字），所以给一个【不会被真调用】的 OpenAI 兼容端点 —— 本件不发任何一轮回合。
  activeProvider: 'fake',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');
writeConfig(false);

let server = null;
let browser = null;
let cdp = null;
try {
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true,
    stdio: 'ignore',
  });
  const healthy = await waitForHttp(appPort, '/health', result => result.status === 200, 300); // 117q:此启动门原吃默认 attempts=200(200×60ms=12s)余量对本机冷启动实测 4.6-6.3s 偏窄,是「FAIL workbench up」假红的根;本文件此助手只此一处调用,仍按同批 12 处一致的编辑形态显式传 300 而不改默认(30 号文 P1-31)
  ok(Boolean(healthy), 'A1 workbench started');
  const executable = browserPath();
  ok(Boolean(executable), 'A2 Edge/Chrome found');
  if (!healthy || !executable) throw new Error('browser prerequisites unavailable');

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
  // 活计时器探针：包住 setInterval/clearInterval，只记周期，随每次刷新自动重装。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
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

  // 后端本波零改动：管家开关本来就在 status 的 config 里，前端读到的就是它。
  const bootConfig = await waitForEval(cdp, READY) && await cdp.evaluate('({ steward: window.state.config.stewardEnabledV1 })');
  ok(bootConfig && bootConfig.steward === false, 'A5 前端 state.config 直接拿到 stewardEnabledV1（后端零改动）');

  // ─── ④ 未知/退役偏好的归一化 ───────────────────────────────────────────────────
  // 121-K1：未知值与已退役的 'preview' 都归一成 steward（与 index.html 预绘脚本同构），但这一拍
  // 管家开关还关着，于是准入判定 fail-closed 到工作台视角 —— 最终落点仍是 classic，而本机偏好里
  // 不再留着那个死值。两个输入各跑一遍：判据不是「某个字面量」，是「归一化 + fail-closed」。
  ok(!(await cdp.evaluate(SHELL_SNAPSHOT)).previewShellPresent,
    'B0 交办台容器 #previewShell 已随它退役（真浏览器里也不存在）');
  for (const stale of ['foo', 'preview']) {
    await cdp.evaluate(`localStorage.setItem('wcw.shellMode', ${JSON.stringify(stale)}); location.reload(); true`);
    await waitForEval(cdp, READY);
    const unknown = await waitForEval(cdp, `(() => {
      const snapshot = ${SHELL_SNAPSHOT};
      return snapshot.stored === 'classic' ? snapshot : null;
    })()`);
    ok(unknown && unknown.mode === 'classic' && unknown.classicDisplay !== 'none'
      && unknown.stewardDisplay === 'none' && unknown.stored === 'classic',
      `B1 本机偏好是 '${stale}' 时归一成 steward、准入不过再 fail-closed 到工作台视角，偏好里不留死值（实测 mode=${unknown && unknown.mode} / stored=${unknown && unknown.stored}）`);
  }

  // ─── ① 开关关 + 偏好写 steward → fail-closed ─────────────────────────────────
  await cdp.evaluate("localStorage.setItem('wcw.shellMode', 'steward'); location.reload(); true");
  await waitForEval(cdp, READY);
  const closed = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.stored === 'classic' ? snapshot : null;
  })()`);
  ok(closed && closed.mode === 'classic' && closed.stored === 'classic' && closed.select === 'classic',
    'C1 管家开关关时：模式、本机偏好、设置页选择器一起回经典');
  ok(closed && closed.stewardOptionDisabled === true && closed.hintHidden === false,
    'C2 管家开关关时设置页管家项置灰并显示「先打开管家」提示');
  ok(closed && DISABLED_REASONS.includes(closed.status),
    'C3 状态区用 i18n 说明回退原因（不是空白，也不是英文兜底键名）');
  ok(closed && closed.classicDisplay !== 'none' && closed.stewardDisplay === 'none',
    'C4 回退后的经典壳完整可用，管家壳保持隐藏');

  // ─── ② 开关开 → 管家：显隐互斥、获焦、零后台税 ────────────────────────────────
  writeConfig(true);
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  const enabled = await waitForEval(cdp, `(() => {
    const option = document.querySelector('#cfgShellMode option[value="steward"]');
    return option && option.disabled === false ? ${SHELL_SNAPSHOT} : null;
  })()`);
  ok(enabled && enabled.stewardOptionDisabled === false && enabled.hintHidden === true,
    'D1 管家开关开后管家项可选，提示收起');
  // 121-K1：先显式落在工作台视角，再切管家 —— 原来这一步是「先切交办台预览」，那一档已退役。
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'classic';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const classicOn = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'classic' ? snapshot : null;
  })()`);
  ok(classicOn && classicOn.stored === 'classic'
    && classicOn.classicDisplay !== 'none' && classicOn.stewardDisplay === 'none'
    && classicOn.legacyPollTimers === 0,
    'D2 工作台视角独占画面，且全仓再没有交办台那一档 30s 后台轮询');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const stewardOn = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.focused === 'stewardShell' ? snapshot : null;
  })()`);
  ok(stewardOn && stewardOn.mode === 'steward' && stewardOn.stored === 'steward' && stewardOn.select === 'steward',
    'D3 切到管家壳：唯一状态源、本机偏好、选择器三者一致');
  ok(stewardOn && stewardOn.stewardDisplay !== 'none' && stewardOn.classicDisplay === 'none',
    'D4 两个同级容器显隐互斥，管家壳独占画面');
  ok(stewardOn && stewardOn.focused === 'stewardShell', 'D5 进入管家壳后焦点落在同级容器上');
  ok(stewardOn && stewardOn.legacyPollTimers === 0,
    'D6 管家壳不引入 30s 档的后台税（交办台那一档已随它退役）');
  // 117b：avatar 态 + 自己的状态轮询（仅在管家模式下才起，与 D6 的「零 30s 后台税」互补）。
  ok(stewardOn && stewardOn.avatarState === 'idle',
    'D7 进入管家壳时头像态为 idle(开关开、未停机、无待决、无错误——GET /api/steward/state 的默认实况)');
  const stewardPolling = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.stewardPollTimers > 0 ? snapshot : null;
  })()`);
  ok(stewardPolling && stewardPolling.stewardPollTimers > 0,
    'D8 管家壳自己对 /api/steward/state 的状态轮询在跑(表按 5s 下限起,只在管家模式下才起)');

  // ─── ③ 刷新恢复 + 管家 → 工作台 → 管家全链路一致 ──────────────────────────────
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  const restored = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'steward' ? snapshot : null;
  })()`);
  ok(restored && restored.stored === 'steward' && restored.select === 'steward'
    && restored.stewardDisplay !== 'none' && restored.classicDisplay === 'none',
    'E1 开关开着时管家壳偏好跨刷新恢复（bind 期的准入回退不会误删偏好）');

  // 121-K4（34 号文 §2.2／§2.7）：切视角的入口从管家壳输入区那枚「经典模式」改成外框顶栏的
  // 分段钮（全仓唯一入口；快捷键 Ctrl+` 是它的同一条路）。点的东西换了，钉的事一个字没变。
  await cdp.evaluate("document.querySelector('#lensSeg [data-lens=\"classic\"]').click(); true");
  const backToClassic = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'classic' ? snapshot : null;
  })()`);
  ok(backToClassic && backToClassic.stored === 'classic' && backToClassic.select === 'classic'
    && backToClassic.classicDisplay !== 'none' && backToClassic.stewardDisplay === 'none'
    && backToClassic.legacyPollTimers === 0,
    'E2 顶栏分段钮切到工作台视角：落盘一致且不留轮询');
  const segAfterClassic = await cdp.evaluate(`(() => {
    const seg = document.getElementById('lensSeg');
    return JSON.stringify({
      on: seg.dataset.on,
      pressed: [...seg.querySelectorAll('[data-lens]')].map(b => b.dataset.lens + ':' + b.getAttribute('aria-pressed')),
    });
  })()`);
  ok(segAfterClassic === JSON.stringify({ on: 'classic', pressed: ['steward:false', 'classic:true'] }),
    `E2b 分段钮的样子只读 data-shell-mode（滑块与 aria-pressed 跟着实况，实得 ${segAfterClassic}）`);
  ok(backToClassic && backToClassic.stewardPollTimers === 0,
    'E2a 回到工作台后管家自己的状态轮询计时器也被清(MutationObserver 盯 data-shell-mode，立即 stopPolling)');

  // 121-K1：原 E3/E3a 走的是「再切回交办台预览」那一档。那一档退役后，全链路的最后一跳改回管家 ——
  // 钉的仍是同一件事：两视之间怎么绕，data-shell-mode / localStorage / 选择器三者始终一致。
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const backToSteward = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'steward' ? snapshot : null;
  })()`);
  ok(backToSteward && backToSteward.stored === 'steward' && backToSteward.select === 'steward'
    && backToSteward.stewardDisplay !== 'none' && backToSteward.classicDisplay === 'none',
    'E3 管家 → 工作台 → 管家全链路：两视与本机偏好始终一致');
  ok(backToSteward && backToSteward.legacyPollTimers === 0,
    'E3a 绕一圈回来仍然零 30s 档后台税（后台税不随视角切换累积）');

  // ─── F 117b：输入框聚焦/输入 → listening，清空/失焦 → idle ──────────────────────
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  // applyShellMode('steward') 排了一次 requestAnimationFrame 把焦点落到 #stewardShell 容器（同 D5）；
  // 先等这一拍尘埃落定，再把焦点抢到输入框——否则输入框的 focus 有概率被随后才触发的容器 rAF
  // 焦点抢走，一 blur 就把 typing 冲回 false，是测试脚本的时序竞争，不是被测代码的缺陷。
  await waitForEval(cdp, `(() => { const s = ${SHELL_SNAPSHOT}; return s.mode === 'steward' && s.focused === 'stewardShell' ? s : null; })()`);
  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.focus();
    input.value = '你好';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  const listening = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.avatarState === 'listening' && snapshot.focused === 'stewardComposerInput' ? snapshot : null;
  })()`);
  ok(listening && listening.avatarState === 'listening',
    'F1 输入框聚焦并输入非空文本后，头像态变为 listening(117a 的禁用占位在 117b 改为可聚焦，仅测这一态)');

  await cdp.evaluate(`(() => {
    const input = document.getElementById('stewardComposerInput');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
    return true;
  })()`);
  const backIdle = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.avatarState === 'idle' ? snapshot : null;
  })()`);
  ok(backIdle && backIdle.avatarState === 'idle', 'F2 清空文本并失焦后，头像态回到 idle');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  await sleep(300);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD SHELL E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

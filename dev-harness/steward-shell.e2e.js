#!/usr/bin/env node
'use strict';

// 第117波 117a 真实浏览器 E2E：壳模式三态并存的准入与 fail-closed。
//   ① 管家开关关 + 本机偏好写 steward → 加载后回经典、偏好被改回 classic、设置页第三项置灰并给原因；
//   ② 管家开关开 → 选中管家 → 三个同级容器显隐互斥、容器获焦、交办台 30s 轮询计时器被停掉；
//   ③ 管家 → 经典 → 交办台预览全链路，data-shell-mode 与 localStorage 始终一致（刷新后仍恢复管家）；
//   ④ 本机偏好被写成未知值 → 回经典。
// 与 pretender-shell.e2e.js 同一套 CDP 无头驱动；轮询断言用 addScriptToEvaluateOnNewDocument
// 包住 setInterval/clearInterval，直接看「30000ms 的活计时器还在不在」。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

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

function browserPath() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file)) || '';
}

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

async function waitForHttp(port, pathname, predicate, attempts = 100) {
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
  const preview = document.getElementById('previewShell');
  const steward = document.getElementById('stewardShell');
  return {
    mode: document.documentElement.getAttribute('data-shell-mode'),
    stored: localStorage.getItem('wcw.shellMode'),
    select: select ? select.value : '',
    stewardOptionDisabled: option ? option.disabled : null,
    hintHidden: document.getElementById('stewardShellModeHint')?.hidden ?? null,
    classicDisplay: getComputedStyle(classic).display,
    previewDisplay: getComputedStyle(preview).display,
    stewardDisplay: getComputedStyle(steward).display,
    status: document.getElementById('stewardStatus').textContent,
    focused: document.activeElement ? document.activeElement.id : '',
    previewPollTimers: (window.__ruyiLiveIntervals ? window.__ruyiLiveIntervals() : []).filter(ms => ms === 30000).length,
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
  configSchema: 9,
  version: '2.4.0',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: ROOT,
  includeWorkbenchMcp: false,
  stewardEnabledV1,
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
  const healthy = await waitForHttp(appPort, '/health', result => result.status === 200);
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

  // ─── ④ 未知偏好回经典 ──────────────────────────────────────────────────────────
  await cdp.evaluate("localStorage.setItem('wcw.shellMode', 'foo'); location.reload(); true");
  await waitForEval(cdp, READY);
  const unknown = await cdp.evaluate(SHELL_SNAPSHOT);
  ok(unknown && unknown.mode === 'classic' && unknown.classicDisplay !== 'none'
    && unknown.previewDisplay === 'none' && unknown.stewardDisplay === 'none',
    'B1 未知壳模式偏好回经典，另外两壳保持隐藏');

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
    'C2 管家开关关时设置页第三项置灰并显示「先打开管家」提示');
  ok(closed && DISABLED_REASONS.includes(closed.status),
    'C3 状态区用 i18n 说明回退原因（不是空白，也不是英文兜底键名）');
  ok(closed && closed.classicDisplay !== 'none' && closed.stewardDisplay === 'none',
    'C4 回退后的经典壳完整可用，管家壳保持隐藏');

  // ─── ② 开关开 → 交办台预览 → 管家：显隐互斥、获焦、轮询停摆 ───────────────────
  writeConfig(true);
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  const enabled = await waitForEval(cdp, `(() => {
    const option = document.querySelector('#cfgShellMode option[value="steward"]');
    return option && option.disabled === false ? ${SHELL_SNAPSHOT} : null;
  })()`);
  ok(enabled && enabled.stewardOptionDisabled === false && enabled.hintHidden === true,
    'D1 管家开关开后第三项可选，提示收起');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'preview';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const previewOn = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.previewPollTimers > 0 ? snapshot : null;
  })()`);
  ok(previewOn && previewOn.mode === 'preview' && previewOn.stored === 'preview'
    && previewOn.previewDisplay !== 'none' && previewOn.classicDisplay === 'none' && previewOn.stewardDisplay === 'none',
    'D2 交办台预览壳独占画面，30s 轮询计时器在跑');

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
  ok(stewardOn && stewardOn.stewardDisplay !== 'none'
    && stewardOn.classicDisplay === 'none' && stewardOn.previewDisplay === 'none',
    'D4 三个同级容器显隐互斥，管家壳独占画面');
  ok(stewardOn && stewardOn.focused === 'stewardShell', 'D5 进入管家壳后焦点落在同级容器上');
  ok(stewardOn && stewardOn.previewPollTimers === 0,
    'D6 管家壳不继承交办台的 30s 轮询，也不引入自己的后台税');

  // ─── ③ 刷新恢复 + 管家 → 经典 → 预览全链路一致 ────────────────────────────────
  await cdp.evaluate('location.reload(); true');
  await waitForEval(cdp, READY);
  const restored = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'steward' ? snapshot : null;
  })()`);
  ok(restored && restored.stored === 'steward' && restored.select === 'steward'
    && restored.stewardDisplay !== 'none' && restored.classicDisplay === 'none',
    'E1 开关开着时管家壳偏好跨刷新恢复（bind 期的准入回退不会误删偏好）');

  await cdp.evaluate("document.getElementById('stewardClassicBtn').click(); true");
  const backToClassic = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'classic' ? snapshot : null;
  })()`);
  ok(backToClassic && backToClassic.stored === 'classic' && backToClassic.select === 'classic'
    && backToClassic.classicDisplay !== 'none' && backToClassic.stewardDisplay === 'none'
    && backToClassic.previewPollTimers === 0,
    'E2 管家壳内「回到经典」落盘一致且不留轮询');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'preview';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const finalPreview = await waitForEval(cdp, `(() => {
    const snapshot = ${SHELL_SNAPSHOT};
    return snapshot.mode === 'preview' ? snapshot : null;
  })()`);
  ok(finalPreview && finalPreview.stored === 'preview' && finalPreview.select === 'preview'
    && finalPreview.previewDisplay !== 'none' && finalPreview.stewardDisplay === 'none' && finalPreview.classicDisplay === 'none',
    'E3 管家 → 经典 → 预览全链路：三态与本机偏好始终一致');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nSTEWARD SHELL E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

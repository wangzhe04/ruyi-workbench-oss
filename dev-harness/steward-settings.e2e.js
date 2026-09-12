#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 第117波 117e 真实浏览器 E2E（27 号文 §5 117e 行／§8.6「权限的界面表达」／§4「面板」）。
//
// 从「管家开关关着」的干净状态出发，把设置页「管家」页签整条走一遍：
//   ① 打开设置 → 切到「管家」页签 → 勾开总开关 → GET /api/steward/state 可用且 running；
//   ② 默认权限改到「改文件不问」→ config 落盘；
//   ③ 切「全自动」→ 出二次确认（§8.6 五条文案，与线程 chip 同一份）→ 取消不变 → 再来一次确认后 auto；
//   ④ 自理清单勾「事项内自动交接」→ stewardAutoActions.relay === true（其余三项不被顺手改掉）；
//   ⑤ 并发上限改 3 → GET /api/steward/arbiter 立即生效（116h：仲裁器每次唤醒重读配置）；
//   ⑥ 记忆面板：夹具两条 → 按 kind 分组显示、「新」标 → 否决 → 恢复 → 就地编辑保存 →
//      导出的 JSON 里含该条 → 清空必须逐字输入 clear；
//   ⑦ 行动流水：夹具两条决策 → 表格出现、按线程过滤只剩一条；
//   ⑧ 头部常驻停机键 → GET /api/steward/state 的 stopped===true 且头像 data-state="sleeping"
//      → 再按一次唤醒 → stopped===false 且头像不再 sleeping；
//   ⑨（117l-A3）新开线程用什么模型：强/快两档各自的服务商 select + 模型名 input 分别改动 →
//      GET /api/status 的 config.stewardThreadModels.{strong,fast}.{providerId,model} 落盘同值；
//      改快档不冲掉刚存的强档（整对象上传，不是只传半个）。依赖服务端 stewardThreadModels 配置键
//      （由并行切片 A1 加：01-config.js 的 defaultConfig/normalizeConfig）。
//
// 与 steward-shell / steward-conversation / steward-drawer 同一套 CDP 无头驱动。
// 后端只多用 117e 第 0 步那一条只读面（/api/steward/decisions）。
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

const POLL_MS = 120000;   // 轮询周期拉满：测试窗口内壳层不会自己 tick，断言不受它干扰
const SID_A = 'sess_settings_thread_a';
const SID_B = 'sess_settings_thread_b';

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
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload swaps execution context */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!document.getElementById('cfgStewardEnabled')) return null;
  if (!document.getElementById('stewardShieldBtn') || !document.getElementById('stewardStopBtn')) return null;
  if (!window.state || !window.state.status || !window.state.config) return null;
  return { ready: true };
})()`;

// 打开设置弹窗并切到「管家」页签（走真实入口：按钮 + 页签按钮，不直接调内部函数）。
const OPEN_TAB = `(() => {
  document.getElementById('openSettingsBtn').click();
  const tab = document.querySelector('#settingsTabs button[data-stab="steward"]');
  if (!tab) return null;
  tab.click();
  const panel = document.getElementById('stab-steward');
  return panel && panel.classList.contains('active') ? { open: true } : null;
})()`;

const PANEL = `(() => {
  const text = id => { const node = document.getElementById(id); return node ? node.textContent.trim() : ''; };
  const val = id => { const node = document.getElementById(id); return node ? node.value : ''; };
  const checked = id => { const node = document.getElementById(id); return node ? node.checked : null; };
  const shield = document.getElementById('stewardShieldBtn');
  const stop = document.getElementById('stewardStopBtn');
  const avatar = document.getElementById('stewardAvatar');
  return {
    enabled: checked('cfgStewardEnabled'),
    permission: val('cfgStewardDefaultPermission'),
    permissionHint: text('cfgStewardPermissionHint'),
    confirmHidden: document.getElementById('cfgStewardPermissionConfirm').hidden,
    confirmLines: [...document.querySelectorAll('#cfgStewardPermissionConfirmList li')].map(node => node.textContent.trim()),
    autoRetry: checked('cfgStewardAutoRetry'),
    autoRelay: checked('cfgStewardAutoRelay'),
    autoNewThread: checked('cfgStewardAutoNewThread'),
    autoResume: val('cfgStewardAutoResume'),
    parallel: val('cfgStewardMaxParallelThreads'),
    retention: val('cfgStewardRetention'),
    poll: val('cfgStewardPollMs'),
    providerOptions: [...document.querySelectorAll('#cfgStewardProviderId option')].map(node => node.value),
    strongProviderOptions: [...document.querySelectorAll('#cfgStewardStrongProviderId option')].map(node => node.value),
    fastProviderOptions: [...document.querySelectorAll('#cfgStewardFastProviderId option')].map(node => node.value),
    strongProviderId: val('cfgStewardStrongProviderId'),
    strongModel: val('cfgStewardStrongModel'),
    fastProviderId: val('cfgStewardFastProviderId'),
    fastModel: val('cfgStewardFastModel'),
    memoryGroups: [...document.querySelectorAll('#cfgStewardMemoryPanel .steward-memory-group')].map(node => node.dataset.kind),
    memoryTexts: [...document.querySelectorAll('#cfgStewardMemoryPanel .steward-memory-text')].map(node => node.value),
    memoryNew: document.querySelectorAll('#cfgStewardMemoryPanel .steward-memory-new').length,
    memoryStates: [...document.querySelectorAll('#cfgStewardMemoryPanel .steward-memory-item')].map(node => node.dataset.state),
    decisionRows: [...document.querySelectorAll('#cfgStewardDecisions tbody tr')].map(node => node.dataset.thread),
    decisionCells: [...document.querySelectorAll('#cfgStewardDecisions tbody tr td')].map(node => node.textContent.trim()),
    decisionHead: [...document.querySelectorAll('#cfgStewardDecisions thead th')].map(node => node.textContent.trim()),
    threadFilter: [...document.querySelectorAll('#cfgStewardDecisionsThread option')].map(node => node.value),
    note: text('cfgStewardNote'),
    runState: text('cfgStewardRunState'),
    shield: shield ? shield.textContent.trim() : '',
    shieldPermission: shield ? (shield.dataset.permission || '') : '',
    stopLabel: stop ? stop.textContent.trim() : '',
    stopFlag: stop ? (stop.dataset.stopped || '') : '',
    avatarState: avatar ? (avatar.dataset.state || '') : '',
    clearHidden: document.getElementById('cfgStewardMemoryClearConfirm').hidden,
    blobs: window.__ruyiBlobs || [],
  };
})()`;

// F5a（27 号文 §11.13.1「F 追加」）：头部两枚常驻控件的【字形】。SVG 里没有文字可读，所以这里读
// 路径本身 —— 四档盾牌必须两两不同却共享同一条盾牌轮廓；停机键必须是电源符（已停机多一道斜杠），
// 而且不能是线程「停止」那枚实心方块（那一枚是 <rect>）。
const HEADER = `(() => {
  const paths = node => (node ? [...node.querySelectorAll('svg path')].map(item => item.getAttribute('d')) : []);
  const shield = document.getElementById('stewardShieldBtn');
  const stop = document.getElementById('stewardStopBtn');
  const menu = document.getElementById('stewardShieldMenu');
  return {
    shieldText: shield ? shield.textContent.trim() : '',
    shieldLabel: shield ? (shield.querySelector('.steward-shield-label') || { textContent: '' }).textContent.trim() : '',
    shieldGlyph: paths(shield).join('|'),
    shieldSvgs: shield ? shield.querySelectorAll('svg').length : 0,
    shieldCarets: shield ? shield.querySelectorAll('.steward-shield-caret').length : 0,
    shieldExpanded: shield ? shield.getAttribute('aria-expanded') : '',
    shieldAria: shield ? shield.getAttribute('aria-label') : '',
    menuHidden: menu ? menu.hidden : null,
    menuModes: [...document.querySelectorAll('#stewardShieldMenu .steward-shield-option')].map(node => node.dataset.permissionMode),
    menuLabels: [...document.querySelectorAll('#stewardShieldMenu .steward-shield-option-label')].map(node => node.textContent.trim()),
    stopGlyph: paths(stop).join('|'),
    stopPaths: paths(stop).length,
    stopRects: stop ? stop.querySelectorAll('svg rect').length : 0,
    stopText: stop ? stop.textContent.trim() : '',
  };
})()`;
const SHIELD_OUTLINE = 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z';
const POWER_ARC = 'M18.36 6.64a9 9 0 1 1-12.73 0';
const POWER_SLASH = 'M4.5 19.5 19.5 4.5';

const appPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-settings-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.mkdirSync(path.join(home, 'steward'), { recursive: true });

// 记忆夹具：两条不同 kind，createdAt 都在 24h 内（面板的「新」标是纯派生）。
const nowIso = new Date().toISOString();
fs.writeFileSync(path.join(home, 'steward', 'memory-v1.json'), JSON.stringify({
  schema: 1,
  updatedAt: nowIso,
  entries: [
    { id: 'mem_pref_1', kind: 'preference', text: '报告都给我写成中文', confidence: 0.8, sourceSessionId: SID_A, sourceSeq: 1, createdAt: nowIso, updatedAt: nowIso, lastUsedAt: '', useCount: 2, state: 'active', mergedFrom: [] },
    { id: 'mem_habit_1', kind: 'habit', text: '周一整理上周任务', confidence: 0.6, sourceSessionId: SID_B, sourceSeq: 3, createdAt: nowIso, updatedAt: nowIso, lastUsedAt: '', useCount: 0, state: 'active', mergedFrom: [] },
  ],
}, null, 2), 'utf8');

// 决策夹具：两条，分属两条线程；第一条带撤回锚点（表格给「撤销」），第二条不带（给「详情」）。
fs.writeFileSync(path.join(home, 'steward', 'decisions-v1.ndjson'), [
  JSON.stringify({ seq: 1, at: '2026-09-06T01:00:00.000Z', tool: 'steward_thread_continue', args: { sessionId: SID_A }, targetSessionId: SID_A, permissionMode: 'acceptEdits', mayAct: 'auto', undoRef: { kind: 'turn', sessionId: SID_A, turnSeq: 2, rewindTargetTurnSeq: 3 }, basis: { inboxSeq: 7, auto: true } }),
  JSON.stringify({ seq: 2, at: '2026-09-06T02:00:00.000Z', tool: 'steward_decide', args: { type: 'permission', action: 'allow' }, targetSessionId: SID_B, permissionMode: 'auto', mayAct: 'auto', undoRef: { kind: 'none', note: '不可撤销' }, basis: { interventionId: 'iv_1' } }),
].join('\n') + '\n', 'utf8');

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
  // 出发点：管家【关着】。① 会把它打开。
  stewardEnabledV1: false,
  stewardPollMs: POLL_MS,
  stewardMaxParallelThreads: 5,
  stewardAutoActions: { retry: true, resume: null, relay: false, newThread: true },
  // 117l-A3：夹具备两个 provider——⑨ 用第二个（'fake2'）来验证「强/快两档」的 providerId select
  // 真的切到了非默认值（只有一个 provider 时，选它和「跟随」在肉眼上分不出差别）。
  providers: [
    { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
    { id: 'fake2', label: 'Fake Two', type: 'openai-compat', baseUrl: 'http://127.0.0.1:2', apiKey: 'k2', model: 'fake2-model', models: [{ id: 'fake2-model', label: 'Fake Two' }] },
  ],
}), 'utf8');

let server = null;
let browser = null;
let cdp = null;
try {
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started'); // 117q:此启动门原吃默认 attempts=200(200×80ms=16s)低于 30 号文 P1-31 建议的 300×同款间隔量级,是「FAIL workbench up」假红的根;默认值被本文件下方大量业务断言调用复用,不能整体抬,这里改成显式传 300 只抬这一处(30 号文 P1-31)

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');
  const cfg = async () => (await request(appPort, 'GET', '/api/status', null, token)).json.config;
  ok((await cfg()).stewardEnabledV1 !== true, 'A3 出发点：管家开关是关着的');

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
  // 导出探针：把 blob 内容截下来，同时让 href 变成一个不可下载的桩（无头下载会污染 profile 目录）。
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__ruyiBlobs = [];
      URL.createObjectURL = function (blob) {
        try { blob.text().then(text => window.__ruyiBlobs.push(text)); } catch (e) { /* ignore */ }
        return 'blob:stub';
      };
      URL.revokeObjectURL = function () {};
    })();`,
  });
  await cdp.evaluate('location.reload(); true');
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 页面就绪（管家页签骨架 + 头部两个常驻控件都在）');

  /* ═════════ ① 打开页签 → 勾开总开关 ═════════ */
  console.log('── ① 总开关 ──');
  ok(Boolean(await waitForEval(cdp, OPEN_TAB)), 'B1 设置弹窗打开并切到「管家」页签');
  const before = await cdp.evaluate(PANEL);
  ok(before.enabled === false, 'B2 页签打开时总开关是关的（跟着 config 回填）');
  ok(before.runState === zh['settings.steward.stateOff'], `B2b 运行态一行如实说「管家没打开」（实测「${before.runState}」）`);
  await cdp.evaluate(`(() => {
    const box = document.getElementById('cfgStewardEnabled');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const running = await waitForHttp(appPort, 'GET', '/api/steward/state',
    result => result.status === 200 && result.json && result.json.ok === true && result.json.running === true, token);
  ok(Boolean(running), 'B3 勾开总开关后 GET /api/steward/state 可用且 running');
  ok((await cfg()).stewardEnabledV1 === true, 'B4 开关落盘（POST /api/config 与 start 是两步，顺序 save→start）');
  const afterEnable = await waitForEval(cdp, `(() => {
    const snapshot = ${PANEL};
    return snapshot.enabled === true && snapshot.runState ? snapshot : null;
  })()`);
  ok(afterEnable && afterEnable.runState === zh['settings.steward.stateRunning'],
    `B5 运行态一行变成「管家在盯着」（实测「${afterEnable && afterEnable.runState}」）`);

  /* ═════════ ② 默认权限 ═════════ */
  console.log('── ② 新线程默认权限 ──');
  ok(afterEnable.permission === 'default', `C0 出发点是「每步都问」（实测 ${afterEnable.permission}）`);
  ok(afterEnable.shieldPermission === 'default' && afterEnable.shield === zh['stewardShell.permission.default.label'],
    `C0b 盾牌显示同一档（实测「${afterEnable.shield}」）`);
  // ── F5a：盾牌是「盾＋档位名＋角标」的胶囊（§11.13.1「F 追加」）──────────────────────────
  const headerDefault = await cdp.evaluate(HEADER);
  ok(headerDefault.shieldLabel === zh['stewardShell.permission.default.label']
    && headerDefault.shieldText === zh['stewardShell.permission.default.label']
    && headerDefault.shieldSvgs === 2 && headerDefault.shieldCarets === 1,
    `C0c F5a：档位名【看得见】地写在盾牌上（盾＋名＋角标 = 2 枚 SVG ＋ 1 段文字），而按钮的 textContent 仍逐字只有那句人话 —— 角标是图标不是字符（实测「${headerDefault.shieldText}」，svg=${headerDefault.shieldSvgs}）`);
  ok(headerDefault.shieldGlyph.includes(SHIELD_OUTLINE) && headerDefault.shieldGlyph.split('|').length >= 2
    && headerDefault.shieldAria === zh['settings.steward.shieldTitle'].replace('{{mode}}', zh['stewardShell.permission.default.label']),
    `C0d F5a：盾内另有一枚只属于这一档的字形（问号），盾牌轮廓这个家族标不变；可及名一个字没动（实测 aria-label「${headerDefault.shieldAria}」）`);
  // 胶囊点开的仍然是【同一个】四档菜单，Esc 仍然收得回来（117j copy-P2-4 那条键盘纪律没被改形状带走）。
  await cdp.evaluate(`(document.getElementById('stewardShieldBtn').click(), true)`);
  const shieldOpen = await waitForEval(cdp, `(() => { const s = ${HEADER}; return s.menuHidden === false ? s : null; })()`);
  ok(shieldOpen && shieldOpen.shieldExpanded === 'true'
    && JSON.stringify(shieldOpen.menuModes) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto'])
    && JSON.stringify(shieldOpen.menuLabels) === JSON.stringify(['default', 'acceptEdits', 'plan', 'auto']
      .map(mode => zh[`stewardShell.permission.${mode}.label`])),
    `C0e F5a：胶囊点开的仍是那【同一个】四档菜单，顺序与人话都来自 chips 那一份表（实测 ${JSON.stringify(shieldOpen && shieldOpen.menuLabels)}）`);
  // 收回菜单走「再点一次」这条与壳模式无关的路：Esc 那一路的唯一监听点在 steward-shell.js
  // （`if (event.key !== 'Escape' || !isStewardMode()) return;`），本组此刻还站在经典壳里，
  // 在这里按 Esc 本来就不该有反应 —— 键盘那一半由 steward-settings.static 的 K8 钉住接线未动。
  await cdp.evaluate(`(document.getElementById('stewardShieldBtn').click(), true)`);
  const shieldClosed = await waitForEval(cdp, `(() => { const s = ${HEADER}; return s.menuHidden === true ? s : null; })()`);
  ok(shieldClosed && shieldClosed.shieldExpanded === 'false' && shieldClosed.shieldSvgs === 2
    && shieldClosed.shieldText === zh['stewardShell.permission.default.label'],
    'C0f F5a：再点一次收回菜单（aria-expanded 回 false），收完盾牌胶囊本身一枚字形都没丢、档位名还在');
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardDefaultPermission');
    select.value = 'acceptEdits';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const acceptEdits = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.permissionMode === 'acceptEdits', token);
  ok(Boolean(acceptEdits), 'C1 改到「改文件不问」后全局 permissionMode 落盘');
  const afterAccept = await waitForEval(cdp, `(() => {
    const snapshot = ${PANEL};
    return snapshot.shieldPermission === 'acceptEdits' ? snapshot : null;
  })()`);
  ok(Boolean(afterAccept), 'C1b 盾牌跟着换色档（data-permission=acceptEdits）');
  ok(afterAccept && afterAccept.permissionHint === zh['stewardShell.permission.acceptEdits.hint'],
    'C1c 档位下面那句人话来自 chips 的同一份表');
  const headerAccept = await cdp.evaluate(HEADER);
  ok(headerAccept.shieldLabel === zh['stewardShell.permission.acceptEdits.label']
    && headerAccept.shieldGlyph !== headerDefault.shieldGlyph
    && headerAccept.shieldGlyph.includes(SHIELD_OUTLINE),
    `C1e F5a：换档之后【字形与文字一起换】——盾里换成铅笔，盾牌轮廓仍是同一条（实测「${headerAccept.shieldLabel}」，字形变了=${headerAccept.shieldGlyph !== headerDefault.shieldGlyph}）`);

  /* ═════════ ③ 全自动二次确认 ═════════ */
  console.log('── ③ 切「全自动」的二次确认 ──');
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardDefaultPermission');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const confirming = await waitForEval(cdp, `(() => {
    const snapshot = ${PANEL};
    return snapshot.confirmHidden === false ? snapshot : null;
  })()`);
  ok(Boolean(confirming), 'D1 切「全自动」先出二次确认，不直接落盘');
  ok(confirming && confirming.confirmLines.length === 5
    && confirming.confirmLines[0] === zh['stewardShell.permission.confirm1']
    && confirming.confirmLines[4] === zh['stewardShell.permission.confirm5'],
    `D2 确认弹窗逐条写明 §8.6 的五件事（与线程 chip 同一份文案；实测 ${confirming && confirming.confirmLines.length} 条）`);
  await cdp.evaluate(`(document.getElementById('cfgStewardPermissionCancel').click(), true)`);
  await sleep(300);
  ok((await cfg()).permissionMode === 'acceptEdits', 'D3 取消：配置不变（仍是「改文件不问」）');
  const cancelled = await cdp.evaluate(PANEL);
  ok(cancelled.confirmHidden === true && cancelled.permission === 'acceptEdits',
    'D3b 取消后确认区收起、选择器回填成落盘值');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardDefaultPermission');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.confirmHidden === false ? 1 : null; })()`);
  await cdp.evaluate(`(document.getElementById('cfgStewardPermissionOk').click(), true)`);
  const autoSaved = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.permissionMode === 'auto', token);
  ok(Boolean(autoSaved), 'D4 确认后落盘 auto');
  const afterAuto = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.shieldPermission === 'auto' ? s : null; })()`);
  ok(Boolean(afterAuto), 'D4b 盾牌切到金底档（data-permission=auto）');
  const headerAuto = await cdp.evaluate(HEADER);
  ok(headerAuto.shieldLabel === zh['stewardShell.permission.auto.label']
    && new Set([headerDefault.shieldGlyph, headerAccept.shieldGlyph, headerAuto.shieldGlyph]).size === 3
    && headerAuto.shieldGlyph.includes(SHIELD_OUTLINE),
    `D4c F5a：走过的三档各是一枚【不同】的盾内字形（问号／铅笔／闪电），共享同一条盾牌轮廓（实测「${headerAuto.shieldLabel}」，三档互不相同=${new Set([headerDefault.shieldGlyph, headerAccept.shieldGlyph, headerAuto.shieldGlyph]).size === 3}）`);

  /* ═════════ ④ 自理清单 ═════════ */
  console.log('── ④ 管家可以自己做的事 ──');
  await cdp.evaluate(`(() => {
    const box = document.getElementById('cfgStewardAutoRelay');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const relayed = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.stewardAutoActions
      && result.json.config.stewardAutoActions.relay === true, token);
  ok(Boolean(relayed), 'E1 勾「事项内自动交接」→ stewardAutoActions.relay === true');
  const autoActions = (await cfg()).stewardAutoActions;
  ok(autoActions.retry === true && autoActions.newThread === true && autoActions.resume === null,
    `E2 其余三项不被顺手改掉（retry/newThread 仍 true、resume 仍三态 null；实测 ${JSON.stringify(autoActions)}）`);

  /* ═════════ ⑤ 并发上限 ═════════ */
  console.log('── ⑤ 并发上限即时生效 ──');
  await cdp.evaluate(`(() => {
    const input = document.getElementById('cfgStewardMaxParallelThreads');
    input.value = '3';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const arbiter = await waitForHttp(appPort, 'GET', '/api/steward/arbiter',
    result => result.json && result.json.ok === true && Number(result.json.maxParallel) === 3, token);
  ok(Boolean(arbiter), `E3 并发上限改 3 后 GET /api/steward/arbiter 立即生效（实测 ${JSON.stringify(arbiter && arbiter.json && arbiter.json.maxParallel)}）`);

  /* ═════════ ⑥ 记忆面板 ═════════ */
  console.log('── ⑥ 管家记得的关于你 ──');
  await cdp.evaluate(`(document.getElementById('cfgStewardMemoryRefreshBtn').click(), true)`);
  const memory = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.memoryTexts.length === 2 ? s : null; })()`);
  ok(Boolean(memory), 'F1 记忆面板加载出两条');
  ok(memory && JSON.stringify(memory.memoryGroups) === JSON.stringify(['preference', 'habit']),
    `F2 按 kind 分组，顺序照 STEWARD_MEMORY_KINDS（实测 ${JSON.stringify(memory && memory.memoryGroups)}）`);
  ok(memory && memory.memoryNew === 2, `F3 24 小时内写入的两条都带「新」标（实测 ${memory && memory.memoryNew}）`);

  await cdp.evaluate(`(() => {
    const item = document.querySelector('#cfgStewardMemoryPanel .steward-memory-item[data-memory-id="mem_pref_1"]');
    const btn = [...item.querySelectorAll('.steward-memory-btn')].find(node => node.textContent.trim() === ${JSON.stringify(zh['settings.steward.memory.veto'])});
    btn.click();
    return true;
  })()`);
  const vetoed = await waitForEval(cdp, `(() => {
    const item = document.querySelector('#cfgStewardMemoryPanel .steward-memory-item[data-memory-id="mem_pref_1"]');
    return item && item.dataset.state === 'vetoed' ? 1 : null;
  })()`);
  ok(Boolean(vetoed), 'F4 否决 → 该条变 vetoed');

  await cdp.evaluate(`(() => {
    const item = document.querySelector('#cfgStewardMemoryPanel .steward-memory-item[data-memory-id="mem_pref_1"]');
    const btn = [...item.querySelectorAll('.steward-memory-btn')].find(node => node.textContent.trim() === ${JSON.stringify(zh['settings.steward.memory.restore'])});
    btn.click();
    return true;
  })()`);
  const restored = await waitForEval(cdp, `(() => {
    const item = document.querySelector('#cfgStewardMemoryPanel .steward-memory-item[data-memory-id="mem_pref_1"]');
    return item && item.dataset.state === 'active' ? 1 : null;
  })()`);
  ok(Boolean(restored), 'F5 恢复 → 该条回到 active');

  const EDITED = '报告都写成中文，图表也要';
  await cdp.evaluate(`(() => {
    const text = document.querySelector('#cfgStewardMemoryPanel .steward-memory-item[data-memory-id="mem_pref_1"] .steward-memory-text');
    text.value = ${JSON.stringify(EDITED)};
    text.dispatchEvent(new Event('blur', { bubbles: false }));
    return true;
  })()`);
  const edited = await waitForHttp(appPort, 'GET', '/api/steward/memory',
    result => result.json && result.json.groups && (result.json.groups.preference || [])
      .some(entry => entry.id === 'mem_pref_1' && entry.text === EDITED), token);
  ok(Boolean(edited), 'F6 就地编辑 → blur 保存（带 version 乐观锁）');
  const editedRow = (edited.json.groups.preference || []).find(entry => entry.id === 'mem_pref_1');
  ok(editedRow && editedRow.confidence === 1 && editedRow.sourceSessionId === 'user_panel',
    'F6b 面板改过的条目置信度拉满、来源标 user_panel（116-2e 既有语义）');

  await cdp.evaluate(`(document.getElementById('cfgStewardMemoryExportBtn').click(), true)`);
  const exported = await waitForEval(cdp, `(() => {
    const blobs = window.__ruyiBlobs || [];
    return blobs.length ? blobs[blobs.length - 1] : null;
  })()`);
  ok(typeof exported === 'string' && exported.includes(EDITED),
    'F7 导出的 JSON 里含刚改过的那条（`<a download>` 只此一处）');

  await cdp.evaluate(`(document.getElementById('cfgStewardMemoryClearBtn').click(), true)`);
  await cdp.evaluate(`(() => {
    document.getElementById('cfgStewardMemoryClearInput').value = 'nope';
    document.getElementById('cfgStewardMemoryClearOk').click();
    return true;
  })()`);
  await sleep(400);
  const stillThere = await request(appPort, 'GET', '/api/steward/memory', null, token);
  ok(stillThere.json && (stillThere.json.groups.preference || []).length === 1,
    'F8 清空必须逐字输入 clear：输错了什么也不会发生');
  await cdp.evaluate(`(() => {
    document.getElementById('cfgStewardMemoryClearInput').value = 'clear';
    document.getElementById('cfgStewardMemoryClearOk').click();
    return true;
  })()`);
  const cleared = await waitForHttp(appPort, 'GET', '/api/steward/memory',
    result => result.json && result.json.counts && result.json.counts.total === 0, token);
  ok(Boolean(cleared), 'F9 逐字输入 clear 后清空');

  /* ═════════ ⑦ 行动流水 ═════════ */
  console.log('── ⑦ 行动流水 ──');
  await cdp.evaluate(`(document.getElementById('cfgStewardDecisionsRefreshBtn').click(), true)`);
  const log = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.decisionRows.length >= 2 ? s : null; })()`);
  ok(Boolean(log), 'G1 行动流水表格出现（夹具两条）');
  ok(log && log.decisionHead.length === 7 && log.decisionHead[0] === zh['settings.steward.decisions.col.at'],
    `G2 表头七列（时间／做了什么／目标线程／线程权限／依据／费用／撤销；实测 ${log && log.decisionHead.length}）`);
  ok(log && log.decisionCells.includes(zh['settings.steward.tool.threadContinue']),
    'G3 「做了什么」列是人话（前端自己的 i18n 映射）');
  ok(log && log.decisionCells.includes(zh['stewardShell.permission.acceptEdits.label']),
    'G4 「线程权限」列复用四档人话');
  ok(log && log.decisionCells.includes(zh['settings.steward.decisions.undo'])
    && log.decisionCells.includes(zh['settings.steward.decisions.details']),
    'G5 有撤回锚点的给「撤销」，没有的给「详情」');
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardDecisionsThread');
    select.value = ${JSON.stringify(SID_B)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const filtered = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.decisionRows.length === 1 ? s : null; })()`);
  ok(filtered && filtered.decisionRows[0] === SID_B,
    `G6 按线程过滤只剩那一条（客户端过滤；实测 ${JSON.stringify(filtered && filtered.decisionRows)}）`);

  /* ═════════ ⑧ 停机与唤醒 ═════════ */
  console.log('── ⑧ 一键停机／唤醒 ──');
  // 头部的两个常驻控件在管家壳里：先切过去（走既有的壳模式选择器，不自己写 data-shell-mode）。
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    select.value = 'steward';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 1 : null`);
  // 停机之前头像【不该】是 sleeping —— 否则下面那条 H2 会「本来就 sleeping」而假过。
  const awakeBefore = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.avatarState && s.avatarState !== 'sleeping' ? s : null; })()`);
  ok(Boolean(awakeBefore), `H0 停机之前头像不是 sleeping（实测 ${awakeBefore && awakeBefore.avatarState}）`);
  // ── F5a：停机 ≠ 停止（§11.13.1「F 追加」）。管家的停机键是电源符，线程的「停止」是实心方块；
  //    修前两处都是「圆里一个方块」，用户看不出停的是谁。 ────────────────────────────────
  const headerAwake = await cdp.evaluate(HEADER);
  ok(headerAwake.stopGlyph.includes(POWER_ARC) && !headerAwake.stopGlyph.includes(POWER_SLASH)
    && headerAwake.stopRects === 0 && headerAwake.stopText === zh['settings.steward.stop'],
    `H0b F5a：没停机时停机键画的是【电源符】（一段开口圆弧＋一竖，零 <rect> —— 线程「停止」那枚实心方块不在这里），可及名仍是「${headerAwake.stopText}」`);
  await cdp.evaluate(`(document.getElementById('stewardStopBtn').click(), true)`);
  const stoppedState = await waitForHttp(appPort, 'GET', '/api/steward/state',
    result => result.json && result.json.stopped === true, token);
  ok(Boolean(stoppedState), 'H1 按下停机键 → GET /api/steward/state 的 stopped === true');
  const sleeping = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.avatarState === 'sleeping' ? s : null; })()`);
  ok(Boolean(sleeping), 'H2 头像立刻切到 sleeping（§8.3 停机覆盖一切，不用等下一次轮询）');
  ok(sleeping && sleeping.stopLabel === zh['settings.steward.wake'] && sleeping.stopFlag === 'true',
    `H3 同一个按钮变成「唤醒管家」（实测「${sleeping && sleeping.stopLabel}」）`);
  const headerStopped = await cdp.evaluate(HEADER);
  ok(headerStopped.stopGlyph.includes(POWER_ARC) && headerStopped.stopGlyph.includes(POWER_SLASH)
    && headerStopped.stopPaths === headerAwake.stopPaths + 1 && headerStopped.stopRects === 0
    && headerStopped.stopText === zh['settings.steward.wake'],
    `H3b F5a：已停机 = 同一枚电源符【多一道斜杠】（路径数 ${headerAwake.stopPaths} → ${headerStopped.stopPaths}），仍然不是那枚实心方块；可及名跟着变成「${headerStopped.stopText}」`);
  ok((await cfg()).stewardEnabledV1 === true, 'H4 停机不改配置（总开关仍是开的）');

  await cdp.evaluate(`(document.getElementById('stewardStopBtn').click(), true)`);
  const woke = await waitForHttp(appPort, 'GET', '/api/steward/state',
    result => result.json && result.json.stopped === false, token);
  ok(Boolean(woke), 'H5 再按一次唤醒 → stopped === false');
  const awake = await waitForEval(cdp, `(() => { const s = ${PANEL}; return s.avatarState && s.avatarState !== 'sleeping' ? s : null; })()`);
  ok(Boolean(awake), `H6 头像离开 sleeping（实测 ${awake && awake.avatarState}）`);
  ok(awake && awake.stopLabel === zh['settings.steward.stop'], 'H7 按钮回到「一键停机」');
  const headerWoke = await cdp.evaluate(HEADER);
  ok(headerWoke.stopGlyph === headerAwake.stopGlyph && !headerWoke.stopGlyph.includes(POWER_SLASH),
    `H7b F5a：唤醒之后那道斜杠也跟着走（字形逐字回到停机之前的那一份；实测 ${headerWoke.stopPaths} 条路径）`);

  /* ═════════ ⑨ 新开线程用什么模型（117l-A3：强/快两档；依赖 A1 的 stewardThreadModels 键） ═════════ */
  console.log('── ⑨ 新开线程用什么模型（强/快两档） ──');
  ok(Boolean(await waitForEval(cdp, OPEN_TAB)), 'I1 重新打开设置弹窗并回到「管家」页签（⑧切去了管家壳）');
  const beforeThreadModels = await cdp.evaluate(PANEL);
  ok(JSON.stringify(beforeThreadModels.strongProviderOptions) === JSON.stringify(['', 'fake', 'fake2'])
    && JSON.stringify(beforeThreadModels.fastProviderOptions) === JSON.stringify(['', 'fake', 'fake2']),
    `I2 强/快两个服务商 select 都是「跟随 + 两个夹具 provider」（实测 强=${JSON.stringify(beforeThreadModels.strongProviderOptions)} 快=${JSON.stringify(beforeThreadModels.fastProviderOptions)}）`);
  ok(beforeThreadModels.strongProviderId === '' && beforeThreadModels.strongModel === ''
    && beforeThreadModels.fastProviderId === '' && beforeThreadModels.fastModel === '',
    'I3 出发点：夹具没设 stewardThreadModels，四格都回填成空（跟随主端点）');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardStrongProviderId');
    select.value = 'fake2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const strongProviderSaved = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.stewardThreadModels
      && result.json.config.stewardThreadModels.strong && result.json.config.stewardThreadModels.strong.providerId === 'fake2', token);
  ok(Boolean(strongProviderSaved), 'I4 强模型服务商改 fake2 → config.stewardThreadModels.strong.providerId 落盘为 fake2');

  await cdp.evaluate(`(() => {
    const input = document.getElementById('cfgStewardStrongModel');
    input.value = 'strong-test-model';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const strongModelSaved = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.stewardThreadModels
      && result.json.config.stewardThreadModels.strong && result.json.config.stewardThreadModels.strong.model === 'strong-test-model', token);
  ok(Boolean(strongModelSaved), 'I5 强模型名改 strong-test-model → config.stewardThreadModels.strong.model 落盘同值');
  ok((await cfg()).stewardThreadModels.strong.providerId === 'fake2',
    'I5b 改模型名没有把上一步刚存的 providerId 顺手冲掉（同一档内两次写口各自合并，不是互相覆盖）');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgStewardFastProviderId');
    select.value = 'fake';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const fastProviderSaved = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.stewardThreadModels
      && result.json.config.stewardThreadModels.fast && result.json.config.stewardThreadModels.fast.providerId === 'fake', token);
  ok(Boolean(fastProviderSaved), 'I6 快速模型服务商改 fake → config.stewardThreadModels.fast.providerId 落盘为 fake');

  await cdp.evaluate(`(() => {
    const input = document.getElementById('cfgStewardFastModel');
    input.value = 'fast-test-model';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  const fastModelSaved = await waitForHttp(appPort, 'GET', '/api/status',
    result => result.json && result.json.config && result.json.config.stewardThreadModels
      && result.json.config.stewardThreadModels.fast && result.json.config.stewardThreadModels.fast.model === 'fast-test-model', token);
  ok(Boolean(fastModelSaved), 'I7 快速模型名改 fast-test-model → config.stewardThreadModels.fast.model 落盘同值');

  // 关键的「整对象上传、不是只传半个」契约：改快档的两步走完之后，强档（上面①②两步存的）必须
  // 原封不动——如果写口只传半个 stewardThreadModels，POST /api/config 的顶层 {...current, ...body}
  // 会把整个 stewardThreadModels 键换成只剩 fast 的那一半，strong 就会静默消失。
  const finalConfig = await cfg();
  ok(finalConfig.stewardThreadModels
    && finalConfig.stewardThreadModels.strong && finalConfig.stewardThreadModels.strong.providerId === 'fake2'
    && finalConfig.stewardThreadModels.strong.model === 'strong-test-model',
    `I8 改完快档之后，强档（provider=fake2/model=strong-test-model）没被冲掉（实测 ${JSON.stringify(finalConfig.stewardThreadModels && finalConfig.stewardThreadModels.strong)}）`);

  const afterThreadModels = await cdp.evaluate(PANEL);
  ok(afterThreadModels.strongProviderId === 'fake2' && afterThreadModels.strongModel === 'strong-test-model'
    && afterThreadModels.fastProviderId === 'fake' && afterThreadModels.fastModel === 'fast-test-model',
    `I9 四格界面回显与落盘一致（实测 强=${afterThreadModels.strongProviderId}/${afterThreadModels.strongModel} 快=${afterThreadModels.fastProviderId}/${afterThreadModels.fastModel}）`);
} catch (error) {
  console.log('ERROR ' + ((error && error.stack) || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  await sleep(400);
  stopRuyiTestBrowsers(profile);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (fail) { console.log(`STEWARD SETTINGS E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD SETTINGS E2E: ALL PASS');
process.exit(0);
})();

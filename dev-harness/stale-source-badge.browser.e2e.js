#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 换机器：直跑时家目录自隔离（服务启动会从真机 ~/.claude.json 导入 MCP 并同步回真机 CLI 配置，两个方向都要断）

// 第 125 波 P2 真浏览器 E2E：**拿旧的当新的**（42 号文 §1 ③ / §2 ③，A02／J02）。
//
// 用户的处境：断网（或站点反爬）时问「最新进展」。`web_fetch` 抓不到会回落磁盘缓存，
// **并且仍然回 `ok: true`** —— 一份三个月前的正文就这么进了模型与用户眼里。
// `fromCache` / `ts` 两个字段一直摆在返回值里，可**没有任何一处可见层读它们**；
// 11-native-tools 那段头注自己写着「stored ts is returned so the model can judge freshness」——
// 把「这是不是旧的」交给模型自己判断，正是这一刀要收回来的那半句。
//
// 本件按四组事实钉这枚徽标（全程不碰网：目标域名是 .invalid，DNS 必然解析失败）：
//   B1 后端那一格真的发生了：预置一条 30 天前的缓存 → web_fetch 回 ok:true 且 fromCache:true；
//   B2 **可见层**：那张工具卡的摘要行上出现徽标，逐字含「30 天」——不展开详情就看得见；
//   B3 **回放路径**：刷新页面重进这条线程，徽标还在（回放读的是落盘的 result，与 live 同一个判据）；
//   B4 **不误伤**：同一回合里那张 file_read 卡零徽标，整页带 data-stale 的元素恰一枚。
//
// 反向（交付记录里逐条记实得）：
//   · 把 staleCacheDays 的 `r.fromCache !== true` 那道门去掉 → B4b／B5 红（那张连缓存都没回落的
//     web_fetch 卡也被印上「抓取时间未知」）。**第一版没有第三张卡，这个反向照样全绿** —— 对照组
//     不在屏上时，「只有真回落缓存的才印」根本没被证过；
//   · 把判据改成读正文关键词 → live-full-text.static 的 J2 当场红（那一组不许判据里出现 .text／
//     includes(／match(）；
//   · 把 chat-stream-runtime 里那一行 renderStaleBadgeInto 拔掉 → B2a/b/c 与 B4b 红、C1 仍绿
//     （live 与回放两条路各证各的，实得如此）。
//
// 判定行：`STALE SOURCE BADGE BROWSER E2E: ALL PASS`。
const cp = require('child_process');
const crypto = require('crypto');
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

// .invalid 是 RFC 2606 保留的永不存在的顶级域：DNS 必然失败，夹具因此不碰真网，也不依赖「当前离线」。
const DEAD_URL = 'https://ruyi-stale-badge.invalid/quarterly';
const CACHE_AGE_DAYS = 30;

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
// 预算 800 × 40 ms = 32 s（与同族浏览器件同一个数：并行全量下几个无头浏览器抢 CPU）。
async function waitForEval(cdp, expression, attempts = 800) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; }
    catch { /* reload 会换执行上下文 */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('promptInput') || !document.getElementById('sendBtn')) return null;
  return { ready: true };
})()`;

// 工具卡快照：只读 DOM 与公开 dataset，一个模块私有状态都不碰。
const CARDS = `(() => {
  const cards = [...document.querySelectorAll('.tool-card')].map(card => {
    const badge = card.querySelector('.tc-stale');
    return {
      name: (card.querySelector('.tc-name') || {}).textContent || '',
      badgeText: badge ? (badge.textContent || '') : '',
      badgeOn: badge ? (badge.dataset.stale || '') : '',
      badgeTitle: badge ? (badge.title || '') : '',
      // 结果 <pre> 被 wrapPreWithCopy 包过一层,选择器容易选错那一个(输入那份 JSON 里没有
      // fromCache,选错就永远等不到)。整张卡的文本里找 —— 这一格只用来「等结果真的落定」。
      resultHasFromCache: /"fromCache":\\s*true/.test(card.textContent || ''),
    };
  });
  return { cards, stamped: document.querySelectorAll('[data-stale]').length };
})()`;

(async () => {
const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-stale-badge-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(root, 'profile');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
// file_read 的对照目标：同一回合里的第二个工具,它必须零徽标。
const readTarget = path.join(work, 'note.txt');
fs.writeFileSync(readTarget, '这是一份本地文件,它跟缓存没有关系。', 'utf8');

// 预置缓存:形状与 11-native-tools 的 writeWebCache 逐字一致({url,title,text,ts}),
// 路径是 <data>/webcache/<sha256(url)>.json —— 夹具自己算这个哈希,不去 require 生产代码。
const cacheDir = path.join(home, 'webcache');
fs.mkdirSync(cacheDir, { recursive: true });
const cachedAt = new Date(Date.now() - CACHE_AGE_DAYS * 86400000).toISOString();
fs.writeFileSync(
  path.join(cacheDir, crypto.createHash('sha256').update(DEAD_URL).digest('hex') + '.json'),
  JSON.stringify({ url: DEAD_URL, title: '季度进展(存档)', text: '这是三十天前抓下来的那一份正文。', ts: cachedAt }),
  'utf8',
);

fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.7.0',
  activeProvider: 'fake',
  engineMode: 'interactive',
  // bypass:工具直接跑,不弹待决 —— 本件测的是「结果回来之后画什么」,不是权限。
  permissionMode: 'bypass',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: work,
  includeWorkbenchMcp: false,
  stewardEnabledV1: false,
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
  // fake-openai 的 FAKE_TOOL_SEQUENCE:同一回合里先 web_fetch 后 file_read,于是一屏上同时有
  // 「该印徽标的」与「不该印的」两张卡,B4 的不误伤是对照出来的,不是空口断言。
  provider = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(providerPort)], {
    env: {
      ...process.env,
      FAKE_TOOL_SEQUENCE: JSON.stringify([
        { name: 'web_fetch', args: { url: DEAD_URL } },
        { name: 'file_read', args: { path: readTarget } },
        // 第三张卡:同样是 web_fetch,但它【连缓存都没有】(loopback 直接被 SSRF 前置拒掉,
        // 那条路刻意不回落缓存)。有了它,「只有真回落了缓存的那张才印」才是对照出来的 ——
        // 少了它,把 fromCache 那道门整个拿掉,这一屏的断言竟然照样全绿(第一版就是这样)。
        { name: 'web_fetch', args: { url: 'http://127.0.0.1:1/blocked' } },
      ]),
    },
    windowsHide: true, stdio: 'ignore',
  });
  await sleep(600);

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

  const appUrl = `http://127.0.0.1:${appPort}/`;
  const browserPath = findBrowserExecutable();
  ok(Boolean(browserPath), 'A3 找得到 Edge/Chrome');
  if (!browserPath) throw new Error('browser unavailable');
  browser = cp.spawn(browserPath, [
    ...(/msedge\.exe$/i.test(browserPath) ? ['--edge-skip-compat-layer-relaunch'] : []),
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--window-size=1440,1000', appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A4 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY)), 'A5 应用就绪');

  // 经典窗口(工具卡长在这里)。
  await cdp.evaluate(`(() => {
    const select = document.getElementById('cfgShellMode');
    if (select) { select.value = 'classic'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  })()`);
  await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') !== 'steward' ? true : null`);

  /* ═════════ B 组:live 路径 ═════════ */
  await cdp.evaluate(`(() => { const b = document.getElementById('newSessionBtn'); if (b) b.click(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `window.state && window.state.currentSession && window.state.currentSession.id ? true : null`)),
    'B0 新线程已建(经典窗口)');
  await cdp.evaluate(`(() => {
    const input = document.getElementById('promptInput');
    input.value = '去看看那一页的季度进展';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('sendBtn').click();
    return true;
  })()`);

  // 两张工具卡都落定(结果 pre 里已经有 fromCache 字样或 file_read 的正文)才开始判。
  const live = await waitForEval(cdp, `(() => {
    const snap = ${CARDS};
    if (snap.cards.length < 3) return null;
    if (!snap.cards.some(c => c.name === 'web_fetch' && c.resultHasFromCache)) return null;
    return snap;
  })()`);
  ok(Boolean(live), `B1 web_fetch 真的回落了缓存(结果里 fromCache:true;实得 ${JSON.stringify(live && live.cards.map(c => c.name))})`);

  const fetchCard = live ? live.cards.find(c => c.name === 'web_fetch') : null;
  ok(Boolean(fetchCard && fetchCard.badgeOn === 'cache'),
    `B2a 那张卡的摘要行上出现缓存徽标(实得 ${JSON.stringify(fetchCard && fetchCard.badgeOn)})`);
  ok(Boolean(fetchCard && /30/.test(fetchCard.badgeText) && /天/.test(fetchCard.badgeText)),
    `B2b 徽标逐字说得出「多久以前」(实得 ${JSON.stringify(fetchCard && fetchCard.badgeText)})`);
  ok(Boolean(fetchCard && fetchCard.badgeTitle && /缓存/.test(fetchCard.badgeTitle)),
    `B2c 鼠标停上去说清为什么(实得 ${JSON.stringify(fetchCard && fetchCard.badgeTitle)})`);

  const readCard = live ? live.cards.find(c => c.name === 'file_read') : null;
  ok(Boolean(readCard) && !(readCard && readCard.badgeOn),
    `B4a 同一回合里的 file_read 卡零徽标(实得 ${JSON.stringify(readCard && readCard.badgeOn)})`);
  ok(live && live.stamped === 1, `B4b 整页带 data-stale 的元素恰一枚(实得 ${live && live.stamped})`);
  const blockedCard = live ? live.cards.filter(c => c.name === 'web_fetch')[1] : null;
  ok(Boolean(blockedCard) && !(blockedCard && blockedCard.badgeOn),
    `B5 同样是 web_fetch,但这一发连缓存都没回落(被 SSRF 拒掉)-> 零徽标(实得 ${JSON.stringify(blockedCard && blockedCard.badgeOn)})`);

  /* ═════════ C 组:回放路径 ═════════ */
  // 刷新 = 整份重画,走的是 toolCard() 里那一支(落盘的 result),与 live 那条流式补渲染不是同一行代码。
  await cdp.send('Page.reload', { ignoreCache: true });
  ok(Boolean(await waitForEval(cdp, READY)), 'C0 刷新后应用再次就绪');
  const replay = await waitForEval(cdp, `(() => {
    const snap = ${CARDS};
    return snap.cards.some(c => c.name === 'web_fetch') ? snap : null;
  })()`);
  const replayFetch = replay ? replay.cards.find(c => c.name === 'web_fetch') : null;
  ok(Boolean(replayFetch && replayFetch.badgeOn === 'cache' && /30/.test(replayFetch.badgeText)),
    `C1 回放路径同样印出徽标(实得 ${JSON.stringify(replayFetch && replayFetch.badgeText)})`);
  const replayRead = replay ? replay.cards.find(c => c.name === 'file_read') : null;
  ok(Boolean(replayRead) && !(replayRead && replayRead.badgeOn),
    `C2 回放路径也不误伤 file_read(实得 ${JSON.stringify(replayRead && replayRead.badgeOn)})`);
} catch (error) {
  fail += 1;
  console.log('FAIL 夹具自身抛了:' + String((error && error.stack) || error));
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  killTree(provider);
  try { await stopRuyiTestBrowsers(profile); } catch { /* best effort */ }
  await sleep(200);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ }
}

console.log(`\nSTALE SOURCE BADGE BROWSER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();

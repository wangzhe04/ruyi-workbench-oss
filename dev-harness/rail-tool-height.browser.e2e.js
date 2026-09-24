#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）

// 真实浏览器 E2E（137x · 用户 2026-09-24「工具显示会让线程变大变小」）：左栏（#railList，经典/管家
// 两视角共用同一份 DOM）里一条正在跑的线程行，在【一次运行期间】反复 tool_use/tool_result 时，
// 行高不许跟着抖 —— 只在「开始跑／跑完」各变一次。
//
// 病灶：服务端在 tool_use 时把 tail.tool 设成工具名、tool_result 时清成 ''（src/04-permission-runtime.js，
// 本件不改也不读那份实现细节，只驱动一个真的多轮工具回合，观察结果）。前端 railSubLine() 修前对
// 「清成 ''」的处理是回落成空串，paintRailLive() 见到空串就把 <p class="steward-board-sub"> 整个摘掉，
// 下一次工具开始时再插回来 —— 插/删各一次 reflow，行高跟着一起变。
//
// 覆盖：
//   A 起一个【浏览器从没挂过流】的多轮工具回合（同 live-full-text.browser 的手法：POST /api/chat/stream
//     不经浏览器，管家派活就是这个形状），左栏靠 EVENT_STREAM_LIVE_EVENT 推送独立更新这一行；
//   B 行一旦进入「在跑」，第二行（.steward-board-sub）必须【全程非空】—— 工具之间的空档不许把它
//     清成空串影响到这一行的存在性；
//   C 同一段时间窗口里连续采样该行 offsetHeight，全程恒定（这是用户原话「变大变小」的直接量化）；
//   D 回合真结束后，这一行的第二行自己收掉（唯一允许的「跑完」那一次变化）。
//
// 反向验证记在头注末尾（改动小节）：把 railSubLine 的空档回落改回 `return ''`，C 组当场红
// （行在两次工具之间塌缩一次又长回来），B 组同时红（该采到的样本里出现空字符串）；改回本刀的
// 实现，两组转绿。
// 判定行：`RAIL TOOL HEIGHT BROWSER E2E: ALL PASS`。
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD = '左栏行高线程';
const GAP_MS = 900; // 每轮工具之间的「空档」——服务端把 tail.tool 清成 '' 到下一次 tool_use 之间的可观察窗口
const SAMPLE_MS = 100;

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
    if (process.platform === 'win32') killOwnTree(child);
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// 确定性 provider：三轮 file_read，轮与轮之间在【发出下一次 tool_use 之前】睡 GAP_MS —— 这段睡眠期间
// 服务端手上的 tail.tool 是上一轮 tool_result 清成的 ''，正是本件要盯的窗口。
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
    const rounds = messages.filter(m => m && m.role === 'tool').length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => { try { res.write('data: ' + JSON.stringify(value) + '\n\n'); } catch { /* client gone */ } };
    const delta = text => sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    if (rounds < 3) {
      delta(`第 ${rounds + 1} 步：我先看一眼现场。`);
      if (rounds > 0) await sleep(GAP_MS); // 首轮不用等——一开场就该立刻进「在跑」，不留一段假的启动态
      const args = JSON.stringify({ path: probeFile });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call_${rounds}`, type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      delta('看完了，三步都过了一遍，结论在这儿。');
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
async function waitForEval(cdp, expression, attempts = 500) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; }
    catch { /* reload swaps execution context */ }
    await sleep(40);
  }
  return null;
}

const READY = `(() => {
  if (!document.getElementById('railList') || !window.state || !window.state.status || !window.state.config) return null;
  if (!document.querySelectorAll('#railList .steward-board-thread').length) return null;
  return { ready: true };
})()`;

const ROW_SEL = sid => `document.querySelector('#railList .steward-board-thread[data-session-id="${sid}"]')`;
// 一次采样：行还在不在、第二行的文本是什么（空串＝这一拍没有第二行）、行的 offsetHeight。
const SAMPLE = sid => `(() => {
  const row = ${ROW_SEL(sid)};
  if (!row) return { present: false, sub: '', height: -1 };
  const sub = row.querySelector('.steward-board-sub');
  return { present: true, sub: sub ? sub.textContent : '', height: row.offsetHeight, state: row.dataset.state || '' };
})()`;

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rail-height-'));
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
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started');
  let token = '';
  for (let i = 0; i < 300 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  const created = await request(appPort, 'POST', '/api/sessions', { title: THREAD, cwd: home }, token);
  const sid = created && created.json && created.json.session && created.json.session.id;
  ok(Boolean(sid), `A3 线程已建(${sid || '失败'})`);
  if (!sid) throw new Error('session fixture unavailable');

  const executable = findBrowserExecutable();
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
  // 本件要的正是事件流推送（thread.live → paintRailLive）——与 live-full-text 相反，这里【不】挡
  // /api/events/stream，否则左栏那一路每次工具调用的插删永远等不到，C 组会变成空断言。
  ok(Boolean(await waitForEval(cdp, READY)), 'A6 页面载入,侧栏里有这条线程');

  /* ═════════ 起一个【浏览器从没挂过流】的多轮工具回合 ═════════ */
  {
    const raw = JSON.stringify({ sessionId: sid, message: '看一遍这三步', cwd: home });
    const req = http.request({
      host: '127.0.0.1', port: appPort, path: '/api/chat/stream', method: 'POST', timeout: 60000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token },
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.write(raw); req.end();
  }

  /* ═════════ B/C 在跑期间：第二行全程非空 + 行高全程恒定 ═════════ */
  console.log('── B/C 在跑期间连续采样左栏这一行 ──');
  // 先等到它真的进了「在跑」——第二行第一次出现（本刀之后：一进「在跑」就有，不必等第一次工具落地）。
  const firstRunning = await waitForEval(cdp, `(() => {
    const s = ${SAMPLE(sid)};
    return (s.present && s.sub) ? s : null;
  })()`, 500);
  ok(Boolean(firstRunning), `B1 线程一进「在跑」，左栏这一行第二行就出现（实测「${firstRunning && firstRunning.sub}」）`);
  // 137x：刚建的会话第一次进投影索引有一拍延迟(13d buildMissionAggregateRows 的「有卡片才走五态」
  // 分支)，与本刀要钉的「工具之间不许清空」是两件事——稳态判据是【连续 3 次非空】，不是【出现过一次】，
  // 避免把索引刚追上那一拍的瞬时空样本记成本刀要抓的那种抖动。有上限兜底：稳不下来就照旧进入采样,
  // 下面 B4/C1 该红照样红。
  for (let stable = 0, attempts = 0; stable < 3 && attempts < 40; attempts++) {
    const s = await cdp.evaluate(SAMPLE(sid));
    stable = (s && s.present && s.sub) ? stable + 1 : 0;
    await sleep(150);
  }

  // 采样窗口覆盖三轮 file_read + 两段 GAP_MS 空档（tail.tool 被清成 '' 的那两段）。窗口比三轮
  // 实测耗时留了余量，回合可能在窗口结束前就真的跑完——那一刻线程离开「在跑」是唯一允许的一次
  // 高度变化（D 组的地盘），不该被本节误判成本刀要抓的那种抖动，所以 B4/B5/C1 只认「在跑」那些帧
  // （state 由 railThreadRow 落的 [data-state] 读出，见 steward-board.js:869）；B3 仍然管全程
  // （不管在跑还是收工，行本身都不许从左栏消失）。
  const WINDOW_MS = GAP_MS * 2 + 2500;
  const samples = [];
  const deadline = Date.now() + WINDOW_MS;
  while (Date.now() < deadline) {
    let s = null;
    try { s = await cdp.evaluate(SAMPLE(sid)); } catch { /* 页面正忙这一拍，跳过 */ }
    if (s) samples.push(s);
    await sleep(SAMPLE_MS);
  }
  ok(samples.length >= 10, `B2 采到了足够多的样本(${samples.length} 帧)，窗口没有落空`);
  ok(samples.every(s => s.present), `B3 这一行全程没有从左栏消失(实测 ${samples.filter(s => !s.present).length} 帧缺席)`);
  const runningSamples = samples.filter(s => s.present && s.state === 'running');
  ok(runningSamples.length >= 10,
    `B3b 「在跑」那段窗口本身够长，够采到有意义的样本(实测 ${runningSamples.length}/${samples.length} 帧；否则下面 B4/B5/C1 是空断言)`);
  const emptySub = runningSamples.filter(s => !s.sub);
  ok(emptySub.length === 0,
    `B4 在跑期间第二行全程非空——工具之间的空档不会把它清空(实测 ${emptySub.length}/${runningSamples.length} 帧是空串)`);
  const distinctSub = new Set(runningSamples.filter(s => s.sub).map(s => s.sub));
  ok(distinctSub.size >= 2,
    `B5 采样窗口里真的经历过内容变化(不是从头到尾一句话没变的空窗口；实测 ${distinctSub.size} 种取值：${[...distinctSub].join(' | ')})`);
  const heights = runningSamples.map(s => s.height);
  const minH = Math.min(...heights), maxH = Math.max(...heights);
  ok(minH > 0 && minH === maxH,
    `C1 行高全程恒定，不随每次工具调用增删(实测 min=${minH}px max=${maxH}px)`);

  /* ═════════ D 回合结束：第二行自己收掉（唯一允许的一次变化） ═════════ */
  console.log('── D 回合结束后 ──');
  const settled = await waitForEval(cdp, `(() => {
    const s = ${SAMPLE(sid)};
    return (s.present && !s.sub) ? s : null;
  })()`, 500);
  ok(Boolean(settled), 'D1 回合结束后第二行自己收掉(唯一允许的一次高度变化)');
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
  console.log(`\nRAIL TOOL HEIGHT BROWSER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });

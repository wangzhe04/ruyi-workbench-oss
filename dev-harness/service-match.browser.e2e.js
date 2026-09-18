'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
// E2E (127 波 ⑥ A-S02 · 45 号文 §4⑥): 服务入口条【真浏览器件】—— 技能库搜索框键入自然语言,
// 列表顶部出现服务条;无匹配/清空即消失(零静态标记,节点不存在而不是藏起来)。
//
// 判据形状(45 号文 §4⑥ 的前端半):服务条文案 = 可用数 / 一次配置引导 / 暂无模板;
// 键入无关词 → 服务条不存在(零行为)。后端计数与承诺词判据在 playbooks.e2e.js ⑦(本件不重复)。
//
// 路线照 scheduler-ui.browser 模具:spawn workbench + 系统 Edge headless(--remote-debugging-port),
// 零依赖 CDP(WebSocket 直连)驱动页面;READY 后走真实入口(#skillBtn 点击开技能库)。
//
// 127-⑧ A-F01(45 号文 §4⑧)追加 C 段:服务状态「未知」的前端半。夹具无 provider、无探测地址、
// WCW_TEST_NO_NET_ANCHORS=1 → network.online === null;HOME 里预置两条要联网的用户模板(coding 一条独占该类、
// research 一条与两条可用内置同类)＋一条要视觉的(无 provider → 需配置)。判据:未知模板在服务条与技能库行上说「未知」、绝不说「可用」;
// 混合类的「可直接用」只数 status===available;首页任务卡状态行只出现在非可用模板上;需配置卡「需要配置」+原因。
// D 段:同一 HOME 改死探测地址重启 → 离线;离线卡/行只一句降级文案(要联网、现在离线、下一步),服务条仍引导查网络。
// 反向:① 后端把未知并进可用 → C1/C2/C4 红;② 服务条可用数改回按 p.available 数 → C3 红(实得 3)。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const { findBrowserExecutable } = require('./lib/browser-path');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const appPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-service-match-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 8000,
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
  try { if (process.platform === 'win32') killOwnTree(child); else child.kill('SIGKILL'); }
  catch { /* already exited */ }
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
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
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
async function waitForTarget(port, appUrl) {
  for (let i = 0; i < 200; i++) {
    const result = await request(port, 'GET', '/json/list');
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

fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', activeProvider: '', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: work, includeWorkbenchMcp: false,
}), 'utf8');
// 127-⑧:两条要联网的用户模板 + 一条要视觉的(数据根 = RUYI_HOME,用户模板目录是 <数据根>/playbooks)。
fs.mkdirSync(path.join(home, 'playbooks'), { recursive: true });
const F01_PLAYBOOKS = [
  { id: 'f01-unknown-coding', title: '代码体检联网版', icon: '🧪', desc: '夹具:要联网的代码任务', inputs: [], promptTemplate: '检查 {q}', requires: ['network'], uiMode: 'both', service: 'coding' },
  { id: 'f01-unknown-research', title: '对比联网资料', icon: '🧪', desc: '夹具:要联网的研究比较', inputs: [], promptTemplate: '对比 {q}', requires: ['network'], uiMode: 'both', service: 'research' },
  // 无 provider(CLI 引擎)→ vision 是配置层已知缺失 → needs_config;不归类,免得影响 B/C 段的服务条。
  { id: 'f01-needs-vision', title: '看图夹具', icon: '🧪', desc: '夹具:要视觉模型', inputs: [], promptTemplate: '看 {q}', requires: ['vision'], uiMode: 'both' },
];
for (const pb of F01_PLAYBOOKS) fs.writeFileSync(path.join(home, 'playbooks', pb.id + '.json'), JSON.stringify(pb), 'utf8');

const spawnWb = () => cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
  cwd: WB,
  // 127-⑧:WCW_TEST_NO_NET_ANCHORS=1 + 无 provider + 无探测地址 → online:null(真未知);B 段只用无 requires 的内置模板,不受影响。
  env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home, WCW_TEST_NO_NET_ANCHORS: '1' },
  windowsHide: true,
});

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  return document.getElementById('skillBtn') && document.getElementById('skillSearch') ? { ready: true } : null;
})()`;
// 键入查询并等服务条出现(服务条是 JS 建的节点 —— 无匹配时它【不存在】,不是 display:none)。
const TYPE_AND_STRIP = `(async (query) => {
  const s = document.getElementById('skillSearch');
  s.value = query;
  s.dispatchEvent(new Event('input', { bubbles: true }));
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const strip = document.querySelector('#skillList .sk-svc-match');
    if (strip) return { text: strip.textContent };
    await new Promise(r => setTimeout(r, 60));
  }
  return null;
})`;
const STRIP_GONE = `(async () => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!document.querySelector('#skillList .sk-svc-match')) return { gone: true };
    await new Promise(r => setTimeout(r, 60));
  }
  return null;
})`;

let server = null, browser = null, cdp = null;
try {
  server = spawnWb();
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', r => r.status === 200)), 'A0 workbench started');
  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A1 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + path.join(root, 'profile'), appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A2 CDP target found');
  if (!target) throw new Error('no CDP target');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  ok(Boolean(await waitForEval(cdp, READY)), 'A3 app booted (state + skillBtn/skillSearch present)');

  // 真实入口:点 #skillBtn 开技能库,等注册表渲出分组。
  await cdp.evaluate(`document.getElementById('skillBtn').click()`, false);
  const panelReady = await waitForEval(cdp, `(() => {
    const m = document.getElementById('skillModal');
    if (!m || m.classList.contains('hidden')) return null;
    return document.querySelector('#skillList .sk-group, #skillList .muted') ? { open: true } : null;
  })()`);
  ok(Boolean(panelReady), 'A4 技能库经 #skillBtn 真实打开并渲出列表');

  // B1 可用服务:整理下载 → 服务条「资料整理 … 个模板可直接用」(可用数随机器 ACC 有无变,不断言死数)。
  const b1 = await cdp.evaluate(`${TYPE_AND_STRIP}('帮我整理下载文件夹')`);
  ok(b1 && /资料整理/.test(b1.text || '') && /个模板可直接用/.test(b1.text || ''), 'B1 「整理下载」服务条 = 资料整理·可直接用 — 实得 ' + JSON.stringify(b1 && b1.text));
  // B2 暂无模板:守望变化 → 服务条「变化守望:这类还没有模板」。
  const b2 = await cdp.evaluate(`${TYPE_AND_STRIP}('帮我守望这个文件夹的变化')`);
  ok(b2 && /变化守望/.test(b2.text || '') && /还没有模板/.test(b2.text || ''), 'B2 「守望变化」服务条 = 变化守望·暂无模板 — 实得 ' + JSON.stringify(b2 && b2.text));
  // B3 无关词 → 服务条不存在(零行为,节点都不建)。
  await cdp.evaluate(`(() => { const s = document.getElementById('skillSearch'); s.value = 'zzzqx'; s.dispatchEvent(new Event('input', { bubbles: true })); })()`, false);
  await sleep(600); // 等 220ms 防抖 + 一个往返
  ok(Boolean(await cdp.evaluate(STRIP_GONE)), 'B3 无关词 → 服务条不存在(零行为)');
  // B4 服务条复现后再清空 → 消失(不常驻)。
  ok(Boolean(await cdp.evaluate(`${TYPE_AND_STRIP}('帮我整理下载文件夹')`)), 'B4 再次键入服务条复现');
  await cdp.evaluate(`(() => { const s = document.getElementById('skillSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`, false);
  ok(Boolean(await cdp.evaluate(STRIP_GONE)), 'B4 清空查询 → 服务条消失(不常驻)');

  // ── C 段 · 127-⑧ A-F01:能力未知时如实显示「未知」,不经文案升级成「可用」 ─────────────────────────
  const capsNow = await request(appPort, 'GET', '/api/capabilities');
  const onlineNow = capsNow && capsNow.json && capsNow.json.network ? capsNow.json.network.online : 'missing';
  ok(onlineNow === null, 'C0 夹具前提:network.online === null(实得 ' + JSON.stringify(onlineNow) + ')');
  const pbList = await request(appPort, 'GET', '/api/playbooks');
  const pbRows = (pbList && pbList.json && pbList.json.playbooks) || [];
  const f01Status = F01_PLAYBOOKS.map(pb => (pbRows.find(p => p.id === pb.id) || {}).status);
  ok(JSON.stringify(f01Status) === '["unknown","unknown","needs_config"]', 'C0 夹具模板 status = 两条联网 unknown + 一条视觉 needs_config(实得 ' + JSON.stringify(f01Status) + ')');
  const researchAvail = pbRows.filter(p => p.service === 'research' && p.status === 'available').length;
  // C1 独占一类的未知模板 → 服务条说「未知」、不说「可用」。
  const c1 = await cdp.evaluate(`${TYPE_AND_STRIP}('帮我写代码修 bug')`);
  const c1Text = (c1 && c1.text) || '';
  ok(/代码任务/.test(c1Text) && /未知/.test(c1Text) && !/可用|可直接用/.test(c1Text), 'C1 「写代码修 bug」服务条 = 代码任务·状态未知、不含「可用」 — 实得 ' + JSON.stringify(c1Text));
  // C2 同一条模板在技能库行上:状态行说「未知」,行里不出现「可用」,且照旧可点(未知不改放行)。
  const c2 = await cdp.evaluate(`(async () => {
    const s = document.getElementById('skillSearch');
    s.value = '代码体检'; s.dispatchEvent(new Event('input', { bubbles: true }));
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const row = [...document.querySelectorAll('#skillList .skill-item')].find(r => (r.querySelector('.sk-id') || {}).textContent === 'pb:f01-unknown-coding');
      if (row) {
        const st = row.querySelector('.sk-status');
        return { status: st ? st.textContent : null, dataStatus: st ? st.dataset.status : null, rowText: row.textContent, greyed: row.classList.contains('unavailable') };
      }
      await new Promise(r => setTimeout(r, 60));
    }
    return null;
  })()`);
  ok(c2 && /未知/.test(c2.status || '') && c2.dataStatus === 'unknown' && !/可用|可直接用/.test(c2.rowText || '') && c2.greyed === false,
    'C2 技能库行 pb:f01-unknown-coding:状态行「未知」、整行不含「可用」、未置灰 — 实得 ' + JSON.stringify(c2));
  // C3 混合类(两条可用内置 + 一条未知):「可直接用」只数 status===available,未知的单独说。
  const c3 = await cdp.evaluate(`${TYPE_AND_STRIP}('对比')`);
  const c3Text = (c3 && c3.text) || '';
  const c3Count = Number((c3Text.match(/(\d+) 个模板可直接用/) || [])[1]);
  ok(researchAvail === 2 && c3Count === researchAvail && /1 个状态未知/.test(c3Text),
    'C3 研究比较服务条可直接用数 = ' + researchAvail + '(status===available),未知 1 条单独说 — 实得 ' + JSON.stringify(c3Text));
  // C4 首页任务卡:状态行只长在非可用模板上;未知卡说「未知」且仍是可点的 <button>。
  await cdp.evaluate(`(() => { const s = document.getElementById('skillSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); })()`, false);
  const c4 = await waitForEval(cdp, `(() => {
    const pbs = (window.state && window.state.playbooks) || [];
    const mode = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'simple' : 'pro';
    const visible = pbs.filter(pb => pb && (pb.uiMode === 'both' || pb.uiMode === mode || !pb.uiMode));
    const cards = [...document.querySelectorAll('.pb-card')];
    if (!visible.length || cards.length !== visible.length) return null;
    const pick = title => {
      const card = cards.find(c => (c.querySelector('.pb-card-title') || {}).textContent === title);
      const st = card && card.querySelector('.pb-card-status');
      const reason = card && card.querySelector('.pb-card-reason');
      return card ? { tag: card.tagName, status: st ? st.textContent : null, reason: reason ? reason.textContent : null, text: card.textContent } : null;
    };
    return {
      cards: cards.length,
      statusLines: document.querySelectorAll('.pb-card .pb-card-status').length,
      expectedLines: visible.filter(pb => pb.status !== 'available').length,
      availableWithLine: [...document.querySelectorAll('.pb-card-status')].filter(n => n.dataset.status === 'available').length,
      unknownCard: pick('代码体检联网版'),
      visionCard: pick('看图夹具'),
    };
  })()`, 150);
  ok(c4 && c4.unknownCard && c4.unknownCard.tag === 'BUTTON' && /未知/.test(c4.unknownCard.status || '') && !/可用|可直接用/.test(c4.unknownCard.text || ''),
    'C4 首页未知卡:状态行「未知」、整卡不含「可用」、仍是可点的 button — 实得 ' + JSON.stringify(c4 && c4.unknownCard));
  ok(c4 && c4.statusLines === c4.expectedLines && c4.availableWithLine === 0,
    'C4 状态行只长在非可用模板上(可用卡零新增节点)— 实得 ' + JSON.stringify(c4 && { cards: c4.cards, statusLines: c4.statusLines, expectedLines: c4.expectedLines, availableWithLine: c4.availableWithLine }));
  ok(c4 && c4.visionCard && c4.visionCard.tag === 'DIV' && c4.visionCard.status === '需要配置' && /视觉/.test(c4.visionCard.reason || ''),
    'C5 首页需配置卡:状态行「需要配置」+ 原有 ⛔ 原因行、置灰不可点 — 实得 ' + JSON.stringify(c4 && c4.visionCard));

  // ── D 段 · 127-⑧ 离线降级:同一 HOME 换成死探测地址重启(同一个 spawnWb 调用点)→ online:false ──────
  killTree(server);
  await sleep(300);
  const deadPort = await getFreePort();
  const cfgPath = path.join(home, 'config.json');
  const cfgNow = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cfgNow, capabilityProbeUrl: 'http://127.0.0.1:' + deadPort }), 'utf8');
  server = spawnWb();
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', r => r.status === 200)), 'D0 以死探测地址重启 workbench');
  const capsOff = await request(appPort, 'GET', '/api/capabilities');
  ok(capsOff && capsOff.json && capsOff.json.network && capsOff.json.network.online === false, 'D0 夹具前提:network.online === false(实得 ' + JSON.stringify(capsOff && capsOff.json && capsOff.json.network && capsOff.json.network.online) + ')');
  await cdp.evaluate('location.reload()', false);
  await sleep(300);
  ok(Boolean(await waitForEval(cdp, READY)), 'D1 页面重载后启动完成');
  const d2 = await waitForEval(cdp, `(() => {
    const card = [...document.querySelectorAll('.pb-card')].find(c => (c.querySelector('.pb-card-title') || {}).textContent === '对比联网资料');
    if (!card) return null;
    const st = card.querySelector('.pb-card-status');
    return { tag: card.tagName, status: st ? st.textContent : null, dataStatus: st ? st.dataset.status : null, reasons: card.querySelectorAll('.pb-card-reason').length };
  })()`, 300);
  ok(d2 && d2.tag === 'DIV' && d2.dataStatus === 'unavailable' && /联网/.test(d2.status || '') && /离线/.test(d2.status || '') && /本地|恢复/.test(d2.status || '') && d2.reasons === 0,
    'D2 首页离线卡:一句降级文案(要联网、现在离线、下一步)替掉 ⛔ 原因行、置灰 — 实得 ' + JSON.stringify(d2));
  await cdp.evaluate(`document.getElementById('skillBtn').click()`, false);
  ok(Boolean(await waitForEval(cdp, `(() => { const m = document.getElementById('skillModal'); return m && !m.classList.contains('hidden') && document.querySelector('#skillList .sk-group, #skillList .muted') ? true : null; })()`)), 'D3 重开技能库');
  const d3 = await cdp.evaluate(`(async () => {
    const s = document.getElementById('skillSearch');
    s.value = '对比联网'; s.dispatchEvent(new Event('input', { bubbles: true }));
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const row = [...document.querySelectorAll('#skillList .skill-item')].find(r => (r.querySelector('.sk-id') || {}).textContent === 'pb:f01-unknown-research');
      if (row) {
        const st = row.querySelector('.sk-status');
        return { status: st ? st.textContent : null, reasons: row.querySelectorAll('.sk-reason').length, greyed: row.classList.contains('unavailable') };
      }
      await new Promise(r => setTimeout(r, 60));
    }
    return null;
  })()`);
  ok(d3 && /联网/.test(d3.status || '') && /离线/.test(d3.status || '') && d3.reasons === 1 && d3.greyed === true,
    'D3 技能库离线行:只一行降级文案(不叠同义原因)、置灰 — 实得 ' + JSON.stringify(d3));
  const d4 = await cdp.evaluate(`${TYPE_AND_STRIP}('帮我写代码修 bug')`);
  ok(d4 && /代码任务/.test(d4.text || '') && /网络/.test(d4.text || '') && !/未知|可直接用/.test(d4.text || ''),
    'D4 离线时代码任务服务条 = 需配置·引导查网络(离线引导仍是 network)— 实得 ' + JSON.stringify(d4 && d4.text));

  console.log('\nSERVICE-MATCH BROWSER E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
} catch (e) {
  console.error('E2E ERROR', e && e.stack || e);
  fail++;
  console.log('\nSERVICE-MATCH BROWSER E2E: FAIL (error)');
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  await sleep(300);
  try { stopRuyiTestBrowsers(path.join(root, 'profile')); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}
})();

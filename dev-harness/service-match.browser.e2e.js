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
(async () => {
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
  try { if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGKILL'); }
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

const spawnWb = () => cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
  cwd: WB,
  env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
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

'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 前端走查第 1 波 #9：服务商没有选定模型时，首条消息的报错原来是整句英文（「Cannot start a x turn: no model is selected …」），
// 在中文界面里很扎眼。现按 config.locale 选语言（与 emptyReplyNotice 同一口径）：zh-CN → 中文人话，en-US → 原来的英文；
// 事件里的 errorClass 仍是 provider_misconfigured（前端的人话化与「去设置」按钮靠它，不靠这句文案）。
// 不需要假 provider：这一步在发请求之前就拦下了。判定行：`PROVIDER NO MODEL LOCALE E2E: ALL PASS`。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('PROVIDER NO MODEL LOCALE');
const { ok } = t;

function request(port, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 8000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(token ? { 'x-wcw-token': token } : {}) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (raw) req.write(raw);
    req.end();
  });
}
function streamChat(port, body, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 20000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { events.push(JSON.parse(line)); } catch { /* 半行 */ } } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-no-model-locale-'));
  const port = await getFreePort();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 8, permissionMode: 'bypass', defaultWorkspace: home, locale: 'zh-CN',
    providers: [{ id: 'nomodel', label: '没模型的服务商', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model: '' }],
    activeProvider: 'nomodel',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: home } });
  try {
    let healthy = false;
    for (let i = 0; i < 300 && !healthy; i++) { await sleep(120); try { healthy = (await request(port, 'GET', '/health')).status === 200; } catch { /* 还没起来 */ } }
    ok(healthy, 'N0 工作台起来了');
    let token = '';
    for (let i = 0; i < 80 && !token; i++) { try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { await sleep(100); } }
    ok(Boolean(token), 'N0b runtime token 可读');

    const turnText = async title => {
      const created = await request(port, 'POST', '/api/sessions', { title, cwd: home }, token);
      const events = await streamChat(port, { sessionId: created.json.session.id, message: '你好', cwd: home }, token);
      const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text || '').join('');
      return { text, result: events.find(e => e.type === 'result') || null, events };
    };

    const zh = await turnText('zh');
    ok(/无法发起「没模型的服务商」这一轮对话/.test(zh.text) && /还没有选定模型/.test(zh.text), `N1 zh-CN：说的是中文人话(实测 ${JSON.stringify(zh.text.slice(0, 80))})`);
    ok(!/Cannot start|no model is selected/.test(zh.text), 'N2 zh-CN：整句里没有英文原句');
    ok(zh.result && zh.result.errorClass === 'provider_misconfigured', `N3 errorClass 仍是 provider_misconfigured(前端人话化靠它;实测 ${zh.result && zh.result.errorClass})`);

    const switched = await request(port, 'POST', '/api/config', { locale: 'en-US' }, token);
    ok(switched.status === 200, 'N4 切到 en-US');
    const en = await turnText('en');
    ok(/Cannot start a 没模型的服务商 turn: no model is selected for this provider/.test(en.text), `N5 en-US：保持原来的英文(实测 ${JSON.stringify(en.text.slice(0, 100))})`);
    ok(en.result && en.result.errorClass === 'provider_misconfigured', 'N6 en-US：errorClass 同样是 provider_misconfigured');
  } finally {
    try { killOwnTree(wb); } catch { /* 已退出 */ }
    await sleep(300);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });

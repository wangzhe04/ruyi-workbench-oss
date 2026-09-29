'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:会话 id 拼文件名的咽喉点(01 sessionPath / 02 sessionBodyPaths / journalDir)拒绝不合形的 id。
// 修前几条路由直接拿请求体里的 sessionId 拼路径:`../config` 让 /api/chat/stream 把 <数据根>/config.json(连同服务商
// 密钥)当成会话读出来、在 session 事件里原样回显;/api/session/skills、/api/session/memories 会把它当会话改写。
//   P1 /api/chat/stream sessionId:'../config' → 回显里没有配置内容(当作没有这个会话,另起一个新会话)
//   P2 /api/session/skills、/api/session/memories sessionId:'../config' → 404,config.json 原样不动
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-id-guard-'));
const t = createRunner('SESSION ID PATH GUARD');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECRET = 'sk-PATHGUARD-7f3a';

function req(port, method, route, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : '';
    const r = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, raw: b }));
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + route)); });
    if (data) r.write(data); r.end();
  });
}

(async () => {
  let wb = null;
  try {
    const port = await getFreePort();
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 8, permissionMode: 'bypass', defaultWorkspace: HOME,
      providers: [{ id: 'p', label: 'P', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: SECRET, model: 'm', models: [{ id: 'm', label: 'm' }] }],
      activeProvider: 'p',
    }, null, 2));
    const env = { ...process.env, HOME, USERPROFILE: HOME, RUYI_HOME: HOME };
    delete env.WIN_CLAUDE_WORKBENCH_HOME;
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
    let token = '';
    for (let i = 0; i < 80 && !token; i++) {
      await sleep(200);
      try { const r = await req(port, 'GET', '/'); const m = (r.raw || '').match(/name="wcw-token"\s+content="([a-f0-9]+)"/); if (m) token = m[1]; } catch { /* not up yet */ }
    }
    ok(!!token, 'workbench up');
    const hdr = { 'x-wcw-token': token };
    const before = fs.readFileSync(path.join(HOME, 'config.json'), 'utf8');

    const chat = await req(port, 'POST', '/api/chat/stream', { sessionId: '../config', message: 'hi', cwd: HOME }, hdr);
    ok(!chat.raw.includes(SECRET) && !chat.raw.includes('"providers"'), `P1 /api/chat/stream ../config 不回显配置(${chat.raw.slice(0, 160)})`);

    for (const [route, body] of [['/api/session/skills', { sessionId: '../config', skills: [] }], ['/api/session/memories', { sessionId: '../config' }]]) {
      const r = await req(port, 'POST', route, body, hdr);
      ok(r.status === 404 && !r.raw.includes(SECRET), `P2 ${route} ../config → 404(${r.status} ${r.raw.slice(0, 100).replace(/\s+/g, ' ')})`);
    }
    const after = fs.readFileSync(path.join(HOME, 'config.json'), 'utf8');
    ok(JSON.parse(after).providers[0].apiKey === SECRET && !fs.existsSync(path.join(HOME, 'config.json.corrupt')), 'P2 config.json 没被当成会话改写或隔离');
    ok(JSON.parse(before).activeProvider === JSON.parse(after).activeProvider, 'P2 配置内容前后一致');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (wb) { try { killOwnTree(wb); } catch { /* gone */ } await sleep(300); }
    if (t.failures === 0) fs.rmSync(HOME, { recursive: true, force: true });
    else console.log('[keep] ' + HOME);
  }
  t.done({ exit: true });
})();

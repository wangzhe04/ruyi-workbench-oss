'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:会话 id 拼文件名的咽喉点(01 sessionPath / 02 sessionBodyPaths / journalDir)拒绝不合形的 id。
// 修前几条路由直接拿请求体里的 sessionId 拼路径:`../config` 让 /api/chat/stream 把 <数据根>/config.json(连同服务商
// 密钥)当成会话读出来、在 session 事件里原样回显;/api/session/skills、/api/session/memories 会把它当会话改写。
//   P1 /api/chat/stream sessionId:'../config' → 回显里没有配置内容(当作没有这个会话,另起一个新会话)
//   P2 /api/session/skills、/api/session/memories sessionId:'../config' → 404,config.json 原样不动
// 会话目录里的保留名与单条会话路由的形状(修前实证):
//   P3 GET /api/sessions/_search-index-v1 → 404,搜索索引没被当成 v1 会话「懒迁移」(修前 200 + 头被改写 + 长出正文);
//      DELETE /api/sessions/index → 400,侧栏索引还在(修前 200 + unlink index.json)
//   P4 开放读口 GET /api/status?sessionId= / GET /api/models?sessionId=(不带 token、跨站来源)只读会话头:
//      头缺默认字段的会话头逐字节不变(修前 loadSession 回写);保留名不长出任何文件
//   P5 /api/sessions/<多段>/<id> 不再是 <id> 的别名(修前 GET 200、DELETE 真删);子路由 /background 与 /search 照常
//   P6 POST /api/sessions 带 messages:[null] → 200,不合形的条目被丢掉(修前 500)
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

    const sessDir = path.join(HOME, 'sessions');
    const jsonOf = r => { try { return JSON.parse(r.raw); } catch { return null; } };
    const created = jsonOf(await req(port, 'POST', '/api/sessions', { title: 'hello guard', cwd: HOME }, hdr));
    const sid = created && created.session && created.session.id;
    ok(typeof sid === 'string' && /^sess_/.test(sid), `建会话(${sid})`);
    const search = await req(port, 'GET', '/api/sessions/search?q=hello', null, hdr);
    ok(search.status === 200, `搜索可用(${search.status})`);
    await sleep(300);
    const searchIdx = path.join(sessDir, '_search-index-v1.json');
    const sideIdx = path.join(sessDir, 'index.json');
    ok(fs.existsSync(searchIdx) && fs.existsSync(sideIdx), '搜索索引与侧栏索引都已落盘');
    const searchBefore = fs.readFileSync(searchIdx, 'utf8');
    const reserved = await req(port, 'GET', '/api/sessions/_search-index-v1', null, hdr);
    ok(reserved.status === 404, `P3 GET /api/sessions/_search-index-v1 → 404(${reserved.status} ${reserved.raw.slice(0, 80).replace(/\s+/g, ' ')})`);
    await sleep(300);
    const strays = fs.readdirSync(sessDir).filter(f => f.startsWith('_search-index-v1') && f !== '_search-index-v1.json');
    ok(fs.readFileSync(searchIdx, 'utf8') === searchBefore && strays.length === 0, `P3 搜索索引原样、没长出正文/备份(${strays.join(',')})`);
    const delIndex = await req(port, 'DELETE', '/api/sessions/index', null, hdr);
    ok(delIndex.status === 400 && fs.existsSync(sideIdx), `P3 DELETE /api/sessions/index → 400,index.json 还在(${delIndex.status})`);

    // P4:一条「老版本写下的」v2 头(缺 normalize 补的默认字段、updatedAt 很旧)。开放读口不许替它回写。
    const headFile = path.join(sessDir, sid + '.json');
    const oldHead = JSON.parse(fs.readFileSync(headFile, 'utf8'));
    for (const key of ['todos', 'skills', 'memories', 'memoriesExplicit', 'memoryExclusions']) delete oldHead[key];
    oldHead.updatedAt = '2020-01-02T03:04:05.000Z';
    fs.writeFileSync(headFile, JSON.stringify(oldHead, null, 2));
    const headBefore = fs.readFileSync(headFile, 'utf8');
    const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
    const st = await req(port, 'GET', '/api/status?sessionId=' + sid, null, crossSite);
    const stJson = jsonOf(st);
    ok(st.status === 200 && stJson && stJson.ok === true && Array.isArray(stJson.models), `P4 /api/status?sessionId= 照常回(${st.status})`);
    const md = await req(port, 'GET', '/api/models?sessionId=' + sid, null, crossSite);
    ok(md.status === 200, `P4 /api/models?sessionId= 照常回(${md.status})`);
    await req(port, 'GET', '/api/status?sessionId=_search-index-v1', null, crossSite);
    await sleep(400);
    ok(fs.readFileSync(headFile, 'utf8') === headBefore, 'P4 开放读口没有回写会话头(修前 load_normalize 回写 + 推 updatedAt)');
    ok(fs.readFileSync(searchIdx, 'utf8') === searchBefore
      && fs.readdirSync(sessDir).filter(f => f.startsWith('_')).join(',') === '_search-index-v1.json', 'P4 /api/status?sessionId=保留名 不长出任何文件');

    const aliasGet = await req(port, 'GET', '/api/sessions/anything/at/all/' + sid, null, hdr);
    ok(aliasGet.status === 404, `P5 GET /api/sessions/anything/at/all/<id> → 404(${aliasGet.status})`);
    const aliasTrail = await req(port, 'GET', '/api/sessions/' + sid + '/', null, hdr);
    ok(aliasTrail.status === 404, `P5 GET /api/sessions/<id>/ → 404(${aliasTrail.status})`);
    const aliasDel = await req(port, 'DELETE', '/api/sessions/zzz/' + sid, null, hdr);
    ok(aliasDel.status === 404 && fs.existsSync(headFile), `P5 DELETE /api/sessions/zzz/<id> 不删会话(${aliasDel.status})`);
    const direct = await req(port, 'GET', '/api/sessions/' + encodeURIComponent(sid), null, hdr);
    ok(direct.status === 200 && (jsonOf(direct) || {}).session && jsonOf(direct).session.id === sid, `P5 GET /api/sessions/<id> 照常(${direct.status})`);
    const bg = await req(port, 'GET', '/api/sessions/' + sid + '/background', null, hdr);
    ok(bg.status === 200 && (jsonOf(bg) || {}).sessionId === sid, `P5 子路由 /api/sessions/<id>/background 照常(${bg.status})`);

    const imported = await req(port, 'POST', '/api/sessions', { title: 'imp', cwd: HOME, messages: [null, 5, 'x', { role: 'user', content: 'kept' }] }, hdr);
    const impJson = jsonOf(imported);
    const impMsgs = impJson && impJson.session && impJson.session.messages;
    ok(imported.status === 200 && Array.isArray(impMsgs) && impMsgs.length === 1 && impMsgs[0].content === 'kept', `P6 messages:[null,…] → 200,只留合形条目(${imported.status})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (wb) { try { killOwnTree(wb); } catch { /* gone */ } await sleep(300); }
    if (t.failures === 0) fs.rmSync(HOME, { recursive: true, force: true });
    else console.log('[keep] ' + HOME);
  }
  t.done({ exit: true });
})();

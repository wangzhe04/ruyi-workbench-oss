'use strict';
// 2026-10（用户：「提问回答有时候会显示 Failed to fetch」）：public/js/net.js 的网络层失败处理。
//   [A] fetch 抛的网络错误（TypeError: Failed to fetch / network error）被 apiErrorInfo 认成 net.disconnected，
//       消息是人话（可由组合根注入翻译），不再是浏览器原生英文；中止（AbortError）与 HTTP 错误不受影响；
//   [B] 只读请求（GET）网络层失败隔一拍重发一次，第二发成功就当没事发生；
//   [C] 写请求（POST）不盲重发 —— 第一发可能已送达（/api/chat/answer 重发会撞 409）；
//   [D] 第二发还失败就照原样抛出，调用方拿到的仍是可识别的网络错误。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const NET = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/net.js')).href;
let net;
let calls;
let script;
let store;
beforeEach(async () => {
  net = net || await import(NET);
  calls = [];
  script = [];
  // 真实的 sessionStorage 是可写可删的:initToken(true) 先 removeItem 再读,删不掉就会拿回旧 token。
  store = new Map([['wcw.token', 'tok']]);
  globalThis.sessionStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET', headers: { ...((opts && opts.headers) || {}) }, options: opts });
    const next = script.shift();
    if (next instanceof Error) throw next;
    if (next && next.response) return next.response;
    return new Response(JSON.stringify(next || { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
const forbidden=()=>new Response(JSON.stringify({ok:false,error:{code:'auth.token_invalid'}}),{status:403,headers:{'content-type':'application/json'}});
const bootstrapOk=token=>new Response(JSON.stringify({ok:true,token}),{status:200,headers:{'content-type':'application/json'}});

test('[A] 网络错误报人话，别的错误原样', () => {
  const info = net.apiErrorInfo(new TypeError('Failed to fetch'));
  assert.equal(info.code, net.NETWORK_ERROR_CODE);
  assert.doesNotMatch(info.message, /Failed to fetch/);
  assert.equal(net.apiErrorInfo(new TypeError('network error')).code, net.NETWORK_ERROR_CODE);
  net.setNetworkErrorMessage(() => 'LOST');
  assert.equal(net.apiErrText(new TypeError('Failed to fetch')), 'LOST');
  const abort = new Error('aborted'); abort.name = 'AbortError';
  assert.equal(net.isNetworkError(abort), false);
  assert.equal(net.apiErrorInfo(new Error('{"ok":false,"error":{"code":"x.y","message":"人话"}}')).code, 'x.y');
  assert.equal(net.apiErrorInfo(new TypeError('Cannot read properties of undefined')).code, '');
});

test('[B] GET 网络层失败重发一次', async () => {
  script = [new TypeError('Failed to fetch'), { ok: true, n: 2 }];
  const r = await net.api('/api/status');
  assert.equal(r.n, 2);
  assert.equal(calls.length, 2);
});

test('[C] POST 不盲重发', async () => {
  script = [new TypeError('Failed to fetch'), { ok: true }];
  await assert.rejects(net.api('/api/chat/answer', { method: 'POST', body: '{}' }), e => net.isNetworkError(e));
  assert.equal(calls.length, 1);
});

test('[D] 重发也失败就照原样抛', async () => {
  script = [new TypeError('Failed to fetch'), new TypeError('Failed to fetch')];
  await assert.rejects(net.api('/api/status'), e => net.isNetworkError(e));
  assert.equal(calls.length, 2);
});

// 2026-10: 迁移备份包上传(POST /api/work-data/uploads，body 是文件)不能走「403 换 token 重放」——
// 重放等于把用户选的那份二进制再发一遍。apiRaw 的 noTokenReplay 选项必须真的跳过 replay 分支，
// 而不是靠 fetch 忽略未知字段或一句假注释；同时这个私有选项不许漏给 fetch。
test('[E] noTokenReplay 的 POST 在 403 token 失效后不换 token、不重放', async () => {
  script = [{ response: forbidden() }, { response: bootstrapOk('fresh') }, { response: new Response('{}', { status: 200 }) }];
  const res = await net.apiRaw('/api/work-data/uploads', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'sealed-bytes', noTokenReplay: true });
  assert.equal(res.status, 403, '403 原样返回给调用方自己判断');
  assert.equal(calls.length, 1, 'zero replay');
  assert.equal(calls.filter(c => String(c.url).includes('/api/bootstrap')).length, 0, '不刷新 token');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers['content-type'], 'application/octet-stream', '调用方自己的 content-type 保留');
  assert.ok(calls[0].headers['x-wcw-token'], '鉴权头照旧带着');
  assert.equal('noTokenReplay' in calls[0].options, false, '私有选项不下传给 fetch(不与浏览器扩展选项打架)');
  assert.equal(await res.text(), JSON.stringify({ ok: false, error: { code: 'auth.token_invalid' } }), '返回的 Response body 仍可读一次');
});

test('[F] 未传 noTokenReplay 时 POST 仍换 token 重放一次(既有调用方行为不变)', async () => {
  script = [
    { response: forbidden() },
    { response: bootstrapOk('fresh') },
    { response: new Response(JSON.stringify({ ok: true, replayed: true }), { status: 202, headers: { 'content-type': 'application/json' } }) },
  ];
  const payload = await net.api('/api/work-data/jobs', { method: 'POST', body: '{}' });
  assert.equal(payload.replayed, true);
  const posts = calls.filter(c => String(c.url) === '/api/work-data/jobs');
  assert.equal(posts.length, 2, '恰好重放一次');
  assert.equal(calls.filter(c => String(c.url).includes('/api/bootstrap')).length, 1);
  assert.equal(posts[1].headers['x-wcw-token'], 'fresh');
});

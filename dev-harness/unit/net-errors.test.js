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
beforeEach(async () => {
  net = net || await import(NET);
  calls = [];
  script = [];
  globalThis.sessionStorage = { getItem: () => 'tok', setItem() {}, removeItem() {} };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || 'GET' });
    const next = script.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next || { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

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

'use strict';
// 04h providerPostJsonOnce 的「调用方取消 / 内部超时」合流语义 —— 真计时器那一半。
// 经两个补全外壳(05 改字 / 06 起草)的同一批判据在 provider-http.test.js [H6];这里直接钉原语:
//   · 真超时:计时器到点 → 中止自己那一发 → timedOut:true、cancelled:false(调用方照自己的口径报超时);
//   · 调用方取消:signal 中止 → cancelled:true、timedOut:false(不许被报成端点慢);
//   · 读回体那一段(头部已回、body 读不完)被取消 / 超时:同样报取消 / 超时,不能落成「服务商给了空补全」;
//   · 调用前已取消:一发都不发(fetch 计数不变);
//   · 结算后摘掉调用方 signal 上的监听器(回合级 signal 活得很久)。
// providerPostJsonOnce 不在 14-main 的导出面里,用 loadServerInternals 取真实现;fetch 用桩,不连网。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-post-json-once-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['providerPostJsonOnce']);

const realFetch = global.fetch;
let calls = 0, lastSignal = null, hang = false, bodyReadHang = false;
global.fetch = async (url, init) => {
  calls++;
  lastSignal = (init && init.signal) || null;
  if (bodyReadHang) {
    // 头部已回、回体读不完:计时/取消都发生在读回体那一段。
    return {
      ok: true, status: 200,
      text: () => new Promise((_, reject) => {
        const s = lastSignal;
        const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
        if (!s) { reject(new Error('body-read hang needs a signal')); return; }
        if (s.aborted) onAbort(); else s.addEventListener('abort', onAbort, { once: true });
      }),
    };
  }
  if (!hang) return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200, headers: { 'content-type': 'application/json' } });
  // 一直不回话,直到调用方(或内部计时器)把 signal 中止。
  return await new Promise((_, reject) => {
    const s = init && init.signal;
    const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
    if (!s) { reject(new Error('stub hang needs a signal')); return; }
    if (s.aborted) onAbort(); else s.addEventListener('abort', onAbort, { once: true });
  });
};
const reset = () => { calls = 0; lastSignal = null; hang = false; bodyReadHang = false; };
const post = (extra = {}) => app.providerPostJsonOnce({ url: 'https://fixture.invalid/v1/chat/completions', headers: {}, body: { messages: [] }, timeoutMs: 60000, ...extra });

test('真超时:计时器中止自己那一发,timedOut 而不是 cancelled', async () => {
  reset(); hang = true;
  const r = await post({ timeoutMs: 25 });
  assert.equal(r.threw, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
  assert.equal(r.error.name, 'AbortError');
  assert.equal(calls, 1);
  assert.equal(Boolean(lastSignal && lastSignal.aborted), true, '计时器要真把这一发中止掉,不能只是放弃等待');
});

test('调用方取消:报 cancelled,不报 timedOut', async () => {
  reset(); hang = true;
  const ctrl = new AbortController();
  const pending = post({ signal: ctrl.signal });
  await new Promise(res => setImmediate(res));
  ctrl.abort();
  const r = await pending;
  assert.equal(r.threw, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.equal(calls, 1);
});

test('调用前已取消:一发都不发', async () => {
  reset();
  const ctrl = new AbortController(); ctrl.abort();
  const r = await post({ signal: ctrl.signal });
  assert.equal(r.threw, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.error.name, 'AbortError');
  assert.equal(calls, 0, '取消的请求不该走到 fetch');
});

test('读回体期间取消:报 cancelled,不落成「空补全」', async () => {
  reset(); bodyReadHang = true;
  const ctrl = new AbortController();
  const pending = post({ signal: ctrl.signal });
  await new Promise(res => setImmediate(res));
  ctrl.abort();
  const r = await pending;
  assert.equal(r.threw, true);
  assert.equal(r.cancelled, true);
  assert.equal(r.timedOut, false);
  assert.equal(calls, 1);
  assert.equal(Boolean(lastSignal && lastSignal.aborted), true, '取消要把读回体那一段也中止掉');
});

test('读回体期间超时:timedOut,不落成「空补全」', async () => {
  reset(); bodyReadHang = true;
  const r = await post({ timeoutMs: 25 });
  assert.equal(r.threw, true);
  assert.equal(r.timedOut, true);
  assert.equal(r.cancelled, false);
});

test('正常返回:回体照旧解析,结算后不留在调用方 signal 上', async () => {
  reset();
  const added = []; let addCalls = 0;
  const fake = {
    aborted: false,
    addEventListener: (_t, fn) => { addCalls++; added.push(fn); },
    removeEventListener: (_t, fn) => { const i = added.indexOf(fn); if (i >= 0) added.splice(i, 1); },
  };
  const r = await post({ signal: fake });
  assert.equal(r.ok, true);
  assert.deepEqual(r.parsed, { choices: [{ message: { content: 'ok' } }] });
  assert.equal(addCalls, 1, '取消语义靠这个监听器:确实挂过');
  assert.equal(added.length, 0, '结算后摘掉监听器');
});

after(() => {
  global.fetch = realFetch;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

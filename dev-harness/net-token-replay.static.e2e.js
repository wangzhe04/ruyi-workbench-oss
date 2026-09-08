#!/usr/bin/env node
'use strict';

// 117q-B3a（P1-6，30 号文 §4.6）伴随断言：「403 场景下 loadMissions() 应换 token 重放并成功」，
// 此前全仓没有这类回归测试。
//
// 为什么不站在真实浏览器 e2e 夹具里做（steward-board.e2e.js 那一路 CDP 无头驱动）：那一路要起
// 真实 server.js + 真无头浏览器；本刀提交窗口内 117q-B1 正并发改 00-boot.js/05-claude-engine.js/
// 05b-kimi-bridge.js/07-autonomy.js 并会重跑整条生成器链重建 server.js（见派单稿硬约束），此时去
// 起一个依赖当前 server.js 状态的真机测试，测出来的红/绿不代表本刀自己的改动，还会平白多一次和
// 并发切片抢 server.js 的风险。apiRaw()/api() 的重放逻辑只依赖全局 fetch + sessionStorage（document
// 只在两者都摸不到 token 时才碰一下）——和 i18n.static.e2e.js 验证 net.js 错误信封（第 72-79 行：
// `global.fetch = ...; await import(data:...)`）用的是同一个办法：把 net.js 当纯 ESM 模块，灌假
// fetch/sessionStorage，让真实的换 token + 重放代码原样跑一遍。不用真机也能把这条真回归焊死，
// 而且比正则扫描的静态锁更硬——它真的执行了 apiRaw 内部的分支，不是只看字面有没有出现某个词。
//
// 判定行：`NET TOKEN REPLAY E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NET_PATH = path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'net.js');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// net.js 的 _token 是模块级变量：每个场景都要一个全新模块实例，场景之间不许共享状态。data: URL
// 的模块缓存按【内容】识别——net.js 本身不用 import.meta.url（不像 i18n.js 需要那一手替换），
// 所以直接在源码尾部追加一行带自增序号的注释让每次的 data: URL 字节都不同，逼出全新模块实例。
let cacheBust = 0;
async function freshNet() {
  cacheBust += 1;
  const source = fs.readFileSync(NET_PATH, 'utf8') + `\n// cache-bust:${cacheBust}\n`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

function makeSessionStorage(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
}

// 模拟真实 Response 的「body 只能读一次，除非 clone()」语义：apiRaw() 用 res.clone().text() 探测
// 403 body 正是为了不消费掉原始流，好让调用方（api() 或场景③④）之后还能对同一个 res 读一次
// body。这里把这条契约做成硬性检查而不是摆设——不用 clone() 直接 res.text() 两次的话，第二次
// 会抛错，和真浏览器一致。
function jsonResponse(status, bodyObj, headers = {}) {
  let consumed = false;
  const bodyText = JSON.stringify(bodyObj);
  const self = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[String(name).toLowerCase()] ?? null },
    async text() {
      if (consumed) throw new Error('body stream already read (call .clone() first)');
      consumed = true;
      return bodyText;
    },
    async json() {
      if (consumed) throw new Error('body stream already read (call .clone() first)');
      consumed = true;
      return JSON.parse(bodyText);
    },
    clone() { return jsonResponse(status, bodyObj, headers); },
  };
  return self;
}

const STALE = 'stale-token-from-before-restart';
const FRESH = 'fresh-token-after-bootstrap';

function backendWithRestart() {
  const calls = { missions: [], bootstrap: 0 };
  const fetchImpl = async (url, options) => {
    const u = String(url);
    if (u.startsWith('/api/bootstrap')) {
      calls.bootstrap += 1;
      return jsonResponse(200, { ok: true, token: FRESH });
    }
    if (u.startsWith('/api/missions')) {
      const tok = options && options.headers && options.headers['x-wcw-token'];
      calls.missions.push(tok);
      if (tok === FRESH) return jsonResponse(200, { ok: true, missions: [{ sessionId: 's1' }] }, { etag: 'W/"1"' });
      return jsonResponse(403, { ok: false, error: { code: 'auth.token_invalid' } });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return { calls, fetchImpl };
}

(async () => {

// ── 场景①：apiRaw() 在 403 auth.token_invalid 后换新 token 重放并成功（steward-board.js:loadMissions
//    换成 apiRaw 之后真正吃到的自愈能力）──────────────────────────────────────────────────
{
  const { calls, fetchImpl } = backendWithRestart();
  global.sessionStorage = makeSessionStorage({ 'wcw.token': STALE });
  delete global.document;
  global.fetch = fetchImpl;
  const net = await freshNet();
  const res = await net.apiRaw('/api/missions?limit=200', { headers: {} });
  ok(res.ok === true && res.status === 200, '① apiRaw() 403 auth.token_invalid 后换新 token 重放，拿到 200');
  ok(calls.missions.length === 2 && calls.missions[0] === STALE && calls.missions[1] === FRESH,
    '① 恰好重放一次：第一次带旧 token(403)，第二次带 initToken(true) 换回来的新 token(200)');
  ok(calls.bootstrap === 1, '① 只在 403 之后握手一次换新 token，不会每次请求都重新 bootstrap');
  const payload = await res.json();
  ok(Array.isArray(payload.missions) && payload.missions[0].sessionId === 's1',
    '① apiRaw() 返回未消费的原始 Response，调用方自己 res.json() 仍能拿到重放后的真实数据（steward-board.js 的 304/etag 判断就是这样接的）');
}

// ── 场景②反向验证：同样的假后端下，旧写法（裸 fetch，无重放）必然吃 403 不会自愈 ────────────
// 证明场景①的 PASS 不是断言写錯了导致的假绿——真把「重放那段」拿掉（这里直接复现 117q-B3a 之前
// steward-board.js:159 的裸 fetch 原样写法），同一个假 403 场景下就是红的。
{
  const { calls, fetchImpl } = backendWithRestart();
  global.sessionStorage = makeSessionStorage({ 'wcw.token': STALE });
  delete global.document;
  global.fetch = fetchImpl;
  // 117q-B3a 之前 steward-board.js:159 的原样写法：authHeaders() 拼头 + 裸 fetch，无 403 判定。
  const legacyHeaders = { 'content-type': 'application/json', 'x-wcw-token': STALE };
  const legacyRes = await global.fetch('/api/missions?limit=200', { headers: legacyHeaders });
  ok(legacyRes.ok === false && legacyRes.status === 403,
    '②反向验证：旧写法(裸 fetch，无重放)在同样的假 403 场景下确实吃不到自愈');
  ok(calls.missions.length === 1 && calls.bootstrap === 0,
    '②反向验证：旧写法只发了一次请求，从没换过 token 重试——这正是 30 号文 §4.6 描述的「一直空转到用户手动刷新页面」');
}

// ── 场景③：api() 复用 apiRaw 之后，45+ 处既有调用点的「成功路径直接拿 JSON」行为逐字节不变 ──
{
  global.sessionStorage = makeSessionStorage({ 'wcw.token': FRESH });
  delete global.document;
  global.fetch = async url => {
    if (String(url).startsWith('/api/steward/arbiter')) return jsonResponse(200, { ok: true, maxParallel: 3 });
    throw new Error('unexpected fetch: ' + url);
  };
  const net = await freshNet();
  const payload = await net.api('/api/steward/arbiter');
  ok(payload && payload.ok === true && payload.maxParallel === 3,
    '③ api() 复用 apiRaw 之后，200 成功路径仍然直接返回解析好的 JSON（既有 45+ 调用点无感知）');
}

// ── 场景④：api() 在 403 场景下也换 token 重放（不是只有 apiRaw 会，api() 自己复用的那份也要会）
{
  const { calls, fetchImpl } = backendWithRestart();
  global.sessionStorage = makeSessionStorage({ 'wcw.token': STALE });
  delete global.document;
  global.fetch = fetchImpl;
  const net = await freshNet();
  const payload = await net.api('/api/missions?limit=200');
  ok(payload && payload.ok === true && Array.isArray(payload.missions),
    '④ api() 自己也换新 token 重放并成功（api() = apiRaw() + .json()，不是另一份逻辑）');
  ok(calls.missions.length === 2 && calls.bootstrap === 1, '④ api() 的重放次数与 apiRaw() 场景①一致，没有重复重放');
}

// ── 场景⑤：非 403/token_invalid 的普通错误，api() 仍然直接抛错（不会被新逻辑误重放/吞掉）───
{
  global.sessionStorage = makeSessionStorage({ 'wcw.token': FRESH });
  delete global.document;
  let calls = 0;
  global.fetch = async () => { calls += 1; return jsonResponse(404, { ok: false, error: 'not found' }); };
  const net = await freshNet();
  let threw = null;
  try { await net.api('/api/missions?limit=200'); } catch (error) { threw = error; }
  ok(threw instanceof Error && /not found/.test(threw.message), '⑤ 普通 404 错误 api() 仍然直接抛错(消息取自响应体)，不会被误判成 token 失效');
  ok(calls === 1, '⑤ 普通错误零重放，只发一次请求（apiRaw() 内部靠 clone() 探测 body，不会因为读了一次 body 就导致后续 api() 读不到）');
}

console.log(fail ? `\nNET TOKEN REPLAY E2E: FAIL (${fail})` : '\nNET TOKEN REPLAY E2E: ALL PASS');
process.exitCode = fail ? 1 : 0;

})().catch(error => {
  console.error('NET TOKEN REPLAY E2E: FAIL (exception)');
  console.error((error && error.stack) || error);
  process.exitCode = 1;
});

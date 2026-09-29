// Unit(perf · 前端条件 GET):public/js/net.js 的 api.conditional(path) —— 给轮询用(session-experience 的
// refreshLiveTurn、steward-drawer 的 loadThreadSlice)。服务端在 GET /api/sessions/:id 上给 ETag、没变回 304(不装载会话),
// 前端按 path 记住最近一次 ETag + 已解析响应,304 时直接回那份(顶层浅拷贝 + notModified:true)。这里换掉 globalThis.fetch,
// 断言的是「发了什么头、拿到什么」,不依赖真服务:
//   [N1] 首发不带 If-None-Match;拿到 ETag 后第二发带上;304 → 回记住的那份(session 同一引用、notModified:true,缓存本体不被写脏);
//   [N2] 200 换新 ETag 就换掉记住的那份;服务端不给 ETag → 不记(下一发不带头,与无条件 api() 行为一致);
//   [N3] 非 2xx 抛错的形状与 api() 相同(status/path/正文),并丢掉这个 path 的记忆;
//   [N4] 只记最近 2 个 path(一份大会话的解析结果动辄几十 MB,不许随浏览过的会话无界增长);
//   [N5] 不带 conditional 的普通 api() 永远不发 If-None-Match(其余 45+ 个调用点的行为不变)。
'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { describe, it, beforeEach, after } = require('node:test');

const NET = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/net.js')).href;
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

let calls = [];
let script = [];   // 每发 fetch 弹一条:{ status, etag, body }
function installFetch() {
  calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    const step = script.shift();
    assert.ok(step, '脚本用完了还在 fetch:' + url);
    const headers = { 'content-type': 'application/json' };
    if (step.etag) headers.etag = step.etag;
    if (step.status === 304) return new Response(null, { status: 304, headers });
    return new Response(JSON.stringify(step.body === undefined ? { ok: true } : step.body), { status: step.status || 200, headers });
  };
}
const inm = call => call.headers['if-none-match'];

describe('api.conditional(path)', () => {
  let net;
  beforeEach(async () => {
    net = await import(NET);
    net.resetConditionalApiCache();
    script = [];
    installFetch();
  });

  it('[N1] 首发不带头;有 ETag 后带上;304 回记住的那份(notModified:true,缓存本体不被写脏)', async () => {
    const body = { ok: true, session: { id: 's1', messages: [{ role: 'user', content: 'hi' }] }, resumable: { live: true } };
    script.push({ etag: 'W/"session-aaa"', body }, { status: 304, etag: 'W/"session-aaa"' }, { status: 304, etag: 'W/"session-aaa"' });
    const r1 = await net.api.conditional('/api/sessions/s1');
    assert.strictEqual(inm(calls[0]), undefined, '首发没有记忆,不带 If-None-Match');
    assert.strictEqual(r1.notModified, undefined);
    const r2 = await net.api.conditional('/api/sessions/s1');
    assert.strictEqual(inm(calls[1]), 'W/"session-aaa"');
    assert.strictEqual(r2.notModified, true);
    assert.strictEqual(r2.session, r1.session, '304 回的 session 是上一次那个引用(内容逐字相同)');
    assert.deepStrictEqual(r2.resumable, { live: true });
    assert.strictEqual(r1.notModified, undefined, '标记只在拷贝上,首发拿到的对象没被写脏');
    const r3 = await net.api.conditional('/api/sessions/s1');
    assert.strictEqual(r3.notModified, true);
    assert.strictEqual(inm(calls[2]), 'W/"session-aaa"');
    assert.strictEqual(calls[1].headers['x-wcw-token'] !== undefined, true, '鉴权头照旧带着(走的是 apiRaw)');
  });

  it('[N2] 200 换新 ETag 就换掉记住的那份;服务端不给 ETag 就不记', async () => {
    script.push(
      { etag: 'E1', body: { ok: true, v: 1 } },
      { etag: 'E2', body: { ok: true, v: 2 } },
      { status: 304, etag: 'E2' },
      { body: { ok: true, v: 3 } },          // 没有 etag
      { body: { ok: true, v: 4 } },
    );
    await net.api.conditional('/api/x');
    const b = await net.api.conditional('/api/x');
    assert.strictEqual(inm(calls[1]), 'E1');
    assert.strictEqual(b.v, 2);
    const c = await net.api.conditional('/api/x');
    assert.strictEqual(inm(calls[2]), 'E2', '带的是最新那个标签');
    assert.strictEqual(c.notModified, true);
    assert.strictEqual(c.v, 2, '304 回的是最新那份,不是更早的');
    const d = await net.api.conditional('/api/x');     // 服务端这一发没给 etag:记忆被清
    assert.strictEqual(inm(calls[3]), 'E2');
    assert.strictEqual(d.v, 3);
    await net.api.conditional('/api/x');
    assert.strictEqual(inm(calls[4]), undefined, '上一发没有 ETag → 不记 → 这一发不带头(与无条件 api() 一致)');
  });

  it('[N3] 非 2xx 抛错(形状同 api())并丢掉这个 path 的记忆', async () => {
    script.push({ etag: 'E1', body: { ok: true } }, { status: 404, body: { ok: false, error: 'gone' } }, { etag: 'E9', body: { ok: true } });
    await net.api.conditional('/api/y');
    let err = null;
    try { await net.api.conditional('/api/y'); } catch (e) { err = e; }
    assert.ok(err, '404 应当抛错');
    assert.strictEqual(err.status, 404);
    assert.strictEqual(err.path, '/api/y');
    assert.match(err.message, /gone/);
    await net.api.conditional('/api/y');
    assert.strictEqual(inm(calls[2]), undefined, '出过错的 path 不再带旧标签');
  });

  it('[N4] 只记最近 2 个 path', async () => {
    script.push(
      { etag: 'A1', body: { ok: true, p: 'a' } }, { etag: 'B1', body: { ok: true, p: 'b' } }, { etag: 'C1', body: { ok: true, p: 'c' } },
      { etag: 'A2', body: { ok: true, p: 'a2' } }, { status: 304, etag: 'C1' }, { etag: 'B2', body: { ok: true, p: 'b2' } },
    );
    await net.api.conditional('/a');
    await net.api.conditional('/b');
    await net.api.conditional('/c');    // 挤掉最老的 /a
    await net.api.conditional('/a');
    assert.strictEqual(inm(calls[3]), undefined, '/a 被挤出去了 → 不带头');
    // 现在记的是 /c 与 /a;/b 被 /a 挤掉
    const c = await net.api.conditional('/c');
    assert.strictEqual(inm(calls[4]), 'C1');
    assert.strictEqual(c.notModified, true);
    const b = await net.api.conditional('/b');
    assert.strictEqual(inm(calls[5]), undefined, '/b 已被挤掉 → 不带头');
    assert.strictEqual(b.p, 'b2');
  });

  it('[N5] 普通 api() 永远不发 If-None-Match', async () => {
    script.push({ etag: 'E1', body: { ok: true } }, { etag: 'E1', body: { ok: true } }, { etag: 'E1', body: { ok: true } });
    await net.api.conditional('/api/z');
    await net.api('/api/z');
    await net.api('/api/z', { method: 'GET' });
    assert.strictEqual(inm(calls[1]), undefined);
    assert.strictEqual(inm(calls[2]), undefined);
  });
});

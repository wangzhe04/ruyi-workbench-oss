#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// E2E：静态资产「每次确认、没变不重传」（体验走查 #22 启动开销）。
//
// 修前静态资产一律 cache-control: no-store —— 为的是 overlay 换包即时生效；代价是每次打开页面 60 多个脚本模块
// 全量重传（约 2.3 MB），而且 Chromium/WebView2 不给 no-store 的脚本做字节码缓存，低配机冷启动每次都重新编译。
// 现在：no-cache ＋ 内容哈希 ETag —— 浏览器每次仍来问一遍（换包即生效，语义不变），没变回 304。
//   S1 脚本／样式带 ETag 与 cache-control: no-cache（不是 no-store，也不是 max-age：不许不问就用旧的）；
//   S2 带着这个 ETag 再取 → 304、空正文；
//   S3 带一个旧 ETag → 200 ＋ 全量正文（换包之后就是这一路）；
//   S4 内容不同的两个文件 ETag 不同（按内容算，不按大小/时间）；
//   S5 index.html 照旧 no-store、不带 ETag（它每次注入的东西不同，也不该被缓存）。
// 判定行：`STATIC REVALIDATE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const { killOwnTree } = require('./lib/kill-own-tree');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', timeout: 5000, headers: { Host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const PORT = await getFreePort();
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-static-revalidate-'));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await sleep(150); up = await get(PORT, '/health').then(r => r.status === 200).catch(() => false); }
    ok(up, 'S0 工作台起来了');
    const js = await get(PORT, '/app.js');
    const css = await get(PORT, '/styles.css').catch(() => null);
    const etag = String(js.headers.etag || '');
    ok(js.status === 200 && /^"[^"]+"$/.test(etag) && js.headers['cache-control'] === 'no-cache' && js.body.length > 1000,
      `S1 /app.js 带 ETag 与 cache-control: no-cache（实测 ${js.status} ${JSON.stringify({ etag, cc: js.headers['cache-control'] })}）`);
    const again = await get(PORT, '/app.js', { 'If-None-Match': etag });
    ok(again.status === 304 && again.body.length === 0, `S2 带着 ETag 再取 → 304 空正文（实测 ${again.status}，${again.body.length} 字节）`);
    const stale = await get(PORT, '/app.js', { 'If-None-Match': '"stale-etag-from-an-older-build"' });
    ok(stale.status === 200 && stale.body.equals(js.body), `S3 带旧 ETag → 200 ＋ 全量正文（实测 ${stale.status}）`);
    const other = await get(PORT, '/js/util.js');
    ok(other.status === 200 && other.headers.etag && other.headers.etag !== etag, 'S4 内容不同的文件 ETag 不同');
    ok(!css || css.status !== 200 || css.headers['cache-control'] === 'no-cache', `S4b 样式同一套（实测 ${css && css.status} ${css && css.headers['cache-control']}）`);
    const html = await get(PORT, '/');
    ok(html.status === 200 && html.headers['cache-control'] === 'no-store' && !html.headers.etag,
      `S5 index.html 照旧 no-store、不带 ETag（实测 ${JSON.stringify({ cc: html.headers['cache-control'], etag: html.headers.etag || '' })}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    try { killOwnTree(wb); } catch { /* already gone */ }
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log('\nSTATIC REVALIDATE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();

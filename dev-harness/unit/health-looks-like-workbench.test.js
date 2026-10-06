'use strict';
// 走查 W1 #11:freeStalePort 判「占着端口的是不是陈旧工作台」的 /health 口径。
// 修前 `health.app === APP_NAME || health.overlayId || health.version`,而 /health 的回包从不带 app,
// 于是退化成「有 version 字段就算」—— 本机别的服务(任何在 /health 回 {version:…} 的)占了端口会被当成工作台杀掉。
// 判据函数 healthLooksLikeWorkbench 是 13-http-router 里的纯函数(没有导出:导出面只减不增),这里按源码切片取出来在运行时调。
//   [H1] 工作台自己的 /health 形状(带 app / overlayId)认得;
//   [H2] 旧版工作台(无 app):version + launchMode + uptimeSec 三件套认得;
//   [H3] 别的服务:只有 version、{ok:true}、{status:'UP', version}、非对象、null 一律不认;
//   [H4] /health 现在真的带 app 字段(与 APP_NAME 同值),这样新版互认走第一条,不靠回退口径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { functionBlock, constBlock } = require('../lib/source-slice');

const srcDir = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const router = fs.readFileSync(path.join(srcDir, '13-http-router.js'), 'utf8');
const boot = fs.readFileSync(path.join(srcDir, '00-boot.js'), 'utf8');
const appNameDecl = constBlock(boot, 'APP_NAME');
const APP_NAME = new Function(appNameDecl + '; return APP_NAME;')();
const fnSrc = functionBlock(router, 'healthLooksLikeWorkbench');
assert.ok(fnSrc.length > 100, '切到了 healthLooksLikeWorkbench');
const healthLooksLikeWorkbench = new Function('APP_NAME', fnSrc + '; return healthLooksLikeWorkbench;')(APP_NAME);

test('[H1] 工作台自己的 /health 形状认得', () => {
  assert.equal(healthLooksLikeWorkbench({ ok: true, app: APP_NAME, version: '3.0.0', overlayId: 'abc', launchMode: 'serve', uptimeSec: 5 }), true);
  assert.equal(healthLooksLikeWorkbench({ app: APP_NAME }), true);
  assert.equal(healthLooksLikeWorkbench({ overlayId: 'ov-1' }), true, '每进程一个的重启证明');
});

test('[H2] 旧版工作台(无 app / 无 overlayId):version + launchMode + uptimeSec 三件套认得', () => {
  assert.equal(healthLooksLikeWorkbench({ ok: true, version: '1.9.0', launchMode: 'serve', uptimeSec: 12 }), true);
});

test('[H3] 别的服务不认:只有 version 不再够', () => {
  assert.equal(healthLooksLikeWorkbench({ version: '1.2.3' }), false, '修前 health.version 就算 → 误杀');
  assert.equal(healthLooksLikeWorkbench({ ok: true, version: '9.9.9' }), false);
  assert.equal(healthLooksLikeWorkbench({ status: 'UP', version: '2.0', uptimeSec: 100 }), false, '缺 launchMode');
  assert.equal(healthLooksLikeWorkbench({ version: '1', launchMode: 'x' }), false, '缺 uptimeSec');
  assert.equal(healthLooksLikeWorkbench({ app: 'someone-else', ok: true }), false);
  assert.equal(healthLooksLikeWorkbench({ overlayId: '' }), false);
  assert.equal(healthLooksLikeWorkbench(null), false);
  assert.equal(healthLooksLikeWorkbench('ok'), false);
  assert.equal(healthLooksLikeWorkbench(42), false);
});

test('[H4] /health 的回包带 app: APP_NAME', () => {
  const healthRoute = router.slice(router.indexOf("u.pathname === '/health'"), router.indexOf("u.pathname === '/health'") + 600);
  assert.match(healthRoute, /app: APP_NAME/, '新版 /health 带 app 字段');
  assert.match(healthRoute, /overlayId: OVERLAY_ID/);
});

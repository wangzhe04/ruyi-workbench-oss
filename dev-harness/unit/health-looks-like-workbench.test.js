'use strict';
// 走查 W1 #11:/health 的回包形状。
// 3.1 精简:原 [H1]–[H3] 钉的是端口接管链里的判据函数 healthLooksLikeWorkbench —— 那条链(freeStalePort)
// 自 62 号所有权闸起已无调用点,随函数一起删除;启动时端口被占只顺延,不结束任何进程。
//   [H4] /health 仍然带 app 字段(与 APP_NAME 同值)与每进程一个的 overlayId,供外部识别本实例。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const srcDir = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const router = fs.readFileSync(path.join(srcDir, '13-http-router.js'), 'utf8');

test('[H4] /health 的回包带 app: APP_NAME', () => {
  const healthRoute = router.slice(router.indexOf("u.pathname === '/health'"), router.indexOf("u.pathname === '/health'") + 600);
  assert.match(healthRoute, /app: APP_NAME/, '新版 /health 带 app 字段');
  assert.match(healthRoute, /overlayId: OVERLAY_ID/);
});

'use strict';
// e2e 预加载件(经 NODE_OPTIONS=--require 注入被测服务进程):给 fs.promises.open 打个计数钩子。
// 命中 *.messages.ndjson 的每一次打开,往 $RUYI_OPEN_LOG 追加一行路径。用途:不改产品代码、不靠计时,
// 确定性地数「某个文件被读了几遍」(store-walkthrough-w1.e2e.js 用它钉会话搜索索引的单飞)。
// 没设 RUYI_OPEN_LOG 时零动作。
const fs = require('fs');
const fsp = require('fs/promises');

const log = process.env.RUYI_OPEN_LOG;
if (log) {
  const realOpen = fsp.open;
  fsp.open = function patchedOpen(p, ...rest) {
    try { if (/\.messages\.ndjson$/.test(String(p))) fs.appendFileSync(log, String(p) + '\n'); } catch { /* 计数是旁路 */ }
    return realOpen.call(this, p, ...rest);
  };
}

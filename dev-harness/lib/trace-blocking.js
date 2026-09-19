'use strict';
// 128f(mission-index-scale (e)/(f) 冷路径门第三次红之后装的取证件):服务子进程用 --require 预载它,
// 预载(--require):记下谁在阻塞事件循环。① 同步起子进程(spawnSync/execFileSync/execSync)>50 ms 的,带 8 层栈;
// ② 事件循环停顿 >200 ms 的(20 ms 一拍的计时器,实际间隔减去 20)。写到 TRACE_BLOCKING_OUT 指的文件(每进程一行一条)。
const fs = require('fs');
const cp = require('child_process');
const out = process.env.TRACE_BLOCKING_OUT;
if (out && /server\.js/.test(process.argv.join(' '))) {
  const t0 = Date.now();
  const log = row => { try { fs.appendFileSync(out, JSON.stringify({ pid: process.pid, t: Date.now() - t0, ...row }) + '\n'); } catch { /* ignore */ } };
  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
    const orig = cp[name];
    cp[name] = function (...args) {
      const started = Date.now();
      try { return orig.apply(this, args); } finally {
        const ms = Date.now() - started;
        if (ms > 50) log({ kind: name, ms, cmd: String(args[0]).slice(0, 120), argv: Array.isArray(args[1]) ? args[1].slice(0, 4).map(String).map(s => s.slice(0, 60)) : [], stack: String(new Error().stack).split('\n').slice(2, 10).map(s => s.trim()) });
      }
    };
  }
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 20;
    if (lag > 200) log({ kind: 'loop-stall', ms: lag });
    last = now;
  }, 20);
  timer.unref();
}

'use strict';
// 128i(48 号文 §1):产品侧收尸只认自己的子孙。真源码(server.js)、临时 HOME。
// 产品里 14 处 killChildTree 与 freeStalePort 修前都是 `taskkill /T`:按父号认子孙,父号过期撞号时会带走别人的树
// —— 在用户的机器上。判据写在 04 的一段 PowerShell 里(唯一实现,分离启动、服务退出时也能跑完);这里钉:
//   [P1] dry 模式喂合成进程表:撞号的陌生人(比父亲还老)及其孩子不在计划里;真子孙含孙辈都在;conhost 不在;
//        根最先、深的先杀。—— 真机上逼不出撞号,只能这样钉「同一段代码」的判据。
//   [P2] dry 模式:根不在表里 ⇒ ROOT-GONE,什么都不杀。
//   [R1] 真进程 killOwnProcessTree:根 ＋ detached 孙子(逃出 libuv 的 job、不会随根一起死)都被收掉。
//   [R2] 真进程 killChildTree(发出去就算的旧调用形状):同上,几秒内都没了。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-kill-tree-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { snapshotProcessTable } = require(path.join(__dirname, '..', 'lib', 'kill-own-tree.js'));
const alive = pid => { const t = snapshotProcessTable(); return Boolean(t && t.some(r => r.pid === pid)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const win = process.platform === 'win32';

test('[P1] dry:撞号的陌生人不算子孙,conhost 不杀,根最先、深的先杀', { skip: !win }, async () => {
  const table = [
    { ProcessId: 100, ParentProcessId: 4, Created: 1000, Name: 'node.exe' },     // 根
    { ProcessId: 101, ParentProcessId: 100, Created: 1100, Name: 'cmd.exe' },    // 子
    { ProcessId: 102, ParentProcessId: 101, Created: 1200, Name: 'python.exe' }, // 孙
    { ProcessId: 103, ParentProcessId: 100, Created: 1150, Name: 'conhost.exe' },
    { ProcessId: 900, ParentProcessId: 100, Created: 500, Name: 'explorer.exe' }, // 撞号的陌生人:比根还老
    { ProcessId: 901, ParentProcessId: 900, Created: 600, Name: 'wps.exe' },
  ];
  const { lines } = await srv.killOwnProcessTree(100, { dry: true, table });
  const plan = lines.filter(l => l.startsWith('PLAN ')).map(l => Number(l.slice(5)));
  assert.deepEqual(plan, [100, 102, 101], `计划 ${JSON.stringify(lines)}`);
});

test('[P2] dry:根不在表里 ⇒ 什么都不杀', { skip: !win }, async () => {
  const { lines } = await srv.killOwnProcessTree(555, { dry: true, table: [{ ProcessId: 1, ParentProcessId: 0, Created: 1, Name: 'x' }] });
  assert.deepEqual(lines, ['ROOT-GONE']);
});

async function rootWithDetachedGrandchild() {
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true,windowsHide:true});console.log(c.pid);setInterval(()=>{},1000);";
  const rootProc = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const grandPid = await new Promise((resolve, reject) => {
    let buf = '';
    rootProc.stdout.on('data', d => { buf += d; const m = /(\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
    setTimeout(() => reject(new Error('grandchild pid not reported')), 10000);
  });
  return { rootProc, grandPid };
}

test('[R1] 真进程 killOwnProcessTree:根与 detached 孙子都收掉', { skip: !win }, async () => {
  const { rootProc, grandPid } = await rootWithDetachedGrandchild();
  assert.ok(alive(grandPid), '前提:孙子在跑');
  const { lines } = await srv.killOwnProcessTree(rootProc.pid);
  assert.ok(lines.includes('KILLED ' + rootProc.pid), `根被杀 ${JSON.stringify(lines)}`);
  assert.ok(lines.includes('KILLED ' + grandPid), `孙子被杀 ${JSON.stringify(lines)}`);
  await sleep(300);
  assert.equal(alive(grandPid), false);
});

test('[R2] 真进程 killChildTree(发出去就算):几秒内根与 detached 孙子都没了', { skip: !win }, async () => {
  const { rootProc, grandPid } = await rootWithDetachedGrandchild();
  srv.killChildTree(rootProc.pid);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await sleep(250); gone = !alive(grandPid) && !alive(rootProc.pid); }
  assert.ok(gone, '根与孙子都没了');
});

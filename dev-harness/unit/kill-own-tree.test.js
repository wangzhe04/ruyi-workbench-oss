'use strict';
// 128c(48 号文 §1):测试收尾「只杀自己的树」。F8 真实误杀过用户的 Ollama(按父进程号认子孙、号被复用);
// taskkill /T 是否核对创建时间未能取证(3 万次 spawn 逼不出撞号),所以 lib/kill-own-tree.js 不赌它 ——
// 这里钉住它的三条判据:
//   [P1] 纯函数:父号过期、恰好撞号的陌生进程(创建得比「父亲」还早)不算子孙,连同它自己的子孙一起排除;
//        真子孙(含孙辈)一个不漏。这是「撞号」这个无法在真机上按需复现的形状,只能用合成进程表钉。
//   [P2] 快照解析:只收 pid,ppid,filetime 三段整数的行,杂行忽略;FILETIME 用 BigInt 不丢精度。
//   [R1] 真进程:根 ＋ 根拉起的孙子,一次 killOwnTree 两个都没了。
//   [R2] 真进程:根已经退出 ⇒ 不碰(它的号可能已经是别人的),返回 skipped:'root-exited'。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');
const { killOwnTree, ownDescendants, parseProcessTable, snapshotProcessTable } = require(path.join(__dirname, '..', 'lib', 'kill-own-tree.js'));

test('[P1] 撞号的陌生进程(比父亲还老)不算子孙;真子孙一个不漏', () => {
  const t = [
    { pid: 100, ppid: 4, created: 1000n },   // 根:我们的测试服务
    { pid: 101, ppid: 100, created: 1100n },  // 它的子进程(MCP 之类)
    { pid: 102, ppid: 101, created: 1200n },  // 孙辈
    { pid: 900, ppid: 100, created: 500n },   // 陌生人:它的父进程早死了,那个号恰好被我们的根复用 —— 比根还老
    { pid: 901, ppid: 900, created: 600n },   // 陌生人自己的孩子
    { pid: 5, ppid: 4, created: 10n },
  ];
  const { root, descendants } = ownDescendants(t, 100);
  assert.equal(root.pid, 100);
  assert.deepEqual(descendants.map(d => d.pid), [101, 102]);
  assert.equal(ownDescendants(t, 12345).root, null, '根不在表里 ⇒ 一个都不认');
});

test('[P2] 快照解析', () => {
  const rows = parseProcessTable('garbage\r\n100,4,133734000000000000\r\n\r\n 101,100,133734000000000001 \r\nx,y,z\r\n');
  assert.deepEqual(rows.map(r => r.pid), [100, 101]);
  assert.equal(rows[1].created - rows[0].created, 1n, 'FILETIME 精度没丢');
});

const alive = pid => { const t = snapshotProcessTable(); return Boolean(t && t.some(r => r.pid === pid)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 根是一个 node,它再 spawn 一个长跑的 node(孙子),把孙子的 pid 打到 stdout。
async function rootWithGrandchild(detached) {
  const opts = detached ? "{stdio:'ignore',detached:true,windowsHide:true}" : "{stdio:'ignore',windowsHide:true}";
  const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],${opts});console.log(c.pid);setInterval(()=>{},1000);`;
  const root = cp.spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const grandPid = await new Promise((resolve, reject) => {
    let buf = '';
    root.stdout.on('data', d => { buf += d; const m = /(\d+)/.exec(buf); if (m) resolve(Number(m[1])); });
    setTimeout(() => reject(new Error('grandchild pid not reported')), 10000);
  });
  return { root, grandPid };
}

// libuv 把非 detached 的子进程放进一个「句柄关闭即杀」的 job ⇒ 根一死它们就跟着没了(128c 取证时撞见的:
// 修前以为是 /T 杀的)。真正需要按树去收的是逃出这个 job 的:detached 的、以及非 node 父进程拉起的(cmd start、python)。
test('[R1] 真进程:detached 的孙子不会随根一起死,由树遍历收掉', { skip: process.platform !== 'win32' }, async () => {
  const { root, grandPid } = await rootWithGrandchild(true);
  assert.ok(alive(grandPid), '前提:孙子在跑');
  const res = killOwnTree(root);
  assert.ok(res.killed.includes(root.pid), `根被杀(${JSON.stringify(res)})`);
  assert.ok(res.killed.includes(grandPid), `detached 孙子由树遍历杀掉(${JSON.stringify(res)})`);
  await sleep(300);
  assert.equal(alive(grandPid), false, '孙子确实没了');
});

test('[R1b] 真进程:普通(非 detached)孙子随根一起走(libuv job),收尾后同样不留', { skip: process.platform !== 'win32' }, async () => {
  const { root, grandPid } = await rootWithGrandchild(false);
  assert.ok(alive(grandPid), '前提:孙子在跑');
  killOwnTree(root);
  await sleep(300);
  assert.equal(alive(grandPid), false, '孙子没了');
});

test('[R2] 根已退出 ⇒ 不碰', async () => {
  const root = cp.spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
  await new Promise(r => root.once('exit', r));
  const res = killOwnTree(root);
  assert.equal(res.skipped, 'root-exited');
  assert.deepEqual(res.killed, []);
});

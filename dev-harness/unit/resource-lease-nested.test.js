'use strict';
// 资源租约(06g)的两处走查缺陷。真源码、临时 HOME,租约原语直调(不起服务、不要 provider)。
//
//   [L1] 嵌套请求死锁:节点级声明与它名下的工具级请求用同一个组名。修前,持有租约的组 A 自己的工具级请求
//        会排在「正等着 A 释放」的别的组 B 后面(queuedAhead 没排除同组、wouldDeadlock 又只给持有者建边):
//        A 等 B、B 等 A,既不报 RESOURCE_DEADLOCK 也不超时(节点级租约不带超时,工具级默认 30 分钟)。
//        现在握着租约的组不排队,只被真正的持有者挡住;drain 侧同理(握着租约的等待者不排在更早的等待者后面)。
//        同时钉住公平性没被带坏:手里没有租约的组仍然排队,读者不抢先于已在排队的写者。
//   [L2] 传进来的 signal 已经 aborted:修前 addEventListener('abort') 不会再触发,请求无限期挂在队里
//        (而且挡住后来的人)。现在入队前先判,直接以 AbortError 拒。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-lease-nested-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { acquireResourceLease, releaseResourceLease, normalizeAgentResources } = srv;

const cwd = path.join(root, 'proj');
const res = (...raw) => normalizeAgentResources(raw, cwd);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 给一个 promise 贴「是否已落定」的旗;不吞拒绝(拒绝记在 .error 上)。
function track(promise) {
  const state = { settled: false, token: '', error: null };
  state.done = promise.then(token => { state.settled = true; state.token = token; return token; }, error => { state.settled = true; state.error = error; return ''; });
  return state;
}
const NO_TIMEOUT = 0;   // 租约超时设为「永远等」,死锁不能靠超时兜住 —— 要靠不排到不该排的队后面

test('[L1a] 节点持有 workspace 租约、别的组在等它:节点自己 workspace 下的工具级请求立刻拿到,不排在那个等待者后面', async () => {
  const nodeA = await acquireResourceLease('runX:A', res('workspace:' + cwd), null, null, NO_TIMEOUT);
  assert.ok(nodeA, 'A 的节点级租约拿到');
  const b = track(acquireResourceLease('runX:B', res('workspace:' + cwd), null, null, NO_TIMEOUT));   // B 被 A 挡住,入队
  await sleep(30);
  assert.equal(b.settled, false, '前提:B 在等 A');
  const tool = track(acquireResourceLease('runX:A', res('file:' + path.join(cwd, 'a.txt')), null, null, NO_TIMEOUT));
  await sleep(100);
  assert.equal(tool.settled, true, '同组的工具级请求不能排在正等着它释放的 B 后面(修前:永远挂着)');
  assert.ok(tool.token && !tool.error, '拿到的是租约不是错误');
  assert.equal(b.settled, false, 'B 仍然在等(A 还握着)');
  releaseResourceLease(tool.token);
  releaseResourceLease(nodeA);
  await Promise.race([b.done, sleep(2000)]);
  assert.equal(b.settled, true, 'A 释放之后 B 照常拿到');
  assert.ok(b.token);
  releaseResourceLease(b.token);
});

test('[L1b] 握着租约的组被真持有者挡住时:更早排队、且正等着本组的等待者,不能把本组卡死在 drain 里', async () => {
  const fileA = path.join(cwd, 'a.txt');
  const fileX = path.join(cwd, 'x.txt');
  const nodeA = await acquireResourceLease('runY:A', res('file:' + fileA), null, null, NO_TIMEOUT);   // A 持 a
  const holderC = await acquireResourceLease('runY:C', res('file:' + fileX), null, null, NO_TIMEOUT); // C 持 x
  // B 要 a 与 x 两样:被 A、C 同时挡住,先入队(排在 A 的工具级请求之前)。
  const b = track(acquireResourceLease('runY:B', res('file:' + fileA, 'file:' + fileX), null, null, NO_TIMEOUT));
  await sleep(30);
  // A 的工具级请求要 x:被 C 真挡住(不是排队挡),入队。B 与它冲突、且更早 —— 但 B 正等着 A,不能让 A 排在 B 后面。
  const aTool = track(acquireResourceLease('runY:A', res('file:' + fileX), null, null, NO_TIMEOUT));
  await sleep(30);
  assert.equal(aTool.settled, false, '前提:A 的工具级请求被 C 挡着');
  assert.equal(b.settled, false, '前提:B 在等');
  releaseResourceLease(holderC);
  await Promise.race([aTool.done, sleep(2000)]);
  assert.equal(aTool.settled, true, 'C 释放后 A 拿到 x(修前:A 排在 B 后面、B 又在等 A,两边永远等)');
  assert.ok(aTool.token && !aTool.error);
  assert.equal(b.settled, false, 'A 还握着 a 与 x,B 继续等');
  releaseResourceLease(aTool.token);
  releaseResourceLease(nodeA);
  await Promise.race([b.done, sleep(2000)]);
  assert.equal(b.settled, true, 'A 全部释放之后 B 拿到');
  releaseResourceLease(b.token);
});

test('[L1c] 公平性没被带坏:手里没有租约的组仍然排队,后来的读者不抢先于已在排队的写者', async () => {
  const shared = path.join(cwd, 'fair.txt');
  const heldReader = await acquireResourceLease('fair-reader-1', res('read:file:' + shared), null, null, NO_TIMEOUT);
  const writer = track(acquireResourceLease('fair-writer', res('file:' + shared), null, null, NO_TIMEOUT));
  const lateReader = track(acquireResourceLease('fair-reader-2', res('read:file:' + shared), null, null, NO_TIMEOUT));
  await sleep(30);
  assert.equal(writer.settled, false);
  assert.equal(lateReader.settled, false, '后来的读者排在写者后面');
  releaseResourceLease(heldReader);
  await Promise.race([writer.done, sleep(2000)]);
  assert.equal(writer.settled, true, '写者先拿到');
  assert.equal(lateReader.settled, false, '读者仍在等写者');
  releaseResourceLease(writer.token);
  await Promise.race([lateReader.done, sleep(2000)]);
  assert.equal(lateReader.settled, true);
  releaseResourceLease(lateReader.token);
});

test('[L1d] 真的等待环照旧被检出(没有因为放宽排队而漏掉 RESOURCE_DEADLOCK)', async () => {
  const rX = res('file:' + path.join(cwd, 'cx.txt'));
  const rY = res('file:' + path.join(cwd, 'cy.txt'));
  const a = await acquireResourceLease('cyc-A', rX, null, null, NO_TIMEOUT);
  const b = await acquireResourceLease('cyc-B', rY, null, null, NO_TIMEOUT);
  const aWantsY = track(acquireResourceLease('cyc-A', rY, null, null, NO_TIMEOUT));   // A 持 x、等 y(B 持)
  await sleep(30);
  await assert.rejects(() => acquireResourceLease('cyc-B', rX, null, null, NO_TIMEOUT), { code: 'RESOURCE_DEADLOCK' });
  releaseResourceLease(b);
  await Promise.race([aWantsY.done, sleep(2000)]);
  assert.equal(aWantsY.settled, true);
  releaseResourceLease(aWantsY.token);
  releaseResourceLease(a);
});

test('[L2] signal 已经 aborted:直接以 AbortError 拒,不留在等待队列里', async () => {
  const rD = res('desktop');
  const holder = await acquireResourceLease('H', rD, null, null, NO_TIMEOUT);
  const ac = new AbortController();
  ac.abort();
  const gone = track(acquireResourceLease('X', rD, ac.signal, null, NO_TIMEOUT));
  await sleep(50);
  assert.equal(gone.settled, true, '修前:永远 pending(监听器挂在一个不会再触发的信号上)');
  assert.equal(gone.error && gone.error.name, 'AbortError');
  // 没有残留的等待者:H 释放后,别的组立刻拿得到桌面租约(修前 X 的幽灵条目会先排在前面挡住它)。
  const another = track(acquireResourceLease('Y', rD, null, null, NO_TIMEOUT));
  await sleep(30);
  assert.equal(another.settled, false, '前提:H 还握着');
  releaseResourceLease(holder);
  await Promise.race([another.done, sleep(2000)]);
  assert.equal(another.settled, true, 'H 释放后 Y 立刻拿到');
  assert.ok(another.token);
  releaseResourceLease(another.token);
  // 没有冲突时已 aborted 的 signal 不影响直接放行(行为不变:只在「要入队」时才判)。
  const free = await acquireResourceLease('Z', res('file:' + path.join(cwd, 'free.txt')), ac.signal, null, NO_TIMEOUT);
  assert.ok(free);
  releaseResourceLease(free);
});

'use strict';
// 走查 W1 #7:磁盘上一个读不成会话的头(截断 / 写坏 / id 与文件名对不上)不再让 listSessions 每次都全量扫盘。
// 修前:快路径比「索引 id 集 == 磁盘 id 集」,坏头永远进不了重建的索引 → 每次判漂移、每次读遍所有头、重建一遍(2000 条 ≈ 240–380 ms),
// 而且永不自愈。现在全量扫描把【确定性判坏】的 id 记进「已知坏头」表,快路径比对时扣掉。
// 用读盘计数(fsp.readFile 对 sessions/sess_*.json 头的调用次数)断言,确定性,不计时:
//   [L1] 承重:一个截断的头 → 第一次全量扫描(读遍头),之后的 listSessions 一个头都不读(走快路径);列表里是其余好会话;
//   [L2] 自愈:坏头被修好(拷回好内容)→ 下一次 listSessions 把它收回来,之后又是快路径;
//   [L3] id 与文件名对不上的头(合法 JSON、不是这个会话)同样被记下,不拖垮快路径;
//   [L4] 读失败(瞬时锁 EBUSY)【不】记坏头:那条好会话不会因此从列表里消失,锁一松下一次就回来;
//   [L5] 坏头被删掉 → 已知坏头表自清,快路径照常。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 计数钩子装在它的属性上
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-list-badhead-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const sessionsDir = path.join(root, 'sessions');

const realReadFile = fsp.readFile;
let headReads = 0;
let failFor = null;   // 要模拟瞬时锁的会话头路径
const isHead = p => { const b = path.basename(String(p)); return /^sess_[A-Za-z0-9_-]+\.json$/.test(b) && path.dirname(String(p)) === sessionsDir; };
fsp.readFile = function patched(p, ...rest) {
  if (isHead(p)) {
    headReads += 1;
    if (failFor && String(p) === failFor) return Promise.reject(Object.assign(new Error('EBUSY: simulated lock'), { code: 'EBUSY' }));
  }
  return realReadFile.call(this, p, ...rest);
};
process.on('exit', () => { fsp.readFile = realReadFile; try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const headPath = id => path.join(sessionsDir, id + '.json');
async function listed() { return (await srv.listSessions()).map(m => m.id).sort(); }
async function settle() { await srv.flushSessionIndex(); await new Promise(r => setTimeout(r, 30)); await srv.flushSessionIndex(); }
async function reads(fn) { headReads = 0; const out = await fn(); return { out, n: headReads }; }

const ids = [];
let goodHead = "";
test('准备:5 条会话,健康时 listSessions 走快路径(0 次读头)', async () => {
  for (let i = 0; i < 5; i++) ids.push((await srv.createSession({ title: 'bh' + i, cwd: root })).id);
  await settle();
  await srv.listSessions();   // 若索引还没建,先建一份
  await settle();
  const { out, n } = await reads(listed);
  assert.deepEqual(out, [...ids].sort());
  assert.equal(n, 0, '健康基线:快路径不读头');
});

test('[L1] 截断的头:第一次全量扫描后,listSessions 回到快路径;列表是其余好会话', async () => {
  const bad = ids[2];
  const good = fs.readFileSync(headPath(bad), 'utf8');
  goodHead = good;
  fs.writeFileSync(headPath(bad), good.slice(0, good.length >> 1));
  await srv.invalidateSessionIndex();
  const first = await reads(listed);
  assert.deepEqual(first.out, ids.filter(id => id !== bad).sort(), '坏头不进列表');
  assert.ok(first.n >= ids.length, '第一次是全量扫描(读遍头)');
  await settle();
  for (let k = 0; k < 3; k++) {
    const again = await reads(listed);
    assert.deepEqual(again.out, ids.filter(id => id !== bad).sort());
    assert.equal(again.n, 0, `第 ${k + 2} 次:修前每次都全量扫盘(读 ${ids.length} 个头),现在走快路径`);
  }
});

test('[L2] 坏头被修好 → 下一次 listSessions 收回来,之后又是快路径', async () => {
  const bad = ids[2];
  fs.writeFileSync(headPath(bad), goodHead);
  const fixed = await reads(listed);
  assert.deepEqual(fixed.out, [...ids].sort(), '修好的会话回到列表');
  assert.ok(fixed.n >= ids.length, '文件戳变了 → 判漂移 → 重扫一遍');
  await settle();
  const after = await reads(listed);
  assert.deepEqual(after.out, [...ids].sort());
  assert.equal(after.n, 0);
});

test('[L3] id 与文件名对不上的头同样被记下,不拖垮快路径', async () => {
  const bad = ids[1];
  const orig = fs.readFileSync(headPath(bad), 'utf8');
  const fake = JSON.parse(orig); fake.id = 'sess_someone_else';
  fs.writeFileSync(headPath(bad), JSON.stringify(fake));
  await srv.invalidateSessionIndex();
  const first = await reads(listed);
  assert.ok(!first.out.includes(bad) && first.out.length === ids.length - 1);
  await settle();
  const again = await reads(listed);
  assert.equal(again.n, 0, '错名的头也不再逼出全量扫描');
  fs.writeFileSync(headPath(bad), orig);   // 还原,供后面的用例
  assert.deepEqual(await listed(), [...ids].sort());
  await settle();
});

test('[L4] 瞬时锁(EBUSY)读失败不记坏头:好会话不会从列表消失,锁松开就回来', async () => {
  const locked = ids[3];
  failFor = headPath(locked);
  await srv.invalidateSessionIndex();
  const during = await reads(listed);
  assert.ok(!during.out.includes(locked), '这一趟确实没读到它');
  await settle();
  failFor = null;
  const after = await listed();
  assert.deepEqual(after, [...ids].sort(), '锁一松,它回到列表(若被误记成坏头,这里会一直缺它)');
  await settle();
  assert.equal((await reads(listed)).n, 0);
});

test('[L5] 坏头被删掉:已知坏头表自清,快路径照常', async () => {
  const bad = ids[4];
  const orig = fs.readFileSync(headPath(bad), 'utf8');
  fs.writeFileSync(headPath(bad), '{ not json');
  await srv.invalidateSessionIndex();
  assert.equal((await listed()).includes(bad), false);
  await settle();
  assert.equal((await reads(listed)).n, 0);
  fs.unlinkSync(headPath(bad));
  const gone = await reads(listed);
  assert.deepEqual(gone.out, ids.filter(id => id !== bad).sort());
  await settle();
  assert.equal((await reads(listed)).n, 0, '文件没了 → 磁盘 id 集本身就对得上');
  fs.writeFileSync(headPath(bad), orig);   // 不留残局
  fs.unlinkSync(headPath(bad));
});

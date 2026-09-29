'use strict';
// Unit(性能批):两条被前端高频轮询的读路径不再每次「全量重算 / 全量重读」。真源码、临时 HOME,断言用
// 确定性计数器与 fs 打点,不看墙钟。
//
//   [A] GET /api/missions 的聚合装配 buildMissionAggregateRows:
//       修前每条线程、每个事项组各算一遍「工作区归属」(stewardRuyiOwnedPath + dataRootAliases,2000 会话约 4000 次/请求);
//       现在一次装配内同一个 cwd 只算一次,别名只取一次。
//       [A1] 一次装配里「真正算归属」的次数 == 不同 cwd 的个数(而不是行数 × 2);
//       [A2] 输出与独立参照(数据根前缀 + 常用工作区表)逐字段一致,线程与事项组各拿【新对象】(改一个不串行);
//       [A3] 记忆只活在一次装配内:配置里那张表一变,下一次装配立刻按新表判(没有跨请求陈旧);
//       [A4] 连续两次装配(输入未变)输出深相等(字节等价:JSON 相同)。
//   [B] GET /api/agent-runs?view=digest 的磁盘摘要 listAgentRunDigests:
//       修前每次轮询把该会话每个 run 快照整份读盘 + JSON.parse 只为取标量;现在按 mtime+size+ino 缓存。
//       [B1] 首次读 N 个文件、第二次零读(用 fsp.readFile 打点,不只信内部计数);
//       [B2] 摘要与「整份读回再取标量」的参照逐字段相同,顺序 = createdAt 降序;
//       [B3] 某个 run 文件被改写(大小变)→ 恰好重读这一份,摘要跟着变;
//       [B4] 经 saveAgentRun 的进程内写入 → 恰好重读这一份(条目被作废,而不是等戳变);
//       [B5] 坏快照跳过、删掉的文件消失、非 run 文件名不进列表 —— 与 listAgentRuns 同口径。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-poll-caches-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, buildMissionAggregateRows, listAgentRunDigests, saveAgentRun, perfCounters } = srv;

// ───────────────────────── [A] 聚合装配 ─────────────────────────
const outsideA = path.join(os.tmpdir(), 'ruyi-poll-caches-outside-a');       // 数据根之外
const outsideB = path.join(os.tmpdir(), 'ruyi-poll-caches-outside-b');
const insideRoot = path.join(root, 'workspaces', 'w1');                       // 数据根之内 => ruyiOwned
const CWDS = [outsideA, outsideA, outsideA, outsideB, outsideB, insideRoot, insideRoot, insideRoot + path.sep];

test('[A] 聚合装配:同一 cwd 一次装配只算一次归属,输出与独立参照一致', async () => {
  const ids = [];
  for (const cwd of CWDS) ids.push((await createSession({ title: 't-' + ids.length, cwd })).id);

  perfCounters.missionAggregate.workspaceComputed = 0;
  const first = await buildMissionAggregateRows({ config: {} });
  const distinct = new Set(CWDS.map(c => c.trim())).size;   // insideRoot 与带尾分隔符的写法是两个不同字符串
  // [A1] 8 条线程 + 8 个事项组(每条会话自成一组)每处都要工作区 = 16 次取值,但只有 distinct 个不同 cwd。
  assert.equal(perfCounters.missionAggregate.workspaceComputed, distinct,
    `一次装配只该算 ${distinct} 次归属,实算 ${perfCounters.missionAggregate.workspaceComputed}`);
  assert.ok(first.rows.length >= CWDS.length, '每条会话至少一行');

  // [A2] 独立参照:在数据根之内 => ruyiOwned,否则(config 里没有常用工作区表)=> false。
  const expectOwned = cwd => cwd.startsWith(root);
  const threads = first.rows.flatMap(row => row.threads);
  assert.equal(threads.length, CWDS.length);
  for (const thread of threads) {
    const ws = thread.workspace;
    assert.ok(ws && ws.path === thread.cwd, '线程工作区 path 即其 cwd');
    assert.equal(ws.name, path.basename(thread.cwd.replace(/[\\/]+$/, '')));
    assert.equal(ws.ruyiOwned, expectOwned(thread.cwd), `${thread.cwd} 的 ruyiOwned`);
  }
  for (const row of first.rows) {
    assert.deepEqual(row.workspace, row.threads[0].workspace, '单线程事项组的工作区 == 那条线程的');
    assert.notEqual(row.workspace, row.threads[0].workspace, '事项组与线程各拿新对象');
  }
  // 同 cwd 的两条线程也不共用同一个对象:改一个不影响另一个。
  const sameCwd = threads.filter(t => t.cwd === outsideA);
  assert.ok(sameCwd.length >= 2 && sameCwd[0].workspace !== sameCwd[1].workspace);
  sameCwd[0].workspace.ruyiOwned = 'mutated';
  assert.equal(sameCwd[1].workspace.ruyiOwned, false);

  // [A4] 输入未变的再一次装配:行内容深相等(工作区、聚合态、stamp 全同)。
  const second = await buildMissionAggregateRows({ config: {} });
  sameCwd[0].workspace.ruyiOwned = false;   // 还原上面故意改坏的那一格,再比
  assert.equal(second.stamp, first.stamp, 'stamp 未变');
  assert.equal(JSON.stringify(second.rows), JSON.stringify(first.rows), '行逐字节相同');

  // [A3] 记忆不跨装配:把 outsideA 登记进常用工作区表(未收编)-> 下一次装配它就是 ruyiOwned。
  perfCounters.missionAggregate.workspaceComputed = 0;
  const flipped = await buildMissionAggregateRows({ config: { stewardManagedWorkspaces: [{ path: outsideA, adopted: false }] } });
  assert.equal(perfCounters.missionAggregate.workspaceComputed, distinct, '新一次装配重新按 cwd 各算一次');
  for (const thread of flipped.rows.flatMap(row => row.threads)) {
    const want = expectOwned(thread.cwd) || thread.cwd === outsideA;
    assert.equal(thread.workspace.ruyiOwned, want, `配置一变 ${thread.cwd} 立刻按新表判`);
  }
  assert.notEqual(flipped.stamp, first.stamp, 'ruyiOwned 进指纹:配置一变 ETag 跟着变');
});

// ───────────────────────── [B] digest 摘要缓存 ─────────────────────────
const SID = 'sess_pollcache01';
const runDir = path.join(root, 'agent-runs', SID);
const runFile = id => path.join(runDir, id + '.json');
const mkRun = (id, i, extra = {}) => ({
  id, sessionId: SID, status: 'succeeded',
  createdAt: new Date(Date.UTC(2026, 8, 1) - i * 3600e3).toISOString(),
  updatedAt: '2026-09-01T00:00:00.000Z', completedAt: '2026-09-01T00:10:00.000Z', eventSeq: 100 + i,
  nodes: [{ id: 'n0', status: 'succeeded', result: 'R'.repeat(2000) }, { id: 'n1', status: 'succeeded', result: 'S'.repeat(2000) }],
  taskPool: [{ id: 'p1', status: 'proposed' }, { id: 'p2', status: 'approved' }],
  ...extra,
});
// 参照:整份读回再按「digest 该有的字段」取标量(与修前 13d 里的表达式同口径)。
function referenceDigests() {
  const runs = [];
  for (const f of fs.readdirSync(runDir).filter(n => /^run_[a-f0-9]+\.json$/i.test(n))) {
    try { const r = JSON.parse(fs.readFileSync(path.join(runDir, f), 'utf8')); if (r) runs.push(r); } catch { /* 坏快照跳过 */ }
  }
  runs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return runs.map(r => ({
    id: r.id, status: r.status, eventSeq: Number(r.eventSeq) || 0,
    updatedAt: r.updatedAt || '', createdAt: r.createdAt || '', completedAt: r.completedAt || '',
    nodeCount: Array.isArray(r.nodes) ? r.nodes.length : 0,
    poolPending: (r.taskPool || []).filter(p => p && p.status === 'proposed').length,
    persistenceDegraded: r.persistenceDegraded === true,
    resumeTier: r.resumeTier || '', pendingReview: !!r.pendingReview,
    anyRunning: Array.isArray(r.nodes) && r.nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
  }));
}
// fsp.readFile 打点:只数 run 快照文件(与被测代码的内部计数互相印证)。
function countRunReads() {
  const orig = fsp.readFile;
  const state = { n: 0, files: [] };
  fsp.readFile = function (p) {
    if (/run_[a-f0-9]+\.json$/i.test(String(p)) && String(p).includes(SID)) { state.n += 1; state.files.push(path.basename(String(p))); }
    return orig.apply(this, arguments);
  };
  state.stop = () => { fsp.readFile = orig; };
  return state;
}
const strip = rows => rows.map(r => ({ ...r }));

test('[B] digest 摘要缓存:未变的 run 文件零读盘,改过的恰好重读一份', async () => {
  fs.mkdirSync(runDir, { recursive: true });
  const ids = ['run_0a1', 'run_0b2', 'run_0c3', 'run_0d4', 'run_0e5', 'run_0f6'];
  ids.forEach((id, i) => fs.writeFileSync(runFile(id), JSON.stringify(mkRun(id, i), null, 2)));
  fs.writeFileSync(path.join(runDir, 'run_0a1.events.ndjson'), '{"seq":1}\n');   // 事件文件不是快照,不进列表
  fs.writeFileSync(path.join(runDir, 'notes.json'), '{}');

  const stats = perfCounters.agentRunDigest;
  // [B1]
  let spy = countRunReads();
  let first;
  try { first = await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.equal(spy.n, ids.length, '首次每个 run 文件读一次');
  assert.equal(first.length, ids.length);
  // [B2]
  assert.deepEqual(strip(first), referenceDigests(), '摘要与整份读回取标量的参照逐字段相同(顺序 createdAt 降序)');
  assert.deepEqual(first.map(r => r.id), ids, 'createdAt 降序 = 我们造的 i 升序');
  assert.equal(first[0].poolPending, 1);
  assert.equal(first[0].nodeCount, 2);

  const hitsBefore = stats.hits, readsBefore = stats.reads;
  spy = countRunReads();
  let again;
  try { again = await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.equal(spy.n, 0, `第二次轮询(文件未变)不该读任何 run 文件,实读 ${spy.n}:${spy.files.join(',')}`);
  assert.equal(stats.reads, readsBefore, '内部读盘计数不动');
  assert.equal(stats.hits - hitsBefore, ids.length, '全部命中缓存');
  assert.deepEqual(strip(again), strip(first), '两次输出相同');
  assert.equal(JSON.stringify(again), JSON.stringify(first), '两次序列化逐字节相同');

  // [B3] 直接改写一个文件(内容与大小都变):只重读它,摘要反映新内容。
  fs.writeFileSync(runFile('run_0c3'), JSON.stringify(mkRun('run_0c3', 2, { status: 'running', eventSeq: 9999, nodes: [{ id: 'n0', status: 'running', result: 'x' }] }), null, 2));
  spy = countRunReads();
  let changed;
  try { changed = await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.deepEqual(spy.files, ['run_0c3.json'], '恰好重读被改的那一份');
  const row = changed.find(r => r.id === 'run_0c3');
  assert.equal(row.status, 'running');
  assert.equal(row.eventSeq, 9999);
  assert.equal(row.nodeCount, 1);
  assert.equal(row.anyRunning, true);
  assert.deepEqual(strip(changed), referenceDigests());

  // 之后再轮询又是零读。
  spy = countRunReads();
  try { await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.equal(spy.n, 0, '改过之后的下一次又回到零读');

  // [B4] 进程内 saveAgentRun:同样大小的内容也必须被看见(条目在写成功后即作废)。
  const live = mkRun('run_0d4', 3, { eventSeq: 103 });
  live.eventSeq = 104;   // 位数不变 => 文件大小不变
  await saveAgentRun(live);
  spy = countRunReads();
  let saved;
  try { saved = await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.deepEqual(spy.files, ['run_0d4.json'], 'saveAgentRun 之后恰好重读这一份');
  assert.equal(saved.find(r => r.id === 'run_0d4').eventSeq, 104);

  // [B5] 坏快照跳过、删除后消失、非 run 文件名不进列表。
  fs.writeFileSync(runFile('run_0bad'), '{ not json');
  fs.unlinkSync(runFile('run_0e5'));
  const after = await listAgentRunDigests(SID);
  assert.equal(after.some(r => r.id === 'run_0e5'), false, '删掉的 run 不再出现');
  assert.equal(after.length, ids.length - 1, '坏快照与非快照文件都不进列表');
  assert.deepEqual(strip(after), referenceDigests());
  spy = countRunReads();
  try { await listAgentRunDigests(SID); } finally { spy.stop(); }
  assert.equal(spy.n, 0, '坏快照同戳也只读一次(不每拍重试)');
});

test('[B] 会话没有 agent-runs 目录 → 空列表,不抛', async () => {
  assert.deepEqual(await listAgentRunDigests('sess_pollcache_none'), []);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

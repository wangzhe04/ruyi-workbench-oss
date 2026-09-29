'use strict';
// 性能批 P2:投影索引(13e)的增量维护。都用计数断言,不掐表。
//   [I1] 启动第一次读做一次全量源扫描,之后目录变化只比对文件名单(一次 readdir),不再逐条 stat
//   [I2] 外部新出现的会话:下一次读就在索引里(121-K3 的保证不变)
//   [I3] 本进程落盘一条会话:只重建那一片(不全量扫描、不重建别的切片)
//   [I4] 外部「原地替换」已有会话头:名单比对看不见,后台校验(verifyNow)之后可见
//   [I5] 外部往用量账追加:下一次读的用量就对(修前索引进了内存后永远看不见外部写账)
//   [I6] 增量刷新的落盘被合并延迟:读路径上不写盘,flush 之后盘上那份与内存同修订号
//   [I7] 落盘还挂着时用户删了缓存文件:下一次读丢内存、从权威源重建(buildReason missing_index)
//   审查轮复现过、在此钉住的:
//   [I8] 外部写账(会话 B)与本进程追加(会话 A)同时发生:两边的用量下一次读都对(修前 B 永远停在旧值)
//   [I9] 已有会话头的会话外部新长出 journal(登记了一条待决):下一次读就在索引里(修前要等后台校验)
//   [I10] 用量变了,只进 ETag 的 missionsUsageRevision 跟着变(列表上的费用不会被 304 挡住)
//   [I11] 数据目录被删了而落盘还挂着:不会把它建回来
const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-pretender-incr-'));
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const hooks = srv.pretenderIndexTestHooks;
const sessionsDir = path.join(root, 'sessions');
const usageDir = path.join(root, 'usage');
const indexFile = path.join(sessionsDir, '.pretender', 'projection-index.json');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const sid = i => 'sess_incr_' + String(i).padStart(3, '0');
function head(i, goal) {
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  return {
    schemaVersion: 4, storageVersion: 2, id: sid(i), missionId: sid(i), kind: 'mission', title: 'Incr ' + i, summary: '',
    cwd: root, pinned: false, createdAt: stamp, updatedAt: stamp, turnSeq: 1, messageCount: 0, providerHistoryCount: 0,
    mission: { goal: goal || ('goal ' + i), createdAt: stamp, updatedAt: stamp, autoMode: 'off', changeSeq: 1,
      milestones: [{ id: 'm1', desc: 'x', status: 'pending', evidence: '', check: null }],
      budget: { maxAutoTurns: 10, maxTokens: 100000 }, spent: { autoTurns: 0, tokens: 0 }, stall: { lastSignature: '', sameCount: 0 }, result: null },
  };
}
function writeSession(i, goal) {
  fs.writeFileSync(path.join(sessionsDir, sid(i) + '.json'), JSON.stringify(head(i, goal)));
  for (const ext of ['.messages.ndjson', '.provider.ndjson']) {
    const f = path.join(sessionsDir, sid(i) + ext);
    if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  }
}
const slice = (index, i) => index.sessions.find(row => row.sessionId === sid(i));
const cardText = (index, i) => JSON.stringify((slice(index, i) || {}).card || null);
const usageRow = (i, n) => JSON.stringify({ ts: '2026-01-05T00:00:00.000Z', sessionId: sid(i), engine: 'openai', provider: 'p', model: 'm', inTok: n, outTok: 1, cost: 0.001, currency: 'USD', kind: 'turn' });

before(() => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(usageDir, { recursive: true });
  for (let i = 0; i < 40; i++) writeSession(i);
  fs.writeFileSync(path.join(usageDir, '2026-01.jsonl'), [usageRow(1, 10), usageRow(1, 10), usageRow(2, 5)].join('\n') + '\n');
});

test('[I1][I2] 首读全量扫描一次;外部新会话靠名单比对当次可见', async () => {
  const first = await srv.getPretenderProjectionIndex();
  assert.equal(first.sessions.length, 40);
  const s0 = hooks.stats();
  assert.equal(s0.fullSourceScans, 1, '启动第一次读做一次全量源扫描');
  writeSession(40);   // 外部新建(目录 mtime 变)
  const second = await srv.getPretenderProjectionIndex();
  assert.ok(slice(second, 40), '外部新会话下一次读就在索引里');
  const s1 = hooks.stats();
  assert.equal(s1.fullSourceScans, s0.fullSourceScans, '目录变化不再触发全量扫描');
  assert.ok(s1.nameDiffScans > s0.nameDiffScans, '改为比对文件名单');
  assert.equal(s1.sliceBuilds - s0.sliceBuilds, 1, '只给新会话建了一片');
});

test('[I3] 本进程落盘一条会话:只重建那一片', async () => {
  await srv.getPretenderProjectionIndex();
  const s = await srv.loadSession(sid(3));
  s.mission.goal = 'goal 3 edited in-process';
  s.mission.changeSeq = (s.mission.changeSeq || 0) + 1;
  await srv.saveSession(s);
  const before = hooks.stats();
  const index = await srv.getPretenderProjectionIndex();
  const afterStats = hooks.stats();
  assert.match(cardText(index, 3), /edited in-process/, '卡片已是新目标');
  assert.equal(afterStats.fullSourceScans, before.fullSourceScans, '不做全量扫描');
  assert.equal(afterStats.sliceBuilds - before.sliceBuilds, 1, '只重建落盘的那一片');
});

test('[I4] 外部原地替换已有会话头:后台校验之后可见', async () => {
  await srv.getPretenderProjectionIndex();
  const file = path.join(sessionsDir, sid(5) + '.json');
  const tmp = file + '.ext-tmp';
  const h = head(5, 'goal 5 replaced externally');
  h.mission.changeSeq = 9;
  fs.writeFileSync(tmp, JSON.stringify(h));
  fs.renameSync(tmp, file);
  const quick = await srv.getPretenderProjectionIndex();
  assert.doesNotMatch(cardText(quick, 5), /replaced externally/, '名单没变:这一次读看不见(交给后台校验)');
  const verified = await hooks.verifyNow();
  assert.match(cardText(verified, 5), /replaced externally/, '后台校验之后可见');
});

test('[I5] 外部往用量账追加:下一次读的用量就对', async () => {
  const before = slice(await srv.getPretenderProjectionIndex(), 2).usage;
  assert.equal(before.turns, 1);
  fs.appendFileSync(path.join(usageDir, '2026-01.jsonl'), usageRow(2, 7) + '\n');
  const after = slice(await srv.getPretenderProjectionIndex(), 2).usage;
  assert.equal(after.turns, 2, '外部追加的那一行算进来了');
  assert.equal(after.inTok, 12);
});

test('[I6][I7] 增量刷新延迟落盘;挂起时删缓存 → 从权威源重建', async () => {
  await hooks.flushPersist();
  const s = await srv.loadSession(sid(7));
  s.mission.goal = 'goal 7 v2';
  s.mission.changeSeq += 1;
  await srv.saveSession(s);
  const persistsBefore = hooks.stats().persists;
  const index = await srv.getPretenderProjectionIndex();
  assert.equal(hooks.stats().persists, persistsBefore, '读路径上不写盘');
  assert.equal(hooks.stats().persisted, false, '标记为待落盘');
  await hooks.flushPersist();
  assert.equal(hooks.stats().persists, persistsBefore + 1, 'flush 写了一次');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).revision, index.revision, '盘上那份与内存同修订号');

  // 再改一条 → 待落盘;此时用户删掉缓存文件
  const s2 = await srv.loadSession(sid(8));
  s2.mission.goal = 'goal 8 v2';
  s2.mission.changeSeq += 1;
  await srv.saveSession(s2);
  await srv.getPretenderProjectionIndex();
  assert.equal(hooks.stats().persisted, false);
  fs.rmSync(indexFile, { force: true });
  const rebuilt = await srv.getPretenderProjectionIndex();
  assert.equal(rebuilt.buildReason, 'missing_index', '丢内存、从权威源重建');
  assert.ok(fs.existsSync(indexFile), '冷重建立即落盘');
  assert.match(cardText(rebuilt, 8), /goal 8 v2/);
});

test('[I8][I10] 外部写账与本进程追加同时发生:两边用量都对;missionsUsageRevision 跟着变', async () => {
  const before = await srv.getPretenderProjectionIndex();
  const a0 = slice(before, 10).usage.turns, b0 = slice(before, 11).usage.turns;
  fs.appendFileSync(path.join(usageDir, '2026-01.jsonl'), usageRow(11, 3) + '\n');   // 外部:B
  srv.appendUsageLedger({ ts: '2026-01-06T00:00:00.000Z', sessionId: sid(10), engine: 'openai', provider: 'p', model: 'm', inTok: 4, outTok: 1, cost: 0.001, currency: 'USD', kind: 'aux', note: 'x' });
  await new Promise(r => setTimeout(r, 200));   // 追加链是 fire-and-forget
  const after = await srv.getPretenderProjectionIndex();
  assert.equal(slice(after, 10).usage.turns, a0 + 1, '本进程追加的 A');
  assert.equal(slice(after, 11).usage.turns, b0 + 1, '外部写进来的 B');
  assert.notEqual(after.missionsUsageRevision, before.missionsUsageRevision, '用量变了,ETag 用的修订号跟着变');
  assert.equal(after.missionsRevision, before.missionsRevision, '分页游标用的修订号不动(翻到一半不 409)');
});

test('[I9] 已有会话头的会话外部新长出 journal:下一次读就在索引里', async () => {
  await srv.getPretenderProjectionIndex();
  const iv = { id: 'iv_ext_1', type: 'permission', sessionId: sid(12), requestedAt: '2026-01-07T00:00:00.000Z', status: 'pending', toolName: 'Bash', tier: 'exec' };
  fs.writeFileSync(path.join(sessionsDir, sid(12) + '.interventions.ndjson'), JSON.stringify(iv) + '\n');
  const index = await srv.getPretenderProjectionIndex();
  assert.ok((slice(index, 12).interventions || []).some(row => row.id === 'iv_ext_1'), '新 journal 当次可见');
});

test('[I11] 数据目录被删而落盘还挂着:不把它建回来', async () => {
  const s = await srv.loadSession(sid(13));
  s.mission.goal = 'goal 13 v2';
  s.mission.changeSeq += 1;
  await srv.saveSession(s);
  await srv.getPretenderProjectionIndex();
  assert.equal(hooks.stats().persisted, false, '有一份待落盘');
  fs.rmSync(sessionsDir, { recursive: true, force: true });
  await hooks.flushPersist();
  assert.ok(!fs.existsSync(sessionsDir), 'sessions 目录没被建回来');
});

'use strict';
// Unit(150 号文 U1):线程搜索命中的较早线程,左栏要画得出来。
//
// 机制:左栏的行只来自 GET /api/missions(主列表页 ∪ 搜索时按 id 补取的 ?sessionIds=)。而那份列表只收 13e 切片上
// 【有卡片】的会话,卡片的产生条件是 threadVisible 窗口(在途 ∪ 今天 ∪ 最近 N 条 ∪ 管家盯着)。搜索命中的较早线程
// 恰好都在窗口外(切片 card:null),于是修前 ?sessionIds= 点名要它们也一条都不回 —— 体验门实测后端 25 条、左栏 4 条。
//
//   [A] 前提:窗口外的旧会话不在主列表里(本件不改窗口,只改「点名补取」);
//   [B] ?sessionIds= 点名的窗口外会话逐条回行,行上带标题/显示名,五态与聚合态按会话头的真事实现算(跑过回合的无账本
//       线程 = done,不是「交办中」);
//   [C] 不编行:不存在的 id、管家自己的会话不回;
//   [D] 现算的卡只活在这次回包里:主列表的行集合、ETag 与索引修订号不变(不写回索引,分页/304 语义不动)。
//
// 反向验证:RUYI_TEST_SERVER_JS 指到修前的 server.js(从基线 0aa09851 拼出)跑本件,[B] 必须红。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-missions-search-hits-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const MissionState = require(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'mission-state.js'));

const RECENT = 10;       // 01-config THREAD_INDEX_RECENT_MIN:取下限,15 条旧会话就够造出「窗口外」
const OLD_COUNT = 15;
const oldId = i => 'sess_old_' + String(i).padStart(3, '0');

// 与 thread-index-visibility.e2e.js 同一种造法:用户自己在 2.0 里聊过的普通会话(quick_ask、无账本、跑过 1 回合),
// updatedAt 很久以前(不落「今天」),mtime 逐条递增(「最近 N 条」排的就是它)。
function seed() {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ threadIndexRecent: RECENT, locale: 'zh-CN' }), 'utf8');
  const dir = path.join(root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < OLD_COUNT; i++) {
    const sid = oldId(i);
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    const head = {
      schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'quick_ask',
      title: '旧的普通会话 ' + i, summary: '上次说到一半', cwd: root, pinned: false,
      createdAt: stamp, updatedAt: stamp, turnSeq: 1, messageCount: 0, providerHistoryCount: 0, mission: null,
    };
    const file = path.join(dir, sid + '.json');
    fs.writeFileSync(file, JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.provider.ndjson'), '', 'utf8');
    const when = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).getTime() / 1000;
    fs.utimesSync(file, when, when);
  }
}
seed();

const { loadServerInternals } = require('../lib/server-internals');
const { handleMissionsApiRoutes, RUNTIME, getPretenderProjectionIndex } = loadServerInternals(['handleMissionsApiRoutes', 'RUNTIME', 'getPretenderProjectionIndex']);
RUNTIME.token = 'unit-token-missions-search-hits';

async function missions(query = '', headers = {}) {
  const req = { method: 'GET', url: '/api/missions' + query, headers: { 'x-wcw-token': RUNTIME.token, ...headers } };
  const out = { status: 0, headers: {}, body: '' };
  const res = { writeHead(status, h) { out.status = status; out.headers = h || {}; }, end(body) { out.body = String(body || ''); } };
  await handleMissionsApiRoutes(req, res, '/api/missions');
  try { out.json = JSON.parse(out.body); } catch { out.json = null; }
  return out;
}
const idsOf = r => ((r.json && r.json.missions) || []).map(row => String(row.sessionId || ''));

test('[U1] ?sessionIds= 对窗口外(无卡片)的命中会话按需现算行;不编行;不写回索引', async () => {
  const before = await missions('?limit=200');
  assert.equal(before.status, 200);
  const outside = [0, 1, 2, 3, 4].map(oldId);
  // [A] 前提:窗口外的 5 条不在主列表,窗口内最新那条在。
  for (const sid of outside) assert.ok(!idsOf(before).includes(sid), `[A] ${sid} 在窗口外,不在主列表`);
  assert.ok(idsOf(before).includes(oldId(OLD_COUNT - 1)), '[A] 窗口内最新那条在主列表');
  const etagBefore = before.headers.etag;
  const revisionBefore = (await getPretenderProjectionIndex()).missionsRevision;

  // [B] 点名要:窗口外 5 条 + 窗口内 1 条 + 不存在的 1 条 + 管家会话。
  const wanted = [...outside, oldId(OLD_COUNT - 1), 'sess_nope_000', 'steward'];
  const picked = await missions('?sessionIds=' + encodeURIComponent(wanted.join(',')));
  assert.equal(picked.status, 200);
  const rows = (picked.json && picked.json.missions) || [];
  const got = idsOf(picked);
  for (const sid of [...outside, oldId(OLD_COUNT - 1)]) assert.ok(got.includes(sid), `[B] ${sid} 回了行(修前窗口外的一条都不回)`);
  for (const sid of outside) {
    const row = rows.find(item => item.sessionId === sid);
    const n = Number(sid.slice(-3));
    assert.equal(row.title, '旧的普通会话 ' + n, `[B] ${sid} 带原标题`);
    assert.equal(row.displayTitle, '旧的普通会话 ' + n, `[B] ${sid} 带显示名`);
    assert.equal(row.missionId, sid);
    assert.equal(MissionState.fromCard(row).state, 'done', `[B] ${sid} 五态按真事实现算:跑过回合的无账本线程 = done,不是交办中`);
    assert.equal(row.aggregateState, 'done', `[B] ${sid} 聚合态与这张卡一致(不借 factsUnknown 那一支的聚合行)`);
    assert.equal(row.activeTurn, false);
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'liveTail'), `[B] ${sid} 叠加过 live 层(overlayMissionCard)`);
  }
  // [C] 不编行。
  assert.ok(!got.includes('sess_nope_000'), '[C] 不存在的会话不回行');
  assert.ok(!got.includes('steward'), '[C] 管家自己的会话不回行');
  assert.equal(new Set(got).size, got.length, '[C] 同一条不回两次');

  // [D] 不写回索引:主列表行集合、ETag、修订号都不变。
  const after = await missions('?limit=200');
  assert.deepEqual(idsOf(after), idsOf(before), '[D] 主列表行集合不变');
  assert.equal(after.headers.etag, etagBefore, '[D] 主列表 ETag 不变');
  assert.equal((await getPretenderProjectionIndex()).missionsRevision, revisionBefore, '[D] 索引修订号不变');
  const notModified = await missions('?limit=200', { 'if-none-match': etagBefore });
  assert.equal(notModified.status, 304, '[D] 304 语义不变');
});

test('[U1] 无 token 仍是 403(鉴权不因补取放宽)', async () => {
  const req = { method: 'GET', url: '/api/missions?sessionIds=' + oldId(0), headers: {} };
  const out = {};
  await handleMissionsApiRoutes(req, { writeHead(status) { out.status = status; }, end() {} }, '/api/missions');
  assert.equal(out.status, 403);
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

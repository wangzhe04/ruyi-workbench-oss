'use strict';
// 会话「读」不该有写的后果;会话目录里的非会话文件不是会话;导入的消息不可信;进程内正文状态表有上限。
// 真源码、临时 HOME、真读盘真写盘。
//   [U1] 新会话第一次 loadSession 不回写头(createSession 落盘前就补齐了默认字段):头文件逐字节不变,列表次序不变。
//   [U2] 装载回写(v2 头缺默认字段 → load_normalize;v1 单文件 → load_migrate)照样落盘,但 updatedAt 保持原值;
//        真编辑(不带 keepUpdatedAt 的 saveSession)照旧推 updatedAt。
//   [U3] 保留名不是会话:loadSession('_search-index-v1') / loadSession('index') 为 null,文件原样;
//        listSessions 不列 `_` 前缀与 index;deleteSession 不删 index.json。
//   [U4] createSession 的 messages 只收普通对象 + 字符串 role + content 缺省/字符串/数组:[null] 不再抛(修前路由 500)。
//   [U5] sessionBodyState 条目数有上限(修前每条摸过的会话都挂一份每行 hash,直到进程退出);被淘汰的会话再存时
//        在写链里按盘上内容重建记录 —— 旧副本补齐(session-stale-copy-rebase)不因淘汰失效,并发追加的消息不丢。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-read-fx-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, loadSession, saveSession, listSessions, deleteSession, perfCounters } = srv;
const sessionsDir = path.join(root, 'sessions');
const headFile = id => path.join(sessionsDir, id + '.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

test('[U1] 新会话第一次装载不回写头,列表次序不变', async () => {
  const a = await createSession({ title: 'A', cwd: root });
  await sleep(15);
  const b = await createSession({ title: 'B', cwd: root });
  await sleep(15);
  const before = fs.readFileSync(headFile(a.id), 'utf8');
  const loaded = await loadSession(a.id);
  await sleep(250);   // 索引写是去抖的:给它落盘的机会
  const order = (await listSessions()).map(s => s.id).filter(id => id === a.id || id === b.id);
  assert.deepEqual(order, [b.id, a.id], '看一眼 A 不会让 A 排到 B 前面');
  assert.equal(loaded.updatedAt, a.updatedAt, '装载拿到的 updatedAt 就是建会话时那一个');
  assert.equal(fs.readFileSync(headFile(a.id), 'utf8'), before, '头文件逐字节不变(修前 load_normalize 回写、推 updatedAt)');
  const head = JSON.parse(before);
  for (const key of ['todos', 'skills', 'memories', 'memoriesExplicit', 'memoryExclusions']) {
    assert.ok(Object.prototype.hasOwnProperty.call(head, key), `新会话头上就有 ${key}`);
  }
});

test('[U2] 装载回写保持 updatedAt;真编辑照旧推', async () => {
  // v2 头缺默认字段(老版本写下的头):load_normalize 回写
  const s = await createSession({ title: 'old-v2', cwd: root });
  const oldAt = '2020-01-02T03:04:05.000Z';
  const raw = JSON.parse(fs.readFileSync(headFile(s.id), 'utf8'));
  for (const key of ['todos', 'skills', 'memories', 'memoriesExplicit', 'memoryExclusions']) delete raw[key];
  raw.updatedAt = oldAt;
  fs.writeFileSync(headFile(s.id), JSON.stringify(raw, null, 2));
  const loaded = await loadSession(s.id);
  const after = JSON.parse(fs.readFileSync(headFile(s.id), 'utf8'));
  assert.ok(Array.isArray(after.todos) && after.memoriesExplicit === false, '补默认字段的回写照样落盘');
  assert.equal(after.updatedAt, oldAt, 'load_normalize 回写不推 updatedAt');
  assert.equal(loaded.updatedAt, oldAt);

  // v1 单文件(storageVersion 之前):load_migrate 懒迁移
  const legacyId = 'sess_legacyread0001';
  fs.writeFileSync(headFile(legacyId), JSON.stringify({
    id: legacyId, title: 'legacy', cwd: root, createdAt: oldAt, updatedAt: oldAt,
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], providerHistory: [],
  }, null, 2));
  const legacy = await loadSession(legacyId);
  assert.equal(legacy.messages.length, 2);
  const migrated = JSON.parse(fs.readFileSync(headFile(legacyId), 'utf8'));
  assert.equal(migrated.storageVersion, 2, '懒迁移照样发生');
  assert.equal(migrated.updatedAt, oldAt, 'load_migrate 不推 updatedAt');
  const listed = (await listSessions()).find(row => row.id === legacyId);
  assert.equal(listed && listed.updatedAt, oldAt, '列表里也是原来的时间');

  // 真编辑:照旧推
  loaded.title = 'renamed';
  await saveSession(loaded);
  const edited = JSON.parse(fs.readFileSync(headFile(s.id), 'utf8'));
  assert.ok(edited.updatedAt > oldAt, `真编辑推 updatedAt(${edited.updatedAt})`);
});

test('[U3] 保留名不是会话:不装载、不迁移、不列、不删', async () => {
  await createSession({ title: 'any', cwd: root });
  await listSessions();
  await sleep(250);
  const searchIndex = path.join(sessionsDir, '_search-index-v1.json');
  const indexFile = path.join(sessionsDir, 'index.json');
  fs.writeFileSync(searchIndex, JSON.stringify({ version: 2, builtAt: 'x', entries: {} }));
  const searchBefore = fs.readFileSync(searchIndex, 'utf8');
  assert.equal(await loadSession('_search-index-v1'), null, '_search-index-v1 不是会话');
  assert.equal(fs.readFileSync(searchIndex, 'utf8'), searchBefore, '搜索索引没被当成 v1 会话迁移');
  assert.ok(!fs.existsSync(path.join(sessionsDir, '_search-index-v1.messages.ndjson')), '没长出正文文件');
  assert.ok(fs.existsSync(indexFile), '侧栏索引在');
  assert.equal(await loadSession('index'), null);
  assert.equal(await loadSession('INDEX'), null, 'Windows 上 INDEX.json 就是 index.json');
  fs.writeFileSync(path.join(sessionsDir, '_stray.json'), JSON.stringify({ id: '_stray', title: 'stray' }));
  const ids = (await listSessions()).map(row => row.id);
  assert.ok(!ids.includes('_stray') && !ids.includes('_search-index-v1') && !ids.includes('index'), `列表不含保留名(${ids.join(',')})`);
  await assert.rejects(deleteSession('index'), /invalid session id/, 'deleteSession(index) 直接拒');
  assert.ok(fs.existsSync(indexFile), '侧栏索引没被删');
  fs.writeFileSync(headFile('steward'), JSON.stringify({ id: 'steward', kind: 'steward', title: 'steward', messages: [], providerHistory: [] }));
  const steward = await loadSession('steward');
  assert.equal(steward && steward.id, 'steward', '管家会话 id(steward)照旧是合法的会话 id');
});

test('[U4] 导入消息只收合形条目', async () => {
  const s = await createSession({
    title: 'imp', cwd: root,
    messages: [null, 5, 'x', [], { role: 'user' }, { role: 'user', content: { a: 1 } }, { content: 'no role' },
      { role: 'user', content: 'hi' }, { role: 'assistant', content: '', segments: [{ type: 'text', text: 'yo' }] }],
  });
  assert.deepEqual(s.messages.map(m => m.role + ':' + (m.content == null ? '-' : m.content)), ['user:-', 'user:hi', 'assistant:']);
  const loaded = await loadSession(s.id);
  assert.equal(loaded.messages.length, 3);
});

test('[U5] 正文状态表条目有上限;被淘汰的会话再存,并发追加不丢', async () => {
  const stats = () => ({ ...perfCounters.sessionBody });
  const victim = await createSession({ title: 'victim', cwd: root });
  victim.messages = [{ role: 'user', content: 'm1' }];
  victim.providerHistory = [{ role: 'user', content: 'm1' }];
  await saveSession(victim);
  const stale = await loadSession(victim.id);
  const turn = await loadSession(victim.id);
  turn.messages.push({ role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' });
  turn.providerHistory.push({ role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' });
  await saveSession(turn);

  // 160 条别的会话各装载一次(每次 save 要几十毫秒,装载只要一两毫秒:盘上直接铺好已归一的 v2 头 + 正文,装载不回写)。
  const template = JSON.parse(fs.readFileSync(headFile(victim.id), 'utf8'));
  const evictionsBefore = stats().stateEvictions || 0;
  for (let i = 0; i < 160; i++) {
    const id = 'sess_fill' + String(i).padStart(4, '0');
    fs.writeFileSync(headFile(id), JSON.stringify({ ...template, id, missionId: id, title: 'fill ' + i, messageCount: 1, providerHistoryCount: 0 }));
    fs.writeFileSync(path.join(sessionsDir, id + '.messages.ndjson'), JSON.stringify({ role: 'user', content: 'x' + i }) + '\n');
    fs.writeFileSync(path.join(sessionsDir, id + '.provider.ndjson'), '');
    assert.ok(await loadSession(id), id);
  }
  const after = stats();
  assert.ok(Number.isInteger(after.stateEntries) && after.stateEntries <= 128, `条目数有上限(${after.stateEntries})`);
  assert.ok(after.stateEvictions - evictionsBefore >= 160 - 128, `最旧的被淘汰(${after.stateEvictions - evictionsBefore})`);

  const recoveriesBefore = after.stateRecoveries || 0;
  stale.title = 'renamed after eviction';
  await saveSession(stale);
  const recovered = stats().stateRecoveries > recoveriesBefore;
  const reread = await loadSession(victim.id);
  assert.equal(reread.title, 'renamed after eviction');
  assert.deepEqual(reread.messages.map(m => m.content), ['m1', 'm2', 'm3'], '别人追加的消息还在(旧副本补齐没因淘汰失效)');
  assert.deepEqual(reread.providerHistory.map(m => m.content), ['m1', 'm2', 'm3']);
  assert.ok(recovered, '写链里按盘上内容重建了记录');
});

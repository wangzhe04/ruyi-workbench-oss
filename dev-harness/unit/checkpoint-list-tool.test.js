// Unit(61 号文 C4):只读工具 checkpoint_list 与「用户在界面撤销」告知行的纯逻辑。
//   [C1] 注册元数据:read 档、files_write 包(闲聊回合不带、改文件/撤销意图才带),不是起手工具;
//   [C2] 分组与字段:同回合同工具同 op 并成一行(主路径 + files 个数 + 至多 5 个样例),skipped 标不可撤销;
//   [C3] 有界:limit 默认 20、上限 50,truncated 如实;turnSeq 过滤;非法 turnSeq 回稳定错误码;
//   [C4] 会话只取自 ctx:参数里夹带 sessionId 不起作用,没有会话回 not_found,别的会话的检查点读不到;
//   [C5] 撤销记录(reverts.json)→ reverted:true 行,与还能撤销的行并存;坏文件当空;
//   [C6] 告知行文案:中英、单文件/多文件/新建、回合数与路径数的上限。
// 真源码 require(server.js),临时家目录,零模型请求。端到端(真撤销 → 下一回合 user 消息带告知)见 checkpoint-visibility.e2e.js。
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-checkpoint-list-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

const list = (sid, args) => srv.toolCall('checkpoint_list', args || {}, { session: { id: sid }, sessionId: sid });
const cpDir = sid => path.join(root, 'checkpoints', sid);
const rec = (sid, turn, tool, file, op, before) => srv.journalRecord(sid, turn, tool, file, op, before === undefined ? (op === 'create' ? null : Buffer.from('before')) : before);

test('[C1] 注册元数据:read 档、files_write 包,闲聊不带', () => {
  assert.equal(srv.NATIVE_TOOL_TIER.checkpoint_list, 'read');
  assert.equal(srv.toolPackForName('checkpoint_list'), 'files_write');
  assert.ok(srv.TOOL_HANDLERS.checkpoint_list, '有 handler');
  const cfg = srv.defaultConfig();
  const offered = srv.buildOpenAiTools(cfg, null, { skillsEnabled: true });
  const names = msg => srv.createToolLoadingState(cfg, msg, null, offered, null, null).current().map(t => t.function.name);
  assert.ok(!names('你好').includes('checkpoint_list'), '闲聊回合不带');
  assert.ok(names('请修改 src/a.js').includes('checkpoint_list'), '改文件意图带(随写包)');
  for (const msg of ['我在界面撤销了刚才的修改', 'please undo that change', 'roll back the checkpoint']) {
    assert.ok(srv.classifyToolPacks(msg).includes('files_write'), `${msg} → files_write 包`);
  }
  const starter = srv.createToolLoadingState(cfg, '你好', null, offered, null, null).current().map(t => t.function.name);
  assert.ok(!starter.includes('checkpoint_list'), '不属于起手工具');
});

test('[C2] 分组与字段', async () => {
  const sid = 'sess_cplist_group';
  await rec(sid, 1, 'file_write', 'C:\\ws\\a.txt', 'create');
  await rec(sid, 1, 'file_write', 'C:\\ws\\b.txt', 'modify');
  await rec(sid, 1, 'file_write', 'C:\\ws\\b.txt', 'modify');   // 同一文件改两次:files 按去重后的路径数
  await rec(sid, 1, 'file_write', 'C:\\ws\\c.txt', 'modify');
  for (let i = 0; i < 12; i++) await rec(sid, 2, 'archive_unzip', `C:\\ws\\unz\\f${i}.txt`, 'create');
  await rec(sid, 2, 'file_delete', 'C:\\ws\\big.bin', 'delete', { skippedBytes: 9 * 1024 * 1024 });   // 超限:没存下 before
  const r = await list(sid);
  assert.equal(r.ok, true);
  assert.equal(r.total, 4, JSON.stringify(r.checkpoints));
  assert.deepEqual(r.checkpoints.map(x => [x.turnSeq, x.tool, x.op]), [
    [2, 'file_delete', 'delete'], [2, 'archive_unzip', 'create'], [1, 'file_write', 'modify'], [1, 'file_write', 'create'],
  ], '回合新的在前,同回合按本组最新一条的 entrySeq 倒序');
  const unz = r.checkpoints.find(x => x.tool === 'archive_unzip');
  assert.equal(unz.files, 12);
  assert.equal(unz.paths.length, 5, '样例路径至多 5 个');
  assert.equal(unz.path, 'C:\\ws\\unz\\f0.txt', '主路径 = 本组最早一条');
  assert.equal(unz.undoable, true);
  assert.equal(unz.reverted, false);
  assert.ok(typeof unz.at === 'string' && !Number.isNaN(Date.parse(unz.at)), 'at 是 ISO 时间');
  assert.ok(Number.isSafeInteger(unz.entrySeq) && unz.entrySeq >= 0);
  const mod = r.checkpoints.find(x => x.turnSeq === 1 && x.op === 'modify');
  assert.equal(mod.files, 2, 'b.txt 改两次只算一个文件');
  assert.deepEqual(mod.paths, ['C:\\ws\\b.txt', 'C:\\ws\\c.txt']);
  const single = r.checkpoints.find(x => x.turnSeq === 1 && x.op === 'create');
  assert.equal(single.path, 'C:\\ws\\a.txt');
  assert.ok(!('files' in single) && !('paths' in single), '单文件行不带 files/paths');
  const big = r.checkpoints.find(x => x.tool === 'file_delete');
  assert.equal(big.undoable, false, 'skipped 的标不可撤销');
  assert.equal(big.notUndoable, 1);
  assert.match(r.note, /only the user can undo/);
});

test('[C3] 有界:limit / turnSeq / 非法入参', async () => {
  const sid = 'sess_cplist_bounds';
  // 检查点每会话只留最近 20 个回合(JOURNAL_KEEP_TURNS):20 个回合 × 4 个工具 = 80 行,足够撑过 limit 上限
  for (let t = 1; t <= 20; t++) for (const tool of ['file_write', 'file_edit', 'file_move', 'file_copy']) await rec(sid, t, tool, `C:\\ws\\${tool}-t${t}.txt`, 'create');
  const dflt = await list(sid);
  assert.equal(dflt.shown, 20);
  assert.equal(dflt.total, 80);
  assert.equal(dflt.truncated, true);
  assert.equal(dflt.checkpoints[0].turnSeq, 20, '默认最新的在前');
  const big = await list(sid, { limit: 9999 });
  assert.equal(big.shown, 50, 'limit 上限 50');
  const one = await list(sid, { limit: 1 });
  assert.equal(one.shown, 1);
  const zero = await list(sid, { limit: 0 });
  assert.equal(zero.shown, 1, 'limit<1 夹到 1');
  const t7 = await list(sid, { turnSeq: 7 });
  assert.equal(t7.total, 4);
  assert.ok(t7.checkpoints.every(x => x.turnSeq === 7));
  assert.ok(!('truncated' in t7));
  const none = await list(sid, { turnSeq: 999 });
  assert.equal(none.total, 0);
  assert.deepEqual(none.checkpoints, []);
  const bad = await list(sid, { turnSeq: -1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_turnSeq');
  const typo = await list(sid, { turnSeq: 'abc' });   // 类型错在通用参数校验那一层就被拒(错误形状由它定),不会走到清单里
  assert.equal(typo.ok, false);
  assert.match(String(typo.error), /turnSeq/);
  assert.equal((await list(sid, { turnSeq: '7' })).total, 4, '字符串数字照收');
});

test('[C4] 会话只取自 ctx', async () => {
  const mine = 'sess_cplist_mine', other = 'sess_cplist_other';
  await rec(mine, 1, 'file_write', 'C:\\ws\\mine.txt', 'create');
  await rec(other, 1, 'file_write', 'C:\\ws\\other.txt', 'create');
  const r = await list(mine, { sessionId: other, session: other });   // 夹带的 sessionId 一律不认
  assert.equal(r.total, 1);
  assert.equal(r.checkpoints[0].path, 'C:\\ws\\mine.txt');
  assert.ok(!JSON.stringify(r).includes('other.txt'));
  const none = await srv.toolCall('checkpoint_list', { sessionId: mine }, {});
  assert.equal(none.ok, false);
  assert.equal(none.error, 'not_found', '没有会话上下文 → not_found,不读参数里的会话');
  const badId = await srv.toolCall('checkpoint_list', {}, { session: { id: '../../etc' } });
  assert.equal(badId.error, 'not_found', '不合形的会话 id 不拼路径');
  const fresh = await list('sess_cplist_fresh');
  assert.equal(fresh.ok, true);
  assert.equal(fresh.total, 0);
});

test('[C5] 撤销记录 → reverted 行;坏文件当空', async () => {
  const sid = 'sess_cplist_reverted';
  await rec(sid, 3, 'file_write', 'C:\\ws\\keep.txt', 'create');
  fs.mkdirSync(cpDir(sid), { recursive: true });
  const items = [
    { seq: 1, turnSeq: 2, entrySeq: 0, tool: 'file_write', op: 'modify', files: 3, paths: ['C:\\ws\\x.txt', 'C:\\ws\\y.txt', 'C:\\ws\\z.txt'], at: '2026-10-04T01:00:00.000Z', revertedAt: '2026-10-04T02:00:00.000Z', announced: false },
    { seq: 2, turnSeq: 2, entrySeq: 5, tool: 'file_write', op: 'create', files: 1, paths: ['C:\\ws\\n.txt'], at: '2026-10-04T01:05:00.000Z', revertedAt: '2026-10-04T02:00:00.000Z', announced: true },
    { seq: 'x', turnSeq: 2 }, null,   // 坏条目被丢掉,不拖垮整份
  ];
  fs.writeFileSync(path.join(cpDir(sid), 'reverts.json'), JSON.stringify({ schema: 1, items }));
  const r = await list(sid);
  assert.equal(r.total, 3);
  assert.deepEqual(r.checkpoints.map(x => [x.turnSeq, x.reverted]), [[3, false], [2, true], [2, true]]);
  const mod = r.checkpoints.find(x => x.op === 'modify');
  assert.equal(mod.reverted, true);
  assert.equal(mod.undoable, false, '已撤销的不再可撤销');
  assert.equal(mod.files, 3);
  assert.equal(mod.revertedAt, '2026-10-04T02:00:00.000Z');
  assert.equal(r.checkpoints.find(x => x.turnSeq === 3).reverted, false);
  const filtered = await list(sid, { turnSeq: 3 });
  assert.equal(filtered.total, 1);
  fs.writeFileSync(path.join(cpDir(sid), 'reverts.json'), '{ not json');
  const broken = await list(sid);
  assert.equal(broken.ok, true);
  assert.equal(broken.total, 1, '坏文件当空:只剩还能撤销的那一行');
});

test('[C6] 告知行文案', () => {
  const zh = srv.getPromptPack('zh-CN').revertNotice;
  const en = srv.getPromptPack('en-US').revertNotice;
  assert.equal(zh({ turns: [{ turnSeq: 3, modified: { paths: ['a.txt', 'b.txt'], total: 2 }, created: null }] }),
    '[用户已在界面撤销：第 3 回合对 a.txt、b.txt 的修改，这些文件已恢复到修改前]');
  assert.equal(zh({ turns: [{ turnSeq: 3, modified: { paths: ['a.txt'], total: 1 }, created: { paths: ['c.txt'], total: 1 } }] }),
    '[用户已在界面撤销：第 3 回合对 a.txt 的修改，该文件已恢复到修改前；新建的 c.txt 已删除]');
  const many = zh({ turns: [{ turnSeq: 1, modified: { paths: ['1', '2', '3', '4', '5'], total: 9 }, created: null }] });
  assert.match(many, /1、2、3、4 等共 9 个文件 的修改/, '路径只点名 4 个,其余报总数');
  assert.ok(!many.includes('、5'));
  const turns = Array.from({ length: 8 }, (_, i) => ({ turnSeq: i + 1, modified: { paths: ['f' + i], total: 1 }, created: null }));
  const capped = zh({ turns });
  assert.match(capped, /第 5 回合/);
  assert.ok(!/第 6 回合/.test(capped));
  assert.match(capped, /另有 3 个回合的改动也已撤销/);
  const long = zh({ turns: [{ turnSeq: 1, modified: { paths: ['C:\\' + 'd'.repeat(300) + '\\a.txt'], total: 1 }, created: null }] });
  assert.ok(long.length < 260, '过长路径被缩写:' + long.length);
  assert.match(long, /…/);
  assert.equal(en({ turns: [{ turnSeq: 3, modified: { paths: ['a.txt', 'b.txt'], total: 2 }, created: { paths: ['c.txt'], total: 1 } }] }),
    '[The user undid file changes in the UI. turn 3: edits to a.txt, b.txt undone, these files are restored to the state before the edit; c.txt created in that turn was deleted]');
  assert.match(en({ turns: [{ turnSeq: 1, modified: { paths: ['1', '2', '3', '4', '5'], total: 9 }, created: null }] }), /1, 2, 3, 4 and 5 more \(9 files in all\)/);
});

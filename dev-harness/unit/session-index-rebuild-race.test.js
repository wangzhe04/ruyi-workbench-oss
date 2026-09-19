// Unit(128f-⑧;Brief §4.2 第 22 条):会话索引的两处「读到旧值」。
//   [R1] 扫盘重建的竞态(确定性构造):索引不在 → listSessions 走扫盘重建;扫到 X 之后【中途】把 X 改名存一次,并让那次存的
//        索引刷新立刻跑完(索引此刻不在 → 修前那一批直接被丢掉)。修前:重建写回的是 X 的旧名,之后 id 集合与磁盘对得上,
//        快路径一直信它 —— 第二次 listSessions 仍是旧名。修后:重建写回时叠上开扫之后的写,新名。
//   [R2] 用量页标题:改名刚存、索引刷新还在去抖窗口里(~200 ms)时,buildUsageSummary 的 bySession 标题修前是盘上的旧名。
//   [R3] 对照:没有中途保存的普通重建照常(不多不少、名字就是盘上的)。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-index-rebuild-race-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('会话索引:重建竞态与用量页标题', () => {
  it('[R1] 扫盘重建中途被存一次:重建写回的是新名,之后快路径也是新名', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) made.push(await srv.createSession({ title: 'r1-' + i, cwd: root }));
    await srv.flushSessionIndex();
    const target = made[2];
    await srv.invalidateSessionIndex();          // 逼 listSessions 走扫盘重建
    let fired = false;
    srv.setSessionIndexRebuildScanHookForTest(async id => {
      if (fired || id !== target.id) return;
      fired = true;
      target.title = 'renamed-mid-scan';
      await srv.saveSession(target);
      await srv.flushSessionIndex();              // 那次存的索引刷新立刻跑完(索引此刻不在)
    });
    try {
      await srv.listSessions();
    } finally { srv.setSessionIndexRebuildScanHookForTest(null); }
    assert.ok(fired, '测试口没有触发 —— 这件没造出竞态');
    // 记「开扫之后的写」那张表只在有重建在扫时记、收尾清空(测试口的返回值就是它的条数)
    assert.strictEqual(srv.setSessionIndexRebuildScanHookForTest(null), 0, '重建收尾后那张表应已清空,否则随会话总数只增不减');
    const again = await srv.listSessions();
    const row = again.find(m => m.id === target.id);
    assert.strictEqual(row && row.title, 'renamed-mid-scan', '重建之后快路径仍是旧名 = 竞态还在');
  });

  it('[R2] 用量页标题:改名刚存、索引还在去抖窗口里时就是新名', async () => {
    const s = await srv.createSession({ title: 'usage-old', cwd: root });
    await srv.flushSessionIndex();
    srv.appendUsageLedger({ sessionId: s.id, engine: 'openai', provider: 'p', model: 'm', inTok: 5, outTok: 1, kind: 'turn' });
    await sleep(150);
    s.title = 'usage-new';
    await srv.saveSession(s);                      // 索引刷新去抖 ~200 ms,此刻还没落盘
    const summary = await srv.buildUsageSummary('all');
    const row = (summary.bySession || []).find(x => x.sessionId === s.id);
    assert.ok(row, 'bySession 里应有这条会话');
    assert.strictEqual(row.title, 'usage-new');
  });

  it('[R3] 对照:没有中途保存的普通重建照常', async () => {
    await srv.flushSessionIndex();
    const before = (await srv.listSessions()).map(m => m.id + ':' + m.title).sort();
    await srv.invalidateSessionIndex();
    const rebuilt = (await srv.listSessions()).map(m => m.id + ':' + m.title).sort();
    assert.deepStrictEqual(rebuilt, before);
    // 没有重建在扫时的保存不进那张表
    const s = await srv.createSession({ title: 'r3-idle', cwd: root });
    s.title = 'r3-idle-2';
    await srv.saveSession(s);
    assert.strictEqual(srv.setSessionIndexRebuildScanHookForTest(null), 0, '没有重建在扫时不该记');
  });
});

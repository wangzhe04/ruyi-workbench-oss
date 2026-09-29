'use strict';
// 128b(48 号文 §2-b):会话「读-改-写」唯一原语 mutateSession ＋ 驱动器撤回后收手。真源码、临时 HOME、真读盘真写盘。
//
// 为什么要这把锁:一次被撤回闸丢掉的 saveSession 返回值与成功时一模一样;普查出十来个请求／后台读改写调用方
// (技能、记忆、todo、任务开始更新核验、任务控制、三个引擎的手动压缩、管家拜访归档……)撤回插在中间时
// 改动被整份丢掉、接口照样回成功。这里钉:
//   [M1] 基本:改动落盘。
//   [M2] 撤回插在读与存之间(mutator 第一次执行时,另一份副本以撤回的身份落盘并抬高代数)⇒ 第一次写被闸丢掉、
//        在新读的副本上重放一次后落上;撤回的效果(正文被截)与这次改动【都在】。
//   [M3] expectGen 与新读到的代数不一致 ⇒ 抛 session.rewound_during_write,什么都不写。
//   [M4] expectGen 读时一致、但撤回落在存之前 ⇒ 同样抛、不重放(慢活基于撤回前的历史,不能写回去)。
//   [M5] mutator 返回 { abort } ⇒ 不写,value 带回。
//   [D1] 任务驱动器手里的对象是撤回之前读出来的 ⇒ 一个回合都不起(修前:照起,每一存都被静默丢掉)。
//   [D2] 对照:对象不陈旧时驱动器照常起回合。
//   [M6] hunt2-P4:同一会话上并发的 mutateSession(各改各的头字段)⇒ 两边的改动【都在】(修前 20/20 丢一边:
//        各自读到同一份旧头、后存者整份盖掉先存者)。updateSessionMeta 与 mutateSession 并发同样不丢。
//   [M7] hunt2-P4 不死锁:读改写链与 saveSession 自己的写链、与「活回合」那种直接 saveSession 的写者交错
//        (mutator 里还夹着一次直接 saveSession),全部在限时内完成,且各自的改动都落盘。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-mutate-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, loadSession, saveSession, mutateSession, updateSessionMeta, sessionObjectIsStale, runMissionDriver } = srv;

async function freshSession(messages = 4) {
  const msgs = [];
  for (let i = 0; i < messages; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i, createdAt: new Date(Date.now() + i).toISOString() });
  const s = await createSession({ title: 't', cwd: root, messages: msgs });
  return s.id;
}
// 模拟一次撤回落盘:另一份副本截掉末两条、以 rewindBump 身份存(与 rewindSession 那一存同一条路径抬代数)。
async function simulateRewind(id) {
  const other = await loadSession(id);
  other.messages = other.messages.slice(0, Math.max(0, other.messages.length - 2));
  await saveSession(other, { rewindBump: true, throwIfStale: true, writer: 'rewind' });
  return other.messages.length;
}

test('[M1] 基本:改动落盘', async () => {
  const id = await freshSession();
  const r = await mutateSession(id, s => { s.todos = [{ content: 'a', status: 'pending' }]; }, { writer: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.deepEqual((await loadSession(id)).todos, [{ content: 'a', status: 'pending' }]);
});

test('[M2] 撤回插在读与存之间 ⇒ 重放一次后落上,撤回的效果与改动都在', async () => {
  const id = await freshSession(6);
  let calls = 0; let keptAfterRewind = -1;
  const r = await mutateSession(id, async (s, { attempt }) => {
    calls += 1;
    if (attempt === 0) keptAfterRewind = await simulateRewind(id);   // 撤回在这份副本读出之后、存之前落盘
    s.skills = [{ id: 'x', source: 'test' }];
  }, { writer: 'test' });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2, '第一次写被闸丢掉,第二次在新读的副本上落上');
  assert.equal(calls, 2);
  const disk = await loadSession(id);
  assert.deepEqual(disk.skills, [{ id: 'x', source: 'test' }], '改动在');
  assert.equal(disk.messages.length, keptAfterRewind, '撤回的效果也在(没有被撤回之前那份副本盖回去)');
});

test('[M3] expectGen 与新读到的代数不一致 ⇒ 抛、不写', async () => {
  const id = await freshSession();
  const base = Number((await loadSession(id)).rewindGen) || 0;
  await simulateRewind(id);
  await assert.rejects(
    mutateSession(id, s => { s.todos = [{ content: 'late', status: 'pending' }]; }, { writer: 'test', expectGen: base }),
    e => e && e.code === 'session.rewound_during_write');
  assert.ok(!((await loadSession(id)).todos || []).some(t => t.content === 'late'));
});

test('[M4] expectGen 读时一致、撤回落在存之前 ⇒ 抛、不重放', async () => {
  const id = await freshSession(6);
  const base = Number((await loadSession(id)).rewindGen) || 0;
  let calls = 0;
  await assert.rejects(
    mutateSession(id, async s => { calls += 1; await simulateRewind(id); s.todos = [{ content: 'late', status: 'pending' }]; }, { writer: 'test', expectGen: base }),
    e => e && e.code === 'session.rewound_during_write');
  assert.equal(calls, 1, '慢活基于撤回之前的历史,不重放');
  assert.ok(!((await loadSession(id)).todos || []).some(t => t.content === 'late'));
});

test('[M5] abort ⇒ 不写', async () => {
  const id = await freshSession();
  const r = await mutateSession(id, s => { s.todos = [{ content: 'no', status: 'pending' }]; return { abort: 'why' }; }, { writer: 'test' });
  assert.equal(r.ok, false);
  assert.equal(r.value, 'why');
  assert.ok(!((await loadSession(id)).todos || []).some(t => t.content === 'no'));
});

test('[M6] 并发 mutateSession / updateSessionMeta 各改各的字段 ⇒ 改动都在', async () => {
  const id = await freshSession();
  let lost = 0;
  for (let i = 0; i < 20; i++) {
    await Promise.all([
      mutateSession(id, x => { x.todos = [{ content: 't' + i, status: 'pending' }]; }, { writer: 'todo' }),
      mutateSession(id, x => { x.skills = [{ id: 'sk' + i, source: '' }]; }, { writer: 'skills' }),
      updateSessionMeta(id, { title: 'title-' + i }),
    ]);
    const r = await loadSession(id);
    const okT = r.todos && r.todos[0] && r.todos[0].content === 't' + i;
    const okS = r.skills && r.skills[0] && r.skills[0].id === 'sk' + i;
    const okM = r.title === 'title-' + i;
    if (!(okT && okS && okM)) lost += 1;
  }
  assert.equal(lost, 0, `并发读改写丢了 ${lost}/20 轮`);
});

test('[M7] 读改写链与写链、与直接 saveSession 的写者交错不死锁', async () => {
  const id = await freshSession(4);
  const live = await loadSession(id);           // 「活回合」手里那份:只走 saveSession,不进读改写链
  const work = [];
  for (let i = 0; i < 10; i++) {
    work.push(mutateSession(id, async x => {
      // mutator 内夹一次对同一会话的直接 saveSession(撤回 / 旁路写者就是这么插进来的,见 [M2])
      if (i % 3 === 0) { const other = await loadSession(id); other.memories = ['m' + i]; await saveSession(other); }
      x.todos = [{ content: 'k' + i, status: 'pending' }];
    }, { writer: 'test' }));
    live.messages.push({ role: 'assistant', content: 'live' + i });
    work.push(saveSession(live));
    work.push(updateSessionMeta(id, { title: 'n' + i }));
  }
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('deadlock: 10 s 内没跑完')), 10000); });
  try { await Promise.race([Promise.all(work), timeout]); } finally { clearTimeout(timer); }
  // 「活回合」那份对象的头字段是旧的,它与读改写谁后落盘谁赢(那是活回合一侧既有守卫的事,不归这里);
  // 这里只钉:全部跑完之后两条链都还通,再来一发读改写与元数据补丁照常落盘。
  await mutateSession(id, x => { x.todos = [{ content: 'after', status: 'pending' }]; }, { writer: 'test' });
  await updateSessionMeta(id, { title: 'after' });
  const disk = await loadSession(id);
  assert.deepEqual(disk.todos, [{ content: 'after', status: 'pending' }]);
  assert.equal(disk.title, 'after');
  assert.ok(disk.messages.some(m => m.content === 'live9'), '活回合那一侧的消息也在');
});

function driverMission() {
  return {
    goal: 'g', autoMode: 'until-done', milestones: [{ id: 'm1', desc: 'd', status: 'pending', check: null, evidence: '' }],
    budget: { maxAutoTurns: 3, maxTokens: 0 }, spent: { autoTurns: 0, tokens: 0 }, stall: { lastDigest: '', sameCount: 0 },
  };
}

test('[D1] 驱动器手里的对象是撤回之前读出来的 ⇒ 一个回合都不起', async () => {
  const id = await freshSession(6);
  const held = await loadSession(id);          // 驱动器攥着的那份
  held.mission = driverMission();
  await simulateRewind(id);                     // 撤回落在两回合之间
  assert.equal(sessionObjectIsStale(held), true, '前提:这份对象已陈旧');
  let turns = 0;
  await runMissionDriver({ session: held, config: await srv.readConfig(), provider: null, emit: () => {}, runTurn: async () => { turns += 1; held.mission.autoMode = 'off'; }, getLastTokens: null, isAlive: () => true });
  assert.equal(turns, 0, '撤回之后驱动器收手(修前照起回合)');
});

test('[D2] 对照:对象不陈旧时驱动器照常起回合', async () => {
  const id = await freshSession(4);
  const held = await loadSession(id);
  held.mission = driverMission();
  assert.equal(sessionObjectIsStale(held), false);
  let turns = 0;
  await runMissionDriver({ session: held, config: await srv.readConfig(), provider: null, emit: () => {}, runTurn: async () => { turns += 1; held.mission.autoMode = 'off'; }, getLastTokens: null, isAlive: () => true });
  assert.equal(turns, 1);
});

// Unit(107-F9a):会话索引「写盘途中读不到自己刚写的」—— 在途批次对读者可见，直到落盘。
//
// 它修的是 F8 取证到的真缺陷：flushSessionIndex 先把待写批次整个拿走、清空 pendingSessionIndex，再去写盘；
// listSessions 只把【仍在】待写表里的改动叠到盘上旧索引上。于是每次刷写的那几毫秒里，刚写的那一批既不在
// 内存待写表、也还没到盘上 —— 读到旧值。用户看得见的后果（F8 实测）：
//   · 约 200 ms 窗口内再拆一次，拆分的幂等判断读到旧值 → 建出重复的空事项（间隔阶梯 162 次里 14 次，
//     全部落在 d=182–202 ms，其外 0/148）；
//   · 事项列表聚合读到旧值 → 刚归类的线程短暂显示成「未归类」（读己之写探针空闲 20 次里 19 次跳回旧值）。
// 修法是 02-session-store.js 的 inflightSessionIndex（头注在那里）。
//
// 为什么放 unit、为什么确定性：窗口只有几毫秒，靠负载碰只能测出概率。这里用 fs/promises 的一次性卡子把
// 【带着本条改动的那一次】索引 rename 卡住 —— 此刻盘上确定是旧索引、那一批确定在途 —— 再去读。卡子只认
// tmp 文件里带着本条标记的那一发 rename，别的刷写（建会话、归一存盘各自触发的）原样放行，不会卡错人。
//
// 六条：
//   A 承重：写盘卡在途中，listSessions 读到的是刚写的新值（对照：此刻盘上确实还是旧值）；
//   B 端到端形状：卡在途中再做一次同参数的拆分 → created:false，不建第二个事项；
//   C 退出时的同步刷写（PF2 那条路）：异步那一发卡在途中时进程退出，在途那批也要写进盘；
//   D 写盘失败（索引被作废）也要撤掉在途条目，之后的读照常对（走全量扫盘）；
//   E 撤在途只撤【自己那一发】的条目：前一发落盘撤表时，不许顺手撤掉后一发对同一会话的新值；
//   F 读到一半，前一发落盘并撤了表 → 读者不许拿「落盘前的旧文件＋已撤空的在途表」拼出旧值，要重读。
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 钩子装在它的属性上
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-index-inflight-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const sessionsDir = path.join(root, 'sessions');
const indexFile = path.join(sessionsDir, 'index.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const turnOfLoop = () => new Promise(r => setImmediate(r));
const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
const FLUSH_MS = 200;   // 与 02-session-store.js 的 SESSION_INDEX_FLUSH_MS 同值

// 盘上的索引（直接读文件，不经 listSessions —— 它正是被测对象）。
function diskIndex() {
  try { const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8')); return Array.isArray(arr) ? new Map(arr.map(e => [String(e.id), e])) : null; }
  catch { return null; }
}
async function listed(id) { return (await srv.listSessions()).find(m => m.id === id) || null; }

// 等盘上索引满足条件（有界 5 秒）。只用来「等前置状态落定」，不拿它判红绿。
async function untilDisk(pred, label) {
  for (let i = 0; i < 100; i++) {
    const idx = diskIndex();
    if (idx && pred(idx)) return idx;
    await sleep(50);
  }
  throw new Error(`${label}:5 秒内盘上索引没有落到预期状态`);
}

// 造一条会话并让它【完全落定】：头已归一、索引里已有它、之后不再有它的刷写在排队。
async function seed(title) {
  const s = await srv.createSession({ title, cwd: root });
  await srv.loadSession(s.id);            // 第一次 load 会归一并顺手存一次，先在这里做掉
  await srv.listSessions();               // 索引不在就按文件重建一份
  await untilDisk(idx => idx.has(s.id) && idx.get(s.id).title === title, `seed(${title})`);
  await sleep(FLUSH_MS * 2);              // 让那一次归一存盘触发的刷写也走完（它带的是同一个标题，放行即可）
  return s.id;
}

// 在 fs/promises 的某个方法上装一次性卡子（照 session-rewind-gen.test.js 的模具）。
//   pre（默认）：命中时先报到（reached），等放行（release）后才真正调用原方法；
//   post：先调原方法拿到结果，再报到、等放行才把结果交回去 —— 用来摆「读已经读完、结果还没交回」的交错；
//   throwError：命中即抛（模拟写盘失败）。
// done：被卡的那一发原方法本身结束（成功或失败）时兑现。命中之后自动卸除，别的调用原样透传。
function hook(method, match, { post = false, throwError } = {}) {
  const original = fsp[method];
  let armed = true;
  let reachedResolve, releaseResolve, doneResolve;
  const reached = new Promise(r => { reachedResolve = r; });
  const gate = new Promise(r => { releaseResolve = r; });
  const done = new Promise(r => { doneResolve = r; });
  fsp[method] = async function (...args) {
    let hit = false;
    if (armed) { try { hit = !!match(...args); } catch { hit = false; } }
    if (!hit) return original.apply(this, args);
    armed = false;
    if (throwError) { reachedResolve(); doneResolve(); throw throwError; }
    if (post) {
      let result, error;
      try { result = await original.apply(this, args); } catch (e) { error = e; }
      doneResolve();
      reachedResolve();
      await gate;
      if (error) throw error;
      return result;
    }
    reachedResolve();
    await gate;
    try { return await original.apply(this, args); } finally { doneResolve(); }
  };
  return {
    reached, done,
    release: () => releaseResolve(),
    restore: () => { fsp[method] = original; releaseResolve(); },
  };
}
// 只认「带着本条改动的那一发」索引 rename：目标是 index.json，且 tmp 里的内容满足 carries。
function holdIndexRename(carries, opts) {
  return hook('rename', (from, to) => same(to, indexFile) && carries(JSON.parse(fs.readFileSync(from, 'utf8'))), opts);
}
const titleIs = (id, title) => arr => arr.some(e => e && e.id === id && e.title === title);

// 「在途条目已经撤掉」的可观测形状：往盘上索引里种一个别的标题（id 集不变，快路径照样信它），读到的必须是
// 种下去的那个 —— 若在途表里还挂着这条会话，叠加会把它盖回去，说明撤表漏了（在途表只增不减 = 永久遮住盘上）。
async function assertRetired(id, label) {
  const arr = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const planted = 'F9a-种下的-' + label;
  fs.writeFileSync(indexFile, JSON.stringify(arr.map(e => (e && e.id === id ? { ...e, title: planted } : e)), null, 2));
  const got = await listed(id);
  assert.equal(got && got.title, planted, `${label}:写盘结束之后在途条目必须撤掉（实得「${got && got.title}」—— 在途表里还挂着它，盖住了盘上）`);
}

// 等卡子被踩到（有界 10 秒）；不许挂死整个快通道。
async function untilReached(h, label) {
  let timer;
  try {
    await Promise.race([
      h.reached,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}:10 秒没踩到卡子（交错没摆出来）`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
// 被测的那一发若因为卡子而挂住（例如误走了要拿索引锁的扫盘重建路径），10 秒后判红，不挂死。
function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}:10 秒没返回（被卡在途的那次写盘挡住了）`)), 10000); }),
  ]).finally(() => clearTimeout(timer));
}

describe('会话索引在途批次（107-F9a）', () => {
  it('A 承重：写盘卡在途中，listSessions 读到刚写的新值', async () => {
    const id = await seed('F9a-A-旧名');
    const fresh = 'F9a-A-新名-' + Date.now();
    const h = holdIndexRename(titleIs(id, fresh));
    try {
      await srv.updateSessionMeta(id, { title: fresh });
      await untilReached(h, 'A');
      // 对照：此刻盘上确实还是旧值 —— 窗口真的摆出来了，读到新值不是因为它已经落盘。
      assert.equal(diskIndex().get(id).title, 'F9a-A-旧名', '对照：卡子放行之前，盘上索引必须还是旧名（否则窗口没摆出来）');
      const during = await bounded(listed(id), 'A');
      assert.equal(during && during.title, fresh,
        `写盘途中读到的必须是刚写的新名（实得「${during && during.title}」—— 刷写拿走了待写批次、又还没落盘，那一批对读者不可见，读己之写被破坏）`);
      h.release();
      await untilDisk(idx => idx.get(id) && idx.get(id).title === fresh, 'A 落盘');
      await h.done;
      await turnOfLoop();
      assert.equal((await listed(id)).title, fresh, '落盘并撤表之后照样读到新名（此时来自盘上）');
      await assertRetired(id, 'A');
    } finally { h.restore(); }
  });

  it('B 端到端形状：写盘卡在途中再拆一次同参数 → created:false，不建第二个事项', async () => {
    const title = 'F9a-B-拆出来的事项';
    const src = await srv.createMissionContainer({ title: 'F9a-B-源事项', cwd: root });
    assert.ok(src && src.ok, `建源事项要成功（实得 ${JSON.stringify(src)}）`);
    const m1 = src.mission.missionId;
    const sid = await seed('F9a-B-线程');
    const attached = await srv.missionAttachThread(m1, sid);
    assert.ok(attached && attached.ok && attached.changed, `归到源事项要成功（实得 ${JSON.stringify(attached)}）`);
    await untilDisk(idx => idx.get(sid) && idx.get(sid).missionId === m1, 'B 归类落盘');
    await sleep(FLUSH_MS * 2);
    // 卡住的是「把这条线程改归到新事项」的那一发（新事项 id 事先不知道：不是源事项、也不是它自己就是它）。
    const h = holdIndexRename(arr => arr.some(e => e && e.id === sid && e.missionId && e.missionId !== m1 && e.missionId !== sid));
    try {
      const split1 = await srv.missionSplitThreads(m1, [sid], title);
      assert.ok(split1 && split1.ok && split1.created === true, `第一次拆分建出新事项（实得 ${JSON.stringify(split1 && { ok: split1.ok, created: split1.created, error: split1.error })}）`);
      const m3 = split1.missionId;
      await untilReached(h, 'B');
      assert.equal(diskIndex().get(sid).missionId, m1, '对照：卡子放行之前，盘上索引里这条线程必须还归在源事项下');
      const split2 = await bounded(srv.missionSplitThreads(m1, [sid], title), 'B');
      const twins = (await srv.listMissionContainers()).filter(m => m && m.title === title && !m.archivedAt);
      assert.equal(split2 && split2.created, false,
        `写盘途中同参数再拆一次必须回 created:false（实得 created:${split2 && split2.created}、同名事项 ${twins.length} 个 —— 幂等判断读到了旧索引，建出了重复的空事项）`);
      assert.equal(split2.missionId, m3, '回的是第一次拆出来的那个事项');
      assert.equal(twins.length, 1, `同名未归档事项只有一个（实得 ${twins.length}）`);
    } finally { h.restore(); }
  });

  it('C 退出时的同步刷写：异步那一发卡在途中，在途那批也要写进盘', async () => {
    const id = await seed('F9a-C-旧名');
    const fresh = 'F9a-C-新名-' + Date.now();
    const h = holdIndexRename(titleIs(id, fresh));
    try {
      await srv.updateSessionMeta(id, { title: fresh });
      await untilReached(h, 'C');
      assert.equal(diskIndex().get(id).title, 'F9a-C-旧名', '对照：异步那一发还卡着，盘上是旧名');
      srv.flushSessionIndexSync();   // 进程退出时 exit 监听器里跑的就是它（同步 I/O，卡子管不到它）
      assert.equal(diskIndex().get(id).title, fresh,
        `同步刷写之后盘上必须是新名（实得「${diskIndex().get(id).title}」—— 在途那批已不在待写表里，同步刷写看不见它，进程一退就丢了）`);
    } finally { h.restore(); }
    await h.done;
    await turnOfLoop();
    assert.equal(diskIndex().get(id).title, fresh, '被放行的异步那一发随后落盘，结果一致（幂等）');
  });

  it('D 写盘失败（索引被作废）：在途条目照样撤掉，之后的读走扫盘、仍然是对的', async () => {
    const id = await seed('F9a-D-旧名');
    const fresh = 'F9a-D-新名-' + Date.now();
    const boom = Object.assign(new Error('injected EIO on index rename'), { code: 'EIO' });
    const h = holdIndexRename(titleIs(id, fresh), { throwError: boom });
    try {
      await srv.updateSessionMeta(id, { title: fresh });
      await untilReached(h, 'D');
    } finally { h.restore(); }
    // 写失败 → 刷写把索引作废（unlink）。等它作废完，再读：没有索引 → 按真文件扫盘。
    for (let i = 0; i < 100 && fs.existsSync(indexFile); i++) await sleep(20);
    assert.ok(!fs.existsSync(indexFile), '写盘失败之后索引被作废（下一次读走扫盘自愈）');
    const got = await listed(id);
    assert.equal(got && got.title, fresh, `扫盘读到的是会话文件里的真值（实得「${got && got.title}」）`);
    await untilDisk(idx => idx.has(id) && idx.get(id).title === fresh, 'D 重建');
    await assertRetired(id, 'D');
  });

  it('E 撤在途只撤自己那一发：前一发落盘撤表，不许撤掉后一发对同一会话的新值', async () => {
    const id = await seed('F9a-E-v0');
    const v1 = 'F9a-E-v1-' + Date.now();
    const v2 = 'F9a-E-v2-' + Date.now();
    const h1 = holdIndexRename(titleIs(id, v1));
    let h2 = null;
    try {
      await srv.updateSessionMeta(id, { title: v1 });
      await untilReached(h1, 'E 第一发');            // 第一发卡在 rename 上，手里攥着索引锁
      h2 = holdIndexRename(titleIs(id, v2));
      await srv.updateSessionMeta(id, { title: v2 });
      // 等第二发的去抖计时器触发：它把 v2 拿进在途表，然后排在索引锁后面。计时器按到期先后触发，
      // 这里的 sleep 比那个 200 ms 计时器晚设、到期更晚，所以它醒来时第二发一定已经拿走了批次。
      await sleep(FLUSH_MS * 2);
      h1.release();
      await h1.done;                                   // 第一发的 rename 落了（盘上 v1），随后它撤表
      await untilReached(h2, 'E 第二发');             // 第二发拿到锁、写到 rename 被卡住：盘上 v1，在途 v2
      assert.equal(diskIndex().get(id).title, v1, '对照：此刻盘上是第一发写的 v1');
      const during = await bounded(listed(id), 'E');
      assert.equal(during && during.title, v2,
        `第二发还在途，读到的必须是 v2（实得「${during && during.title}」—— 在途表里没有第二发的条目：第一发撤表时把它一起撤了，或在途批次根本对读者不可见）`);
      h2.release();
      await h2.done;
      await turnOfLoop();
      assert.equal(diskIndex().get(id).title, v2, '第二发随后落盘');
    } finally { h1.restore(); if (h2) h2.restore(); }
  });

  it('F 读到一半，前一发落盘并撤了表 → 不许拼出旧值，要重读', async () => {
    const id = await seed('F9a-F-旧名');
    const fresh = 'F9a-F-新名-' + Date.now();
    const hw = holdIndexRename(titleIs(id, fresh));
    let hr = null;
    try {
      await srv.updateSessionMeta(id, { title: fresh });
      await untilReached(hw, 'F 写');                 // 刷写卡在 rename 上：盘上旧名，新名在途
      // 读者的第一次 readFile 读完（拿到的是旧文件）、但结果先别交回去。
      hr = hook('readFile', p => same(p, indexFile), { post: true });
      const reading = listed(id);
      await untilReached(hr, 'F 读');
      hw.release();
      await hw.done;                                   // 新索引落盘
      await turnOfLoop();                              // 刷写的 finally 已跑：在途表撤空
      hr.release();                                    // 现在才把那份「落盘前的旧文件」交回给读者
      const got = await bounded(reading, 'F');
      assert.equal(got && got.title, fresh,
        `读者拿到的必须是新名（实得「${got && got.title}」—— 读到的是落盘前的旧文件，而能盖住差别的在途条目已经撤了，没有重读）`);
    } finally { hw.restore(); if (hr) hr.restore(); }
  });
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

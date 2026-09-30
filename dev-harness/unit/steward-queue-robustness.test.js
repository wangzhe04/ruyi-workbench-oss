'use strict';
// hunt3:管家收件箱 / 线程仲裁器 / 线程五态 / wait_agents 的四条稳健性回归。真源码、临时 HOME、不起模型。
//   [Q1] 收件箱落盘失败(有界重试之后仍失败,这里是 EIO):修前四源游标已经越过这一批,事件永远读不回来
//        (一条「需要你」的权限请求就此从收件箱消失);现在整批放回结转队列,下一拍照样入箱,inboxSeq 不留空号。
//        瞬时 EBUSY 由与 appendIntervention 同款的有界重试在同一拍里吃掉。
//   [Q2] 一条线程的回合排在仲裁器里等预算(turns_per_hour):修前五态只认 activeChildren,报「已收工」,
//        与同一份回执里的 wait(「等预算」)自相矛盾;现在 queued 证据键 -> running(卡片 / 会话头两个适配器同判)。
//   [Q3] 被预算挡住、此刻又没有任何回合在跑:修前没有人再唤醒队列(小时窗滑过去了也照样挂着);
//        现在 drain 收尾时挂一个自唤醒定时器,窗口滑过去之后放行。用 node:test 的假时钟把一小时走完。
//   [Q4] wait_agents 等一个不存在的 runId:修前把 not_found 当成「还没结算」,白白挂满整个超时;
//        现在立即返回,信封里仍标 status:'not_found',timedOut 只看活的 run。
const { test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-queue-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;

let srv = null;
// 被测代码里的定时器全是 unref 的(不拖住进程退出);修前 wait_agents 的那种「挂满超时」在没有任何活句柄时
// 会被 node:test 判成「事件循环已空、Promise 还没决议」而不是一条可读的断言失败 —— 挂一个保活句柄。
const keepAlive = setInterval(() => {}, 1000);
const INBOX = path.join(root, 'steward', 'inbox-v1.ndjson');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inboxRows = () => {
  try { return fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
};
const STEWARD_CTX = { session: { id: 'steward', kind: 'steward' }, trigger: 'user' };

before(async () => {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 7, defaultWorkspace: root, includeWorkbenchMcp: false, locale: 'zh-CN',
    stewardEnabledV1: true, stewardPollMs: 120000, stewardGlobalMaxTurnsPerHour: 1,
  }), 'utf8');
  srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
});

after(async () => {
  clearInterval(keepAlive);
  try { mock.timers.reset(); } catch { /* ignore */ }
  try { srv && srv.stopStewardInbox(); } catch { /* best-effort */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// 让 fsp.appendFile 对收件箱文件按 plan 依次失败(plan 里是错误码;用完就放行)。
function failInboxAppends(plan) {
  const orig = fsp.appendFile;
  const queue = [...plan];
  let calls = 0;
  fsp.appendFile = function (p, ...rest) {
    if (String(p) === INBOX) {
      calls += 1;
      if (queue.length) {
        const code = queue.shift();
        return Promise.reject(Object.assign(new Error(code + ': injected'), { code }));
      }
    }
    return orig.call(this, p, ...rest);
  };
  return { restore: () => { fsp.appendFile = orig; }, calls: () => calls, left: () => queue.length };
}

test('[Q4] wait_agents:不存在的 runId 立即返回,不挂满超时', async () => {
  const t0 = Date.now();
  const out = await srv.waitForAgentRunResults('sess_aaaaaaaaaaaaaaaa', ['run_doesnotexist'], 3000, null);
  const took = Date.now() - t0;
  assert.ok(took < 1500, `立即返回(实测 ${took} ms;修前挂满 3000 ms)`);
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].status, 'not_found', '信封里如实标 not_found');
  assert.equal(out.settled, false, 'settled 口径不变:not_found 不算结果到手');
  assert.equal(out.timedOut, false, 'timedOut 只看活的 run');
});

test('[Q1] 收件箱落盘失败:事件不丢,下一拍照样入箱;瞬时 EBUSY 同一拍重试吃掉', async () => {
  const cfg = await srv.readConfig();
  const s = await srv.createSession({ title: 'watched thread', cwd: root });
  s.launchedBy = 'steward'; s.createdBy = 'steward'; s.kind = 'mission';
  await srv.saveSession(s);
  await srv.startStewardInbox(cfg);                      // 第一拍:冷启动只建基线
  const base = inboxRows().length;

  srv.registerIntervention(s.id, 'permission', 'perm_q1_0001', { toolName: 'file_write', tier: 'edit', input: { path: 'x.txt' } });
  await sleep(200);
  const inj = failInboxAppends(['EIO']);
  try { await srv.startStewardInbox(cfg); } finally { inj.restore(); }   // 幂等 start = 补一拍
  assert.equal(inj.left(), 0, '前提:这一拍的落盘确实失败了');
  assert.equal(inboxRows().length, base, '失败那一拍箱子里没有新行');
  await srv.startStewardInbox(cfg);                      // 磁盘恢复后的下一拍
  const after1 = inboxRows().slice(base);
  assert.equal(after1.length, 1, `下一拍补进来了(修前 0 行):${JSON.stringify(after1.map(r => r.kind))}`);
  assert.equal(after1[0].kind, 'needs_you');
  assert.equal(after1[0].sessionId, s.id);
  const prevSeq = base ? Number(inboxRows()[base - 1].inboxSeq) : 0;
  assert.equal(Number(after1[0].inboxSeq), prevSeq + 1, 'inboxSeq 退回了失败那一批,不留空号');
  await srv.startStewardInbox(cfg);
  assert.equal(inboxRows().length, base + 1, '不重复入箱');

  // 瞬时锁:两次 EBUSY 之后放行 —— 同一拍里就落盘了(有界重试)。
  srv.registerIntervention(s.id, 'permission', 'perm_q1_0002', { toolName: 'file_write', tier: 'edit', input: { path: 'y.txt' } });
  await sleep(200);
  const busy = failInboxAppends(['EBUSY', 'EBUSY']);
  try { await srv.startStewardInbox(cfg); } finally { busy.restore(); }
  assert.equal(busy.left(), 0);
  assert.ok(busy.calls() >= 3, `重试了(appendFile 调用 ${busy.calls()} 次)`);
  assert.equal(inboxRows().length, base + 2, '同一拍里就进了箱');
  srv.stopStewardInbox();
});

let queuedThread = null;
test('[Q2] 回合排在仲裁器里等预算:五态 running(不再说已收工)', async () => {
  const H = srv.StewardHooks;
  const cfg = await srv.readConfig();
  assert.equal(cfg.stewardGlobalMaxTurnsPerHour, 1, '前提:全局每小时 1 个回合');
  const s = await srv.createSession({ title: 'resumed thread', cwd: root });
  s.turnSeq = 1;
  s.launchedBy = 'steward';
  s.messages = [
    { role: 'user', content: 'hi', turnSeq: 1, createdAt: new Date().toISOString() },
    { role: 'assistant', content: 'ok', turnSeq: 1, createdAt: new Date().toISOString() },
  ];
  await srv.saveSession(s);
  queuedThread = s;

  const before1 = await srv.toolCall('steward_thread_status', { sessionId: s.id }, STEWARD_CTX);
  assert.equal(before1.state, 'done', '前提:跑过一个回合、此刻空闲的线程是 done');

  // 烧掉本小时的预算,然后给这条线程续一个回合:它排在队里等预算。
  const a = await H.acquireTurnSlot({ sessionId: 'sess_aaaaaaaaaaaaaaaa', cwd: path.join(root, 'a'), config: cfg });
  assert.equal(a.granted, true);
  a.release();
  let bDone = false;
  const bp = H.acquireTurnSlot({ sessionId: s.id, cwd: root, config: cfg, title: s.title }).then(r => { bDone = true; return r; });
  try {
    await sleep(300);
    assert.equal(bDone, false, '前提:被预算挡着');
    assert.equal((H.arbiterWait(s.id) || {}).budget && H.arbiterWait(s.id).budget.axis, 'turns_per_hour');

    const st = await srv.toolCall('steward_thread_status', { sessionId: s.id }, STEWARD_CTX);
    assert.equal(st.wait && st.wait.reason, 'budget', '回执的 wait 说在等预算');
    assert.equal(st.state, 'running', `五态不再说已收工(修前 ${st.state}/${st.stateLabel})`);
    assert.equal(st.stateSources.queued, true, 'queued 证据键进了 sources');
    const head = await srv.readSessionHeadResilient(s.id);
    assert.equal(srv.stewardThreadStateFromHead(head, { kind: 'mission' }).state, 'running', '会话头适配器同判');
    assert.equal(srv.stewardThreadStateFromCard({ status: 'none', turnSeq: 1, queued: true, mission: {} }).state, 'running', '卡片适配器同判');
  } finally {
    // 撤出队列(撤走最后一条时自唤醒定时器一并撤掉),留给 [Q3] 一个干净的队列。
    H.cancelQueuedTurn(s.id);
    const bRes = await bp;
    assert.equal(bRes.granted, false);
    await sleep(100);
  }
  const head2 = await srv.readSessionHeadResilient(s.id);
  assert.equal(srv.stewardThreadStateFromHead(head2, { kind: 'mission' }).state, 'done', '撤出队列之后回到 done');
});

test('[Q3] 被预算挡着、没有回合在跑:窗口滑过去之后自己放行', async () => {
  const H = srv.StewardHooks;
  const cfg = await srv.readConfig();
  const s = queuedThread;
  assert.ok(s, '前提:[Q2] 建好了线程并烧掉了本小时的预算');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let cDone = false;
  let cRes = null;
  try {
    H.acquireTurnSlot({ sessionId: s.id, cwd: root, config: cfg, title: s.title }).then(r => { cDone = true; cRes = r; });
    const spin = async (n, until) => { for (let i = 0; i < n && !until(); i++) await new Promise(r => setImmediate(r)); };
    await spin(2000, () => !!H.arbiterWait(s.id) && !!H.arbiterWait(s.id).budget);
    assert.ok(H.arbiterWait(s.id) && H.arbiterWait(s.id).budget, '前提:被预算挡着(没有任何回合在跑)');
    mock.timers.tick(30 * 60 * 1000);              // 半小时:窗口还没滑过去
    await spin(2000, () => cDone);
    assert.equal(cDone, false, '半小时时还不该放行');
    mock.timers.tick(31 * 60 * 1000);              // 再过 31 分钟:烧预算的那一笔滑出了小时窗
    await spin(5000, () => cDone);
    assert.equal(cDone, true, '窗口滑过去之后自己放行(修前没人唤醒,永远挂着)');
    assert.equal(cRes && cRes.granted, true);
  } finally {
    mock.timers.reset();
    if (cRes && cRes.release) cRes.release();
    else H.cancelQueuedTurn(s.id);
  }
});

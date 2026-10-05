'use strict';
// 走查修复:调度器(13s)/ 管家定时工具(13t)/ 管家运行态(13l)/ 调度内核(06j)/ 回合入口(10)。
// 真源码、临时 HOME、假时钟(WCW_SCHEDULER_CLOCK_FILE)、进程内假 provider;六条 API 由进程内裸 http 壳交给
// handleSchedulerApiRoutes,管家工具经 srv.toolCall 直调(合成管家 ctx)。「立即运行」(run-now)是触发入口,不等 tick。
//
//   [U1] 任务表读不出来(tasks-v1.json 在、持续 EBUSY):管家的五个定时工具(list/create/pause/resume/run_now/delete)修前照常
//        回 ok + 空表 / not_found / 假成功;现在回 scheduler.unavailable、盘上不动;锁放开后正常。
//   [U2] 暂停后恢复要按「此刻」重算 nextFireAt(HTTP PATCH 与管家 resume 两条路):修前停在暂停时的旧时点上,恢复后第一拍补跑
//        暂停期间的时点或记一条没人错过的 skipped。
//   [U3] 无人值守等批准不被超时吃掉:批准窗口与回合超时同量级时,修前超时计时器先到、记 failed/timeout,needs_you 走不到;
//        现在待批的区间不计进超时 → needs_you。真超时(慢回合)照旧 failed/timeout。
//   [U4] 回合在 13n 仲裁器里排队超过超时:修前 stopSession 拿不到活回合、计时器作废,回合排到后照跑却记 failed/timeout;
//        现在计时器把它撤出队列、记 skipped/queue_timeout(不计连败、什么都没跑)。
//   [U5] 两条定时任务同刻指向同一条既有线程:修前后一个把前一个顶掉(同源不算忙),前一个消息丢了仍记 succeeded;
//        现在后来者 409 → skipped/target_busy,前一个照常跑完,它的无人值守等待窗口也没被后来者的收尾删掉。
//   [U6] steward_runs_status 的 nodes.done 数成功态('succeeded'),修前数 'done'(节点没有这个值)恒为 0。
//   [U7] 06j 内核:policy.onFailure 'retry-once'(无人实现)归一回 notify;错误信息不再带内部文档号 / 波次。
//
// 测试旗:WCW_SCHEDULER_ASK_WAIT_MS / WCW_SCHEDULER_TIMEOUT_MS 在用例里临时设置,用完还原。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, toolCallFrames } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-review-'));
const CLOCK = path.join(root, 'clock.txt');
let clock = new Date(2026, 4, 4, 8, 0, 0).getTime();
const setClock = ms => { clock = ms; fs.writeFileSync(CLOCK, String(Math.round(ms)), 'utf8'); };
setClock(clock);
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.WCW_SCHEDULER_CLOCK_FILE = CLOCK;
process.env.WCW_SCHEDULER_TICK_MS = '40';
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { handleSchedulerApiRoutes, stopScheduler, normalizeSchedulerTask } = srv;

const TASKS = path.join(root, 'scheduler', 'tasks-v1.json');
const FIRES = path.join(root, 'scheduler', 'fires-v1.ndjson');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = (ms, value = null) => new Promise(r => { const t = setTimeout(() => r(value), ms); if (t.unref) t.unref(); });

let gateRelease = null;
let gate = null;
function armGate() { gate = new Promise(r => { gateRelease = r; }); }
armGate();
let fake = null;
let server = null;
let base = '';

async function api(method, p, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  const res = await fetch(base + p, { method, headers: data ? { 'content-type': 'application/json' } : {}, body: data || undefined });
  let json = null; try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
function fires() {
  try { return fs.readFileSync(FIRES, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}
const reconciledOf = id => fires().filter(f => f.taskId === id && f.phase === 'reconciled');
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(40); }
  return null;
}
const taskOf = async id => ((await api('GET', '/api/scheduler/tasks')).json.tasks || []).find(t => t.id === id);
const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });
const tool = (name, args) => srv.toolCall(name, args, stewardCtx());
const userTextOf = rq => rq.messages.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
// 临时设环境变量(测试旗),返回还原函数。
function withEnv(vars) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = String(v); }
  return () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test('setup', async () => {
  fake = await startFakeProvider({
    async handler(rq) {
      const text = userTextOf(rq);
      if (text.includes('GATED')) await gate;
      if (text.includes('SLOWTURN')) await sleep(4000);
      // 要批准的那一类:default 档下 file_write 判 ask(目标线程的工作目录就是 root,绝对路径在工作区内)。
      if (text.includes('TOOLCALL') && !rq.messages.some(m => m.role === 'tool')) return toolCallFrames('file_write', { path: path.join(root, 'ask.txt'), content: 'x' }, 'call_ask');
      return textFrames('ok');
    },
  });
  fs.mkdirSync(path.join(root, 'Ruyi'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false },
    includeWorkbenchMcp: false, schedulerEnabledV1: true,
    // 管家工具要开着管家(13g 门控壳);回合入口的仲裁器(13n)也只在管家开着时生效。
    stewardEnabledV1: true, stewardThreadBriefV1: false, stewardPollMs: 120000, stewardWorkspaceRoot: path.join(root, 'Ruyi'),
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }), 'utf8');
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    Promise.resolve(handleSchedulerApiRoutes(req, res, pathname)).then(() => {
      if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
    }, err => { res.writeHead(500); res.end(JSON.stringify({ error: String(err && err.message) })); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

/* ═══════════════ [U1] 任务表读不出来:管家定时工具不再假装成功 ═══════════════ */
test('[U1] 任务表读不出来:六个定时工具回 scheduler.unavailable、盘上不动;锁放开后正常', async () => {
  fs.mkdirSync(path.dirname(TASKS), { recursive: true });
  const original = JSON.stringify({
    schema: 1, globalRuns: { date: '', count: 0 },
    tasks: [{ id: 'sch_disk_good', title: '盘上那条', schedule: { kind: 'daily', at: '21:00' }, payload: { kind: 'reminder', text: 'hi' }, state: { enabled: true } }],
  }, null, 2);
  fs.writeFileSync(TASKS, original, 'utf8');
  const orig = fsp.readFile;
  fsp.readFile = async function (p, ...rest) {
    if (String(p) === TASKS) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return orig.call(this, p, ...rest);
  };
  try {
    const calls = [
      ['steward_schedule_list', {}],
      ['steward_schedule_create', { title: 'x', schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: 'x' } }],
      ['steward_schedule_pause', { id: 'sch_disk_good' }],
      ['steward_schedule_resume', { id: 'sch_disk_good' }],
      ['steward_schedule_run_now', { id: 'sch_disk_good' }],
      ['steward_schedule_delete', { id: 'sch_disk_good' }],
    ];
    for (const [name, args] of calls) {
      const r = await tool(name, args);
      assert.ok(r && r.ok === false && r.error === 'scheduler.unavailable',
        `${name}:表读不出来时要答 scheduler.unavailable(修前回 ok/空表/not_found),实得 ${JSON.stringify(r).slice(0, 200)}`);
      assert.match(String(r.message), /读不出来/, `${name}:有一句人话`);
    }
    assert.equal(fs.readFileSync(TASKS, 'utf8'), original, '盘上的任务表一个字节都没动');
  } finally { fsp.readFile = orig; }
  const listed = await tool('steward_schedule_list', {});
  assert.ok(listed && listed.ok === true && listed.tasks.some(t => t.id === 'sch_disk_good'), '锁放开之后装载成功,列表里有盘上那条:' + JSON.stringify(listed).slice(0, 200));
  const gone = await tool('steward_schedule_delete', { id: 'sch_disk_good' });
  assert.ok(gone && gone.ok === true, '锁放开后删除照常:' + JSON.stringify(gone).slice(0, 200));
});

/* ═══════════════ [U2] 暂停后恢复重算 nextFireAt ═══════════════ */
test('[U2] 暂停后恢复:nextFireAt 按此刻重算(HTTP PATCH 与管家 resume),不补跑暂停期间的时点', async () => {
  const nextFiveAm = afterMs => {
    const d = new Date(afterMs);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0).getTime();
    if (t <= afterMs) t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 5, 0, 0, 0).getTime();
    return t;
  };
  setClock(new Date(2026, 4, 4, 8, 0, 0).getTime());
  // ── HTTP 一路 ──
  const c = await api('POST', '/api/scheduler/tasks', { title: 'pause-http', schedule: { kind: 'daily', at: '05:00' }, payload: { kind: 'reminder', text: 'p' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.task.id;
  const staleNext = Date.parse(c.json.task.nextRunAt);
  assert.equal(staleNext, nextFiveAm(clock), '前提:建的时候下一次是明早 5 点');
  assert.equal((await api('PATCH', '/api/scheduler/tasks/' + id, { enabled: false })).status, 200);
  setClock(new Date(2026, 4, 9, 12, 0, 0).getTime());   // 暂停了五天
  const resumed = await api('PATCH', '/api/scheduler/tasks/' + id, { enabled: true });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  assert.equal(Date.parse(resumed.json.task.nextRunAt), nextFiveAm(clock), '恢复后下一次是【此刻之后】的 5 点,不是暂停时的旧时点 ' + resumed.json.task.nextRunAt);
  assert.ok(Date.parse(resumed.json.task.nextRunAt) > clock);
  // 没改计划、没暂停的 PATCH(改标题)仍保住盘上的 nextFireAt。
  const renamed = await api('PATCH', '/api/scheduler/tasks/' + id, { title: 'pause-http-2' });
  assert.equal(Date.parse(renamed.json.task.nextRunAt), nextFiveAm(clock), '改标题不推下一次');
  await sleep(300);
  assert.equal(fires().filter(f => f.taskId === id).length, 0, '恢复后没有任何补跑 / 错过记录(修前第一拍就补跑暂停期间的时点)');
  await api('DELETE', '/api/scheduler/tasks/' + id);

  // ── 管家工具一路 ──
  setClock(new Date(2026, 4, 4, 8, 0, 0).getTime());
  const created = await tool('steward_schedule_create', { title: 'pause-tool', schedule: { kind: 'daily', at: '05:00' }, payload: { kind: 'reminder', text: 'p' } });
  assert.ok(created && created.ok, JSON.stringify(created).slice(0, 300));
  const tid = created.task.id;
  assert.ok((await tool('steward_schedule_pause', { id: tid })).ok);
  setClock(new Date(2026, 4, 9, 12, 0, 0).getTime());
  const back = await tool('steward_schedule_resume', { id: tid });
  assert.ok(back && back.ok === true, JSON.stringify(back).slice(0, 300));
  assert.equal(Date.parse(back.task.nextRunAt), nextFiveAm(clock), '管家 resume 同样按此刻重算:' + back.task.nextRunAt);
  await sleep(300);
  assert.equal(fires().filter(f => f.taskId === tid).length, 0, '管家 resume 之后也没有补跑');
  await api('DELETE', '/api/scheduler/tasks/' + tid);
});

/* ═══════════════ [U3] 等批准不被回合超时吃掉 ═══════════════ */
test('[U3] 无人值守等批准:批准窗口与回合超时同量级时仍记 needs_you,不是 failed/timeout;慢回合照旧超时', async () => {
  setClock(new Date(2026, 4, 4, 8, 0, 0).getTime());
  // 批准窗口 1500ms、回合超时 1500ms:批准在回合起手后才发起,窗口必然晚于超时到期 —— 修前超时先到。
  const restore = withEnv({ WCW_SCHEDULER_ASK_WAIT_MS: 1500, WCW_SCHEDULER_TIMEOUT_MS: 1500 });
  try {
    const holder = await srv.createSession({ title: 'ask holder', cwd: root });
    await srv.saveSession(holder);
    const c = await api('POST', '/api/scheduler/tasks', {
      title: 'ask-vs-timeout', schedule: { kind: 'daily', at: '06:00' }, payload: { kind: 'prompt', text: 'TOOLCALL 写一个文件' },
      target: { mode: 'existing-session', sessionId: holder.id }, autonomy: { permissionMode: 'default' },
    });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const id = c.json.task.id;
    const ran = await Promise.race([api('POST', '/api/scheduler/tasks/' + id + '/run-now', {}), deadline(15000)]);
    assert.ok(ran && ran.status === 200, '前提:run-now 返回了');
    const row = reconciledOf(id)[0];
    assert.ok(row, '有 reconciled 行');
    assert.equal(row.outcome, 'needs_you', `等批准到时被拒 → needs_you(修前 failed/timeout);实得 ${row.outcome}/${row.error}`);
    assert.equal(row.error, 'permission_denied');
    assert.ok(!fs.existsSync(path.join(root, 'ask.txt')), '到时是拒,文件没被写出来');
    const t = await taskOf(id);
    assert.equal(t.state.consecutiveFailures, 0, '不计连败(修前三次就熔断停用)');
    await api('DELETE', '/api/scheduler/tasks/' + id);

    // 对照:回合真的慢(provider 睡 4 秒),超时照旧叫停 → failed/timeout。
    const slow = await api('POST', '/api/scheduler/tasks', { title: 'really-slow', schedule: { kind: 'daily', at: '07:00' }, payload: { kind: 'prompt', text: 'SLOWTURN 慢慢来' } });
    const sid = slow.json.task.id;
    const t0 = Date.now();
    const slowRan = await Promise.race([api('POST', '/api/scheduler/tasks/' + sid + '/run-now', {}), deadline(15000)]);
    assert.ok(slowRan && slowRan.status === 200);
    assert.ok(Date.now() - t0 < 3800, `超时把回合叫停了,没有等满 provider 的 4 秒(实测 ${Date.now() - t0}ms)`);
    const slowRow = reconciledOf(sid)[0];
    assert.equal(slowRow.outcome, 'failed');
    assert.equal(slowRow.error, 'timeout', '活回合超时仍记 failed/timeout');
    await api('DELETE', '/api/scheduler/tasks/' + sid);
  } finally { restore(); }
});

/* ═══════════════ [U4] 仲裁器里排队超时 ═══════════════ */
test('[U4] 回合在仲裁器里排队超过超时:撤出队列、记 skipped/queue_timeout、不计连败、没有跑过', async () => {
  setClock(new Date(2026, 4, 4, 8, 0, 0).getTime());
  armGate();
  await srv.mutateConfig(cfg => { cfg.stewardMaxParallelThreads = 1; });
  const U = await srv.createSession({ title: 'user hog', cwd: root });
  await srv.saveSession(U);
  const hog = srv.runSessionTurn({ sessionId: U.id, message: 'GATED 占着唯一的并发位', source: 'http', onEvent: () => {} });
  const restore = withEnv({ WCW_SCHEDULER_TIMEOUT_MS: 700 });
  let id = '';
  try {
    assert.ok(await waitFor(() => fake.requests.some(r => userTextOf(r).includes('占着唯一的并发位')), 8000), '前提:占位的回合已经在 provider 里挂着');
    const c = await api('POST', '/api/scheduler/tasks', { title: 'queued', schedule: { kind: 'daily', at: '08:30' }, payload: { kind: 'prompt', text: 'QUEUED-NEVER-RUNS 这条不该跑' } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    id = c.json.task.id;
    const before = Number(((await taskOf(id)).state.runsToday || {}).count) || 0;
    const ran = await Promise.race([api('POST', '/api/scheduler/tasks/' + id + '/run-now', {}), deadline(10000)]);
    assert.ok(ran && ran.status === 200, '排队超时后 run-now 返回了(修前一直挂到占位的回合放行)');
    assert.equal(ran.json.outcome, 'skipped', `实得 ${ran.json.outcome}`);
    const row = reconciledOf(id)[0];
    assert.equal(row.outcome, 'skipped');
    assert.equal(row.error, 'queue_timeout');
    const t = await taskOf(id);
    assert.equal(t.state.consecutiveFailures, 0, '不计连败');
    assert.equal(t.enabled, true);
    assert.equal(Number((t.state.runsToday || {}).count) || 0, before, '什么都没跑,当日计数退回');
    // 放行占位回合之后,被撤的那条也不会「排到了照跑」。
    gateRelease();
    await Promise.race([hog.catch(() => null), deadline(15000)]);
    await sleep(500);
    assert.ok(!fake.requests.some(r => userTextOf(r).includes('QUEUED-NEVER-RUNS')), '被撤出队列的回合一次 provider 请求都没发过');
  } finally {
    restore();
    gateRelease();
    await srv.mutateConfig(cfg => { delete cfg.stewardMaxParallelThreads; });
    if (id) await api('DELETE', '/api/scheduler/tasks/' + id);
  }
});

/* ═══════════════ [U5] 同刻两条任务指向同一既有线程 ═══════════════ */
test('[U5] 两条定时任务同刻指向同一条既有线程:后来者 skipped/target_busy,前一个照常跑完且等待窗口还在', async () => {
  setClock(new Date(2026, 4, 4, 8, 0, 0).getTime());
  armGate();
  const S = await srv.createSession({ title: 'shared thread', cwd: root });
  await srv.saveSession(S);
  const mk = async (title, text) => {
    const c = await api('POST', '/api/scheduler/tasks', { title, schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text }, target: { mode: 'existing-session', sessionId: S.id } });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    return c.json.task.id;
  };
  const a = await mk('first', 'GATED scheduled-first');
  const b = await mk('second', 'scheduled-second');
  const runA = api('POST', '/api/scheduler/tasks/' + a + '/run-now', {});
  try {
    assert.ok(await waitFor(() => fake.requests.some(r => userTextOf(r).includes('scheduled-first')), 8000), '前提:A 的回合已经在 provider 里挂着');
    assert.ok(srv.schedulerAskWaitSessions.get(S.id) > 0, '前提:A 的无人值守等待窗口在表里');
    const ranB = await Promise.race([api('POST', '/api/scheduler/tasks/' + b + '/run-now', {}), deadline(10000)]);
    assert.ok(ranB && ranB.status === 200, 'B 的 run-now 返回了');
    assert.equal(ranB.json.outcome, 'skipped', `B 不能顶掉 A(修前 succeeded、A 的消息丢了);实得 ${ranB.json.outcome}`);
    const rowB = reconciledOf(b)[0];
    assert.equal(rowB.error, 'target_busy');
    assert.equal((await taskOf(b)).state.consecutiveFailures, 0);
    assert.ok(srv.schedulerAskWaitSessions.get(S.id) > 0, 'B 被挡回去的收尾没有把 A 正在用的等待窗口删掉');
    assert.ok(!fake.requests.some(r => userTextOf(r).includes('scheduled-second')), 'B 的消息一个字都没发给模型');
  } finally {
    gateRelease();
  }
  const doneA = await Promise.race([runA, deadline(15000)]);
  assert.ok(doneA && doneA.status === 200, 'A 收尾了');
  assert.equal(doneA.json.outcome, 'succeeded', `A 的回合没被顶掉,照常跑完(实得 ${doneA.json.outcome})`);
  const head = await srv.loadSession(S.id);
  const texts = head.messages.map(m => String(m.content || ''));
  assert.ok(texts.some(x => x.includes('scheduled-first')), 'A 的消息在线程里');
  assert.ok(!texts.some(x => x.includes('scheduled-second')), 'B 的消息不在线程里');
  assert.ok(!srv.schedulerAskWaitSessions.has(S.id), 'A 收尾后窗口照常清掉');
  for (const id of [a, b]) await api('DELETE', '/api/scheduler/tasks/' + id);
});

/* ═══════════════ [U6] steward_runs_status 的节点完成数 ═══════════════ */
test('[U6] steward_runs_status:nodes.done 数成功态(节点成功终态叫 succeeded)', async () => {
  const S = await srv.createSession({ title: 'runs holder', cwd: root });
  S.kind = 'mission';
  await srv.saveSession(S);
  const run = {
    schemaVersion: 4, id: 'run_' + 'a1b2c3d4e5f6a7b8', sessionId: S.id, status: 'partial', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    taskPool: [], messages: [],
    nodes: [
      { id: 'n1', status: 'succeeded' }, { id: 'n2', status: 'succeeded' }, { id: 'n3', status: 'failed' },
      { id: 'n4', status: 'running' }, { id: 'n5', status: 'waiting_resource' }, { id: 'n6', status: 'skipped' },
    ],
  };
  await srv.saveAgentRun(run);
  const r = await tool('steward_runs_status', { sessionId: S.id });
  assert.ok(r && r.ok === true && Array.isArray(r.runs), JSON.stringify(r).slice(0, 300));
  const row = r.runs.find(x => x.runId === run.id);
  assert.ok(row, '读到了刚存的 run:' + JSON.stringify(r).slice(0, 300));
  assert.deepEqual(row.nodes, { total: 6, done: 2, failed: 1, running: 2 }, '2 个成功、1 个失败、2 个在跑/等锁(修前 done 恒为 0)');
});

/* ═══════════════ [U7] 06j 内核:onFailure 与错误话术 ═══════════════ */
test('[U7] 06j:onFailure 只认 notify(retry-once 无人实现,回落);错误信息不带内部文档号 / 波次', () => {
  const base = { title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' } };
  const retry = normalizeSchedulerTask({ ...base, policy: { onFailure: 'retry-once' } }, Date.now());
  assert.equal(retry.ok, true);
  assert.equal(retry.task.policy.onFailure, 'notify', 'retry-once 没有实现,归一回它实际的行为 notify');
  assert.equal(normalizeSchedulerTask({ ...base, policy: { onFailure: 'notify' } }, Date.now()).task.policy.onFailure, 'notify');
  const badKind = normalizeSchedulerTask({ ...base, payload: { kind: 'playbook', text: 'x' } }, Date.now());
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, 'invalid_request');
  assert.match(badKind.message, /payload\.kind must be one of reminder\/prompt/);
  const forbidden = normalizeSchedulerTask({ ...base, payload: { kind: 'prompt', text: 'x', env: { A: '1' } } }, Date.now());
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.code, 'payload_forbidden_key');
  assert.match(forbidden.message, /payload must not carry env/);
  for (const bad of [badKind, forbidden]) {
    assert.ok(!/号文|wave\s*\d+|§/.test(bad.message), '返回给模型 / API 的话不带内部文档号与波次:' + bad.message);
  }
});

test('teardown', async () => {
  stopScheduler();
  try { gateRelease(); } catch { /* ignore */ }
  await new Promise(r => server.close(r));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await fake.close();
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

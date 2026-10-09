'use strict';
// hunt2(persist):调度器 13s 的四条缺陷。真源码、临时 HOME、假时钟(WCW_SCHEDULER_CLOCK_FILE)、进程内假 provider;
// 六条 API 由进程内一个裸 http 壳直接交给导出的 handleSchedulerApiRoutes(鉴权属于路由表,不在本件的判据里)。
//
//   [S1] P6 任务表【在】但读不出来(持续 EBUSY):修前答成「没有任务表」按空表启动,下一次写盘冲掉用户全部任务。
//        现在 startScheduler 不起、API 回 503、盘上一字节不动;锁放开后路由闸装载成功并补起调度器。
//   [S2] P6 归一化不过的行(这一版读不懂的定义)不调度,但写盘时原样带回去(修前下一次写盘就删掉)。
//   [S3] P1 回合在飞时 PATCH 任务:修前 PATCH 换了对象,在飞那次把 inFlightRunId 清在旧对象上 ——
//        新对象永远「在跑」(run-now 永远 409、tick 永远跳过)。现在收尾后 inFlightRunId 清空、再跑一次 200。
//   [S4] P10 run-now 不再拿住 tick 锁:手动那一次回合挂着的时候,别的任务照常到点派单、跑完。
//   [S5] P5 进程一直活着、时钟跳过去(睡眠唤醒)的错过:onMissed:'skip' / 超出 graceMinutes ⇒ 记 skipped、
//        不派单、推进 nextRunAt(修前晚 11 小时仍记 ontime 照跑);默认策略宽限内 ⇒ 以 late 补跑一次。
//   [S6] hunt3 登记之后任何一步抛错(这里是 fires-v1.ndjson 一次 EIO):修前异常冒出去只落一条日志,inFlightRunId
//        永远挂着、没有 reconciled 行、nextRunAt 不动 —— tick 永远跳过它、run-now 永远 409。现在按 failed 收尾。
//   [S7] hunt3 运行中把 schedulerEnabledV1 关掉:修前 interval 照跑、到点照派;现在关着就不派,再打开接着走。
//   [S8] hunt3 目标线程正被别处的回合占着(SESSION_TURN_BUSY_ELSEWHERE):修前记 failed、计入连败(3 次熔断停用);
//        现在记 skipped/target_busy,连败不动,不往那条线程的会话头上记管家末回合。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-persist-'));
const CLOCK = path.join(root, 'clock.txt');
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
let clock = new Date(2026, 4, 4, 8, 0, 0).getTime();
const setClock = ms => { clock = ms; fs.writeFileSync(CLOCK, String(Math.round(ms)), 'utf8'); };
setClock(clock);
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.WCW_SCHEDULER_CLOCK_FILE = CLOCK;
process.env.WCW_SCHEDULER_TICK_MS = '40';
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { handleSchedulerApiRoutes, startScheduler, stopScheduler, schedulerRuntimeSnapshot, readConfig } = srv;

const TASKS = path.join(root, 'scheduler', 'tasks-v1.json');
const FIRES = path.join(root, 'scheduler', 'fires-v1.ndjson');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

// 假 provider:用户消息里带 GATED 的回合挂在闸上,直到测试放行;其余立刻答。
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
async function waitFor(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(40); }
  return null;
}
const taskOf = async id => ((await api('GET', '/api/scheduler/tasks')).json.tasks || []).find(t => t.id === id);

test('setup', async () => {
  fake = await startFakeProvider({
    async handler(rq) {
      if (rq.messages.some(m => String(m.content).includes('GATED'))) await gate;
      return textFrames('ok');
    },
  });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false },
    schedulerEnabledV1: true, stewardEnabledV1: false, stewardThreadBriefV1: false,
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

const GOOD_ROW = {
  id: 'sch_disk_good', title: '盘上那条', schedule: { kind: 'daily', at: '21:00' },
  payload: { kind: 'reminder', text: 'hi' }, state: { enabled: true },
};
const BAD_ROW = { id: 'sch_disk_future', title: '更新的版本写的', schedule: { kind: 'lunar', at: '??' }, payload: { kind: 'reminder', text: 'x' } };

test('[S1] 任务表读不出来:不起、503、盘上不动;锁放开后补起', async () => {
  fs.mkdirSync(path.dirname(TASKS), { recursive: true });
  const original = JSON.stringify({ schema: 1, globalRuns: { date: '', count: 0 }, tasks: [GOOD_ROW, BAD_ROW] }, null, 2);
  fs.writeFileSync(TASKS, original, 'utf8');
  const orig = fsp.readFile;
  fsp.readFile = async function (p, ...rest) {
    if (String(p) === TASKS) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return orig.call(this, p, ...rest);
  };
  try {
    const started = await startScheduler(await readConfig());
    assert.equal(started, false, '读不出任务表时不启动');
    assert.equal(schedulerRuntimeSnapshot().started, false);
    const r = await api('GET', '/api/scheduler/tasks');
    assert.equal(r.status, 503, `API 回 503 而不是一张空表(实测 ${r.status})`);
    const w = await api('POST', '/api/scheduler/tasks', { title: 'x', schedule: { kind: 'daily', at: '10:00' }, payload: { kind: 'reminder', text: 'x' } });
    assert.equal(w.status, 503, '写接口同样拒');
    assert.equal(fs.readFileSync(TASKS, 'utf8'), original, '盘上的任务表一个字节都没动');
  } finally { fsp.readFile = orig; }
  const r = await api('GET', '/api/scheduler/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.tasks.map(t => t.id), ['sch_disk_good'], '读得懂的那条上了 API');
  assert.equal(schedulerRuntimeSnapshot().started, true, '路由闸装载成功后把调度器补起来了');
});

test('[S2] 读不懂的行写盘时原样带回去', async () => {
  const w = await api('POST', '/api/scheduler/tasks', { title: 'new', schedule: { kind: 'daily', at: '22:00' }, payload: { kind: 'reminder', text: 'n' } });
  assert.equal(w.status, 200);
  const disk = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
  const ids = disk.tasks.map(t => t.id);
  assert.ok(ids.includes('sch_disk_good') && ids.includes(w.json.task.id));
  assert.deepEqual(disk.tasks.find(t => t.id === 'sch_disk_future'), BAD_ROW, '读不懂的那行逐字段原样还在');
  for (const id of ['sch_disk_good', w.json.task.id]) await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[S3] 回合在飞时 PATCH:收尾后 inFlightRunId 清空,再跑一次不 409', async () => {
  armGate();
  const c = await api('POST', '/api/scheduler/tasks', { title: 'T', schedule: { kind: 'daily', at: '03:00' }, payload: { kind: 'prompt', text: 'GATED go' } });
  const id = c.json.task.id;
  const run = api('POST', '/api/scheduler/tasks/' + id + '/run-now', {});
  assert.ok(await waitFor(async () => { const t = await taskOf(id); return t && t.state.inFlightRunId; }), '前提:回合在飞');
  const p = await api('PATCH', '/api/scheduler/tasks/' + id, { title: 'T renamed' });
  assert.equal(p.status, 200);
  gateRelease();
  const done = await Promise.race([run, deadline(20000).then(() => null)]);
  assert.ok(done && done.status === 200 && done.json.outcome === 'succeeded', '在飞那一次正常收尾');
  const t = await taskOf(id);
  assert.equal(t.state.inFlightRunId, '', '表里的任务不再挂着 inFlightRunId');
  assert.equal(t.state.lastResult, 'succeeded');
  assert.equal(t.title, 'T renamed', 'PATCH 的改动还在');
  const disk = JSON.parse(fs.readFileSync(TASKS, 'utf8')).tasks.find(x => x.id === id);
  assert.equal(disk.state.inFlightRunId, '', '落盘的也清了(否则重启会被当成崩溃残留)');
  armGate(); gateRelease();                     // 第二次不挂
  const again = await api('POST', '/api/scheduler/tasks/' + id + '/run-now', {});
  assert.equal(again.status, 200, `第二次 run-now 不再 409(实测 ${again.status})`);
  await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[S4] run-now 挂着的时候,别的任务照常到点跑完', async () => {
  armGate();
  const a = await api('POST', '/api/scheduler/tasks', { title: 'slow', schedule: { kind: 'daily', at: '03:00' }, payload: { kind: 'prompt', text: 'GATED slow' } });
  const run = api('POST', '/api/scheduler/tasks/' + a.json.task.id + '/run-now', {});
  assert.ok(await waitFor(async () => { const t = await taskOf(a.json.task.id); return t && t.state.inFlightRunId; }), '前提:手动那一次在飞');
  const b = await api('POST', '/api/scheduler/tasks', { title: 'quick', schedule: { kind: 'cron', expr: '*/1 * * * *' }, payload: { kind: 'reminder', text: 'q' } });
  const bId = b.json.task.id;
  setClock(Date.parse(b.json.task.nextRunAt) + 1000);
  const landed = await waitFor(() => fires().some(f => f.taskId === bId && f.phase === 'reconciled'), 5000);
  assert.ok(landed, '修前 run-now 整段拿着 tick 锁,这条要等手动那一次跑完才派得出去');
  const row = fires().find(f => f.taskId === bId && f.phase === 'reconciled');
  assert.equal(row.mode, 'ontime');
  gateRelease();
  await Promise.race([run, deadline(20000)]);
  for (const id of [a.json.task.id, bId]) await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[S5] 进程活着、时钟跳过去的错过:按 onMissed / graceMinutes 判', async () => {
  const skip = await api('POST', '/api/scheduler/tasks', {
    title: 'skipme', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    policy: { onMissed: 'skip', graceMinutes: 30 },
  });
  const late = await api('POST', '/api/scheduler/tasks', {
    title: 'lateok', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'y' },
  });
  const skipId = skip.json.task.id;
  const lateId = late.json.task.id;
  const dueMs = Date.parse(skip.json.task.nextRunAt);
  setClock(dueMs + 2 * HOUR);                    // 机器睡过去,两小时后醒来(进程没重启)
  const got = await waitFor(() => {
    const rows = fires();
    return rows.some(f => f.taskId === skipId && f.phase === 'reconciled') && rows.some(f => f.taskId === lateId && f.phase === 'reconciled');
  }, 5000);
  assert.ok(got, '两条都有结论');
  const rows = fires();
  const s = rows.find(f => f.taskId === skipId && f.phase === 'reconciled');
  assert.equal(s.outcome, 'skipped', `onMissed:skip 且超出 30 分钟宽限 ⇒ skipped(实测 ${s.outcome}/${s.mode})`);
  assert.equal(s.error, 'grace_expired');
  assert.equal(s.mode, 'late');
  assert.equal(Date.parse(s.dueAt), dueMs, '记的是原本那个时点');
  assert.ok(!rows.some(f => f.taskId === skipId && f.phase === 'registered'), '跳过的那条压根没派单');
  const l = rows.find(f => f.taskId === lateId && f.phase === 'reconciled');
  assert.equal(l.mode, 'late', '默认策略(宽限 720 分钟内、run-once-late)⇒ 以 late 补跑,不再冒充 ontime');
  assert.equal(l.outcome, 'succeeded');
  const after = await taskOf(skipId);
  assert.ok(Date.parse(after.nextRunAt) > clock, 'nextRunAt 推到了「现在」之后(跳过不等于卡住)');
  await sleep(300);
  assert.equal(fires().filter(f => f.taskId === lateId && f.phase === 'registered').length, 1, '只补一次');
});

test('[S6] 登记之后一步写失败:按 failed 收尾,不再永远在飞', async () => {
  const c = await api('POST', '/api/scheduler/tasks', { title: 'eio', schedule: { kind: 'daily', at: '04:00' }, payload: { kind: 'reminder', text: 'e' } });
  const id = c.json.task.id;
  const dueMs = Date.parse(c.json.task.nextRunAt);
  const orig = fsp.appendFile;
  let failed = 0;
  fsp.appendFile = function (p, ...rest) {
    if (String(p) === FIRES && failed < 1) { failed += 1; return Promise.reject(Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' })); }
    return orig.call(this, p, ...rest);
  };
  try {
    setClock(dueMs + 1000);
    assert.ok(await waitFor(() => fires().some(f => f.taskId === id && f.phase === 'reconciled'), 5000), '有一行 reconciled(修前一行都没有)');
  } finally { fsp.appendFile = orig; }
  assert.equal(failed, 1, '前提:registered 那一行确实写失败了一次');
  const row = fires().find(f => f.taskId === id && f.phase === 'reconciled');
  assert.equal(row.outcome, 'failed');
  assert.match(String(row.error), /^dispatch_error: EIO/);
  const t = await taskOf(id);
  assert.equal(t.state.inFlightRunId, '', '内存里不再挂着 inFlightRunId');
  assert.equal(t.state.consecutiveFailures, 1, '计入连败(熔断照常兜底)');
  assert.ok(Date.parse(t.nextRunAt) > dueMs, 'nextRunAt 推进到了下一个时点');
  const disk = JSON.parse(fs.readFileSync(TASKS, 'utf8')).tasks.find(x => x.id === id);
  assert.equal(disk.state.inFlightRunId, '', '盘上也清了');
  const again = await api('POST', '/api/scheduler/tasks/' + id + '/run-now', {});
  assert.equal(again.status, 200, `之后再跑一次不 409(实测 ${again.status})`);
  assert.equal(again.json.outcome, 'succeeded');
  setClock(Date.parse(t.nextRunAt) + 1000);
  assert.ok(await waitFor(() => fires().filter(f => f.taskId === id && f.phase === 'reconciled' && f.mode === 'ontime').length === 2, 5000),
    '第二天到点照常触发(修前 tick 永远跳过它)');
  await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[S7] 运行中关掉总开关:到点不派;再打开接着走', async () => {
  const c = await api('POST', '/api/scheduler/tasks', { title: 'off', schedule: { kind: 'daily', at: '05:00' }, payload: { kind: 'reminder', text: 'o' } });
  const id = c.json.task.id;
  const dueMs = Date.parse(c.json.task.nextRunAt);
  // Hold one tick's enabled snapshot until disabling has completed. A normal
  // timer-only test misses this race unless concurrent CI load delays the read.
  await srv.mutateConfig(cfg => { cfg.schedulerEnabledV1 = true; });
  const originalRead = fsp.readFile;
  let capturedResolve;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  let releaseRead;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  fsp.readFile = async function (p, ...rest) {
    const value = await originalRead.call(this, p, ...rest);
    if (String(p) === path.join(root, 'config.json')) {
      fsp.readFile = originalRead;
      capturedResolve();
      await readGate;
    }
    return value;
  };
  try {
    assert.ok(await Promise.race([captured.then(() => true), sleep(5000).then(() => false)]), 'tick 已读到开启时的配置');
    await srv.mutateConfig(cfg => { cfg.schedulerEnabledV1 = false; });
    assert.equal((await readConfig()).schedulerEnabledV1, false, '前提:配置里已经关了');
    setClock(dueMs + 1000);
    releaseRead();
    await sleep(500);                          // 40 ms 一拍,至少十来拍
    assert.equal(fires().filter(f => f.taskId === id).length, 0, '关着的时候一行 fires 都不写(修前 registered/dispatched/reconciled 照写)');
  } finally {
    fsp.readFile = originalRead;
    releaseRead();
    await srv.mutateConfig(cfg => { cfg.schedulerEnabledV1 = true; return cfg; });
  }
  assert.ok(await waitFor(() => fires().some(f => f.taskId === id && f.phase === 'reconciled'), 5000), '再打开之后不必重启,下一拍接着派');
  await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[S8] 目标线程被别处的回合占着:skipped/target_busy,不计连败', async () => {
  armGate();
  const S = await srv.createSession({ title: 'user chat', cwd: root });
  await srv.saveSession(S);
  const c = await api('POST', '/api/scheduler/tasks', {
    title: 'poke', schedule: { kind: 'daily', at: '06:00' }, payload: { kind: 'prompt', text: 'status please' },
    target: { mode: 'existing-session', sessionId: S.id },
  });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.task.id;
  const userTurn = srv.runSessionTurn({ sessionId: S.id, message: 'GATED user is talking', source: 'http', onEvent: () => {} });
  try {
    await sleep(200);
    const before = Number(((await taskOf(id)).state.runsToday || {}).count) || 0;
    for (let i = 0; i < 3; i++) {
      const r = await api('POST', '/api/scheduler/tasks/' + id + '/run-now', {});
      assert.equal(r.status, 200);
      assert.equal(r.json.outcome, 'skipped', `第 ${i + 1} 次:忙不是失败(实测 ${r.json.outcome})`);
    }
    const rows = fires().filter(f => f.taskId === id && f.phase === 'reconciled');
    assert.equal(rows.length, 3);
    assert.ok(rows.every(f => f.outcome === 'skipped' && f.error === 'target_busy'), JSON.stringify(rows.map(f => [f.outcome, f.error])));
    const t = await taskOf(id);
    assert.equal(t.state.consecutiveFailures, 0, '连败不动(修前三次就熔断)');
    assert.equal(t.enabled, true, '没有被熔断停用');
    assert.equal(Number((t.state.runsToday || {}).count) || 0, before, '什么都没跑,当日计数退回');
    const head = await srv.readSessionHeadResilient(S.id).catch(() => null);
    assert.ok(!head || !head.stewardLastTurn, '没往用户那条线程头上记一笔管家末回合');
  } finally {
    gateRelease();
    await Promise.race([userTurn.catch(() => null), deadline(20000)]);
  }
  await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('teardown', async () => {
  stopScheduler();
  try { gateRelease(); } catch { /* ignore */ }
  await new Promise(r => server.close(r));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await fake.close();
});

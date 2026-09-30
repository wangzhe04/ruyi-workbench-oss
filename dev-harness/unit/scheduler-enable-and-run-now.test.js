'use strict';
// 调度器的两条后续修复(13s / 13t / 01 writeConfig)。真源码、临时 HOME、假时钟(WCW_SCHEDULER_CLOCK_FILE)、进程内假 provider;
// 六条 API 由进程内一个裸 http 壳交给导出的 handleSchedulerApiRoutes,管家工具经 srv.toolCall 直调(合成管家 ctx)。
//
//   [E1] 启动时 schedulerEnabledV1 关着:startScheduler 立即返回,关着的这段时间 <data>/scheduler/ 一次都不建(零持久化写入)、
//        不起 interval。
//   [E2] 之后在配置里打开(mutateConfig —— 设置页 POST /api/config 与管家改设置走的同一个写口):不重启,调度器当场起来,
//        新建的任务到点照常触发。修前 tick 只在「启动时开着」才有 interval,关着启动的进程要重启才生效。
//   [R1] steward_schedule_run_now 与 HTTP run-now 同一道【按任务】的闸:一条慢任务(手动运行、回合挂在假 provider 上)
//        在飞时,管家对【另一条】任务的「立即运行」照常跑完;tick 的到点派单也不被挡住。修前管家那一半看的是全局的
//        schedulerRuntime.ticking —— 别的任务在跑就拒(steward.busy),自己跑时整段占着 ticking,把 tick 一起挡住。
//   [R2] 对【在飞的那一条】再按「立即运行」仍然拒:管家回 steward.busy,HTTP 回 409 scheduler.busy;收尾之后再跑不拒。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-enable-'));
const CLOCK = path.join(root, 'clock.txt');
let clock = new Date(2026, 4, 4, 8, 0, 0).getTime();
const setClock = ms => { clock = ms; fs.writeFileSync(CLOCK, String(Math.round(ms)), 'utf8'); };
setClock(clock);
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.WCW_SCHEDULER_CLOCK_FILE = CLOCK;
process.env.WCW_SCHEDULER_TICK_MS = '40';
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { handleSchedulerApiRoutes, startScheduler, stopScheduler, schedulerRuntimeSnapshot, readConfig } = srv;

const SCHED_DIR = path.join(root, 'scheduler');
const FIRES = path.join(SCHED_DIR, 'fires-v1.ndjson');
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
const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });
const tool = (name, args) => srv.toolCall(name, args, stewardCtx());

test('setup', async () => {
  fake = await startFakeProvider({
    async handler(rq) {
      if (rq.messages.some(m => String(m.content).includes('GATED'))) await gate;
      return textFrames('ok');
    },
  });
  fs.mkdirSync(path.join(root, 'Ruyi'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false },
    includeWorkbenchMcp: false, schedulerEnabledV1: false,
    // 管家工具要开着管家(13g 门控壳的第一道门);定时线程的工作文件夹钉在临时 HOME 下(缺省读 os.homedir())。
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

test('[E1] 启动时关着:什么都不起、一个字节都不写', async () => {
  const cfg = await readConfig();
  assert.equal(cfg.schedulerEnabledV1, false, '前提:配置里关着');
  assert.equal(await startScheduler(cfg), false, '关着启动 → startScheduler 立即返回 false');
  const snap = schedulerRuntimeSnapshot();
  assert.equal(snap.started, false);
  assert.equal(snap.timerActive, false, '关着不起 interval');
  const r = await api('GET', '/api/scheduler/tasks');
  assert.equal(r.status, 409, '关着时路由一律 409 scheduler.disabled');
  // 关着时别的配置照常写(写口会派 config.written,开关位是 false):调度器不许被唤醒。
  await srv.mutateConfig(c => { c.stewardPollMs = 120001; });
  await sleep(300);
  assert.equal(schedulerRuntimeSnapshot().started, false, '写别的配置不唤醒调度器');
  assert.ok(!fs.existsSync(SCHED_DIR), '关着的这段时间 <data>/scheduler/ 一次都没建过(零持久化写入)');
});

test('[E2] 之后在配置里打开:不重启,调度器当场起来,新任务到点触发', async () => {
  await srv.mutateConfig(c => { c.schedulerEnabledV1 = true; });
  const up = await waitFor(() => schedulerRuntimeSnapshot().started, 5000);
  assert.ok(up, '打开之后不必重启,调度器自己起来了(修前要重启进程)');
  const c = await api('POST', '/api/scheduler/tasks', { title: 'late-enabled', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'hi' } });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const id = c.json.task.id;
  assert.equal(schedulerRuntimeSnapshot().timerActive, true, '有了任务就起 interval');
  setClock(Date.parse(c.json.task.nextRunAt) + 1000);
  assert.ok(await waitFor(() => fires().some(f => f.taskId === id && f.phase === 'reconciled'), 5000), '到点照常触发(修前 tick 从没起过,永远不触发)');
  const row = fires().find(f => f.taskId === id && f.phase === 'reconciled');
  assert.equal(row.mode, 'ontime');
  assert.equal(row.outcome, 'succeeded');
  await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('[R1][R2] 管家的「立即运行」按任务把闸:慢任务在飞不挡别的任务,也不挡 tick', async () => {
  armGate();
  const slow = await tool('steward_schedule_create', { title: 'slow', schedule: { kind: 'daily', at: '03:00' }, payload: { kind: 'prompt', text: 'GATED slow' } });
  const quick = await tool('steward_schedule_create', { title: 'quick', schedule: { kind: 'daily', at: '04:00' }, payload: { kind: 'reminder', text: 'q' } });
  assert.ok(slow && slow.ok && quick && quick.ok, JSON.stringify({ slow, quick }).slice(0, 400));
  const slowId = slow.task.id;
  const quickId = quick.task.id;
  let slowDone = false;
  const slowRun = tool('steward_schedule_run_now', { id: slowId }).then(r => { slowDone = true; return r; });
  assert.ok(await waitFor(async () => { const t = await taskOf(slowId); return t && t.state.inFlightRunId; }), '前提:慢任务的手动运行在飞');
  try {
    // [R1] 另一条任务的「立即运行」照常跑完。
    const other = await tool('steward_schedule_run_now', { id: quickId });
    assert.ok(other && other.ok === true && other.outcome === 'succeeded',
      '慢任务在飞时,另一条任务的立即运行照常跑完(修前 steward.busy「全局并发 1」):' + JSON.stringify(other).slice(0, 300));
    // [R1] tick 的到点派单同样不被挡住(修前管家的手动运行整段占着 ticking,tick 一进来就 return)。
    const cron = await api('POST', '/api/scheduler/tasks', { title: 'tick', schedule: { kind: 'cron', expr: '*/1 * * * *' }, payload: { kind: 'reminder', text: 't' } });
    const cronId = cron.json.task.id;
    setClock(Date.parse(cron.json.task.nextRunAt) + 1000);
    assert.ok(await waitFor(() => fires().some(f => f.taskId === cronId && f.phase === 'reconciled' && f.mode === 'ontime'), 5000),
      '慢任务的手动运行在飞时,别的任务照常到点派单、跑完');
    await api('DELETE', '/api/scheduler/tasks/' + cronId);
    // [R2] 在飞的那一条本身:两个入口都拒。
    const again = await tool('steward_schedule_run_now', { id: slowId });
    assert.ok(again && again.ok === false && again.error === 'steward.busy', '在飞的那一条再按立即运行 → steward.busy:' + JSON.stringify(again).slice(0, 300));
    const viaHttp = await api('POST', '/api/scheduler/tasks/' + slowId + '/run-now', {});
    assert.equal(viaHttp.status, 409, 'HTTP 入口同一道闸 → 409');
    assert.equal(viaHttp.json.error.code, 'scheduler.busy');
    assert.equal(slowDone, false, '前提:上面这些都发生在慢任务收尾之前');
  } finally {
    gateRelease();
  }
  const first = await Promise.race([slowRun, deadline(20000).then(() => null)]);
  assert.ok(first && first.ok === true && first.outcome === 'succeeded', '慢任务正常收尾:' + JSON.stringify(first).slice(0, 300));
  armGate(); gateRelease();                    // 第二次不挂
  const rerun = await tool('steward_schedule_run_now', { id: slowId });
  assert.ok(rerun && rerun.ok === true, '收尾之后再跑不拒:' + JSON.stringify(rerun).slice(0, 300));
  for (const id of [slowId, quickId]) await api('DELETE', '/api/scheduler/tasks/' + id);
});

test('teardown', async () => {
  stopScheduler();
  try { gateRelease(); } catch { /* ignore */ }
  await new Promise(r => server.close(r));
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await fake.close();
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

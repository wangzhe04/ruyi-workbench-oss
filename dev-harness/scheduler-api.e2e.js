require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// E2E(第123波 M1 §3.3):定时任务六条 API 的正反面。
//
// 六条:GET /api/scheduler/tasks · POST /api/scheduler/tasks · PATCH /:id · DELETE /:id ·
//       POST /:id/run-now · GET /:id/runs?limit=N。
//
// 判据(§3.3 逐条 + 29 号文 §10 红线):
//   A 鉴权   —— 六条【全部】不带 header token 一律 403;**带 body token 也不行**(ROUTE_AUTH 给的是
//               token 档而不是 body-token 档 —— 红线三:任务定义只能由 token 级 API 写入,
//               MCP 子进程那条路永远够不着「以后每天替我做这件事」这种最长效的授权)。
//   B 建     —— 回 {ok, task};task 带 K7 前端要的 nextRunAt(ISO)/enabled/name,
//               以及 describeKey + describeParams(人话回读的原料,文案在 locale 里)。
//   C 越权   —— autonomy.permissionMode:'bypass' 【回落】而不是照收(任务级授权永不含 bypass)。
//   D 禁止键 —— 载荷里出现 localCommand/env/apiKey/dataRoot/cwd 之一 -> 整条拒 400。
//   E 改     —— PATCH revision+1;只改标题时 nextRunAt 【不动】(改个名字不该把日程往后推);
//               enabled:false 是暂停,true 是恢复;不存在的 id 404。
//   F 立即运行 —— mode:'manual' 的【新】 occurrence;不动 nextRunAt(它是计划之外的一次)。
//   G 删     —— 定义没了,但 GET /:id/runs 【仍然读得出来】(回执不随定义走,37 号文 §1)。
//   H 上限   —— 第 201 条 -> 409 scheduler.capacity_exceeded。
//   I 开关   —— schedulerEnabledV1:false 的另一份数据根:六条路由仍在,但一律 409 scheduler.disabled。
//
// 载荷一律 reminder:本件量的是 API 面,不该把模型端点的不确定性叠进来。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-scheduler-api-e2e');
const HOME_OFF = path.join(os.tmpdir(), 'wcw-scheduler-api-off-e2e');
const CLOCK = path.join(HOME, 'clock.txt');
const TICK_MS = 250;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(child) { if (child && child.pid) { try { killOwnTree(child); } catch { /* already gone */ } } }
function readToken(home) { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 300; i++) { const r = await request(port, 'GET', '/health', null, '').catch(() => null); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}
async function waitToken(home) {
  for (let i = 0; i < 300; i++) { const t = readToken(home); if (t) return t; await sleep(100); }
  return readToken(home);
}
// 唯一的 spawn 点(fixture-home.static 数的就是它这一处)。
function spawnWb(home, port, extraEnv) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, HOME: home, USERPROFILE: home, WCW_SCHEDULER_TICK_MS: String(TICK_MS), ...(extraEnv || {}) },
    windowsHide: true,
  });
  child.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  return child;
}
function writeConfig(home, enabled) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 7, engineMode: 'interactive', permissionMode: 'acceptEdits',
    includeWorkbenchMcp: false, defaultWorkspace: path.join(home, 'workspace'),
    stewardEnabledV1: false, stewardThreadBriefV1: false,
    schedulerEnabledV1: enabled,
  }), 'utf8');
}

const REMINDER = (title, date) => ({
  title, schedule: { kind: 'once', date, at: '09:00' }, payload: { kind: 'reminder', text: '到点了' },
});

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(HOME_OFF, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'workspace'), { recursive: true });
  writeConfig(HOME, true);
  writeConfig(HOME_OFF, false);
  // 固定假时钟:本件不量触发时序,只量 API 面 —— 钉死时间是为了让 once 的日期与 nextRunAt 可逐字断言。
  const clockMs = new Date(2026, 4, 4, 12, 0, 0, 0).getTime();
  fs.writeFileSync(CLOCK, String(clockMs), 'utf8');

  const PORT = await getFreePort();
  const PORT_OFF = await getFreePort();
  const wb = spawnWb(HOME, PORT, { WCW_SCHEDULER_CLOCK_FILE: CLOCK });
  let wbOff = null;

  try {
    ok(await waitHealth(PORT), 'workbench up');
    const token = await waitToken(HOME);
    ok(!!token, 'runtime token available');

    /* ═════════ A 鉴权:六条全 403;body token 也不行 ═════════ */
    const noAuth = [
      ['GET', '/api/scheduler/tasks', null],
      ['POST', '/api/scheduler/tasks', REMINDER('无票建任务', '2030-01-01')],
      ['PATCH', '/api/scheduler/tasks/sch_nope', { title: 'x' }],
      ['DELETE', '/api/scheduler/tasks/sch_nope', null],
      ['POST', '/api/scheduler/tasks/sch_nope/run-now', {}],
      ['GET', '/api/scheduler/tasks/sch_nope/runs', null],
    ];
    for (const [method, pathname, body] of noAuth) {
      const r = await request(PORT, method, pathname, body, '');
      ok(r.status === 403, `A ${method} ${pathname} 无 token -> 403(实测 ${r.status})`);
    }
    {
      // 红线三:body token 是 MCP 子进程那条路的档,它【不该】写得动任务定义。
      const r = await request(PORT, 'POST', '/api/scheduler/tasks', { ...REMINDER('body-token 建任务', '2030-01-01'), token }, '');
      ok(r.status === 403, `A7 带 body token(不带 header)仍 403 —— 任务定义只能由 token 级 API 写入(实测 ${r.status})`);
      const list = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json;
      ok(list && Array.isArray(list.tasks) && list.tasks.length === 0, 'A8 那一次真的什么都没建出来');
    }

    /* ═════════ B 建 + 列 ═════════ */
    const created = await request(PORT, 'POST', '/api/scheduler/tasks',
      { title: '每个工作日写周报', schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], at: '18:00' }, payload: { kind: 'reminder', text: '写周报' } }, token);
    ok(created.status === 200 && created.json && created.json.ok === true, `B1 POST 建任务 200(实测 ${created.status})`);
    const task = created.json.task;
    ok(/^[A-Za-z0-9_-]{1,64}$/.test(String(task.id)), 'B2 服务端派了一个 id(纯函数不造随机,id 由 13s 补)');
    ok(task.enabled === true && typeof task.nextRunAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(task.nextRunAt),
      `B3 K7 前端要的两个键就位:enabled 与 ISO 的 nextRunAt(实测 ${task.nextRunAt})`);
    ok(task.name === task.title, 'B4 name 与 title 同值(K7 那份前向兼容读法两个候选键都给上)');
    ok(task.describeKey === 'scheduler.describe.weekly.weekdays' && task.describeParams.time === '18:00',
      `B5 describeKey + params 就位(实测 ${task.describeKey} ${JSON.stringify(task.describeParams)})`);
    ok(task.revision === 0 && task.createdBy === 'user', 'B6 revision 从 0 起、createdBy 缺省 user');
    {
      const list = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json;
      ok(list.ok === true && list.tasks.length === 1 && list.tasks[0].id === task.id, 'B7 GET 列表读得到它');
      ok(Number.isFinite(list.nowMs) && list.nowMs === clockMs, `B8 列表带 nowMs(与假时钟同源;实测 ${list.nowMs})`);
    }

    /* ═════════ C 越权 bypass 回落 ═════════ */
    {
      const r = await request(PORT, 'POST', '/api/scheduler/tasks',
        { ...REMINDER('想要 bypass', '2030-02-01'), autonomy: { permissionMode: 'bypass' } }, token);
      ok(r.status === 200 && r.json.task.autonomy.permissionMode === '',
        `C1 bypass 回落成空(= 跟随全局默认档),不是照收(实测 ${JSON.stringify(r.json && r.json.task && r.json.task.autonomy)})`);
      await request(PORT, 'DELETE', '/api/scheduler/tasks/' + r.json.task.id, null, token);
      const r2 = await request(PORT, 'POST', '/api/scheduler/tasks',
        { ...REMINDER('要 plan 档', '2030-02-01'), autonomy: { permissionMode: 'plan' } }, token);
      ok(r2.status === 200 && r2.json.task.autonomy.permissionMode === 'plan', 'C2 非 bypass 的档原样留着');
      await request(PORT, 'DELETE', '/api/scheduler/tasks/' + r2.json.task.id, null, token);
    }

    /* ═════════ D 禁止键整条拒 ═════════ */
    for (const key of ['localCommand', 'env', 'apiKey', 'dataRoot', 'cwd']) {
      const r = await request(PORT, 'POST', '/api/scheduler/tasks',
        { title: '偷渡 ' + key, schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x', [key]: 'v' } }, token);
      ok(r.status === 400 && r.json && r.json.error && r.json.error.code === 'scheduler.payload_forbidden_key',
        `D 载荷带 ${key} -> 400 scheduler.payload_forbidden_key(实测 ${r.status}/${r.json && r.json.error && r.json.error.code})`);
    }
    {
      const r = await request(PORT, 'POST', '/api/scheduler/tasks',
        { title: '坏计划', schedule: { kind: 'cron', expr: 'not a cron' }, payload: { kind: 'reminder', text: 'x' } }, token);
      ok(r.status === 400, `D6 坏 cron -> 400(实测 ${r.status})`);
    }

    /* ═════════ E 改 ═════════ */
    {
      const before = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json.tasks.find(t => t.id === task.id);
      const renamed = await request(PORT, 'PATCH', '/api/scheduler/tasks/' + task.id, { title: '改个名字' }, token);
      ok(renamed.status === 200 && renamed.json.task.title === '改个名字', 'E1 PATCH 改标题');
      ok(renamed.json.task.revision === 1, `E2 revision + 1(实测 ${renamed.json.task.revision})`);
      ok(renamed.json.task.nextRunAt === before.nextRunAt,
        'E3 计划没变时 nextRunAt 【不动】—— 改个名字不该把日程往后推');
      const paused = await request(PORT, 'PATCH', '/api/scheduler/tasks/' + task.id, { enabled: false }, token);
      ok(paused.status === 200 && paused.json.task.enabled === false && paused.json.task.revision === 2, 'E4 enabled:false = 暂停');
      const resumed = await request(PORT, 'PATCH', '/api/scheduler/tasks/' + task.id, { enabled: true }, token);
      ok(resumed.status === 200 && resumed.json.task.enabled === true, 'E5 enabled:true = 恢复');
      const rescheduled = await request(PORT, 'PATCH', '/api/scheduler/tasks/' + task.id, { schedule: { kind: 'daily', at: '07:15' } }, token);
      ok(rescheduled.status === 200 && rescheduled.json.task.nextRunAt !== before.nextRunAt
        && rescheduled.json.task.describeKey === 'scheduler.describe.daily',
        'E6 换了计划时 nextRunAt 才重算,describeKey 跟着变');
      const missing = await request(PORT, 'PATCH', '/api/scheduler/tasks/sch_nope', { title: 'x' }, token);
      ok(missing.status === 404 && missing.json.error.code === 'scheduler.not_found', `E7 改不存在的 id -> 404(实测 ${missing.status})`);
      const badPatch = await request(PORT, 'PATCH', '/api/scheduler/tasks/' + task.id, { schedule: { kind: 'daily', at: '99:99' } }, token);
      ok(badPatch.status === 400, `E8 改成非法计划 -> 400,原任务不动(实测 ${badPatch.status})`);
    }

    /* ═════════ F 立即运行 ═════════ */
    {
      const before = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json.tasks.find(t => t.id === task.id);
      const ran = await request(PORT, 'POST', '/api/scheduler/tasks/' + task.id + '/run-now', {}, token);
      ok(ran.status === 200 && ran.json.ok === true && ran.json.outcome === 'succeeded',
        `F1 run-now 当场跑完(实测 ${ran.status}/${ran.json && ran.json.outcome})`);
      ok(ran.json.task.nextRunAt === before.nextRunAt,
        'F2 「再跑一次」不动 nextRunAt —— 它是计划之外的一个新 occurrence,不是把日程往后推');
      const runs = (await request(PORT, 'GET', '/api/scheduler/tasks/' + task.id + '/runs', null, token)).json;
      ok(runs.ok === true && runs.runs.length === 1 && runs.runs[0].mode === 'manual',
        `F3 那一次的触发模式是 manual(实测 ${runs.runs.length} 条 / ${runs.runs[0] && runs.runs[0].mode})`);
      ok(runs.runs[0].occurrenceKey.startsWith(task.id + '@'), 'F4 manual 也有自己的 occurrenceKey');
      const missing = await request(PORT, 'POST', '/api/scheduler/tasks/sch_nope/run-now', {}, token);
      ok(missing.status === 404, `F5 对不存在的 id run-now -> 404(实测 ${missing.status})`);
      // 再跑一次 -> 又是一个【新】 occurrence(不是同一个的第二次尝试)
      await request(PORT, 'POST', '/api/scheduler/tasks/' + task.id + '/run-now', {}, token);
      const runs2 = (await request(PORT, 'GET', '/api/scheduler/tasks/' + task.id + '/runs', null, token)).json;
      ok(runs2.runs.length === 2 && runs2.runs.every(r => r.executionGeneration === 1),
        `F6 两次 run-now 是两个 occurrence(各自 executionGeneration 1),不是同一个的重试(实测 ${JSON.stringify(runs2.runs.map(r => r.executionGeneration))})`);
      const limited = (await request(PORT, 'GET', '/api/scheduler/tasks/' + task.id + '/runs?limit=1', null, token)).json;
      ok(limited.runs.length === 1, 'F7 limit 生效');
    }

    /* ═════════ G 删定义不删回执 ═════════ */
    {
      const removed = await request(PORT, 'DELETE', '/api/scheduler/tasks/' + task.id, null, token);
      ok(removed.status === 200 && removed.json.ok === true, 'G1 DELETE 200');
      const list = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json;
      ok(!list.tasks.some(t => t.id === task.id), 'G2 列表里没有它了');
      const runs = (await request(PORT, 'GET', '/api/scheduler/tasks/' + task.id + '/runs', null, token)).json;
      ok(runs.ok === true && runs.runs.length === 2,
        `G3 【删定义不删历史回执】—— runs 仍然读得出那两次(实测 ${runs.runs.length})`);
      const again = await request(PORT, 'DELETE', '/api/scheduler/tasks/' + task.id, null, token);
      ok(again.status === 404, `G4 再删一次 -> 404(实测 ${again.status})`);
    }

    /* ═════════ H 200 条上限 ═════════ */
    {
      const listBefore = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json;
      let created200 = listBefore.tasks.length;
      let lastStatus = 200;
      while (created200 < 200 && lastStatus === 200) {
        const r = await request(PORT, 'POST', '/api/scheduler/tasks', REMINDER('批量 ' + created200, '2030-06-15'), token);
        lastStatus = r.status;
        if (r.status === 200) created200 += 1;
      }
      ok(created200 === 200, `H1 建满 200 条(实测 ${created200},最后一次 HTTP ${lastStatus})`);
      const overflow = await request(PORT, 'POST', '/api/scheduler/tasks', REMINDER('第 201 条', '2030-06-15'), token);
      ok(overflow.status === 409 && overflow.json.error.code === 'scheduler.capacity_exceeded',
        `H2 第 201 条 -> 409 scheduler.capacity_exceeded(实测 ${overflow.status}/${overflow.json && overflow.json.error && overflow.json.error.code})`);
      const listAfter = (await request(PORT, 'GET', '/api/scheduler/tasks', null, token)).json;
      ok(listAfter.tasks.length === 200, `H3 上限之后还是 200 条(实测 ${listAfter.tasks.length})`);
    }

    /* ═════════ I 开关关掉:路由仍在,一律 409 ═════════ */
    {
      wbOff = spawnWb(HOME_OFF, PORT_OFF, {});
      ok(await waitHealth(PORT_OFF), 'I1 第二份数据根(schedulerEnabledV1:false)的服务起来了');
      const tokenOff = await waitToken(HOME_OFF);
      const r = await request(PORT_OFF, 'GET', '/api/scheduler/tasks', null, tokenOff);
      ok(r.status === 409 && r.json && r.json.error && r.json.error.code === 'scheduler.disabled',
        `I2 关着时 GET -> 409 scheduler.disabled(路由清册不因开关变化;实测 ${r.status}/${r.json && r.json.error && r.json.error.code})`);
      const w = await request(PORT_OFF, 'POST', '/api/scheduler/tasks', REMINDER('关着也想建', '2030-01-01'), tokenOff);
      ok(w.status === 409, `I3 关着时 POST 也 409(实测 ${w.status})`);
      ok(!fs.existsSync(path.join(HOME_OFF, 'scheduler')),
        'I4 关着时 <data>/scheduler/ 目录一次都没建过(29 号文 §10:零持久化写入)');
    }
  } finally {
    kill(wb);
    kill(wbOff);
  }

  console.log(fail ? ('FAIL total ' + fail) : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });

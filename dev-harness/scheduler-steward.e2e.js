require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
(async () => {
'use strict';
// E2E(第 123 波 M2 §3.5;37 号文判据第一条):管家的六个 steward_schedule_* 工具【直调 handler】。
//
// 骨架抄 steward-tools.e2e.js:进程内 require(server.js) + srv.toolCall(name, args, ctx),
// 合成管家 ctx `{session:{id:'steward',kind:'steward'}}`。**不起 HTTP 服务**——本件测的是工具面,
// 六条路由那一半已经由 M1 的 scheduler-api.e2e.js 钉过了,再起一份只会多一个端口和一次启动开销。
// 进程内也能跑 run_now:13s 的 schedulerFireOnce 不依赖 listen(startScheduler 只管 tick 定时器)。
//
// 判据(每路一条正、一条反):
//  (A) 两道门 —— schedulerEnabledV1:false 时六个工具全 scheduler.disabled 且 <data>/scheduler
//      一个字节都不写;普通会话 ctx 六个工具全 steward.forbidden(13g 门控壳,与既有 27 个同一道)。
//  (C) create 正:回 describeKey/describeParams(「每个工作日 18:00」那一句的键与参数逐字);
//      反:缺 title / 载荷带禁止键 / once 已过期 —— 三条各自的稳定信封,且表里一条都不多。
//  (D) 无人值守(ctx.trigger:'inbox')—— create 与 delete 只回 propose_required 且【零写入】;
//      同一 ctx 下 list/pause/resume/run_now 仍然可做(它们不越用户的边界)。
//  (E) list 正:两条都在、字段齐;反:不是数组/漏 describeKey 就红(逐字段核)。
//  (F) pause 正:enabled 变 false 且 nextRunAt 一个字符没动(暂停不该把下一次往后推);反:错 id -> not_found。
//  (G) resume 正:enabled 回 true 且熔断计数清零;反:错 id -> not_found。
//  (H) run_now 正:outcome succeeded、fires 多一行 mode:'manual' 的 reconciled、任务的 nextRunAt
//      【不动】(它是计划之外的一次);反:错 id -> not_found。
//  (I) delete 正:表里少一条、fires-v1.ndjson 一个字节没少(删定义不删回执);反:错 id -> not_found。
//  (J) 决策日志:五个写动作各恰好一行,读工具 list 一行都不写。
//  (K) reminder 出箱回调:run_now 一条 reminder -> 收件箱多一行 kind:'reminder' 且 payload.quiet。
//
// 判定行:`SCHEDULER STEWARD E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sched-steward-'));
const WORK = path.join(HOME, 'workspace');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const schedulerDir = path.join(HOME, 'scheduler');
const tasksFile = path.join(schedulerDir, 'tasks-v1.json');
const firesFile = path.join(schedulerDir, 'fires-v1.ndjson');
const stewardDir = path.join(HOME, 'steward');
const decisionsFile = path.join(stewardDir, 'decisions-v1.ndjson');
const inboxFile = path.join(stewardDir, 'inbox-v1.ndjson');

function ndjson(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function tasksOnDisk() {
  try { return JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks || []; } catch { return []; }
}
const decisionsFor = tool => ndjson(decisionsFile).filter(r => r.tool === tool);

const SCHEDULE_TOOLS = [
  'steward_schedule_create', 'steward_schedule_list', 'steward_schedule_pause',
  'steward_schedule_resume', 'steward_schedule_run_now', 'steward_schedule_delete',
];
// 形状合法但目标不存在的最小参数:两道门必须在碰这些参数之前就返回 disabled/forbidden。
const MIN_ARGS = {
  steward_schedule_create: { title: 'x', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' } },
  steward_schedule_list: {},
  steward_schedule_pause: { id: 'sch_nope' },
  steward_schedule_resume: { id: 'sch_nope' },
  steward_schedule_run_now: { id: 'sch_nope' },
  steward_schedule_delete: { id: 'sch_nope' },
};

function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'dead', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: WORK, recentWorkspaces: [],
    subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000,
    schedulerEnabledV1: true,
    // (L) 组要的那条「注定失败」的路:端点指向一个【没人监听】的端口 -> 每次回合都是 ECONNREFUSED。
    // 比造一个会返 500 的假服务更省:本件只需要「失败」这个事实,不需要失败的花样。
    providers: [{ id: 'dead', label: 'Dead', type: 'openai-compat', baseUrl: `http://127.0.0.1:${DEAD_PORT}`, apiKey: 'k', model: 'dead-model', models: [{ id: 'dead-model', label: 'Dead' }] }],
    ...patch,
  }, null, 2), 'utf8');
}
const DEAD_PORT = await getFreePort();   // 取一个空闲端口【但永不监听】
fs.mkdirSync(WORK, { recursive: true });
writeConfig({ schedulerEnabledV1: false });

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = extra => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] }, ...(extra || {}) });
const plainCtx = { session: { id: 'plain-sess', kind: 'quick_ask', providerHistory: [] } };
const call = (name, args, ctx) => srv.toolCall(name, args === null || args === undefined ? MIN_ARGS[name] : args, ctx);

// 计划固定用「每个工作日 18:00」——它的 describe 键是 weekly.weekdays 那一条特例,
// 参数只有 time,逐字可核(随便挑一个 daily 会让这条断言弱得多)。
const WEEKDAY_SCHEDULE = { kind: 'weekly', at: '18:00', days: [1, 2, 3, 4, 5] };

try {
  /* ═════════ (A) 两道门 ═════════ */
  console.log('── (A) 两道门 ──');
  {
    const bad = [];
    for (const name of SCHEDULE_TOOLS) {
      const r = await call(name, null, stewardCtx());
      if (!r || r.ok !== false || r.error !== 'scheduler.disabled') bad.push(`${name}:${r && r.error}`);
    }
    ok(bad.length === 0, 'A1 schedulerEnabledV1:false 时六个工具全部 scheduler.disabled' + (bad.length ? ' → ' + bad.join(',') : ''));
    ok(!fs.existsSync(schedulerDir), 'A2 关着时 <data>/scheduler 目录都不建(29 号文 §10:零持久化写入)');

    writeConfig({});
    const badPlain = [];
    for (const name of SCHEDULE_TOOLS) {
      const r = await call(name, null, plainCtx);
      if (!r || r.ok !== false || r.error !== 'steward.forbidden') badPlain.push(`${name}:${r && r.error}`);
    }
    ok(badPlain.length === 0, 'A3 普通会话 ctx 下六个工具全部 steward.forbidden(13g 门控壳)' + (badPlain.length ? ' → ' + badPlain.join(',') : ''));
    const noCtx = await call('steward_schedule_list', {}, null);
    ok(noCtx && noCtx.error === 'steward.forbidden', 'A4 无 ctx(桥接/子进程路径)同样 fail-closed forbidden');
    ok(!fs.existsSync(schedulerDir), 'A5 越权与无 ctx 的调用一个字节都没写');
  }

  /* ═════════ (C) create 正反 ═════════ */
  console.log('── (C) create ──');
  let taskId = '';
  {
    const res = await call('steward_schedule_create', {
      title: '周报草稿', schedule: WEEKDAY_SCHEDULE, payload: { kind: 'prompt', text: '把这周的进展写成周报草稿' },
      permissionMode: 'plan',
    }, stewardCtx());
    ok(res && res.ok === true && res.task && res.task.id, 'C1 create 建成一条(回 {ok,task})');
    taskId = res && res.task ? res.task.id : '';
    ok(res && res.describeKey === 'scheduler.describe.weekly.weekdays',
      `C2 回 describeSchedule 的【键】(实得 ${res && res.describeKey})`);
    ok(res && res.describeParams && res.describeParams.time === '18:00' && Object.keys(res.describeParams).length === 1,
      `C3 回 describeSchedule 的【参数】逐字(实得 ${JSON.stringify(res && res.describeParams)})`);
    ok(res && res.task.describeKey === res.describeKey && res.task.nextRunAt && res.task.enabled === true,
      'C4 task 行自带同一份 describeKey,且 nextRunAt 已经算好、enabled 为真');
    ok(res && res.task.payloadKind === 'prompt' && res.task.lastResult === '' && res.task.lastMode === '',
      'C5 task 行带载荷类型与「还没跑过」的两个空');
    const onDisk = tasksOnDisk();
    ok(onDisk.length === 1 && onDisk[0].id === taskId && onDisk[0].createdBy === 'steward',
      `C6 真的落盘了且 createdBy 记成 steward(实得 ${onDisk.length} 条)`);
    ok(onDisk.length === 1 && onDisk[0].autonomy && onDisk[0].autonomy.permissionMode === 'plan',
      'C7 permissionMode 入参落进 autonomy(天花板判定在 13s,这里只核透传)');

    const noTitle = await call('steward_schedule_create', { schedule: WEEKDAY_SCHEDULE, payload: { kind: 'reminder', text: 'x' } }, stewardCtx());
    ok(noTitle && noTitle.ok === false && noTitle.error === 'invalid_request',
      `C8 反:缺 title -> invalid_request(实得 ${noTitle && noTitle.error})`);
    const forbidden = await call('steward_schedule_create', {
      title: '坏载荷', schedule: WEEKDAY_SCHEDULE, payload: { kind: 'reminder', text: 'x', extra: { localCommand: 'del /f' } },
    }, stewardCtx());
    ok(forbidden && forbidden.error === 'payload_forbidden_key',
      `C9 反:载荷深处带 localCommand -> payload_forbidden_key(实得 ${forbidden && forbidden.error})`);
    const expired = await call('steward_schedule_create', {
      title: '过去的一次', schedule: { kind: 'once', date: '2020-01-01', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    }, stewardCtx());
    ok(expired && expired.error === 'invalid_request',
      `C10 反:once 的时点已经过去 -> invalid_request(实得 ${expired && expired.error})`);
    ok(tasksOnDisk().length === 1, `C11 三条反例一条都没落进表里(实得 ${tasksOnDisk().length} 条)`);
  }

  /* ═════════ (D) 无人值守 ═════════ */
  console.log('── (D) 无人值守(ctx.trigger:inbox) ──');
  {
    const unattended = stewardCtx({ trigger: 'inbox' });
    const created = await call('steward_schedule_create', {
      title: '模型自己想排的', schedule: { kind: 'daily', at: '07:00' }, payload: { kind: 'reminder', text: 'x' },
    }, unattended);
    ok(created && created.ok === false && created.error === 'propose_required' && created.reason === 'unattended',
      `D1 无人值守时 create 只回 propose_required(实得 ${created && created.error}/${created && created.reason})`);
    const deleted = await call('steward_schedule_delete', { id: taskId }, unattended);
    ok(deleted && deleted.ok === false && deleted.error === 'propose_required' && deleted.reason === 'unattended',
      `D2 无人值守时 delete 只回 propose_required(实得 ${deleted && deleted.error})`);
    ok(tasksOnDisk().length === 1 && tasksOnDisk()[0].id === taskId, 'D3 两条 propose_required 都是【零写入】(表还是那一条)');
    const listed = await call('steward_schedule_list', {}, unattended);
    ok(listed && listed.ok === true, 'D4 同一 ctx 下 list 仍可做(只读,不越任何边界)');
    const paused = await call('steward_schedule_pause', { id: taskId }, unattended);
    ok(paused && paused.ok === true && paused.task.enabled === false,
      'D5 同一 ctx 下 pause 仍可做(暂停用户自己下的单,不改载荷不改权限档)');
    const resumed = await call('steward_schedule_resume', { id: taskId }, unattended);
    ok(resumed && resumed.ok === true && resumed.task.enabled === true, 'D6 resume 同上');
  }

  /* ═════════ (E) list 正反 ═════════ */
  console.log('── (E) list ──');
  let secondId = '';
  {
    const second = await call('steward_schedule_create', {
      title: '每天喝水', schedule: { kind: 'daily', at: '10:30' }, payload: { kind: 'reminder', text: '起来走两步' },
    }, stewardCtx());
    secondId = second && second.task ? second.task.id : '';
    const listed = await call('steward_schedule_list', {}, stewardCtx());
    ok(listed && listed.ok === true && Array.isArray(listed.tasks) && listed.tasks.length === 2,
      `E1 list 回两条(实得 ${listed && listed.tasks && listed.tasks.length})`);
    const row = (listed.tasks || []).find(t => t.id === secondId) || {};
    ok(row.describeKey === 'scheduler.describe.daily' && row.describeParams && row.describeParams.time === '10:30',
      `E2 每行自带 describeKey/params(实得 ${row.describeKey}/${JSON.stringify(row.describeParams)})`);
    const FIELDS = ['id', 'title', 'enabled', 'nextRunAt', 'payloadKind', 'lastResult', 'lastMode', 'describeKey', 'describeParams'];
    ok(FIELDS.every(f => Object.prototype.hasOwnProperty.call(row, f)) && Object.keys(row).length === FIELDS.length,
      `E3 工具面这一行【只】有那九个字段(不把 policy/state/载荷正文灌进模型上下文;实得 ${Object.keys(row).sort().join(',')})`);
    ok(!('payload' in row) && !('policy' in row) && !('state' in row), 'E4 反向:界面那份全量字段一个都没混进来');
  }

  /* ═════════ (F)(G) pause / resume 正反 ═════════ */
  console.log('── (F)(G) pause / resume ──');
  {
    const before = (await call('steward_schedule_list', {}, stewardCtx())).tasks.find(t => t.id === taskId);
    const paused = await call('steward_schedule_pause', { id: taskId }, stewardCtx());
    ok(paused && paused.ok === true && paused.task.enabled === false, 'F1 pause 正:enabled 变 false');
    ok(paused && paused.task.nextRunAt === before.nextRunAt,
      `F2 pause 不动 nextRunAt(暂停不该把下一次往后推;前 ${before.nextRunAt} 后 ${paused && paused.task.nextRunAt})`);
    const missing = await call('steward_schedule_pause', { id: 'sch_nope' }, stewardCtx());
    ok(missing && missing.ok === false && missing.error === 'not_found', `F3 反:错 id -> not_found(实得 ${missing && missing.error})`);

    const resumed = await call('steward_schedule_resume', { id: taskId }, stewardCtx());
    ok(resumed && resumed.ok === true && resumed.task.enabled === true, 'G1 resume 正:enabled 回 true');
    const missingResume = await call('steward_schedule_resume', { id: 'sch_nope' }, stewardCtx());
    ok(missingResume && missingResume.error === 'not_found', 'G3 反:错 id -> not_found');
  }

  /* ═════════ (H)(K) run_now 正反 + reminder 出箱 ═════════ */
  console.log('── (H)(K) run_now ──');
  {
    const before = (await call('steward_schedule_list', {}, stewardCtx())).tasks.find(t => t.id === secondId);
    const inboxBefore = ndjson(inboxFile).length;
    const res = await call('steward_schedule_run_now', { id: secondId }, stewardCtx());
    ok(res && res.ok === true && res.outcome === 'succeeded',
      `H1 run_now 正:reminder 载荷 outcome succeeded(实得 ${res && res.outcome})`);
    const rows = ndjson(firesFile).filter(r => r.taskId === secondId);
    const reconciled = rows.filter(r => r.phase === 'reconciled');
    ok(reconciled.length === 1 && reconciled[0].mode === 'manual',
      `H2 fires 多一行 reconciled 且 mode 是 manual(实得 ${reconciled.length} 行/${reconciled[0] && reconciled[0].mode})`);
    ok(res && res.task.nextRunAt === before.nextRunAt,
      `H3 「再跑一次」不动下一次触发时间(前 ${before.nextRunAt} 后 ${res && res.task.nextRunAt})`);
    const missing = await call('steward_schedule_run_now', { id: 'sch_nope' }, stewardCtx());
    ok(missing && missing.error === 'not_found', 'H4 反:错 id -> not_found');

    const inbox = ndjson(inboxFile);
    ok(inbox.length === inboxBefore + 1, `K1 reminder 到点写进收件箱恰好一行(实得 ${inbox.length - inboxBefore})`);
    const last = inbox[inbox.length - 1] || {};
    ok(last.kind === 'reminder', `K2 新类 reminder(实得 ${last.kind})`);
    ok(last.payload && last.payload.quiet === true && last.payload.ask === '起来走两步',
      `K3 payload 带 quiet 与那句事实(实得 quiet=${last.payload && last.payload.quiet} ask=${last.payload && last.payload.ask})`);
    ok(last.payload && last.payload.source === 'scheduler' && last.payload.notice === 'due' && last.payload.taskId === secondId,
      'K4 payload 标明来源与是哪条任务(收件箱行不猜,直接记)');
  }

  /* ═════════ (L) 熔断:连败三次 -> 停用 + 出箱;resume 清零 ═════════ */
  console.log('── (L) 熔断与恢复 ──');
  {
    const created = await call('steward_schedule_create', {
      title: '注定失败的一条', schedule: { kind: 'daily', at: '03:00' },
      payload: { kind: 'prompt', text: '随便说点什么' }, permissionMode: 'auto',
    }, stewardCtx());
    const deadId = created && created.task ? created.task.id : '';
    ok(!!deadId, 'L0 建一条 prompt 任务(端点指向一个没人监听的端口 -> 每次回合必失败)');
    let last = null;
    for (let i = 0; i < 3; i++) last = await call('steward_schedule_run_now', { id: deadId }, stewardCtx());
    ok(last && last.ok === true && last.outcome === 'failed',
      `L1 三次 run_now 全部 failed(实得 ${last && last.outcome})`);
    const state = (tasksOnDisk().find(t => t.id === deadId) || {}).state || {};
    ok(state.enabled === false && state.consecutiveFailures >= 3,
      `L2 连败 3 次 -> 自动停用(实得 enabled=${state.enabled} 连败=${state.consecutiveFailures})`);
    const tripped = ndjson(firesFile).filter(r => r.taskId === deadId && r.tripped === true);
    ok(tripped.length === 1, `L3 fires 恰好一行带 tripped(实得 ${tripped.length})`);
    // 熔断通知那一口在 13s 里是 `void schedulerNotify(...)`(旁路纪律:观测绝不反噬触发),
    // 所以 run_now 返回时它还在飞 —— 这里等它落盘,而不是假设它已经落了。
    const trippedRows = () => ndjson(inboxFile).filter(r => r.kind === 'reminder' && r.payload && r.payload.notice === 'tripped');
    for (let i = 0; i < 60 && trippedRows().length === 0; i++) await new Promise(r => setTimeout(r, 50));
    const notice = trippedRows();
    ok(notice.length === 1 && /连着失败三次/.test(String(notice[0].payload.ask)),
      `L4 熔断也走 reminder 类、印一句事实(实得 ${notice.length} 行 / ${notice[0] && notice[0].payload.ask})`);
    const resumed = await call('steward_schedule_resume', { id: deadId }, stewardCtx());
    ok(resumed && resumed.task.enabled === true, 'L5 resume 把熔断的那条重新打开');
    const after = (tasksOnDisk().find(t => t.id === deadId) || {}).state || {};
    ok(after.consecutiveFailures === 0,
      `L6 从熔断里恢复时连败计数清零(不清零的话下一次失败会立刻再熔断;实得 ${after.consecutiveFailures})`);
    await call('steward_schedule_delete', { id: deadId }, stewardCtx());
  }

  /* ═════════ (I) delete 正反 ═════════ */
  console.log('── (I) delete ──');
  {
    const firesBefore = ndjson(firesFile).length;
    const res = await call('steward_schedule_delete', { id: secondId }, stewardCtx());
    ok(res && res.ok === true && res.deleted === true && res.id === secondId, 'I1 delete 正:回 {ok,id,deleted}');
    ok(tasksOnDisk().every(t => t.id !== secondId) && tasksOnDisk().length === 1,
      `I2 表里少一条(实得 ${tasksOnDisk().length} 条)`);
    ok(ndjson(firesFile).length === firesBefore,
      `I3 删定义【不删回执】:fires 行数一行没少(前 ${firesBefore} 后 ${ndjson(firesFile).length})`);
    const missing = await call('steward_schedule_delete', { id: 'sch_nope' }, stewardCtx());
    ok(missing && missing.error === 'not_found', 'I4 反:错 id -> not_found');
  }

  /* ═════════ (J) 决策日志 ═════════ */
  console.log('── (J) 决策日志 ──');
  {
    // stewardAppendDecision 是 fire-and-forget(记账失败绝不回滚已经做完的动作),最后一条
    // delete 的那一行在 I 组返回时还在写链上 —— 等它落盘再数,而不是把「还没写完」当成「没写」。
    for (let i = 0; i < 60 && decisionsFor('steward_schedule_delete').length < 2; i++) await new Promise(r => setTimeout(r, 50));
    // 上面各动作的次数:create 3(周报 + 喝水 + 注定失败)、pause 2(D5 + F1)、resume 3(D6 + G1 + L5)、
    // run_now 4(H1 一次 + L 三次)、delete 2(L 的那条 + I 的那条);list 一行都不该有。
    ok(decisionsFor('steward_schedule_create').length === 3, `J1 create 恰好三行(实得 ${decisionsFor('steward_schedule_create').length})`);
    ok(decisionsFor('steward_schedule_pause').length === 2, `J2 pause 恰好两行(实得 ${decisionsFor('steward_schedule_pause').length})`);
    ok(decisionsFor('steward_schedule_resume').length === 3, `J3 resume 恰好三行(实得 ${decisionsFor('steward_schedule_resume').length})`);
    ok(decisionsFor('steward_schedule_run_now').length === 4, `J4 run_now 恰好四行(实得 ${decisionsFor('steward_schedule_run_now').length})`);
    ok(decisionsFor('steward_schedule_delete').length === 2, `J5 delete 恰好两行(实得 ${decisionsFor('steward_schedule_delete').length})`);
    ok(decisionsFor('steward_schedule_list').length === 0, 'J6 反:读工具 list 一行都不写');
    const createRow = decisionsFor('steward_schedule_create')[0] || {};
    ok(createRow.undoRef && createRow.undoRef.kind === 'schedule' && createRow.undoRef.id,
      'J7 create 那一行带 undoRef{kind:schedule,id}');
    ok(!JSON.stringify(decisionsFor('steward_schedule_create')).includes('把这周的进展'),
      'J8 决策日志的 args 只记 id/标题/两个 kind,不复制载荷正文');
  }
} catch (error) {
  fail++;
  console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(fail === 0 ? '\nSCHEDULER STEWARD E2E: ALL PASS' : `\nSCHEDULER STEWARD E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();

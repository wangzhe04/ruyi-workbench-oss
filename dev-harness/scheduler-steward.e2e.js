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
//  (L) 熔断:连败三次 -> 自动停用 + fires 带 tripped + 收件箱一行 notice:'tripped';resume 清零。
//  (M) 无人值守遇 ask 【不放行】(红线二)+ 「回来摘要」的承诺三项(未来承诺增量、过期或结果未知
//      按 fires 水位切、等你的是【此刻状态】不是流水),外加三行的 i18n 键与排序。
//  —— 127 波 2-ter(45 号文 §2-ter,以 §2-quinquies 的改判为准)。两段都排在 (J) 之后,不动 (J) 的计数:
//  (T) S-a 档位:① tier:'fast' 的任务触发后,线程 engineRoute 与手工 steward_thread_new({tier:'fast'})
//      【逐字段相同】;② 那一档没配 → 跟随全局、不记审计;配了但端点已删 → 跟随全局 + 一条
//      steward_thread_model_fallback(sessionId 就是这条定时线程);③ 不传 tier → 任务表没有 tier 键、
//      决策日志与工具返回都没有、线程 engineRoute 是全局那条(strong 档配着 strong-model 也【不】被套上);
//      ④ existing-session 带 tier → 落盘的任务没有 tier。
//  (W) S-b 每条任务自己的文件夹:① 手工线程在 defaultWorkspace 上跑慢回合(假引擎 SLOW 暗号)时触发定时任务
//      → 定时线程拿到不同的 cwdKey、手工回合没完它已经 reconciled、全程 arbiterWait 为空(反向时这里读出
//      「等锁：同一个文件夹被「手工慢线程」占着」);② 新文件夹登记在如意那张表(stewardManagedWorkspaces)
//      里、task.workdir 落盘,W7 起用户的常用工作区一行不多;③ 第二次触发复用同一个 workdir,没有 `-2`
//      目录、表不多一行;磁盘上被删了 → 原地建回、表不多一行;从表里删掉那一行 → 重新派生并重新登记;
//      常用工作区满员 → W7 起照常派生(修前回落 defaultWorkspace + table_full,那条回落已退役);
//      ④ target 仍拒 cwd,HTTP 新建 / PATCH 写不进 workdir、PATCH 保住服务端那一份
//      (进程内 http 壳挂 srv.handleSchedulerApiRoutes,鉴权表由 scheduler-api.e2e 另钉);
//      ⑤ 管家关着 → 不派生、任务没有 workdir、表不多一行。
//
// 判定行:`SCHEDULER STEWARD E2E: ALL PASS`。
const fs = require('fs'), http = require('http'), os = require('os'), path = require('path');
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
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: WORK, recentWorkspaces: [],
    subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000,
    schedulerEnabledV1: true,
    // 127 波 2-ter S-b:定时线程现在会在 stewardWorkspaceRoot 下给每条任务开自己的文件夹,而它的缺省读
    // os.homedir()(不跟 RUYI_HOME 走,steward-guardrails 头注记过这个坑)—— 显式钉到临时 HOME。
    stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  }, null, 2), 'utf8');
}

// ── fake OpenAI 兼容引擎(按用户消息里的暗号分叉;与 scheduler.e2e.js 同一手法)────────────────
//   BOOM     -> HTTP 500(造 (L) 组要的连败三次)
//   TOOLCALL -> 发起一次 file_write(edit 档,在 default 权限下 gate 判 ask ->
//               无人值守等 WCW_SCHEDULER_ASK_WAIT_MS 之后【拒】-> outcome needs_you,29 号文 §10 红线二)
//   SLOW     -> 先睡 SLOW_MS 再回一句((W) 组的手工慢回合:它在 defaultWorkspace 上占着写锁)
//   其余     -> 直接回一句
// 8 s:定时那一次(进程内、假引擎秒回)要在它之内 reconciled 才算判据 ① 成立 —— 留足 4 路回归负载下的余量。
const SLOW_MS = 8000;
let slowSeen = 0;   // 收到过几次带 SLOW 的模型请求(到这一步时手工回合一定已经拿到写锁,正在跑)
const PROVIDER_PORT = await getFreePort();
process.env.WCW_SCHEDULER_ASK_WAIT_MS = '400';   // 只压「等多久」,不改「等到了怎么判」(13s 头注)
const provider = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = null;
  try { body = JSON.parse(raw); } catch { body = null; }
  const messages = (body && Array.isArray(body.messages)) ? body.messages : [];
  const userText = messages.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join(' ');
  const toolDone = messages.some(m => m && m.role === 'tool');
  if (userText.includes('BOOM')) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
  if (userText.includes('SLOW') && Array.isArray(body && body.tools) && body.tools.length) {
    slowSeen += 1;
    await new Promise(r => setTimeout(r, SLOW_MS));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  if (userText.includes('TOOLCALL') && !toolDone) {
    frame({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_write', arguments: '' } }] }, finish_reason: null }] });
    frame({ id: 'x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: path.join(WORK, 'scheduled.txt'), content: 'x' }) } }] }, finish_reason: null }] });
    frame({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    frame({ id: 'x', choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] });
    frame({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => provider.listen(PROVIDER_PORT, '127.0.0.1', r));
fs.mkdirSync(WORK, { recursive: true });
writeConfig({ schedulerEnabledV1: false });

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = extra => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] }, ...(extra || {}) });
const plainCtx = { session: { id: 'plain-sess', kind: 'quick_ask', providerHistory: [] } };
const call = (name, args, ctx) => srv.toolCall(name, args === null || args === undefined ? MIN_ARGS[name] : args, ctx);

// ── 127 波 2-ter 的几个小工具((T)(W) 两段用)────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const configFile = path.join(HOME, 'config.json');
const configOnDisk = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return {}; } };
// 在【盘上现有那份】上打补丁:派生会往如意那张表(stewardManagedWorkspaces)追加行,整份重写(writeConfig)会把它们抹掉。
function patchConfig(patch) {
  fs.writeFileSync(configFile, JSON.stringify({ ...configOnDisk(), ...patch }, null, 2), 'utf8');
}
const canonPath = p => path.resolve(String(p || '')).toLowerCase();
// W7:派生登记的是如意自己那张表(stewardManagedWorkspaces),不再是 workspaces[](用户的常用工作区)。
// tableRows / inTable 从此指那张表;favRows 是常用工作区,派生前后它一行都不该变。
const tableRows = () => (Array.isArray(configOnDisk().stewardManagedWorkspaces) ? configOnDisk().stewardManagedWorkspaces : []);
const favRows = () => (Array.isArray(configOnDisk().workspaces) ? configOnDisk().workspaces : []);
const inTable = p => tableRows().some(row => row && canonPath(row.path) === canonPath(p));
// 仲裁器的锁键口径(13n stewardArbiterCwdKey:resolve → realpath → win32 折小写 → sha1 前 12 位)。这里照算一遍只为
// 把「两条线程的键不一样」打印成人能对的两个值;判据本身同时看 arbiterWait(真仲裁器)与回合先后。
const cwdKeyOf = p => {
  let abs = path.resolve(String(p || ''));
  try { abs = fs.realpathSync.native(abs); } catch { /* 目录不在:用 resolve 结果 */ }
  return require('crypto').createHash('sha1').update(process.platform === 'win32' ? abs.toLowerCase() : abs).digest('hex').slice(0, 12);
};
const taskOnDisk = id => tasksOnDisk().find(t => t.id === id) || null;
// 这条任务每次触发开的线程 id(fires 里 dispatched 那一行带 sessionId),按 seq 升序。
const sessionIdsOf = taskId => ndjson(firesFile)
  .filter(r => r.taskId === taskId && r.phase === 'dispatched' && r.sessionId)
  .sort((a, b) => a.seq - b.seq).map(r => r.sessionId);
const headOf = async sid => (sid ? await srv.loadSession(sid).catch(() => null) : null);
function logRows(kind) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(HOME, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f)); } catch { files = []; }
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(path.join(HOME, 'logs', f), 'utf8'); } catch { text = ''; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(kind)) continue;
      try { const row = JSON.parse(line); if (row.kind === kind) out.push(row); } catch { /* 半行 */ }
    }
  }
  return out;
}
async function waitFor(pred, ms, step = 50) {
  const end = Date.now() + ms;
  for (;;) { const v = await pred(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
}

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
      payload: { kind: 'prompt', text: 'BOOM 随便说点什么' }, permissionMode: 'auto',
    }, stewardCtx());
    const deadId = created && created.task ? created.task.id : '';
    ok(!!deadId, 'L0 建一条 prompt 任务(正文带 BOOM -> 假引擎回 HTTP 500 -> 每次回合必失败)');
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

  /* ═════════ (M) needs_you + 「回来摘要」的承诺三项 ═════════ */
  console.log('── (M) 承诺三项 ──');
  {
    // ① 真造一次 needs_you:TOOLCALL 让假引擎发起 file_write(edit 档),任务权限档 default ->
    //    nativeToolGate 判 ask -> 无人值守【不放行】,等 WCW_SCHEDULER_ASK_WAIT_MS 之后拒。
    const asked = await call('steward_schedule_create', {
      title: '要动文件的一条', schedule: { kind: 'daily', at: '04:00' },
      payload: { kind: 'prompt', text: 'TOOLCALL 写个文件' }, permissionMode: 'default',
    }, stewardCtx());
    const askId = asked && asked.task ? asked.task.id : '';
    const ran = await call('steward_schedule_run_now', { id: askId }, stewardCtx());
    ok(ran && ran.outcome === 'needs_you',
      `M1 无人值守遇 ask 【不放行】:等窗到时拒,本次 needs_you(29 号文 §10 红线二;实得 ${ran && ran.outcome})`);
    ok(!fs.existsSync(path.join(WORK, 'scheduled.txt')), 'M2 被拒的那一次一个字节都没写出去');

    // ② 承诺三项。upcoming 用两条【一小时后 / 两小时后】的 once,确定性地落在 24 小时窗口里
    //    （拿 daily/weekly 会随今天是星期几而漂）。
    const at = ms => {
      const d = new Date(Date.now() + ms);
      return {
        kind: 'once',
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        at: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      };
    };
    // 前面几组留下的任务里也有一天之内会触发的(daily 04:00 之类),所以这里量的是【增量】
    // 而不是绝对值 —— 绝对值会随「今天是星期几」漂。
    const base = await srv.stewardVisitDigest(0, 0);
    const soonA = await call('steward_schedule_create', { title: '一小时后', schedule: at(3600000), payload: { kind: 'reminder', text: 'a' } }, stewardCtx());
    const soonB = await call('steward_schedule_create', { title: '两小时后', schedule: at(7200000), payload: { kind: 'reminder', text: 'b' } }, stewardCtx());
    ok(soonA.ok && soonB.ok, 'M3 两条一天之内会触发的 once 建好了');

    // missed 那一项数的是 fires 里的 skipped / unknown。这两种行只有【启动恢复】那条路会写
    // (错过跳过 / 崩溃后结果未知),而崩溃钩子要真的把进程打死 —— 进程内够不着,所以这里按
    // M1 落的【同一形状】直接往 append-only 账本上补两行,喂给读模型。
    const maxSeq = ndjson(firesFile).reduce((m, r) => Math.max(m, Number(r.seq) || 0), 0);
    fs.appendFileSync(firesFile, JSON.stringify({
      seq: maxSeq + 1, at: new Date().toISOString(), taskId: askId, title: '要动文件的一条',
      occurrenceKey: askId + '@x', dueAt: new Date().toISOString(), runId: '', executionGeneration: 0,
      mode: 'late', phase: 'reconciled', outcome: 'skipped', error: 'grace_expired',
    }) + '\n' + JSON.stringify({
      seq: maxSeq + 2, at: new Date().toISOString(), taskId: askId, title: '要动文件的一条',
      occurrenceKey: askId + '@y', dueAt: new Date().toISOString(), runId: 'srun_x', executionGeneration: 1,
      mode: 'ontime', phase: 'reconciled', outcome: 'unknown', error: 'interrupted',
    }) + '\n', 'utf8');

    const digest = await srv.stewardVisitDigest(0, 0);
    ok(digest && digest.commitments && (digest.commitments.upcoming - base.commitments.upcoming) === 2,
      `M4 未来承诺:新建两条一天内触发的 once 之后,这一项【正好多 2】(前 ${digest && digest.commitments && base.commitments.upcoming} 后 ${digest && digest.commitments && digest.commitments.upcoming})`);
    ok(digest.commitments.missed === 2,
      `M5 过期或结果未知:上次到访以来 skipped + unknown 共 2 条(实得 ${digest.commitments.missed})`);
    ok(digest.commitments.needsYou === 1,
      `M6 等你的:此刻 lastResult 仍是 needs_you 的 1 条(实得 ${digest.commitments.needsYou})`);
    const byField = Object.fromEntries((digest.items || []).filter(i => i.kind === 'commitment').map(i => [i.field, i]));
    ok(Object.keys(byField).length === 3, `M7 摘要里三行都在(实得 ${Object.keys(byField).join(',')})`);
    ok(byField.upcoming && byField.upcoming.key === 'stewardShell.digest.commitment.upcoming'
      && byField.upcoming.params && byField.upcoming.params.count === digest.commitments.upcoming,
      'M8 每行带 i18n 键与 params(前端 steward-conversation 优先按键渲染,text 只是兜底)');
    ok((digest.items || []).findIndex(i => i.kind === 'commitment') >= (digest.items || []).filter(i => i.kind !== 'commitment').length - 1,
      'M9 三行排在既有七类【之后】(那七类是刚发生的事,承诺是日程)');
    ok(digest.fireSeq === maxSeq + 2, `M10 fires 的水位跟着推进(实得 ${digest.fireSeq},应为 ${maxSeq + 2})`);
    const again = await srv.stewardVisitDigest(0, digest.fireSeq);
    ok(again.commitments.missed === 0,
      `M11 反:把水位喂回去 -> 同样两行不再重复计入(实得 ${again.commitments.missed})`);
    ok(again.commitments.upcoming === digest.commitments.upcoming && again.commitments.needsYou === 1,
      'M12 另两项是【此刻的状态】不是流水,水位对它们没有影响(同一条任务反复 needs_you 只算一条)');

    for (const id of [askId, soonA.task.id, soonB.task.id]) await call('steward_schedule_delete', { id }, stewardCtx());
  }

  /* ═════════ (J) 决策日志 ═════════ */
  console.log('── (J) 决策日志 ──');
  {
    // stewardAppendDecision 是 fire-and-forget(记账失败绝不回滚已经做完的动作),最后一条
    // delete 的那一行在 I 组返回时还在写链上 —— 等它落盘再数,而不是把「还没写完」当成「没写」。
    for (let i = 0; i < 60 && decisionsFor('steward_schedule_delete').length < 5; i++) await new Promise(r => setTimeout(r, 50));
    // 上面各动作的次数:create 6(周报/喝水/注定失败/要动文件/一小时后/两小时后)、pause 2(D5 + F1)、resume 3(D6 + G1 + L5)、
    // run_now 5(H1 一次 + L 三次 + M 一次)、delete 5(L 一条 + M 三条 + I 一条);list 一行都不该有。
    ok(decisionsFor('steward_schedule_create').length === 6, `J1 create 恰好六行(实得 ${decisionsFor('steward_schedule_create').length})`);
    ok(decisionsFor('steward_schedule_pause').length === 2, `J2 pause 恰好两行(实得 ${decisionsFor('steward_schedule_pause').length})`);
    ok(decisionsFor('steward_schedule_resume').length === 3, `J3 resume 恰好三行(实得 ${decisionsFor('steward_schedule_resume').length})`);
    ok(decisionsFor('steward_schedule_run_now').length === 5, `J4 run_now 恰好五行(实得 ${decisionsFor('steward_schedule_run_now').length})`);
    ok(decisionsFor('steward_schedule_delete').length === 5, `J5 delete 恰好五行(实得 ${decisionsFor('steward_schedule_delete').length})`);
    ok(decisionsFor('steward_schedule_list').length === 0, 'J6 反:读工具 list 一行都不写');
    const createRow = decisionsFor('steward_schedule_create')[0] || {};
    ok(createRow.undoRef && createRow.undoRef.kind === 'schedule' && createRow.undoRef.id,
      'J7 create 那一行带 undoRef{kind:schedule,id}');
    ok(!JSON.stringify(decisionsFor('steward_schedule_create')).includes('把这周的进展'),
      'J8 决策日志的 args 只记 id/标题/两个 kind,不复制载荷正文');
  }

  /* ═════════ (T) 127 波 2-ter S-a:定时任务带档位 ═════════ */
  console.log('── (T) S-a 档位 ──');
  {
    // 两档都配上且【互不相同、也都不同于全局】:strong → fake/strong-model,fast → fast-ep(模型留空 = 用该端点自己的)。
    // strong 必须配着 —— 判据 ③ 要证明「不传 tier 就不套」,而不是「套了 strong 但 strong 恰好没配」。
    const baseProviders = configOnDisk().providers || [];
    patchConfig({
      providers: [...baseProviders.filter(p => p && p.id !== 'fast-ep'),
        { id: 'fast-ep', label: 'Fast', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fast-model', models: [{ id: 'fast-model', label: 'Fast' }] }],
      stewardThreadModels: { strong: { providerId: 'fake', model: 'strong-model' }, fast: { providerId: 'fast-ep', model: '' } },
    });
    const GLOBAL_ROUTE = JSON.stringify({ engine: 'openai', providerId: 'fake', model: 'fake-model' });

    // ① tier:'fast' 的任务 vs 手工 steward_thread_new({tier:'fast'}),同一份配置。
    const fastTask = await call('steward_schedule_create', {
      title: '快档巡检', schedule: { kind: 'daily', at: '05:10' }, payload: { kind: 'prompt', text: '随便说点什么' }, tier: 'fast',
    }, stewardCtx());
    const fastId = fastTask && fastTask.task ? fastTask.task.id : '';
    ok(!!fastId && fastTask.tier === 'fast' && (taskOnDisk(fastId) || {}).target && taskOnDisk(fastId).target.tier === 'fast',
      `T0 建一条 tier:fast 的任务,落盘 target.tier=fast(实得 ${JSON.stringify(taskOnDisk(fastId) && taskOnDisk(fastId).target)})`);
    const ranFast = await call('steward_schedule_run_now', { id: fastId }, stewardCtx());
    const fastSid = sessionIdsOf(fastId).pop();
    const fastRoute = (await headOf(fastSid) || {}).engineRoute;
    const manual = await call('steward_thread_new', { title: '手工快档', tier: 'fast', brief: { userText: '随便说点什么' } }, stewardCtx());
    const manualRoute = (await headOf(manual && manual.sessionId) || {}).engineRoute;
    ok(ranFast && ranFast.outcome === 'succeeded' && !!fastSid, `T1 触发成功并开了线程(实得 outcome=${ranFast && ranFast.outcome} sid=${fastSid})`);
    ok(!!manualRoute && JSON.stringify(fastRoute) === JSON.stringify(manualRoute)
      && JSON.stringify(fastRoute) === JSON.stringify({ engine: 'openai', providerId: 'fast-ep', model: 'fast-model' }),
      `T2 ① 定时线程的 engineRoute 与手工 steward_thread_new({tier:'fast'}) 逐字段相同(实得 定时=${JSON.stringify(fastRoute)} 手工=${JSON.stringify(manualRoute)})`);

    // ② 那一档没配 → 跟随全局、不记审计。
    patchConfig({ stewardThreadModels: { strong: { providerId: 'fake', model: 'strong-model' }, fast: { providerId: '', model: '' } } });
    const ranUnset = await call('steward_schedule_run_now', { id: fastId }, stewardCtx());
    const unsetSid = sessionIdsOf(fastId).pop();
    const unsetRoute = (await headOf(unsetSid) || {}).engineRoute;
    await sleep(300);
    ok(ranUnset && ranUnset.outcome === 'succeeded' && unsetSid !== fastSid && JSON.stringify(unsetRoute) === GLOBAL_ROUTE,
      `T3 ② fast 档没配 → 跟随全局(实得 ${JSON.stringify(unsetRoute)})`);
    ok(!logRows('steward_thread_model_fallback').some(r => r.sessionId === unsetSid), 'T4 ② 没配不是「配了但端点没了」:这一条不记 steward_thread_model_fallback');
    // ② 配了但端点已删 → 同样跟随全局,并留一条审计(sessionId 就是这条定时线程)。
    patchConfig({ stewardThreadModels: { strong: { providerId: 'fake', model: 'strong-model' }, fast: { providerId: 'ghost-ep', model: 'x' } } });
    const ranGhost = await call('steward_schedule_run_now', { id: fastId }, stewardCtx());
    const ghostSid = sessionIdsOf(fastId).pop();
    const ghostRoute = (await headOf(ghostSid) || {}).engineRoute;
    const ghostAudit = await waitFor(() => logRows('steward_thread_model_fallback').find(r => r.sessionId === ghostSid), 5000);
    ok(ranGhost && ranGhost.outcome === 'succeeded' && JSON.stringify(ghostRoute) === GLOBAL_ROUTE,
      `T5 ② fast 档指向已删的端点 → 跟随全局(实得 ${JSON.stringify(ghostRoute)})`);
    ok(!!ghostAudit && ghostAudit.providerId === 'ghost-ep' && ghostAudit.tier === 'fast',
      `T6 ② 并记一条 steward_thread_model_fallback(与手工开线程同一个函数写的;实得 ${JSON.stringify(ghostAudit)})`);
    patchConfig({ stewardThreadModels: { strong: { providerId: 'fake', model: 'strong-model' }, fast: { providerId: 'fast-ep', model: '' } } });

    // ③ 不传 tier:任务表、工具返回、决策日志都没有 tier;线程 engineRoute 是全局那条(strong 配着也不套)。
    const plain = await call('steward_schedule_create', {
      title: '不选档位', schedule: { kind: 'daily', at: '05:20' }, payload: { kind: 'prompt', text: '随便说点什么' },
    }, stewardCtx());
    const plainId = plain && plain.task ? plain.task.id : '';
    const plainDisk = taskOnDisk(plainId) || {};
    ok(!!plainId && JSON.stringify(plainDisk.target) === '{"mode":"new-session"}' && !('tier' in plain),
      `T7 ③ 不传 tier → 落盘 target 逐字是 {"mode":"new-session"}、工具返回没有 tier 键(实得 ${JSON.stringify(plainDisk.target)})`);
    await waitFor(() => decisionsFor('steward_schedule_create').some(r => r.args && r.args.id === plainId), 3000);
    const plainDecision = decisionsFor('steward_schedule_create').find(r => r.args && r.args.id === plainId) || {};
    const fastDecision = decisionsFor('steward_schedule_create').find(r => r.args && r.args.id === fastId) || {};
    ok(plainDecision.args && !('tier' in plainDecision.args) && fastDecision.args && fastDecision.args.tier === 'fast',
      `T8 ③ 决策日志:不传的那条 args 没有 tier 键,带 fast 的那条记着 tier(实得 ${JSON.stringify(plainDecision.args)} / ${JSON.stringify(fastDecision.args)})`);
    const ranPlain = await call('steward_schedule_run_now', { id: plainId }, stewardCtx());
    const plainRoute = (await headOf(sessionIdsOf(plainId).pop()) || {}).engineRoute;
    ok(ranPlain && ranPlain.outcome === 'succeeded' && JSON.stringify(plainRoute) === GLOBAL_ROUTE,
      `T9 ③ 不传 tier 的线程 engineRoute 就是全局那条 —— strong 档配着 strong-model 也没被套上(实得 ${JSON.stringify(plainRoute)})`);

    // ④ existing-session 带 tier → 落盘没有 tier(既有线程有它自己的引擎)。
    const onExisting = await call('steward_schedule_create', {
      title: '在既有线程里跑', schedule: { kind: 'daily', at: '05:30' }, payload: { kind: 'prompt', text: '随便说点什么' },
      target: { mode: 'existing-session', sessionId: manual && manual.sessionId }, tier: 'fast',
    }, stewardCtx());
    const existingDisk = taskOnDisk(onExisting && onExisting.task && onExisting.task.id) || {};
    ok(onExisting && onExisting.ok === true && existingDisk.target && existingDisk.target.mode === 'existing-session'
      && !('tier' in existingDisk.target) && !('tier' in onExisting),
      `T10 ④ existing-session 带 tier → 落盘的任务没有 tier(实得 ${JSON.stringify(existingDisk.target)})`);
    for (const id of [fastId, plainId, existingDisk.id]) if (id) await call('steward_schedule_delete', { id }, stewardCtx());
  }

  /* ═════════ (W) 127 波 2-ter S-b:每条任务自己的文件夹 ═════════ */
  console.log('── (W) S-b 每条任务自己的文件夹 ──');
  {
    // ① 手工线程在 defaultWorkspace(WORK)上跑一个慢回合,占着那把 cwd-write 锁。
    const manualSession = await srv.createSession({ title: '手工慢线程', cwd: WORK });
    let manualDone = false;
    const slowBefore = slowSeen;
    const manualTurn = srv.runSessionTurn({ sessionId: manualSession.id, message: 'SLOW 手工慢回合', cwd: WORK, source: 'http' })
      .catch(() => null).then(r => { manualDone = true; return r; });
    const slowStarted = await waitFor(() => slowSeen > slowBefore, 15000, 20);
    ok(!!slowStarted && !manualDone, 'W0 前提:手工慢回合已经拿到写锁、正在模型那一步睡着');

    const rowsBefore = tableRows().length;
    const favBefore = favRows().length;
    const created = await call('steward_schedule_create', {
      title: 'A股盘中巡检(2-ter 夹具)', schedule: { kind: 'daily', at: '14:00' }, payload: { kind: 'prompt', text: '按计划做一次盘中巡检' },
    }, stewardCtx());
    const taskId = created && created.task ? created.task.id : '';
    ok(!!taskId && !('workdir' in (taskOnDisk(taskId) || {})), 'W1 建好一条 prompt 任务;还没触发时任务表里没有 workdir');
    const waits = [];
    let runDone = false;
    const runP = call('steward_schedule_run_now', { id: taskId }, stewardCtx()).then(r => { runDone = true; return r; });
    let schedSid = '';
    while (!runDone) {
      if (!schedSid) schedSid = sessionIdsOf(taskId)[0] || '';
      if (schedSid) {
        const wait = srv.StewardHooks.arbiterWait(schedSid);
        if (wait) waits.push({ wait, label: srv.waitReasonFor({}, wait).label, manualDone });
      }
      await sleep(20);
    }
    const ran = await runP;
    const reconciledWhileManualRunning = !manualDone;
    const schedHead = await headOf(schedSid || sessionIdsOf(taskId)[0]) || {};
    const keySched = cwdKeyOf(schedHead.cwd);
    const keyManual = cwdKeyOf(WORK);
    // 只数【锁】:13n 里每个新回合都先入队、再由 drain 判准入,入队到 drain 之间挂着一个同步算出来的临时原因
    // (没有同 cwd 的锁就是「等并发位：下一个就是它」)—— 那是仲裁器的设计,与 S-b 无关;判据 ① 问的是「不在等锁」。
    // (首版断言「arbiterWait 全程为空」,回归之后的直跑采到过一次这个临时 slot 原因,是夹具量具过严。)
    const lockWaits = waits.filter(w => w.wait && w.wait.lock);
    ok(ran && ran.outcome === 'succeeded' && reconciledWhileManualRunning && lockWaits.length === 0 && keySched !== keyManual,
      `W2 ① 定时线程拿到不同的 cwdKey(${keySched} vs 手工 ${keyManual}),手工慢回合没完它已 reconciled(${reconciledWhileManualRunning}),全程没有在等锁(arbiterWait 采样到 lock ${lockWaits.length} 次:${JSON.stringify(lockWaits.slice(0, 2).map(w => w.label))};其余非空 ${waits.length - lockWaits.length} 次:${JSON.stringify(waits.filter(w => !(w.wait && w.wait.lock)).slice(0, 2).map(w => w.label))});outcome=${ran && ran.outcome}`);
    const workdir = (taskOnDisk(taskId) || {}).workdir || '';
    ok(!!workdir && canonPath(workdir) === canonPath(schedHead.cwd) && canonPath(workdir).startsWith(canonPath(path.join(HOME, 'Ruyi')) + path.sep),
      `W3 ② task.workdir 落盘,且就是那条线程的 cwd(在 Ruyi 根下;实得 workdir=${workdir} cwd=${schedHead.cwd})`);
    ok(!!workdir && inTable(workdir) && tableRows().length === rowsBefore + 1 && fs.statSync(workdir).isDirectory(),
      `W4 ② 新文件夹登记在如意那张表里(表 ${rowsBefore} → ${tableRows().length} 行)且目录真的建了`);
    ok(favRows().length === favBefore && !favRows().some(row => canonPath(row.path) === canonPath(workdir)),
      `W4b W7:用户的常用工作区一行没多(${favBefore} → ${favRows().length} 行),定时任务的文件夹不出现在里面`);
    await manualTurn;
    ok(manualDone, 'W5 手工慢回合随后也跑完了(两条互不等待)');

    // ③ 第二次触发:同一个 workdir、没有 -2、表不多一行。
    const ran2 = await call('steward_schedule_run_now', { id: taskId }, stewardCtx());
    const sid2 = sessionIdsOf(taskId).pop();
    const head2 = await headOf(sid2) || {};
    ok(ran2 && ran2.outcome === 'succeeded' && sid2 !== schedSid && canonPath(head2.cwd) === canonPath(workdir)
      && (taskOnDisk(taskId) || {}).workdir === workdir && !fs.existsSync(workdir + '-2') && tableRows().length === rowsBefore + 1,
      `W6 ③ 第二次触发复用同一个 workdir:没有 -2 目录、表不多一行(实得 cwd=${head2.cwd} -2存在=${fs.existsSync(workdir + '-2')} 表 ${tableRows().length} 行)`);
    // 磁盘上被人删了、表里还在 → 原地建回来再用,表不多一行。
    fs.rmSync(workdir, { recursive: true, force: true });
    const ran3 = await call('steward_schedule_run_now', { id: taskId }, stewardCtx());
    const head3 = await headOf(sessionIdsOf(taskId).pop()) || {};
    ok(ran3 && ran3.outcome === 'succeeded' && canonPath(head3.cwd) === canonPath(workdir) && fs.existsSync(workdir)
      && tableRows().length === rowsBefore + 1,
      `W7 目录被删、表里那行还在 → 原地建回、仍用它、表不多一行(实得 cwd=${head3.cwd} 存在=${fs.existsSync(workdir)} 表 ${tableRows().length} 行)`);
    // 用户把那一行从表里删了 → 不再认它,重新派生并重新登记(空目录复用,所以路径不变、行回来)。
    patchConfig({ stewardManagedWorkspaces: tableRows().filter(row => canonPath(row.path) !== canonPath(workdir)) });
    ok(!inTable(workdir), 'W8 前提:那一行已经不在候选表里');
    const ran4 = await call('steward_schedule_run_now', { id: taskId }, stewardCtx());
    const head4 = await headOf(sessionIdsOf(taskId).pop()) || {};
    const workdir4 = (taskOnDisk(taskId) || {}).workdir || '';
    ok(ran4 && ran4.outcome === 'succeeded' && !!workdir4 && inTable(workdir4) && canonPath(head4.cwd) === canonPath(workdir4),
      `W9 ③ 表里没有了 → 重新派生、重新登记,线程用的是新登记的那一个(实得 workdir=${workdir4} 在表里=${inTable(workdir4)})`);

    // 常用工作区满员(64 行)→ W7 起【照常派生】:派生登记在如意那张表里,不占常用工作区的行。
    // 修前这里断的是「表满 → 回落 defaultWorkspace + scheduler_workdir_fallback(reason:table_full)」——
    // 那条回落随 13k 的派生前帽检查一起退役(派生不再往常用工作区写,「表满」对它没有意义了)。
    const savedFav = favRows();
    const fillers = [];
    for (let i = 0; savedFav.length + fillers.length < 64; i++) fillers.push({ path: path.join(HOME, 'fill', 'f' + i), read: true, write: true, execute: true });
    patchConfig({ workspaces: [...savedFav, ...fillers] });
    ok(favRows().length === 64, `W10 前提:常用工作区填满 64 行(实得 ${favRows().length})`);
    const full = await call('steward_schedule_create', {
      title: '表满时的那条', schedule: { kind: 'daily', at: '14:30' }, payload: { kind: 'prompt', text: '随便说点什么' },
    }, stewardCtx());
    const fullId = full && full.task ? full.task.id : '';
    const ranFull = await call('steward_schedule_run_now', { id: fullId }, stewardCtx());
    const fullSid = sessionIdsOf(fullId).pop();
    const fullHead = await headOf(fullSid) || {};
    const fullWorkdir = (taskOnDisk(fullId) || {}).workdir || '';
    ok(ranFull && ranFull.outcome === 'succeeded' && !!fullWorkdir && canonPath(fullHead.cwd) === canonPath(fullWorkdir)
      && canonPath(fullWorkdir).startsWith(canonPath(path.join(HOME, 'Ruyi')) + path.sep) && inTable(fullWorkdir) && favRows().length === 64,
      `W11 常用工作区满员 → 照常派生、任务记下 workdir、常用工作区仍 64 行(实得 outcome=${ranFull && ranFull.outcome} cwd=${fullHead.cwd} 常用 ${favRows().length} 行)`);
    await sleep(200);
    ok(!logRows('scheduler_workdir_fallback').some(r => r.taskId === fullId),
      'W12 没有 scheduler_workdir_fallback(退役的 table_full 回落不再出现)');
    patchConfig({ workspaces: savedFav });

    // ④ HTTP 新建 / PATCH 写不进 workdir;PATCH 保住服务端那一份;target 仍拒 cwd。
    const shim = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      Promise.resolve(srv.handleSchedulerApiRoutes(req, res, pathname)).catch(() => null).then(() => {
        if (!res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    const shimPort = await getFreePort();
    await new Promise(r => shim.listen(shimPort, '127.0.0.1', r));
    const api = (method, pathname, body) => new Promise(resolve => {
      const raw = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: shimPort, path: pathname, method,
        headers: raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {} }, res => {
        let text = ''; res.on('data', c => { text += c; });
        res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json }); });
      });
      req.on('error', () => resolve({ status: 0, json: null }));
      if (raw) req.write(raw);
      req.end();
    });
    try {
      const evil = path.join(HOME, 'evil');
      const posted = await api('POST', '/api/scheduler/tasks', {
        title: 'HTTP 建的', schedule: { kind: 'daily', at: '15:00' }, payload: { kind: 'prompt', text: 'x' },
        target: { mode: 'new-session', tier: 'fast' }, workdir: evil,
      });
      const postedId = posted.json && posted.json.task ? posted.json.task.id : '';
      const postedDisk = taskOnDisk(postedId) || {};
      ok(posted.status === 200 && !!postedId && !('workdir' in postedDisk) && postedDisk.target && postedDisk.target.tier === 'fast',
        `W13 ④ HTTP 新建带 workdir → 落盘没有 workdir;target.tier 照收(实得 ${posted.status} ${JSON.stringify({ workdir: postedDisk.workdir, target: postedDisk.target })})`);
      const patched = await api('PATCH', '/api/scheduler/tasks/' + taskId, { title: 'A股盘中巡检(改名)', workdir: evil });
      ok(patched.status === 200 && (taskOnDisk(taskId) || {}).workdir === workdir4 && (taskOnDisk(taskId) || {}).title === 'A股盘中巡检(改名)',
        `W14 ④ PATCH 带 workdir → 服务端那一份原样保住(实得 ${patched.status} ${(taskOnDisk(taskId) || {}).workdir})`);
      const retiered = await api('PATCH', '/api/scheduler/tasks/' + taskId, { target: { mode: 'new-session', tier: 'fast', workdir: evil } });
      const retieredDisk = taskOnDisk(taskId) || {};
      ok(retiered.status === 200 && retieredDisk.target && retieredDisk.target.tier === 'fast' && retieredDisk.workdir === workdir4
        && !('workdir' in retieredDisk.target),
        `W15 PATCH 整替 target 就能改档位(已有任务改档的唯一入口),target 里夹带的 workdir 不落、服务端那一份不动(实得 ${JSON.stringify({ target: retieredDisk.target, workdir: retieredDisk.workdir })})`);
      const cwdPost = await api('POST', '/api/scheduler/tasks', {
        title: '想指定 cwd', schedule: { kind: 'daily', at: '15:10' }, payload: { kind: 'prompt', text: 'x' }, target: { mode: 'new-session', cwd: evil },
      });
      const cwdPatch = await api('PATCH', '/api/scheduler/tasks/' + taskId, { target: { mode: 'new-session', cwd: evil } });
      ok(cwdPost.status === 400 && cwdPost.json && cwdPost.json.error && cwdPost.json.error.code === 'scheduler.payload_forbidden_key'
        && cwdPatch.status === 400 && (taskOnDisk(taskId) || {}).workdir === workdir4,
        `W16 ④ target 仍拒 cwd:新建与 PATCH 都 400 scheduler.payload_forbidden_key(实得 ${cwdPost.status}/${cwdPatch.status})`);
      ok(!fs.existsSync(evil), 'W17 ④ 那个「想指定的」目录从头到尾没被建出来');

      // ⑤ 管家关着 → 不派生、任务没有 workdir、表不多一行(定时任务本身照跑)。
      patchConfig({ stewardEnabledV1: false });
      const offRows = tableRows().length;
      const offPosted = await api('POST', '/api/scheduler/tasks', {
        title: '管家关着时的那条', schedule: { kind: 'daily', at: '15:20' }, payload: { kind: 'prompt', text: '随便说点什么' },
      });
      const offId = offPosted.json && offPosted.json.task ? offPosted.json.task.id : '';
      const offRan = await api('POST', '/api/scheduler/tasks/' + offId + '/run-now', {});
      const offHead = await headOf(sessionIdsOf(offId).pop()) || {};
      ok(offRan.status === 200 && offRan.json && offRan.json.outcome === 'succeeded' && canonPath(offHead.cwd) === canonPath(WORK)
        && !('workdir' in (taskOnDisk(offId) || {})) && tableRows().length === offRows && !fs.existsSync(path.join(HOME, 'Ruyi', '管家关着时的那条')),
        `W18 ⑤ 管家关着 → 线程照旧落 defaultWorkspace、任务没有 workdir、表不多一行、没建目录(实得 outcome=${offRan.json && offRan.json.outcome} cwd=${offHead.cwd})`);
    } finally {
      await new Promise(r => shim.close(() => r()));
    }
  }
} catch (error) {
  fail++;
  console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
}

try { provider.close(); } catch { /* already closed */ }
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(fail === 0 ? '\nSCHEDULER STEWARD E2E: ALL PASS' : `\nSCHEDULER STEWARD E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();

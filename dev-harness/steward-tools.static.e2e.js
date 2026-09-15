#!/usr/bin/env node
'use strict';
// 静态锁:第 116 波 116c(27 号文 §3.5 工具面 / §11.3 第 49 波入库门)—— 管家 21 个工具的
// 「四处登记一致」与模块落点纪律(116-2e 重钉:21 -> 26)。判定行:`STEWARD TOOLS STATIC E2E: ALL PASS`。
//
// 断言六个方向:
//   ① 四处登记一致:13f schema / 12 handler 注册表 / 07 NATIVE_TOOL_TIER / 07 NATIVE_TOOL_PACKS
//      四个表的 steward_* 键集必须【完全相同】且恰好是这 27 个名字(任何一处漏登 = 锁红)。
//      重钉来源:116h 增 steward_thread_prioritize,20 -> 21;116-2e 增 config_get/config_set/
//      playbook_draft/skill_toggle/quick_ask(27 号文 §3.5「如意设置」/「内容管理」行、§11.1 第 2 项),21 -> 26;
//      117m-A4 增 steward_thread_stop(§11.10 用户第六轮走查第 ③ 条),26 -> 27,注册表总数 89 -> 90。
//   ② handler 纪律:每个 steward_* handler 的 paths 必须是 null 且带非空 guardNote;handler 源码
//      必须只调 StewardHooks.*、不含 require(、不含任何 13g 的内部符号(禁止前向边的机器判据)。
//   ③ 13g 填充的 StewardHooks 键集 ⊇ 06i 契约注释里列出的键(契约注释不是装饰品)。
//   ④ tier 与 pack:观察族 read、线程族 edit、决策族 exec、记忆族 edit;pack 一律 'steward',
//      且 TOOL_PACK_DESCRIPTIONS 有 steward 条目。
//   ⑤ 四个 offer 面各自都有 isStewardToolName 门(源码正则锁 + 真实调用回环)。
//   ⑥ 五态判据与前端 public/js/mission-state.js 机械对账(分支顺序与关键字面量逐条相同)——
//      06i 的服务端副本是抄写件,不是第二套状态机。
//   ⑪ 117w-W1④:workspaces[] 的行数帽子一处定义(01-config WORKSPACE_TABLE_CAP)、清洗块两支
//      循环各读一次、代码行零裸字面量;13k 的派生前帽检查一处实现两处调用,且都挂在「省略 cwd」
//      那一支下(表内 cwd 不派生,不该被帽子挡)。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
const SRC = path.join(APP, 'src');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const STEWARD_TOOLS = [
  'steward_self_status', 'steward_threads_search', 'steward_thread_status', 'steward_thread_read',
  'steward_runs_status', 'steward_inbox_read', 'steward_usage', 'steward_health', 'steward_audit_tail',
  'steward_missions',
  'steward_thread_new', 'steward_thread_continue', 'steward_thread_rename', 'steward_thread_permission',
  'steward_thread_note', 'steward_thread_prioritize',
  'steward_decide', 'steward_run_action',
  // 117m-A4(§11.10 用户第六轮走查第 ③ 条):线程级停止。26 -> 27。
  'steward_thread_stop',
  'steward_memory_write', 'steward_memory_veto', 'steward_memory_search',
  // 116-2e:设置族两个(§3.5「如意设置」行的三级分级)+ 内容管理三个(playbook 起草 / 技能启停 /
  // 速查线程)。21 -> 26。
  'steward_config_get', 'steward_config_set',
  'steward_playbook_draft', 'steward_skill_toggle', 'steward_quick_ask',
  // 123-M2(37 号文 §3.5):定时任务六件(实现住 13t-steward-schedule.js,门控壳仍是 13g 的
  // stewardToolHandler)。27 -> 33,注册表总数 90 -> 96。
  'steward_schedule_create', 'steward_schedule_list', 'steward_schedule_pause',
  'steward_schedule_resume', 'steward_schedule_run_now', 'steward_schedule_delete',
];
const EXPECTED_TIER = {
  steward_self_status: 'read', steward_threads_search: 'read', steward_thread_status: 'read',
  steward_thread_read: 'read', steward_runs_status: 'read', steward_inbox_read: 'read',
  steward_usage: 'read', steward_health: 'read', steward_audit_tail: 'read',
  steward_missions: 'read', // 116g: 事项级只读视图,零副作用
  steward_thread_new: 'edit', steward_thread_continue: 'edit', steward_thread_rename: 'edit',
  steward_thread_permission: 'edit', // 116-2a: 线程权限只降不升,归线程族 edit
  steward_thread_note: 'edit',       // 116-2b: 给在跑的线程补一句上下文,归线程族 edit
  steward_thread_prioritize: 'edit', // 116h: 插队只动仲裁器队列顺序,不改文件不动世界,归线程族 edit
  steward_decide: 'exec', steward_run_action: 'exec',
  steward_thread_stop: 'exec',       // 117m-A4: 决策族;真去掐一个在跑的子进程/在途请求
  steward_memory_write: 'edit', steward_memory_veto: 'edit', steward_memory_search: 'edit',
  steward_config_get: 'read',                               // 116-2e: 只读掩码后的配置、零副作用
  steward_config_set: 'exec',                               // 116-2e: §3.5「如意设置」行
  steward_playbook_draft: 'edit',                           // 116-2e: 只出草稿不落盘,归内容管理 edit
  steward_skill_toggle: 'exec', steward_quick_ask: 'exec',  // 116-2e: 改线程工具面 / 开一条真会动世界的线程
  // 123-M2: list 只读归 read;另五件改的都是如意自己账面上的一张表(任务定义),不动文件不动世界,归 edit。
  steward_schedule_list: 'read',
  steward_schedule_create: 'edit', steward_schedule_pause: 'edit', steward_schedule_resume: 'edit',
  steward_schedule_run_now: 'edit', steward_schedule_delete: 'edit',
};
// StewardHooks 上的实现键 <- 工具名。inbox 的门控壳叫 inboxReadTool:116b 已经把 inboxRead 用作
// 【原始读取器】(签名 (opts),无门控),契约不能被 116c 改语义,故工具壳另起一个键。
const HOOK_KEY = {
  steward_self_status: 'selfStatus', steward_threads_search: 'threadsSearch', steward_thread_status: 'threadStatus',
  steward_thread_read: 'threadRead', steward_runs_status: 'runsStatus', steward_inbox_read: 'inboxReadTool',
  steward_usage: 'usage', steward_health: 'health', steward_audit_tail: 'auditTail',
  steward_missions: 'missions',
  steward_thread_new: 'threadNew', steward_thread_continue: 'threadContinue', steward_thread_rename: 'threadRename',
  steward_thread_permission: 'threadPermission', steward_thread_note: 'threadNote',
  steward_thread_prioritize: 'threadPrioritize',
  steward_decide: 'decide', steward_run_action: 'runAction', steward_thread_stop: 'threadStop',
  steward_config_get: 'configGet', steward_config_set: 'configSet',
  steward_playbook_draft: 'playbookDraft', steward_skill_toggle: 'skillToggle', steward_quick_ask: 'quickAsk',
  steward_memory_write: 'memoryWrite', steward_memory_veto: 'memoryVeto', steward_memory_search: 'memorySearch',
  steward_schedule_create: 'scheduleCreate', steward_schedule_list: 'scheduleList',
  steward_schedule_pause: 'schedulePause', steward_schedule_resume: 'scheduleResume',
  steward_schedule_run_now: 'scheduleRunNow', steward_schedule_delete: 'scheduleDelete',
};

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const srcFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();   // 116-2e ⑦ 全仓扫描用
const src06i = read('06i-steward-core.js');
const src07 = read('07-autonomy.js');
const src11 = read('11-native-tools.js');
const src12 = read('12-tool-dispatch.js');
const src13 = read('13-http-router.js');
const src13f = read('13f-native-tool-schemas.js');
const src13g = read('13g-steward.js');
const src13h = read('13h-steward-runner.js');
// 117 波 T2(32 号文 §5):13h 拆成六个文件(纯搬家)。①c/①d 要的那两张登记表(STEWARD_ACTION_HOOKS
// 与 STEWARD_TOOL_LABELS)随共享常量块搬进 13m;⑦ 的 userPressed 三处分落 13m(注释)/13q(唯一置 true)
// /13h(act 路由那段「不置」的注释)。故这两组判据改读确切的那个文件与整族,期望值一字未改。
const src13m = read('13m-steward-runner-base.js');   // 117m-A4 ①c/①d:ACTION_HOOKS 与人话标签的登记面(T2 后住这里)
const STEWARD_RUNNER_FAMILY = ['13m-steward-runner-base.js', '13n-steward-arbiter.js', '13o-steward-runner-prompt.js',
  '13p-steward-runner-actions.js', '13q-steward-runner-turn.js', '13h-steward-runner.js'];

/* ═════════════ ① 四处登记一致(真实产物内省,不靠 grep 形状) ═════════════ */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-tools-static-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = tmpHome;
process.env.RUYI_HOME = tmpHome;
const srv = require(path.join(APP, 'server.js'));

const regNames = Object.keys(srv.TOOL_HANDLERS).filter(n => n.startsWith('steward_')).sort();
const tierNames = Object.keys(srv.NATIVE_TOOL_TIER).filter(n => n.startsWith('steward_')).sort();
const packNames = Object.keys(srv.NATIVE_TOOL_PACKS).filter(n => n.startsWith('steward_')).sort();
// schema 面:MCP_TOOLS 不导出,按 13f 源码里的 `name: 'steward_xxx',` 字面量对账(它就是 schema 的唯一声明处)。
const schemaNames = [...new Set((src13f.match(/name: '(steward_[a-z_]+)'/g) || []).map(m => m.slice(7, -1)))].sort();
const expected = [...STEWARD_TOOLS].sort();

ok(JSON.stringify(schemaNames) === JSON.stringify(expected), `① 13f schema 恰好登记 33 个 steward_*(got ${schemaNames.length})`);
ok(JSON.stringify(regNames) === JSON.stringify(expected), `① 12 TOOL_HANDLERS 恰好登记 33 个 steward_*(got ${regNames.length})`);
ok(JSON.stringify(tierNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_TIER 恰好登记 33 个 steward_*(got ${tierNames.length})`);
ok(JSON.stringify(packNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_PACKS 恰好登记 33 个 steward_*(got ${packNames.length})`);
// 117m-A4 重钉 89 -> 90。理由:本波【真的新增了一个工具】(steward_thread_stop),数字变化就是被测事实
// 本身,不是把闸门放宽 —— 这条断言的语义是「注册表里一个不多一个不少」,重钉后它仍是等号。
// 按「断言只加不改」的纪律,重钉的同时补两条【更强】的伴随断言(下面 ①b/①c):新增的这一个必须
// 恰好是决策族里【唯一】的线程级停止原语,且必须真的登记进了 13h 的 STEWARD_ACTION_HOOKS ——
// 只钉总数会让「加错了一个工具」也照样过。
ok(Object.keys(srv.TOOL_HANDLERS).length === 96, `① 注册表总数 96(63 + 33;123-M2 增六件定时任务;got ${Object.keys(srv.TOOL_HANDLERS).length})`);
const stopPrimitives = expected.filter(n => /_stop$/.test(n));
ok(JSON.stringify(stopPrimitives) === JSON.stringify(['steward_thread_stop']),
  `①b 决策族里恰好【一个】线程级停止原语(多一个 = 两条停机路径,少一个 = 管家又只能拿 run_action 凑;got ${JSON.stringify(stopPrimitives)})`);
const hooksBlock = src13m.slice(src13m.indexOf('const STEWARD_ACTION_HOOKS'), src13m.indexOf('const STEWARD_DECIDE_LABELS'));
ok(/steward_thread_stop: 'threadStop'/.test(hooksBlock),
  '①c steward_thread_stop 登记进 13h 族的 STEWARD_ACTION_HOOKS(不在表里 = 用户亲手按那枚按钮时 not_allowed)');
ok(/steward_thread_stop: '暂停这条线程'/.test(src13m),
  '①d STEWARD_TOOL_LABELS 有它的人话标签(※ 脚注与降级按钮不许吐 steward_thread_stop 这个内部 id)');

/* ═════════════ ①e act 表的机械锁(124 走查;同一个坑第三次)═════════════
   用户 2026-09-15 真机:管家提的「就按这个排」按下去 —— 没做成: steward_schedule_create
   不能作为 act 执行。病根不是这一个工具,是**这张表是手维护的第四处登记**:123-M2 加六个
   定时任务工具时登记了 schema(13f)/handler(12)/tier 与 pack(07),漏了它;而 create 与 delete
   自己在无人值守时就回 propose_required -> stewardDowngradeActions 把它降级成一枚按钮 ->
   13q stewardRunAct 查不到实现 -> not_allowed。117m-A4(thread_stop)、117z-E2b(thread_permission)
   已经各踩过一次,①c/①d 是那两次留下的【单点】断言 —— 单点断言只看得住已经出过事的那一个。

   本条把它变成一条【推导出来的】不变量:
     凡是实现里会回 'propose_required' 的管家工具(＝一定会被降级成按钮的那些),
     都必须是 STEWARD_ACTION_HOOKS 的键。
   推导链全在源码里,没有第二份名单:stewardToolHandler('steward_xxx', stewardImplYyy) 给出
   工具名 -> 实现名的对应(注册点与实现常常不在同一个文件:13g 注册、13k/13l 实现,所以函数体
   要全仓找),再看那个函数体里有没有 'propose_required'。

   **有意不按 07 的 tier 推**(试过:写类 21 个里有 9 个不在表里)—— memory_search / playbook_draft
   / quick_ask / thread_note 是写类但本来就不该被按钮触发,按 tier 推会逼着把它们一并放进来,
   而 act 这条路是 ctx.userPressed = true 的唯一来源(见下面 ⑦)。**放宽这道闸必须是有人决定的,
   不能是一条锁顺手带进来的。**
   如实记一处边界:thread_stop 不回 propose_required,本条覆盖不到它 —— ①c 仍然是它的看守。 */
{
  const toolFns = [];
  for (const f of srcFiles) {
    for (const m of read(f).matchAll(/stewardToolHandler\(\s*'([A-Za-z0-9_]+)'\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
      toolFns.push({ tool: m[1], fn: m[2] });
    }
  }
  ok(toolFns.length === STEWARD_TOOLS.length,
    `①e0 每个管家工具都经 stewardToolHandler 注册恰一次(got ${toolFns.length} / 期望 ${STEWARD_TOOLS.length})`);
  const bodyOf = fn => {
    for (const f of srcFiles) {
      const s = read(f);
      const at = s.search(new RegExp('(?:async )?function ' + fn + '\\('));
      if (at < 0) continue;
      const rest = s.slice(at);
      const end = rest.indexOf('\n}\n');
      return end < 0 ? rest : rest.slice(0, end);
    }
    return '';
  };
  const noBody = toolFns.filter(row => !bodyOf(row.fn)).map(row => row.fn);
  ok(noBody.length === 0, `①e1 每个实现函数体都找得到(找不到 = 本条静默失效;got ${JSON.stringify(noBody)})`);
  const proposers = toolFns.filter(row => bodyOf(row.fn).includes("'propose_required'")).map(row => row.tool);
  ok(proposers.length >= 8,
    `①e2 会回 propose_required 的管家工具至少 8 个(推导链没断;got ${proposers.length})`);
  const unreachable = proposers.filter(tool => !new RegExp('\\b' + tool + ':').test(hooksBlock));
  ok(unreachable.length === 0,
    `①e 凡会回 propose_required 的工具都在 STEWARD_ACTION_HOOKS 里(否则「管家提了按钮、按下去报错」;got ${JSON.stringify(unreachable)})`);
}

/* ①f 124 走查:五个【写类】定时任务工具都能被按钮按到,steward_schedule_list 是只读、不进表
   (表头那条纪律:「只有写类管家工具可以;只读工具请在回合里直接调用」)。
   pause/resume/run_now 不回 propose_required,①e 覆盖不到它们 —— 但模型照样能把它们提成一枚
   act 按钮(acts 不经这张表过滤),所以它们要的是这条显式断言。 */
{
  const writeSchedule = ['create', 'pause', 'resume', 'run_now', 'delete'].map(s => 'steward_schedule_' + s);
  const missing = writeSchedule.filter(tool => !new RegExp('\\b' + tool + ':').test(hooksBlock));
  ok(missing.length === 0, `①f 五个写类定时任务工具都在 act 表里(got missing ${JSON.stringify(missing)})`);
  ok(!/\bsteward_schedule_list:/.test(hooksBlock), '①f2 只读的 steward_schedule_list 不进 act 表');
  const noLabel = writeSchedule.filter(tool => !new RegExp(tool + ": '").test(src13m));
  ok(noLabel.length === 0, `①f3 五个都有人话标签(按钮上不吐内部 id;got ${JSON.stringify(noLabel)})`);
}

/* ═════════════ ② handler 纪律:paths:null + guardNote + 只调 StewardHooks ═════════════ */

let badPaths = [], badNote = [], badBody = [], badHook = [];
for (const name of STEWARD_TOOLS) {
  const entry = srv.TOOL_HANDLERS[name];
  if (!entry || entry.paths !== null) { badPaths.push(name); continue; }
  if (!(typeof entry.guardNote === 'string' && entry.guardNote.trim())) badNote.push(name);
  const body = entry.handler.toString();
  // 只允许出现 StewardHooks.<键>(args, ctx) 这一种调用;require( 与任何 13g 内部符号都是违规。
  if (/require\s*\(/.test(body) || /stewardImpl|stewardToolHandler|stewardDir\(/.test(body)) badBody.push(name);
  if (!new RegExp('StewardHooks\\.' + HOOK_KEY[name] + '\\(').test(body)) badHook.push(name);
}
ok(badPaths.length === 0, '② 全部 steward_* 条目 paths === null' + (badPaths.length ? ' → ' + badPaths.join(',') : ''));
ok(badNote.length === 0, '② 全部 steward_* 条目带非空 guardNote' + (badNote.length ? ' → ' + badNote.join(',') : ''));
ok(badBody.length === 0, '② handler 体零 require(、零 13g 内部符号(禁止前向边的机器判据)' + (badBody.length ? ' → ' + badBody.join(',') : ''));
ok(badHook.length === 0, '② 每个 handler 只调它自己的 StewardHooks.<键>' + (badHook.length ? ' → ' + badHook.join(',') : ''));

/* ═════════════ ③ 13g 填充键集 ⊇ 06i 契约注释列出的键 ═════════════ */

// 06i 的契约注释按 `键名(args,ctx)` / `键名(opts)` / `键名()` 的形状列出预留键;这里把它们抽出来对账。
const contractBlock = src06i.slice(src06i.indexOf('// 预留键名契约'), src06i.indexOf('const StewardHooks = {};'));
const contractKeys = [...new Set((contractBlock.match(/(?:^|[\s、])([a-z][A-Za-z]+)\(/gm) || [])
  .map(m => m.replace(/[^A-Za-z]/g, '')))]
  .filter(k => typeof srv.StewardHooks[k] === 'function' || /^(handleApiRoutes|stopInbox|inboxState|inboxRead|selfStatus|threadsSearch|threadStatus|threadRead|runsStatus|inboxReadTool|usage|health|auditTail|threadNew|threadContinue|threadRename|threadPermission|threadNote|missions|decide|runAction|memoryWrite|memoryVeto|memorySearch|configGet|configSet|playbookDraft|skillToggle|quickAsk|enrichInboxRows|quickClose|quickClosed)$/.test(k));
const filled = Object.keys(srv.StewardHooks);
const missingFill = contractKeys.filter(k => typeof srv.StewardHooks[k] !== 'function');
ok(contractKeys.length >= 30, `③ 06i 契约注释列出 ≥30 个预留键(116h 增 threadPrioritize 与 5 个仲裁键;got ${contractKeys.length})`);
ok(missingFill.length === 0, '③ 13g 填充键集 ⊇ 06i 契约注释列出的键' + (missingFill.length ? ' → 未填充: ' + missingFill.join(',') : ''));
ok(STEWARD_TOOLS.every(n => typeof srv.StewardHooks[HOOK_KEY[n]] === 'function'), '③ 33 个工具的实现键全部落在 StewardHooks 上');
ok(filled.length >= 30, `③ StewardHooks 至少 30 个实现键(4 个 116b 基础设施 + 26 个工具 + 116f/116-pre/116h 的运行器与仲裁键 + 116-2e 的三个基础设施键;got ${filled.length})`);
ok(/Object\.assign\(StewardHooks, \{/.test(src13g), '③ 13g 经 Object.assign(StewardHooks, {...}) 单向填充(06i 从不引用 13g)');

/* ═════════════ ④ tier / pack 分档 ═════════════ */

const tierBad = STEWARD_TOOLS.filter(n => srv.NATIVE_TOOL_TIER[n] !== EXPECTED_TIER[n]);
ok(tierBad.length === 0, '④ tier 分档符合 §3.5(观察 read / 线程 edit / 决策 exec / 记忆 edit)' + (tierBad.length ? ' → ' + tierBad.map(n => `${n}:${srv.NATIVE_TOOL_TIER[n]}`).join(',') : ''));
const packBad = STEWARD_TOOLS.filter(n => srv.NATIVE_TOOL_PACKS[n] !== 'steward');
ok(packBad.length === 0, "④ 全部 steward_* 归 pack 'steward'" + (packBad.length ? ' → ' + packBad.join(',') : ''));
ok(/steward: 'workbench steward:/.test(src07), "④ TOOL_PACK_DESCRIPTIONS 含 steward 包说明");
// 普通会话的 pack 路由永远不会命中 steward 包(四个 offer 面在包路由之前就拦掉了);这里锁「包名唯一来源」。
ok(srv.toolPackForName('steward_decide', {}) === 'steward', "④ toolPackForName('steward_decide') === 'steward'");

/* ═════════════ ⑤ 四个 offer 面各自都有门 ═════════════ */

ok(/if \(isStewardToolName\(t\.name\) && !\(opts && opts\.stewardSession === true\)\) continue;/.test(src07),
  '⑤ 面 1:07 buildOpenAiTools 有 isStewardToolName 门(fail-closed 默认不 offer)');
ok(/isStewardToolName\(t\.name\) && !stewardSession/.test(src13) && /process\.env\.WCW_SESSION_KIND === 'steward'/.test(src13),
  '⑤ 面 2:13 MCP tools/list 桥有 isStewardToolName 门(身份来自注入的 WCW_SESSION_KIND,缺失即隐藏)');
ok(/!isStewardToolName\(t\.name\) \|\| stewardSession/.test(src11),
  '⑤ 面 3:11 adaptiveCatalogForMcp 有 isStewardToolName 门');
ok(/!isStewardToolName\(t\.name\)\)\.map\(t => \(\{ name: t\.name/.test(src13),
  '⑤ 面 4:13 /api/status 工具清单无条件排除 steward_*');
// 真实回环:四个面里能在进程内直测的三个(buildOpenAiTools / adaptive 目录 / handler 二次校验)。
const cfg = srv.normalizeConfig({}).config;
const offeredPlain = srv.buildOpenAiTools(cfg, null, {}).map(t => t.function.name).filter(n => n.startsWith('steward_'));
const offeredSteward = srv.buildOpenAiTools(cfg, null, { stewardSession: true }).map(t => t.function.name).filter(n => n.startsWith('steward_'));
ok(offeredPlain.length === 0, `⑤ 回环:普通会话 buildOpenAiTools 零 steward_*(got ${offeredPlain.length})`);
// 117m-A4 重钉 26 -> 27(理由同 ① 的重钉:本波真的多了一个工具)。同时把这条从【只数个数】
// 换成【逐名对账】—— 那是更强的断言:个数对但少一个多一个的错法从此也会红。
ok(offeredSteward.length === 33, `⑤ 回环:管家会话 buildOpenAiTools 拿到 33 个 steward_*(got ${offeredSteward.length})`);
ok(JSON.stringify([...offeredSteward].sort()) === JSON.stringify(expected),
  `⑤b 回环:offer 出去的那一份与四张登记表【逐名】相同(缺: ${expected.filter(n => !offeredSteward.includes(n)).join(',') || '无'};多: ${offeredSteward.filter(n => !expected.includes(n)).join(',') || '无'})`);
ok(/steward\.forbidden/.test(src13g) && /steward\.disabled/.test(src13g), '⑤ 13g 门控壳含 steward.forbidden / steward.disabled 两个稳定信封');
ok(/session\.kind === 'steward'/.test(src13g), "⑤ 13g 身份判定读【显式】session.kind === 'steward'(不经 sessionKind 归一)");

/* ═════════════ ⑥ 五态判据与前端 mission-state.js 机械对账 ═════════════ */

const frontSrc = fs.readFileSync(path.join(APP, 'public', 'js', 'mission-state.js'), 'utf8');
const BRANCHES = [
  // 117r-D5 重钉(逐对交代):这一条原来钉的是 "=== 'quick_ask') state = 'quick_ask';",
  // 也就是第 0 条守卫「kind 是 quick_ask 就短路」。D5 把它换成「调用方有没有这条线程的事实」
  // (factsUnknown,默认有事实)—— 速查是一个 kind、不是一个 state,被短路掉的整台五态机器
  // 正是「在跑/在等你/跑完的速查线程都只会说速查中」的根因。断言的【意图】(两份抄写件的第 0 条
  // 分支逐字相同、且排在最前)一个字没变,变的只是那一行的字面量。
  // 伴随的更强断言在下面 BRANCH_GONE:除了钉住新守卫在两边逐字相同,还【反向】钉住旧守卫在两份
  // 抄写件里一处都不剩 —— 原来那一条只钉了「有」,钉不住有人把旧逃生舱悄悄加回来并存。
  "if (src.factsUnknown) state = 'quick_ask';",
  "pendingTotal > 0) state = 'needs_you';",
  "resultStatus === 'complete') state = 'done';",
  "autoMode === 'until-done' || src.liveRuns > 0) state = 'running';",
  "src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';",
  // 117p-S2(30 号文 §8.3):无账本线程分支,位置钉在 dispatching 之后、stopped 兜底之前。
  "else if (src.ledgerless && src.turnSeq > 0) state = src.lastTurnFailed ? 'stopped' : 'done';",
  "else state = 'stopped';",
];
let branchBad = [];
for (const b of BRANCHES) if (!(frontSrc.includes(b) && src06i.includes(b))) branchBad.push(b);
ok(branchBad.length === 0, '⑥ 06i 的五态分支与 public/js/mission-state.js 逐条相同(抄写件,非第二套状态机)' + (branchBad.length ? ' → ' + JSON.stringify(branchBad) : ''));
// 117r-D5 伴随断言(比被它替换掉的那一条更强):旧逃生舱在两份抄写件里一处都不剩。
// 只钉「新守卫在」挡不住有人把 `if (src.kind === 'quick_ask') state = 'quick_ask';` 加回来并存 ——
// 那样一条速查线程又会在第 0 条被劫走,而 BRANCHES 那张表照样全绿。
const BRANCH_GONE = "src.kind === 'quick_ask'";
ok(!frontSrc.includes(BRANCH_GONE) && !src06i.includes(BRANCH_GONE),
  "⑥ 「kind 是 quick_ask 就短路」那条旧逃生舱在两份抄写件里一处都不剩(速查是 kind 不是 state)");
ok(/来源:ruyi-workbench\/app\/public\/js\/mission-state\.js/.test(src06i), '⑥ 06i 注明抄写来源(改判据必须两边同改)');
// 分支顺序也要一致:两份源码里 6 个分支的出现顺序必须完全相同。
const orderOf = text => BRANCHES.map(b => text.indexOf(b));
const frontOrder = orderOf(frontSrc), coreOrder = orderOf(src06i);
const monotonic = arr => arr.every((v, i) => i === 0 || (v > arr[i - 1]));
ok(monotonic(frontOrder) && monotonic(coreOrder), '⑥ 两份源码里五态分支的出现顺序一致(顺序即判定优先级)');

/* ═════════════ 附:永久豁免正则与委托书纯函数 ═════════════ */

ok(srv.stewardToolPermanentlyExempt('send_email') && srv.stewardToolPermanentlyExempt('mcp_configure') === false
  || srv.stewardToolPermanentlyExempt('send_email'), '附 永久豁免正则命中对外发送类工具名');
for (const name of ['send_email', 'post_message', 'sms_send', 'pay_invoice', 'purchase_item', 'transfer_funds', 'uninstall_app', 'install_pkg', 'registry_write', 'system_setting_set', 'shutdown_host', 'format_disk']) {
  ok(srv.stewardToolPermanentlyExempt(name), `附 永久豁免命中 ${name}`);
}
for (const name of ['file_read', 'git_status', 'todo_write']) {
  ok(!srv.stewardToolPermanentlyExempt(name), `附 永久豁免不误伤 ${name}`);
}
{
  const composed = srv.buildStewardBrief({ userText: '把 <b>报告</b> 整理一下', goal: '<script>x</script>', acceptance: ['A > B'] });
  ok(composed.text.startsWith('把 <b>报告</b> 整理一下'), '附 委托书:用户原话逐字在最前(含尖括号,不被中和)');
  ok(composed.supplement.includes('[script]') && !composed.supplement.includes('<script>'), '附 委托书:管家补充里的尖括号被中和');
  ok(composed.text.includes('<steward-brief added-by="steward">') && composed.text.includes('</steward-brief>'), '附 委托书:补充放在管家围栏内并标注 added-by');
  const bare = srv.buildStewardBrief({ userText: '只有原话' });
  ok(bare.text === '只有原话', '附 委托书:无补充时不吐围栏(原话 === 整条消息)');
  const long = srv.buildStewardBrief({ userText: 'u', context: Array.from({ length: 12 }, () => 'x'.repeat(300)) });
  ok(long.truncated === true && long.supplement.length <= srv.STEWARD_BRIEF_LIMITS.supplementChars, '附 委托书:补充超 1200 字截断并标注 truncated');
}
{
  ok(srv.stewardTermJaccard('用户偏好中文输出', '用户偏好中文输出') === 1, '附 记忆去重:同句 Jaccard === 1');
  ok(srv.stewardTermJaccard('用户偏好中文输出', '今天天气不错') < 0.8, '附 记忆去重:无关句 Jaccard < 0.8');
}

/* ═════════════ ⑦ 116-2e:ctx.userPressed 的出现处白名单(全仓机械锁) ═════════════ */

// 「用户亲手按下了按钮」这件事只有一个来源:13h 的 POST /api/steward/act 执行路径。它一旦泄漏到
// 别处(比如被 stewardMayAct 或永久豁免判定读到),「用户点了一下」就会变成「管家从此可以放宽权限」
// —— 27 号文 §3.3 永久豁免第 2 条正是禁止这个。故这里把全仓每一处 userPressed 的出现点钉死:
//   · 06i-steward-core.js —— 只在契约注释里(纯函数层不读它);
//   · 13g-steward.js      —— 门控壳剥字段(117 波 T1 之后这里只剩剥字段那一处);
//   · 13k-steward-threads.js —— 派活原语那段的注释,加 117z-E2 的一处读点
//     (steward_thread_permission 的 capabilities.desktop === true 那一支,见下面的逐名对账);
//   · 13l-steward-ops.js  —— config_set / skill_toggle 两处「须确认」判定(T1 随实现从 13g 搬来);
//   · 13h-steward-runner.js —— 唯一置 true 的那一行(act 执行路径)。
// 任何第六个文件出现它 = 锁红。
// 117 波 T1 重钉:白名单从三个文件扩到五个,读点计数从「13g 里两处」改成「13g 族里两处、且都在
// 13l」。改的只是这两处代码住在哪个文件,被钉的事实(唯一置 true 点在 13h 的 act 路径、读点恰好
// 两处、权限门与授权书零 userPressed)一个字没变;读点那条还比原来严 —— 原来只看 13g 一个文件,
// 把实现搬进兄弟文件就绕过去了,现在整族一起数。
{
  const NEWLINE_RE = /\r?\n/;
  const COMMENT_RE = /^\s*(\/\/|\*|\/\*)/;
  const STEWARD_TOOL_FAMILY = ['13g-steward.js', '13j-steward-tool-base.js', '13k-steward-threads.js', '13l-steward-ops.js'];
  // 117 波 T2 重钉:白名单里的「13h」扩成 T2 拆出的运行器族六个文件(纯搬家)。三处出现点各自的
  // 落点:13m 是 ACTION_HOOKS 表头那两行注释、13q 是【唯一】置 true 的那一行(stewardRunAct)、
  // 13h 是 act 路由里「不置 userPressed」的那句注释。被钉的事实(唯一置 true 点在 act 路径、读点
  // 恰好两处且都在 13l、权限门与授权书零 userPressed)一个字没变。
  const ALLOWED = new Set(['06i-steward-core.js', ...STEWARD_TOOL_FAMILY, ...STEWARD_RUNNER_FAMILY]);
  const hits = [];
  for (const file of srcFiles) {
    const text = read(file);
    const count = (text.match(/userPressed/g) || []).length;
    if (count) hits.push([file, count, text]);
  }
  const outside = hits.filter(([file]) => !ALLOWED.has(file)).map(([file]) => file);
  ok(outside.length === 0, '⑦ userPressed 只出现在 06i / 13g 族 / 13h 族里' + (outside.length ? ' → ' + outside.join(',') : ''));
  const src13h2 = STEWARD_RUNNER_FAMILY.map(read).join('\n');
  const setters = (src13h2.match(/userPressed: true/g) || []).length;
  ok(setters === 1, `⑦ 全仓只有一处把 userPressed 置 true(13h 族的 act 执行路径;got ${setters})`);
  ok(/pathname === '\/api\/steward\/act'/.test(src13h2), "⑦ 那一处所在的路由就是 POST /api/steward/act");
  // 读它的地方只有 config_set 与 skill_toggle 的「须确认」判定(加上门控壳剥字段那一处)。
  // 只数【代码行】:注释里指路的那一句不算读。
  // 117z-E2(27 号文 §11.21.3)重钉:读点从两处扩到三处,期望值逐条列名而不是只数个数 ——
  // 第三处是 13k 的 steward_thread_permission 在 `capabilities.desktop === true`(= 给线程开桌面
  // 权限,本工具上唯一的放宽方向)那一支上的「恒提议、只有用户亲手按下才穿得过去」。
  // 为什么这次可以扩:被钉的红线是「按钮 ≠ 管家获得放宽权限的能力」。这一处开的是【会话级】覆盖,
  // 全局 allowDesktopTools 仍在 06i 的 forbidden 清册里,管家一个字都改不了;而且它只在放宽方向
  // 上读 userPressed,收紧方向(desktop:false)与档位轴的收紧一样不读 —— 「能自动的只有降,升永远
  // 要人按」这条机械规则在新那条轴上原样成立。下面三条断言一起看住这件事:
  //   (a) 全仓读点恰好三处;(b) 落点是 13l×2 + 13k×1(不是随便哪三处);
  //   (c) 13k 那一处必须写在 stewardImplThreadPermission 的函数体里,而且它的条件里带 wantDesktop
  //       === true —— 挪到别的线程族工具里、或者去掉「只在放宽方向上读」这个限定,都当场红。
  const readerLines = STEWARD_TOOL_FAMILY.flatMap(f => read(f).split(NEWLINE_RE)
    .filter(line => line.includes('ctx.userPressed') && !COMMENT_RE.test(line)).map(() => f));
  ok(readerLines.length === 3, `⑦ 13g 族里恰好三处读 ctx.userPressed(config_set / skill_toggle 的须确认判定 + thread_permission 的桌面放宽;got ${readerLines.length})`);
  const readerTally = readerLines.reduce((acc, f) => { acc[f] = (acc[f] || 0) + 1; return acc; }, {});
  ok(readerTally['13l-steward-ops.js'] === 2 && readerTally['13k-steward-threads.js'] === 1
    && Object.keys(readerTally).length === 2,
    `⑦ 落点逐名对账:13l 两处(设置族与内容管理族)+ 13k 一处(桌面放宽);got ${JSON.stringify(readerTally)}`);
  {
    const src13k = read('13k-steward-threads.js');
    const start = src13k.indexOf('async function stewardImplThreadPermission(');
    const end = start < 0 ? -1 : src13k.indexOf('\n}\n', start);
    const body = start < 0 ? '' : (end < 0 ? src13k.slice(start) : src13k.slice(start, end));
    ok(/ctx\.userPressed !== true/.test(body),
      '⑦ 13k 那一处就写在 stewardImplThreadPermission 的函数体里(不是散在别的线程族工具上)');
    ok(/if \(wantDesktop === true\) \{/.test(body) && body.indexOf('wantDesktop === true') < body.indexOf('ctx.userPressed'),
      '⑦ 而且它【只在放宽方向上】读:userPressed 那道闸整个住在 `wantDesktop === true` 的分支里面');
    ok(!/stewardMayTightenTo[\s\S]{0,400}ctx\.userPressed/.test(body),
      '⑦ 反向:档位轴的只降不升判定(stewardMayTightenTo)与 userPressed 之间没有任何耦合');
  }
  // 伴随:门控壳剥字段那一处仍在 13g —— 它是「args 里的同名字段一概不作数」的唯一执行点。
  ok(/for \(const key of Object\.keys\(raw\)\) \{ if \(key !== 'userPressed'\)/.test(src13g),
    '⑦ 门控壳剥 args.userPressed 那一处仍在 13g(唯一执行点,拆分没把它挪走)');
  ok(!/userPressed/.test(read('07-autonomy.js')) && !/userPressed/.test(read('06f-autonomy-grants.js')),
    '⑦ 权限门(07 nativeToolGate)与授权书(06f)源码里零 userPressed —— 按钮不等于扩权');
  const src06i2 = read('06i-steward-core.js');
  const codeLines = src06i2.split(NEWLINE_RE).filter(line => line.includes('userPressed') && !COMMENT_RE.test(line));
  ok(codeLines.length === 0, '⑦ 06i 里 userPressed 只出现在契约注释,不出现在任何一行代码');
}

// ⑧ 117w-W1 提交①(27 号文 §11.19.4):cwd 校验【一处实现、两处调用】。
// 被钉的事实:13k 里 thread_new 与 quick_ask 各自把 args.cwd 交给【同一个】stewardValidateCwd,
// 而不是各抄一份判据(抄两份 = 迟早分叉,提交②③ 再改一处就漏一处)。
// 计数口径按 §11.18.6 那个模具:定义签名与调用点【同形】的正则会假绿,所以这里
//   (a) 分开数「function stewardValidateCwd(」恰好 1 次(定义唯一),
//   (b) 数整名出现恰好 3 次(定义 1 + 调用 2),
//   (c) 再把两个调用点【锚到各自的函数体里】—— 只数次数挡不住「两处调用都写在 thread_new 里」。
// 另钉一条反向保护:修前那行原样透传(`cwd: args.cwd ? String(args.cwd)`)在 src 里必须零残留。
{
  const src13k = read('13k-steward-threads.js');
  const defs = (src13k.match(/function stewardValidateCwd\(/g) || []).length;
  ok(defs === 1, `⑧ stewardValidateCwd 只定义一次(got ${defs})`);
  const uses = (src13k.match(/stewardValidateCwd\(/g) || []).length;
  ok(uses === 3, `⑧ stewardValidateCwd 整文件出现 3 次 = 定义 1 + 调用 2(got ${uses})`);
  // 函数体切片:从 `async function X(` 起到下一个顶格 `}` 为止(本文件的顶层函数都顶格收尾)。
  const bodyOf = (name) => {
    const start = src13k.indexOf(`async function ${name}(`);
    if (start < 0) return '';
    const end = src13k.indexOf('\n}\n', start);
    return end < 0 ? src13k.slice(start) : src13k.slice(start, end);
  };
  const newBody = bodyOf('stewardImplThreadNew');
  const quickBody = bodyOf('stewardImplQuickAsk');
  ok(newBody && quickBody, '⑧ 取到 stewardImplThreadNew / stewardImplQuickAsk 两个函数体');
  const inNew = (newBody.match(/stewardValidateCwd\(args\.cwd, config\)/g) || []).length;
  const inQuick = (quickBody.match(/stewardValidateCwd\(args\.cwd, config\)/g) || []).length;
  ok(inNew === 1, `⑧ thread_new 函数体里恰好一处调用(got ${inNew})`);
  ok(inQuick === 1, `⑧ quick_ask 函数体里恰好一处调用(got ${inQuick})`);
  // 反向保护:修前那行原样透传不许留在任何 src 模块里。
  const passthrough = srcFiles.filter(f => /cwd:\s*args\.cwd\s*\?\s*String\(args\.cwd\)/.test(read(f)));
  ok(passthrough.length === 0, '⑧ 全 src 零「cwd: args.cwd ? String(args.cwd)」原样透传' + (passthrough.length ? ' → ' + passthrough.join(',') : ''));
  // 归一化只用仓里既有的那一份(01-config 的 normalizeWorkspacePathString),不许在 13k 里另写一套。
  ok(/normalizeWorkspacePathString\(/.test(src13k),
    '⑧ 归一化复用 01-config 的 normalizeWorkspacePathString(与 workspaces 清洗同一口径)');
}

// ⑨ 117w-W1 提交③(27 号文 §11.19.2 + §11.19.7 裁决):候选表上限【一处定义、两处读】。
// 被钉的事实:06i 定义 STEWARD_WORKSPACE_TABLE_MAX,13k 的 cwd 拒绝文案与 13o 的候选表投影都读它。
// 为什么静态与行为两层都要:steward-tools.e2e 的 O6 用 20 行夹具比较两个【运行期产出】,能抓住
// 「有人把其中一处改小」;「有人把其中一处改大」在行为层要造一张比上限还大的表才看得见,不是
// 这条锁的形状 —— 那一半靠这里的源码锁。
{
  const src06i = read('06i-steward-core.js');
  const src13k = read('13k-steward-threads.js');
  const src13o = read('13o-steward-runner-prompt.js');
  const defs = (src06i.match(/const STEWARD_WORKSPACE_TABLE_MAX = /g) || []).length;
  ok(defs === 1, `⑨ STEWARD_WORKSPACE_TABLE_MAX 在 06i 只定义一次(got ${defs})`);
  const others = srcFiles.filter(f => f !== '06i-steward-core.js' && /const STEWARD_WORKSPACE_TABLE_MAX/.test(read(f)));
  ok(others.length === 0, '⑨ 没有第二个模块另立同名常量' + (others.length ? ' → ' + others.join(',') : ''));
  // 两个消费者各自【在代码行里】读它(注释里提到不算)。
  const codeUses = (src, name) => src.split(/\r?\n/)
    .filter(line => line.includes(name) && !/^\s*(\/\/|\*|\/\*)/.test(line)).length;
  ok(codeUses(src13k, 'STEWARD_WORKSPACE_TABLE_MAX') >= 1, '⑨ 13k 的拒绝文案读同一个常量');
  ok(codeUses(src13o, 'STEWARD_WORKSPACE_TABLE_MAX') >= 1, '⑨ 13o 的候选表投影读同一个常量');
  // 反向保护:提交① 那个自立门户的 8 不许留在任何 src 模块里。
  const zombie = srcFiles.filter(f => /STEWARD_CWD_CANDIDATES_MAX/.test(read(f)));
  ok(zombie.length === 0, '⑨ 提交① 的 STEWARD_CWD_CANDIDATES_MAX 已零残留' + (zombie.length ? ' → ' + zombie.join(',') : ''));
}

// ⑩ 117w-W1 提交③:候选表是【只读投影】,不是配置转储。
// 被钉的事实:13o 的投影函数体里只出现 path / note / write 三个字段名,围栏字段一个都不出现。
// e2e 那边是按渲染出来的文本 grep 的(「上下文里没有这几个词」);这里钉的是【源码上取不到它们】——
// 有人日后往投影里加一行 `allowOutsideWorkspace: config.allowOutsideWorkspace` 时,哪怕它当时恰好
// 渲染成空串,这一条也会红。
{
  const src13o = read('13o-steward-runner-prompt.js');
  const start = src13o.indexOf('function stewardWorkspaceTableBlock(');
  const end = src13o.indexOf('\n}\n', start);
  const body = start < 0 ? '' : src13o.slice(start, end < 0 ? undefined : end);
  ok(!!body, '⑩ 取到 stewardWorkspaceTableBlock 函数体');
  for (const fence of ['allowOutsideWorkspace', 'additionalDirectories', 'recentWorkspaces', 'defaultWorkspace', 'apiKey']) {
    ok(!body.includes(fence), `⑩ 投影函数体里零「${fence}」`);
  }
  ok(/row\.write === false/.test(body), '⑩ 只读标的判据写死 `write === false`(缺字段的老配置默认可写,不能反过来)');
}

// ⑪ 117w-W1④(27 号文 §11.19.8 债表第一行):workspaces[] 的行数帽子【一处定义、两处读】。
// 被钉的事实:01-config 的清洗块里两支循环(原始数组那一支、从 defaultWorkspace + recentWorkspaces
// 播种那一支)都读同一个 WORKSPACE_TABLE_CAP,清洗块的【代码行】里零裸字面量帽子。
// 为什么要钉:修前那两处是两个各自写死的 `>= 20`,谁只改一处,配置就会出现「原始数组能存 64 行、
// 播种只播 20 行」这种谁也说不清的形状。行为层(steward-tools.e2e P1/P1b)只走得到第一支
// —— 播种那一支要 configSchema < 10 且表为空才可达,那一半靠这里的源码锁。
{
  const src01 = read('01-config.js');
  const defs = (src01.match(/const WORKSPACE_TABLE_CAP = /g) || []).length;
  ok(defs === 1, `⑪ WORKSPACE_TABLE_CAP 在 01-config 只定义一次(got ${defs})`);
  const others = srcFiles.filter(f => f !== '01-config.js' && /const WORKSPACE_TABLE_CAP/.test(read(f)));
  ok(others.length === 0, '⑪ 没有第二个模块另立同名常量' + (others.length ? ' → ' + others.join(',') : ''));
  // 清洗块切片:从 workspaces 那段块注释起,到 `config.workspaces = clean;` 落定为止(两支循环都在里面)。
  const wsStart = src01.indexOf('// v2.7 (workspace permissions): workspaces');
  const wsEnd = src01.indexOf('config.workspaces = clean;', wsStart);
  const wsBlock = (wsStart < 0 || wsEnd < 0) ? '' : src01.slice(wsStart, wsEnd);
  ok(!!wsBlock, '⑪ 取到 01-config 的 workspaces 清洗块');
  // 只看【代码行】:块注释里为了讲清来历会写「20 -> 64」,那不是帽子。
  const wsCode = wsBlock.split(/\r?\n/).filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const capReads = wsCode.filter(line => line.includes('WORKSPACE_TABLE_CAP')).length;
  ok(capReads === 2, `⑪ 清洗块的两支循环各读一次同一个常量(got ${capReads})`);
  const bareCaps = wsCode.filter(line => /clean\.length >= \d/.test(line));
  ok(bareCaps.length === 0, '⑪ 清洗块代码行里零裸字面量帽子' + (bareCaps.length ? ' → ' + JSON.stringify(bareCaps) : ''));
  ok(!/\bWORKSPACE_TABLE_CAP\b\s*=\s*20\b/.test(src01), '⑪ 反向:常量没被悄悄改回 20');

  // 派生前的帽检查:一处实现、三处调用(与 ⑧ 的 stewardValidateCwd 同一模具)。第三处是
  // 117w-W1④ 小刀加的复检:占位(建目录 + append)与帽检查现在同处一个 mutateConfig 串行段,
  // 预检时那份配置副本可能已经过期(另一条线程刚占了第 64 行)。
  const src13k = read('13k-steward-threads.js');
  const capDefs = (src13k.match(/function stewardWorkspaceTableFull\(/g) || []).length;
  ok(capDefs === 1, `⑪ stewardWorkspaceTableFull 只定义一次(got ${capDefs})`);
  const capUses = (src13k.match(/stewardWorkspaceTableFull\(/g) || []).length;
  ok(capUses === 4, `⑪ 整文件出现 4 次 = 定义 1 + 调用 3(两个工具入口的预检 + 串行段里的复检;got ${capUses})`);
  const bodyOfCap = (name) => {
    const start = src13k.indexOf(`async function ${name}(`);
    if (start < 0) return '';
    const end = src13k.indexOf('\n}\n', start);
    return end < 0 ? src13k.slice(start) : src13k.slice(start, end);
  };
  const newBodyCap = bodyOfCap('stewardImplThreadNew');
  const quickBodyCap = bodyOfCap('stewardImplQuickAsk');
  ok((newBodyCap.match(/stewardWorkspaceTableFull\(config\)/g) || []).length === 1, '⑪ thread_new 函数体里恰好一处帽检查');
  ok((quickBodyCap.match(/stewardWorkspaceTableFull\(config\)/g) || []).length === 1, '⑪ quick_ask 函数体里恰好一处帽检查');
  // 帽检查读的是【同一个】常量,不是自己再写一个数。
  const capFnStart = src13k.indexOf('function stewardWorkspaceTableFull(');
  const capFnEnd = src13k.indexOf('\n}\n', capFnStart);
  const capFnBody = capFnStart < 0 ? '' : src13k.slice(capFnStart, capFnEnd < 0 ? undefined : capFnEnd);
  ok(/WORKSPACE_TABLE_CAP/.test(capFnBody), '⑪ 帽检查读 01-config 的 WORKSPACE_TABLE_CAP(不另写一个数)');
  ok(/workspace_table_full/.test(capFnBody), '⑪ 帽满走【专属 reason】workspace_table_full,不与 cwd_not_in_workspaces 混为一谈');
  // 反向保护:两个调用点都必须在【派生分支】里(cwd 省略才派生;给了表内 cwd 的线程不该被帽子挡)。
  ok(/cwdCheck\.cwd === undefined\)\s*\{\s*\n\s*const capFail/.test(newBodyCap.replace(/\r/g, ''))
    || /cwdCheck\.cwd === undefined[\s\S]{0,200}stewardWorkspaceTableFull\(config\)/.test(newBodyCap),
    '⑪ thread_new 的帽检查挂在「省略 cwd」那一支下(表内 cwd 不派生,不该被挡)');
  ok(/quickCwdCheck\.cwd === undefined[\s\S]{0,200}stewardWorkspaceTableFull\(config\)/.test(quickBodyCap),
    '⑪ quick_ask 的帽检查同样挂在「省略 cwd」那一支下');
}

// ── ⑫ 126-M02:「什么叫过期」只许有一个判据口 ─────────────────────────────────────────
// 管家记忆补了 expiresAt(44 号文 §1.2)。判据**没有**在管家族里另写一份 —— 复用工作台库
// 06d 已有的 memoryIsExpired(它只读 .expiresAt,与条目形状无关)。这就是本波说的「两库职责
// 划分」:两套存储,一套判据。这把锁钉住这件事,否则哪天有人在某个读取口里顺手写一句
// `Date.parse(e.expiresAt) < Date.now()`,两处判据就开始各说各话(与 125 波「判据唯一」同一个模具)。
{
  const stewardFiles = fs.readdirSync(SRC).filter(n => /^(06i|13[fgjklmo])-/.test(n) && n.endsWith('.js'));
  const offenders = [];
  let callers = 0;
  for (const name of stewardFiles) {
    const text = fs.readFileSync(path.join(SRC, name), 'utf8');
    if (/\bmemoryIsExpired\s*\(/.test(text)) callers++;
    for (const line of text.split(/\r?\n/)) {
      if (!/expiresAt/.test(line)) continue;
      if (/^\s*(\/\/|\*)/.test(line)) continue;                 // 注释里怎么写都行
      if (/Date\.parse\s*\(|new Date\s*\(/.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 100)}`);
    }
  }
  ok(stewardFiles.length >= 6, `⑫ 扫得到管家族文件（实得 ${stewardFiles.length} 个；扫不到 = 本条静默失效）`);
  ok(callers >= 2, `⑫ 管家族里真的在用那一个判据 memoryIsExpired（实得 ${callers} 个文件；一个都没有 = 过滤被摘掉了）`);
  ok(offenders.length === 0,
    `⑫ 管家族不许自己解析 expiresAt —— 判据只有 06d 的 memoryIsExpired 一处${offenders.length ? '；实得：' + offenders.join(' ⏐ ') : ''}`);
}

// ── ⑬ 126-M01:「作用域算不算数」也只许有一个判据口 ─────────────────────────────────
// 与 ⑫ 同一个模具:归一与匹配都在 13j 的 stewardNormalizeMemoryScope / stewardMemoryScopeMatches,
// 管家族别处不许自己算项目键(那会造出第二套口径)。判据住 13j 而不是 06i 是被依赖图逼出来的:
// 实测 manifest 里 06i@18 排在 06d@19 之前,06i 引用 06d 的 projectKeyForCwd 是前向边且连带
// 造出 7 条循环边 —— 与 125-P1「06i 读 06 会造 7 条循环边」是同一个坑、同一个文件。
{
  const scopeFiles = fs.readdirSync(SRC).filter(n => /^(06i|13[fgjklmo])-/.test(n) && n.endsWith('.js'));
  const offenders2 = [];
  let matchers = 0;
  for (const name of scopeFiles) {
    const text = fs.readFileSync(path.join(SRC, name), 'utf8');
    if (/\bstewardMemoryScopeMatches\s*\(/.test(text)) matchers++;
    if (name === '13j-steward-tool-base.js') continue;   // 判据本身住这儿
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;          // 注释里怎么写都行
      if (/projectKeyForCwd\s*\(/.test(line)) offenders2.push(`${name}: ${line.trim().slice(0, 90)}`);
    }
  }
  ok(matchers >= 1, `⑬ 管家族里真的在用那一个作用域判据 stewardMemoryScopeMatches（实得 ${matchers} 个文件；一个都没有 = 过滤被摘掉了）`);
  ok(offenders2.length === 0,
    `⑬ 管家族不许自己算项目键 —— 键只由 13j 那一处从 06d 的 projectKeyForCwd 推${offenders2.length ? '；实得：' + offenders2.join(' ⏐ ') : ''}`);
}

console.log('');
if (fail) { console.log(`STEWARD TOOLS STATIC E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD TOOLS STATIC E2E: ALL PASS');

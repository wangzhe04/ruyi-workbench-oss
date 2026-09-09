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
const src13h = read('13h-steward-runner.js');   // 117m-A4 ①c/①d:ACTION_HOOKS 与人话标签的登记面

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

ok(JSON.stringify(schemaNames) === JSON.stringify(expected), `① 13f schema 恰好登记 27 个 steward_*(got ${schemaNames.length})`);
ok(JSON.stringify(regNames) === JSON.stringify(expected), `① 12 TOOL_HANDLERS 恰好登记 27 个 steward_*(got ${regNames.length})`);
ok(JSON.stringify(tierNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_TIER 恰好登记 27 个 steward_*(got ${tierNames.length})`);
ok(JSON.stringify(packNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_PACKS 恰好登记 27 个 steward_*(got ${packNames.length})`);
// 117m-A4 重钉 89 -> 90。理由:本波【真的新增了一个工具】(steward_thread_stop),数字变化就是被测事实
// 本身,不是把闸门放宽 —— 这条断言的语义是「注册表里一个不多一个不少」,重钉后它仍是等号。
// 按「断言只加不改」的纪律,重钉的同时补两条【更强】的伴随断言(下面 ①b/①c):新增的这一个必须
// 恰好是决策族里【唯一】的线程级停止原语,且必须真的登记进了 13h 的 STEWARD_ACTION_HOOKS ——
// 只钉总数会让「加错了一个工具」也照样过。
ok(Object.keys(srv.TOOL_HANDLERS).length === 90, `① 注册表总数 90(63 + 27;117m-A4 增 thread_stop;got ${Object.keys(srv.TOOL_HANDLERS).length})`);
const stopPrimitives = expected.filter(n => /_stop$/.test(n));
ok(JSON.stringify(stopPrimitives) === JSON.stringify(['steward_thread_stop']),
  `①b 决策族里恰好【一个】线程级停止原语(多一个 = 两条停机路径,少一个 = 管家又只能拿 run_action 凑;got ${JSON.stringify(stopPrimitives)})`);
const hooksBlock = src13h.slice(src13h.indexOf('const STEWARD_ACTION_HOOKS'), src13h.indexOf('const STEWARD_DECIDE_LABELS'));
ok(/steward_thread_stop: 'threadStop'/.test(hooksBlock),
  '①c steward_thread_stop 登记进 13h 的 STEWARD_ACTION_HOOKS(不在表里 = 用户亲手按那枚按钮时 not_allowed)');
ok(/steward_thread_stop: '暂停这条线程'/.test(src13h),
  '①d STEWARD_TOOL_LABELS 有它的人话标签(※ 脚注与降级按钮不许吐 steward_thread_stop 这个内部 id)');

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
ok(STEWARD_TOOLS.every(n => typeof srv.StewardHooks[HOOK_KEY[n]] === 'function'), '③ 27 个工具的实现键全部落在 StewardHooks 上');
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
ok(offeredSteward.length === 27, `⑤ 回环:管家会话 buildOpenAiTools 拿到 27 个 steward_*(got ${offeredSteward.length})`);
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
//   · 13k-steward-threads.js —— 只在注释里(派活原语那段解释「用 trigger 而不是 userPressed」);
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
  const ALLOWED = new Set(['06i-steward-core.js', ...STEWARD_TOOL_FAMILY, '13h-steward-runner.js']);
  const hits = [];
  for (const file of srcFiles) {
    const text = read(file);
    const count = (text.match(/userPressed/g) || []).length;
    if (count) hits.push([file, count, text]);
  }
  const outside = hits.filter(([file]) => !ALLOWED.has(file)).map(([file]) => file);
  ok(outside.length === 0, '⑦ userPressed 只出现在 06i / 13g 族 / 13h 里' + (outside.length ? ' → ' + outside.join(',') : ''));
  const src13h2 = read('13h-steward-runner.js');
  const setters = (src13h2.match(/userPressed: true/g) || []).length;
  ok(setters === 1, `⑦ 全仓只有一处把 userPressed 置 true(13h 的 act 执行路径;got ${setters})`);
  ok(/pathname === '\/api\/steward\/act'/.test(src13h2), "⑦ 那一处所在的路由就是 POST /api/steward/act");
  // 读它的地方只有 config_set 与 skill_toggle 的「须确认」判定(加上门控壳剥字段那一处)。
  // 只数【代码行】:注释里指路的那一句不算读。
  const readerLines = STEWARD_TOOL_FAMILY.flatMap(f => read(f).split(NEWLINE_RE)
    .filter(line => line.includes('ctx.userPressed') && !COMMENT_RE.test(line)).map(() => f));
  ok(readerLines.length === 2, `⑦ 13g 族里只有两处读 ctx.userPressed(config_set / skill_toggle 的须确认判定;got ${readerLines.length})`);
  ok(readerLines.every(f => f === '13l-steward-ops.js'),
    `⑦ 这两处都在 13l-steward-ops.js(设置族与内容管理族的实现所在;got ${JSON.stringify(readerLines)})`);
  // 伴随:门控壳剥字段那一处仍在 13g —— 它是「args 里的同名字段一概不作数」的唯一执行点。
  ok(/for \(const key of Object\.keys\(raw\)\) \{ if \(key !== 'userPressed'\)/.test(src13g),
    '⑦ 门控壳剥 args.userPressed 那一处仍在 13g(唯一执行点,拆分没把它挪走)');
  ok(!/userPressed/.test(read('07-autonomy.js')) && !/userPressed/.test(read('06f-autonomy-grants.js')),
    '⑦ 权限门(07 nativeToolGate)与授权书(06f)源码里零 userPressed —— 按钮不等于扩权');
  const src06i2 = read('06i-steward-core.js');
  const codeLines = src06i2.split(NEWLINE_RE).filter(line => line.includes('userPressed') && !COMMENT_RE.test(line));
  ok(codeLines.length === 0, '⑦ 06i 里 userPressed 只出现在契约注释,不出现在任何一行代码');
}

console.log('');
if (fail) { console.log(`STEWARD TOOLS STATIC E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD TOOLS STATIC E2E: ALL PASS');

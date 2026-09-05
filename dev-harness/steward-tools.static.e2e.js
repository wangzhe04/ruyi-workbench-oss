#!/usr/bin/env node
'use strict';
// 静态锁:第 116 波 116c(27 号文 §3.5 工具面 / §11.3 第 49 波入库门)—— 管家 20 个工具的
// 「四处登记一致」与模块落点纪律。判定行:`STEWARD TOOLS STATIC E2E: ALL PASS`。
//
// 断言六个方向:
//   ① 四处登记一致:13f schema / 12 handler 注册表 / 07 NATIVE_TOOL_TIER / 07 NATIVE_TOOL_PACKS
//      四个表的 steward_* 键集必须【完全相同】且恰好是这 20 个名字(任何一处漏登 = 锁红)。
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
  'steward_thread_note',
  'steward_decide', 'steward_run_action',
  'steward_memory_write', 'steward_memory_veto', 'steward_memory_search',
];
const EXPECTED_TIER = {
  steward_self_status: 'read', steward_threads_search: 'read', steward_thread_status: 'read',
  steward_thread_read: 'read', steward_runs_status: 'read', steward_inbox_read: 'read',
  steward_usage: 'read', steward_health: 'read', steward_audit_tail: 'read',
  steward_missions: 'read', // 116g: 事项级只读视图,零副作用
  steward_thread_new: 'edit', steward_thread_continue: 'edit', steward_thread_rename: 'edit',
  steward_thread_permission: 'edit', // 116-2a: 线程权限只降不升,归线程族 edit
  steward_thread_note: 'edit',       // 116-2b: 给在跑的线程补一句上下文,归线程族 edit
  steward_decide: 'exec', steward_run_action: 'exec',
  steward_memory_write: 'edit', steward_memory_veto: 'edit', steward_memory_search: 'edit',
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
  steward_decide: 'decide', steward_run_action: 'runAction',
  steward_memory_write: 'memoryWrite', steward_memory_veto: 'memoryVeto', steward_memory_search: 'memorySearch',
};

const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const src06i = read('06i-steward-core.js');
const src07 = read('07-autonomy.js');
const src11 = read('11-native-tools.js');
const src12 = read('12-tool-dispatch.js');
const src13 = read('13-http-router.js');
const src13f = read('13f-native-tool-schemas.js');
const src13g = read('13g-steward.js');

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

ok(JSON.stringify(schemaNames) === JSON.stringify(expected), `① 13f schema 恰好登记 20 个 steward_*(got ${schemaNames.length})`);
ok(JSON.stringify(regNames) === JSON.stringify(expected), `① 12 TOOL_HANDLERS 恰好登记 20 个 steward_*(got ${regNames.length})`);
ok(JSON.stringify(tierNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_TIER 恰好登记 20 个 steward_*(got ${tierNames.length})`);
ok(JSON.stringify(packNames) === JSON.stringify(expected), `① 07 NATIVE_TOOL_PACKS 恰好登记 20 个 steward_*(got ${packNames.length})`);
ok(Object.keys(srv.TOOL_HANDLERS).length === 83, `① 注册表总数 83(63 + 20;116g 增 steward_missions;got ${Object.keys(srv.TOOL_HANDLERS).length})`);

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
  .filter(k => typeof srv.StewardHooks[k] === 'function' || /^(handleApiRoutes|stopInbox|inboxState|inboxRead|selfStatus|threadsSearch|threadStatus|threadRead|runsStatus|inboxReadTool|usage|health|auditTail|threadNew|threadContinue|threadRename|threadPermission|threadNote|missions|decide|runAction|memoryWrite|memoryVeto|memorySearch)$/.test(k));
const filled = Object.keys(srv.StewardHooks);
const missingFill = contractKeys.filter(k => typeof srv.StewardHooks[k] !== 'function');
ok(contractKeys.length >= 24, `③ 06i 契约注释列出 ≥24 个预留键(116g 增 missions;got ${contractKeys.length})`);
ok(missingFill.length === 0, '③ 13g 填充键集 ⊇ 06i 契约注释列出的键' + (missingFill.length ? ' → 未填充: ' + missingFill.join(',') : ''));
ok(STEWARD_TOOLS.every(n => typeof srv.StewardHooks[HOOK_KEY[n]] === 'function'), '③ 20 个工具的实现键全部落在 StewardHooks 上');
ok(filled.length >= 24, `③ StewardHooks 至少 24 个实现键(4 个 116b 基础设施 + 20 个工具;got ${filled.length})`);
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
ok(offeredSteward.length === 20, `⑤ 回环:管家会话 buildOpenAiTools 拿到 20 个 steward_*(got ${offeredSteward.length})`);
ok(/steward\.forbidden/.test(src13g) && /steward\.disabled/.test(src13g), '⑤ 13g 门控壳含 steward.forbidden / steward.disabled 两个稳定信封');
ok(/session\.kind === 'steward'/.test(src13g), "⑤ 13g 身份判定读【显式】session.kind === 'steward'(不经 sessionKind 归一)");

/* ═════════════ ⑥ 五态判据与前端 mission-state.js 机械对账 ═════════════ */

const frontSrc = fs.readFileSync(path.join(APP, 'public', 'js', 'mission-state.js'), 'utf8');
const BRANCHES = [
  "=== 'quick_ask') state = 'quick_ask';",
  "pendingTotal > 0) state = 'needs_you';",
  "resultStatus === 'complete') state = 'done';",
  "autoMode === 'until-done' || src.liveRuns > 0) state = 'running';",
  "src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';",
  "else state = 'stopped';",
];
let branchBad = [];
for (const b of BRANCHES) if (!(frontSrc.includes(b) && src06i.includes(b))) branchBad.push(b);
ok(branchBad.length === 0, '⑥ 06i 的五态分支与 public/js/mission-state.js 逐条相同(抄写件,非第二套状态机)' + (branchBad.length ? ' → ' + JSON.stringify(branchBad) : ''));
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

console.log('');
if (fail) { console.log(`STEWARD TOOLS STATIC E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD TOOLS STATIC E2E: ALL PASS');

#!/usr/bin/env node
'use strict';
// 静态门(第 116 波 116b · 27 号文 §11.3):管家收件箱的【源事件机械对账】与落点契约。
//
// 为什么是机械对账而不是人肉清单(先例:dev-harness/progress-events.static.e2e.js 的 D1/D2/D3):
// 管家只认五类事件(等你/失败/收工/停滞/预算),其余一律丢弃。「丢弃」如果靠沉默的 default 分支,
// 新事件加进引擎时没人会记得回来看管家一眼 —— 与 112b 摸底发现的「服务端发 54 种、前端认 34 种」
// 同一根因。故本门把三个源在【源码写入端】出现的每一个 type 字面量扫出来,逐个要求在
// STEWARD_SOURCE_EVENT_MAP 里有登记(登记为 null 也算登记),反向再要求表里没有僵尸条目。
//
// 五条判定:
//   D1 mission change:02-session-store.js 的 MISSION_CHANGE_TYPES 集合 ↔ 表 missionChange 子表,双向等集。
//   D2 agent run:全 src 扫 appendAgentRunEvent(...) 的 type 表达式里的字面量 ↔ 表 agentRun 子表,双向等集。
//      (三元表达式里的比较值不是事件 type,必须在 NON_TYPE_LITERALS 里写明理由 —— 想放行就得留一行字。)
//   D3 intervention:全 src 扫 registerIntervention(sid, '<type>', ...) ↔ 表 intervention 子表,双向等集。
//   D4 模块落点:manifest 里 13g-steward.js 紧跟 13e-pretender-index.js 之后、14-main.js 之前。
//   D7 第四源 sessionTurns(116-4):登记在表里、走 @sessionTurn 解析器、收集器与它的三条判据
//      (速查线程 / launchedBy:'steward' / 别人事项里的线程)都在 13i,且 13g 真的在会话头上写这两个标。
//   D5 挂接纪律:13-http-router.js 只经 StewardHooks 挂路由与关服收尾 —— 源码含
//      `StewardHooks.handleApiRoutes` / `StewardHooks.stopInbox`,且【不含】`handleStewardApiRoutes`
//      字面量(直接引用 13g 的符号 = 新前向边,是本切片的硬红线);另锁开关门控与 ROUTE_AUTH 档位。
//
// 判定行:`STEWARD EVENTS STATIC E2E: ALL PASS`。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const okSet = (missing, extra, label) => ok(missing.length === 0 && extra.length === 0,
  label + (missing.length ? ` :: 源码有表里没有(未登记): ${missing.join(', ')}` : '')
        + (extra.length ? ` :: 表里有源码没有(僵尸条目): ${extra.join(', ')}` : ''));

const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');
const srcFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();

// 表本身从产物 require(与生产运行的是同一份;临时 HOME 防污染真实数据根)。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-events-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const { STEWARD_SOURCE_EVENT_MAP, STEWARD_EVENT_KINDS } = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));

/* ═══════════════ D1 mission change ═══════════════ */

{
  const text = read('02-session-store.js');
  const start = text.indexOf('const MISSION_CHANGE_TYPES = new Set([');
  ok(start >= 0, 'D1 找到 02-session-store.js 的 MISSION_CHANGE_TYPES 集合(扫描锚点)');
  const end = text.indexOf(']);', start);
  const block = text.slice(start, end);
  const scanned = [...block.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  ok(scanned.length >= 8, `D1 扫到 ${scanned.length} 种 mission change type(下界 8,防扫描器悄悄失灵)`);
  const table = Object.keys(STEWARD_SOURCE_EVENT_MAP.missionChange).sort();
  okSet(scanned.filter(t => !table.includes(t)), table.filter(t => !scanned.includes(t)),
    `D1 mission change ${scanned.length} 种全部登记且无僵尸`);
}

/* ═══════════════ D2 agent run ═══════════════ */

// 三元/比较里出现、但不是事件 type 的字面量。加一条必须写明理由(豁免是登记,不是免罪符)。
const NON_TYPE_LITERALS = Object.freeze({
  queued: "09-workflow.js `node.status === 'queued' ? 'node_requeued' : 'node_settled'` 里的 node.status 比较值,不是事件 type。",
});

// 从 appendAgentRunEvent( 起,取 `type:` 后面到同层逗号/右花括号为止的表达式,收集其中全部字符串字面量。
function typeExpressionLiterals(text) {
  const out = new Set();
  let from = 0;
  for (;;) {
    const call = text.indexOf('appendAgentRunEvent(', from);
    if (call < 0) break;
    from = call + 1;
    const scope = text.slice(call, call + 800);
    const typeAt = scope.indexOf('type:');
    if (typeAt < 0) continue; // appendAgentRunEvent 的函数定义本身
    let depth = 0, quote = null, expr = '';
    for (let i = typeAt + 'type:'.length; i < scope.length; i++) {
      const ch = scope[i];
      if (quote) { expr += ch; if (ch === '\\') { expr += scope[++i] || ''; continue; } if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; expr += ch; continue; }
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
      else if (ch === ',' && depth === 0) break;
      expr += ch;
    }
    for (const m of expr.matchAll(/'([^']*)'/g)) out.add(m[1]);
  }
  return out;
}

{
  const literals = new Set();
  for (const file of srcFiles) for (const value of typeExpressionLiterals(read(file))) literals.add(value);
  const exempt = [...literals].filter(v => Object.prototype.hasOwnProperty.call(NON_TYPE_LITERALS, v)).sort();
  const scanned = [...literals].filter(v => !Object.prototype.hasOwnProperty.call(NON_TYPE_LITERALS, v)).sort();
  ok(scanned.length >= 20, `D2 扫到 ${scanned.length} 种 run 事件 type(下界 20,防扫描器悄悄失灵)`);
  ok(scanned.includes('run_end') && scanned.includes('node_settled') && scanned.includes('node_requeued'),
    'D2 扫描器认得三元表达式的两支(node_requeued / node_settled)');
  ok(exempt.length === 1 && exempt[0] === 'queued', `D2 非 type 字面量豁免恰 1 条且已写明理由: ${exempt.join(', ')}`);
  const table = Object.keys(STEWARD_SOURCE_EVENT_MAP.agentRun).sort();
  okSet(scanned.filter(t => !table.includes(t)), table.filter(t => !scanned.includes(t)),
    `D2 agent run ${scanned.length} 种全部登记且无僵尸`);
}

/* ═══════════════ D3 intervention ═══════════════ */

{
  const literals = new Set();
  for (const file of srcFiles) {
    for (const m of read(file).matchAll(/registerIntervention\(\s*[A-Za-z0-9_.]+\s*,\s*'([a-z_]+)'/g)) literals.add(m[1]);
  }
  const scanned = [...literals].sort();
  ok(scanned.length >= 4, `D3 扫到 ${scanned.length} 种待决 type(下界 4:permission/question/plan/pool)`);
  const table = Object.keys(STEWARD_SOURCE_EVENT_MAP.intervention).sort();
  okSet(scanned.filter(t => !table.includes(t)), table.filter(t => !scanned.includes(t)),
    `D3 intervention ${scanned.length} 种全部登记且无僵尸`);
  // 五类白名单本身不许漂:表里出现的 kind 必须全落在 STEWARD_EVENT_KINDS。
  const kinds = new Set();
  for (const sub of Object.values(STEWARD_SOURCE_EVENT_MAP)) for (const v of Object.values(sub)) if (typeof v === 'string' && !v.startsWith('@')) kinds.add(v);
  ok([...kinds].every(k => STEWARD_EVENT_KINDS.includes(k)), 'D3 表里出现的 kind 全在五类白名单内: ' + [...kinds].sort().join('/'));
}

/* ═══════════════ D4 模块落点 ═══════════════ */

{
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const files = manifest.modules.map(m => (typeof m === 'string' ? m : m.file));
  const i = files.indexOf('13g-steward.js');
  ok(i > 0, 'D4 manifest 含 13g-steward.js');
  // 116-2e 重钉:13g 与 13e 之间插入了 13i-steward-inbox.js(收件箱轮询与游标的零行为搬家落点;
  // 只能前置 —— steward-runner.static ① 同时锁着「13h 紧跟 13g」与「13h 紧邻 14-main」)。判据的用意
  // 不变 —— 管家这一族仍连续地待在 transport 层末尾、组合根 14-main 之前。
  ok(files[i - 1] === '13i-steward-inbox.js', 'D4 13g 紧跟 13i-steward-inbox.js 之后(116-2e 重钉)');
  ok(files[i - 2] === '13e-pretender-index.js', 'D4 13i 紧跟 13e-pretender-index.js 之后');
  ok(fs.existsSync(path.join(SRC, '13i-steward-inbox.js')), 'D4 13i-steward-inbox.js 文件存在');
  // 116f 重钉:13g 与 14-main 之间插入了 13h-steward-runner.js(管家回合运行器,同为 transport 层;
  // 理由见 116c 交付记录「13g 已 1710 行,116f 另起 13h」)。判据的用意不变 —— 13g 仍在 transport 层
  // 末尾、组合根 14-main 之前,故改钉「13g 之后是 13h」+「14-main 仍是最后一个模块」。
  ok(files[i + 1] === '13h-steward-runner.js', 'D4 13g 之后是 13h-steward-runner.js(116f 重钉)');
  ok(files[files.length - 1] === '14-main.js', 'D4 14-main.js 仍是组合根(最后一个模块)');
  ok(fs.existsSync(path.join(SRC, '13g-steward.js')), 'D4 13g-steward.js 文件存在');
}

/* ═══════════════ D5 挂接纪律 / 开关门控 / 鉴权档位 ═══════════════ */

{
  const router = read('13-http-router.js');
  ok(router.includes('StewardHooks.handleApiRoutes'), 'D5 13-http-router 经 StewardHooks.handleApiRoutes 挂路由');
  ok(router.includes('StewardHooks.stopInbox'), 'D5 13-http-router 关服收尾经 StewardHooks.stopInbox 停轮询');
  ok(!router.includes('handleStewardApiRoutes'), 'D5 13-http-router 不含 handleStewardApiRoutes 字面量(直接引用 13g = 新前向边,红线)');
  ok(!/\bstartStewardInbox\b/.test(router), 'D5 13-http-router 不直接引用 startStewardInbox');

  const steward = read('13g-steward.js');
  // 116-2e 重钉(只改读哪个文件,断言语义与文本不变):收件箱轮询与游标整体前移到 13i-steward-inbox.js,
  // 13g 只留路由/决策日志/记忆/工具管道。故下面四条读的是 13i,Object.assign 那条仍读 13g。
  const inbox = read('13i-steward-inbox.js');
  ok(/Object\.assign\(StewardHooks, \{/.test(steward), 'D5 13g 用 Object.assign(StewardHooks, {...}) 延迟绑定填充');
  ok(/function startStewardInbox\(config\)[\s\S]{0,400}stewardEnabledV1 !== true\) return \{ ok: false, running: false/.test(inbox),
    'D5 开关关(stewardEnabledV1 !== true)时 startStewardInbox 立即返回:零 interval、零目录、零写入');
  ok(!/setInterval/.test(inbox.slice(0, inbox.indexOf('async function startStewardInbox'))),
    'D5 模块加载期不起任何 interval(轮询只能由 startStewardInbox 起)');
  ok(inbox.includes("path.join(paths.data, STEWARD_DIR_NAME)") && !inbox.includes("paths.steward"),
    'D5 <data>/steward 不进 paths 常量表(否则 ensureDirs 会在开关关时也建目录)');
  ok(inbox.includes('repairMissionChangeTornTail'), 'D5 inbox 追加复用 session-changes 同款 NDJSON 原语(不新造)');
  ok(inbox.includes('atomicWriteJson(stewardCursorPath()'), 'D5 游标经 atomicWriteJson 落盘');

  const main = read('14-main.js');
  ok(/startStewardInbox\(await readConfig\(\)\)/.test(main), 'D5 14-main 在 startServer 返回后调用 startStewardInbox(config)');

  const auth = read('01b-route-auth.js');
  for (const p of ['/api/steward/start', '/api/steward/stop', '/api/steward/state', '/api/steward/inbox']) {
    ok(new RegExp(`p: '${p.replace(/\//g, '\\/')}', auth: 'token' \\}`).test(auth), `D5 ROUTE_AUTH ${p} = token 级`);
  }
}

/* ═══════════════ D6 116-2b 停滞/预算信号的新 type 登记 ═══════════════ */

// D1/D2 的双向等集已经保证「源码有的表里都有」;D6 另钉【归类是否正确】—— 等集只管有没有登记,
// 不管登记成什么。四个新 type 各自该落哪一类是 116-2b 的设计判断,值得单独一条断言看住。
{
  const mc = STEWARD_SOURCE_EVENT_MAP.missionChange;
  const ar = STEWARD_SOURCE_EVENT_MAP.agentRun;
  ok(mc.stalled === 'stalled', "D6 change type 'stalled' → 五类的 stalled");
  ok(mc.budget_tripped === 'budget', "D6 change type 'budget_tripped' → 五类的 budget");
  ok(mc.budget === null, "D6 既有 change type 'budget' 仍是心跳(丢弃)——新 type 不改既有语义");
  ok(ar.run_stalled === 'stalled', "D6 run 事件 'run_stalled' → 五类的 stalled");
  ok(ar.run_budget_tripped === 'budget', "D6 run 事件 'run_budget_tripped' → 五类的 budget");
  // 只走 SSE 的进度信号:登记为 null(有人来过、判过),且不在三个持久写入端的等集判定里。
  const sse = STEWARD_SOURCE_EVENT_MAP.sseOnly || {};
  ok(Object.prototype.hasOwnProperty.call(sse, 'adaptive_tool_budget') && sse.adaptive_tool_budget === null,
    "D6 adaptive_tool_budget 登记在 sseOnly 且为 null(进度,不入箱)");
  ok(!Object.prototype.hasOwnProperty.call(ar, 'adaptive_tool_budget'),
    'D6 adaptive_tool_budget 不在 agentRun 子表(它没有 appendAgentRunEvent 写入端,放进去会变僵尸条目)');
  // 写入端存在性:两个新 run 事件必须真有人写,两个新 change type 也必须真有人写。
  const src08 = read('08-agent-runs.js');
  const src09 = read('09-workflow.js');
  const src02 = read('02-session-store.js');
  ok(/type: 'run_stalled'/.test(src08) && /type: 'run_budget_tripped'/.test(src08),
    'D6 08 有 run_stalled / run_budget_tripped 的写入端');
  ok(/recordRunStalledEvent\(run,/.test(src09) && /recordRunBudgetTrippedEvent\(run,/.test(src09),
    'D6 09 的节点事件壳与节点跑者调用了两个写入端');
  ok(/type: 'stalled'/.test(src02) && /type: 'budget_tripped'/.test(src02),
    'D6 02 有 stalled / budget_tripped 的账本写入端');
  ok(/missionSignalThrottleAllow\(/.test(src02) && /MISSION_STALL_SIGNAL_WINDOW_MS = 5 \* 60 \* 1000/.test(src02),
    'D6 频控在写入端(同 run/会话 5 分钟一条),不是读取端去重');
  ok(/missionBudgetTripTurns\.get\(sid\) === turnSeq/.test(src02),
    'D6 budget_tripped 每回合最多一条(按 turnSeq 去重)');
}

/* ═══════════════ D7 第四源 sessionTurns(116-4) ═══════════════ */

// 为什么它不参与 D1/D2/D3 的双向等集:那三条扫的是【源码里的写入端 type 字面量】,而第四源的事实
// 来自会话头本身(turnSeq 前进 + 无活回合),没有写入端可对账 —— 与 projection 派生组同一处境。
// 但「新信号必须有人登记一次」这条纪律照样适用,故在这里单独钉一遍。
{
  const st = STEWARD_SOURCE_EVENT_MAP.sessionTurn || {};
  ok(Object.prototype.hasOwnProperty.call(st, 'turn_settled') && st.turn_settled === '@sessionTurn',
    "D7 sessionTurn.turn_settled 登记为 '@sessionTurn'(语义由会话头上的 stewardLastTurn 决定)");
  const src13i = read('13i-steward-inbox.js');
  ok(src13i.includes('function stewardResolveSessionTurnKind('), 'D7 解析器 stewardResolveSessionTurnKind 在 13i');
  ok(src13i.includes("'@sessionTurn': stewardResolveSessionTurnKind"), 'D7 解析器登记进 STEWARD_KIND_RESOLVERS');
  ok(src13i.includes("return (last.ok === false && last.aborted !== true) ? 'failed' : 'done';"),
    "D7 判据:账上 ok:false 且不是用户主动停 -> failed;其余(含账缺席)-> done");
  const Q = String.fromCharCode(39);   // 单引号:内联在断言字符串里会把本文件的引号配对搞乱
  ok(src13i.includes('function stewardWatchedThread(')
    && src13i.includes('if (head.stewardQuick && typeof head.stewardQuick === ' + Q + 'object' + Q + ') return true;')
    && src13i.includes('if (head.launchedBy === ' + Q + 'steward' + Q + ') return true;')
    && src13i.includes('return String(missionId || ' + Q + Q + ') !== String(sessionId || ' + Q + Q + ');'),
    "D7 「管家关心哪些会话」的三条判据单点在 13i(速查 / launchedBy / 别人事项里的线程)");
  // 位置纪律:第四源必须排在「不活跃就 continue」之前 —— 速查线程没有 mission 卡片,
  // recent 恒 false,放在后面等于它只在会话首见那一轮生效。
  const collectAt = src13i.indexOf('const turnEvt = await stewardCollectSessionTurn(');
  const continueAt = src13i.indexOf('{ idleSessionIds.push(sid); continue; }');
  ok(collectAt > 0 && continueAt > 0 && collectAt < continueAt,
    'D7 第四源的收集点排在「不活跃就 continue」之前(否则第二轮起就再也看不到速查线程)');
  // 游标:新字段不改 schema 号(老游标缺这段 = 每条会话都算首见,由首见纪律兜住)。
  ok(src13i.includes('sources: { missionChanges, agentRuns, pendingIds, budgetSeen, sessionTurns },'),
    'D7 游标落盘带上 sessionTurns 段');
  ok(src13i.includes('const STEWARD_CURSOR_SCHEMA = 1;'), 'D7 游标 schema 号仍是 1(向后兼容,不做迁移)');
  // 写入端:13g 必须真的在会话头上写这两个标,否则第四源的判据永远为假。
  const src13g = read('13g-steward.js');
  ok(src13g.includes('function stewardRecordLaunchOutcome('), 'D7 13g 有回合成败的落盘写入端');
  ok((src13g.match(/session.launchedBy = 'steward';/g) || []).length === 2,
    'D7 两条建线程的路径(quick_ask / thread_new)都就地写了 launchedBy');
  ok(src13g.includes("launchedBy: 'steward',") && src13g.includes('stewardLastTurn: {'),
    'D7 settle 之后的那次落盘同时补 launchedBy(覆盖递话给用户自己会话的那条路)');
  ok(src13g.includes("result.result && typeof result.result === 'object'"),
    "D7 成败取【内层】result.result.ok —— 外层 ok 只表示这次调用完成了(一条 HTTP 500 的回合外层仍是 ok:true)");
  const src02b = read('02-session-store.js');
  ok(src02b.includes("if (patch.launchedBy === 'steward') session.launchedBy = 'steward';"),
    "D7 02 的元数据白名单只认 'steward' 这一个字面量(PATCH /api/sessions 的调用方拿不到别的值)");
  ok(src02b.includes('session.stewardLastTurn = {')
    && src02b.includes("errorClass: String(t.errorClass || '').slice(0, 64),"),
    'D7 stewardLastTurn 严格归一成固定五字段(与 stewardQuick 同纪律)');
  // 117p①(用户第七轮走查「2.0 回合已经跑完了,管家没有收到体现也没收工」):活回合分支的基线不能是
  // 「正在跑的那一回合」本身 —— turnSeq 在回合【开始】那一刻就落盘,首见就撞上活回合时拿它当基线
  // 等于把这一回合算成已报过,回合真跑完时 turnSeq 没再前进,唯一那条 done 被永久吞掉。
  ok(src13i.includes("turnSeq: known ? known.turnSeq : Math.max(0, turnSeq - 1), stamp: '' };"),
    'D7 117p① 活回合分支的基线是「这一回合之前」那个号(Math.max(0, turnSeq - 1)),不是正在跑的那个 turnSeq');
  // 117p②:首见分支还要堵住「回合已起手、还没登记进 activeChildren」那个窗口 —— 判据是
  // stewardLastTurn 落盘(last.seq >= turnSeq),且只能在 known == null 这一次生效(之后 known != null,
  // 普通的 turnSeq > baseline 就够了;放开范围会把用户自己接着聊的回合永久判成「还没结束」)。
  {
    const knownNullAt = src13i.indexOf('if (known == null) {');
    const inFlightAt = src13i.indexOf("const inFlight = String(head.launchedBy || '') === 'steward'");
    const backfillInFlightAt = src13i.indexOf('if (backfill && inFlight) {');
    ok(knownNullAt > 0 && inFlightAt > knownNullAt && backfillInFlightAt > inFlightAt,
      'D7 117p② 首见分支(known == null)里有 stewardLastTurn 的 in-flight 判据,且被 backfill && inFlight 一起把关');
  }
}

console.log(fail === 0 ? 'STEWARD EVENTS STATIC E2E: ALL PASS' : `STEWARD EVENTS STATIC E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);

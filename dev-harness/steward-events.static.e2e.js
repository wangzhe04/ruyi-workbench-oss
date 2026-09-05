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
  ok(files[i - 1] === '13e-pretender-index.js', 'D4 13g 紧跟 13e-pretender-index.js 之后');
  ok(files[i + 1] === '14-main.js', 'D4 13g 紧接在 14-main.js 之前');
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
  ok(/Object\.assign\(StewardHooks, \{/.test(steward), 'D5 13g 用 Object.assign(StewardHooks, {...}) 延迟绑定填充');
  ok(/function startStewardInbox\(config\)[\s\S]{0,400}stewardEnabledV1 !== true\) return \{ ok: false, running: false/.test(steward),
    'D5 开关关(stewardEnabledV1 !== true)时 startStewardInbox 立即返回:零 interval、零目录、零写入');
  ok(!/setInterval/.test(steward.slice(0, steward.indexOf('async function startStewardInbox'))),
    'D5 模块加载期不起任何 interval(轮询只能由 startStewardInbox 起)');
  ok(steward.includes("path.join(paths.data, STEWARD_DIR_NAME)") && !steward.includes("paths.steward"),
    'D5 <data>/steward 不进 paths 常量表(否则 ensureDirs 会在开关关时也建目录)');
  ok(steward.includes('repairMissionChangeTornTail'), 'D5 inbox 追加复用 session-changes 同款 NDJSON 原语(不新造)');
  ok(steward.includes('atomicWriteJson(stewardCursorPath()'), 'D5 游标经 atomicWriteJson 落盘');

  const main = read('14-main.js');
  ok(/startStewardInbox\(await readConfig\(\)\)/.test(main), 'D5 14-main 在 startServer 返回后调用 startStewardInbox(config)');

  const auth = read('01b-route-auth.js');
  for (const p of ['/api/steward/start', '/api/steward/stop', '/api/steward/state', '/api/steward/inbox']) {
    ok(new RegExp(`p: '${p.replace(/\//g, '\\/')}', auth: 'token' \\}`).test(auth), `D5 ROUTE_AUTH ${p} = token 级`);
  }
}

console.log(fail === 0 ? 'STEWARD EVENTS STATIC E2E: ALL PASS' : `STEWARD EVENTS STATIC E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);

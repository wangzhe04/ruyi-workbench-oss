// Unit: 第 116 波 116-2a(27 号文 §3.3「线程权限即管家边界」/ §8.6「权限的界面表达」)——
// 线程级权限的两个纯函数面。
// 覆盖:
//   ① resolvePermissionMode 三层优先级全表:请求级 > 会话级 > 全局。每层【只认 PERMISSION_MODES
//      白名单】,非法/缺失静默回落下一层(请求非法回落会话、会话非法回落全局、全空回落 'default'),
//      期望值是从 §3.3 直接抄写的字面量,不是对生产实现分支的镜像重写。
//   ② 入参形态:三项各自既接受对象(读 .permissionMode)也接受字符串(就是档本身);
//      入参整体非对象 → 'default';绝不抛错(它是回合入口的第一行,抛错等于回合起不来)。
//   ③ STEWARD_PERMISSION_RANK 序表 + stewardPermissionRank/stewardMayTightenTo:
//      「管家只能收紧,不能放宽」的单调性判定 —— 严格更紧才 true,相等/放宽/未知档一律 false。
//   ④ PERMISSION_MODES_REQUIRING_CONFIRM 恰为「全自动」三名(auto/bypass/bypassPermissions)。
//
// 与既有 dev-harness/unit 件同款约定(见 steward-core.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录(它是系统级环境变量,曾污染真实数据根);
// PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-permission-resolve-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const {
  resolvePermissionMode, PERMISSION_MODES, PERMISSION_MODES_REQUIRING_CONFIRM,
  STEWARD_PERMISSION_RANK, stewardPermissionRank, stewardMayTightenTo,
} = srv;

/* ═════════════ ① 三层优先级全表(§3.3:请求级 > 会话级 > 全局) ═════════════ */

// [request, session, config, 期望档, 说明]
const TABLE = [
  // —— 三层都合法:请求级赢 ——
  ['plan', 'acceptEdits', 'auto', 'plan', '三层都合法 → 请求级赢'],
  ['auto', 'plan', 'default', 'auto', '请求级放宽也赢(第78波语义:这一单当前执行链说了算)'],
  // —— 请求级缺失/非法:会话级赢 ——
  ['', 'plan', 'auto', 'plan', '请求级空 → 会话级'],
  [null, 'acceptEdits', 'default', 'acceptEdits', '请求级 null → 会话级'],
  [undefined, 'bypass', 'default', 'bypass', '请求级 undefined → 会话级'],
  ['nope', 'plan', 'auto', 'plan', '请求级非法 → 静默回落会话级(不报错、不回写)'],
  ['dontAsk', 'plan', 'auto', 'plan', 'dontAsk 不在 PERMISSION_MODES 里 → 回落会话级'],
  ['bypassPermissions', 'plan', 'auto', 'plan', 'CLI 原生内部名不在白名单 → 回落会话级'],
  // —— 会话级缺失/非法:全局赢 ——
  ['', '', 'acceptEdits', 'acceptEdits', '请求级与会话级都空 → 全局'],
  ['', null, 'auto', 'auto', '会话级 null(= 存量会话没有该字段)→ 全局'],
  ['', 'nope', 'plan', 'plan', '会话级非法 → 静默回落全局'],
  ['nope', 'nope', 'acceptEdits', 'acceptEdits', '请求级与会话级都非法 → 全局'],
  // —— 三层全空/全非法:'default' ——
  ['', '', '', 'default', '三层全空 → default'],
  ['nope', 'nope', 'nope', 'default', '三层全非法 → default'],
  [null, null, null, 'default', '三层全 null → default'],
];
for (const [request, session, config, want, note] of TABLE) {
  const got = resolvePermissionMode({ request, session, config });
  ok(got === want, `① ${note}(req=${JSON.stringify(request)} sess=${JSON.stringify(session)} cfg=${JSON.stringify(config)} → ${want};实 ${got})`);
}

// 白名单五档逐个都能从每一层解析出来(防止某一层漏了某个档)。
for (const mode of PERMISSION_MODES) {
  ok(resolvePermissionMode({ request: mode, session: '', config: '' }) === mode, `① 请求级可解析 ${mode}`);
  ok(resolvePermissionMode({ request: '', session: mode, config: '' }) === mode, `① 会话级可解析 ${mode}`);
  ok(resolvePermissionMode({ request: '', session: '', config: mode }) === mode, `① 全局可解析 ${mode}`);
}

/* ═════════════ ② 入参形态:对象/字符串/垃圾 ═════════════ */

ok(resolvePermissionMode({ session: { permissionMode: 'plan' }, config: { permissionMode: 'auto' } }) === 'plan',
  '② session/config 传对象时读它的 .permissionMode');
ok(resolvePermissionMode({ session: { id: 'sess_x' }, config: { permissionMode: 'acceptEdits' } }) === 'acceptEdits',
  '② 会话对象没有 permissionMode 字段(存量会话)→ 回落全局');
ok(resolvePermissionMode({ request: 'plan', session: { permissionMode: 'auto' }, config: { permissionMode: 'auto' } }) === 'plan',
  '② 请求级字符串 + 会话/全局对象混用');
ok(resolvePermissionMode({}) === 'default', '② 空入参 → default');
ok(resolvePermissionMode(null) === 'default', '② 入参 null → default(不抛错)');
ok(resolvePermissionMode('plan') === 'default', '② 入参不是对象 → default(不抛错)');
ok(resolvePermissionMode({ session: 42, config: 7 }) === 'default', '② 入参是数字 → default(不抛错)');
ok(resolvePermissionMode({ session: { permissionMode: 'steward' }, config: { permissionMode: 'default' } }) === 'default',
  "② 管家会话头上的独立值 'steward' 不在白名单 → 回落全局(管家自身不设线程档)");

/* ═════════════ ③ 收紧序表(§3.3「管家只能收紧线程权限,不能放宽」) ═════════════ */

ok(Object.isFrozen(STEWARD_PERMISSION_RANK), '③ STEWARD_PERMISSION_RANK 已冻结');
ok(JSON.stringify(STEWARD_PERMISSION_RANK) === JSON.stringify({ plan: 0, default: 1, acceptEdits: 2, auto: 3, bypass: 4, bypassPermissions: 4 }),
  '③ 序表内容锁定 plan<default<acceptEdits<auto<=bypass(只做收紧比较,不代表安全度线性)');
ok(stewardPermissionRank('bypass') === stewardPermissionRank('bypassPermissions'),
  '③ bypass 与 bypassPermissions 同 rank(同一档的两个名字)');
ok(stewardPermissionRank('') === -1 && stewardPermissionRank('nope') === -1 && stewardPermissionRank(null) === -1,
  '③ 未知/空档 rank = -1');

// 收紧比较矩阵:严格更紧才 true。
const ORDER = ['plan', 'default', 'acceptEdits', 'auto'];
let tightenBad = [];
for (const from of ORDER) for (const to of ORDER) {
  const want = ORDER.indexOf(to) < ORDER.indexOf(from);
  if (stewardMayTightenTo(from, to) !== want) tightenBad.push(`${from}->${to}`);
}
ok(tightenBad.length === 0, '③ 收紧矩阵 4×4 全对(严格更紧才允许)' + (tightenBad.length ? ' → ' + tightenBad.join(',') : ''));
ok(stewardMayTightenTo('auto', 'auto') === false, '③ 平移到同一档不算收紧(空操作不该写决策日志)');
ok(stewardMayTightenTo('bypass', 'bypassPermissions') === false, '③ bypass → bypassPermissions 同 rank(同档改名),不算收紧');
ok(stewardMayTightenTo('bypass', 'auto') === true, '③ bypass(rank 4)→ auto(rank 3)按序表算收紧');
ok(stewardMayTightenTo('bypass', 'acceptEdits') === true, '③ bypass → acceptEdits 是收紧');
ok(stewardMayTightenTo('plan', 'default') === false, '③ plan → default 是放宽(线程能做的事变多),禁止');
ok(stewardMayTightenTo('nope', 'plan') === false && stewardMayTightenTo('auto', 'nope') === false,
  '③ 任一边是未知档 → 一律 false(既不算可收紧也不算已放宽)');

/* ═════════════ ④ 「切到全自动须二次确认」的名单(§8.6) ═════════════ */

ok(Object.isFrozen(PERMISSION_MODES_REQUIRING_CONFIRM), '④ PERMISSION_MODES_REQUIRING_CONFIRM 已冻结');
ok(JSON.stringify(PERMISSION_MODES_REQUIRING_CONFIRM) === JSON.stringify(['auto', 'bypass', 'bypassPermissions']),
  '④ 二次确认名单恰为全自动三名(auto/bypass/bypassPermissions)');
ok(!PERMISSION_MODES_REQUIRING_CONFIRM.includes('plan') && !PERMISSION_MODES_REQUIRING_CONFIRM.includes('default')
  && !PERMISSION_MODES_REQUIRING_CONFIRM.includes('acceptEdits'),
  '④ 收紧方向的三档都不需要二次确认');

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`PERMISSION-RESOLVE UNIT: FAIL (${fail})`); process.exit(1); }
console.log('PERMISSION-RESOLVE UNIT: ALL PASS');

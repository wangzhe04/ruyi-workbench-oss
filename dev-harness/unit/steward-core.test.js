// Unit: 第 116 波 116a(27 号文 §11.3/§3.3) —— 管家(Steward)引擎侧纯函数。
// 覆盖:
//   ① stewardMayAct 全表 —— 5 种 permissionMode(default/acceptEdits/plan/auto/bypass) ×
//      permission(tier ∈ read/edit/exec/缺失) × question/plan/pool/failed/relay/done/stalled/budget/未知,
//      逐格断言(期望值是从设计文档 §3.3 真值表直接抄写的字面量表,不是对生产实现分支的镜像重写)。
//   ② buildStewardDigestLine —— lastSay 201 字截断加省略号、整行 320 硬顶(纯截断不加省略号)、
//      尖括号中和、换行折叠、缺字段跳段、费用两位小数。
//   ③ STEWARD_EVENT_KINDS 冻结且恰为五类白名单。
//
// 与既有 dev-harness/unit 件同款约定(见 session-route-ui.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录,防止污染真实数据根;PASS/FAIL 逐条打印(见
// econ-calibration.test.js),process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-core-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { stewardMayAct, buildStewardDigestLine, STEWARD_EVENT_KINDS, STEWARD_DIGEST_LIMITS } = srv;

/* ═══════════════════════ ① stewardMayAct 全表(§3.3) ═══════════════════════ */

// 非 permission 的九类 kind,按 §3.3 分成三组字面量(直接抄文档,不复用生产代码的判断顺序)。
const AUTO_MODE_AUTO_KINDS = ['question', 'plan', 'pool', 'failed', 'relay'];       // auto/bypass 下 -> auto
const AUTO_MODE_PROPOSE_KINDS = ['done', 'stalled', 'budget', 'unknown_kind'];       // auto/bypass 下 -> propose
const ACCEPT_PROPOSE_KINDS = ['question', 'plan', 'pool'];                          // acceptEdits 下 -> propose
const ACCEPT_AUTO_KINDS = ['failed', 'relay'];                                      // acceptEdits 下 -> auto
const ALL_OTHER_KINDS = [...AUTO_MODE_AUTO_KINDS, ...AUTO_MODE_PROPOSE_KINDS];        // 9 个非 permission kind 全集
const PERMISSION_TIERS = ['read', 'edit', 'exec', undefined];                        // undefined = 缺失

for (const mode of ['auto', 'bypass']) {
  for (const tier of PERMISSION_TIERS) {
    ok(stewardMayAct(mode, 'permission', tier) === 'auto', `${mode} × permission(tier=${tier}) -> auto(全自动放行任意 tier)`);
  }
  for (const kind of AUTO_MODE_AUTO_KINDS) {
    ok(stewardMayAct(mode, kind) === 'auto', `${mode} × ${kind} -> auto`);
  }
  for (const kind of AUTO_MODE_PROPOSE_KINDS) {
    ok(stewardMayAct(mode, kind) === 'propose', `${mode} × ${kind} -> propose`);
  }
}

for (const tier of ['read', 'edit']) {
  ok(stewardMayAct('acceptEdits', 'permission', tier) === 'auto', `acceptEdits × permission(tier=${tier}) -> auto`);
}
for (const tier of ['exec', undefined]) {
  ok(stewardMayAct('acceptEdits', 'permission', tier) === 'propose', `acceptEdits × permission(tier=${tier}) -> propose`);
}
for (const kind of ACCEPT_PROPOSE_KINDS) {
  ok(stewardMayAct('acceptEdits', kind) === 'propose', `acceptEdits × ${kind} -> propose`);
}
for (const kind of ACCEPT_AUTO_KINDS) {
  ok(stewardMayAct('acceptEdits', kind) === 'auto', `acceptEdits × ${kind} -> auto`);
}
for (const kind of AUTO_MODE_PROPOSE_KINDS) {
  ok(stewardMayAct('acceptEdits', kind) === 'propose', `acceptEdits × ${kind}(其它) -> propose`);
}

for (const mode of ['default', 'plan']) {
  for (const tier of PERMISSION_TIERS) {
    ok(stewardMayAct(mode, 'permission', tier) === 'propose', `${mode} × permission(tier=${tier}) -> propose(只提议)`);
  }
  for (const kind of ALL_OTHER_KINDS) {
    ok(stewardMayAct(mode, kind) === 'propose', `${mode} × ${kind} -> propose(只提议)`);
  }
}

// 额外补充(§3.3 明确写了这些别名/边界值的处理,不是「5 种 mode」表格之外的臆造):
// bypassPermissions 与 bypass/auto 同源(CLI 原生内部值,按全自动处理);dontAsk/空/未知模式一律只提议。
ok(stewardMayAct('bypassPermissions', 'permission', 'exec') === 'auto', 'bypassPermissions 与 bypass/auto 同表(exec permission -> auto)');
ok(stewardMayAct('bypassPermissions', 'done') === 'propose', 'bypassPermissions × done -> propose');
ok(stewardMayAct('dontAsk', 'permission', 'read') === 'propose', 'dontAsk 未在四档之列 -> 一律 propose');
ok(stewardMayAct('', 'permission', 'read') === 'propose', '空 permissionMode -> propose');
ok(stewardMayAct(undefined, 'failed') === 'propose', '未知/undefined permissionMode -> propose');
ok(stewardMayAct('not-a-real-mode', 'relay') === 'propose', '未识别 permissionMode -> propose');

/* ═══════════════════════ ② buildStewardDigestLine ═══════════════════════ */

ok(STEWARD_DIGEST_LIMITS.lastSayChars === 200 && STEWARD_DIGEST_LIMITS.lineChars === 320
  && STEWARD_DIGEST_LIMITS.maxThreads === 40 && STEWARD_DIGEST_LIMITS.totalChars === 12000,
  'STEWARD_DIGEST_LIMITS 四个数字锁定(lastSay 200/line 320/maxThreads 40/total 12000)');

{
  const longSay = 'a'.repeat(201);
  const line = buildStewardDigestLine({ id: 't1', lastSay: longSay });
  ok(line.includes('a'.repeat(200) + '…') && !line.includes('a'.repeat(201)), 'lastSay 201 字截断为 200 字 + 省略号');
}
{
  const exactSay = 'b'.repeat(200);
  const line = buildStewardDigestLine({ id: 't2', lastSay: exactSay });
  ok(line.includes(exactSay) && !line.includes('…'), 'lastSay 恰 200 字不截断、不加省略号');
}
{
  const line = buildStewardDigestLine({ id: 'huge', missionTitle: 'M'.repeat(200), title: 'T'.repeat(200), lastSay: 'x' });
  ok(line.length === 320, `整行硬顶 320(实测 ${line.length})`);
  ok(!line.endsWith('…'), '整行硬顶是纯截断,不追加省略号(与 lastSay 的省略号规则不同)');
}
{
  const line = buildStewardDigestLine({ id: 't3', title: '<script>alert(1)</script>' });
  ok(!line.includes('<') && !line.includes('>'), '尖括号中和为方括号');
  ok(line.includes('[script]'), '中和后仍保留可读文本([script])');
}
{
  const line = buildStewardDigestLine({ id: 't4', action: "第一行\n第二行", lastSay: "话一\n话二" });
  ok(!line.includes('\n') && line.includes('第一行 第二行') && line.includes('话一 话二'), '换行折叠成空格');
}
{
  // 缺字段跳段:只给 id 与 title,其余字段(state/action/waitReason/permissionMode/cost/lastSay)全部省略。
  const line = buildStewardDigestLine({ id: 't5', title: '仅标题' });
  ok(line === '[t5] 仅标题', `缺字段的段整段跳过,不留孤立分隔符(实测 ${JSON.stringify(line)})`);
}
{
  const line = buildStewardDigestLine({ id: 't6', cost: 3 });
  ok(line.includes('$3.00'), '费用两位小数(整数费用补零)');
  const line2 = buildStewardDigestLine({ id: 't7', cost: 1.005 });
  ok(/\$1\.0[01]/.test(line2), '费用四舍五入到两位小数');
  const line3 = buildStewardDigestLine({ id: 't8' });
  ok(!line3.includes('$'), 'cost 缺失时不输出费用段');
}
{
  const line = buildStewardDigestLine({ id: 't9', state: 'needs_you', permissionMode: 'acceptEdits' });
  ok(line.includes('需要你'), '五态人话映射:needs_you -> 需要你');
  ok(line.includes('改文件不问'), '权限人话映射:acceptEdits -> 改文件不问');
}
{
  const line = buildStewardDigestLine({ id: 't10', state: 'running', permissionMode: 'auto' });
  ok(line.includes('进行中') && line.includes('全自动'), '五态/权限人话:running -> 进行中,auto -> 全自动');
}
{
  const line = buildStewardDigestLine({ id: 't11', state: 'weird_unmapped_state', permissionMode: 'weird_unmapped_mode' });
  ok(line.includes('weird_unmapped_state') && line.includes('weird_unmapped_mode'), '未登记的 state/permissionMode 原样透传');
}
ok(typeof buildStewardDigestLine({}) === 'string' && buildStewardDigestLine({}) === '', '全空输入返回空字符串,不抛异常');
ok(buildStewardDigestLine(null) === '', 'null 输入不抛异常且返回空字符串');

/* ═══════════════════════ ③ STEWARD_EVENT_KINDS 五类白名单 ═══════════════════════ */

ok(Object.isFrozen(STEWARD_EVENT_KINDS), 'STEWARD_EVENT_KINDS 已冻结');
ok(Array.isArray(STEWARD_EVENT_KINDS) && STEWARD_EVENT_KINDS.length === 5, 'STEWARD_EVENT_KINDS 恰为 5 类');
ok(JSON.stringify(STEWARD_EVENT_KINDS) === JSON.stringify(['needs_you', 'failed', 'done', 'stalled', 'budget']),
  'STEWARD_EVENT_KINDS 内容与顺序锁定(needs_you/failed/done/stalled/budget)');

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`STEWARD-CORE UNIT: FAIL (${fail})`); process.exit(1); }
console.log('STEWARD-CORE UNIT: ALL PASS');

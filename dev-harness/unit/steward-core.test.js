// Unit: 第 116 波 116a(27 号文 §11.3/§3.3) —— 管家(Steward)引擎侧纯函数。
// 覆盖:
//   ① stewardMayAct 全表 —— 5 种 permissionMode(default/acceptEdits/plan/auto/bypass) ×
//      permission(tier ∈ read/edit/exec/缺失) × question/plan/pool/failed/relay/done/stalled/budget/未知,
//      逐格断言(期望值是从设计文档 §3.3 真值表直接抄写的字面量表,不是对生产实现分支的镜像重写)。
//   ② buildStewardDigestLine —— lastSay 201 字截断加省略号、整行 320 硬顶(纯截断不加省略号)、
//      尖括号中和、换行折叠、缺字段跳段、费用两位小数。
//   ③ STEWARD_EVENT_KINDS 冻结且恰为六类白名单(121-K3 加 adopted)。
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
  ok(line.includes('进行中') && line.includes('智能自动'), '五态/权限人话:running -> 进行中,auto -> 智能自动(与 locale permission.mode.auto.short 同词)');
}
{
  // 反向保护:auto 与 bypass 不能是同一个词。修前两档都印「全自动」,界面上分不出自己在哪一档;
  // bypass 的措辞【保持】「全自动」(它的 locale 键 permission.mode.bypass.short 就是这四个字)。
  const autoLine = buildStewardDigestLine({ id: 't10', permissionMode: 'auto' });
  const bypassLine = buildStewardDigestLine({ id: 't10', permissionMode: 'bypass' });
  ok(bypassLine.includes('全自动') && !autoLine.includes('全自动') && autoLine !== bypassLine,
    'auto 与 bypass 跨档不同词(auto -> 智能自动 / bypass -> 全自动)');
}
{
  const line = buildStewardDigestLine({ id: 't11', state: 'weird_unmapped_state', permissionMode: 'weird_unmapped_mode' });
  ok(line.includes('weird_unmapped_state') && line.includes('weird_unmapped_mode'), '未登记的 state/permissionMode 原样透传');
}
ok(typeof buildStewardDigestLine({}) === 'string' && buildStewardDigestLine({}) === '', '全空输入返回空字符串,不抛异常');
ok(buildStewardDigestLine(null) === '', 'null 输入不抛异常且返回空字符串');

/* ═══════════════════════ ③ STEWARD_EVENT_KINDS 五类白名单 ═══════════════════════ */

ok(Object.isFrozen(STEWARD_EVENT_KINDS), 'STEWARD_EVENT_KINDS 已冻结');
// 121-K3(34 号文 §4.4「交接」):5 -> 6,新增 adopted(用户把线程交给管家盯)。排在表尾:
// 到访摘要按本表顺序归纳(13q stewardVisitDigest),插在中间会改既有摘要的行序。
ok(Array.isArray(STEWARD_EVENT_KINDS) && STEWARD_EVENT_KINDS.length === 6, 'STEWARD_EVENT_KINDS 恰为 6 类');
ok(JSON.stringify(STEWARD_EVENT_KINDS) === JSON.stringify(['needs_you', 'failed', 'done', 'stalled', 'budget', 'adopted']),
  'STEWARD_EVENT_KINDS 内容与顺序锁定(needs_you/failed/done/stalled/budget/adopted)');

/* ═══ ④ 117y-S1(27 号文 §11.18.2):正文天花板裁剪 stewardTrimSayAtSentence ═══ */
// 钉的是【事实】不是实现:600 不再是运行期的刀、天花板处不许裸切、切了必须明说,
// 外加一条【反向保护】—— 总览行那把 stewardClipSay(200 字 + 省略号)不许被这一刀误伤。
const { stewardTrimSayAtSentence, stewardClipSay, STEWARD_SAY_TARGET, STEWARD_SAY_CEILING } = srv;

ok(STEWARD_SAY_TARGET === 600, `④ TARGET = 600(提示词目标;got ${STEWARD_SAY_TARGET})`);
ok(STEWARD_SAY_CEILING === 4000, `④ CEILING = 4000(病态载荷天花板;got ${STEWARD_SAY_CEILING})`);
ok(STEWARD_SAY_CEILING >= STEWARD_SAY_TARGET * 6,
  `④ 天花板 ≥ 目标的 6 倍 —— 守规矩的回复永远碰不到它(got ${STEWARD_SAY_CEILING / STEWARD_SAY_TARGET} 倍)`);

{
  // 本刀的核心断言(§11.18.5 第 1 条)的纯函数面:700 字【一个字都不少】。
  // 修前这一路是 `.slice(0, 600)`,700 字会在第 600 字处无声断掉。
  const say700 = '这是管家的一段长话。'.repeat(70);
  ok(say700.length === 700, `④ 样本恰 700 字(got ${say700.length})`);
  const kept = stewardTrimSayAtSentence(say700, STEWARD_SAY_CEILING);
  ok(kept === say700, `④ 700 字的 say 原样返回,一个字不少(got ${kept.length} 字)`);
  ok(kept.length > STEWARD_SAY_TARGET, '④ 且它确实越过了 600 这条【提示词目标】线(证明目标不再是刀)');
}
{
  const exact = 'x'.repeat(STEWARD_SAY_CEILING);
  ok(stewardTrimSayAtSentence(exact, STEWARD_SAY_CEILING) === exact, '④ 恰到天花板不裁剪、不加标记(边界值)');
}
{
  // §11.18.5 第 2 条:5000 字触顶 -> 切在句末标点上,末尾有明说。
  const sentence = '管家把这件事的来龙去脉讲清楚。';                       // 15 字,以 U+3002 结尾
  const say5000 = sentence.repeat(334).slice(0, 5000);
  ok(say5000.length === 5000, `④ 样本恰 5000 字(got ${say5000.length})`);
  const trimmed = stewardTrimSayAtSentence(say5000, STEWARD_SAY_CEILING);
  const note = trimmed.slice(trimmed.indexOf('\n'));
  const body = trimmed.slice(0, trimmed.indexOf('\n'));
  ok(body.length > 0 && body.length <= STEWARD_SAY_CEILING, `④ 正文不超过天花板(got ${body.length})`);
  ok(say5000.startsWith(body), '④ 正文是原文的前缀(只截不改写)');
  ok(/[。！？.!?]$/.test(body), `④ 切在句末标点上,不是半句话(结尾 ${JSON.stringify(body.slice(-3))})`);
  ok(body.length > STEWARD_SAY_CEILING - sentence.length,
    `④ 切点是天花板【之前的最后一个】句号,不是更早的某个(got ${body.length},下界 ${STEWARD_SAY_CEILING - sentence.length})`);
  ok(note.length > 10 && trimmed !== say5000.slice(0, body.length), '④ 触顶必留标记,不许静默');
  ok(/截断|没说完|后面还有/.test(note), `④ 标记是诚实的明说(不假装说完了):${JSON.stringify(note)}`);
}
{
  // 全角叹号/问号也在表里 —— 这条专防「字面量被静默归一成半角」那类看不见的损坏:
  // 若表里只剩半角三个,下面两句会退化成裸切,body 就不再以标点结尾。
  for (const [mark, label] of [['！', '全角叹号 U+FF01'], ['？', '全角问号 U+FF1F']]) {
    const src = ('管家说了一句话' + mark).repeat(700).slice(0, 5000);
    const body = stewardTrimSayAtSentence(src, STEWARD_SAY_CEILING).split('\n')[0];
    ok(body.endsWith(mark), `④ ${label} 认得出来(切在它上面;结尾 ${JSON.stringify(body.slice(-2))})`);
  }
  ok('！'.charCodeAt(0) === 0xff01 && '？'.charCodeAt(0) === 0xff1f, '④ 本件用的就是全角码位本身(样本自洽)');
}
{
  // 一个句号都找不到才退回裸切 —— 但【仍然】要留标记。
  const noStop = '啊'.repeat(5000);
  const trimmed = stewardTrimSayAtSentence(noStop, STEWARD_SAY_CEILING);
  const body = trimmed.split('\n')[0];
  ok(body === '啊'.repeat(STEWARD_SAY_CEILING), `④ 全文无句末标点 -> 退回裸切到天花板(got ${body.length})`);
  ok(trimmed.length > body.length, '④ 裸切这一路同样留标记(不静默)');
}
{
  ok(stewardTrimSayAtSentence('', STEWARD_SAY_CEILING) === '', '④ 空串原样返回');
  ok(stewardTrimSayAtSentence(null, STEWARD_SAY_CEILING) === '', '④ null 不抛异常');
  ok(stewardTrimSayAtSentence('abc', 0) === 'abc' && stewardTrimSayAtSentence('abc', NaN) === 'abc',
    '④ ceiling 非正/非数时不裁剪(而不是把整段吞成空串)');
}

/* ═══ ⑤ 反向保护:stewardClipSay 没被 117y-S1 误伤(§11.18.5 第 4 条)═══ */
// 它喂的是【总览行与待决一行话】—— 列表里的一行摘要,200 字加省略号正是对的做法。
// 这条一红 = 有人把两个函数当成一件事合并了。
{
  ok(stewardClipSay('a'.repeat(201)) === 'a'.repeat(200) + '…', '⑤ 201 字 -> 200 字 + 省略号(与 116a 同一口径)');
  ok(stewardClipSay('b'.repeat(200)) === 'b'.repeat(200), '⑤ 恰 200 字不截断、不加省略号');
  const long = stewardClipSay('c'.repeat(5000));
  ok(long.length === 201, `⑤ 总览行【不】走 4000 天花板那条路(仍是 200+1;got ${long.length})`);
  ok(!/截断|没说完|后面还有/.test(long), '⑤ 总览行不缀正文那句诚实标记(摘要本来就不该说完整)');
  ok(stewardClipSay('c'.repeat(5000)) !== stewardTrimSayAtSentence('c'.repeat(5000), STEWARD_SAY_CEILING),
    '⑤ 两个函数对同一份输入给出不同结果 —— 它们是两件事,不是一件');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`STEWARD-CORE UNIT: FAIL (${fail})`); process.exit(1); }
console.log('STEWARD-CORE UNIT: ALL PASS');

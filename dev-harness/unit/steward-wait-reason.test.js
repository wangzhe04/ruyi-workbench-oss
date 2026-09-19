// Unit: 第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「排队可解释」)—— 等待原因单点判定
// waitReasonFor 的穷举。纯函数:入参两个普通对象,零磁盘零配置,每条用例只构造字面量。
//
// 铁律是「每条等待线程有且只有一个原因」,优先级 needs_you > lock > budget > slot。所以这份单测的
// 主要工作不是覆盖四个分支各自能出对的结果(那是显然的),而是穷举【同时成立】的组合,逐条确认
// 只报优先级最高的那一个 —— 原因一多,UI 与管家就会各挑一个说,用户看到的两处解释就对不上。
//
// 覆盖:
//   ① 四个原因各自单独成立
//   ② 不在等(pending=0 且 ctx 为空/null/非对象)-> null
//   ③ 原因单一性:2^4 - 1 = 15 种「至少一个成立」的组合,逐个断言 reason 是优先级最高的那个
//   ④ 形状:reason 必在 STEWARD_WAIT_REASONS 里;lock 带 blockedBy、slot 带 ahead、
//      needs_you/budget 两个可选字段都不带(形状不能随原因偷偷长出别的键)
//   ⑤ 边界:pending 非数/负数/字符串数字;ahead 缺失或非数 -> 0;lock 只有 sessionId 没有 title;
//      budget 两个 axis 的人话不同;标签里的尖括号被中和
//
// 与既有 dev-harness/unit 件同款约定(见 steward-preroute.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录;PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-wait-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { waitReasonFor, STEWARD_WAIT_REASONS, STEWARD_WAIT_LABELS } = srv;

const LOCK = { sessionId: 'sess_holder', title: '周报-W36', cwdKey: 'abc123def456' };
const BUDGET_TURNS = { axis: 'turns_per_hour', spent: 120, limit: 120 };
const BUDGET_COST = { axis: 'cost_per_day', spent: 21.5, limit: 20 };
const SLOT = { ahead: 2 };

/* ═══════════ ⓪ 常量表本身 ═══════════ */
ok(Array.isArray(STEWARD_WAIT_REASONS) && STEWARD_WAIT_REASONS.length === 4
  && STEWARD_WAIT_REASONS.join(',') === 'needs_you,lock,budget,slot',
  '⓪ STEWARD_WAIT_REASONS 就是四个原因,且顺序即优先级(等你>等锁>等预算>等并发位)');
ok(Object.isFrozen(STEWARD_WAIT_REASONS) && Object.isFrozen(STEWARD_WAIT_LABELS), '⓪ 两张常量表都冻结');
ok(STEWARD_WAIT_REASONS.every(r => typeof STEWARD_WAIT_LABELS[r] === 'string' && STEWARD_WAIT_LABELS[r]),
  '⓪ 每个原因都有人话短标签');

/* ═══════════ ① 四个原因各自单独成立 ═══════════ */
{
  const needs = waitReasonFor({ pending: 3 }, null);
  ok(needs && needs.reason === 'needs_you' && needs.label === '等你(3 条待决)', '① 只有待决 -> needs_you,标签带条数');
  const lock = waitReasonFor({ pending: 0 }, { lock: LOCK });
  ok(lock && lock.reason === 'lock' && lock.blockedBy && lock.blockedBy.sessionId === 'sess_holder'
    && lock.label.includes('周报-W36'), '① 只有锁 -> lock,blockedBy 与标签都指向占着的那条线程');
  const budget = waitReasonFor({ pending: 0 }, { budget: BUDGET_TURNS });
  ok(budget && budget.reason === 'budget' && budget.label.includes('120'), '① 只有预算 -> budget,标签带触顶的数字');
  const slot = waitReasonFor({ pending: 0 }, { slot: SLOT });
  ok(slot && slot.reason === 'slot' && slot.ahead === 2 && slot.label.includes('前面还有 2 条'),
    '① 只有并发位 -> slot,ahead 与标签一致');
}

/* ═══════════ ② 不在等 -> null ═══════════ */
for (const [label, thread, ctx] of [
  ['两个入参都空对象', {}, {}],
  ['ctx 为 null', { pending: 0 }, null],
  ['ctx 为非对象', { pending: 0 }, 'lock'],
  ['thread 为 null', null, null],
  ['两个入参都 undefined', undefined, undefined],
  ['ctx 的三个键都是假值', { pending: 0 }, { lock: null, budget: null, slot: null }],
  ['ctx 的键是非对象真值(不认)', { pending: 0 }, { lock: true, budget: 1, slot: 'x' }],
]) ok(waitReasonFor(thread, ctx) === null, `② 不在等 -> null:${label}`);

/* ═══════════ ③ 原因单一性:15 种组合逐个断言 ═══════════ */
{
  const priority = ['needs_you', 'lock', 'budget', 'slot'];
  let bad = [];
  for (let mask = 1; mask < 16; mask++) {
    const on = {
      needs_you: !!(mask & 1), lock: !!(mask & 2), budget: !!(mask & 4), slot: !!(mask & 8),
    };
    const thread = { pending: on.needs_you ? 1 : 0 };
    const ctx = {};
    if (on.lock) ctx.lock = LOCK;
    if (on.budget) ctx.budget = BUDGET_TURNS;
    if (on.slot) ctx.slot = SLOT;
    const expected = priority.find(r => on[r]);
    const got = waitReasonFor(thread, ctx);
    if (!got || got.reason !== expected) bad.push(`mask=${mask} 期待 ${expected} 实得 ${got ? got.reason : 'null'}`);
    // 单一性还有第二层:结果里只能有一个 reason 字段,不能同时挂上别的原因的证据。
    if (got && got.reason !== 'lock' && 'blockedBy' in got) bad.push(`mask=${mask} 非 lock 却带 blockedBy`);
    if (got && got.reason !== 'slot' && 'ahead' in got) bad.push(`mask=${mask} 非 slot 却带 ahead`);
  }
  ok(bad.length === 0, '③ 15 种「至少一个成立」的组合全部只报优先级最高的那个原因' + (bad.length ? ' → ' + bad.join(' | ') : ''));
}

/* ═══════════ ④ 形状 ═══════════ */
{
  const all = [
    waitReasonFor({ pending: 1 }, {}),
    waitReasonFor({ pending: 0 }, { lock: LOCK }),
    waitReasonFor({ pending: 0 }, { budget: BUDGET_COST }),
    waitReasonFor({ pending: 0 }, { slot: SLOT }),
  ];
  ok(all.every(w => w && STEWARD_WAIT_REASONS.includes(w.reason)), '④ reason 必在 STEWARD_WAIT_REASONS 白名单里');
  ok(all.every(w => typeof w.label === 'string' && w.label.length > 0 && w.label.length <= 120),
    '④ 每种原因都给出一句非空、不失控的人话');
  ok(all.every(w => w.label.startsWith(STEWARD_WAIT_LABELS[w.reason])), '④ 人话以该原因的短标签开头(UI 可只取短标签)');
  const lock = all[1];
  ok(Object.keys(lock).sort().join(',') === 'blockedBy,label,reason', '④ lock 的键恰好是 {reason,label,blockedBy}');
  const slot = all[3];
  ok(Object.keys(slot).sort().join(',') === 'ahead,label,reason', '④ slot 的键恰好是 {reason,label,ahead}');
  ok(Object.keys(all[0]).sort().join(',') === 'label,reason' && Object.keys(all[2]).sort().join(',') === 'label,reason',
    '④ needs_you / budget 的键恰好是 {reason,label}(形状不随原因偷偷长键)');
}

/* ═══════════ ⑤ 边界 ═══════════ */
{
  ok(waitReasonFor({ pending: '2' }, null).reason === 'needs_you', "⑤ pending 是数字字符串 '2' 也算有待决");
  ok(waitReasonFor({ pending: -3 }, { slot: SLOT }).reason === 'slot', '⑤ pending 为负 -> 不算待决(夹到 0)');
  ok(waitReasonFor({ pending: NaN }, { slot: SLOT }).reason === 'slot', '⑤ pending 非数 -> 不算待决');
  ok(waitReasonFor({ pending: 'many' }, null) === null, '⑤ pending 是不可解析的字符串 -> 不算待决');

  const noTitle = waitReasonFor({}, { lock: { sessionId: 'sess_x' } });
  ok(noTitle.blockedBy.sessionId === 'sess_x' && noTitle.blockedBy.title === '' && noTitle.label.includes('sess_x'),
    '⑤ 锁的持有者没有标题时,人话退回到它的 id(不编一个标题)');
  const anon = waitReasonFor({}, { lock: {} });
  ok(anon.reason === 'lock' && !anon.label.includes('「'), '⑤ 锁的持有者连 id 都没有时给一句不带引号的兜底人话');

  const evil = waitReasonFor({}, { lock: { sessionId: 'sess_y', title: '<img src=x>' } });
  ok(!evil.label.includes('<') && !evil.label.includes('>') && evil.label.includes('＜img src=x＞'),
    '⑤ 标题里的尖括号被中和成全角尖括号(与 stewardSanitizeText 同一口径;128f 起不再是方括号)');

  ok(waitReasonFor({}, { slot: {} }).ahead === 0 && waitReasonFor({}, { slot: {} }).label.includes('下一个就是它'),
    '⑤ ahead 缺失 -> 0,人话改说「下一个就是它」');
  ok(waitReasonFor({}, { slot: { ahead: 'x' } }).ahead === 0, '⑤ ahead 非数 -> 0');
  ok(waitReasonFor({}, { slot: { ahead: -5 } }).ahead === 0, '⑤ ahead 为负 -> 0');

  const turns = waitReasonFor({}, { budget: BUDGET_TURNS }).label;
  const cost = waitReasonFor({}, { budget: BUDGET_COST }).label;
  ok(turns.includes('回合') && !turns.includes('花'), '⑤ 小时回合触顶说的是回合数');
  ok(cost.includes('花') && cost.includes('21.5'), '⑤ 当日费用触顶说的是钱数');
  ok(waitReasonFor({}, { budget: {} }).reason === 'budget', '⑤ budget 缺字段仍能给出一个 budget 原因(不抛)');
}

/* ═══════════ ⑥ 纯函数:入参不被改写 ═══════════ */
{
  const thread = { pending: 0 };
  const ctx = { lock: { sessionId: 'sess_z', title: 'T' } };
  const before = JSON.stringify([thread, ctx]);
  waitReasonFor(thread, ctx);
  waitReasonFor(thread, ctx);
  ok(JSON.stringify([thread, ctx]) === before, '⑥ 连调两次,两个入参对象一字未改(纯函数)');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`STEWARD-WAIT-REASON UNIT: FAIL (${fail})`); process.exit(1); }
console.log('STEWARD-WAIT-REASON UNIT: ALL PASS');

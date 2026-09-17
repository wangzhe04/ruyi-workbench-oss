// Unit: 第 123 波 M1 §3.1(37 号文;设计权威 29 号文 §3)—— 定时任务纯函数内核 06j-scheduler-core.js。
//
// 为什么这份单测是这一刀的主判据:调度器要对的是【日历】,而日历的坑全在边界上 ——
// 月末(31 号在 2 月是几号)、闰日(2 月 29 只在闰年存在)、夏令时(一天可能只有 23 小时或有 25 小时)、
// cron 的并集规则。这些边界一年只来一次,靠真等是等不到的;而 nextFireAt 把「现在几点」做成了入参,
// 于是每一条边界都能在毫秒级里被穷举。
//
// 覆盖(≥30 条):
//   ① 月末钳位:1/31 -> 2/28(平年)、2/29(闰年)、4 月钳到 30;钳位不溢出到下月 1 号
//   ② 闰日:once 2028-02-29 合法、2027-02-29 被拒;cron `0 0 29 2 *` 只在闰年命中
//   ③ DST 两向(TZ=America/New_York 子进程):3 月切换日不存在的 02:30、11 月重复的 01:30 各一;
//      「本地墙钟 09:00 就是 09:00」跨两向都成立
//   ④ cron 边界:*/15、0 9 * * 1-5、日与周同时限定取并集、5 字段校验、越界拒
//   ⑤ once 过期 -> null;grace 内外(missedOccurrence);occurrenceKey 形状
//   ⑥ describeSchedule:只回键与参数;中英各 7 句逐字(期望文案是本文件里的【显式表】,
//      即交给 M2 的 locale 建议稿,不是对生产实现的镜像重写)
//   ⑦ normalizeSchedulerTask:缺省 policy、bypass 回落、禁止键整条拒、上限钳位、target 校验
//   ⑧ 127 波 2-ter:target.tier 值域与 13f 两处 tier 枚举逐项相等、只在 prompt + new-session 时留下、
//      不带就没有这个键;服务端自有的 workdir 原样带过去、空不落键、清控制字符、截 1000 字
//
// 与既有 dev-harness/unit 件同款约定(见 steward-core.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME / RUYI_HOME 覆盖到临时目录,防止污染真实数据根;PASS/FAIL 逐条打印,
// process.exit(fail?1:0)。
'use strict';
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-core-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const serverPath = path.join(app, 'server.js');
const srv = require(serverPath);

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const {
  normalizeSchedulerTask, nextFireAt, parseCronExpr, describeSchedule,
  occurrenceKey, missedOccurrence,
  SCHEDULER_DEFAULT_POLICY, SCHEDULER_LIMITS, SCHEDULER_DESCRIBE_KEYS, SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
} = srv;

// 本地墙钟 -> epoch ms(测试侧自己算一遍,不复用生产的 schedulerLocalMs —— 那会变成镜像重写)。
const at = (y, mo, d, hh, mm) => new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();
const localParts = ms => {
  const dt = new Date(ms);
  return { y: dt.getFullYear(), mo: dt.getMonth() + 1, d: dt.getDate(), hh: dt.getHours(), mm: dt.getMinutes() };
};
const same = (ms, y, mo, d, hh, mm) => {
  const p = localParts(ms);
  return p.y === y && p.mo === mo && p.d === d && p.hh === hh && p.mm === mm;
};

/* ═══════════════════ ① 月末钳位(37 号文 §3.1) ═══════════════════ */
{
  // 2027 是平年:1/31 09:00 之后的下一次「每月 31 号」应落在 2/28,不是 3/3(那是 Date 溢出的样子)。
  const plan = { kind: 'monthly', dayOfMonth: 31, at: '09:00' };
  const after131 = nextFireAt(plan, at(2027, 1, 31, 9, 1));
  ok(same(after131, 2027, 2, 28, 9, 0), '① 平年 1/31 -> 2/28 09:00(月末钳位,不溢出到 3/3);实得 ' + new Date(after131).toString());
  // 2028 是闰年:同一条计划在 1/31 之后应落在 2/29。
  const leap = nextFireAt(plan, at(2028, 1, 31, 9, 1));
  ok(same(leap, 2028, 2, 29, 9, 0), '① 闰年 1/31 -> 2/29 09:00;实得 ' + new Date(leap).toString());
  // 4 月只有 30 天:3/31 之后应落在 4/30。
  const april = nextFireAt(plan, at(2027, 3, 31, 9, 1));
  ok(same(april, 2027, 4, 30, 9, 0), '① 3/31 -> 4/30 09:00(4 月无 31 号);实得 ' + new Date(april).toString());
  // 钳位只影响短月:5 月有 31 天,4/30 之后就是 5/31。
  const may = nextFireAt(plan, at(2027, 4, 30, 9, 1));
  ok(same(may, 2027, 5, 31, 9, 0), '① 4/30 -> 5/31 09:00(长月不钳);实得 ' + new Date(may).toString());
  // dayOfMonth 29:平年 2 月钳到 28。
  const d29 = nextFireAt({ kind: 'monthly', dayOfMonth: 29, at: '07:00' }, at(2027, 2, 1, 0, 0));
  ok(same(d29, 2027, 2, 28, 7, 0), '① dayOfMonth 29 在平年 2 月钳到 2/28;实得 ' + new Date(d29).toString());
  // 同月内还没到点时不跳月。
  const sameMonth = nextFireAt({ kind: 'monthly', dayOfMonth: 15, at: '18:00' }, at(2027, 6, 15, 17, 59));
  ok(same(sameMonth, 2027, 6, 15, 18, 0), '① 当月还没到点 -> 就是本月那一天;实得 ' + new Date(sameMonth).toString());
  // 已过点则跳下月。
  const nextMonth = nextFireAt({ kind: 'monthly', dayOfMonth: 15, at: '18:00' }, at(2027, 6, 15, 18, 0));
  ok(same(nextMonth, 2027, 7, 15, 18, 0), '① 当月已过点(含正好等于)-> 下月同日;实得 ' + new Date(nextMonth).toString());
}

/* ═══════════════════ ② 闰日 ═══════════════════ */
{
  const good = normalizeSchedulerTask({
    title: '闰日提醒', schedule: { kind: 'once', date: '2028-02-29', at: '09:00' },
    payload: { kind: 'reminder', text: '闰日快乐' },
  }, at(2027, 1, 1, 0, 0));
  ok(good.ok === true && good.task.schedule.date === '2028-02-29', '② once 2028-02-29 合法(闰年真有这一天)');
  ok(good.ok === true && same(Date.parse(good.task.state.nextFireAt), 2028, 2, 29, 9, 0),
    '② once 2028-02-29 的 nextFireAt 就是那一天 09:00');
  const bad = normalizeSchedulerTask({
    title: '不存在的日子', schedule: { kind: 'once', date: '2027-02-29', at: '09:00' },
    payload: { kind: 'reminder', text: 'x' },
  }, at(2026, 1, 1, 0, 0));
  ok(bad.ok === false && bad.code === 'invalid_request', '② once 2027-02-29 被拒(平年没有 2 月 29)');
  const badDay = normalizeSchedulerTask({
    title: '不存在的日子', schedule: { kind: 'once', date: '2027-04-31', at: '09:00' },
    payload: { kind: 'reminder', text: 'x' },
  }, at(2026, 1, 1, 0, 0));
  ok(badDay.ok === false, '② once 2027-04-31 被拒(4 月没有 31 号,不静默折成 5/1)');
}

/* ═══════════════════ ④ cron ═══════════════════ */
{
  const every15 = parseCronExpr('*/15 * * * *');
  ok(every15.ok === true && every15.minute.join(',') === '0,15,30,45', '④ */15 -> 分 0,15,30,45');
  const f1 = nextFireAt({ kind: 'cron', expr: '*/15 * * * *' }, at(2026, 5, 4, 10, 7));
  ok(same(f1, 2026, 5, 4, 10, 15), '④ */15 从 10:07 起下一次是 10:15');
  const f2 = nextFireAt({ kind: 'cron', expr: '*/15 * * * *' }, at(2026, 5, 4, 10, 45));
  ok(same(f2, 2026, 5, 4, 11, 0), '④ */15 从 10:45(正好在点上)起下一次是 11:00 —— 严格「之后」');
  // 0 9 * * 1-5:工作日 09:00。2026-05-02 是周六 -> 下一次是周一 5/4。
  const weekday = nextFireAt({ kind: 'cron', expr: '0 9 * * 1-5' }, at(2026, 5, 2, 12, 0));
  ok(same(weekday, 2026, 5, 4, 9, 0), '④ 0 9 * * 1-5 周六之后跳到周一 09:00;实得 ' + new Date(weekday).toString());
  // 0 0 29 2 *:只在闰年 2/29。2026 起算 -> 2028-02-29 00:00。
  const leapCron = nextFireAt({ kind: 'cron', expr: '0 0 29 2 *' }, at(2026, 3, 1, 0, 0));
  ok(same(leapCron, 2028, 2, 29, 0, 0), '④ 0 0 29 2 * 只在闰年命中(2026-03 起算 -> 2028-02-29);实得 ' + new Date(leapCron).toString());
  // 日与周同时限定 -> POSIX 并集(或),不是交集。2026-05-04 是周一。
  const union = parseCronExpr('0 0 13 * 5');
  ok(union.ok === true && union.domRestricted === true && union.dowRestricted === true, '④ 日与周都不是 * 时两个 restricted 旗都为真');
  const unionFire = nextFireAt({ kind: 'cron', expr: '0 0 13 * 5' }, at(2026, 5, 4, 0, 0));
  // 5/8 是周五(先到),5/13 是周三(13 号)。并集 -> 先命中 5/8。
  ok(same(unionFire, 2026, 5, 8, 0, 0), '④ 日与周同时给 -> 取并集(周五 5/8 先于 13 号);实得 ' + new Date(unionFire).toString());
  ok(parseCronExpr('* * * *').ok === false, '④ 4 个字段被拒(必须 5 个)');
  ok(parseCronExpr('60 * * * *').ok === false, '④ 分钟 60 越界被拒');
  ok(parseCronExpr('0 24 * * *').ok === false, '④ 小时 24 越界被拒');
  ok(parseCronExpr('0 0 * * 8').ok === false, '④ 星期 8 越界被拒');
  ok(parseCronExpr('0 0 * * MON').ok === false, '④ 名字写法(MON)不支持,明确拒而不是猜');
  const dow7 = parseCronExpr('0 0 * * 7');
  ok(dow7.ok === true && dow7.dow.join(',') === '0', '④ 星期 7 折成 0(周日两种写法同义)');
  const stepFrom = parseCronExpr('5/20 * * * *');
  ok(stepFrom.ok === true && stepFrom.minute.join(',') === '5,25,45', '④ 5/20 = 从 5 起步进 20 到上界');
  const range = parseCronExpr('0-4 * * * *');
  ok(range.ok === true && range.minute.join(',') === '0,1,2,3,4', '④ 0-4 展开成 5 个值');
  const list = parseCronExpr('0,30 * * * *');
  ok(list.ok === true && list.minute.join(',') === '0,30', '④ 逗号列表');
  ok(nextFireAt({ kind: 'cron', expr: '0 0 30 2 *' }, at(2026, 1, 1, 0, 0)) === null,
    '④ 0 0 30 2 *(2 月 30 号永不存在)-> 五年扫不到,回 null 而不是死循环');
}

/* ═══════════════════ ⑤ once 过期 / grace / occurrenceKey ═══════════════════ */
{
  ok(nextFireAt({ kind: 'once', date: '2020-01-01', at: '09:00' }, at(2026, 1, 1, 0, 0)) === null,
    '⑤ 过期的 once -> null(不再触发)');
  ok(occurrenceKey('sch_x', Date.UTC(2026, 8, 14, 1, 0, 0)) === 'sch_x@2026-09-14T01:00:00.000Z',
    '⑤ occurrenceKey = taskId@dueIso');
  const base = normalizeSchedulerTask({
    title: '每天九点', schedule: { kind: 'daily', at: '09:00' },
    payload: { kind: 'reminder', text: '起床' },
    policy: { graceMinutes: 120 },
  }, at(2026, 5, 4, 8, 0));
  ok(base.ok === true && same(Date.parse(base.task.state.nextFireAt), 2026, 5, 4, 9, 0), '⑤ daily 建好时 nextFireAt = 今天 09:00');
  const task = { ...base.task, id: 'sch_grace' };
  ok(missedOccurrence(task, at(2026, 5, 4, 8, 59)) === null, '⑤ 还没到点 -> 没有错过');
  const inside = missedOccurrence(task, at(2026, 5, 4, 10, 30));
  ok(!!inside && inside.withinGrace === true && inside.runLate === true && inside.mode === 'late',
    '⑤ 迟 90 分钟(grace 120)-> 在宽限内、该补跑一次、mode late');
  ok(!!inside && inside.occurrenceKey === occurrenceKey('sch_grace', at(2026, 5, 4, 9, 0)),
    '⑤ 补跑引用的是【原本那个时点】的 occurrenceKey,不是「现在」');
  const outside = missedOccurrence(task, at(2026, 5, 4, 12, 30));
  ok(!!outside && outside.withinGrace === false && outside.runLate === false,
    '⑤ 迟 210 分钟(grace 120)-> 超出宽限,不补跑(由 13s 记 skipped)');
  const skipTask = { ...task, policy: { ...task.policy, onMissed: 'skip' } };
  const skipped = missedOccurrence(skipTask, at(2026, 5, 4, 9, 30));
  ok(!!skipped && skipped.withinGrace === true && skipped.runLate === false,
    '⑤ onMissed:skip -> 即使在宽限内也不补跑(策略优先于宽限)');
}

/* ═══════════════════ ⑥ describeSchedule:只回键与参数 + 中英各 7 句逐字 ═══════════════════ */
// 这张表就是交给 M2 的 locale 建议稿。它是【显式期望】,不是对生产实现的镜像 ——
// 生产代码里一个中文句子都没有(它只回键),所以这里写错了不会自动变绿。
const ZH_DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const EN_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TEXT = {
  zh: {
    'scheduler.describe.once': p => p.month + ' 月 ' + p.day + ' 日 ' + p.time + ' 一次',
    'scheduler.describe.daily': p => '每天 ' + p.time,
    'scheduler.describe.weekly': p => '每周' + p.days.map(d => ZH_DOW[d].slice(1)).join('、') + ' ' + p.time,
    'scheduler.describe.weekly.weekdays': p => '每个工作日 ' + p.time,
    'scheduler.describe.weekly.weekend': p => '每个周末 ' + p.time,
    'scheduler.describe.monthly': p => '每月 ' + p.day + ' 日 ' + p.time,
    'scheduler.describe.monthly.lastDay': p => '每月最后一天 ' + p.time,
    'scheduler.describe.cron': p => '按 cron 表达式 ' + p.expr,
    'scheduler.describe.invalid': () => '这条计划读不懂',
  },
  en: {
    'scheduler.describe.once': p => 'once on ' + p.month + '/' + p.day + ' at ' + p.time,
    'scheduler.describe.daily': p => 'every day at ' + p.time,
    'scheduler.describe.weekly': p => 'every ' + p.days.map(d => EN_DOW[d]).join(', ') + ' at ' + p.time,
    'scheduler.describe.weekly.weekdays': p => 'every weekday at ' + p.time,
    'scheduler.describe.weekly.weekend': p => 'every weekend at ' + p.time,
    'scheduler.describe.monthly': p => 'day ' + p.day + ' of every month at ' + p.time,
    'scheduler.describe.monthly.lastDay': p => 'the last day of every month at ' + p.time,
    'scheduler.describe.cron': p => 'on cron schedule ' + p.expr,
    'scheduler.describe.invalid': () => 'this schedule cannot be read',
  },
};
const render = (described, lang) => TEXT[lang][described.key](described.params);
{
  const cases = [
    [{ kind: 'once', date: '2026-09-14', at: '09:00' }, 'scheduler.describe.once', '9 月 14 日 09:00 一次', 'once on 9/14 at 09:00'],
    [{ kind: 'daily', at: '07:30' }, 'scheduler.describe.daily', '每天 07:30', 'every day at 07:30'],
    [{ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '18:00' }, 'scheduler.describe.weekly.weekdays', '每个工作日 18:00', 'every weekday at 18:00'],
    [{ kind: 'weekly', days: [0, 6], at: '10:00' }, 'scheduler.describe.weekly.weekend', '每个周末 10:00', 'every weekend at 10:00'],
    [{ kind: 'weekly', days: [1, 4], at: '20:15' }, 'scheduler.describe.weekly', '每周一、四 20:15', 'every Mon, Thu at 20:15'],
    [{ kind: 'monthly', dayOfMonth: 31, at: '09:00' }, 'scheduler.describe.monthly.lastDay', '每月最后一天 09:00', 'the last day of every month at 09:00'],
    [{ kind: 'monthly', dayOfMonth: 5, at: '09:00' }, 'scheduler.describe.monthly', '每月 5 日 09:00', 'day 5 of every month at 09:00'],
    [{ kind: 'cron', expr: '0 9 * * 1-5' }, 'scheduler.describe.cron', '按 cron 表达式 0 9 * * 1-5', 'on cron schedule 0 9 * * 1-5'],
  ];
  for (const [plan, key, zh, en] of cases) {
    const zhOut = describeSchedule(plan, 'zh');
    const enOut = describeSchedule(plan, 'en');
    ok(zhOut.key === key, '⑥ ' + key + ' 键命中');
    ok(render(zhOut, 'zh') === zh, '⑥ zh 逐字「' + zh + '」;实得「' + render(zhOut, 'zh') + '」');
    ok(render(enOut, 'en') === en, '⑥ en 逐字「' + en + '」;实得「' + render(enOut, 'en') + '」');
  }
  ok(describeSchedule({ kind: 'weekly', days: [], at: '09:00' }, 'zh').key === 'scheduler.describe.invalid',
    '⑥ 读不懂的计划回 invalid 键,不编一句话出来');
  ok(describeSchedule({ kind: 'daily', at: '25:00' }, 'zh').key === 'scheduler.describe.invalid',
    '⑥ 非法时间回 invalid 键');
  {
    const out = describeSchedule({ kind: 'monthly', dayOfMonth: 5, at: '09:00' }, 'zh');
    ok(out.key.indexOf('scheduler.describe.') === 0 && typeof out.params === 'object',
      '⑥ 返回值只有 key/params/locale 三样,生产代码不产出人话');
    ok(Object.keys(out).sort().join(',') === 'key,locale,params', '⑥ 返回形状恒为 {key, locale, params}');
  }
  const missing = SCHEDULER_DESCRIBE_KEYS.filter(k => !TEXT.zh[k] || !TEXT.en[k]);
  ok(missing.length === 0, '⑥ SCHEDULER_DESCRIBE_KEYS 每个键在中英两张建议稿里都有文案(缺: ' + missing.join(',') + ')');
}

/* ═══════════════════ ⑦ normalizeSchedulerTask ═══════════════════ */
{
  const now = at(2026, 5, 4, 8, 0);
  const good = normalizeSchedulerTask({
    title: '  写周报  ', schedule: { kind: 'weekly', days: [5, 5, 1], at: '18:00' },
    payload: { kind: 'prompt', text: '生成周报草稿' },
  }, now);
  ok(good.ok === true, '⑦ 合法任务通过');
  ok(good.task.title === '写周报', '⑦ title 去空白');
  ok(good.task.schedule.days.join(',') === '1,5', '⑦ days 去重并升序');
  ok(JSON.stringify(good.task.policy) === JSON.stringify(SCHEDULER_DEFAULT_POLICY), '⑦ 未给 policy -> 逐字等于 SCHEDULER_DEFAULT_POLICY');
  ok(good.task.target.mode === 'new-session', '⑦ 未给 target -> new-session');
  ok(good.task.autonomy.permissionMode === '', "⑦ 未给权限档 -> '' = 跟随全局默认档");
  ok(good.task.id === '' && good.task.revision === 0 && good.task.schema === 1, '⑦ 纯函数不造 id(留给 13s),revision 从 0 起');
  ok(good.task.state.enabled === true && good.task.state.consecutiveFailures === 0, '⑦ state 缺省:开着、零连败');

  const bypass = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    autonomy: { permissionMode: 'bypass' },
  }, now);
  ok(bypass.ok === true && bypass.task.autonomy.permissionMode === '', '⑦ 越权 bypass 回落(29 号文 §10:任务级授权永不含 bypass)');
  const bypassAlias = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    autonomy: { permissionMode: 'bypassPermissions' },
  }, now);
  ok(bypassAlias.ok === true && bypassAlias.task.autonomy.permissionMode === '', '⑦ CLI 原生别名 bypassPermissions 同样回落');
  const plan = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    autonomy: { permissionMode: 'plan' },
  }, now);
  ok(plan.ok === true && plan.task.autonomy.permissionMode === 'plan', '⑦ 非 bypass 的档原样留着(白名单判定在 13s)');

  for (const key of SCHEDULER_FORBIDDEN_PAYLOAD_KEYS) {
    const hit = normalizeSchedulerTask({
      title: 't', schedule: { kind: 'daily', at: '09:00' },
      payload: { kind: 'prompt', text: 'x', [key]: 'whatever' },
    }, now);
    ok(hit.ok === false && hit.code === 'payload_forbidden_key', '⑦ 载荷带禁止键 ' + key + ' -> 整条拒');
  }
  const deep = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' },
    payload: { kind: 'prompt', text: 'x', meta: { list: [{ apiKey: 'sk-x' }] } },
  }, now);
  ok(deep.ok === false && deep.code === 'payload_forbidden_key', '⑦ 禁止键藏在数组里的对象上也拒(深扫)');
  const targetCwd = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x' },
    target: { mode: 'new-session', cwd: 'C:\\somewhere' },
  }, now);
  ok(targetCwd.ok === false && targetCwd.code === 'payload_forbidden_key', '⑦ target.cwd 同样拒(绕过工作区表的唯一入口)');

  ok(normalizeSchedulerTask({ title: '', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' } }, now).ok === false, '⑦ 空标题被拒');
  ok(normalizeSchedulerTask({ title: 't', schedule: { kind: 'nope', at: '09:00' }, payload: { kind: 'reminder', text: 'x' } }, now).ok === false, '⑦ 未知计划类型被拒');
  ok(normalizeSchedulerTask({ title: 't', schedule: { kind: 'daily', at: '9:00' }, payload: { kind: 'reminder', text: 'x' } }, now).ok === false, "⑦ at 必须是两位 'HH:MM'");
  ok(normalizeSchedulerTask({ title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'playbook', text: 'x' } }, now).ok === false, '⑦ playbook 载荷本波不收(127 波)');
  ok(normalizeSchedulerTask({ title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: '   ' } }, now).ok === false, '⑦ 空正文被拒');
  ok(normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x' },
    target: { mode: 'existing-session' },
  }, now).ok === false, '⑦ existing-session 缺 sessionId 被拒');
  const existing = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x' },
    target: { mode: 'existing-session', sessionId: 'sess_abc123' },
  }, now);
  ok(existing.ok === true && existing.task.target.sessionId === 'sess_abc123', '⑦ existing-session 带合法 sessionId 通过');
  const clamped = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
    policy: { graceMinutes: 999999, maxRunsPerDay: 0, timeoutMinutes: -5, onMissed: 'nope', onFailure: 'nope' },
  }, now);
  ok(clamped.ok === true
    && clamped.task.policy.graceMinutes === SCHEDULER_LIMITS.graceMinutesMax
    && clamped.task.policy.maxRunsPerDay === SCHEDULER_LIMITS.maxRunsPerDayMin
    && clamped.task.policy.timeoutMinutes === SCHEDULER_LIMITS.timeoutMinutesMin
    && clamped.task.policy.onMissed === SCHEDULER_DEFAULT_POLICY.onMissed
    && clamped.task.policy.onFailure === SCHEDULER_DEFAULT_POLICY.onFailure,
  '⑦ policy 越界钳位 + 未知枚举回默认');
  const expiredOnce = normalizeSchedulerTask({
    title: 't', schedule: { kind: 'once', date: '2020-01-01', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
  }, now);
  ok(expiredOnce.ok === false, '⑦ 新建一条已经过期的 once -> 拒(它建出来就永远不会触发)');
  const ctrl = normalizeSchedulerTask({
    title: 'a' + String.fromCharCode(0) + 'b' + String.fromCharCode(9) + 'c',
    schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' },
  }, now);
  ok(ctrl.ok === true && ctrl.task.title === 'ab c', '⑦ 标题里的控制字符被清掉(NUL 丢、TAB 折空格)');
  ok(normalizeSchedulerTask(null, now).ok === false && normalizeSchedulerTask('x', now).ok === false, '⑦ 非对象入参被拒');
}

/* ═══════════════════ ⑧ 127 波 2-ter:target.tier(S-a)与服务端自有的 workdir(S-b) ═══════════════════ */
{
  const now = at(2026, 5, 4, 8, 0);
  const base = { title: 't', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x' } };
  // 两处值域相等:06j 抄的字面量 vs 13f 里 steward_thread_new / steward_schedule_create 的 tier 枚举(真产物内省,
  // 从管家会话能拿到的工具表里取 —— 不 grep 源码形状)。
  const tools = srv.buildOpenAiTools({ subagentMaxPerTurn: 0 }, null, { stewardSession: true });
  const enumOf = name => {
    const tool = tools.find(item => item && item.function && item.function.name === name);
    const tier = tool && tool.function.parameters && tool.function.parameters.properties && tool.function.parameters.properties.tier;
    return tier && Array.isArray(tier.enum) ? tier.enum : null;
  };
  const tiers = Array.isArray(srv.SCHEDULER_THREAD_TIERS) ? [...srv.SCHEDULER_THREAD_TIERS] : null;
  ok(tiers && JSON.stringify(tiers) === JSON.stringify(enumOf('steward_thread_new')),
    '⑧ 06j SCHEDULER_THREAD_TIERS 与 13f steward_thread_new 的 tier 枚举逐项相等(实得 ' + JSON.stringify(tiers) + ' vs ' + JSON.stringify(enumOf('steward_thread_new')) + ')');
  ok(tiers && JSON.stringify(tiers) === JSON.stringify(enumOf('steward_schedule_create')),
    '⑧ steward_schedule_create 的 tier 枚举与之同一份(实得 ' + JSON.stringify(enumOf('steward_schedule_create')) + ')');
  ok(Object.isFrozen(srv.SCHEDULER_THREAD_TIERS), '⑧ 值域常量是冻结的');

  for (const tier of ['strong', 'fast']) {
    const r = normalizeSchedulerTask({ ...base, target: { mode: 'new-session', tier } }, now);
    ok(r.ok === true && r.task.target.tier === tier && JSON.stringify(Object.keys(r.task.target)) === '["mode","tier"]',
      '⑧ prompt + new-session 带 tier:' + tier + ' -> 落进 target.tier(实得 ' + JSON.stringify(r.task && r.task.target) + ')');
  }
  const none = normalizeSchedulerTask({ ...base, target: { mode: 'new-session' } }, now);
  ok(none.ok === true && !('tier' in none.task.target) && JSON.stringify(none.task.target) === '{"mode":"new-session"}',
    '⑧ 判据 ③:不带 tier -> target 里【没有】tier 键(与修前逐字节同形;实得 ' + JSON.stringify(none.task && none.task.target) + ')');
  const empty = normalizeSchedulerTask({ ...base, target: { mode: 'new-session', tier: '' } }, now);
  ok(empty.ok === true && !('tier' in empty.task.target), '⑧ 空串 tier 不落字段');
  const bogus = normalizeSchedulerTask({ ...base, target: { mode: 'new-session', tier: 'deepseek' } }, now);
  ok(bogus.ok === true && !('tier' in bogus.task.target), '⑧ 值域外的 tier(deepseek)静默丢,不拒整条(与权限档越界回落同口径)');
  const existingTier = normalizeSchedulerTask({ ...base, target: { mode: 'existing-session', sessionId: 'sess_abc123', tier: 'fast' } }, now);
  ok(existingTier.ok === true && !('tier' in existingTier.task.target) && existingTier.task.target.sessionId === 'sess_abc123',
    '⑧ 判据 ④:existing-session 带 tier -> 静默丢(既有线程有它自己的引擎;实得 ' + JSON.stringify(existingTier.task && existingTier.task.target) + ')');
  const reminderTier = normalizeSchedulerTask({ ...base, payload: { kind: 'reminder', text: 'x' }, target: { mode: 'new-session', tier: 'fast' } }, now);
  ok(reminderTier.ok === true && !('tier' in reminderTier.task.target), '⑧ reminder 载荷带 tier -> 静默丢(不起回合)');
  const cwdStill = normalizeSchedulerTask({ ...base, target: { mode: 'new-session', tier: 'fast', cwd: 'C:\\somewhere' } }, now);
  ok(cwdStill.ok === false && cwdStill.code === 'payload_forbidden_key', '⑧ 判据 ④:带了 tier 的 target 仍然拒 cwd(禁止键表不动)');
  ok(JSON.stringify([...SCHEDULER_FORBIDDEN_PAYLOAD_KEYS]) === JSON.stringify(['localCommand', 'env', 'apiKey', 'dataRoot', 'cwd']),
    '⑧ 禁止键表逐字没动(workdir 不是靠禁止键挡的,是靠入口剥离 + 到点再核候选表)');

  // workdir:服务端自有字段。本函数只负责把它原样带过去(装载 / PATCH 都经这里);入口剥离在 13s/13t,由
  // scheduler-steward.e2e 的 W 段对真路由钉。
  const kept = normalizeSchedulerTask({ ...base, workdir: 'C:\\Users\\me\\Ruyi\\巡检' }, now);
  ok(kept.ok === true && kept.task.workdir === 'C:\\Users\\me\\Ruyi\\巡检', '⑧ 带着 workdir 的盘上任务 -> 原样带过去(实得 ' + JSON.stringify(kept.task && kept.task.workdir) + ')');
  ok(!('workdir' in none.task), '⑧ 没有 workdir 的任务不落这个键(管家关着 / 还没触发过的任务与修前同形)');
  const blank = normalizeSchedulerTask({ ...base, workdir: '   ' }, now);
  ok(blank.ok === true && !('workdir' in blank.task), '⑧ 只有空白的 workdir 不落键');
  const dirty = normalizeSchedulerTask({ ...base, workdir: 'C:\\a' + String.fromCharCode(0) + 'b' + String.fromCharCode(10) + 'c' }, now);
  ok(dirty.ok === true && dirty.task.workdir === 'C:\\ab c', '⑧ workdir 里的控制字符同样清掉(实得 ' + JSON.stringify(dirty.task && dirty.task.workdir) + ')');
  const long = normalizeSchedulerTask({ ...base, workdir: 'C:\\' + 'x'.repeat(2000) }, now);
  ok(long.ok === true && long.task.workdir.length === 1000, '⑧ workdir 截到 1000 字(与工作区路径同一个上限;实得 ' + (long.task && long.task.workdir.length) + ')');
}

/* ═══════════════════ ③ DST 两向(TZ=America/New_York 子进程) ═══════════════════ */
// 为什么要开子进程:TZ 只在进程启动时被 Date 读一次,本进程里改 process.env.TZ 不生效(Node 会缓存)。
// 2026 年美东:3 月 8 日 02:00 EST -> 03:00 EDT(那一天没有 02:30);11 月 1 日 02:00 EDT -> 01:00 EST
// (那一天有两个 01:30)。
{
  const DST_SCRIPT = [
    'const srv = require(' + JSON.stringify(serverPath) + ');',
    'const nf = srv.nextFireAt;',
    'const at = (y,mo,d,hh,mm) => new Date(y,mo-1,d,hh,mm,0,0).getTime();',
    'const parts = ms => { const t = new Date(ms); return { iso:t.toISOString(), y:t.getFullYear(), mo:t.getMonth()+1, d:t.getDate(), hh:t.getHours(), mm:t.getMinutes(), off:t.getTimezoneOffset() }; };',
    'const out = {};',
    'out.tz = new Date(at(2026,7,1,12,0)).getTimezoneOffset();',
    'out.springSkipped = parts(nf({kind:"daily", at:"02:30"}, at(2026,3,7,12,0)));',
    'out.springNextDay = parts(nf({kind:"daily", at:"02:30"}, nf({kind:"daily", at:"02:30"}, at(2026,3,7,12,0))));',
    'out.springNine = parts(nf({kind:"daily", at:"09:00"}, at(2026,3,7,12,0)));',
    'out.springNineBefore = parts(nf({kind:"daily", at:"09:00"}, at(2026,3,6,12,0)));',
    'out.fallFirst = parts(nf({kind:"daily", at:"01:30"}, at(2026,10,31,12,0)));',
    'out.fallSecond = parts(nf({kind:"daily", at:"01:30"}, nf({kind:"daily", at:"01:30"}, at(2026,10,31,12,0))));',
    'out.fallNine = parts(nf({kind:"daily", at:"09:00"}, at(2026,10,31,12,0)));',
    'process.stdout.write(JSON.stringify(out));',
  ].join('');
  const dstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-dst-'));
  const child = cp.spawnSync(process.execPath, ['-e', DST_SCRIPT], {
    env: {
      ...process.env,
      TZ: 'America/New_York',
      WIN_CLAUDE_WORKBENCH_HOME: dstHome,
      RUYI_HOME: dstHome,
      HOME: dstHome,
      USERPROFILE: dstHome,
    },
    encoding: 'utf8',
    windowsHide: true,
  });
  let dst = null;
  try { dst = JSON.parse(String(child.stdout || '')); } catch { dst = null; }
  ok(!!dst, '③ TZ=America/New_York 子进程跑通(stderr: ' + String(child.stderr || '').slice(0, 200) + ')');
  if (dst) {
    // 先确认 TZ 真的生效了 —— 7 月 1 日美东是 EDT(UTC-4),getTimezoneOffset() === 240。
    ok(dst.tz === 240, '③ 子进程真的在 America/New_York(7 月偏移 240 分钟);实得 ' + dst.tz);
    // 春季:3/8 的 02:30 不存在,JS 把它归一到 03:30 EDT(off 240)。这就是「由重算吸收」。
    ok(dst.springSkipped.mo === 3 && dst.springSkipped.d === 8 && dst.springSkipped.hh === 3 && dst.springSkipped.mm === 30 && dst.springSkipped.off === 240,
      '③ 春季跳过的 02:30 -> 落在 3/8 03:30 EDT(那一天真的没有 02:30);实得 ' + JSON.stringify(dst.springSkipped));
    ok(dst.springNextDay.d === 9 && dst.springNextDay.hh === 2 && dst.springNextDay.mm === 30,
      '③ 再下一次回到 3/9 02:30(只是切换那一天被顶到 03:30,不是从此永久改点);实得 ' + JSON.stringify(dst.springNextDay));
    ok(dst.springNine.d === 8 && dst.springNine.hh === 9 && dst.springNine.off === 240
      && dst.springNineBefore.d === 7 && dst.springNineBefore.hh === 9 && dst.springNineBefore.off === 300,
      '③ 本地墙钟 09:00 跨春季切换仍是 09:00(偏移 300 -> 240,墙钟不动);实得 ' + JSON.stringify([dst.springNineBefore, dst.springNine]));
    // 秋季:11/1 有两个 01:30(EDT off 240 与 EST off 300)。只落在第一个上。
    ok(dst.fallFirst.mo === 11 && dst.fallFirst.d === 1 && dst.fallFirst.hh === 1 && dst.fallFirst.mm === 30 && dst.fallFirst.off === 240,
      '③ 秋季重复的 01:30 -> 落在【第一个】(EDT,偏移 240);实得 ' + JSON.stringify(dst.fallFirst));
    ok(dst.fallSecond.d === 2 && dst.fallSecond.hh === 1 && dst.fallSecond.mm === 30,
      '③ 下一次直接跳到 11/2 01:30,不把同一天的第二个 01:30 再触发一遍;实得 ' + JSON.stringify(dst.fallSecond));
    ok(dst.fallNine.d === 1 && dst.fallNine.hh === 9 && dst.fallNine.off === 300,
      '③ 本地墙钟 09:00 跨秋季切换仍是 09:00(偏移已回 300);实得 ' + JSON.stringify(dst.fallNine));
  }
  try { fs.rmSync(dstHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(fail ? ('FAIL total ' + fail) : 'ALL PASS');
process.exit(fail ? 1 : 0);

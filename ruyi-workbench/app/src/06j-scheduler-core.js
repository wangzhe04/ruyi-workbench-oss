// ============================================================================
// 第 123 波 M1 §3.1(37 号文;设计权威 29 号文 §3「数据模型」与 §4「调度器」):
// 定时任务的【纯函数】内核。
//
// 三条纪律(整份文件的存在理由):
//   ① **零 I/O、零全局可变状态、零时钟读取** —— 「现在几点」永远由调用方喂进来(nowMs/fromMs)。
//      假时钟 e2e(§3.4 的 WCW_SCHEDULER_CLOCK_FILE)与 unit/scheduler-core.test.js 都靠这一条:
//      只要时间是入参,月末/闰日/夏令时/错过时点就都能在毫秒级里穷举,不必真等到那一天。
//   ② **本地墙钟语义**(29 号文 §4「时区与夏令时」):at:'09:00' 表示【本地】9 点,不存 UTC 偏移;
//      每次触发之后重算下一次,不预先缓存多次 —— 跨 DST 边界由重算自然吸收。
//      具体后果:春季跳过的那一小时里的时点(America/New_York 3 月切换日的 02:30)由 JS 的 Date
//      归一到 03:30(那一天真的没有 02:30);秋季重复的那一小时只落在【第一次】上(下一次从次日零点
//      起算,不会把同一天的第二个 01:30 再触发一遍)。
//   ③ **只算,不判定副作用**。要不要真的补跑、要不要熔断、要不要出箱,全在 13s-scheduler.js;
//      这里只回答「下一个时点是几」「错过的那个时点在不在宽限内」「这条任务洗干净长什么样」。
//
// 落点(engine 层,manifest 中位于 06i-steward-core.js 之后、07-autonomy.js 之前;文件名按
// ENGINEERING-SPEC §1 的 ^0[56][a-z]?- 正则)。本文件【不引用任何模块符号】—— 连 PERMISSION_MODES
// 都不引:权限档的值域校验在这里只做「不是 bypass 的非空字符串就留着」,真正的白名单判定留给 13s
// (它读得到 config,越界一律回落全局默认档)。这样本文件零入边零出边,不进任何环。
//
// 一条补丁纪律(32 号文 §4 纪律 11,本文件第一版真栽过):控制字符【不写转义字面量】。
// 第一版写了 /[<U+0000>-<U+001F>]/ 这种字符类,补丁传输层把 \uXXXX 当成转义解释,真往源码里写进了
// 裸 NUL 与 0x1F —— cat 出来一模一样,只有逐字节扫才看得见。改法见 schedulerStripControl:
// 按 charCodeAt 逐码位判,一个转义序列都不出现。
// ============================================================================

// 调度器的【延迟绑定命名空间】。先例逐字同款:06i 的 StewardHooks(「引擎侧纯函数与延迟绑定命名
// 空间,不实现,契约声明」)与 00-boot 的 EventStreamHooks。它住在这里而不是 13s,是因为填充方
// (13i 的 reminder 出箱写口,M2 §3.5)在 manifest 里排在 13s 【之前】—— 直接引用 13s 的函数名会是
// 一条新前向边;它只写 SchedulerHooks.onReminderDue,而 13i → 06j 是后向边。
// 契约(M1 只调用,不实现;M2 填充):
//   · onReminderDue(row)  —— reminder 载荷到点。row = { taskId, title, text, occurrenceKey, dueAt,
//                            firedAt, mode, sourceRef? }。写一行收件箱 reminder(「一句事实,不需要回答」)。
//   · onSchedulerNotice(row) —— 需要让用户知道、但不是 reminder 的三件事:
//                            row.kind ∈ 'skipped'(错过且不补) | 'tripped'(连败熔断) | 'needs_you'
//                            | 'unknown'(崩溃后结果未知);另带 taskId/title/occurrenceKey/mode/at。
// 两个口都是【旁路】:未填充时调用是无操作,填充方抛错也绝不反噬触发本身(13s 里整段 try 包住)。
const SchedulerHooks = {};

// ── 值域与上限(单一事实源;13s 与 API 都引用这里,不各写一份字面量)────────────────────────────
const SCHEDULER_SCHEDULE_KINDS = Object.freeze(['once', 'daily', 'weekly', 'monthly', 'cron']);
const SCHEDULER_PAYLOAD_KINDS = Object.freeze(['reminder', 'prompt']);   // playbook/workflow → 127 波
const SCHEDULER_TARGET_MODES = Object.freeze(['new-session', 'existing-session']);
const SCHEDULER_ON_MISSED = Object.freeze(['run-once-late', 'skip']);
const SCHEDULER_ON_FAILURE = Object.freeze(['notify', 'retry-once']);
const SCHEDULER_FIRE_MODES = Object.freeze(['ontime', 'late', 'manual']);
const SCHEDULER_PHASES = Object.freeze(['registered', 'dispatched', 'running', 'reconciled']);
const SCHEDULER_OUTCOMES = Object.freeze(['succeeded', 'failed', 'needs_you', 'skipped', 'unknown']);
const SCHEDULER_CREATORS = Object.freeze(['user', 'steward']);

// 29 号文 §10 红线第三条:任务载荷里不得出现本地命令、密钥、环境变量与数据目录。
// 判据是【键名】而不是值:载荷是模型能写的地方,「值看起来没问题」不是安全边界。深扫整棵载荷树,
// 命中一个就整条拒(不静默删键 —— 静默删会让下单方以为自己那条约定生效了)。
// cwd 也在表里:本刀的 target 不接受 cwd(见 normalizeSchedulerTask 的 target 段),载荷里出现它
// 只可能是想绕过工作区表。
const SCHEDULER_FORBIDDEN_PAYLOAD_KEYS = Object.freeze(['localCommand', 'env', 'apiKey', 'dataRoot', 'cwd']);

const SCHEDULER_LIMITS = Object.freeze({
  maxTasks: 200,                 // 29 号文 §3:任务定义上限
  titleChars: 120,
  textChars: 4000,
  graceMinutesMin: 0,
  graceMinutesMax: 10080,        // 7 天
  graceMinutesDefault: 720,      // 29 号文 §3 的缺省
  maxRunsPerDayMin: 1,
  maxRunsPerDayMax: 200,
  maxRunsPerDayDefault: 24,
  timeoutMinutesMin: 1,
  timeoutMinutesMax: 720,
  timeoutMinutesDefault: 30,
  globalRunsPerDay: 200,         // 29 号文 §4「上限」:全局每日触发上限
  consecutiveFailuresTrip: 3,    // 连败 3 次熔断
  askWaitMinutesMin: 1,          // §3.3 无人值守 ask 的等待窗口(config.schedulerAskWaitMinutes 的钳区间)
  askWaitMinutesMax: 240,
  askWaitMinutesDefault: 30,
});

// 缺省 policy(37 号文 §3.1 逐字)。数值全部取自 SCHEDULER_LIMITS,不在这里重写字面量。
const SCHEDULER_DEFAULT_POLICY = Object.freeze({
  onMissed: 'run-once-late',
  graceMinutes: SCHEDULER_LIMITS.graceMinutesDefault,
  maxRunsPerDay: SCHEDULER_LIMITS.maxRunsPerDayDefault,
  timeoutMinutes: SCHEDULER_LIMITS.timeoutMinutesDefault,
  onFailure: 'notify',
});

// ── 控制字符清洗(零转义字面量;见文件头「一条补丁纪律」)──────────────────────────────────────
const SCHEDULER_CODE_TAB = 9;
const SCHEDULER_CODE_LF = 10;
const SCHEDULER_CODE_CR = 13;
const SCHEDULER_CODE_SPACE = 32;
const SCHEDULER_CODE_DEL = 127;
const SCHEDULER_TEXT_SPACE = String.fromCharCode(SCHEDULER_CODE_SPACE);
const SCHEDULER_TEXT_LF = String.fromCharCode(SCHEDULER_CODE_LF);
// keepLines=false:整段折成单行(标题、id 这类);keepLines=true:保留换行(载荷正文)。
// CRLF 与裸 CR 一律折成一个换行,制表折成空格,其余 C0 控制字符与 DEL 直接丢。
function schedulerStripControl(schedTextRaw, schedKeepLines) {
  const source = String(schedTextRaw == null ? '' : schedTextRaw);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === SCHEDULER_CODE_CR) {
      if (source.charCodeAt(i + 1) === SCHEDULER_CODE_LF) i++;
      out += schedKeepLines ? SCHEDULER_TEXT_LF : SCHEDULER_TEXT_SPACE;
      continue;
    }
    if (code === SCHEDULER_CODE_LF) { out += schedKeepLines ? SCHEDULER_TEXT_LF : SCHEDULER_TEXT_SPACE; continue; }
    if (code === SCHEDULER_CODE_TAB) { out += SCHEDULER_TEXT_SPACE; continue; }
    if (code < SCHEDULER_CODE_SPACE || code === SCHEDULER_CODE_DEL) continue;
    out += source[i];
  }
  return out;
}
function schedulerCleanLine(schedTextRaw, schedMaxChars) {
  return schedulerStripControl(schedTextRaw, false).trim().slice(0, schedMaxChars);
}
function schedulerCleanBlock(schedTextRaw, schedMaxChars) {
  return schedulerStripControl(schedTextRaw, true).trim().slice(0, schedMaxChars);
}

// ── 时间小工具(全部走本地时区的 Date 构造;不做任何 UTC 偏移运算)──────────────────────────────
// new Date(y, m + 1, 0) = 下个月的第 0 天 = 本月最后一天。闰年 2 月自动 29。
function schedulerDaysInMonth(schedYear, schedMonth) {
  return new Date(schedYear, schedMonth + 1, 0).getDate();
}
// 本地墙钟 → epoch ms。**故意不校验「这个本地时刻是否存在」**:春季跳过的那一小时里的时刻由 JS
// 归一到跳过之后(02:30 → 03:30),这正是纪律②要的「由重算吸收」。
function schedulerLocalMs(schedYear, schedMonth, schedDay, schedHour, schedMinute) {
  return new Date(schedYear, schedMonth, schedDay, schedHour, schedMinute, 0, 0).getTime();
}
function schedulerParseHhMm(schedAtRaw) {
  const matched = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(schedulerCleanLine(schedAtRaw, 8));
  return matched ? { hour: Number(matched[1]), minute: Number(matched[2]) } : null;
}
// 'YYYY-MM-DD' → {year, month(0基), day};**真实性校验**:2027-02-29 不存在 → null(闰日只在闰年过得去)。
function schedulerParseYmd(schedDateRaw) {
  const matched = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(schedulerCleanLine(schedDateRaw, 12));
  if (!matched) return null;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > schedulerDaysInMonth(year, month - 1)) return null;
  return { year, month: month - 1, day };
}

// ── cron(自写最小 5 字段解析,零依赖;29 号文 §3「parseCronExpr」)──────────────────────────────
// 支持 *、a、a-b、a,b、*/n、a-b/n、a/n(a 到上界步进 n);不支持名字(JAN/MON)与 @reserved 别名。
// 越界/写法不认识一律 null,由 parseCronExpr 翻成稳定的 {ok:false}。
function schedulerCronField(schedFieldRaw, schedLo, schedHi) {
  // 局部名【不能】叫 text:32 号文 §4 纪律 12 —— 依赖图把裸标识符当跨模块符号,
  // `text` 命中 00-boot 的顶层 text(),会凭空生成一条 06j → 00-boot 的边(本文件第一版实测红过)。
  const fieldText = schedulerCleanLine(schedFieldRaw, 200);
  if (!fieldText) return null;
  const values = new Set();
  for (const chunk of fieldText.split(',')) {
    const piece = chunk.trim();
    if (!piece) return null;
    let rangeText = piece;
    let step = 1;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      rangeText = piece.slice(0, slash);
      const stepText = piece.slice(slash + 1);
      if (!/^[0-9]{1,4}$/.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let start;
    let end;
    if (rangeText === '*') { start = schedLo; end = schedHi; }
    else {
      const dash = rangeText.indexOf('-');
      if (dash > 0) {
        const lowText = rangeText.slice(0, dash);
        const highText = rangeText.slice(dash + 1);
        if (!/^[0-9]{1,4}$/.test(lowText) || !/^[0-9]{1,4}$/.test(highText)) return null;
        start = Number(lowText); end = Number(highText);
      } else {
        if (!/^[0-9]{1,4}$/.test(rangeText)) return null;
        start = Number(rangeText);
        // 5/15 = 从 5 起按 15 步进到上界(POSIX cron 的既有语义);裸 5 就是单值。
        end = slash >= 0 ? schedHi : start;
      }
    }
    if (start < schedLo || end > schedHi || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? values : null;
}

// 返回 { ok:true, expr, minute[], hour[], dom[], month[], dow[], domRestricted, dowRestricted }
// 或 { ok:false, error }。domRestricted/dowRestricted 记录「这一列写的是不是 *」—— POSIX 的并集规则
// (日与周同时限定时取【或】)只有靠这两个旗才判得出来。
function parseCronExpr(schedExprRaw) {
  const parts = schedulerCleanLine(schedExprRaw, 240).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { ok: false, error: 'cron 表达式必须是 5 个字段(分 时 日 月 周)' };
  const minute = schedulerCronField(parts[0], 0, 59);
  const hour = schedulerCronField(parts[1], 0, 23);
  const dom = schedulerCronField(parts[2], 1, 31);
  const month = schedulerCronField(parts[3], 1, 12);
  const dowRaw = schedulerCronField(parts[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dowRaw) {
    return { ok: false, error: 'cron 字段值越界或写法不认识(只支持 * , - / 与数字)' };
  }
  const sorted = source => [...source].sort((a, b) => a - b);
  // 周日两种写法(0 与 7)折成同一个值,否则 0-7 会被当成 8 个不同的星期。
  const dow = new Set(sorted(dowRaw).map(value => (value === 7 ? 0 : value)));
  return {
    ok: true,
    expr: parts.join(' '),
    minute: sorted(minute),
    hour: sorted(hour),
    dom: sorted(dom),
    month: sorted(month),
    dow: sorted(dow),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

// 某一天(本地)是否命中 cron 的日期部分。29 号文 §3:日与周同时给时按 POSIX 取【并集】。
function schedulerCronDayMatches(schedParsed, schedYear, schedMonth, schedDay) {
  if (!schedParsed.month.includes(schedMonth + 1)) return false;
  const weekday = new Date(schedYear, schedMonth, schedDay).getDay();
  const domHit = schedParsed.dom.includes(schedDay);
  const dowHit = schedParsed.dow.includes(weekday);
  if (schedParsed.domRestricted && schedParsed.dowRestricted) return domHit || dowHit;
  if (schedParsed.domRestricted) return domHit;
  if (schedParsed.dowRestricted) return dowHit;
  return true;
}

// cron 的下一个时点。按【天】外循环、命中的那天再走 hour × minute —— 纯分钟外循环在
// `0 0 29 2 *`(只在闰年)这种表达式上要走两百多万次,按天走最多 366×5 次。
const SCHEDULER_CRON_DAY_SCAN = 366 * 5;   // 五年扫不到 = 这条 cron 永远不会再触发(如 0 0 30 2 *)
function schedulerCronNextFireAt(schedParsed, schedFromMs) {
  const cursor = new Date(schedFromMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);   // 严格「之后」:同一分钟内不重复触发
  let year = cursor.getFullYear();
  let month = cursor.getMonth();
  let day = cursor.getDate();
  let floorHour = cursor.getHours();
  let floorMinute = cursor.getMinutes();
  for (let scanned = 0; scanned < SCHEDULER_CRON_DAY_SCAN; scanned++) {
    if (schedulerCronDayMatches(schedParsed, year, month, day)) {
      for (const hour of schedParsed.hour) {
        if (hour < floorHour) continue;
        for (const minute of schedParsed.minute) {
          if (hour === floorHour && minute < floorMinute) continue;
          const candidate = schedulerLocalMs(year, month, day, hour, minute);
          if (candidate > schedFromMs) return candidate;
        }
      }
    }
    const nextDay = new Date(year, month, day + 1, 0, 0, 0, 0);
    year = nextDay.getFullYear(); month = nextDay.getMonth(); day = nextDay.getDate();
    floorHour = 0; floorMinute = 0;
  }
  return null;
}

// ── nextFireAt:下一个【严格晚于 fromMs】的触发时刻(epoch ms);永不再触发时返回 null ──────────
// 五种计划共用一个出口。非法计划(时间格式坏、once 的日期不存在、weekly 没给 days …)一律 null ——
// 归一化已经把这些挡在建任务那一步,这里的 null 是第二道网,不是给用户看的错误。
function nextFireAt(schedPlanRaw, schedFromMs) {
  const plan = (schedPlanRaw && typeof schedPlanRaw === 'object' && !Array.isArray(schedPlanRaw)) ? schedPlanRaw : null;
  const from = Number(schedFromMs);
  if (!plan || !Number.isFinite(from)) return null;
  const kind = String(plan.kind || '');
  if (kind === 'cron') {
    const parsed = parseCronExpr(plan.expr);
    return parsed.ok ? schedulerCronNextFireAt(parsed, from) : null;
  }
  const time = schedulerParseHhMm(plan.at);
  if (!time) return null;
  const base = new Date(from);
  if (kind === 'once') {
    const date = schedulerParseYmd(plan.date);
    if (!date) return null;
    const ms = schedulerLocalMs(date.year, date.month, date.day, time.hour, time.minute);
    return ms > from ? ms : null;      // 过期的 once 不再触发(37 号文 §3.1)
  }
  if (kind === 'daily') {
    // 走三天而不是两天:秋季重复的那一小时里,「今天那一刻」可能仍 <= from,得让位给明天。
    for (let offset = 0; offset <= 2; offset++) {
      const ms = schedulerLocalMs(base.getFullYear(), base.getMonth(), base.getDate() + offset, time.hour, time.minute);
      if (ms > from) return ms;
    }
    return null;
  }
  if (kind === 'weekly') {
    const days = Array.isArray(plan.days)
      ? [...new Set(plan.days.map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 6))]
      : [];
    if (!days.length) return null;
    for (let offset = 0; offset <= 8; offset++) {
      const probe = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, 0, 0, 0, 0);
      if (!days.includes(probe.getDay())) continue;
      const ms = schedulerLocalMs(probe.getFullYear(), probe.getMonth(), probe.getDate(), time.hour, time.minute);
      if (ms > from) return ms;
    }
    return null;
  }
  if (kind === 'monthly') {
    const wanted = Number(plan.dayOfMonth);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 31) return null;
    let year = base.getFullYear();
    let month = base.getMonth();
    for (let offset = 0; offset <= 24; offset++) {
      // **月末钳位**(37 号文 §3.1):31 号在 2 月是 28/29、在 4 月是 30。钳位不是回退到上个月,
      // 也不是溢出到下个月 1 号 —— new Date(y, 1, 31) 会悄悄变成 3 月 3 日,那正是要避开的坑。
      const day = Math.min(wanted, schedulerDaysInMonth(year, month));
      const ms = schedulerLocalMs(year, month, day, time.hour, time.minute);
      if (ms > from) return ms;
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    return null;
  }
  return null;
}

// ── occurrenceKey / missedOccurrence ─────────────────────────────────────────────────────────
// 一次「应该发生的触发」的稳定身份(37 号文 §3.1):taskId@dueIso。
// 重试引用同一 occurrence(executionGeneration 递增),「再跑一次」是新 occurrence(manual)。
function occurrenceKey(schedTaskId, schedDueMs) {
  const ms = Number(schedDueMs);
  const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  return String(schedTaskId == null ? '' : schedTaskId) + '@' + iso;
}

// 启动恢复用:这条任务有没有一个「本该触发但没跑成」的时点,以及它在不在宽限里。
// 事实源是任务自己的 state.nextFireAt —— 它在每次触发收尾时被重算,所以「它 <= 现在」就等价于
// 「那一刻没人来触发」。回 null = 没错过。
//   · withinGrace —— 距今是否 <= policy.graceMinutes;
//   · runLate     —— withinGrace 且 onMissed === 'run-once-late'(= 该补跑一次,只补一次)。
function missedOccurrence(schedTaskRaw, schedNowMs) {
  const task = (schedTaskRaw && typeof schedTaskRaw === 'object' && !Array.isArray(schedTaskRaw)) ? schedTaskRaw : null;
  const now = Number(schedNowMs);
  if (!task || !Number.isFinite(now)) return null;
  const state = (task.state && typeof task.state === 'object') ? task.state : {};
  const dueMs = Date.parse(String(state.nextFireAt || ''));
  if (!Number.isFinite(dueMs) || dueMs > now) return null;
  const policy = (task.policy && typeof task.policy === 'object') ? task.policy : SCHEDULER_DEFAULT_POLICY;
  const graceRaw = Number(policy.graceMinutes);
  const graceMinutes = Number.isFinite(graceRaw) ? graceRaw : SCHEDULER_DEFAULT_POLICY.graceMinutes;
  const withinGrace = (now - dueMs) <= graceMinutes * 60000;
  return {
    dueMs,
    occurrenceKey: occurrenceKey(task.id, dueMs),
    lateByMs: now - dueMs,
    graceMinutes,
    withinGrace,
    runLate: withinGrace && String(policy.onMissed || '') === 'run-once-late',
    mode: 'late',
  };
}

// ── describeSchedule:结构化计划 → 【i18n 键 + 参数】(29 号文 §3;UI 与管家回读确认共用)──────
// 纯函数【只】返回键与参数,文案住 locale 文件(M2 §3.6 补四份)。locale 入参只是回显 ——
// 键不随语言变,把它带在返回值里是为了让调用方一眼看出「这份描述是给谁看的」。
const SCHEDULER_DESCRIBE_KEYS = Object.freeze([
  'scheduler.describe.once',
  'scheduler.describe.daily',
  'scheduler.describe.weekly',
  'scheduler.describe.weekly.weekdays',
  'scheduler.describe.weekly.weekend',
  'scheduler.describe.monthly',
  'scheduler.describe.monthly.lastDay',
  'scheduler.describe.cron',
  'scheduler.describe.invalid',
]);
const SCHEDULER_DOW_KEYS = Object.freeze([
  'scheduler.dow.0', 'scheduler.dow.1', 'scheduler.dow.2', 'scheduler.dow.3',
  'scheduler.dow.4', 'scheduler.dow.5', 'scheduler.dow.6',
]);
function describeSchedule(schedPlanRaw, schedLocaleRaw) {
  const locale = String(schedLocaleRaw || '') === 'en' ? 'en' : 'zh';
  const plan = (schedPlanRaw && typeof schedPlanRaw === 'object' && !Array.isArray(schedPlanRaw)) ? schedPlanRaw : null;
  const invalid = { key: 'scheduler.describe.invalid', params: {}, locale };
  if (!plan) return invalid;
  const kind = String(plan.kind || '');
  if (kind === 'cron') {
    const parsed = parseCronExpr(plan.expr);
    return parsed.ok ? { key: 'scheduler.describe.cron', params: { expr: parsed.expr }, locale } : invalid;
  }
  const time = schedulerParseHhMm(plan.at);
  if (!time) return invalid;
  const at = schedulerCleanLine(plan.at, 8);
  if (kind === 'once') {
    const date = schedulerParseYmd(plan.date);
    if (!date) return invalid;
    return {
      key: 'scheduler.describe.once',
      params: { year: date.year, month: date.month + 1, day: date.day, time: at },
      locale,
    };
  }
  if (kind === 'daily') return { key: 'scheduler.describe.daily', params: { time: at }, locale };
  if (kind === 'weekly') {
    const days = Array.isArray(plan.days)
      ? [...new Set(plan.days.map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b)
      : [];
    if (!days.length) return invalid;
    const asText = days.join(',');
    if (asText === '1,2,3,4,5') return { key: 'scheduler.describe.weekly.weekdays', params: { time: at }, locale };
    if (asText === '0,6') return { key: 'scheduler.describe.weekly.weekend', params: { time: at }, locale };
    return {
      key: 'scheduler.describe.weekly',
      params: { days, dayKeys: days.map(value => SCHEDULER_DOW_KEYS[value]), time: at },
      locale,
    };
  }
  if (kind === 'monthly') {
    const wanted = Number(plan.dayOfMonth);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 31) return invalid;
    // 31 号 = 「每月最后一天」:钳位语义下它在 2 月就是 28/29、4 月就是 30,回读时必须说人话,
    // 不能印一句「每月 31 日」然后在 2 月 28 日触发(那是回读与行为不一致)。
    if (wanted === 31) return { key: 'scheduler.describe.monthly.lastDay', params: { time: at }, locale };
    return { key: 'scheduler.describe.monthly', params: { day: wanted, time: at }, locale };
  }
  return invalid;
}

// ── normalizeSchedulerTask:把外面递进来的一坨洗成 29 号文 §3 的形状 ──────────────────────────
// 失败一律返回 { ok:false, code, message }(稳定信封,API 直接透出);成功返回 { ok:true, task }。
// 深扫禁止键。数组也要进(载荷里塞一个 [{env:{}}] 一样是绕过)。深度上限 8 防自引用/畸形深树。
function schedulerFindForbiddenKey(schedValue, schedDepth) {
  const depth = Number(schedDepth) || 0;
  if (depth > 8 || !schedValue || typeof schedValue !== 'object') return '';
  if (Array.isArray(schedValue)) {
    for (const item of schedValue) {
      const hit = schedulerFindForbiddenKey(item, depth + 1);
      if (hit) return hit;
    }
    return '';
  }
  for (const key of Object.keys(schedValue)) {
    if (SCHEDULER_FORBIDDEN_PAYLOAD_KEYS.includes(key)) return key;
    const hit = schedulerFindForbiddenKey(schedValue[key], depth + 1);
    if (hit) return hit;
  }
  return '';
}
function schedulerClampInt(schedValueRaw, schedLo, schedHi, schedFallback) {
  const value = Number(schedValueRaw);
  return Number.isFinite(value) ? Math.min(schedHi, Math.max(schedLo, Math.round(value))) : schedFallback;
}
function schedulerFail(schedCode, schedMessage) {
  return { ok: false, code: String(schedCode), message: String(schedMessage) };
}

function normalizeSchedulerTask(schedRawTask, schedNowMs) {
  const raw = (schedRawTask && typeof schedRawTask === 'object' && !Array.isArray(schedRawTask)) ? schedRawTask : null;
  if (!raw) return schedulerFail('invalid_request', 'task must be an object');
  const now = Number.isFinite(Number(schedNowMs)) ? Number(schedNowMs) : 0;
  const nowIsoText = new Date(now).toISOString();

  const title = schedulerCleanLine(raw.title, SCHEDULER_LIMITS.titleChars);
  if (!title) return schedulerFail('invalid_request', 'title is required');

  // ① 计划
  const rawSchedule = (raw.schedule && typeof raw.schedule === 'object' && !Array.isArray(raw.schedule)) ? raw.schedule : null;
  if (!rawSchedule) return schedulerFail('invalid_request', 'schedule is required');
  const kind = String(rawSchedule.kind || '');
  if (!SCHEDULER_SCHEDULE_KINDS.includes(kind)) {
    return schedulerFail('invalid_request', 'schedule.kind must be one of ' + SCHEDULER_SCHEDULE_KINDS.join('/'));
  }
  const schedule = { kind };
  if (kind === 'cron') {
    const parsed = parseCronExpr(rawSchedule.expr);
    if (!parsed.ok) return schedulerFail('invalid_request', parsed.error);
    schedule.expr = parsed.expr;
  } else {
    const time = schedulerParseHhMm(rawSchedule.at);
    if (!time) return schedulerFail('invalid_request', 'schedule.at must be HH:MM (24h, local wall clock)');
    schedule.at = schedulerCleanLine(rawSchedule.at, 8);
    if (kind === 'once') {
      const date = schedulerParseYmd(rawSchedule.date);
      if (!date) return schedulerFail('invalid_request', 'schedule.date must be an existing calendar day YYYY-MM-DD');
      schedule.date = schedulerCleanLine(rawSchedule.date, 12);
    }
    if (kind === 'weekly') {
      const days = Array.isArray(rawSchedule.days)
        ? [...new Set(rawSchedule.days.map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 6))].sort((a, b) => a - b)
        : [];
      if (!days.length) return schedulerFail('invalid_request', 'schedule.days must hold at least one weekday (0=Sunday..6=Saturday)');
      schedule.days = days;
    }
    if (kind === 'monthly') {
      const wanted = Number(rawSchedule.dayOfMonth);
      if (!Number.isInteger(wanted) || wanted < 1 || wanted > 31) {
        return schedulerFail('invalid_request', 'schedule.dayOfMonth must be an integer in [1,31] (31 = last day of every month)');
      }
      schedule.dayOfMonth = wanted;
    }
  }
  // 时区字段只记「系统本地」这一个事实(29 号文 §3 的 tz 列);不接受用户指定别的时区(非目标)。
  schedule.tz = 'local';

  // ② 载荷
  const rawPayload = (raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)) ? raw.payload : null;
  if (!rawPayload) return schedulerFail('invalid_request', 'payload is required');
  const payloadKind = String(rawPayload.kind || '');
  if (!SCHEDULER_PAYLOAD_KINDS.includes(payloadKind)) {
    return schedulerFail('invalid_request', 'payload.kind must be one of ' + SCHEDULER_PAYLOAD_KINDS.join('/') + ' (playbook/workflow land in wave 127)');
  }
  const forbidden = schedulerFindForbiddenKey(rawPayload, 0);
  if (forbidden) {
    return schedulerFail('payload_forbidden_key',
      'payload must not carry ' + forbidden + ' (29 号文 §10:本地命令/密钥/环境变量/数据目录一律不进任务载荷)');
  }
  // 同上:局部名不能叫 text(纪律 12)。
  const payloadText = schedulerCleanBlock(rawPayload.text, SCHEDULER_LIMITS.textChars);
  if (!payloadText) return schedulerFail('invalid_request', 'payload.text is required');
  const payload = { kind: payloadKind, text: payloadText };
  // sourceRef:安静卡「稍后」建的那条 once reminder 用它指回收件箱行(M2 §3.5)。只留三个标量键。
  const rawSourceRef = (rawPayload.sourceRef && typeof rawPayload.sourceRef === 'object' && !Array.isArray(rawPayload.sourceRef)) ? rawPayload.sourceRef : null;
  if (rawSourceRef) {
    const inboxSeq = Number(rawSourceRef.inboxSeq);
    payload.sourceRef = {
      inboxSeq: Number.isSafeInteger(inboxSeq) && inboxSeq > 0 ? inboxSeq : 0,
      sessionId: schedulerCleanLine(rawSourceRef.sessionId, 64),
      kind: schedulerCleanLine(rawSourceRef.kind, 32),
    };
  }

  // ③ 目标。**本刀不接受 cwd / engineRoute**:cwd 在禁止键表里(绕过工作区表的唯一入口),
  // engineRoute 留给 127 波。新线程的工作目录由 createSession 的既有回落决定(defaultWorkspace)。
  const rawTarget = (raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target)) ? raw.target : {};
  const targetForbidden = schedulerFindForbiddenKey(rawTarget, 0);
  if (targetForbidden) {
    return schedulerFail('payload_forbidden_key', 'target must not carry ' + targetForbidden);
  }
  const targetMode = SCHEDULER_TARGET_MODES.includes(String(rawTarget.mode || '')) ? String(rawTarget.mode) : 'new-session';
  const target = { mode: targetMode };
  if (targetMode === 'existing-session') {
    const sessionId = schedulerCleanLine(rawTarget.sessionId, 64);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
      return schedulerFail('invalid_request', 'target.sessionId is required when target.mode is existing-session');
    }
    target.sessionId = sessionId;
  }
  // reminder 不起回合,目标无意义 —— 归一成 new-session 但永远不会被用到(13s 的 reminder 分支不看它)。

  // ④ 自治。天花板 = 全局档去掉 bypass;越界(含显式 bypass)一律回落 '' = 「跟随全局默认档」,
  //    真正的白名单判定在 13s(它读得到 config)。29 号文 §10:任务级授权永不含 bypass。
  const rawAutonomy = (raw.autonomy && typeof raw.autonomy === 'object' && !Array.isArray(raw.autonomy)) ? raw.autonomy : {};
  const wantedMode = schedulerCleanLine(rawAutonomy.permissionMode, 32);
  const permissionMode = (wantedMode && wantedMode !== 'bypass' && wantedMode !== 'bypassPermissions') ? wantedMode : '';
  const autonomy = { permissionMode };

  // ⑤ 策略
  const rawPolicy = (raw.policy && typeof raw.policy === 'object' && !Array.isArray(raw.policy)) ? raw.policy : {};
  const policy = {
    onMissed: SCHEDULER_ON_MISSED.includes(String(rawPolicy.onMissed || '')) ? String(rawPolicy.onMissed) : SCHEDULER_DEFAULT_POLICY.onMissed,
    graceMinutes: schedulerClampInt(rawPolicy.graceMinutes, SCHEDULER_LIMITS.graceMinutesMin, SCHEDULER_LIMITS.graceMinutesMax, SCHEDULER_DEFAULT_POLICY.graceMinutes),
    maxRunsPerDay: schedulerClampInt(rawPolicy.maxRunsPerDay, SCHEDULER_LIMITS.maxRunsPerDayMin, SCHEDULER_LIMITS.maxRunsPerDayMax, SCHEDULER_DEFAULT_POLICY.maxRunsPerDay),
    timeoutMinutes: schedulerClampInt(rawPolicy.timeoutMinutes, SCHEDULER_LIMITS.timeoutMinutesMin, SCHEDULER_LIMITS.timeoutMinutesMax, SCHEDULER_DEFAULT_POLICY.timeoutMinutes),
    onFailure: SCHEDULER_ON_FAILURE.includes(String(rawPolicy.onFailure || '')) ? String(rawPolicy.onFailure) : SCHEDULER_DEFAULT_POLICY.onFailure,
  };

  // ⑥ 状态。**nextFireAt 在这里现算**:归一化是「洗净 + 定型」的唯一出口,让它同时算下一次,
  //    调用方就不可能落一条「有计划但没有下次」的任务(那条任务会永远不触发,而且看不出来)。
  const rawState = (raw.state && typeof raw.state === 'object' && !Array.isArray(raw.state)) ? raw.state : {};
  const enabled = rawState.enabled !== false;
  const nextMs = nextFireAt(schedule, now);
  const state = {
    enabled,
    lastFiredAt: schedulerCleanLine(rawState.lastFiredAt, 40),
    lastResult: SCHEDULER_OUTCOMES.includes(String(rawState.lastResult || '')) ? String(rawState.lastResult) : '',
    lastMode: SCHEDULER_FIRE_MODES.includes(String(rawState.lastMode || '')) ? String(rawState.lastMode) : '',
    nextFireAt: nextMs == null ? '' : new Date(nextMs).toISOString(),
    inFlightRunId: schedulerCleanLine(rawState.inFlightRunId, 64),
    consecutiveFailures: schedulerClampInt(rawState.consecutiveFailures, 0, 9999, 0),
    runsToday: {
      date: schedulerCleanLine(rawState.runsToday && rawState.runsToday.date, 10),
      count: schedulerClampInt(rawState.runsToday && rawState.runsToday.count, 0, 100000, 0),
    },
  };
  // once 已经过期(算不出 nextFireAt)且这是一条【新】任务 → 拒。改一条老任务时不拒:
  // 它可能只是想改标题,把一条跑完的 once 连带删掉不是用户的意思。
  if (!state.nextFireAt && !String(raw.id || '') && kind === 'once') {
    return schedulerFail('invalid_request', 'schedule.date/at is already in the past');
  }

  const idRaw = String(raw.id || '');
  const task = {
    schema: 1,
    id: /^[A-Za-z0-9_-]{1,64}$/.test(idRaw) ? idRaw : '',   // 空 = 由 13s 用 makeId 补(纯函数不造随机)
    title,
    createdAt: schedulerCleanLine(raw.createdAt, 40) || nowIsoText,
    updatedAt: nowIsoText,
    createdBy: SCHEDULER_CREATORS.includes(String(raw.createdBy || '')) ? String(raw.createdBy) : 'user',
    revision: schedulerClampInt(raw.revision, 0, 1000000000, 0),
    schedule,
    payload,
    target,
    autonomy,
    policy,
    state,
  };
  return { ok: true, task };
}

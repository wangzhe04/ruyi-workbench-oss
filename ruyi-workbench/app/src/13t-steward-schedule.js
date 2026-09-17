// ============================================================================
// 第 123 波 M2 §3.5(37 号文;设计权威 29 号文 §5「载荷」§8「UI」§10「红线」):
// 定时任务的【管家面】—— 六个 steward_schedule_* 工具、reminder 出箱的两个回调实现、
// 「回来摘要」的承诺三项读口。
//
// 落点(transport 层,manifest 中位于 13s-scheduler.js 之后、14-main.js 之前;文件名按
// ENGINEERING-SPEC §1 的 ^13[a-z]?- 正则)。
//
// **为什么另起一个文件,而不是把这些塞进 13g / 13s**(派单原稿写的是「handler 表进 13g」):
//   · 六个工具要动的是调度器的账(建/改/删/立刻跑),那些原语住 13s;而 13g 在 manifest 里排在
//     13s 【之前】—— 在 13g 里直接写 schedulerSaveTasks 是一条【前向边】,而且 13s 已经因为
//     13->13s 那条前向边进了既有的唯一大 SCC,于是它连带会变成一批新【环边】,要在
//     module-dependency-policy.json 里逐条登记。
//   · 反过来把工具实现塞进 13s,则 13s 要引用 13j 的 stewardFail、13k 的 stewardUnattendedByModel、
//     13i 的收件箱写口 —— 同样全是「13s 反过来指回管家族」的新环边。
//   · 本文件排在【所有】它要用的模块之后(06i/06j/13g/13i/13j/13k/13s 全在前面),因此它对外的
//     每一条引用都是后向边;而它自己【零入边】(消费者 12-tool-dispatch 与 13q 都只看
//     StewardHooks / SchedulerHooks 两个延迟绑定命名空间),所以它不可能进任何环。
//     这正是 13i/13j/13k/13l/13m–13q 一路拆出来时用的同一个模具。
//   · 门控壳仍然是 13g 的 stewardToolHandler(开关 -> 身份 -> 实现 -> 异常兜底),一个字没改 ——
//     派单要的是「六工具沿同一道门」,这条满足了;变的只是那六行注册写在哪个文件里
//     (13h-steward-runner.js 早有先例:thread_prioritize / thread_stop 两个工具的注册就不在 13g)。
//
// 三条红线(29 号文 §10,本文件这一半):
//   ① `stewardUnattendedByModel(ctx)` 为真(收件箱触发、模型自己决定)时 create / delete 只回
//      propose_required —— 无人值守时不许模型自己给用户排/删日程。写法逐字沿 13k 的
//      steward_thread_new 那一段。
//   ② 载荷禁止键、200 条上限、bypass 回落全部走 06j 的 normalizeSchedulerTask(与六条 API 同一份
//      判据,不在这里另写一遍)。
//   ③ 收件箱写口在 stewardEnabledV1 !== true 时【一个字节都不写】(收件箱是管家的账面;
//      steward-tools.e2e A2 钉着「关着时 <data>/steward 目录不存在」)。
// ============================================================================

// ── 工具面:六条共用的前置(开关 -> 装载)。返回稳定信封 = 已经答完,调用方直接 return。─────────
function schedulerToolGate(schedConfig) {
  if (!schedulerEnabled(schedConfig)) {
    return stewardFail('scheduler.disabled',
      '定时任务功能没有打开(schedulerEnabledV1);这件事要用户在设置里先打开,不要重试');
  }
  return null;
}

// 工具面回给模型的一行。**不是** schedulerPublicTask 那一份:那份是给界面的全量(含 policy /
// state / payload 正文),进模型上下文纯属浪费。这里只留模型说人话需要的六个字段。
function schedulerToolRow(schedTask) {
  const described = describeSchedule(schedTask.schedule, 'zh');
  return {
    id: schedTask.id,
    title: schedTask.title,
    enabled: schedTask.state.enabled,
    nextRunAt: schedTask.state.nextFireAt,
    payloadKind: schedTask.payload.kind,
    lastResult: schedTask.state.lastResult,
    lastMode: schedTask.state.lastMode,
    describeKey: described.key,
    describeParams: described.params,
  };
}

function schedulerToolFind(schedId) {
  const id = String(schedId || '');
  const index = schedulerRuntime.tasks.findIndex(task => task.id === id);
  return { id, index, task: index < 0 ? null : schedulerRuntime.tasks[index] };
}

// 1) steward_schedule_create —— 下单。回读确认是【对话里的事】(见 13f 的 description),
//    工具本身只在无人值守时挡一道。
async function stewardImplScheduleCreate(args, ctx, config) {
  const gate = schedulerToolGate(config); if (gate) return gate;
  if (stewardUnattendedByModel(ctx)) {
    return stewardFail('propose_required',
      '无人值守时不能替用户排新的定时任务;把它作为一条提议交给用户,不要重试', {
        reason: 'unattended', tool: 'steward_schedule_create',
      });
  }
  await schedulerLoad();
  if (schedulerRuntime.tasks.length >= SCHEDULER_LIMITS.maxTasks) {
    return stewardFail('scheduler.capacity_exceeded',
      `定时任务最多 ${SCHEDULER_LIMITS.maxTasks} 条,先删掉几条再来`, { max: SCHEDULER_LIMITS.maxTasks });
  }
  // 127 波 2-ter S-a:tier 是与 permissionMode 平级的顶层入参(与 steward_thread_new 同一个参数名、同一个
  // 枚举),落进 target.tier —— 值域与「只在 prompt + new-session 时留下」由 06j 判。args.target 里自带的
  // tier 也认(顶层给了就以顶层为准)。workdir 不在这张逐字段清单里:服务端自有字段,模型写不进来。
  const rawTarget = (args.target && typeof args.target === 'object' && !Array.isArray(args.target)) ? args.target : null;
  const target = args.tier !== undefined ? { ...(rawTarget || {}), tier: args.tier } : args.target;
  const normalized = normalizeSchedulerTask({
    title: args.title,
    schedule: args.schedule,
    payload: args.payload,
    target,
    autonomy: { permissionMode: args.permissionMode },
    createdBy: 'steward',
    id: '',
    revision: 0,
  }, schedulerClockNow());
  if (!normalized.ok) return stewardFail(normalized.code, normalized.message);
  normalized.task.id = makeId('sch');
  schedulerRuntime.tasks.push(normalized.task);
  await schedulerSaveTasks();
  schedulerEnsureTimer();
  schedulerEmitChanged(normalized.task.id, 'created', '');
  const row = schedulerToolRow(normalized.task);
  const tier = String(normalized.task.target.tier || '');
  stewardAppendDecision({
    tool: 'steward_schedule_create',
    args: { id: row.id, title: row.title, scheduleKind: normalized.task.schedule.kind, payloadKind: row.payloadKind, ...(tier ? { tier } : {}) },
    targetSessionId: '', permissionMode: String(normalized.task.autonomy.permissionMode || ''), mayAct: 'user',
    undoRef: { kind: 'schedule', id: row.id, prev: null },
    basis: (args.basis && typeof args.basis === 'object') ? args.basis : {},
  });
  return { ok: true, task: row, describeKey: row.describeKey, describeParams: row.describeParams, ...(tier ? { tier } : {}) };
}

// 2) steward_schedule_list —— 只读。不进决策日志(读工具没有「做过什么」可记)。
async function stewardImplScheduleList(args, ctx, config) {
  const gate = schedulerToolGate(config); if (gate) return gate;
  await schedulerLoad();
  return { ok: true, tasks: schedulerRuntime.tasks.map(schedulerToolRow) };
}

// 3)/4) pause / resume —— 同一段实现两个方向。收紧(暂停)与放开(继续)都不越过用户的任何边界:
//       任务本来就是用户自己下的单,开关它不改载荷、不改权限档,所以无人值守时也可以做。
async function schedulerToolSetEnabled(args, ctx, config, wantEnabled, toolName) {
  const gate = schedulerToolGate(config); if (gate) return gate;
  await schedulerLoad();
  const found = schedulerToolFind(args.id);
  if (!found.task) return stewardFail('not_found', `没有 id 为 ${stewardSanitizeText(found.id)} 的定时任务`);
  const task = found.task;
  const was = task.state.enabled === true;
  task.state.enabled = wantEnabled;
  // 从熔断里被重新打开:连败计数清零(与 PATCH /api/scheduler/tasks/:id 同口径 —— 不清零的话
  // 下一次失败会立刻再熔断,用户会以为「继续」这枚按钮没生效)。
  if (wantEnabled && !was) task.state.consecutiveFailures = 0;
  task.revision = (Number(task.revision) || 0) + 1;
  task.updatedAt = new Date(schedulerClockNow()).toISOString();
  await schedulerSaveTasks();
  schedulerEnsureTimer();
  schedulerEmitChanged(task.id, 'updated', '');
  stewardAppendDecision({
    tool: toolName, args: { id: task.id, enabled: wantEnabled },
    targetSessionId: '', permissionMode: '', mayAct: 'user',
    undoRef: { kind: 'schedule', id: task.id, prev: { enabled: was } },
    basis: (args.basis && typeof args.basis === 'object') ? args.basis : {},
  });
  return { ok: true, task: schedulerToolRow(task) };
}
async function stewardImplSchedulePause(args, ctx, config) {
  return schedulerToolSetEnabled(args, ctx, config, false, 'steward_schedule_pause');
}
async function stewardImplScheduleResume(args, ctx, config) {
  return schedulerToolSetEnabled(args, ctx, config, true, 'steward_schedule_resume');
}

// 5) steward_schedule_run_now —— 「再跑一次」。与 POST /api/scheduler/tasks/:id/run-now 同一条路:
//    全局并发 1 的两道闸(任务自己在途 / 调度器正在 tick)、新 occurrence(mode:'manual')、
//    同毫秒撞 key 时往后挪一格(假时钟下时钟是钉死的,必走这段循环)。
async function stewardImplScheduleRunNow(args, ctx, config) {
  const gate = schedulerToolGate(config); if (gate) return gate;
  await schedulerLoad();
  const found = schedulerToolFind(args.id);
  if (!found.task) return stewardFail('not_found', `没有 id 为 ${stewardSanitizeText(found.id)} 的定时任务`);
  const task = found.task;
  if (task.state.inFlightRunId) {
    return stewardFail('steward.busy', '这条定时任务正在跑,等它跑完再说(不要重试)', { id: task.id });
  }
  if (schedulerRuntime.ticking) {
    return stewardFail('steward.busy', '调度器正在跑另一条任务(全局并发 1),等一会儿再说(不要重试)', { id: task.id });
  }
  let manualDueMs = schedulerClockNow();
  while (schedulerRuntime.attempts.has(occurrenceKey(task.id, manualDueMs))) manualDueMs += 1;
  schedulerRuntime.ticking = true;
  let outcome = '';
  try { outcome = await schedulerFireOnce(task, 'manual', manualDueMs); }
  finally { schedulerRuntime.ticking = false; }
  stewardAppendDecision({
    tool: 'steward_schedule_run_now', args: { id: task.id, outcome },
    targetSessionId: '', permissionMode: '', mayAct: 'user',
    undoRef: null,
    basis: (args.basis && typeof args.basis === 'object') ? args.basis : {},
  });
  return { ok: true, outcome, task: schedulerToolRow(task) };
}

// 6) steward_schedule_delete —— 删【定义】,不删历史回执(fires-v1.ndjson 一个字节不动)。
async function stewardImplScheduleDelete(args, ctx, config) {
  const gate = schedulerToolGate(config); if (gate) return gate;
  if (stewardUnattendedByModel(ctx)) {
    return stewardFail('propose_required',
      '无人值守时不能替用户删定时任务;把它作为一条提议交给用户,不要重试', {
        reason: 'unattended', tool: 'steward_schedule_delete',
      });
  }
  await schedulerLoad();
  const found = schedulerToolFind(args.id);
  if (!found.task) return stewardFail('not_found', `没有 id 为 ${stewardSanitizeText(found.id)} 的定时任务`);
  const removed = schedulerToolRow(found.task);
  schedulerRuntime.tasks.splice(found.index, 1);
  await schedulerSaveTasks();
  schedulerEnsureTimer();
  schedulerEmitChanged(removed.id, 'deleted', '');
  stewardAppendDecision({
    tool: 'steward_schedule_delete', args: { id: removed.id, title: removed.title },
    targetSessionId: '', permissionMode: '', mayAct: 'user',
    undoRef: { kind: 'schedule', id: removed.id, prev: { title: removed.title } },
    basis: (args.basis && typeof args.basis === 'object') ? args.basis : {},
  });
  return { ok: true, id: removed.id, deleted: true, task: removed };
}

// ────────────────────────────────────────────────────────────────────────────
// 收件箱 reminder 出箱(§3.5)。06j 的 SchedulerHooks 两个口在这里填充。
//
// 三件事都走【同一个新类 reminder】(06i STEWARD_EVENT_KINDS 第七类):到点提醒、错过跳过、
// 连败熔断。共同点是「一句事实,不需要回答」—— 与 needs_you(问句)分开,才不会把「你该交周报了」
// 混进「N 条线程在等你拿主意」那一行。
// prompt 载荷的 done/failed/needs_you 【不】走这里:13s 已经把 launchedBy:'steward' 写在会话头上,
// 13i 的第四源照常自动收(那条路一个字没改)。
// ────────────────────────────────────────────────────────────────────────────
const SCHEDULER_INBOX_KIND = 'reminder';
const SCHEDULER_INBOX_TEXT_MAX = 200;

// 收件箱是管家的账面:管家关着时一个字节都不写(steward-tools.e2e A2 钉着这条)。
async function schedulerInboxAppend(schedRow) {
  const config = await readConfig().catch(() => null);
  if (!config || config.stewardEnabledV1 !== true) return null;
  await stewardLoadState();
  stewardRuntime.inboxSeq += 1;
  const row = {
    inboxSeq: stewardRuntime.inboxSeq,
    kind: SCHEDULER_INBOX_KIND,
    sessionId: String(schedRow.sessionId || ''),
    missionId: String(schedRow.sessionId || ''),
    runId: '',
    // 去重位 = occurrenceKey:同一个应触发时点无论重放多少次都只有一行,而「再跑一次」是新
    // occurrence(13s 的 manual 分支已经把它挪到一个没用过的毫秒上),所以它是两行。
    seq: String(schedRow.occurrenceKey || ''),
    at: schedRow.at || nowIso(),
    payload: schedRow.payload,
    count: 1,
  };
  await stewardAppendInboxRows([row]);
  for (const key of stewardInboxRowDedupeKeys(row)) stewardRuntime.seen.add(key);
  stewardRuntime.lastInboxAt = nowIso();
  return row;
}

// reminder 到点。payload.quiet:true —— 提醒【就是】要打扰用户那一下(用户自己下的单);
// 安静卡的渲染层规则(只在工作台视角、静默时段不出)仍由前端各判一次,服务端不越俎。
async function schedulerOnReminderDue(schedRow) {
  const raw = (schedRow && typeof schedRow === 'object') ? schedRow : {};
  const sourceRef = (raw.sourceRef && typeof raw.sourceRef === 'object') ? raw.sourceRef : null;
  // 正文由下单方写死:安静卡「稍后」建的那条把「来自你 N 分钟前按的『稍后』」整句写进 payload.text
  // (i18n 在客户端做,服务端不拼第二份文案)。这里只清洗与截断。
  const text = stewardClipSummary(stewardSanitizeText(raw.text || '')).slice(0, SCHEDULER_INBOX_TEXT_MAX);
  const title = stewardSanitizeText(raw.title || '').slice(0, 120);
  const summary = text || title;
  return schedulerInboxAppend({
    sessionId: sourceRef ? sourceRef.sessionId : '',
    occurrenceKey: raw.occurrenceKey,
    at: stewardIsoAt(raw.firedAt),
    payload: {
      source: 'scheduler',
      notice: 'due',
      taskId: String(raw.taskId || ''),
      title,
      mode: String(raw.mode || ''),
      quiet: true,
      ...(sourceRef ? { snoozedFrom: { inboxSeq: Number(sourceRef.inboxSeq) || 0, kind: String(sourceRef.kind || '') } } : {}),
      ask: summary,
      summary,
    },
  });
}

// 三种「要让用户知道、但不是到点提醒」的事。文案在服务端拼成一句事实(与 13i 既有的
// stewardNormalizeThreadAdopted / stewardNormalizeBudgetExhausted 同一条纪律:收件箱行的
// summary 是构造好的短句,不是工具输出原文)。
const SCHEDULER_NOTICE_TEXT = Object.freeze({
  skipped: title => `定时任务《${title}》错过了这一次,已经跳过`,
  tripped: title => `定时任务《${title}》连着失败三次,已经自动停用`,
  needs_you: title => `定时任务《${title}》要你批准之后才跑得下去`,
  unknown: title => `定时任务《${title}》上一次的结果不明(如意当时被关掉了),先核对一下`,
});
async function schedulerOnSchedulerNotice(schedRow) {
  const raw = (schedRow && typeof schedRow === 'object') ? schedRow : {};
  const kind = String(raw.kind || '');
  const make = SCHEDULER_NOTICE_TEXT[kind];
  if (!make) return null;
  const title = stewardSanitizeText(raw.title || '').slice(0, 60) || '(未命名)';
  const summary = stewardClipSummary(make(title));
  return schedulerInboxAppend({
    sessionId: String(raw.sessionId || ''),
    // needs_you 与 tripped 可以在同一个 occurrence 上先后发生,加上 kind 才不会互相顶掉。
    occurrenceKey: String(raw.occurrenceKey || '') + '#' + kind,
    at: stewardIsoAt(raw.at),
    payload: {
      source: 'scheduler',
      notice: kind,
      taskId: String(raw.taskId || ''),
      title,
      mode: String(raw.mode || ''),
      ...(raw.reason ? { reason: String(raw.reason) } : {}),
      quiet: true,
      ask: summary,
      summary,
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 「回来摘要」的承诺三项(§3.5)。13q 的 stewardVisitDigest 经 SchedulerHooks 调它 ——
// 13q 在 manifest 里排在 13s/13t 【之前】,直接写函数名会是前向边。
//   · upcoming —— 未来 24 小时内将触发的条数(开着且 nextFireAt 落在 [now, now+24h]);
//   · missed   —— 上次到访以来 fires 里 outcome 是 skipped 或 unknown 的次数(「过期或结果未知」);
//   · needsYou —— 此刻 state.lastResult 仍是 needs_you 的任务数(现状计数,不是流水计数:
//                 同一条任务反复 needs_you 只该在摘要里占一条)。
// fireSeq 是水位:调用方把它记在到访状态里,下次只数比它新的行。
// ────────────────────────────────────────────────────────────────────────────
const SCHEDULER_COMMITMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
async function schedulerCommitmentsSince(schedSinceFireSeq, schedNowMs) {
  const empty = { upcoming: 0, missed: 0, needsYou: 0, fireSeq: Math.max(0, Number(schedSinceFireSeq) || 0) };
  const config = await readConfig().catch(() => null);
  if (!schedulerEnabled(config)) return empty;
  await schedulerLoad();
  const now = Number.isFinite(Number(schedNowMs)) ? Number(schedNowMs) : schedulerClockNow();
  let upcoming = 0;
  let needsYou = 0;
  for (const task of schedulerRuntime.tasks) {
    if (task.state.lastResult === 'needs_you') needsYou += 1;
    if (!task.state.enabled) continue;
    const due = Date.parse(String(task.state.nextFireAt || ''));
    if (Number.isFinite(due) && due >= now && due <= now + SCHEDULER_COMMITMENT_WINDOW_MS) upcoming += 1;
  }
  const since = Math.max(0, Number(schedSinceFireSeq) || 0);
  let missed = 0;
  let fireSeq = since;
  for (const row of await schedulerReadFireRows()) {
    const seq = Number(row.seq) || 0;
    if (seq > fireSeq) fireSeq = seq;
    if (seq <= since) continue;
    if (String(row.phase) !== 'reconciled') continue;
    const outcome = String(row.outcome || '');
    if (outcome === 'skipped' || outcome === 'unknown') missed += 1;
  }
  return { upcoming, missed, needsYou, fireSeq };
}

// ────────────────────────────────────────────────────────────────────────────
// 127 波 2-ter(45 号文 §2-ter,以 §2-quinquies 的改判为准):定时任务开线程时的两件事 ——
// SchedulerHooks.prepareThread 的实现。13s 在 createSession 之后、saveSession 之前调它(契约见 06j 头注),
// 本函数只改内存里的 session 与 task 两份对象,落盘由 13s 接着做。
//
// S-a 档位:task.target.tier 非空才动 —— 经 StewardHooks.applyThreadTier(= 13q stewardApplyThreadTier,
//   steward_thread_new 用的【同一个】函数:那一档没配 → 不写 engineRoute、跟随全局;配了但端点已删 → 同样
//   回落并记 steward_thread_model_fallback)。**空就一个字都不碰**:thread_new 不传 tier 时按 strong 套,
//   这里照抄会让「没选档位的任务」悄悄换引擎,破判据 ③「不传 tier 与今天逐字节等价」。
// S-b 工作文件夹:只在 stewardEnabledV1 === true 时做 —— 同文件夹写锁只在那时存在(10 的回合入口),
//   管家关着时三件调度器 e2e 逐字节不变。
//   · task.workdir 仍在工作区候选表里(stewardValidateCwd,与 thread_new 的 cwd 同一道校验)→ 复用;
//     表里有、磁盘上被人删了 → 原地把这个空文件夹建回来再复用(路径本来就是这里派生、表里授权过的那一个;
//     不建的话线程的工具全在一个不存在的目录里失败);
//   · 否则(首次触发 / 用户把那一行从表里删了)→ 照 thread_new 省略 cwd 的既有行为派生:在 Ruyi 根下按
//     任务标题开文件夹并登记进候选表(stewardDeriveThreadCwd,建目录与登记是一件事),路径记进 task.workdir。
//     **按任务固定,不按次派生**:每日任务第二次触发不会长出 `-2` 目录、也不会再占一行候选表(上限 64 行,
//     与管家线程共用 —— 表满时派生返回空,等锁问题就复发了);
//   · 表满 / 根不可用 / 派生失败 / 意外异常 → session.cwd 保持 createSession 落的 defaultWorkspace,回
//     workdir:'fallback' 让 13s 记一条日志,触发本身照跑。
// 为什么住这里:13s 直调 13k 会把 13k 拉进环;13t → 13k / 06i / 00-boot 都是既有的后向边,零新增边。
// ────────────────────────────────────────────────────────────────────────────
async function schedulerPrepareThread(schedRow) {
  const raw = (schedRow && typeof schedRow === 'object') ? schedRow : {};
  const session = (raw.session && typeof raw.session === 'object') ? raw.session : null;
  const task = (raw.task && typeof raw.task === 'object') ? raw.task : null;
  const config = (raw.config && typeof raw.config === 'object') ? raw.config : {};
  const outcome = { tier: '', workdir: '' };
  if (!session || !task) return outcome;

  // ── S-a ──
  const wantedTier = String((task.target && task.target.tier) || '');
  if (wantedTier) {
    try {
      const applied = StewardHooks.applyThreadTier(session, wantedTier, config);
      outcome.tier = String((applied && applied.tier) || '');
    } catch { /* 套不上 = 跟随全局;不连累下面的文件夹,也不反噬触发 */ }
  }

  // ── S-b ──
  if (config.stewardEnabledV1 !== true) return outcome;
  const fallback = reason => ({ ...outcome, workdir: 'fallback', fallbackReason: reason });
  try {
    const kept = String(task.workdir || '');
    if (kept) {
      const check = stewardValidateCwd(kept, config);
      if (check.ok && check.cwd) {
        await fsp.mkdir(check.cwd, { recursive: true });   // 已存在 = 无操作
        session.cwd = check.cwd;
        return { ...outcome, workdir: 'reused' };
      }
    }
    if (stewardWorkspaceTableFull(config)) return fallback('table_full');
    if (!stewardCanonWorkspacePath(config.stewardWorkspaceRoot)) return fallback('no_root');
    const derived = await stewardDeriveThreadCwd(task.title, session.id, config);
    if (!derived) return fallback('derive_failed');
    session.cwd = derived;
    task.workdir = derived;
    return { ...outcome, workdir: 'derived' };
  } catch {
    return fallback('error');
  }
}

// ── 延迟绑定注册(先例:13g / 13h 各自往 StewardHooks 上填自己那一份)────────────────────────
// 六个工具沿 13g 的 stewardToolHandler 门控壳(开关 -> 身份 -> 实现 -> 异常兜底);12-tool-dispatch
// 的 handler 仍然只写一行 `StewardHooks.<键>(args, ctx)`,与既有 27 个逐字同型。
Object.assign(StewardHooks, {
  scheduleCreate: stewardToolHandler('steward_schedule_create', stewardImplScheduleCreate),
  scheduleList: stewardToolHandler('steward_schedule_list', stewardImplScheduleList),
  schedulePause: stewardToolHandler('steward_schedule_pause', stewardImplSchedulePause),
  scheduleResume: stewardToolHandler('steward_schedule_resume', stewardImplScheduleResume),
  scheduleRunNow: stewardToolHandler('steward_schedule_run_now', stewardImplScheduleRunNow),
  scheduleDelete: stewardToolHandler('steward_schedule_delete', stewardImplScheduleDelete),
});
// 06j 的两个旁路口(M1 只调用、不实现)在这里落地;第三个键是 13q 的承诺三项读口;
// 第四个键是 127 波 2-ter 的开线程前置(档位 + 任务自己的工作文件夹),消费者是 13s 的触发分支。
Object.assign(SchedulerHooks, {
  onReminderDue: schedulerOnReminderDue,
  onSchedulerNotice: schedulerOnSchedulerNotice,
  commitmentsSince: schedulerCommitmentsSince,
  prepareThread: schedulerPrepareThread,
});

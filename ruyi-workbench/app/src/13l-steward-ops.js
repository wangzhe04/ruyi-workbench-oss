// ============================================================================
// 第 117 波 T1(32 号文 §2.1):管家非线程族工具 —— 观察 / 决策 / 记忆 / 设置 / 内容管理。
//
// 落点(transport 层,manifest 中位于 13k-steward-threads.js 之后、13g-steward.js 之前)。
// 收录十六个工具的实现:steward_self_status / runs_status / inbox_read / usage / health /
//   audit_tail / decide / run_action / memory_write / memory_veto / memory_search / missions /
//   config_get / config_set / playbook_draft / skill_toggle。
// 全部函数体自原 13g-steward.js 逐字节搬来,零行为改动;工具门控壳与注册表仍在 13g。
//
// ctx.userPressed 的两处读点(config_set 与 skill_toggle 的「须确认」判定)随实现一起搬到本文件。
// steward-tools.static ⑦ 的出现处白名单已随之重钉:全仓唯一把它置 true 的地方仍只有 13h 的
// POST /api/steward/act 执行路径,读它的代码行仍恰好两处,只是这两处从 13g 挪到了这里。
//
// 依赖纪律(§11.3):本文件只引用拼接顺序在它之前的模块符号(00/01/02/04/05/06/06d/06i/07/08/12/13/
// 13b/13d/13i/13j …),全部后向边;它自己的符号只被 13g 的路由与注册表引用,同样是后向边。
// ============================================================================

// ════════════════════════════════════════════════════════════════════════════
// 观察族(tier read)—— 只读如意自身账面,零副作用,不写任何持久化。
// ════════════════════════════════════════════════════════════════════════════

// 1) steward_self_status —— 复用 108c 的装配函数(12-tool-dispatch 的 buildWorkbenchSelfStatus),
//    再追加一个 steward 段(管家设置掩码 + 收件箱状态)。不新造任何事实源。
const STEWARD_CONFIG_KEYS = Object.freeze([
  'stewardEnabledV1', 'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour',
  'stewardMaxCostPerDay', 'stewardAutoActions', 'stewardContextBudgetTokens', 'stewardReadBudgetChars',
  'stewardVisitIdleMinutes', 'stewardConversationRetention',
]);
async function stewardImplSelfStatus(args, ctx, config) {
  const wantSteward = !args.section || args.section === 'all' || args.section === 'steward';
  // section:'steward' 只要身份 + 管家段(省上下文);其余 section 原样透传给 108c 的装配函数。
  const base = await buildWorkbenchSelfStatus({ section: args.section === 'steward' ? 'identity' : args.section }, ctx);
  if (!wantSteward) return base;
  const stewardConfig = {};
  // 全部是标量/小对象开关,天生不含 apiKey/token;仍按白名单逐键回显,防将来新增敏感键被顺带带出。
  for (const key of STEWARD_CONFIG_KEYS) stewardConfig[key] = config[key];
  return { ...base, steward: { config: stewardConfig, inbox: await stewardInboxState(config) } };
}

// 5) steward_runs_status —— 复用 08 的 listAgentRuns + 13d 的 missionRunDigest(不另造 digest)。
async function stewardImplRunsStatus(args, ctx, config) {
  const explicit = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !explicit) return stewardFail('not_found', 'invalid sessionId');
  let sessionIds = [];
  if (explicit) sessionIds = [explicit];
  else {
    const index = await getPretenderProjectionIndex().catch(() => null);
    sessionIds = ((index && index.sessions) || []).filter(row => row.card).map(row => row.sessionId);
  }
  const runs = [];
  for (const sid of sessionIds) {
    if (runs.length >= STEWARD_RUNS_MAX) break;
    const head = await stewardReadSessionHead(sid);
    if (stewardRawKind(head) === 'steward') continue;
    for (const run of await listAgentRuns(sid).catch(() => [])) {
      if (runs.length >= STEWARD_RUNS_MAX) break;
      const live = activeAgentRuns.get(run.id);
      const mem = live && live.run ? live.run : run;
      const nodes = Array.isArray(mem.nodes) ? mem.nodes : [];
      runs.push({
        sessionId: sid,
        runId: String(run.id || ''),
        status: String(mem.status || ''),
        live: !!live,
        paused: !!(live && live.paused),
        nodes: { total: nodes.length, done: nodes.filter(n => n && n.status === 'done').length, failed: nodes.filter(n => n && n.status === 'failed').length, running: nodes.filter(n => n && (n.status === 'running' || n.status === 'waiting_resource')).length },
        // 等待原因单一化:优先「等你」(池提案待批),其次「等锁」(资源),再次「已暂停」。
        waitReason: (Array.isArray(mem.taskPool) ? mem.taskPool : []).some(p => p && p.status === 'proposed') ? '等你批任务池提案'
          : nodes.some(n => n && n.status === 'waiting_resource') ? '等资源锁'
            : (live && live.paused) ? '已暂停' : '',
        resumeTier: String(mem.resumeTier || ''),
        digest: missionRunDigest(mem, !!live),
      });
    }
  }
  return { ok: true, runs, truncated: runs.length >= STEWARD_RUNS_MAX };
}

// 6) steward_inbox_read —— 直接委托 116b 的原始读取器(同一实现,不复制第二份)。
async function stewardImplInboxRead(args) {
  return { ok: true, ...await stewardInboxRead({ since: args.since, limit: args.limit }) };
}

// 7) steward_usage —— 用量台账按会话/按日汇总;管家自身开销(kind:'aux', note:'steward')单列。
function stewardEmptyUsageBucket() { return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} }; }
function stewardAddUsageRow(bucket, row) {
  bucket.turns += 1;
  bucket.inTok += Number(row.inTok) || 0;
  bucket.outTok += Number(row.outTok) || 0;
  bucket.cachedInTok += Number(row.cachedInTok) || 0;
  const cost = Number(row.cost);
  const currency = typeof row.currency === 'string' ? row.currency : '';
  // costTrusted === false 的行(套餐制的名义金额)不进真实费用合计 —— 与 13e 的 addMissionUsageRow 同口径。
  if (row.costTrusted !== false && currency && Number.isFinite(cost)) {
    bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + cost) * 1e6) / 1e6;
  }
}
async function stewardImplUsage(args) {
  const sessionId = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !sessionId) return stewardFail('not_found', 'invalid sessionId');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args.day || '')) ? String(args.day) : '';
  const rows = await readUsageRows(0).catch(() => []);
  const total = stewardEmptyUsageBucket();
  const steward = stewardEmptyUsageBucket();
  const bySession = new Map();
  const byDay = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (sessionId && String(row.sessionId || '') !== sessionId) continue;
    const rowDay = usageDayKey(Date.parse(row.ts));
    if (day && rowDay !== day) continue;
    stewardAddUsageRow(total, row);
    if (row.kind === 'aux' && row.note === 'steward') stewardAddUsageRow(steward, row);
    const sid = String(row.sessionId || '');
    if (!bySession.has(sid)) bySession.set(sid, stewardEmptyUsageBucket());
    stewardAddUsageRow(bySession.get(sid), row);
    if (!byDay.has(rowDay)) byDay.set(rowDay, stewardEmptyUsageBucket());
    stewardAddUsageRow(byDay.get(rowDay), row);
  }
  const topSessions = [...bySession.entries()]
    .sort((a, b) => (b[1].inTok + b[1].outTok) - (a[1].inTok + a[1].outTok))
    .slice(0, 20)
    .map(([sid, bucket]) => ({ sessionId: sid, ...bucket }));
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31).map(([d, bucket]) => ({ day: d, ...bucket }));
  return { ok: true, scope: { sessionId: sessionId || '', day: day || '' }, total, steward, bySession: topSessions, byDay: days };
}

// 8) steward_health —— computeHealth 的原始项(人话映射留给前端/管家自己说)。
async function stewardImplHealth(args, ctx, config) {
  const { health } = await computeHealth(config);
  return { ok: true, health: (Array.isArray(health) ? health : []).map(h => ({ id: h.id, ok: h.ok, detail: h.detail })) };
}

// 9) steward_audit_tail —— 既有 collectAudit(内部已过 redact 脱敏),只取 workbench 源(桌面 MCP 审计
//    要起桥,管家的「刚才发生了什么」不该为此拉起一个子进程)。
async function stewardImplAuditTail(args, ctx, config) {
  const limit = stewardClampInt(args.limit, 1, STEWARD_AUDIT_LIMIT_MAX, STEWARD_AUDIT_LIMIT_DEFAULT);
  const audit = await collectAudit(config, { limit, sourceFilter: 'workbench', typeFilter: null });
  return { ok: true, entries: (audit && audit.entries) || [], truncated: !!(audit && audit.truncated) };
}

// ════════════════════════════════════════════════════════════════════════════
// 决策族(tier exec)—— 替用户答复待决 / 控制班组。放行范围一律经 stewardMayAct + 永久豁免。
// ════════════════════════════════════════════════════════════════════════════

// 13) steward_decide。判定顺序(顺序即安全):
//     读待决 -> 永久豁免正则 -> stewardMayAct(目标线程权限) -> 才真正 decideIntervention。
//     前两道拦下的一律【不落决策日志】—— 没做决定就没有决定可记(只记「做过什么」,不记「想做什么」)。
async function stewardImplDecide(args, ctx, config) {
  const missionId = safeSessionId(args.missionId);
  const interventionId = String(args.interventionId || '');
  const action = String(args.action || '');
  if (!missionId || !interventionId || !action) return stewardFail('invalid_request', 'missionId, interventionId and action are required');
  const head = await stewardReadSessionHead(missionId);
  if (!head || !head.id) return stewardFail('not_found', 'mission or intervention not found');
  const current = (await readInterventions(missionId).catch(() => [])).find(iv => iv && String(iv.id) === interventionId);
  if (!current) return stewardFail('not_found', 'mission or intervention not found');
  // 121-K3(34 号文 §4.5「管家对你正坐着的线程」):【代答路径】。用户就坐在这条线程前面时,那道提问
  // 是当着他的面弹出来的 —— 管家替他按下去,是在抢他手里的鼠标。判据与 13k 两处工具门同一份
  // (stewardSeatedByUser,13k -> 13l 是后向边),拒绝信封也同一个形状。
  // 注意这道门【只挡代答】:steward_thread_read 不过门(用户问「那条在干嘛」时管家还得答得上来)。
  if (stewardSeatedByUser(missionId)) return stewardSeatedFail(missionId);

  const type = String(current.type || '');
  const toolName = String(current.toolName || '');
  const tier = String(current.tier || '');
  const permissionMode = stewardThreadPermissionMode(head, config);

  // §3.3 永久豁免:命中即降级为提议,任何权限档都不放行 —— 这类动作没有 checkpoint 可回滚。
  // 116-3 P0-1:read/edit 档只看工具名(那两档本来就不碰系统面);其余(exec 与档位缺失)连
  // 命令文本一起看 —— `Bash`/`PowerShell`/`run_command` 这类通用执行工具的名字什么关键词都不含,
  // 只看名字等于对 `rm -rf` / `winget uninstall` / `curl -X POST` / `git push` 完全不设防。
  // 两问分开写(而不是一次带 input 的调用):① 工具名本身就在清单里;② 名字看不出来,但命令文本
  // 命中了那五类动作。分开的好处是信封能说清楚「因为哪一条被降级」,审计与人话都更实在。
  const exemptInput = (tier === 'read' || tier === 'edit') ? null : current.input;
  const exemptByName = stewardToolPermanentlyExempt(toolName);
  const exemptByCommand = !exemptByName && stewardToolPermanentlyExempt(toolName, exemptInput);
  if (type === 'permission' && (exemptByName || exemptByCommand)) {
    const because = exemptByName
      ? `工具 ${stewardSanitizeText(toolName)} 属于永久豁免清单`
      : `工具 ${stewardSanitizeText(toolName)} 这次要执行的命令命中了永久豁免清单`;
    return stewardFail('propose_required', `${because}(不可撤销且外溢的动作),任何权限档都必须由用户亲自决定`, {
      reason: 'permanently_exempt', exemptBy: exemptByName ? 'tool_name' : 'command_text',
      missionId, interventionId, type, toolName, permissionMode,
    });
  }
  const mayAct = stewardMayAct(permissionMode, type === 'permission' ? 'permission' : type, tier);
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,这类待决只能由用户决定;把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', missionId, interventionId, type, toolName, tier, permissionMode,
    });
  }

  const expectedVersion = Number.isInteger(args.expectedVersion) && args.expectedVersion >= 0
    ? args.expectedVersion
    : Math.max(0, Number(current.interventionVersion) || 0);
  const result = await decideIntervention({
    missionId,
    interventionId,
    payload: { action, ...(args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload : {}) },
    expectedVersion,
    idempotencyKey: makeId('stew'),
    source: 'steward',
    decidedBy: 'steward',
    contractRequest: true,
  });
  const body = (result && result.body) || {};
  // permission 放行后不可撤销(工具已经开跑);其余三类锚回会话 turnSeq(可回退检查点)。
  const undoRef = body.ok === true
    ? (type === 'permission' && action === 'allow'
      ? { kind: 'none', note: '不可撤销' }
      : { kind: 'turn', sessionId: missionId, turnSeq: Math.max(0, Number(head.turnSeq) || 0) })
    : null;
  if (body.ok === true) {
    stewardAppendDecision({
      tool: 'steward_decide',
      args: { type, action, toolName, tier, interventionId, expectedVersion },
      targetSessionId: missionId,
      permissionMode,
      mayAct,
      undoRef,
      basis: { interventionId, interventionVersion: Number(body.interventionVersion) || 0 },
    });
    return { ...body, undoRef };
  }
  // 失败按 decideIntervention 的稳定 reason 原样回传(version_conflict / not_found / already_terminal /
  // delivery_unavailable …)。用 body.reason 而不是 error.code:reason 是命令核心的机器码,
  // error.code 只是它加了 'intervention.' 前缀的 HTTP 变体,工具面统一暴露前者更好分支。
  const failure = (body.error && typeof body.error === 'object') ? body.error : {};
  return stewardFail(String(body.reason || failure.code || 'decision_failed'), String(failure.message || body.message || 'decision could not be delivered'), {
    missionId, interventionId, type, params: failure.params || {}, status: result && result.status,
  });
}

// 14) steward_run_action。口径(§11.3 116c 行):
//     pause / stop —— 收紧类,任何权限档都可做(把事情停下来永远比让它跑下去保守);
//     resume / retry_node —— 失败处置类,按 §3.3 真值表的 'failed' 档口径:「改文件不问」以上可由管家直接做
//     (续跑/重试只是让线程接着走,线程自己的权限门仍会对 exec 逐条问);「每步都问」「只做计划」只提议。
//     116-2b 验收对齐(Fable):原先借 'plan' 档判定把它们限定为「只有全自动」,与 §3.3 自理清单
//     (失败重试/重启续跑对改文件不问生效)及 13h 自理侧预闸口径不一致,两道闸统一为 'failed'。
//     steer_node —— 改变线程要做的事,按 'plan' 档口径只有「全自动」可做。
const STEWARD_RUN_TIGHTENING = Object.freeze(['pause', 'stop']);
const STEWARD_RUN_ADVANCING = Object.freeze(['resume', 'retry_node', 'steer_node']);
const STEWARD_RUN_ACTION_KIND = Object.freeze({ resume: 'failed', retry_node: 'failed', steer_node: 'plan' });
// 116-3 P0-4(对抗审查):续跑的第六道闸(§11.3 116-2b 行「权限面不可证明就不自动」)此前【只】长在
// 13h 的确定性自理路径上 —— 模型在结构化回复里声明 {tool:'steward_run_action', args:{action:'resume'}}
// 的那条路完全绕开它,一个被判为 manual_resume_required(有非纯读节点停在半路 / 权限面变过)的班组
// 会被自动续跑。判据的【唯一权威点】按 §3.3 的既定纪律在 13g 工具内部,故函数搬到这里;13h 的自理
// 预闸仍调它(13h -> 13g 是后向边),两处共用同一份判定,不再各写一份。
// 读不到快照一律按不安全处理('unknown' ≠ 'auto_resumable')。
//
// 125-P0:班组快照的另一个读点。它与上面那道分级读的是【同一份文件】,但两者的「读不到」语义不同 ——
// 分级要分 ENOENT('missing',没有这条班组可续,不是安全问题)与其它 IO 错('unknown',按不安全处理),
// 所以那个函数一个字节不动;这里只回快照本身,读不到回 null,由 06i 的判据决定怎么办(读不到 = 不知道
// 它被停没停 -> stewardStoppedTarget 只看 head 那一半,不凭空拦)。执行序上这道闸排在分级【之前】,
// 拦下了就不会再读第二次。
async function stewardReadRunSnapshot(sessionId, runId) {
  try { return safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null); }
  catch { return null; }
}
async function stewardRunResumeTier(sessionId, runId, config) {
  let raw = null;
  try {
    raw = await fsp.readFile(agentRunFile(sessionId, runId), 'utf8');
  } catch (error) {
    // 快照【根本不存在】≠「不敢续跑」:那是「没有这条班组可续」,核心自己会回 run_action_failed,
    // 拿它当危险来挡会把一个 not-found 说成安全问题。其余读失败(权限/IO)一律按不安全处理。
    return (error && error.code === 'ENOENT') ? 'missing' : 'unknown';
  }
  const run = safeJsonParse(raw, null);
  if (!run) return 'unknown';
  return String(classifyRunResumeTier(run, config && config.permissionMode).tier || '');
}
async function stewardImplRunAction(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  const runId = safeSessionId(args.runId);
  const action = String(args.action || '');
  if (!sessionId || !runId) return (sessionId && STEWARD_RUN_TIGHTENING.includes(action)) ? stewardFail('no_agent_run', '这条线程没有班组可暂停;要停的是它这一回合的话,用 steward_thread_stop', { sessionId, action }) : stewardFail('invalid_request', 'sessionId and runId are required');  // 117m-A4:缺 runId 的收紧类是【问错了工具】(普通线程没有班组),不是请求非法;其余动作逐字不变。全部理由见 13h 的 stewardImplThreadStop 头注
  if (!STEWARD_RUN_TIGHTENING.includes(action) && !STEWARD_RUN_ADVANCING.includes(action)) {
    return stewardFail('invalid_request', `unknown action: ${stewardSanitizeText(action)}`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no agent runs');
  const permissionMode = stewardThreadPermissionMode(head, config);
  const mayAct = STEWARD_RUN_TIGHTENING.includes(action) ? 'auto' : stewardMayAct(permissionMode, STEWARD_RUN_ACTION_KIND[action], 'exec');
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `「${stewardSanitizeText(action)}」是推进类动作,当前线程权限「${stewardPermissionLabel(permissionMode)}」不允许管家直接执行(续跑/重试需「改文件不问」以上,改指令需「智能自动」)——把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', sessionId, runId, action, permissionMode,
    });
  }
  // 125-P0(42 号文 §1 ①):被停下来的班组,管家不自动重开。判据在 06i 一处(本文件不自己算),
  // 位置在 mayAct 之后、续跑分级之前 —— 分级读的是同一份快照,先问这一句,拦下了就省掉那次读。
  // 条件是【用户不在跟前】:POST /api/steward/act 与 /api/steward/relay 都给 trigger:'user',于是
  // 「降级成按钮、用户自己按」那条路照旧走得通;没有 trigger 的调用面(工具循环里模型直接调、
  // 进程内直调)按 fail-closed 一并拦下 —— 那些面上做决定的仍然是模型,不是人。
  if (STEWARD_RUN_ADVANCING.includes(action) && stewardTriggerOf(ctx) !== 'user') {
    const stoppedWhich = stewardStoppedTarget(head, await stewardReadRunSnapshot(sessionId, runId));
    if (stoppedWhich) {
      return stewardFail('propose_required', stewardStoppedRefusal(stoppedWhich), {
        reason: 'target_stopped', sessionId, runId, action, permissionMode, stopped: stoppedWhich,
      });
    }
  }
  // 116-3 P0-4:第六道闸。放在 mayAct 之后、真正下发命令之前 —— 权限档允许不代表这条班组
  // 「重启后自动跑起来」是安全的(那是 run 快照自己的分级,与线程权限档正交)。
  if (action === 'resume') {
    const resumeTier = await stewardRunResumeTier(sessionId, runId, config);
    if (resumeTier !== 'auto_resumable' && resumeTier !== 'missing') {
      return stewardFail('propose_required', `这条班组重启后被判为「${stewardSanitizeText(resumeTier || '未知')}」,自动续跑不安全;把它作为提议交给用户按,不要重试`, {
        reason: 'resume_tier', sessionId, runId, action, permissionMode, resumeTier,
      });
    }
  }
  const cmd = await agentRunActionCommand({
    sessionId, runId, action,
    nodeId: args.nodeId,
    text: args.message == null ? '' : String(args.message).slice(0, STEWARD_STEER_TEXT_MAX),
  });
  if (!cmd) return stewardFail('invalid_request', `unsupported action: ${stewardSanitizeText(action)}`);
  const body = cmd.body || {};
  if (body.ok !== true) return stewardFail('run_action_failed', String(body.error || 'agent run action failed'), { sessionId, runId, action, status: cmd.status });
  // pause/stop 可由 resume 撤销;推进类动作没有对称撤销原语,如实标注不可撤销。
  const undoRef = action === 'pause' || action === 'stop'
    ? { kind: 'run_action', sessionId, runId, action: 'resume' }
    : { kind: 'none', note: '不可撤销' };
  stewardAppendDecision({
    tool: 'steward_run_action',
    args: { action, runId, nodeId: String(args.nodeId || '') },
    targetSessionId: sessionId,
    permissionMode,
    mayAct,
    undoRef,
    basis: stewardBasisOf(args, { runId }),
  });
  return { ...body, sessionId, runId, action, undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 记忆族(§4)—— 只记「用户本人陈述」。四道闸:来源必须是用户消息 -> 敏感过滤 -> 容量 -> 同义去重。
// ════════════════════════════════════════════════════════════════════════════

// 来源校验:sourceRef 指向的那个回合里必须真有一条【用户】消息。工具输出/助手消息来源确定性拒绝
// (§11.3「工具输出来源确定性拒绝」)—— 否则管家会把自己或工具说的话当成用户的偏好记下来。
async function stewardSourceIsUserMessage(sourceRef) {
  const sessionId = safeSessionId(sourceRef && sourceRef.sessionId);
  if (!sessionId) return false;
  const turnSeq = Number(sourceRef && sourceRef.turnSeq);
  if (!Number.isFinite(turnSeq)) return false;
  const session = await loadSession(sessionId).catch(() => null);
  if (!session) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // 116f 第二道:role:'user' 还不够 —— 管家的【收件箱回合】也是以一条 user 消息注入的(工作台把
  // 几十条系统事件归成一段文本发给模型),但那不是用户本人说的话。13h 在那条消息上落了
  // meta.origin === 'inbox'(随会话正文持久化,重启后仍在),这里确定性拒绝它。同理拒绝
  // 驱动器自动续跑的消息(source:'mission-driver')—— 也不是人说的。
  return messages.some(m => m && m.role === 'user' && Number(m.turnSeq) === turnSeq
    && !(m.meta && typeof m.meta === 'object' && m.meta.origin === 'inbox')
    && m.source !== 'mission-driver');
}

// 15) steward_memory_write
async function stewardImplMemoryWrite(args, ctx, config) {
  const kind = String(args.kind || '');
  if (!STEWARD_MEMORY_KINDS.includes(kind)) return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  const text = stewardSanitizeText(args.text).trim();
  if (!text) return stewardFail('invalid_request', 'text is required');
  if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
    return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
  }
  const sourceRef = (args.sourceRef && typeof args.sourceRef === 'object') ? args.sourceRef : null;
  if (!sourceRef) return stewardFail('invalid_request', 'sourceRef {sessionId, turnSeq} is required');
  if (!await stewardSourceIsUserMessage(sourceRef)) {
    return stewardFail('source_not_user', 'sourceRef must point at a turn that contains the user\'s own message; tool output and assistant text are not valid memory sources');
  }
  // 敏感过滤复用工作台记忆的同一条正则(密钥/口令/JWT/连接串),不另写第二套判据。
  if (memoryProposalLooksSensitive({ body: text })) {
    return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
  }

  // 126-M02:时效。清洗复用 06d 的 cleanMemoryDate(非法/缺省 -> 空串 = 不过期)。
  // 写的时候允许留空 —— 「我用 Windows」这种事实本来就不该有到期日;该写的是
  //「这两周在赶 A 项目」那一类必然过期的。给不给由模型按提示词判断,服务端只管清洗与过滤。
  const expiresAt = cleanMemoryDate(args && args.expiresAt);
  const terms = stewardMemoryTerms(text);
  return stewardMutateMemory(async store => {
    // 被否决过的同义内容拒绝写回(§4 第 ⑤ 条:vetoed 之后同义不再自动写回)。
    const vetoed = store.entries.find(e => e.state === 'vetoed' && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    if (vetoed) {
      return { persist: false, result: stewardFail('vetoed_duplicate', `a synonymous memory was vetoed by the user (${vetoed.id}); do not write it back`, { id: vetoed.id }) };
    }
    const existing = store.entries.find(e => e.state === 'active' && e.kind === kind && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    const at = nowIso();
    if (existing) {
      // 116-2e(§4 ⑥):合并【不新增条目】—— 保留旧 id(引用它的决策日志与提示词行不失效),
      // text 取新(用户最近一次的说法更准),confidence 取两者较大再 +0.1 封顶 1(同一件事被说了
      // 第二遍,置信度只该升不该降),来源 ref 进 mergedFrom(最多 5 个,先进先出)。
      const incomingConfidence = Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6;
      const prevRef = { sessionId: existing.sourceSessionId, turnSeq: existing.sourceSeq, at: existing.updatedAt || existing.createdAt };
      existing.text = text;
      existing.confidence = Math.min(1, Math.max(existing.confidence, incomingConfidence) + 0.1);
      existing.mergedFrom = [...(Array.isArray(existing.mergedFrom) ? existing.mergedFrom : []), prevRef].slice(-STEWARD_MEMORY_MERGED_FROM_MAX);
      existing.sourceSessionId = String(sourceRef.sessionId || '');
      existing.sourceSeq = Math.max(0, Number(sourceRef.turnSeq) || 0);
      existing.updatedAt = at;
      // 126-M02 合并时的时效:给了新到期日就用新的;**没给而旧的已经过期,就把到期日清掉** ——
      // 用户又说了一遍,这条事实就是当下有效的。不这么写会留一个陷阱:合并成功、
      // 却因为继承了过去的到期日而仍然不进提示词块(写了等于没写)。
      if (expiresAt) existing.expiresAt = expiresAt;
      else if (memoryIsExpired(existing)) existing.expiresAt = '';
      const undoRef = { kind: 'memory', id: existing.id, prev: null };
      stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: true }, targetSessionId: String(sourceRef.sessionId || ''), permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [existing.id] } });
      return { persist: true, result: { ok: true, id: existing.id, merged: true, undoRef } };
    }
    const activeCount = store.entries.filter(e => e.state === 'active').length;
    if (activeCount >= STEWARD_MEMORY_LIMITS.maxEntries) {
      return { persist: false, result: stewardFail('capacity_exceeded', `steward memory is full (${STEWARD_MEMORY_LIMITS.maxEntries} active entries); veto something before writing more`) };
    }
    const entry = {
      id: makeId('smem'),
      kind,
      text,
      confidence: Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6,
      sourceSessionId: String(sourceRef.sessionId || ''),
      sourceSeq: Math.max(0, Number(sourceRef.turnSeq) || 0),
      createdAt: at,
      updatedAt: at,
      lastUsedAt: '',
      useCount: 0,
      state: 'active',
      mergedFrom: [],
      expiresAt, // 126-M02:空串 = 不过期(绝大多数条目就该是空的)
    };
    store.entries.push(entry);
    const undoRef = { kind: 'memory', id: entry.id, prev: null };
    stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: false }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [entry.id] } });
    return { persist: true, result: { ok: true, id: entry.id, merged: false, undoRef } };
  });
}

// 16) steward_memory_veto
async function stewardImplMemoryVeto(args) {
  const id = String(args.id || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    const prev = entry.state;
    entry.state = 'vetoed';
    entry.updatedAt = nowIso();
    const undoRef = { kind: 'memory', id, prev };
    stewardAppendDecision({ tool: 'steward_memory_veto', args: { id }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, id, state: 'vetoed', undoRef } };
  });
}

// 17) steward_memory_search —— 词法匹配(词项 Jaccard + 子串命中),默认排除 vetoed。
async function stewardImplMemorySearch(args) {
  const q = String(args.q || '').trim();
  const kind = STEWARD_MEMORY_KINDS.includes(String(args.kind || '')) ? String(args.kind) : '';
  const limit = stewardClampInt(args.limit, 1, STEWARD_MEMORY_LIMITS.searchLimit, 20);
  const includeVetoed = args.includeVetoed === true;
  // 126-M02:过期条目默认**不出现在读取结果里** —— 提示词块(13o)与模型自己的检索都走这一口,
  // 所以「过期就不再被用上」这件事在这一处就够了,不必散到调用方去。
  // 时效是**过滤,不是删除**:条目仍在库里、仍在面板上可见并带「已过期」标(§6 ② 的拍板;
  // 与 116 波「否决条目不换说法复活」同一条理由 —— 删掉的话同一条会被原样重写一遍)。
  // 判据不在本文件:调 06d 的 memoryIsExpired,与工作台库同一口径(44 号文 §1.2)。
  const includeExpired = args.includeExpired === true;
  const nowMs = Date.now();
  const store = await stewardReadMemoryStore();
  const terms = q ? stewardMemoryTerms(q) : null;
  const needle = q.toLowerCase();
  const rows = store.entries
    .filter(e => (includeVetoed || e.state === 'active') && (!kind || e.kind === kind))
    .filter(e => includeExpired || !memoryIsExpired(e, nowMs))
    .map(e => ({
      entry: e,
      score: terms ? Math.max(stewardTermJaccard(terms, e.text), e.text.toLowerCase().includes(needle) ? 0.9 : 0) : 0,
    }))
    .filter(row => !terms || row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)))
    .slice(0, limit)
    .map(row => ({ ...row.entry, score: Number(row.score.toFixed(4)) }));
  return { ok: true, query: q, kind: kind || '', total: store.entries.length, entries: rows };
}

// 20) steward_missions —— 事项级只读视图(116g / §3.1 / §8.10)。
// 纪律:装配全部委托 13d 的 buildMissionAggregateRows(与看板 GET /api/missions 逐字节同源),
// 事项级状态只经 06i 的 aggregateMissionState 纯函数 —— 本文件【不】自己判定任何状态。
async function stewardImplMissions(args, ctx, config) {
  const includeArchived = !!(args && args.includeArchived === true);
  const aggregate = await buildMissionAggregateRows({ includeArchived }).catch(() => ({ rows: [] }));
  const missions = aggregate.rows.map(row => {
    const mission = {
      missionId: row.missionId,
      title: stewardSanitizeText(row.title),
      goal: stewardSanitizeText(row.goal).slice(0, 400),
      aggregateState: row.aggregateState,
      aggregateStateLabel: stewardStateLabel(row.aggregateState),
      acceptance: {
        done: row.acceptance.done,
        total: row.acceptance.total,
        items: row.acceptance.items.map(item => ({ id: item.id, text: stewardSanitizeText(item.text), done: item.done === true })),
      },
      budget: row.budget,
      cost: row.cost,
      derived: row.derived,
      threads: row.threads.map(thread => ({
        sessionId: thread.sessionId,
        title: thread.title,
        state: thread.state,
        stateLabel: thread.stateLabel,
        permissionMode: thread.permissionMode,
        lastAssistantText: thread.lastAssistantText,   // 13d 已按 §11.2 截到 120 字
        ...(thread.brief ? { brief: thread.brief } : {}),   // 116-5b:同 threads_search —— title 仍是原话,brief 多给的
        wait: thread.wait || null,                     // 116h:等待原因原样透传(13d 已经过 waitReasonFor)
      })),
    };
    if (row.archivedAt) mission.archivedAt = row.archivedAt;
    return mission;
  });
  return { ok: true, missions, count: missions.length };
}

// ════════════════════════════════════════════════════════════════════════════
// 设置族(tier exec)—— §3.5「如意设置」行的三级分级。判据唯一来源是 06i 的 stewardConfigTierFor。
// ════════════════════════════════════════════════════════════════════════════

// 22) steward_config_get —— 掩码复用 POST /api/config 回包用的同一个 maskProviders(不另写一套)。
//     forbidden 级的键【连掩码值都不回】,只在 omitted[] 里列键名 —— 给出掩码值等于承认它存在
//     并暗示它的形状,而 forbidden 的意思是「这一族根本不经管家」。
async function stewardImplConfigGet(args, ctx, config) {
  const masked = maskProviders(config);
  const requested = Array.isArray(args.keys)
    ? args.keys.map(k => String(k || '').trim()).filter(Boolean).slice(0, 64)
    : Object.keys(masked);
  const values = {};
  const tiers = {};
  const omitted = [];
  for (const key of requested) {
    const tier = stewardConfigTierFor(key);
    if (tier === 'forbidden') { omitted.push(key); continue; }
    if (!Object.prototype.hasOwnProperty.call(masked, key)) { omitted.push(key); continue; }
    values[key] = masked[key];
    tiers[key] = tier;
  }
  return { ok: true, values, tiers, omitted };
}

// 23) steward_config_set —— 整份原子:任一键 forbidden 就整份拒绝(零写入),任一键 confirm 且用户
//     没亲手按就整份 propose_required。不做「能写的写、不能写的跳过」—— 半份生效的配置是最难解释
//     的那种状态,用户按下按钮时看到的也必须是他刚才看到的那一整份。
async function stewardImplConfigSet(args, ctx, config) {
  const rawPatch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
  if (!rawPatch) return stewardFail('invalid_request', 'patch must be an object of {key: value}');
  const patch = { ...rawPatch };   // 本地副本:下面要往里塞一个请求级信号(confirm),不该改模型给的对象
  const keys = Object.keys(patch);
  if (!keys.length) return stewardFail('invalid_request', 'patch is empty');
  if (keys.length > 32) return stewardFail('invalid_request', 'patch carries too many keys (max 32)');

  const forbidden = keys.filter(k => stewardConfigTierFor(k) === 'forbidden');
  if (forbidden.length) {
    return stewardFail('steward.forbidden', `these keys can never be changed through the steward: ${forbidden.join(', ')}`, { keys: forbidden });
  }
  // 116-3 P2-12(§8.6):把全局默认权限切到「全自动」是一条【专门】要求二次确认的动作,不是任意
  // confirm 键共用的通用按钮语义。判定与错误口径与 13d 的线程级 PATCH、13 的 applyConfigPatch 共用
  // 同一张 PERMISSION_MODES_REQUIRING_CONFIRM 与同一个 `permission.confirm_required` 码。
  // 外层信封仍是 propose_required —— 13h 只对这个码做「降级成一个按钮」,换成别的码用户就再也
  // 按不到那个按钮了;专门口径放在 reason 与人话里(界面按 reason 取 §8.6 那五条文案)。
  // 只读一次 ctx.userPressed:06i 的契约与 steward-tools.static ⑦ 把「13g 里读它的地方」钉成两处
  //(config_set / skill_toggle 各一处),下面两道门共用这一个局部量。
  const pressed = ctx.userPressed === true;
  if (Object.prototype.hasOwnProperty.call(patch, 'permissionMode') && !pressed) {
    const requested = patch.permissionMode == null ? '' : String(patch.permissionMode);
    if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested)) {
      return stewardFail('propose_required',
        `把【新线程的默认权限】切到「${stewardPermissionLabel(requested)}」要你亲手确认:那之后线程可以在你不在的时候改文件、跑命令、装东西、联网发东西。把它作为提议交给用户按,不要重试`,
        { reason: 'permission.confirm_required', keys: ['permissionMode'], permissionMode: requested });
    }
  }
  const confirmKeys = keys.filter(k => stewardConfigTierFor(k) === 'confirm');
  if (confirmKeys.length && !pressed) {
    // 13h 既有的降级路径会把 propose_required 变成一个按钮;用户按下那个按钮走 POST /api/steward/act,
    // 只有那条路径会置 ctx.userPressed = true(06i 的契约注释里写死了唯一来源)。
    return stewardFail('propose_required', `changing ${confirmKeys.join(', ')} needs the user to press the button`, { reason: 'confirm_required', keys: confirmKeys });
  }

  // 校验整份 patch 走【与 POST /api/config 同一条】normalize/sanitize:先合进当前配置跑一遍
  // normalizeConfig,再逐键比对 —— 被 sanitize 清洗掉(非法值静默回落)的键当场拒绝,而不是写进去
  // 之后让用户在设置页里发现「我改的没生效」。
  const probe = normalizeConfig({ ...config, ...patch }).config;
  const rejected = keys.filter(k => JSON.stringify(probe[k]) !== JSON.stringify(patch[k]));
  if (rejected.length) {
    return stewardFail('invalid_request', `these values did not survive config sanitize (illegal value or out of range): ${rejected.join(', ')}`, { keys: rejected });
  }

  const before = {};
  for (const key of keys) before[key] = config[key];
  // 落盘走与 POST /api/config 同一个 applyConfigPatch:116h 的 arbiterRefresh、CLI settings 同步、
  // MCP 同步全在那条路径上,管家另开一条就会静默漏掉它们。
  // 116-3 B1:applyConfigPatch 顶部新加了「切全局默认权限到全自动须 confirm:true」的服务端门。
  // 走到这一行时 confirm 档的判定已经过了(permissionMode 本来就在 STEWARD_CONFIG_TIER_CONFIRM 里,
  // 所以想改它必须 ctx.userPressed === true = 用户在界面上亲手按下了那个按钮),这个事实如实带过去。
  // 它是请求级信号不是配置键:applyConfigPatch 判完就把它剥掉,绝不会进 config.json;放在
  // keys/probe/before 三处算完【之后】才塞,免得它被当成一个待写的配置键。
  patch.confirm = true;
  const next = await applyConfigPatch(patch);
  const applied = {};
  for (const key of keys) applied[key] = next[key];
  // undoRef 内联在决策日志行里({kind:'config', before:{key:oldValue}}),不新增任何持久化面。
  const undoRef = { kind: 'config', before };
  stewardAppendDecision({
    tool: 'steward_config_set',
    args: { keys, confirmed: confirmKeys.length > 0 },
    targetSessionId: '',
    permissionMode: '',
    mayAct: confirmKeys.length ? 'user' : 'auto',
    undoRef,
    basis: stewardBasisOf(args),
  });
  return { ok: true, applied, tiers: Object.fromEntries(keys.map(k => [k, stewardConfigTierFor(k)])), undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 内容管理族 —— §3.5「内容管理」行。playbook 只起草不保存;技能启停须确认;速查线程自己收工。
// ════════════════════════════════════════════════════════════════════════════

// 22) steward_playbook_draft —— 只返回草稿,【不保存】。保存走既有 UI(POST /api/playbooks,117 接)。
//     每回合 1 次:draftPlaybookFromSession 自己要调一次模型,管家一个回合里连起五个草稿是纯烧钱。
async function stewardImplPlaybookDraft(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  // 同 skill_toggle:身份判定排在装载之前(见那边的原注释)。
  if (sessionId === STEWARD_SESSION_ID) return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
  if (!stewardTurnQuotaTake('playbook_draft', ctx, STEWARD_PLAYBOOK_DRAFTS_PER_TURN)) {
    return stewardFail('quota_exceeded', `at most ${STEWARD_PLAYBOOK_DRAFTS_PER_TURN} playbook draft per steward turn; do not retry - tell the user what you have`);
  }
  const draft = await draftPlaybookFromSession(sessionId);
  if (!draft || draft.ok === false) {
    return stewardFail('draft_failed', String((draft && draft.error) || 'the engine could not draft a playbook from this thread'));
  }
  return { ok: true, sessionId, draft: draft.playbook || draft.draft || null, saveVia: 'POST /api/playbooks' };
}

// 23) steward_skill_toggle —— 与 POST /api/session/skills 共用 setSessionSkillsCore(同一段校验/去重/
//     截 8/来源锁定/活动回合同步)。须确认:改了技能就等于改了那条线程下一回合的工具面与提示词。
async function stewardImplSkillToggle(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  // 管家不能对自己用:管家提示词包本来就不含技能索引(§3.5「管家动如意、线程动世界」)。这一条排在
  // 会话装载【之前】—— 目标是管家自己时,答案是「这件事不该做」,不该因为管家会话恰好还没建出来
  // 就退化成「找不到」(两个信封说的是完全不同的两件事)。
  if (sessionId === STEWARD_SESSION_ID) {
    return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') {
    return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
  }
  if (!Array.isArray(args.skills)) return stewardFail('invalid_request', 'skills must be an array of skill ids');
  if (ctx.userPressed !== true) {
    return stewardFail('propose_required', 'changing the enabled skills of a thread needs the user to press the button',
      { reason: 'confirm_required', sessionId, skills: args.skills.map(x => String((x && x.id) || x || '')).slice(0, 8) });
  }
  const result = await setSessionSkillsCore(sessionId, args.skills);
  if (!result.ok) return stewardFail('not_found', String(result.error || 'session not found'));
  stewardAppendDecision({
    tool: 'steward_skill_toggle',
    args: { skills: result.skills.map(s => s.id) },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'user',
    undoRef: { kind: 'skills', sessionId, before: Array.isArray(head.skills) ? head.skills.map(s => (s && s.id) || '') : [] },
    basis: stewardBasisOf(args),
  });
  return { ok: true, sessionId, skills: result.skills };
}

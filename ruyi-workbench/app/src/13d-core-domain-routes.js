async function handleSessionApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return send(res, json({ ok: true, sessions: await listSessions() }));
  }
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    return send(res, json({ ok: true, session: await createSession(body) }));
  }
  // Bulk history cleanup is intentionally narrower than the single-session DELETE endpoint: it only
  // clears unpinned sessions and can preserve the currently open session supplied by the UI.
  if (req.method === 'POST' && pathname === '/api/sessions/bulk-delete') {
    const body = await readJsonBody(req);
    return send(res, json(await bulkDeleteUnpinnedSessions({
      preserveSessionId: body && body.preserveSessionId,
      purgeAssociated: Boolean(body && body.purgeAssociated),
    })));
  }
  if (pathname.startsWith('/api/sessions/')) {
    const id = path.basename(pathname); // guards traversal
    if (req.method === 'GET') {
      const session = await loadSession(id);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      // v0.8-S0 A6: surface whether the last turn dangles (arrested mid-flight) so the UI can offer resume.
      return send(res, json({ ok: true, session, resumable: detectDanglingTurn(session) }));
    }
    if (req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) {
      const body = await readJsonBody(req);
      const session = await updateSessionMeta(id, body);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      return send(res, json({ ok: true, session }));
    }
    if (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE')) {
      return send(res, json(await deleteSession(id)));
    }
  }
  return false;
}

// ============================================================================
// 第70波(EC-E Mission Ready 首切片):/api/missions 聚合只读投影。
// 纪律:①纯读模型 —— 不复制第二套执行状态机,快照全部从既有权威源(mission 账本 / run 快照 /
// checkpoint journal / usage 月度账本 / 内存 pending 注册表)现算;②旧会话适配只读派生(sessionKind),
// 绝不回写磁盘;③列表只读会话头文件(<id>.json 含 mission,不触 messages/provider 正文),详情才全量加载。
// ============================================================================

// 卡片/快照共用的状态派生:complete(全部里程碑 done) > active(until-done 驱动中) > paused(supervised =
// 预算耗尽/停滞/用户接管后的待命态) > idle(off 且未完成)。mission 缺失时不应出现在任务列表('none')。
function missionCardStatus(m) {
  if (!m) return 'none';
  const ms = Array.isArray(m.milestones) ? m.milestones : [];
  if (ms.length > 0 && ms.every(x => x && x.status === 'done')) return 'complete';
  if (m.autoMode === 'until-done') return 'active';
  if (m.autoMode === 'supervised') return 'paused';
  return 'idle';
}

// 未决事项统一读形(第71b:四源统一 —— permission/question/plan/pool 全部从 session.interventions NDJSON 现算)。
// 前三者此前是纯内存 Map(04-permission-runtime:191/194/199),重启即归零;71 波旁路持久化为 Intervention(02
// append-only NDJSON),重启终态化(markInterruptedInterventions)后 pending 标 cancelled_restart -> 计数归零。
// 71b 池提案统一进来:paused run 的提案恢复后仍可审批,boot 对账补登记 + markInterruptedInterventions 按 run
// 状态分流保留 pending(见 02/08);run 快照扫描仅作并集兜底(append 落盘延迟 + 对账前存量),按 id 去重不双计。
async function missionPendingCounts(sessionId, runs, interventions) {
  const ivs = Array.isArray(interventions) ? interventions : await readInterventions(sessionId).catch(() => []);
  let permissions = 0, questions = 0, plans = 0, pool = 0;
  const poolPendingIds = new Set();
  for (const iv of ivs) {
    if (!iv || iv.status !== 'pending') continue;
    if (iv.type === 'permission') permissions++;
    else if (iv.type === 'question') questions++;
    else if (iv.type === 'plan') plans++;
    else if (iv.type === 'pool') { pool++; poolPendingIds.add(String(iv.id)); }
  }
  for (const r of (runs || [])) for (const item of ((r && r.taskPool) || [])) {
    if (item && item.status === 'proposed' && !poolPendingIds.has(String(item.id))) { pool++; poolPendingIds.add(String(item.id)); }
  }
  return { permissions, questions, plans, pool };
}

// run 摘要投影(对齐 /api/agent-runs?view=digest 的标量集 + 用量字段;live run 以内存为准)。
function missionRunDigest(r, includeLive = true) {
  const live = includeLive ? activeAgentRuns.get(r.id) : null;
  const mem = live && live.run ? live.run : null;
  const src = mem || r;
  return {
    id: src.id, status: src.status, eventSeq: Number(src.eventSeq) || 0,
    createdAt: src.createdAt || '', updatedAt: src.updatedAt || '', completedAt: src.completedAt || '',
    nodeCount: Array.isArray(src.nodes) ? src.nodes.length : 0,
    poolPending: ((src.taskPool) || []).filter(p => p && p.status === 'proposed').length,
    live: !!live, paused: !!(live && live.paused), resumeTier: src.resumeTier || '',
    totalTokens: Number(src.totalTokens) || 0, costUsd: Number(src.costUsd) || 0,
  };
}

// 列表卡片:从会话头文件投影(头含 mission,见 saveSession 头/正文拆分)。
async function buildMissionCard(head, runs, opts = {}) {
  const m = head.mission;
  const ms = (m && Array.isArray(m.milestones)) ? m.milestones : [];
  return {
    sessionId: head.id, missionId: sessionMissionId(head), title: head.title || '', cwd: head.cwd || '', kind: 'mission',
    createdAt: head.createdAt || '', updatedAt: head.updatedAt || '',
    status: missionCardStatus(m),
    activeTurn: opts.persistent ? false : activeChildren.has(head.id), // 75c:live overlay 不写进可重建持久索引
    mission: {
      goal: m.goal || '', createdAt: m.createdAt || '', updatedAt: m.updatedAt || '',
      autoMode: m.autoMode || 'off',
      milestonesTotal: ms.length,
      done: ms.filter(x => x && x.status === 'done').length,
      blocked: ms.filter(x => x && x.status === 'blocked').length,
      pending: ms.filter(x => !x || x.status === 'pending').length,
      budget: m.budget || { maxAutoTurns: 0, maxTokens: 0 },
      spent: m.spent || { autoTurns: 0, tokens: 0 },
      budgetExhausted: Boolean(m.budgetExhaustedAt),
      // 第72波:结果章存根(列表卡片只带状态+时间,明细走详情快照 result)
      result: (m.result && typeof m.result === 'object') ? { status: m.result.status || '', finishedAt: m.result.finishedAt || '' } : null,
    },
    pending: await missionPendingCounts(head.id, runs, opts.interventions),
    runCount: (runs || []).length,
    lastRun: runs && runs.length ? missionRunDigest(runs[runs.length - 1], !opts.persistent) : null,
  };
}

async function handleMissionsApiRoutes(req, res, pathname) {
  // 75c:列表走可删物化索引。冷读验证/重建权威源，热读只叠加 live overlay；cursor 携带 revision，
  // 跨页期间事实变化返回 409 snapshot_changed，绝不静默漏项/重复。
  if (req.method === 'GET' && pathname === '/api/missions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const index = await getPretenderProjectionIndex();
    const missions = index.sessions.filter(row => row.card).map(overlayMissionCard);
    missions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const paged = paginatePretenderProjection(req, 'missions', index.missionsRevision, missions);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('missions', index.missionsRevision + '-' + pretenderLiveOverlayRevision(), paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      missions: paged.items,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: index.missionsRevision,
      index: pretenderIndexMeta(index),
    }, 200, { etag }));
  }
  // 详情:单会话稳定任务快照(EC-E:mission + Agent Run + 产物 + 变更 + 检查点 + 用量 + 游标)。
  if (req.method === 'GET' && pathname.startsWith('/api/missions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const index = await getPretenderProjectionIndex();
    const indexed = index.sessions.find(row => row.sessionId === sessionId) || null;
    const etag = indexed ? pretenderEtag('mission', indexed.revision + '-' + pretenderLiveOverlayRevision(sessionId)) : '';
    if (etag && pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const runs = await listAgentRuns(sessionId).catch(() => []);

    // 验收投影:里程碑计数 + 逐项状态(机器验收证据随行)。
    const ms = (session.mission && Array.isArray(session.mission.milestones)) ? session.mission.milestones : [];
    const acceptance = {
      total: ms.length,
      done: ms.filter(x => x && x.status === 'done').length,
      blocked: ms.filter(x => x && x.status === 'blocked').length,
      pending: ms.filter(x => !x || x.status === 'pending').length,
      items: ms.map(x => ({ id: x && x.id, desc: x && x.desc, status: (x && x.status) || 'pending', checkType: (x && x.check && x.check.type) || 'none', evidence: (x && x.evidence) || '' })),
    };

    // 变更/产物聚合:跨回合 turnSummary 折叠(02 foldTurnSummaries 单一实现,与 buildMissionResult 共用) ——
    // filesChanged 按 path 后写胜(最新 op/revertible 为当前态),artifacts 按 path 先去重(首次产出记回合)。
    // revertible=false 即不可逆显式标注(journal skipped 或天生不在账内)。
    // 第72波顺手修:旧内联折叠 `commands += (ts.commands || []).length` 把数字当数组,commands>0 即 NaN
    // (JSON 序列化为 null)——统一走 fold 后该 bug 消失;irreversible 正向账随行,旧回合(无该字段)的
    // commands 诚实单列 legacyCommands,不混进新账假装有据。
    const fold = foldTurnSummaries(session);
    const filesChangedList = fold.filesChanged, artifactsList = fold.artifacts, commands = fold.commands;

    // 检查点引用(真实回滚能力的入口:POST /api/checkpoints/rollback {sessionId, turnSeq, entrySeq?})。
    const cpEntries = await journalReadIndex(sessionId).catch(() => []);
    const cpTurnSeqs = [...new Set(cpEntries.map(e => e && e.turnSeq).filter(Number.isFinite))].sort((a, b) => a - b);
    const checkpoints = {
      entries: cpEntries.length,
      turnSeqs: cpTurnSeqs,
      totalBytes: cpEntries.reduce((s, e) => s + (Number(e && e.bytes) || 0), 0),
      rollbackAvailable: cpEntries.length > 0,
    };

    // 用量切片:append-only 月度账本按 sessionId 过滤(权威存储,session 对象上无聚合字段)。
    const usage = indexed && indexed.usage ? indexed.usage : emptyMissionUsage();

    // 游标:增量消费的位置令牌 —— 会话 turnSeq(单调不回绕)+ 各 run 事件流 eventSeq(严格单调,afterSeq 补播)。
    const cursor = {
      turnSeq: Number(session.turnSeq) || 0,
      runs: Object.fromEntries(runs.map(r => [r.id, Number(r && r.eventSeq) || 0])),
      projectionRevision: indexed ? indexed.revision : '',
      snapshotAt: nowIso(),
    };
    const pendingCounts = await missionPendingCounts(sessionId, runs, indexed && indexed.interventions);

    return send(res, json({
      ok: true,
      snapshot: {
        sessionId, missionId: sessionMissionId(session), kind: sessionKind(session), title: session.title || '', summary: session.summary || '',
        cwd: session.cwd || '', createdAt: session.createdAt || '', updatedAt: session.updatedAt || '',
        status: missionCardStatus(session.mission),
        activeTurn: activeChildren.has(sessionId), // 第56波:活回合标志(五态派生的「进行中」权威信号之一,与 run.live 同型内存叠加)
        mission: session.mission || null,
        acceptance,
        runs: runs.map(missionRunDigest),
        changes: { filesChanged: filesChangedList, artifacts: artifactsList, commands },
        // 第72波:不可逆操作正向账(活任务也随快照下发;终态任务以 mission.result 盖章版为准)
        irreversible: { total: fold.irreversible.total, byKind: fold.irreversible.byKind, items: fold.irreversible.items.slice(-30), legacyCommands: fold.irreversible.legacyCommands },
        // 第72波:任务结果快照(终态盖章;active/paused 为 null,看 acceptance/changes/irreversible 实时投影)
        result: (session.mission && session.mission.result) || null,
        checkpoints,
        usage,
        pending: pendingCounts,
        cursor,
        projectionRevision: indexed ? indexed.revision : '',
        freshness: {
          persistentRevision: indexed ? indexed.revision : '',
          indexedAt: indexed ? indexed.indexedAt : '',
          liveOverlay: activeChildren.has(sessionId) || runs.some(r => activeAgentRuns.has(r.id)),
          overlayAt: nowIso(),
        },
      },
      index: pretenderIndexMeta(index),
    }, 200, etag ? { etag } : {}));
  }
  return false;
}

// ============================================================================
// 第75b波(Pretender P1):Intervention 单一 command core。
// 新契约与经典四端点都只做参数/响应适配;权威 CAS、可送达检查、实际动作、审计与幂等响应持久化均在这里。
// ============================================================================
function canonicalDecisionValue(value, depth = 0) {
  if (depth > 24 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => canonicalDecisionValue(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalDecisionValue(value[key], depth + 1);
  return out;
}

function interventionDecisionFingerprint(missionId, interventionId, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalDecisionValue({ missionId, interventionId, payload })), 'utf8')
    .digest('hex');
}

function interventionCommandFailure(reason, status, params = {}, message = '') {
  return {
    status,
    body: {
      ok: false,
      reason,
      error: {
        code: `intervention.${reason}`,
        params: params && typeof params === 'object' && !Array.isArray(params) ? params : {},
        ...(message ? { message } : {}),
      },
    },
  };
}

function normalizeContractQuestionDecision(payload, questions) {
  const rows = payload && payload.answer && Array.isArray(payload.answer.answers)
    ? payload.answer.answers
    : null;
  const known = Array.isArray(questions) ? questions : [];
  if (!rows || rows.length !== known.length || rows.length < 1 || rows.length > 3) {
    return { ok: false, message: 'answer.answers must contain exactly one answer for each question' };
  }
  const byId = new Map(known.map(q => [String(q && q.id || ''), q]));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') return { ok: false, message: 'each answer must be an object' };
    if (Object.keys(row).some(key => !['questionId', 'selectedOptionIds', 'otherText'].includes(key))) {
      return { ok: false, message: 'answer contains fields outside the typed question contract' };
    }
    const questionId = String(row.questionId || '');
    const question = byId.get(questionId);
    if (!question || seen.has(questionId)) return { ok: false, message: 'questionId is unknown or duplicated' };
    seen.add(questionId);
    if (!Array.isArray(row.selectedOptionIds)) return { ok: false, message: 'selectedOptionIds must be an array' };
    if (row.selectedOptionIds.some(id => typeof id !== 'string')) return { ok: false, message: 'selectedOptionIds must contain strings' };
    if (row.otherText !== undefined && typeof row.otherText !== 'string') return { ok: false, message: 'otherText must be a string' };
    const selected = row.selectedOptionIds.map(x => String(x || '')).filter(Boolean);
    if (selected.length !== new Set(selected).size || selected.length > 12) return { ok: false, message: 'selectedOptionIds contains duplicates or too many values' };
    const optionIds = new Set((Array.isArray(question.options) ? question.options : []).map(o => String(o && o.id || '')));
    if (selected.some(id => !optionIds.has(id))) return { ok: false, message: 'selectedOptionIds contains an option outside this question' };
    const otherText = String(row.otherText || '').trim();
    const mode = String(question.answerMode || (question.multiSelect ? 'multiple' : 'single'));
    if (mode === 'single' && selected.length > 1) return { ok: false, message: 'single-choice question accepts at most one option' };
    if (mode === 'text' && selected.length) return { ok: false, message: 'text question does not accept selectedOptionIds' };
    if (otherText && mode !== 'text' && question.allowOther !== true) return { ok: false, message: 'otherText is not allowed for this question' };
    if (!selected.length && !otherText) return { ok: false, message: 'each question requires an answer' };
  }
  return { ok: true, answer: normalizeQuestionAnswer({ answers: rows }, known) };
}

function mapInterventionTransitionFailure(result) {
  const reason = String(result && result.reason || 'decision_failed');
  if (reason === 'not_found') return interventionCommandFailure(reason, 404, {}, 'mission or intervention not found');
  if (reason === 'expired') return interventionCommandFailure(reason, 410, { status: result.status || '' }, 'intervention has expired');
  if (reason === 'version_conflict') {
    return interventionCommandFailure(reason, 409, {
      expectedVersion: result.expectedVersion,
      actualVersion: result.actualVersion,
    }, 'intervention version does not match');
  }
  if (reason === 'idempotency_conflict') {
    return interventionCommandFailure(reason, 409, {}, 'idempotencyKey was already used for a different request');
  }
  if (reason === 'already_terminal') {
    return interventionCommandFailure(reason, 409, {
      status: result.status || '',
      interventionVersion: Number(result.interventionVersion) || 0,
    }, 'intervention is already terminal');
  }
  if (reason === 'not_pending') {
    return interventionCommandFailure(reason, 409, { status: result.status || '' }, 'intervention is already being applied');
  }
  return interventionCommandFailure(reason, 409, {
    ...(result && result.runId ? { runId: result.runId } : {}),
  }, String(result && result.message || 'intervention cannot be delivered'));
}

async function decideIntervention(command = {}) {
  const rawMissionId = String(command.missionId || '');
  const missionId = safeSessionId(rawMissionId);
  const interventionId = String(command.interventionId || '');
  const source = String(command.source || 'contract').slice(0, 64);
  const contractRequest = command.contractRequest !== false;
  const payload = command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
    ? command.payload
    : {};
  if (!missionId || missionId !== rawMissionId || !/^[A-Za-z0-9_-]{1,160}$/.test(interventionId)) {
    return interventionCommandFailure('invalid_request', 400, {}, 'invalid missionId or interventionId');
  }
  let head = null;
  try { head = safeJsonParse(await fsp.readFile(sessionPath(missionId), 'utf8'), null); } catch { /* 404 below */ }
  if (!head || sessionMissionId(head) !== missionId) {
    return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
  }

  if (contractRequest) {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 0) {
      return interventionCommandFailure('invalid_request', 400, { field: 'expectedVersion' }, 'expectedVersion must be a non-negative integer');
    }
    const key = String(command.idempotencyKey || '');
    if (!key || key.length > 128) {
      return interventionCommandFailure('invalid_request', 400, { field: 'idempotencyKey' }, 'idempotencyKey must contain 1-128 characters');
    }
  }

  const current = (await readInterventions(missionId).catch(() => []))
    .find(iv => iv && String(iv.id) === interventionId);
  if (!current || String(current.sessionId || missionId) !== missionId) {
    return interventionCommandFailure('not_found', 404, {}, 'mission or intervention not found');
  }

  const type = String(current.type || '');
  const action = String(payload.action || '');
  if (contractRequest) {
    const commonFields = new Set(['expectedVersion', 'idempotencyKey', 'action']);
    const typeFields = type === 'permission' ? ['updatedInput']
      : type === 'question' ? ['answer']
        : type === 'plan' ? ['feedback']
          : [];
    const allowed = new Set([...commonFields, ...typeFields]);
    const unknown = Object.keys(payload).filter(key => !allowed.has(key));
    if (unknown.length) return interventionCommandFailure('payload_invalid', 400, { fields: unknown }, 'request contains fields outside the type/action contract');
  }
  let toStatus = '';
  let normalizedAnswer = null;
  if (type === 'permission') {
    if (action !== 'allow' && action !== 'deny') return interventionCommandFailure('action_invalid', 400, { type }, 'permission action must be allow or deny');
    if (action === 'allow' && payload.updatedInput !== undefined && (!payload.updatedInput || typeof payload.updatedInput !== 'object' || Array.isArray(payload.updatedInput))) {
      return interventionCommandFailure('payload_invalid', 400, { field: 'updatedInput' }, 'updatedInput must be an object');
    }
    toStatus = action === 'allow' ? 'allowed' : 'denied';
  } else if (type === 'question') {
    if (action !== 'answer') return interventionCommandFailure('action_invalid', 400, { type }, 'question action must be answer');
    if (contractRequest) {
      const normalized = normalizeContractQuestionDecision(payload, current.questions);
      if (!normalized.ok) return interventionCommandFailure('payload_invalid', 400, { type }, normalized.message);
      normalizedAnswer = normalized.answer;
    } else {
      normalizedAnswer = payload.normalizedAnswer;
      if (!normalizedAnswer || typeof normalizedAnswer !== 'object') return interventionCommandFailure('payload_invalid', 400, { type }, 'question answer is required');
    }
    toStatus = normalizedAnswer.ok === false ? 'cancelled' : 'answered';
  } else if (type === 'plan') {
    if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'plan action must be approve or reject');
    if (contractRequest && payload.feedback !== undefined && typeof payload.feedback !== 'string') {
      return interventionCommandFailure('payload_invalid', 400, { field: 'feedback' }, 'feedback must be a string');
    }
    toStatus = action === 'approve' ? 'approved' : 'rejected';
  } else if (type === 'pool') {
    if (action !== 'approve' && action !== 'reject') return interventionCommandFailure('action_invalid', 400, { type }, 'pool action must be approve or reject');
    toStatus = action === 'approve' ? 'approved' : 'rejected';
  } else {
    return interventionCommandFailure('type_unsupported', 409, { type }, 'intervention type is not supported by this release');
  }

  const idempotencyKey = String(command.idempotencyKey || makeId('legacy')).slice(0, 128);
  const decisionPayload = type === 'question'
    ? { action, answer: normalizedAnswer }
    : type === 'permission'
      ? { action, ...(action === 'allow' && payload.updatedInput !== undefined ? { updatedInput: payload.updatedInput } : {}) }
      : type === 'plan'
        ? { action, ...(payload.feedback !== undefined ? { feedback: String(payload.feedback) } : {}) }
        : { action };
  const decisionFingerprint = interventionDecisionFingerprint(missionId, interventionId, decisionPayload);
  let runtimeEntry = null;
  let poolContext = null;

  const preflight = async authoritative => {
    if (!authoritative || String(authoritative.type || '') !== type) return { ok: false, reason: 'not_found' };
    if (type === 'permission') {
      runtimeEntry = pendingPermissions.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'permission consumer is not live' };
      return { ok: true };
    }
    if (type === 'question') {
      runtimeEntry = pendingQuestions.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'question consumer is not live' };
      return { ok: true };
    }
    if (type === 'plan') {
      runtimeEntry = pendingPlans.get(interventionId);
      if (!runtimeEntry || runtimeEntry.sessionId !== missionId) return { ok: false, reason: 'delivery_unavailable', message: 'plan consumer is not live' };
      return { ok: true };
    }

    const runId = String(authoritative.runId || '');
    if (command.requestRunId && String(command.requestRunId) !== runId) return { ok: false, reason: 'not_found' };
    const live = activeAgentRuns.get(runId);
    if (!live || !live.run || live.closing) {
      let persisted = null;
      try { persisted = safeJsonParse(await fsp.readFile(agentRunFile(missionId, runId), 'utf8'), null); } catch {}
      const reason = persisted && persisted.status === 'paused' ? 'run_paused' : 'run_not_live';
      return { ok: false, reason, runId, message: reason === 'run_paused' ? 'run is paused; resume it before deciding' : 'run is not live' };
    }
    if (live.run.sessionId !== missionId) return { ok: false, reason: 'not_found' };
    if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) {
      return { ok: false, reason: 'run_stopping', runId, message: 'run is stopping' };
    }
    const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === interventionId);
    if (!item || item.status !== 'proposed') return { ok: false, reason: 'pool_item_unavailable', runId, message: 'pool item is no longer proposed' };
    let config = null, cwd = '', roleLibrary = new Map();
    if (action === 'approve') {
      try {
        config = await readConfig();
        const session = await loadSession(missionId);
        cwd = normalizeCwd(session && session.cwd, config.defaultWorkspace);
        roleLibrary = new Map((await getAgentRoleLibrary(cwd, config)).map(role => [role.id, role]));
      } catch { /* preserve the existing empty-role-library fallback */ }
      const dryRun = { ...live.run, nodes: Array.isArray(live.run.nodes) ? [...live.run.nodes] : [] };
      const dry = materializePoolItem(dryRun, { ...item }, { roleLibrary, cwd, config });
      if (!dry.ok) return { ok: false, reason: 'pool_materialize_rejected', runId, message: dry.error || 'pool item cannot be materialized' };
    }
    poolContext = { runId, live, item, config, cwd, roleLibrary };
    return { ok: true };
  };

  const execute = () => {
    if (type === 'permission') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      const decision = action === 'allow'
        ? { behavior: 'allow', updatedInput: payload.updatedInput }
        : { behavior: 'deny', message: String(payload.message || 'denied by user') };
      runtimeEntry.resolve(decision, { skipInterventionSettle: true });
      return { ok: true, delivered: true };
    }
    if (type === 'question') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      const delivered = runtimeEntry.deliver(normalizedAnswer, { skipInterventionSettle: true, preserveRegistry: true });
      return { ok: delivered !== false, delivered: delivered !== false, reason: delivered === false ? 'delivery_failed' : '' };
    }
    if (type === 'plan') {
      runtimeEntry.commandApplying = true;
      clearTimeout(runtimeEntry.timer);
      runtimeEntry.resolve({
        decision: action,
        note: payload.feedback != null ? String(payload.feedback).slice(0, 2000) : '',
      }, { skipInterventionSettle: true });
      return { ok: true, delivered: true };
    }
    return (async () => {
      const { runId, live, item, config, cwd, roleLibrary } = poolContext;
      if (activeAgentRuns.get(runId) !== live || live.closing || live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted) || item.status !== 'proposed') {
        return { ok: false, reason: 'run_state_changed' };
      }
      if (action === 'reject') {
        item.status = 'rejected'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso();
        bumpRunIntervention(live.run, 'pool_reject');
        appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'rejected', poolId: interventionId, by: String(command.decidedBy || 'user') } });
        await saveAgentRun(live.run);
        return { ok: true, poolId: interventionId };
      }
      const mat = materializePoolItem(live.run, item, { roleLibrary, cwd, config });
      if (!mat.ok) return { ok: false, reason: 'pool_materialize_failed', message: mat.error || '' };
      item.status = 'materialized'; item.decidedBy = String(command.decidedBy || 'user'); item.decidedAt = nowIso(); item.resultNodeId = mat.node.id;
      bumpRunIntervention(live.run, 'pool_approve');
      appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'materialized', poolId: interventionId, by: String(command.decidedBy || 'user'), nodeId: mat.node.id } });
      try { live.poolGraceArmed = true; } catch {}
      if (live.inPoolGrace && Array.isArray(live.resumeWaiters)) {
        const waiters = live.resumeWaiters.splice(0);
        for (const wake of waiters) wake();
      }
      await saveAgentRun(live.run);
      return { ok: true, poolId: interventionId, nodeId: mat.node.id };
    })();
  };

  let transition;
  try {
    transition = await transitionInterventionState(
      missionId,
      interventionId,
      contractRequest ? command.expectedVersion : undefined,
      toStatus,
      {
        source,
        decidedBy: String(command.decidedBy || 'user'),
        idempotencyKey,
        decisionFingerprint,
        preflight,
        action: execute,
        resolveStatus: result => result && result.ok === false ? 'indeterminate' : toStatus,
        extra: result => ({
          action,
          ...(type === 'question' ? { answer: normalizedAnswer } : {}),
          ...(type === 'plan' && payload.feedback != null ? { feedback: String(payload.feedback).slice(0, 2000) } : {}),
          ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
        }),
        buildResponse: (result, meta) => result && result.ok === false
          ? interventionCommandFailure(result.reason || 'delivery_failed', 409, { type }, result.message || 'decision could not be delivered').body
          : {
              ok: true,
              missionId,
              interventionId,
              type,
              action,
              status: meta.status,
              interventionVersion: meta.interventionVersion,
              ...(result && result.delivered !== undefined ? { delivered: result.delivered } : {}),
              ...(result && result.nodeId ? { nodeId: result.nodeId } : {}),
            },
        audit: command.audit === false ? undefined : (_result, terminal) => {
          const auditSource = source === 'legacy_question' ? 'question_answer'
            : source === 'legacy_permission' ? 'permission_decision'
              : source === 'legacy_plan' ? 'plan_decision'
                : source === 'legacy_pool' ? `pool_${action}`
                  : 'intervention_decision';
          logEvent({ kind: 'intervention', source: auditSource, sessionId: missionId, interventionId, type, action, interventionVersion: terminal.interventionVersion });
        },
        afterTerminal: () => {
          if (!runtimeEntry) return;
          runtimeEntry.commandApplying = false;
          if (type === 'permission' && pendingPermissions.get(interventionId) === runtimeEntry) pendingPermissions.delete(interventionId);
          else if (type === 'question' && pendingQuestions.get(interventionId) === runtimeEntry) pendingQuestions.delete(interventionId);
          else if (type === 'plan' && pendingPlans.get(interventionId) === runtimeEntry) pendingPlans.delete(interventionId);
        },
      },
    );
  } catch (error) {
    const message = String(error && error.message || error);
    return interventionCommandFailure('execution_failed', 500, {}, message);
  }
  if (!transition || !transition.ok) return mapInterventionTransitionFailure(transition);
  const response = transition.response && typeof transition.response === 'object'
    ? transition.response
    : {
        ok: true,
        missionId,
        interventionId,
        type,
        action,
        status: transition.status,
        interventionVersion: transition.interventionVersion,
      };
  return { status: response.ok === false ? 409 : 200, body: response };
}

async function handleInterventionApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/_test/pretender-maintenance') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    const body = await readJsonBody(req);
    if (body.action === 'compact') {
      const sessionId = safeSessionId(body.sessionId);
      if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
      return send(res, json(await compactInterventionJournal(sessionId, { force: true })));
    }
    if (body.action === 'rebuild') {
      pretenderIndexRuntime.fullDirty = true;
      return send(res, json({ ok: true, index: pretenderIndexMeta(await getPretenderProjectionIndex()) }));
    }
    return send(res, json({ ok: false, error: 'invalid maintenance action' }, 400));
  }
  const contractMatch = pathname.match(/^\/api\/missions\/([^/]+)\/interventions\/([^/]+)\/decision$/);
  if (req.method === 'POST' && contractMatch) {
    let missionId = '', interventionId = '';
    try {
      missionId = decodeURIComponent(contractMatch[1]);
      interventionId = decodeURIComponent(contractMatch[2]);
    } catch {
      return send(res, json(interventionCommandFailure('invalid_request', 400, {}, 'malformed route encoding').body, 400));
    }
    const body = await readJsonBody(req);
    const result = await decideIntervention({
      missionId,
      interventionId,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      payload: body,
      source: 'contract',
      contractRequest: true,
    });
    return send(res, json(result.body, result.status));
  }
  // 第56波(Pretender 立项门 / EC-E 363):全局「需要你」最小聚合入口 —— 跨会话 pending Intervention 收件箱。
  // 只读派生:扫 *.interventions.ndjson 折叠取 pending(注册/决策/超时/清理/重启终态化全在旁路账里);
  // pool 型由 71b 注册 + boot 对账覆盖,append 落盘延迟窗为最终一致(与 13d missionPendingCounts 同立场)。
  // 按 requestedAt 升序(FIFO 收件箱:最先等你的在最前)。
  if (req.method === 'GET' && pathname === '/api/interventions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const index = await getPretenderProjectionIndex();
    const pending = [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, total: 0 };
    for (const slice of index.sessions) {
      const sessionId = slice.sessionId;
      for (const iv of slice.interventions || []) {
        if (!iv || iv.status !== 'pending') continue;
        pending.push({
          id: iv.id, type: iv.type || '', sessionId, missionId: slice.missionId || sessionId,
          requestedAt: iv.requestedAt || '',
          toolName: iv.toolName || '', tier: iv.tier || '', revertible: iv.revertible === true,
          runId: iv.runId || '', proposedBy: iv.proposedBy || '', task: iv.task || '',
          questions: iv.type === 'question' && Array.isArray(iv.questions) ? iv.questions : [],
          live: activeChildren.has(sessionId), // 决策可送达性提示:活回合在,决策才能立刻被消费
        });
        counts.total++;
        if (iv.type === 'permission') counts.permission++;
        else if (iv.type === 'question') counts.question++;
        else if (iv.type === 'plan') counts.plan++;
        else if (iv.type === 'pool') counts.pool++;
      }
    }
    pending.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    const paged = paginatePretenderProjection(req, 'interventions', index.interventionsRevision, pending);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('interventions', index.interventionsRevision + '-' + pretenderLiveOverlayRevision(), paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      pending: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: index.interventionsRevision,
      index: pretenderIndexMeta(index),
    }, 200, { etag }));
  }
  // 第71波:会话的持久化 Intervention 只读派生(注册/决策/超时/清理/重启终态化的旁路记录,02 NDJSON)。
  if (req.method === 'GET' && pathname.startsWith('/api/interventions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const index = await getPretenderProjectionIndex();
    const slice = index.sessions.find(row => row.sessionId === sessionId) || null;
    const interventions = slice ? slice.interventions : [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, pending: 0, resolved: 0 };
    for (const iv of interventions) {
      if (!iv) continue;
      if (iv.status === 'pending') {
        counts.pending++;
        if (iv.type === 'permission') counts.permission++;
        else if (iv.type === 'question') counts.question++;
        else if (iv.type === 'plan') counts.plan++;
        else if (iv.type === 'pool') counts.pool++;
      } else counts.resolved++;
    }
    const revision = slice ? slice.interventionRevision : pretenderHash([]);
    const paged = paginatePretenderProjection(req, 'session-interventions:' + sessionId, revision, interventions);
    if (paged.response) return send(res, paged.response);
    const etag = pretenderEtag('session-interventions', revision, paged.page);
    if (pretenderNotModified(req, etag)) return send(res, { status: 304, headers: { etag }, body: '' });
    return send(res, json({
      ok: true,
      sessionId,
      missionId: slice ? slice.missionId : sessionId,
      interventions: paged.items,
      counts,
      page: paged.page,
      nextCursor: paged.page.nextCursor,
      projectionRevision: revision,
      integrity: slice ? slice.integrity : { degraded: false, corruptLines: 0, journalRows: 0, journalBytes: 0 },
    }, 200, { etag }));
  }
  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    // 75b compatibility adapter: normalize the classic answer[] shape, then hand the actual decision to
    // the same command core used by the Mission contract.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const questionId = String(body.questionId || body.toolUseId || '');
    const entry = pendingQuestions.get(questionId);
    if (!entry || entry.sessionId !== sessionId) {
      return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    }
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: questionId,
      payload: { action: 'answer', normalizedAnswer: normalizeQuestionAnswer(body, entry.questions) },
      source: 'legacy_question',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, apiFailure('question.delivery_failed', {}, 'answer could not be delivered; the question is still pending', 409));
    return send(res, json({ ok: true, delivered: true, questionId }));
  }
  if (req.method === 'POST' && pathname === '/api/question/request') {
    // Called by request_user_input in the per-session Claude MCP child. Hold the tool call until the UI
    // answers, then return a normal MCP tool result. Provider turns use the same registry in-process.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, apiFailure('auth.token_invalid', {}, 'bad token', 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg || !reg.onEvent) return send(res, apiFailure('question.no_active_turn', {}, 'no active UI stream to prompt', 409));
    const config = await readConfig();
    const answer = await requestUserQuestion(sessionId, makeId('question'), body.questions, reg.onEvent, config.permissionTimeoutMs);
    return send(res, json(answer && answer.ok
      ? { ok: true, answers: answer.answers, content: answer.content }
      : { ok: false, error: (answer && (answer.error || answer.content)) || 'question cancelled' }));
  }
  if (req.method === 'POST' && pathname === '/api/permission/request') {
    // Called by the permission-bridge MCP tool (loopback). Holds until the UI decides or times out.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const config = await readConfig();
    const sessionId = String(body.sessionId || '');
    const reg = activeChildren.get(sessionId);
    const requestId = makeId('perm');
    if (!reg || !reg.onEvent) {
      // No live UI stream to ask — fail closed.
      return send(res, json({ behavior: 'deny', message: 'no active UI to prompt', requestId }));
    }
    // v0.8-S4b: mirror the native path — carry tier + revertible so the popup renders the badge + the
    // revertibility line for CLI-bridge permission prompts too. The CLI reports its own tool names (Edit/
    // Write/Bash/…); toolIsRevertible only matches the workbench file_* set, so a native CLI Edit shows
    // 「无法自动撤销」(correct: CLI-native edits don't pass through toolCall → aren't journaled).
    // 第27波:CLI 桥授权书消耗点。命中直接 allow —— 连 permission_request 事件都不发(免弹窗静默放行)。工具名按 CLI
    // 弹窗实际显示的 Claude 名(Bash/Edit/Write)匹配,与签发卡片同名口径。范围外回落到下方正常弹窗。session 仅需 .id。
    const bridgeTier = nativeToolTier(String(body.toolName || ''));
    // 对抗轮 P3(天花板对称):与 native 主 gate 对齐 —— 仅当工作台自身权限模式对该档判定为 'ask' 时才允许授权书降级。
    // 工作台若处于 plan 模式(该档判 'block'),即便 CLI 发来请求也不放行(子集律:授权书永不把 block 提升为 allow),
    // 回落到下方正常弹窗由人定夺。default→'ask' 授权书生效;bypass→'allow' 本就免弹窗,无需授权书。
    if (nativeToolGate(config.permissionMode, bridgeTier) === 'ask') {
      const grantHit = consumeGrant({ id: sessionId }, String(body.toolName || ''), body.input || {}, 'cli', null);
      // 第42b波(live 冒烟擒获):CLI ≥2.1 的 zod union 要求 allow 变体【必须】带 updatedInput record,
      // 裸 {behavior:'allow'} 会被 CLI 判 invalid_union 拒掉 → 回显原始输入。
      if (grantHit) return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    reg.onEvent({ type: 'permission_request', requestId, toolName: body.toolName, input: body.input, tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    registerIntervention(sessionId, 'permission', requestId, { toolName: String(body.toolName || ''), tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    // 第27f波:CLI 桥超时→存档暂停(与 provider 路径对称)。仅【opt-in + 本会话处于无人值守 driverAuto 回合】才启用;
    // 否则维持"超时即拒杀"安全默认。两段定时:基础超时→检查点(logEvent+saveSession)+ permission_paused 事件 + 延长到 TTL;
    // TTL 内无决定则回落 deny(fail-closed)。entry.timer 重赋为 TTL 定时器,/api/permission/decision 与 clearPendingPermissions 照常清对。
    const cliPause = config.autonomyPauseOnTimeout && driverAutoSessions.has(sessionId);
    const decision = await new Promise(resolve => {
      const entry = { resolve, sessionId, timer: null };
      const baseMs = Number(config.permissionTimeoutMs || 120000);
      if (cliPause) {
        entry.timer = setTimeout(() => {
          if (reg) reg.pausePending = true; // 第27f波:存档暂停期间豁免子进程 idle 看门狗(否则 TTL 内先杀子,窗口被截断)
          try { logEvent({ kind: 'permission_paused', sessionId, tool: String(body.toolName || ''), tier: bridgeTier, requestId, engine: 'claude' }); } catch { /* ignore */ }
          loadSession(sessionId).then(s => s && saveSession(s)).catch(() => {}); // 检查点:会话已在磁盘,重写一遍固化
          try { reg.onEvent({ type: 'permission_paused', requestId, toolName: body.toolName, tier: bridgeTier, ttlMs: config.autonomyPauseTtlMs }); } catch { /* stream gone */ }
          entry.timer = setTimeout(() => {
            const message = '权限已存档暂停但在时限内无人决定,已回落拒绝';
            runAutomaticInterventionDecision({
              missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
              idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
            }, () => {
              if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
              pendingPermissions.delete(requestId);
              resolve({ behavior: 'deny', message, pausedTimeout: true });
              settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: 'paused ttl timeout' });
            });
          }, Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => {
          const message = 'permission prompt timed out';
          runAutomaticInterventionDecision({
            missionId: sessionId, interventionId: requestId, source: 'timeout_permission', decidedBy: 'timeout',
            idempotencyKey: `timeout:${requestId}`, payload: { action: 'deny', message },
          }, () => {
            if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
            pendingPermissions.delete(requestId);
            resolve({ behavior: 'deny', message });
            settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: message });
          });
        }, baseMs);
      }
      pendingPermissions.set(requestId, entry);
    });
    try { reg.onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
    if (reg) { reg.pausePending = false; reg.lastEventAt = Date.now(); } // 解除暂停豁免 + 重置看门狗时钟(暂停不算子进程空闲)
    if (res.writableEnded || res.destroyed) return; // request already gone (e.g. child died)
    // 第42b波(live 冒烟擒获):CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union —— allow 变体必须
    // 带 updatedInput record;UI 纯「允许」(未改输入)时 decision.updatedInput 为 undefined,JSON 序列化
    // 掉键后被 CLI 拒(invalid_union: expected record, received undefined)→ 回合必败。回填原始输入。
    if (decision && decision.behavior === 'allow' && (typeof decision.updatedInput !== 'object' || decision.updatedInput === null || Array.isArray(decision.updatedInput))) {
      decision.updatedInput = body.input || {};
    }
    return send(res, json(decision));
  }
  if (req.method === 'POST' && pathname === '/api/permission/decision') {
    // 75b compatibility adapter. The entry lookup only recovers the mission partition; execution is core-owned.
    const body = await readJsonBody(req);
    const requestId = String(body.requestId || '');
    const entry = pendingPermissions.get(requestId);
    if (!entry) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
    const result = await decideIntervention({
      missionId: entry.sessionId,
      interventionId: requestId,
      payload: behavior === 'allow'
        ? { action: 'allow', updatedInput: body.updatedInput }
        : { action: 'deny', message: body.message || 'denied by user' },
      source: 'legacy_permission',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/plan/decision') {
    // 75b compatibility adapter for the classic plan-mode pause.
    const body = await readJsonBody(req);
    const planId = String(body.planId || '');
    const sessionId = String(body.sessionId || '');
    const entry = pendingPlans.get(planId);
    if (!entry || entry.sessionId !== sessionId) return send(res, json({ ok: false, error: 'no pending plan' }));
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    const result = await decideIntervention({
      missionId: sessionId,
      interventionId: planId,
      payload: { action: decision, feedback: body.note != null ? String(body.note) : '' },
      source: 'legacy_plan',
      contractRequest: false,
    });
    if (result.status !== 200) return send(res, json({ ok: false, error: 'no pending plan' }));
    return send(res, json({ ok: true }));
  }
  // 75a-2: test-only CAS primitive probe (failure-injection matrix, SCHEMA §7 六窗口). Env-gated
  // (RUYI_TEST_HOOKS=1) + token; production returns 404. Not a user-facing route -- 75b 的统一契约端点
  // POST /api/missions/:missionId/interventions/:id/decision 才是对外入口。
  if (req.method === 'POST' && pathname === '/api/_test/intervention-cas') {
    if (process.env.RUYI_TEST_HOOKS !== '1') return send(res, json({ ok: false, error: 'not found' }, 404));
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    let result;
    try {
      result = await transitionInterventionState(body.sessionId, body.ivId, body.expectedVersion, body.toStatus || 'allowed', {
        crashAt: body.crashAt, decidedBy: body.decidedBy, source: 'test',
        action: body.actionMs ? () => new Promise(r => setTimeout(r, Number(body.actionMs) || 0)) : undefined,
      });
    } catch (e) {
      const m = String((e && e.message) || '');
      if (m.startsWith('__cas_crash:')) return send(res, json({ ok: false, reason: 'crash', at: m.slice('__cas_crash:'.length) }));
      throw e;
    }
    return send(res, json(result));
  }
  return false;
}

async function handleAgentRunApiRoutes(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/agent-runs') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const listUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(listUrl.searchParams.get('sessionId'));
    if (!sessionId) return send(res, json({ ok: false, error: 'sessionId required' }, 400));
    const runs = await listAgentRuns(sessionId);
    // 25.2: persistenceDegraded 从内存活跃对象叠加下发 —— 快照写失败时磁盘是陈旧的,这条旗标必须绕过磁盘到达 UI。
    for (const run of runs) { const live = activeAgentRuns.get(run.id); if (live) { run.live = true; run.paused = !!live.paused; if (live.run && live.run.persistenceDegraded) run.persistenceDegraded = true; } }
    // 第29波(§29a): digest 轻量视图 —— 增量客户端每 tick 只拉这份 run 级标量做变更探测(eventSeq/status/
    // updatedAt),不再每 2s 重传全部节点(单节点 result≤24KB + roleSnapshot 8KB prompt,历史终态 run 每 tick
    // 白传)。live run 的 eventSeq/status/updatedAt 以【内存】为准(快照节流 1.5s,磁盘恒旧);快照仍是唯一
    // 权威状态源,digest 只是"该不该去拉"的信号。
    if (listUrl.searchParams.get('view') === 'digest') {
      const digest = runs.map(r => {
        const live = activeAgentRuns.get(r.id);
        const mem = live && live.run ? live.run : null;
        return {
          id: r.id, status: mem ? mem.status : r.status, eventSeq: Number((mem || r).eventSeq) || 0,
          updatedAt: (mem || r).updatedAt || '', createdAt: r.createdAt || '', completedAt: (mem || r).completedAt || '',
          nodeCount: Array.isArray((mem || r).nodes) ? (mem || r).nodes.length : 0,
          poolPending: ((mem || r).taskPool || []).filter(p => p && p.status === 'proposed').length,
          live: !!live, paused: !!(live && live.paused), persistenceDegraded: !!(mem && mem.persistenceDegraded) || r.persistenceDegraded === true,
          resumeTier: (mem || r).resumeTier || '', pendingReview: !!(mem || r).pendingReview,
          anyRunning: Array.isArray((mem || r).nodes) && (mem || r).nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
        };
      });
      return send(res, json({ ok: true, view: 'digest', runs: digest }));
    }
    return send(res, json({ ok: true, runs }));
  }
  // 第29波(§29a): 增量事件消费 —— 客户端记住 lastSeq,断线/重开后 afterSeq=lastSeq 重发即天然补播;
  // seq 严格单调(25.3)保证补播无重无漏。必须排在文件底部 GET /api/agent-runs/:id 通配前缀分支之前,
  // 否则被吞。跨会话防护与快照端点同源:事件文件按 sessionId 分目录,错 session 只会 404→空数组。
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/') && pathname.endsWith('/events')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const evUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(evUrl.searchParams.get('sessionId'));
    const evParts = pathname.split('/').filter(Boolean); // ['api','agent-runs',runId,'events']
    const runId = evParts.length === 4 ? safeSessionId(evParts[2]) : null;
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const afterSeq = Number(evUrl.searchParams.get('afterSeq')) || 0;
    const { events, hasMore } = await readAgentRunEvents(sessionId, runId, afterSeq, Number(evUrl.searchParams.get('limit')) || 0);
    return send(res, json({ ok: true, runId, afterSeq, events, hasMore }));
  }
  if (req.method === 'POST' && pathname.startsWith('/api/agent-runs/')) {
    const parts = pathname.split('/').filter(Boolean);
    const runId = safeSessionId(parts[2]);
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    const action = String(body.action || '');
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const live = activeAgentRuns.get(runId);
    // runId 是全局命名空间（不像持久化文件那样按 sessionId 分目录），live runtime 挂在内存 Map 里也不天然按
    // sessionId 隔离——不加这层校验，一个知道/猜到 runId 的会话就能 pause/resume/stop/steer 另一个会话正在跑的
    // 工作流。对齐 apply_isolation 从文件读到 run 后做的 run.sessionId !== sessionId 校验语义，统一在这里拦截，
    // 对 pause/resume/stop/steer_node 全部生效；resume 的冷启动分支（live 为空）走 launchPersistedAgentRun，
    // 本来就按 sessionId 找持久化文件，不受影响。
    if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
    if (action === 'pause') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行' }, 409));
      // 对抗轮 P3(#8): 计数按【状态迁移】幂等 —— 对已暂停 run 重复 POST(UI 按钮态滞后期双击/双面板)端点行为
      // 无害但计数器会被 UI 时延系统性抬高。只在真正 running→paused 时计一次干预(与本文件 pool_approve 先查
      // status!=='proposed' 的"无效重复不计干预"模式一致)。
      const wasPaused = live.paused === true;
      live.paused = true; live.run.pauseRequestedAt = nowIso();
      if (!wasPaused) bumpRunIntervention(live.run, 'pause'); // 29c(状态迁移才计)
      appendAgentRunEvent(live.run, { type: 'run_paused', data: { reason: 'user' } }); // 25.3
      await saveAgentRun(live.run);
      return send(res, json({ ok: true, state: 'pausing' }));
    }
    if (action === 'resume') {
      if (live) {
        // Reset the idle clock ATOMICALLY with clearing paused: the watchdog reads live.lastActivityAt, so by the
        // time it observes paused=false the clock is already fresh -> no false idle-abort right after a long pause.
        const wasPaused = live.paused === true; // 对抗轮 P3(#8): 仅 paused→running 计一次(对运行中 run resume 是 no-op,不计)
        live.paused = false; live.lastActivityAt = Date.now(); const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
        if (wasPaused) bumpRunIntervention(live.run, 'resume'); // 29c
        appendAgentRunEvent(live.run, { type: 'run_resume_requested', data: { mode: 'warm' } }); // 25.3
        saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 追写快照,让 eventSeq 尽快落盘(缩小崩溃重号窗口)
        return send(res, json({ ok: true, state: 'running' }));
      }
      return send(res, json(await launchPersistedAgentRun({ sessionId, runId, interventionKind: 'resume' })));
    }
    if (action === 'stop') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行' }, 409));
      const wasStopping = live.stopRequested === true; // 对抗轮 P3(#8): 重复 stop 不重复计
      live.stopRequested = true; live.paused = false; try { if (live.ctrl) live.ctrl.abort(); } catch {}
      const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
      if (!wasStopping) bumpRunIntervention(live.run, 'stop'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_stop_requested' }); // 25.3
      saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 同 resume —— 追写快照缩小 eventSeq 崩溃重号窗口
      return send(res, json({ ok: true, state: 'stopping' }));
    }
    if (action === 'retry_node') {
      if (live) return send(res, json({ ok: false, error: '请先等待或停止当前运行' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      return send(res, json(await launchPersistedAgentRun({ sessionId, runId, retryNodeId: nodeId, retryCascade: body.cascade === true, interventionKind: 'retry_node' })));
    }
    if (action === 'apply_isolation') {
      if (live) return send(res, json({ ok: false, error: '请先等待当前运行结束' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8').catch(() => ''), null);
      if (!run || run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      const applied = await applyAgentWorktree(run, nodeId).catch(e => ({ ok: false, error: String(e && (e.gitStderr || e.message) || e) }));
      return send(res, json(applied, applied.ok ? 200 : 409));
    }
    // Directional node steering. Provider nodes consume at their next iteration boundary; Claude nodes consume
    // through the live stream-json stdin channel. Queued nodes keep the message until their model starts.
    if (action === 'steer_node') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行，无法插话' }, 409));
      // 停止收尾窗口：stop 已经请求（或 ctrl 已中止）之后，节点即将被标记 cancelled，不会再有下一次迭代边界来
      // 消费插话队列；此时接受插话只会让用户误以为它会生效，直接拒绝更诚实。
      if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) return send(res, json({ ok: false, error: '工作流正在停止，无法插话' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      if (!nodeId) return send(res, json({ ok: false, error: 'nodeId required' }, 400));
      // 团队模式 v2 (B1): 投递资格判定与 send_to_agent 共用同一小函数(不复制两份),reason 各自映射为本处既有措辞。
      const elig = nodeDeliveryEligibility(live.run, nodeId, { allowClaude: true });
      if (elig.reason === 'not_found') return send(res, json({ ok: false, error: '节点不存在' }, 404));
      if (elig.reason === 'deterministic_gate') return send(res, json({ ok: false, error: '确定性质量门节点不经过模型，无法插话' }, 409));
      if (elig.reason === 'terminal') return send(res, json({ ok: false, error: '节点已结束，无法插话' }, 409));
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return send(res, json({ ok: false, error: '插话内容不能为空' }, 400));
      if (!live.steerQueues) live.steerQueues = new Map();
      let q = live.steerQueues.get(nodeId);
      if (!q) { q = []; live.steerQueues.set(nodeId, q); }
      if (q.length >= STEER_QUEUE_MAX) return send(res, json({ ok: false, error: '该节点插话队列已满' }, 409));
      q.push(text);
      bumpRunIntervention(live.run, 'steer_node'); // 29c(队列在内存,计数随下一次快照落盘即可,不额外写盘)
      return send(res, json({ ok: true, queued: q.length, live: elig.node.status === 'running' }));
    }
    // 75b compatibility adapter: pool approval/rejection shares decideIntervention with the Mission contract.
    if (action === 'pool_approve' || action === 'pool_reject') {
      const poolId = String(body.poolId || '').trim();
      if (!poolId) return send(res, json({ ok: false, error: 'poolId required' }, 400));
      const result = await decideIntervention({
        missionId: sessionId,
        interventionId: poolId,
        requestRunId: runId,
        payload: { action: action === 'pool_approve' ? 'approve' : 'reject' },
        source: 'legacy_pool',
        contractRequest: false,
      });
      if (result.status !== 200) {
        const reason = String(result.body && result.body.reason || '');
        if (!live || live.closing) return send(res, json({ ok: false, error: '运行已结束;可在新运行中执行该任务' }, 409));
        if (reason === 'not_found') return send(res, json({ ok: false, error: '提案不存在' }, 404));
        const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && String(p.id) === poolId);
        if (item && item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item.status})` }, 409));
        const message = result.body && result.body.error && result.body.error.message;
        return send(res, json({ ok: false, error: message || '运行已结束或提案已处理' }, result.status === 404 ? 404 : 409));
      }
      return send(res, json({
        ok: true,
        status: action === 'pool_approve' ? 'materialized' : 'rejected',
        poolId,
        ...(result.body.nodeId ? { nodeId: result.body.nodeId } : {}),
      }));
    }
    return send(res, json({ ok: false, error: 'unknown action' }, 400));
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agent-runs/')) {
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    if (activeAgentRuns.has(runId)) return send(res, json({ ok: false, error: '运行中的工作流不能删除' }, 409));
    try {
      const file = agentRunFile(sessionId, runId);
      const run = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
      for (const node of (run && run.nodes || [])) if (node.isolation) await cleanupAgentWorktree(node.isolation);
      await fsp.unlink(file);
      // 对抗轮修(第25波): 删除快照必须连带删姊妹事件日志 —— 用户删「运行记录」的心智模型是数据消失,
      // 取证 ndjson(含时间线/错误切片)不该在删除后无限期残留。
      await fsp.unlink(agentRunEventsFile(sessionId, runId)).catch(() => {});
      await fsp.unlink(agentRunEventsFile(sessionId, runId) + '.gz').catch(() => {}); // v1.9 数据管家: 归档压缩变体一并删
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
    return send(res, json({ ok: true }));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/')) {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    if (!sessionId || !runId) return send(res, apiFailure('agent_run.id_required', {}, 'sessionId/runId required', 400));
    // 第29波(§29a): live run 以【内存】对象下发 —— 增量客户端在 settle 类事件后靠本端点刷新单 run 状态,
    // 磁盘快照节流 1.5s 恒旧,读盘会让客户端 lastSeq 与状态错位(拿旧状态配新 seq)。JSON.stringify 同步
    // 执行,事件循环内原子,无撕裂读。归属校验与 POST action 的 live 分支同源(sessionId 不符 = 404)。
    const liveOne = activeAgentRuns.get(runId);
    if (liveOne && liveOne.run) {
      if (liveOne.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      return send(res, json({ ok: true, run: { ...liveOne.run, live: true, paused: !!liveOne.paused } }));
    }
    try {
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null);
      if (!run) throw new Error('invalid run');
      return send(res, json({ ok: true, run }));
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
  }
  return false;
}

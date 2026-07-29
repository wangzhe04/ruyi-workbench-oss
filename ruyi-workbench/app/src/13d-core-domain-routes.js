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
async function missionPendingCounts(sessionId, runs) {
  const ivs = await readInterventions(sessionId).catch(() => []);
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
function missionRunDigest(r) {
  const live = activeAgentRuns.get(r.id);
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
async function buildMissionCard(head, runs) {
  const m = head.mission;
  const ms = (m && Array.isArray(m.milestones)) ? m.milestones : [];
  return {
    sessionId: head.id, title: head.title || '', cwd: head.cwd || '', kind: 'mission',
    createdAt: head.createdAt || '', updatedAt: head.updatedAt || '',
    status: missionCardStatus(m),
    activeTurn: activeChildren.has(head.id), // 第56波:活回合标志(列表卡片五态派生用)
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
    pending: await missionPendingCounts(head.id, runs),
    runCount: (runs || []).length,
    lastRun: runs && runs.length ? missionRunDigest(runs[runs.length - 1]) : null,
  };
}

async function handleMissionsApiRoutes(req, res, pathname) {
  // 列表:扫会话头文件(不用索引缓存 —— 索引是派生物,旧条目缺 mission 字段会漏收存量任务会话;
  // 头文件是权威源且不含正文,读取代价与索引同量级)。
  if (req.method === 'GET' && pathname === '/api/missions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const missions = [];
    let files = [];
    try { files = await fsp.readdir(paths.sessions); } catch { files = []; }
    for (const f of files) {
      if (!/^sess_[A-Za-z0-9_-]+\.json$/.test(f)) continue; // 跳过 index.json / *.ndjson / 备份
      const head = safeJsonParse(await fsp.readFile(path.join(paths.sessions, f), 'utf8').catch(() => ''), null);
      if (!head || !head.id || sessionKind(head) !== 'mission') continue;
      const runs = await listAgentRuns(head.id).catch(() => []);
      missions.push(await buildMissionCard(head, runs));
    }
    missions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return send(res, json({ ok: true, missions }));
  }
  // 详情:单会话稳定任务快照(EC-E:mission + Agent Run + 产物 + 变更 + 检查点 + 用量 + 游标)。
  if (req.method === 'GET' && pathname.startsWith('/api/missions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
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
    const usageRows = (await readUsageRows(0).catch(() => [])).filter(r => r && String(r.sessionId || '') === sessionId);
    const costsByCurrency = {};
    const usage = { inTok: 0, outTok: 0, turns: 0, subagentTurns: 0, costsByCurrency };
    for (const r of usageRows) {
      usage.inTok += Number(r.inTok) || 0; usage.outTok += Number(r.outTok) || 0; usage.turns += 1;
      if (r.kind === 'subagent') usage.subagentTurns += 1;
      const cost = Number(r.cost);
      if (r.costTrusted !== false && typeof r.currency === 'string' && r.currency && Number.isFinite(cost)) costsByCurrency[r.currency] = (costsByCurrency[r.currency] || 0) + cost;
    }
    for (const k of Object.keys(costsByCurrency)) costsByCurrency[k] = Math.round(costsByCurrency[k] * 1e6) / 1e6;

    // 游标:增量消费的位置令牌 —— 会话 turnSeq(单调不回绕)+ 各 run 事件流 eventSeq(严格单调,afterSeq 补播)。
    const cursor = {
      turnSeq: Number(session.turnSeq) || 0,
      runs: Object.fromEntries(runs.map(r => [r.id, Number(r && r.eventSeq) || 0])),
      snapshotAt: nowIso(),
    };
    const pendingCounts = await missionPendingCounts(sessionId, runs);

    return send(res, json({
      ok: true,
      snapshot: {
        sessionId, kind: sessionKind(session), title: session.title || '', summary: session.summary || '',
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
      },
    }));
  }
  return false;
}

async function handleInterventionApiRoutes(req, res, pathname) {
  // 第56波(Pretender 立项门 / EC-E 363):全局「需要你」最小聚合入口 —— 跨会话 pending Intervention 收件箱。
  // 只读派生:扫 *.interventions.ndjson 折叠取 pending(注册/决策/超时/清理/重启终态化全在旁路账里);
  // pool 型由 71b 注册 + boot 对账覆盖,append 落盘延迟窗为最终一致(与 13d missionPendingCounts 同立场)。
  // 按 requestedAt 升序(FIFO 收件箱:最先等你的在最前)。
  if (req.method === 'GET' && pathname === '/api/interventions') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const pending = [];
    const counts = { permission: 0, question: 0, plan: 0, pool: 0, total: 0 };
    let files = [];
    try { files = await fsp.readdir(paths.sessions); } catch { files = []; }
    for (const f of files) {
      if (!f.endsWith('.interventions.ndjson')) continue;
      const sessionId = f.slice(0, -'.interventions.ndjson'.length);
      if (!/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) continue;
      const ivs = await readInterventions(sessionId).catch(() => []);
      for (const iv of ivs) {
        if (!iv || iv.status !== 'pending') continue;
        pending.push({
          id: iv.id, type: iv.type || '', sessionId,
          requestedAt: iv.requestedAt || '',
          toolName: iv.toolName || '', tier: iv.tier || '', revertible: iv.revertible === true,
          runId: iv.runId || '', proposedBy: iv.proposedBy || '', task: iv.task || '',
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
    return send(res, json({ ok: true, pending, counts }));
  }
  // 第71波:会话的持久化 Intervention 只读派生(注册/决策/超时/清理/重启终态化的旁路记录,02 NDJSON)。
  if (req.method === 'GET' && pathname.startsWith('/api/interventions/')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(path.basename(pathname)); // basename 挡穿越
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const interventions = await readInterventions(sessionId).catch(() => []);
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
    return send(res, json({ ok: true, sessionId, interventions, counts }));
  }
  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    // Settle exactly one live question. A stale/wrong-session answer is a conflict, never a fake success:
    // the UI must keep the modal open so the user can retry or see that the turn already ended.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const questionId = String(body.questionId || body.toolUseId || '');
    const entry = pendingQuestions.get(questionId);
    if (!entry || entry.sessionId !== sessionId) {
      return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    }
    const delivered = entry.deliver(normalizeQuestionAnswer(body));
    if (!delivered) return send(res, apiFailure('question.delivery_failed', {}, 'answer could not be delivered; the question is still pending', 409));
    logEvent({ kind: 'intervention', source: 'question_answer', sessionId, questionId });
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
          entry.timer = setTimeout(() => { pendingPermissions.delete(requestId); resolve({ behavior: 'deny', message: '权限已存档暂停但在时限内无人决定,已回落拒绝', pausedTimeout: true }); settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: 'paused ttl timeout' }); }, Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => { pendingPermissions.delete(requestId); resolve({ behavior: 'deny', message: 'permission prompt timed out' }); settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'timeout', note: 'permission prompt timed out' }); }, baseMs);
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
    // UI's allow/deny for a pending permission request.
    const body = await readJsonBody(req);
    const entry = pendingPermissions.get(String(body.requestId || ''));
    if (!entry) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    clearTimeout(entry.timer);
    pendingPermissions.delete(String(body.requestId));
    const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
    // 29c: 干预落账 —— 只对真实待决请求计数(过期/重复决定已被上面 404 滤掉);entry 自带 sessionId。
    // 存档暂停(27f)窗口内的决定与基础窗内的决定走同一 handler,天然同权重。
    logEvent({ kind: 'intervention', source: 'permission_decision', sessionId: entry.sessionId || '', behavior });
    entry.resolve(behavior === 'allow' ? { behavior: 'allow', updatedInput: body.updatedInput } : { behavior: 'deny', message: body.message || 'denied by user' });
    settleIntervention(entry.sessionId, String(body.requestId || ''), behavior === 'allow' ? 'allowed' : 'denied', { decidedBy: 'user', note: behavior === 'deny' ? String(body.message || '') : '' });
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/plan/decision') {
    // v0.9-S5 (真流程 plan mode): the UI's approve/reject for a paused plan. Token-gated (needsToken whitelist
    // above; header-token — this decision unlocks mutating tools for the turn, so it is at least as sensitive
    // as /api/permission). Looks up pendingPlans[planId], verifies the sessionId matches (so a decision can't
    // resolve another session's plan), settles the promise, and clears the timer. Idempotent: a second
    // decision for the same (already-settled) planId finds no entry → {ok:false, error:'no pending plan'}.
    const body = await readJsonBody(req);
    const planId = String(body.planId || '');
    const sessionId = String(body.sessionId || '');
    const entry = pendingPlans.get(planId);
    if (!entry || entry.sessionId !== sessionId) return send(res, json({ ok: false, error: 'no pending plan' }));
    clearTimeout(entry.timer);
    pendingPlans.delete(planId);
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    logEvent({ kind: 'intervention', source: 'plan_decision', sessionId, decision }); // 29c
    entry.resolve({ decision, note: body.note != null ? String(body.note) : '' });
    settleIntervention(sessionId, planId, decision === 'approve' ? 'approved' : 'rejected', { decidedBy: 'user', note: body.note != null ? String(body.note) : '' });
    return send(res, json({ ok: true }));
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
    // 团队模式 v2 (A2/A4): 任务池审批。归属守卫(live.run.sessionId !== sessionId → 404)已在上方对全 action 生效。
    // 非 live 或 closing(收尾已原子置位)→ 409 带指引;宽限窗内 closing 仍为 false,故窗内可批并物化并继续调度。
    if (action === 'pool_approve' || action === 'pool_reject') {
      if (!live || live.closing) return send(res, json({ ok: false, error: '运行已结束;可在新运行中执行该任务' }, 409));
      const poolId = String(body.poolId || '').trim();
      if (!poolId) return send(res, json({ ok: false, error: 'poolId required' }, 400));
      const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && p.id === poolId);
      if (!item) return send(res, json({ ok: false, error: '提案不存在' }, 404));
      if (item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item.status})` }, 409));
      if (action === 'pool_reject') {
        item.status = 'rejected'; item.decidedBy = 'user'; item.decidedAt = nowIso();
        settleIntervention(sessionId, poolId, 'rejected', { decidedBy: 'user' }); // 71b: 旁路结算(后写胜)
        bumpRunIntervention(live.run, 'pool_reject'); // 29c
        appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'rejected', poolId, by: 'user' } }); // 29a
        await saveAgentRun(live.run);
        return send(res, json({ ok: true, status: 'rejected', poolId }));
      }
      // approve → 物化(normalizeAgentWorkflow 同款单节点清洗,见 materializePoolItem)。角色库按会话 cwd 构建以校验 roleId。
      // 对抗轮 P3: 停止收尾窗(stopRequested/aborted 已置、closing 尚未置位)内拒绝审批——否则返回"已加入工作流",
      // 节点却在批次落地后立刻被 cancel,语义不诚实。与 steer_node 的停止窗 409 对齐;入口与复检各一道。
      const stoppingNow = () => live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted);
      if (stoppingNow()) return send(res, json({ ok: false, error: '工作流正在停止,无法再加入新任务' }, 409));
      let cwd = '', roleLib = new Map(), cfgRef = null;
      try { cfgRef = await readConfig(); const sess = await loadSession(sessionId); cwd = normalizeCwd(sess && sess.cwd, cfgRef.defaultWorkspace); roleLib = new Map((await getAgentRoleLibrary(cwd, cfgRef)).map(r => [r.id, r])); } catch { /* 角色库不可用则以空库物化(无角色节点仍可执行) */ }
      // 团队模式 v2 (P1 TOCTOU): 上面连续 await(readConfig/loadSession/getAgentRoleLibrary)后、物化前同步复检——
      // 入口校验(!live/closing、item.status==='proposed')与物化之间隔着这些 await,期间调度循环可能已推进:
      //  (a) 宽限窗到期 → 收尾原子置 closing 并 finalize(run 已记终态),此时物化只会追加一个永远 queued 的孤儿节点;
      //  (b) 并发的 pool_reject(其检查到落地无 await)已把本 item 置 rejected,恢复后照物化 = 执行已被拒的任务。
      // 复检 activeAgentRuns.get(runId)/closing/item.status;此复检 → materializePoolItem → 置 materialized 全程无
      // await,与调度循环收尾段(runtime.closing=true 起同步执行到首个 await)互斥,原子成立。
      if (activeAgentRuns.get(runId) !== live || live.closing || stoppingNow()) return send(res, json({ ok: false, error: '运行已结束或正在停止;可在新运行中执行该任务' }, 409));
      if (!item || item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item && item.status || 'unknown'})` }, 409));
      const mat = materializePoolItem(live.run, item, { roleLibrary: roleLib, cwd, config: cfgRef });
      if (!mat.ok) return send(res, json({ ok: false, error: mat.error || '物化失败' }, 409));
      item.status = 'materialized'; item.decidedBy = 'user'; item.decidedAt = nowIso(); item.resultNodeId = mat.node.id;
      settleIntervention(sessionId, poolId, 'approved', { decidedBy: 'user', nodeId: mat.node.id }); // 71b: 旁路结算(后写胜)
      bumpRunIntervention(live.run, 'pool_approve'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'materialized', poolId, by: 'user', nodeId: mat.node.id } }); // 29a
      // 团队模式 v2 (P2-1 重新武装): 物化成功 → 允许宽限窗再武装一次。窗只在有新节点物化后才能重开,而物化必消耗一条
      // proposed(POOL_MAX_TOTAL=8 天然封顶总提案),故续窗次数 ≤ 物化次数 ≤ 8,不会无限续窗。
      try { live.poolGraceArmed = true; } catch {}
      // 若正处宽限窗,唤醒调度循环(其 200ms poll 也会自然发现新 queued 节点;这里加速 paused 情况的唤醒)。
      if (live.inPoolGrace && Array.isArray(live.resumeWaiters)) { const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake(); }
      await saveAgentRun(live.run);
      return send(res, json({ ok: true, status: 'materialized', poolId, nodeId: mat.node.id }));
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

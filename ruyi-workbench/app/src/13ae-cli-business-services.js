// Shared CLI business services. HTTP adapters own authentication; the internal relay supplies
// an exact registered execution owner and rechecks it before business mutations.
async function cliTodoService(body, { method = 'POST', trusted = false, ownerReg = null, ownerCheck = () => {}, isClosed = () => false } = {}) {
  ownerCheck();

    // v0.8-S3: called by the todo_write tool running in the MCP child (Claude engine) over loopback. The
    // child must NOT write session files itself (races the serve process's saveSession), so it delegates
    // the persist here. Body-token authenticated (same pattern as /api/permission/request). Validates →
    // loadSession → session.todos = items → saveSession → if a live turn owns this session, emit `todo`.
    const sessionId = safeSessionId(body.sessionId); // F4
    if (!sessionId) return (apiSessionIdInvalid());
    const items = normalizeTodoItems(body.items);
    // 128b:mutateSession —— 撤回插在读与存之间时在新读的副本上重放,不被闸静默丢掉还回 ok。
    let written;
    try { written = await mutateSession(sessionId, fresh => { ownerCheck(); fresh.todos = items; }, { writer: 'todo' }); }
    catch (error) {
      if (error && error.code === 'session.rewound_during_write') return (apiFailure(error.code, {}, error.message, 409));
      throw error;
    }
    ownerCheck();
    if (!written.session) return (apiSessionNotFound());
    const reg = ownerReg || activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'todo', items }); } catch { /* stream gone */ } }
    return (json({ ok: true, count: items.length }));

}

async function cliMissionService(bodyOrQ, { method = 'POST', trusted = false, ownerReg = null, ownerCheck = () => {}, isClosed = () => false } = {}) {
  ownerCheck();

    const sessionId = safeSessionId(bodyOrQ.sessionId);
    if (!sessionId) return (apiSessionIdInvalid());
    let session = await loadSession(sessionId); ownerCheck();
    if (!session) return (apiSessionNotFound());
    if (method === 'GET') return (json({ ok: true, mission: session.mission || null }));
    // 128b:check／start／update 都走 mutateSession 落盘;撞上撤回回 409 稳定码,不回成功、不记变更流水。
    const rewoundReply = error => (apiFailure(error.code, {}, error.message, 409));
    if (method !== 'POST') return (json({ ok: false, error: 'method not allowed' }, 405));
    const action = String(bodyOrQ.action || 'update');
    const emitMission = () => { ownerCheck(); const reg = ownerReg || activeChildren.get(sessionId); if (reg && reg.onEvent) { try { reg.onEvent({ type: 'mission', mission: session.mission }); } catch { /* stream gone */ } } };
    if (action === 'stop') {
      const result = await missionControlCommand(sessionId, 'stop'); ownerCheck();
      return (json(result.body, result.status));
    }
    if (action === 'check') {
      // 跑全部里程碑机器验收;autoMark!==false 时把 pass 的 pending/blocked 里程碑标 done(证据落 detail)。
      const checkConfig = await readConfig(); ownerCheck();
      const cwd = normalizeCwd(session.cwd, checkConfig.defaultWorkspace);
      const baseGen = Number(session.rewindGen) || 0;
      const results = [];
      for (const m of ((session.mission && session.mission.milestones) || [])) {
        const r = await evaluateMissionCheck(m.check, cwd); ownerCheck();
        results.push({ id: m.id, checkType: m.check ? m.check.type : 'none', result: r });
      }
      const byId = new Map(results.map(item => [item.id, item.result]));
      let resultBefore = '';
      let written;
      try {
        written = await mutateSession(sessionId, async fresh => { ownerCheck();
          for (const m of ((fresh.mission && fresh.mission.milestones) || [])) {
            const r = byId.get(m.id);
            if (!r) continue;
            recordMissionCheckResult(m, r);   // 124-P1:落章(唯一写入口在 02);done 不回退的既有语义不变
            if (r.pass && bodyOrQ.autoMark !== false && m.status !== 'done') { m.status = 'done'; m.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); }
            if (!r.pass && m.status === 'done') { /* 不自动回退 done → 避免抖动;仅 report */ }
          }
          if (fresh.mission) fresh.mission.updatedAt = nowIso();
          resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
          await maybeFinalizeMission(fresh, 'check'); ownerCheck(); // 第72波:全 done 盖 complete 章
        }, { writer: 'mission_check', expectGen: baseGen });
      } catch (error) {
        if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
        throw error;
      }
      ownerCheck();
    if (!written.session) return (apiSessionNotFound());
      session = written.session;
      if (session.mission) {
        const resultAfter = String(session.mission.result && session.mission.result.status || '');
        const revision = await bumpMissionChangeSeq(sessionId, {
          type: resultAfter && resultAfter !== resultBefore ? 'result' : 'progress',
          cursor: { action: 'check' },
          detail: { checks: results.length, passed: results.filter(item => item.result && item.result.pass).length, status: resultAfter },
        });
        ownerCheck(); if (revision) session.mission.changeSeq = revision;
      }
      emitMission();
      return (json({ ok: true, mission: session.mission || null, checks: results }));
    }
    // start = 全量新建(normalizeMission,prev=null);update = 按 id 增量合并(applyMissionUpdate,不抹其它里程碑)。
    // autoMode 可作 body 兄弟字段或 mission.autoMode 传入,两条路径都尊重。
    // 对抗轮 P1: trusted = 【header token】(UI/用户)——只有它能定义机器 check;body-token loopback(模型经 MCP 子进程)
    // 视为不可信,不能设 check.cmd。header token 存在即 UI 直连(浏览器 CORS 拿不到该 token)。

    let resultBefore = '';
    let written;
    try {
      written = await mutateSession(sessionId, async fresh => { ownerCheck();
        resultBefore = String(fresh.mission && fresh.mission.result && fresh.mission.result.status || '');
        if (action === 'start') {
          const input = { ...(bodyOrQ.mission || bodyOrQ) };
          if (bodyOrQ.autoMode != null && input.autoMode == null) input.autoMode = bodyOrQ.autoMode;
          fresh.mission = normalizeMission(input, null, trusted);
          fresh.mission.startedTurnSeq = Math.max(1, (Number(fresh.turnSeq) || 0) + 1);
          fresh.kind = 'mission'; // 第70波(EC-E):start 是显式任务动作 → Quick Ask 翻转 Mission(非启发式)
          return undefined;
        }
        if (!fresh.mission) return { abort: 'no_mission' };
        fresh.mission = applyMissionUpdate(fresh.mission, bodyOrQ.patch || bodyOrQ, trusted);
        if (bodyOrQ.autoMode != null) fresh.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : fresh.mission.autoMode;
        await maybeFinalizeMission(fresh, 'update'); ownerCheck(); // 第72波:全 done 盖 complete 章 / 再武装清旧章
        return undefined;
      }, { writer: 'mission_' + (action === 'start' ? 'start' : 'update') });
    } catch (error) {
      if (error && error.code === 'session.rewound_during_write') return rewoundReply(error);
      throw error;
    }
    ownerCheck();
    if (!written.session) return (apiSessionNotFound());
    if (!written.ok && written.value === 'no_mission') return (json({ ok: false, error: '当前会话没有活动任务账本;请先 action:start' }, 400));
    session = written.session;
    if (action === 'start') logEvent({ kind: 'mission_start', sessionId, trusted, autoMode: session.mission.autoMode }); // 29c: 预算超支率的分母
    if (session.mission) {
      const resultAfter = String(session.mission.result && session.mission.result.status || '');
      const revision = await bumpMissionChangeSeq(sessionId, {
        type: action === 'start' ? 'mission_started' : (resultAfter && resultAfter !== resultBefore ? 'result' : 'progress'),
        cursor: { action },
        detail: {
          status: resultAfter,
          autoMode: session.mission.autoMode || 'off',
          milestonesTotal: Array.isArray(session.mission.milestones) ? session.mission.milestones.length : 0,
          milestonesDone: Array.isArray(session.mission.milestones) ? session.mission.milestones.filter(item => item && item.status === 'done').length : 0,
        },
      });
      ownerCheck(); if (revision) session.mission.changeSeq = revision;
    }
    emitMission();
    // C4 (75a-3): sync the mission change to the active turn's in-memory session, so the provider round-tail
    // saveSession (09:1924) doesn't cover back this route mutation. provider engine updates mission in-process
    // (09:1719) and saves only at round-tail; without sync the turn's stale in-memory mission clobbers the
    // route mutation. 'update' applies the patch (merge via applyMissionUpdate, preserving in-process
    // mission_update changes); start/stop/check replace (full-state action). claude engine re-reads at 05:765
    // instead (its mission_update loops back to disk), so it doesn't need this sync.
    ownerCheck();
    { const reg = ownerReg || activeChildren.get(sessionId); if (reg && reg.session && reg.session !== session) {
      if (action === 'update' && reg.session.mission) {
        reg.session.mission = applyMissionUpdate(reg.session.mission, bodyOrQ.patch || bodyOrQ, trusted);
        if (bodyOrQ.autoMode != null) reg.session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : reg.session.mission.autoMode;
        // 第97波对抗复审(B2):本路由已把磁盘权威侧落盘(含 maybeFinalizeMission 盖的 complete/stopped 章
        // 与归档的 resultHistory);reg 内存侧只是 applyMissionUpdate 深拷旧值,result/resultHistory 仍是旧的。
        // 若不同步,09/provider 回合收尾 saveSession(reg.session)会用陈旧内存覆盖磁盘,新章与归档整条丢失。
        // 同步磁盘权威的 result 与 resultHistory(归档历史是追加语义,以磁盘为准)。
        reg.session.mission.result = session.mission && session.mission.result || null;
        reg.session.mission.resultHistory = Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory.slice(-10) : [];
        if (session.mission && session.mission.result && session.mission.result.status === 'complete' && resultBefore !== 'complete') {
          Object.defineProperty(reg.session, '__missionFinalizeHow', { value: 'update', writable: true, configurable: true, enumerable: false });
        }
      } else {
        reg.session.mission = session.mission;
        if (action === 'start') reg.session.kind = 'mission';
      }
    } }
    return (json({ ok: true, mission: session.mission }));

}

async function cliAgentLaunchService(body, { method = 'POST', trusted = false, ownerReg = null, ownerCheck = () => {}, isClosed = () => false } = {}) {
  if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.run && !WorkDataMaintenanceHooks.entered('agent-launch')) return WorkDataMaintenanceHooks.run('agent-launch', () => cliAgentLaunchService(...arguments));
  ownerCheck();

    // Claude CLI's one-shot MCP child proxies the persistent DAG into the serve process. v1.4.4: the DAG
    // is genuinely dual-engine now — each node picks 'openai' (HTTP against a configured Provider) or
    // 'claude' (a native one-shot `claude` CLI spawn, runClaudeSubAgentOnce) via runAgentWorkflow's
    // per-node engine resolution, so a Claude-CLI-only setup no longer needs a Provider configured at all.
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return (apiSessionIdInvalid());
    const session = await loadSession(sessionId); ownerCheck();
    if (!session) return (apiSessionNotFound());
    const config = await readConfig(); ownerCheck();
    const reg = ownerReg || activeChildren.get(sessionId);
    const provider = resolveProvider(config, body.providerId)
      || activeOpenAiProvider(config)
      || (config.providers || []).find(p => p && p.baseUrl && (p.model || (p.models && p.models.length)));
    // A direct UI/MCP launch has no active parent registry. In a Claude-only installation, defaulting such
    // a launch to OpenAI manufactured an unusable route with provider=null and failed before the fake/real
    // Claude child could start. Choose from actual availability when no live parent turn exists.
    // 2026-10:只有活着的 Claude / provider 父回合才决定默认引擎。Kimi Code 父回合(reg.kind 'kimi-acp')修前被一律当成
    // 'openai',没配 provider 时路由成 provider=null,节点一启动就抛 Cannot read properties of null —— 节点引擎只有
    // openai / claude 两种,Kimi 父回合与「没有父回合」一样按实际可用的引擎挑。
    const parentEngine = reg && reg.kind === 'claude' ? 'claude'
      : (reg && reg.kind === 'openai' ? 'openai' : (provider ? 'openai' : 'claude'));
    const parentModel = parentEngine === 'claude'
      ? String(config.model || '')
      : String(provider && (provider.model || (provider.models && provider.models[0] && (provider.models[0].id || provider.models[0]))) || '');
    const claudeCli = config.claudePath || detectClaudePath();
    const claudeCliUsable = Boolean(process.env.WCW_FAKE_CLAUDE) || Boolean(claudeCli && await existsExecutableAsync(claudeCli)); ownerCheck(); // test seam, see runClaudeTurn; 128f-⑬ 异步
    // Only reject up front when NEITHER engine could possibly run anything; a specific node explicitly
    // requesting an unavailable engine still fails gracefully per-node inside runAgentWorkflow.
    if (!provider && !claudeCliUsable) {
      // 61-C6:说清 Claude CLI 找的是哪(修前探测对不存在的 claude.cmd 也判可用,走不到这里;现在走得到,就要说得清)。
      const where = claudeCli ? `找过 ${claudeCli},不可用` : '没有配置 claudePath,PATH 里也找不到 claude';
      return (json({ ok: false, error: `Agent DAG 需要至少配置一个 OpenAI 兼容 Provider，或安装并配置 Claude CLI(${where})（Kimi Code 不能作为工作流节点的引擎）` }, 400));
    }
    // 2026-10:工作流按【这条线程】的生效权限档跑 —— 修前直接取全局 config.permissionMode,线程在自己的权限 chip 上收紧过也照
    // 全局放。有活着的父回合就用它起回合时解析出的档(请求级 > 会话级 > 全局,05/09 登记在 reg.permissionMode),否则按
    // 会话级 > 全局解析(与续跑、恢复分级 agentRunPermissionMode 同一个解析器)。
    // provider 回合登记了 effectivePermissionMode()(回合中途在线程 chip 上收紧会被它看到),优先用它;其次是起回合时的快照。
    const liveMode = reg && typeof reg.effectivePermissionMode === 'function' ? (() => { try { return reg.effectivePermissionMode(); } catch { return ''; } })() : (reg && reg.permissionMode);
    const launchPermissionMode = PERMISSION_MODES.includes(liveMode) ? liveMode : resolvePermissionMode({ session, config });
    // 代理模式 v2:事件只在【发起时的那个回合】仍是活回合时进它的流(回合结束后 run 继续跑,但不往关掉的 SSE
    // 写、也不串进后来的回合);run 自己的事件日志与 GET /api/agent-runs 始终是权威实时面。
    const onEvent = reg && reg.onEvent ? (evt => { try { ownerCheck(); } catch { return; } const live = activeChildren.get(sessionId); if (live === reg && live.onEvent) live.onEvent(evt); }) : () => {};
    const resolved = await resolveOrchestrateNodes(body, normalizeCwd(session.cwd, config.defaultWorkspace)); ownerCheck();
    if (resolved.error) return (json({ ok: false, error: resolved.error, startedCount: 0 }));
    const wantEnvelope = body.envelope === true;
    // v1.4.4: a persisted DAG's node-count ceiling is agentWorkflowMaxNodes, NOT subagentMaxPerTurn (that's
    // an ad hoc, single-CHAT-TURN spawn_agent/orchestrate_agents fan-out budget — a 4-node default there
    // used to reject any real pipeline with 5+ nodes outright here, even though resuming the same run used
    // a hardcoded 32).
    const contextText = String(body.context || '').trim();
    // 代理模式 v2:完成 → 交付信封进后台任务账本(隐藏的数据面回执 + toast + 下一回合开头注入一次),不再往对话里
    // 追加整份「Agent 工作流已结束」助手消息(那条会被 syncProviderHistoryFromDisplay 抄进模型上下文)。
    const completion = run => deliverAgentRunEnvelope(session.id, run);
    const background = body.async === true || body.background === true;
    // 只有 Claude/Kimi 的 MCP 子进程回环(envelope:true)替模型发起的 background:true 才算「模型起的」:跑完才会唤醒主会话。
    // 面板 / HTTP 的 async:true 是用户点的,信封照常进账本、随下一回合送达,但不替模型起回合。
    const launchedByModel = body.envelope === true && body.background === true;
    if (background) {
      const runId = makeId('run');
      // 与 launchPersistedAgentRun 同款:等到登记进 activeAgentRuns(或登记前就退出)再回。修前发起即回 accepted ——
      // 校验失败(重复节点 id、缺角色、依赖坏)以 { ok:false } 返回却没人看,调用方拿到 runId 却永远等不到这次运行;
      // 受理后立刻 pause / stop / 插话也会被 409「工作流当前未运行」拒掉。
      let markRegistered = null;
      const registered = new Promise(resolve => { markRegistered = resolve; });
      const finished = runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, runIdOverride: runId, onComplete: completion, poolPolicy: body.poolPolicy, parentEngine, parentModel, background: true, launchedByModel, onRegistered: () => markRegistered() }).catch(async e => {
        activeAgentRuns.delete(runId); // 对抗轮 P2: 启动期抛出时兜底清注册(与 launchPersistedAgentRun 的 catch 对齐)
        const run = { schemaVersion: 4, id: runId, sessionId: session.id, turnSeq: session.turnSeq, providerId: provider && provider.id || '', status: 'failed', background: true, launchedByModel, createdAt: nowIso(), updatedAt: nowIso(), completedAt: nowIso(), error: String(e && e.message || e), nodes: [] };
        await saveAgentRun(run).catch(() => {});
        await completion(run).catch(() => {});
        return { ok: false, error: run.error, reported: true };
      });
      const first = await Promise.race([registered.then(() => null), finished]); ownerCheck();
      if (first && first.ok === false && !first.reported) return (json({ ok: false, error: first.error || '工作流未能启动', startedCount: 0 }));
      return (json({ ok: true, accepted: true, background: true, status: 'running', runId, nodes: resolved.nodes.map(n => n && n.id).filter(Boolean), note: '代理已在后台运行;完成后交付信封会自动送达一次(也可 wait_agents 收件);全文用 agent_result 取。' }));
    }
    // 同步:MCP 回环(envelope:true)拿信封,并登记已读(它就是投递本身);UI/管理面(不带 envelope)照旧拿整份结果,
    // 且当没有活回合时把信封投进账本,让模型下一回合知道这件事。
    let completedRun = null;
    const result = await runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: launchPermissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, onComplete: async run => { completedRun = run; }, poolPolicy: body.poolPolicy, parentEngine, parentModel });
    ownerCheck();
    if (wantEnvelope) {
      if (!completedRun) return (json({ ok: false, error: (result && result.error) || '代理启动失败', runId: result && result.runId || '', startedCount: 0 }));
      if (EventStreamHooks.markAgentEnvelopeDelivered) {
        const liveReg = ownerReg || activeChildren.get(sessionId);
        if (liveReg && liveReg.session) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, completedRun.id);
        else await mutateSession(sessionId, fresh => { ownerCheck(); EventStreamHooks.markAgentEnvelopeDelivered(fresh, completedRun.id); }, { writer: 'agent_envelope_delivered' }).catch(() => {}); // 读-改-写走 mutateSession
      }
      return (json(buildAgentRunEnvelope(completedRun)));
    }
    if (completedRun && !activeChildren.has(session.id)) await completion(completedRun).catch(() => {});
    return (json(result));

}

async function cliQuestionService(body, { method = 'POST', trusted = false, ownerReg = null, ownerCheck = () => {}, isClosed = () => false } = {}) {
  ownerCheck();

    // Called by request_user_input in the per-session Claude MCP child. Hold the tool call until the UI
    // answers, then return a normal MCP tool result. Provider turns use the same registry in-process.
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return (apiSessionIdInvalid());
    const reg = ownerReg || activeChildren.get(sessionId);
    if (!reg || !reg.onEvent) return (apiFailure('question.no_active_turn', {}, 'no active UI stream to prompt', 409));
    const config = await readConfig(); ownerCheck();
    ownerCheck(); const answer = await requestUserQuestion(sessionId, makeId('question'), body.questions, reg.onEvent, config.questionTimeoutMs, reg.questionContext || ''); ownerCheck();
    return (json(answer && answer.ok
      ? { ok: true, answers: answer.answers, content: answer.content }
      : { ok: false, error: (answer && (answer.error || answer.content)) || 'question cancelled' }));

}

async function cliPermissionService(body, { method = 'POST', trusted = false, ownerReg = null, ownerCheck = () => {}, isClosed = () => false } = {}) {
  ownerCheck();

    // Called by the permission-bridge MCP tool (loopback). Holds until the UI decides or times out.
    const config = await readConfig(); ownerCheck();
    const sessionId = String(body.sessionId || '');
    const reg = ownerReg || activeChildren.get(sessionId);
    const requestId = makeId('perm');
    if (!reg || !reg.onEvent) {
      // No live UI stream to ask — fail closed.
      return (json({ behavior: 'deny', message: 'no active UI to prompt', requestId }));
    }
    // 审计 A② 后续(CLI 直挂面):toolLoadingMode:'full' 时桥接服务器(ACC 等)直接写进 --mcp-config,由 CLI 自己调,
    // 不经工作台的三个分发点 —— 唯一还能插手的地方就是这里:CLI 为 mcp__<server>__<tool> 来问权限时,按与分发点
    // 同一个 bridgedReadPathGate 判读路径,越界 / 内部数据 / 相对路径直接拒(不弹窗、不走授权书、不走 auto 短路)。
    // 覆盖不到的:CLI 不来问的时候 —— bypass / auto 档(不带 --permission-prompt-tool)与 exec 档 DAG 节点(bypass 起)。
    // 如意自己的 MCP 工具(mcp__ruyi__*)在它自己的 toolCall 里已有文件闸,这里不重复判。
    {
      const cliToolName = String(body.toolName || '');
      if (cliToolName.startsWith('mcp__') && !cliToolName.startsWith(RUYI_MCP_CLI_TOOL_PREFIX)) {
        // 2026-10 能力总闸(纵深):CLI 直挂的内置桌面 MCP(mcp__ai-computer-control__<tool>)来问权限时,按与 09/08/12 同一个
        // toolDisabledByPolicy 判,被 allowCommandTools / allowDesktopTools(+ 这条线程的 desktopTools)关掉的直接拒,不弹窗。
        // 主防线在源头:01 把同一张表算成 ACC_HIDE_TOOLS 交给 ACC,它根本不注册这些工具;这里兜的是旧版 ACC(不认该变量)。
        // 同样覆盖不到 CLI 不来问的档(bypass / auto、exec 档 DAG 节点)—— 那几档只靠源头裁剪。
        const accPrefix = `mcp__${DESKTOP_MCP_SERVER_ID}__`;
        if (cliToolName.startsWith(accPrefix)) {
          const policyOff = toolDisabledByPolicy(cliToolName, config, sessionDesktopToolsOf(reg.session),
            { serverId: DESKTOP_MCP_SERVER_ID, toolName: cliToolName.slice(accPrefix.length) });
          if (policyOff) {
            logEvent({ kind: 'permission_bridge_policy_deny', sessionId, tool: cliToolName, reason: policyOff });
            return (json({ behavior: 'deny', message: toolDisabledResult(cliToolName, policyOff).error, requestId }));
          }
        }
        const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
        const readRefusal = await bridgedReadPathGate(cliToolName, input, { sessionId, session: reg.session, config }); ownerCheck();
        if (readRefusal) {
          logEvent({ kind: 'permission_bridge_path_deny', sessionId, tool: cliToolName, code: readRefusal.code || '' });
          return (json({ behavior: 'deny', message: readRefusal.error || 'path not allowed', requestId }));
        }
      }
    }
    // v0.8-S4b: mirror the native path — carry tier + revertible so the popup renders the badge + the
    // revertibility line for CLI-bridge permission prompts too. The CLI reports its own tool names (Edit/
    // Write/Bash/…); toolIsRevertible only matches the workbench file_* set, so a native CLI Edit shows
    // 「无法自动撤销」(correct: CLI-native edits don't pass through toolCall → aren't journaled).
    // 第27波:CLI 桥授权书消耗点。命中直接 allow —— 连 permission_request 事件都不发(免弹窗静默放行)。工具名按 CLI
    // 弹窗实际显示的 Claude 名(Bash/Edit/Write)匹配,与签发卡片同名口径。范围外回落到下方正常弹窗。session 仅需 .id。
    const bridgeTier = Object.prototype.hasOwnProperty.call(CLI_TOOL_TIER, String(body.toolName || '')) ? CLI_TOOL_TIER[String(body.toolName)] : nativeToolTier(String(body.toolName || ''));   // CLI 报的是 Claude 名(Edit/Write/Bash),查 CLI 表;修前查原生表,一律落成 exec
    // 117m-A3(配 A1 的 D1):高风险判据要吃到工具名与入参,否则 CLI 桥这一侧的 auto 档还是老口径。
    // 审计 C:按【这一回合】的实效档判,不按全局档。runClaudeTurn 登记活回合时记下了 spawn CLI 用的解析档
    // (请求级 > 会话级 > 全局,10 runSessionTurn 解析);修前读 config.permissionMode —— 全局 auto 时,一条被
    // 收紧到 default/plan 的线程(或交办卡/定时任务的请求级收紧)经 CLI 桥发来的 edit/exec 请求被静默放行。
    // 登记表上没有这个值(Kimi 等其它引擎)就按会话头 + 全局解析,仍比「只看全局」更紧或相等。
    const bridgeMode = String((reg && reg.permissionMode) || resolvePermissionMode({ session: reg && reg.session, config }) || '');
    const bridgeGate = nativeToolGate(bridgeMode, bridgeTier, String(body.toolName || ''), body.input || {});
    // auto 档的低风险动作在原生引擎里已经不弹窗了,CLI 桥必须同口径 —— 否则同一个「全自动」在两个引擎
    // 下行为不一致。只对 auto 档短路(其余档位一行不变:read/bypass 的既有落点仍走下面那条路)。
    if (bridgeMode === 'auto' && bridgeGate === 'allow') {
      return (json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    // 对抗轮 P3(天花板对称):与 native 主 gate 对齐 —— 仅当工作台自身权限模式对该档判定为 'ask' 时才允许授权书降级。
    // 工作台若处于 plan 模式(该档判 'block'),即便 CLI 发来请求也不放行(子集律:授权书永不把 block 提升为 allow),
    // 回落到下方正常弹窗由人定夺。default→'ask' 授权书生效;bypass→'allow' 本就免弹窗,无需授权书。
    if (bridgeGate === 'ask') {
      const grantHit = consumeGrant({ id: sessionId }, String(body.toolName || ''), body.input || {}, 'cli', null);
      // 第42b波(live 冒烟擒获):CLI ≥2.1 的 zod union 要求 allow 变体【必须】带 updatedInput record,
      // 裸 {behavior:'allow'} 会被 CLI 判 invalid_union 拒掉 → 回显原始输入。
      if (grantHit) return (json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    ownerCheck(); reg.onEvent({ type: 'permission_request', requestId, toolName: body.toolName, input: body.input, tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    registerIntervention(sessionId, 'permission', requestId, {
      toolName: String(body.toolName || ''), tier: bridgeTier, revertible: toolIsRevertible(body.toolName),
      input: body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {},
    });
    // 第27f波:CLI 桥超时→存档暂停(与 provider 路径对称)。仅【opt-in + 本会话处于无人值守 driverAuto 回合】才启用;
    // 否则维持"超时即拒杀"安全默认。两段定时:基础超时→检查点(logEvent+saveSession)+ permission_paused 事件 + 延长到 TTL;
    // TTL 内无决定则回落 deny(fail-closed)。entry.timer 重赋为 TTL 定时器,/api/permission/decision 与 clearPendingPermissions 照常清对。
    const ownerAlive = () => { try { ownerCheck(); return true; } catch { return false; } };
    const cliPause = config.autonomyPauseOnTimeout && driverAutoSessions.has(sessionId);
    const decision = await new Promise(resolve => {
      // 128f-⑪:「等多久」问 04 的 permissionWaitMs(修前这一支只认 config,定时线程上的 CLI 引擎也是 120 s)。
      const baseMs = permissionWaitMs(sessionId, config, reg && reg.session);
      const entry = { resolve, sessionId, timer: null, deadlineAt: Date.now() + baseMs };
      const clearExpiredOwner = () => {
        if (ownerAlive()) return false;
        // Registry cleanup belongs to the intervention command core, not to a stale CLI grant.
        // Clear only this request: a replacement turn may already have another pending prompt.
        const note = 'originating CLI execution ended';
        runAutomaticInterventionDecision({
          missionId: sessionId, interventionId: requestId, source: 'clear_permission', decidedBy: 'clear',
          idempotencyKey: `clear:${requestId}`, payload: { action: 'deny', message: note },
        }, () => {
          if (pendingPermissions.get(requestId) !== entry || entry.commandApplying) return;
          pendingPermissions.delete(requestId);
          resolve({ behavior: 'deny', message: note });
          settleIntervention(sessionId, requestId, 'denied', { decidedBy: 'clear', note });
        });
        return true;
      };
      if (cliPause) {
        entry.timer = setTimeout(() => {
          if (clearExpiredOwner()) return;
          if (reg) reg.pausePending = true; // 第27f波:存档暂停期间豁免子进程 idle 看门狗(否则 TTL 内先杀子,窗口被截断)
          try { logEvent({ kind: 'permission_paused', sessionId, tool: String(body.toolName || ''), tier: bridgeTier, requestId, engine: 'claude' }); } catch { /* ignore */ }
          loadSession(sessionId).then(s => { ownerCheck(); return s && saveSession(s); }).catch(() => {}); // 检查点:会话已在磁盘,重写一遍固化
          try { reg.onEvent({ type: 'permission_paused', requestId, toolName: body.toolName, tier: bridgeTier, ttlMs: config.autonomyPauseTtlMs }); } catch { /* stream gone */ }
          entry.deadlineAt = Date.now() + Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000);   // 128f-⑪:存档暂停把窗口延长了
          entry.timer = setTimeout(() => {
          if (clearExpiredOwner()) return;
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
          if (clearExpiredOwner()) return;
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
    ownerCheck();
    try { reg.onEvent({ type: 'permission_decision', requestId, behavior: decision && decision.behavior === 'allow' ? 'allow' : 'deny', message: decision && decision.message }); } catch { /* stream gone */ }
    if (reg) { reg.pausePending = false; reg.lastEventAt = Date.now(); } // 解除暂停豁免 + 重置看门狗时钟(暂停不算子进程空闲)
    if (isClosed()) return; // request already gone (e.g. child died)
    // 第42b波(live 冒烟擒获):CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union —— allow 变体必须
    // 带 updatedInput record;UI 纯「允许」(未改输入)时 decision.updatedInput 为 undefined,JSON 序列化
    // 掉键后被 CLI 拒(invalid_union: expected record, received undefined)→ 回合必败。回填原始输入。
    if (decision && decision.behavior === 'allow' && (typeof decision.updatedInput !== 'object' || decision.updatedInput === null || Array.isArray(decision.updatedInput))) {
      decision.updatedInput = body.input || {};
    }
    return (json(decision));

}

async function cliAgentResultService(body, kind, { ownerReg = null, ownerCheck = () => {} } = {}) {
  ownerCheck();

  const sessionId = safeSessionId(body.sessionId);
  if (!sessionId) return (apiSessionIdInvalid());
  const liveReg = ownerReg || activeChildren.get(sessionId);
  const markSession = async runIds => {
    ownerCheck();
    if (!EventStreamHooks.markAgentEnvelopeDelivered || !runIds.length) return;
    if (liveReg && liveReg.session) { for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(liveReg.session, id); return; }
    // 没有活回合:读-改-写走 mutateSession(撤回闸/写链纪律,见 02 头注),不直接 saveSession。
    await mutateSession(sessionId, fresh => { ownerCheck(); for (const id of runIds) EventStreamHooks.markAgentEnvelopeDelivered(fresh, id); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
  };
  if (kind === 'wait') {
    const out = await waitForAgentRunResults(sessionId, body.runIds, resolveWaitAgentsMs(body.timeoutMs), null, () => { try { ownerCheck(); if (liveReg) liveReg.lastEventAt = Date.now(); } catch { /* expired request cannot refresh the old turn */ } });   // 等待窗内 Claude/Kimi 父回合的看门狗不算空闲(MCP 子进程里的 wait_agents 期间 CLI 没有任何输出)
    ownerCheck();
    // 与 provider 回合同一套结算(settleWaitEnvelopes):通知先到 → 短回执;wait 先到 → 登记已读。
    if (liveReg && liveReg.session) settleWaitEnvelopes(liveReg.session, out);
    else {
      const snapshot = await loadSession(sessionId); ownerCheck();
      if (snapshot) {
        settleWaitEnvelopes(snapshot, out);
        const marked = Array.isArray(snapshot.backgroundJobSeen) ? snapshot.backgroundJobSeen : [];
        await mutateSession(sessionId, fresh => { ownerCheck(); fresh.backgroundJobSeen = [...new Set([...(Array.isArray(fresh.backgroundJobSeen) ? fresh.backgroundJobSeen : []), ...marked])].slice(-100); }, { writer: 'agent_envelope_delivered' }).catch(() => {});
      }
    }
    return (json(out));
  }
  const out = await agentRunResultSlice({ sessionId, runId: body.runId, nodeId: body.nodeId, maxChars: body.maxChars, offset: body.offset }); ownerCheck();
  if (out && out.ok && out.live !== true && AGENT_RUN_TERMINAL.has(String(out.runStatus))) await markSession([out.runId]);
  return (json(out));

}

Object.assign(CliBusinessHooks, { todo: cliTodoService, mission: cliMissionService, agentLaunch: cliAgentLaunchService, question: cliQuestionService, permission: cliPermissionService, agentResult: cliAgentResultService });

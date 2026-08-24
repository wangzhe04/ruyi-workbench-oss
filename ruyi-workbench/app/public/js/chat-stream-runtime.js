'use strict';

export function createChatStreamRuntime(deps = {}) {
  const {
    $,
    api,
    apiErrText,
    appendToolOutput,
    authHeaders,
    autoGrow,
    cliMissingCard,
    compactNarrativeProcessRuns,
    currentEngineMeta,
    currentWorkspace,
    el,
    engineLabel,
    errorCard,
    emitSessionStream = () => {},
    fmtTokens,
    handleAgentWorkflowEvent,
    handlePermissionRequest,
    handlePlanEvent,
    highlightIn,
    iconTextBtn,
    isProviderMode,
    isUntitledTitle,
    latestUsage,
    loadAutonomyGrants,
    maybeScrollToBottom,
    messageShell,
    msgActions,
    narrativeQuestionCard,
    narrativeSemanticCard,
    narrativeToolAnchor,
    newSession,
    openModal,
    pushRawEvent,
    refreshSessions,
    refreshToolPane = () => {},
    renderAttachments,
    renderAutonomyBar,
    renderContextMeter,
    renderCurrentSession,
    renderGitDiffInto,
    renderMarkdown,
    renderMissionBar,
    renderResumeBanner,
    renderSessions,
    renderStaticMessage,
    renderStepBar,
    safeStringify,
    scrollMessagesToBottom,
    settleLiveThinking,
    showAskUserModal,
    state,
    suggestMemoryFromTurn = async () => {},
    switchSettingsTab,
    t,
    thinkingPanel,
    toast,
    toolCard,
    toolGroupSummaryText,
    turnArtifactChips,
    turnSummaryCard,
    turnToolIndexCard,
    updateContextMeter,
    updateJumpLatest,
    usageLine,
    wbNativeClaudeFinalize,
    wbNativeClaudeOnSubagent,
    wrapPreWithCopy,
  } = deps;

  /* ---------------- streaming turn ---------------- */
  // One live stream per session. Switching sessions only changes which entry drives the composer; it never
  // aborts another session's request. Streams for background sessions keep draining so the server connection
  // stays alive, and their final persisted message appears when that session is opened again.
  const activeTurns = new Map(); // sessionId -> { abort, startedAt, eventLines, eventChars, live, main }
  function notifySessionStream(event) {
    try { emitSessionStream(event); } catch { /* Preview observer is best-effort and never owns execution */ }
  }
  // One-shot preference for the next ordinary user message. It is intentionally not persisted in a
  // session or localStorage: sending the message consumes the preference and immediately resets the UI.
  let agentTeamTurnEnabled = false;
  function agentTeamAvailable() {
    return Number(state.config && state.config.subagentMaxPerTurn) > 0;
  }
  function updateAgentTeamButton() {
    const btn = $('agentTeamBtn');
    if (!btn) return;
    const available = agentTeamAvailable();
    if (!available) agentTeamTurnEnabled = false;
    btn.disabled = Boolean(state.streaming) || !available;
    btn.setAttribute('aria-pressed', agentTeamTurnEnabled ? 'true' : 'false');
    btn.title = available
      ? t(agentTeamTurnEnabled ? 'composer.agentTeam.activeTitle' : 'composer.agentTeam.title')
      : t('composer.agentTeam.unavailableTitle');
    btn.setAttribute('aria-label', t('composer.agentTeam.label'));
    iconTextBtn(btn, 'agents', t(agentTeamTurnEnabled ? 'composer.agentTeam.active' : 'composer.agentTeam.label'));
  }
  function toggleAgentTeamTurn() {
    if (!agentTeamAvailable() || state.streaming) return;
    agentTeamTurnEnabled = !agentTeamTurnEnabled;
    updateAgentTeamButton();
  }
  const ACTIVE_TURN_EVENT_CAP = 2_000_000;
  // Re-parsing an ever-growing Markdown document on every token is O(n^2) and eventually monopolizes the UI
  // thread. Stream as incremental plain text, then perform one bounded Markdown pass when the turn settles.
  const MARKDOWN_SYNC_MAX_CHARS = 48_000;
  function attachLiveTextNode(live, bubble) {
    bubble.textContent = '';
    bubble.classList.add('live-plain');
    live.bubble = bubble;
    live.textNode = document.createTextNode('');
    live.renderedChars = 0;
    bubble.appendChild(live.textNode);
  }
  function startLiveTextSegment(live) {
    if (!live || !live.narrative) return null;
    compactNarrativeProcessRuns(live.narrative);
    live.completedRun = [];
    live.completedGroup = null;
    const bubble = el('div', 'bubble md stream-cursor');
    live.bufferText = '';
    attachLiveTextNode(live, bubble);
    live.narrative.appendChild(bubble);
    return bubble;
  }
  function ensureLiveTextSegment(live) {
    return live && live.bubble && live.bubble.isConnected ? live.bubble : startLiveTextSegment(live);
  }
  function sealLiveTextSegment(live, dropIfText) {
    if (!live || !live.bubble) return;
    if (live.rafId) { cancelAnimationFrame(live.rafId); live.rafId = 0; }
    live.rafPending = false;
    const bubble = live.bubble;
    const text = String(live.bufferText || '');
    const drop = dropIfText != null && text.trim() === String(dropIfText || '').trim();
    bubble.classList.remove('stream-cursor', 'live-plain');
    if (!text || drop) bubble.remove();
    else if (text.length <= MARKDOWN_SYNC_MAX_CHARS) {
      bubble.classList.remove('plain'); bubble.innerHTML = renderMarkdown(text); highlightIn(bubble);
    } else { bubble.classList.add('plain'); bubble.textContent = text; }
    live.bubble = null; live.textNode = null; live.bufferText = ''; live.renderedChars = 0;
  }
  function registerNarrativeTool(live, evt, card) {
    if (!live || !card) return;
    sealLiveTextSegment(live);
    const anchorId = narrativeToolAnchor(evt.id, state.currentSession && state.currentSession.turnSeq);
    if (anchorId !== 'turn-tool-') card.d.id = anchorId;
    live.narrative.appendChild(card.d);
    const batchId = String(evt.batchId || `single-${evt.id || live.toolIndex.length}`);
    let batch = live.toolBatches.get(batchId);
    if (!batch) { batch = { id: batchId, items: [], group: null }; live.toolBatches.set(batchId, batch); }
    const item = { id: evt.id, card: card.d, done: false, error: false, status: 'running', anchorId, tc: { id: evt.id, name: evt.name, input: evt.input } };
    batch.items.push(item); live.toolIndex.push(item);
    if (batch.group) {
      batch.group._tgBody.appendChild(card.d);
      batch.group._tgLabel.textContent = toolGroupSummaryText(batch.items.length);
    }
  }
  function settleNarrativeTool(live, id, isError) {
    if (!live) return;
    let owner = null, item = null;
    for (const batch of live.toolBatches.values()) {
      item = batch.items.find(candidate => String(candidate.id) === String(id));
      if (item) { owner = batch; break; }
    }
    if (!owner || !item) return;
    item.done = true; item.error = Boolean(isError); item.status = isError ? 'error' : 'done';
    if (owner.items.length < 2) {
      if (item.error) { live.completedRun = []; live.completedGroup = null; return; }
      if (!Array.isArray(live.completedRun)) live.completedRun = [];
      live.completedRun.push(item);
      if (live.completedRun.length === 2) {
        const group = el('details', 'tool-group narrative-tool-batch narrative-completed-run');
        const sum = el('summary', 'tool-group-sum');
        sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', toolGroupSummaryText(live.completedRun.length)));
        const body = el('div', 'tool-group-body');
        group.append(sum, body);
        live.completedRun[0].card.before(group);
        for (const entry of live.completedRun) body.appendChild(entry.card);
        group._tgBody = body; group._tgLabel = sum.querySelector('.tg-label');
        live.completedGroup = group;
      } else if (live.completedRun.length > 2 && live.completedGroup) {
        live.completedGroup._tgBody.appendChild(item.card);
        live.completedGroup._tgLabel.textContent = toolGroupSummaryText(live.completedRun.length);
      }
      return;
    }
    live.completedRun = []; live.completedGroup = null;
    // A parallel Claude/provider batch remains as individual rows while any member is still running. Folding
    // only after the whole batch settles keeps the current action visible instead of hiding it mid-flight.
    if (!owner.items.every(entry => entry.done)) return;
    if (!owner.group) {
      const first = owner.items[0].card;
      const group = el('details', 'tool-group narrative-tool-batch');
      const sum = el('summary', 'tool-group-sum');
      sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', toolGroupSummaryText(owner.items.length)));
      const body = el('div', 'tool-group-body');
      group.append(sum, body); group._tgBody = body; group._tgLabel = sum.querySelector('.tg-label');
      first.before(group);
      for (const entry of owner.items) body.appendChild(entry.card);
      owner.group = group;
    }
    owner.group._tgLabel.textContent = toolGroupSummaryText(owner.items.length);
  }
  function createLiveAssistantShell() {
    const box = $('messages');
    const { row, main } = messageShell('assistant', new Date().toISOString(), currentEngineMeta());
    const live = { thinkingText: '', thinkingActive: false, bufferText: '', thinkingEl: null, thinkingNode: null, bubble: null, textNode: null, renderedChars: 0, toolCards: new Map(), toolBatches: new Map(), toolIndex: [], subCards: new Map(), workflowCards: new Map(), semanticCards: new Map(), semanticData: new Map(), completedRun: [], completedGroup: null, rendered: false, rafPending: false, rafId: 0, thinkingFollowTimer: 0, followThinkingPanel: false };
    live.narrative = el('div', 'turn-narrative');
    main.appendChild(live.narrative);
    live.toolsWrap = live.narrative; // compatibility host for sub-agent/workflow cards
    startLiveTextSegment(live);
    box.appendChild(row); scrollMessagesToBottom(); // EC-D 57: 新 turn 开始 -> 恢复跟随最新
    return { live, main };
  }
  function rememberTurnLine(turn, line) {
    if (!turn || !line || !line.trim()) return;
    // raw_line is already available in the debug stream and can be extremely large; the visible
    // progress replay only needs normalized events.
    try { if (JSON.parse(line).type === 'raw_line') return; } catch { return; }
    turn.eventLines.push(line); turn.eventChars += line.length;
    turn.eventHead = Number(turn.eventHead) || 0;
    while (turn.eventChars > ACTIVE_TURN_EVENT_CAP && turn.eventLines.length - turn.eventHead > 1) {
      turn.eventChars -= turn.eventLines[turn.eventHead++].length;
    }
    // Array.shift() moved the entire replay log on every post-cap delta. A logical head makes eviction O(1);
    // compact only occasionally so a multi-megabyte stream never creates an input/scroll freeze.
    if (turn.eventHead > 2048 && turn.eventHead * 2 >= turn.eventLines.length) {
      turn.eventLines = turn.eventLines.slice(turn.eventHead);
      turn.eventHead = 0;
    }
  }
  function surfaceBackgroundQuestion(line, sessionId) {
    let evt; try { evt = JSON.parse(line); } catch { return; }
    if (evt?.type === 'ask_user') showAskUserModal(evt.questionId || evt.id, evt.questions, sessionId, evt.context || '');
  }
  function mountActiveTurn(sessionId) {
    const turn = activeTurns.get(sessionId);
    if (!turn || state.currentSession?.id !== sessionId) return;
    const box = $('messages');
    box.querySelector('.empty-state')?.remove();
    if (turn.optimisticUserRow && !turn.optimisticUserRow.isConnected) box.appendChild(turn.optimisticUserRow);
    const shell = createLiveAssistantShell(); turn.live = shell.live; turn.main = shell.main;
    // Coalesce tiny deltas while preserving tool/workflow boundaries. Keep this shell live: finalizing it here
    // detaches its text node, so subsequent deltas otherwise remain invisible until the terminal full reload.
    let textParts = [], thinkingParts = [];
    const flush = () => {
      if (thinkingParts.length) { handleStreamLine(JSON.stringify({ type: 'thinking_delta', text: thinkingParts.join('') }), turn.live, turn.main, sessionId); thinkingParts = []; }
      if (textParts.length) { handleStreamLine(JSON.stringify({ type: 'assistant_delta', text: textParts.join('') }), turn.live, turn.main, sessionId); textParts = []; }
    };
    for (let index = Number(turn.eventHead) || 0; index < turn.eventLines.length; index++) {
      const line = turn.eventLines[index];
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'session') continue;
      if (evt.type === 'ask_user' && turn.answeredQuestions?.has(String(evt.questionId || evt.id || ''))) continue;
      if (evt.type === 'assistant_delta') { if (thinkingParts.length) flush(); textParts.push(evt.text || ''); continue; }
      if (evt.type === 'thinking_delta') { if (textParts.length) flush(); thinkingParts.push(evt.text || ''); continue; }
      flush(); handleStreamLine(line, turn.live, turn.main, sessionId);
    }
    flush();
  }
  // The proc-dot moved into the model chip (.mc-dot) in v0.7b. setProc now drives that dot's three
  // states (running/stopped/idle) + an engine-aware title, reusing the pulse animation via CSS.
  function setProc(state_) {
    const dot = document.querySelector('#modelChip .mc-dot');
    if (!dot) return;
    dot.className = 'mc-dot' + (state_ ? ` ${state_}` : ' idle');
    dot.title = `${engineLabel()} 进程状态：${state_ || 'idle'}`;
  }
  // Send⇄Stop same-position toggle (§4.3). While streaming, #sendBtn becomes "■ 停止" (danger) wired to
  // stopTurn; otherwise it is "发送 ▷" (primary) wired to sendPrompt. The old topbar #stopBtn is gone.
  // 50-fix(三态):流式中按钮按输入内容分态 —— 输入框【有文本】→「插话」(sendPrompt 路由 /api/steer,不打扰
  // 当前回合);【空输入】→「■ 停止」(stopTurn)。旧行为流式中恒为停止,插话只剩 Enter 一条隐藏路径,
  // 用户"输入后还是停止,不会变成 Steer"(ChatGPT 同款三态:generating + typing → send)。
  function updateSendBtn() {
    const btn = $('sendBtn');
    if (!btn) return;
    const streaming = Boolean(state.streaming);
    const hasText = !!(($('promptInput')?.value || '').trim());
    const steerCapability = activeTurnSteerCapability();
    const steer = streaming && hasText && steerCapability.ok;
    const blockedSteer = streaming && hasText && !steerCapability.ok;
    btn.classList.toggle('danger', streaming && !steer && !blockedSteer);
    btn.classList.toggle('primary', !streaming || steer);
    if (!streaming) { iconTextBtn(btn, 'send', t('chat.send')); btn.onclick = () => sendPrompt(); btn.title = ''; }
    else if (steer) { iconTextBtn(btn, 'send', t('chat.steer')); btn.onclick = () => sendPrompt(); btn.title = t('chat.steerHint'); }
    else if (blockedSteer) { iconTextBtn(btn, 'settings', t('chat.steerEnable')); btn.onclick = showClaudeSteerSetup; btn.title = t('chat.steerEnableHint'); }
    else { iconTextBtn(btn, 'stop', t('common.stop')); btn.onclick = stopTurn; btn.title = ''; }
  }
  function activeTurnSteerCapability() {
    const sid = state.currentSession?.id || '';
    const turn = sid ? activeTurns.get(sid) : null;
    if (turn && turn.engine === 'claude' && !turn.claudeInteractive) {
      return { ok: false, reason: 'claude_requires_interactive' };
    }
    return { ok: true, reason: '' };
  }
  function showClaudeSteerSetup() {
    toast(t('toast.steerRequiresInteractive'), 'err');
    openModal('settingsModal');
    switchSettingsTab('claude', true);
    setTimeout(() => { const mode = $('cfgEngineMode'); if (mode) { mode.focus(); mode.scrollIntoView({ block: 'center' }); } }, 0);
  }
  function setStreaming(on) {
    state.streaming = on;
    // v3 (§B6): 有活动回合即让上下文电量表现身(不再等 60%,两模式一致);无用量数据时 renderContextMeter 自持隐藏。
    if (on) { try { updateContextMeter(); } catch { /* ignore */ } }
    // v0.9-S5: clear any lingering 「AI 在等你批准计划」 hint when a turn ends (stop/error can bypass the card's
    // own finish()). Set fresh by handlePlanEvent while a plan is pending.
    if (!on) { const h = $('composerHint'); if (h) { h.innerHTML = ''; h.style.display = 'none'; } steerPendingList.length = 0; steeredSeen.length = 0; }
    // v1.0.2 (F3): Claude 模式的 /compact 是流式回合 —— 回合结束(setStreaming(false))即压缩完成,收指示条。
    if (!on && compactState.active) endCompactIndicator();
    updateSendBtn(); // 50-fix:发送/插话/停止 三态(原:流式恒停止)
    updateAgentTeamButton();
    updateJumpLatest();
    updateAgentTeamButton();
  }
  function syncStreamingUi() {
    const sid = state.currentSession?.id || '';
    const on = !!sid && activeTurns.has(sid);
    setStreaming(on);
    setProc(on ? 'running' : 'idle');
  }

  // v1.0.2 (F3): 压缩进行中的持续指示。compactState.active 防重入(进行中再点=忽略);indicator 是 composer
  // 上方一条带 spinner 的持续提示条;compactBtn 禁用 + 文案变「压缩中…」;90s 兜底超时恢复防卡死。
  const compactState = { active: false, timer: 0 };
  function beginCompactIndicator() {
    compactState.active = true;
    const btn = $('compactBtn');
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = t('chat.compacting'); }
    // 持续指示条:插在 composer 顶部(resumeBanner 之上),复用 chip/toast 令牌,自带 spinner。
    let bar = $('compactIndicator');
    if (!bar) {
      bar = el('div', 'compact-indicator'); bar.id = 'compactIndicator';
      bar.append(el('span', 'compact-spinner'), el('span', '', t('chat.compactHint')));
      const composer = document.querySelector('.composer');
      if (composer) composer.insertBefore(bar, composer.firstChild);
    }
    bar.classList.remove('hidden');
    // External map-reduce can run several sequential local-model calls (a real 65K Ollama chunk takes
    // ~3 minutes on the reference machine). Keep the stale-UI guard, but do not declare failure while
    // the HTTP request is still legitimately reducing a long history.
    clearTimeout(compactState.timer);
    const indicatorTimeoutMs = state.config?.compactProviderId ? 30 * 60 * 1000 : 5 * 60 * 1000;
    compactState.timer = setTimeout(() => { if (compactState.active) { endCompactIndicator(); toast(t("toast.compactTimeout"), 'err'); } }, indicatorTimeoutMs);
  }
  function endCompactIndicator() {
    compactState.active = false;
    clearTimeout(compactState.timer); compactState.timer = 0;
    const btn = $('compactBtn');
    if (btn) { btn.disabled = false; if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; } }
    const bar = $('compactIndicator');
    if (bar) bar.classList.add('hidden');
  }

  // One-click context compaction, engine-aware (§5.2). Claude mode: send the CLI's built-in /compact (a
  // streaming turn — the indicator clears when that turn ends, via setStreaming(false) → endCompactIndicator).
  // Provider mode: POST /api/provider/compact (server makes one non-streaming summary call and collapses
  // providerHistory), then reload the session and show the before/after estimate.
  async function compactContext() {
    if (compactState.active) return; // F3⑥ 进行中再点=忽略
    if (state.streaming) { toast(t("toast.compactWaitTurn"), ''); return; }
    if (!state.currentSession || !(state.currentSession.messages || []).length) { toast(t("toast.compactEmpty"), ''); return; }
    if (!isProviderMode() && state.config?.agentCliType === 'claude' && !state.config?.compactProviderId) {
      // Claude 模式:/compact 是流式回合。开指示,sendPrompt 走完流后 setStreaming(false) 会调 endCompactIndicator。
      beginCompactIndicator();
      toast(t("toast.compactRequested"), 'ok');
      sendPrompt('/compact');
      return;
    }
    const sid = state.currentSession.id;
    beginCompactIndicator();
    try {
      const endpoint = isProviderMode() ? '/api/provider/compact' : '/api/agent/compact';
      const r = await api(endpoint, { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
      if (!r || !r.ok) { toast(t("toast.compactFail", { p1: (r && r.error) || t('common.unknownError') }), 'err'); return; }
      if (state.currentSession?.id === sid) { const s = await api(`/api/sessions/${sid}`); state.currentSession = s.session; renderCurrentSession(); }
      await refreshSessions();
      toast(t("toast.compactDone", { p1: fmtTokens(r.beforeTokens || 0), p2: fmtTokens(r.afterTokens || 0) }), 'ok');
    } catch (e) { toast(t("toast.compactFail", { p1: apiErrText(e) }), 'err'); }
    finally { endCompactIndicator(); }
  }

  async function sendPrompt(overrideText, options = {}) {
    // v0.8-S7 steering (§4 A3) + 47a 双引擎:任何引擎回合流式中,composer 的发送都变为插话路由到 /api/steer。
    // provider 经队列在下一边界注入;Claude(interactive)经 stdin 即时注入;Claude print 模式由服务器返回
    // 人话错误(print 不支持),toast 呈现——前端不再按引擎静默吞掉输入。
    const selectedId = state.currentSession?.id || '';
    if (selectedId && activeTurns.has(selectedId)) return steerPrompt(overrideText);
    const message = (overrideText != null ? overrideText : $('promptInput').value).trim();
    if (!message) return;
    if (!state.currentSession) await newSession();

    const turnSessionId = state.currentSession.id;
    // Slash-command/override turns (for example /compact) must neither consume nor inherit the visible toggle.
    const agentTeam = overrideText == null && agentTeamTurnEnabled && agentTeamAvailable();
    if (agentTeam) { agentTeamTurnEnabled = false; updateAgentTeamButton(); }
    if (overrideText == null) { $('promptInput').value = ''; autoGrow($('promptInput')); }
    try { localStorage.removeItem('wcw.draft'); } catch { /* ignore */ }

    const box = $('messages');
    box.querySelector('.empty-state')?.remove();
    // Capture & clear attachments now so a failed/aborted turn doesn't silently re-send them.
    // 第96波(P4):交办台(Pretender)经 options.attachments 显式注入附件 —— 不经经典托盘,
    // 也不清空/重绘经典托盘(预览壳下它根本未挂载)。
    const sentAttachments = Array.isArray(options.attachments) ? options.attachments.slice() : state.attachments;
    if (!Array.isArray(options.attachments)) { state.attachments = []; renderAttachments(); }
    // 第69波:留住乐观 user 行的引用 —— 它是合成对象(无 turnSeq、不在 session.messages),其操作条里的
    // 「回溯到此处」必然 toast「无法定位该消息的回合」;回合拿到持久化真身后必须重绑(见下方 finally 前)。
    const optimisticUserRow = renderStaticMessage({ role: 'user', content: message, createdAt: new Date().toISOString(), attachments: sentAttachments });
    box.appendChild(optimisticUserRow);
    // 把乐观行的操作条重绑到持久化的真实 user 消息(按文本自尾向前匹配,跳过 steered)。
    // 成功路径直接用回合末已重取的 session;失败/中止路径单独拉一次。重绑失败无碍 —— 下次全量重渲染自然换真行。
    const rebindOptimisticUserRow = sess => {
      try {
        if (!optimisticUserRow.isConnected || !sess) return;
        const msgs = Array.isArray(sess.messages) ? sess.messages : [];
        let real = null;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'user' && !m.steered && String(m.content || '') === String(message || '')) { real = m; break; }
        }
        if (!real) return;
        const bar = optimisticUserRow.querySelector('.msg-actions');
        if (bar) bar.replaceWith(msgActions(real));
      } catch { /* best-effort */ }
    };

    // Live assistant container — tag it with the current engine so its badge/avatar match the engine
    // producing this reply (the server sends the authoritative meta on the persisted message).
    const shell = createLiveAssistantShell();
    let live = shell.live, main = shell.main;

    const turnAbort = new AbortController();
    const turnEngine = isProviderMode() ? 'openai' : 'claude';
    const turnState = { abort: turnAbort, startedAt: Date.now(), message, optimisticUserRow, eventLines: [], eventHead: 0, eventChars: 0, answeredQuestions: new Set(), live, main,
      engine: turnEngine, agentCliType: state.config?.agentCliType || 'claude',
      claudeInteractive: turnEngine !== 'claude' || state.config?.agentCliType === 'kimi' || state.config.engineMode === 'interactive' };
    activeTurns.set(turnSessionId, turnState);
    notifySessionStream({ type: 'start', sessionId: turnSessionId, message, createdAt: new Date().toISOString() });
    syncStreamingUi();
    renderSessions();
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: authHeaders(), signal: turnAbort.signal,
        body: JSON.stringify({
          sessionId: turnSessionId,
          message,
          cwd: currentWorkspace(),
          attachments: sentAttachments,
          agentTeam,
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        // Keep a bounded normalized event log for background replay. Returning to this session while
        // it is still running reconstructs all progress instead of showing only the initial user message.
        for (const line of lines) {
          rememberTurnLine(turnState, line);
          notifySessionStream({ type: 'event', sessionId: turnSessionId, line });
          if (state.currentSession?.id === turnSessionId) {
            live = turnState.live; main = turnState.main;
            handleStreamLine(line, live, main, turnSessionId);
          } else surfaceBackgroundQuestion(line, turnSessionId);
        }
      }
      if (buf.trim()) {
        rememberTurnLine(turnState, buf);
        notifySessionStream({ type: 'event', sessionId: turnSessionId, line: buf });
        if (state.currentSession?.id === turnSessionId) handleStreamLine(buf, turnState.live, turnState.main, turnSessionId);
        else surfaceBackgroundQuestion(buf, turnSessionId);
      }
      finalizeLive(turnState.live);
      await refreshSessions();
      if (state.currentSession?.id === turnSessionId) {
        const r = await api(`/api/sessions/${turnSessionId}`);
        state.currentSession = r.session; state.resumable = r.resumable || null;
        rebindOptimisticUserRow(r.session); // 第69波:乐观行的「回溯到此处」重绑到持久化真身
        // The live DOM already contains this complete turn. Rebuilding it here parses/highlights the same long
        // answer a second time and causes the characteristic end-of-stream stall.
        $('sessionTitle').textContent = isUntitledTitle(r.session?.title) ? t('navigation.workbench') : r.session.title.trim();
        $('sessionMeta').textContent = r.session?.cwd || '';
        renderStepBar(r.session && r.session.todos);
        renderMissionBar(r.session && r.session.mission);
        renderContextMeter(latestUsage(r.session));
        renderResumeBanner();
      }
      // 不阻塞回合解锁：两引擎都可能通过 workbench_memory_propose 提交待确认候选；provider 还会
      // 运行自动审稿。服务端通常静默返回 proposal:null，只有真正的 pending 才追加卡片。
      if (turnState.live && turnState.live.resultOk === true && state.currentSession?.id === turnSessionId) {
        Promise.resolve().then(() => suggestMemoryFromTurn(turnSessionId, turnState.live.narrative || turnState.main)).catch(() => {});
      }
    } catch (err) {
      // C6: aborts read as a neutral note (.msg-note), real failures as a red .msg-error block — not
      // stuffed into the markdown buffer. finalizeLive still renders whatever text streamed before this.
      if (err.name === 'AbortError') { appendMsgNote(main, live, t('status.stopped')); toast(t("toast.turnStopped")); }
      else { appendMsgError(main, live, apiErrText(err)); toast(t("toast.error", { p1: apiErrText(err) }), 'err'); }
      finalizeLive(live);
      // 失败/中止路径没有成功路径的回合末重取 —— 单独拉一次,把乐观行的操作条重绑到持久化真身。
      api(`/api/sessions/${turnSessionId}`).then(s => rebindOptimisticUserRow(s && s.session)).catch(() => {});
    } finally {
      activeTurns.delete(turnSessionId);
      notifySessionStream({ type: 'settled', sessionId: turnSessionId });
      syncStreamingUi();
      renderSessions();
    }
  }

  // v0.8-S7 steering (§4 A3) + Agent CLI adapters. Called when the composer sends WHILE a turn streams.
  // Provider injects at an iteration boundary, Claude interactive writes stdin immediately, and Kimi ACP
  // queues a same-session follow-up prompt (the current ACP revision has no native mid-prompt steer method).
  // On success clears the input, toasts (按 r.injected 区分即时/下步生效), and optimistically renders the user's
  // interjection in the message flow with a muted 「插话」 badge. The server also emits a `steered` event when it
  // actually injects the text — steeredSeen dedups that echo against this optimistic render (by text within a short time window).
  const steeredSeen = []; // [{text, ts}] recently rendered locally, for `steered`-event dedup(不限时,逐条 splice;cap 50)

  // v1.9.0: 插话队列可视化——在客户端维护一份「已发送但尚未被模型消费」的待注入列表。
  // 每次 steerPrompt 排队成功后 push;收到 steered 事件时 splice 已注入项;回合结束清空。
  // composerHint 从纯文本升级为卡片列表,每条显示截断文本 + ×撤回按钮 + 清空队列。
  const steerPendingList = []; // [{text, ts}]

  function renderSteerQueue() {
    const h = $('composerHint');
    if (!h) return;
    if (!steerPendingList.length) { h.innerHTML = ''; h.style.display = 'none'; return; }
    h.style.display = '';
    const n = steerPendingList.length;
    const queuedCount = steerPendingList.filter(p => !p.injected).length; // v1.9.1: provider 排队项数(Claude injected 不计)
    // Never interpolate user-provided steer text into innerHTML or inline onclick. Besides XSS, quoted text
    // would break the old onclick attribute. textContent + listeners keep both short and truncated strings safe.
    const card = el('div', 'steer-queue' + (queuedCount ? '' : ' injected'));
    const header = el('div', 'steer-queue-head');
    const title = el('span', 'steer-queue-title');
    // v1.9.1: 混合态优先显「插话队列」(还有排队项);全已注入显「已注入」(Claude 即时注入确认)
    title.textContent = `${t(queuedCount > 0 ? 'chat.steerQueueTitle' : 'chat.steerInjectedTitle')} · ${n}`;
    header.appendChild(title);
    if (queuedCount > 1) {
      const clear = el('button', 'steer-queue-clear');
      clear.type = 'button'; clear.textContent = t('chat.steerClearAll');
      clear.addEventListener('click', () => { void window.cancelSteer('', true); });
      header.appendChild(clear);
    }
    card.appendChild(header);
    const items = el('div', 'steer-queue-items');
    for (const pending of steerPendingList) {
      const item = el('div', 'steer-queue-item' + (pending.injected ? ' is-injected' : ''));
      const text = el('span', 'steer-queue-text');
      text.title = pending.text;
      const truncated = pending.text.length > 80 ? pending.text.slice(0, 80) + '…' : pending.text;
      text.textContent = truncated;
      item.append(text, el('span', 'steer-queue-state', pending.injected ? t('chat.steerInjectedTitle') : t('chat.steerQueueTitle')));
      if (pending.injected) {
        // Claude 即时注入不可撤回(后端 DELETE 会拒绝),不显示 × 按钮
      } else {
        const cancel = el('button', 'steer-queue-cancel');
        cancel.type = 'button'; cancel.textContent = '×'; cancel.title = t('chat.steerCancelAria'); cancel.setAttribute('aria-label', t('chat.steerCancelAria'));
        cancel.addEventListener('click', () => { void window.cancelSteer(encodeURIComponent(pending.text)); });
        item.append(cancel);
      }
      items.appendChild(item);
    }
    card.appendChild(items);
    h.replaceChildren(card);
  }
  // cancelSteer: 从队列中撤回一条插话。clearAll 是独立控制参数，绝不复用用户文本作哨兵值。
  window.cancelSteer = async function(encodedText, clearAll = false) {
    let text = '';
    if (!clearAll) {
      try { text = decodeURIComponent(encodedText); } catch { return; }
    }
    if (!state.currentSession?.id) return;
    if (clearAll) {
      // 批量撤回:逐条调用 DELETE,忽略单条失败(可能已被模型消费)。跳过 Claude injected 项(不可撤回,DELETE 恒失败)。
      const items = [...steerPendingList];
      for (const p of items) {
        if (p.injected) continue; // v1.9.1: Claude injected 项不可撤回,跳过
        try { await api('/api/steer', { method: 'DELETE', body: JSON.stringify({ sessionId: state.currentSession.id, text: p.text }) }); } catch {}
      }
      // v1.9.1: 只移除快照中的非 injected 项,不 length=0 --否则 await 期间并发新 steer 会被误清(对抗验证发现)。
      for (const p of items) {
        if (p.injected) continue;
        const i = steerPendingList.indexOf(p);
        if (i >= 0) steerPendingList.splice(i, 1);
      }
    } else {
      try {
        const r = await api('/api/steer', { method: 'DELETE', body: JSON.stringify({ sessionId: state.currentSession.id, text }) });
        if (r && r.ok) {
          const idx = steerPendingList.findIndex(p => p.text === text && !p.injected); // v1.9.1: 不匹配 Claude injected 项(不可撤回)
          if (idx >= 0) steerPendingList.splice(idx, 1);
        } else {
          toast(t('toast.steerFail', { p1: r?.error ? apiErrText(r.error) : t('common.unknownError') }), 'err');
        }
      } catch (e) { toast(t('toast.steerFail', { p1: apiErrText(e) }), 'err'); }
    }
    renderSteerQueue();
  };

  async function steerPrompt(overrideText) {
    const text = (overrideText != null ? overrideText : $('promptInput').value).trim();
    if (!text) return;
    if (!state.currentSession?.id) return;
    if (!activeTurnSteerCapability().ok) { showClaudeSteerSetup(); return; }
    try {
      const r = await api('/api/steer', { method: 'POST', body: JSON.stringify({ sessionId: state.currentSession.id, text }) });
      if (!r || !r.ok) { toast(t("toast.steerFail", { p1: r?.error ? apiErrText(r.error) : t('common.unknownError') }), 'err'); return; }
      if (overrideText == null) { $('promptInput').value = ''; autoGrow($('promptInput')); updateSendBtn(); } // 50-fix:清空后按钮回落「停止」
      steeredSeen.push({ text, ts: Date.now() });
      if (steeredSeen.length > 50) steeredSeen.splice(0, steeredSeen.length - 50); // 50-fix:cap 防无限积
      renderSteeredMessage(text);
      // v1.9.1: 两条路径都显示卡片(provider 排队可撤回 / Claude 已注入确认 2.5s)。
      if (r.queued) {
        // provider: 排队等待下次迭代边界注入,卡片可撤回
        if (state.streaming) { steerPendingList.push({ text, ts: Date.now(), injected: false }); renderSteerQueue(); }
        toast(t('toast.steerQueued'), 'ok'); // v1.9.1: turn 已结束(POST 迟到)只 toast 不显卡片(无 drain 事件移除会持久残留)
      } else if (r.injected) {
        // v1.9.1: Claude 即时注入也显示卡片(「已注入」确认,不可撤回),2.5 秒后自动消失。
        //   Claude 不排队(无迭代边界),steered 事件几乎与 POST 响应同时到 -> 不依赖事件移除,否则卡片一闪而过。
        if (!state.streaming) { toast(t('toast.steerInjected'), 'ok'); } // v1.9.1: turn 已结束(POST 迟到)不显示卡片,避免在已结束 turn 残留 2.5s
        else {
          const item = { text, ts: Date.now(), injected: true };
          steerPendingList.push(item);
          renderSteerQueue();
          toast(t('toast.steerInjected'), 'ok');
          setTimeout(() => {
            const i = steerPendingList.indexOf(item);
            if (i >= 0) { steerPendingList.splice(i, 1); renderSteerQueue(); }
          }, 2500);
        }
      } else {
        toast(t('toast.steerInjected'), 'ok');
      }
    } catch (e) { toast(t("toast.steerFail", { p1: apiErrText(e) }), 'err'); }
  }

  // Render a user interjection row with a muted 「插话」 badge. Used by steerPrompt (optimistic) and by the
  // `steered` stream event (when the UI didn't already show it locally — e.g. a steer from another tab).
  // v1.9.1: 闪绿插话徽章 3 秒(注入确认)。从 steered 事件内联抽出复用--乐观行/事件行/已存在行补闪都走它。
  function flashSteerBadge(row) {
    const badge = row && row.querySelector('.steered-badge');
    if (!badge) return;
    badge.textContent = t('chat.steerInjectedBadge');
    badge.style.color = '#16a34a';
    badge.style.fontWeight = '600';
    badge.style.background = 'rgba(22,163,74,.1)';
    setTimeout(() => { badge.style.color = ''; badge.style.fontWeight = ''; badge.style.background = ''; }, 3000);
  }
  // EC-D 56b: 构造 turn narrative 内的内嵌插话 segment(live renderSteeredMessage 与静态 renderStaticTurnNarrative 共享,
  //   确保流式与刷新后视觉一致)。用户插话原文用 textContent(不进 markdown,防 XSS 与引用断裂)。
  function buildNarrativeSteerSegment(text) {
    const seg = el('div', 'turn-segment narrative-steer');
    seg.appendChild(el('span', 'steered-badge', t('chat.steer')));
    const bubble = el('div', 'bubble');
    bubble.textContent = String(text || '');
    seg.appendChild(bubble);
    return seg;
  }
  function renderSteeredMessage(text, justInjected) {
    const box = $('messages');
    box.querySelector('.empty-state')?.remove();
    // v1.9.1 幂等:同文本插话只渲染一次。防 SSE 比 POST 响应先到的竞态双写
    //   (事件先到 -> steeredSeen 空 -> 下方 steered case 渲染行A;POST 返回 -> 乐观再渲染行B = 两条)。
    //   DOM 文本去重不依赖时序,第二次调用发现同文本 steered 行已存在则跳过。
    const now = Date.now();
    // v1.9.1 幂等加时间窗口:同文本且 1.5 秒内才算同一条的乐观/事件重复(跳过);超窗视为不同条同文本插话(跨回合重发或连发),各自渲染。纯文本去重会误杀不同条(对抗验证发现)。
    for (const node of box.querySelectorAll('[data-steered="true"]')) {
      if (node.dataset.steerTs && now - Number(node.dataset.steerTs) > 1500) continue; // v1.9.1: 只对设了 steerTs 的乐观/事件行判窗;历史行(静态重渲染无 steerTs)始终参与文本去重,防会话切回 mountActiveTurn 重放双写
      const md = node.querySelector('.bubble'); // steered 行是 user .plain bubble(.markdown 类不存在);直接 .bubble 匹配
      if (md && md.textContent.trim() === String(text || '').trim()) {
        if (justInjected) flashSteerBadge(node); // 行已存在(事件先到,乐观尚未渲染),补闪绿
        return;
      }
    }
    // EC-D 56(插话插入点):有活动 live turn 时,把插话作为 turn narrative 内的 segment 落在当前流式位置--
    //   seal 当前文本段(插话前的助手文字)-> 插入 narrative-steer segment -> startLiveTextSegment(后续文字流入新 bubble)。
    //   不再追加到 #messages 末尾钉死底部。无活动 turn(回合已结束/事件迟到)回退原独立 user 行。
    const sid = state.currentSession?.id || '';
    const turn = sid ? activeTurns.get(sid) : null;
    const narrative = turn && turn.live && turn.live.narrative && turn.live.narrative.isConnected ? turn.live.narrative : null;
    if (narrative) {
      sealLiveTextSegment(turn.live); // 封存插话前的助手文本 -> 插话落在其后(无文本则移除空 bubble)
      const seg = buildNarrativeSteerSegment(text);
      seg.dataset.steered = 'true'; // 幂等检查/闪绿匹配覆盖
      seg.dataset.steerTs = String(now); // 时间戳供幂等窗口判定(静态重渲染行无此标记 -> 超窗 -> 不阻止新插话)
      narrative.appendChild(seg);
      startLiveTextSegment(turn.live); // 插话后开新文本段,后续助手文本流入新 bubble(空则 finalizeLive 移除)
      if (justInjected) flashSteerBadge(seg); // 事件触发的渲染直接闪绿(乐观行可能尚未出现,等不到事件来闪)
      maybeScrollToBottom();
      return;
    }
    // 回退:无活动 live turn -> 独立 user 行(刷新后静态渲染同源)
    const row = renderStaticMessage({ role: 'user', content: text, createdAt: new Date().toISOString(), steered: true });
    row.dataset.steered = 'true'; // renderStaticMessage 已设,此处冗余保留
    row.dataset.steerTs = String(now); // v1.9.1: 时间戳供幂等窗口判定(静态重渲染行无此标记 -> 超窗 -> 不阻止新插话)
    box.appendChild(row);
    if (justInjected) flashSteerBadge(row); // 事件触发的渲染直接闪绿(乐观行可能尚未出现,等不到事件来闪)
    maybeScrollToBottom();
  }

  function stopTurn() {
    const sid = state.currentSession?.id || '';
    const turn = sid ? activeTurns.get(sid) : null;
    if (turn && turn.abort) turn.abort.abort();
    if (sid) api('/api/stop', { method: 'POST', body: JSON.stringify({ sessionId: sid }) }).catch(() => {});
    setProc('stopped');
  }

  function scheduleRender(live) {
    if (live.rafPending) return;
    live.rafPending = true;
    live.rafId = requestAnimationFrame(() => {
      live.rafPending = false;
      live.rafId = 0;
      const pending = live.bufferText.slice(live.renderedChars || 0);
      if (pending && live.textNode) live.textNode.appendData(pending);
      live.renderedChars = live.bufferText.length;
      // EC-D 57: 正文/思考/工具统一走聊天滚动控制器；DOM 增长不再伪装成用户 scroll。
      maybeScrollToBottom();
    });
  }
  function finalizeLive(live) {
    // Every terminal path settles and collapses the active reasoning note unless the user toggled it.
    flushThinkingBuffer(live); // rAF 合批未写出的思维链增量先落盘，摘要字数才准确
    settleLiveThinking(live);
    // A transport failure can close the turn after tool_use but before its tool_result line reaches the
    // browser. Never leave that card claiming it is still running after the owning turn has settled.
    for (const [id, card] of (live?.toolCards || new Map())) {
      if (card.durationTimer) { clearInterval(card.durationTimer); card.durationTimer = 0; }
      if (!card.statusbar?.classList.contains('running')) continue;
      card.status.textContent = t('status.stopped');
      card.status.classList.remove('ok', 'err'); card.status.classList.add('err');
      card.statusbar.classList.remove('running', 'ok', 'err'); card.statusbar.classList.add('err');
      if (card.dur && card.t0 != null) card.dur.textContent = `· ${((performance.now() - card.t0) / 1000).toFixed(1)}s`;
      if (card.resPre && !card.resPre.textContent) card.resPre.textContent = t('chat.toolResultMissing');
      settleNarrativeTool(live, id, true);
    }
    compactNarrativeProcessRuns(live && live.narrative);
    if (live.bubble && !live.bufferText && (live.errorShown || live.noteShown || live.narrative.childElementCount > 1)) sealLiveTextSegment(live);
    else if (live.bubble) {
      if (!live.bufferText) live.bufferText = t('chat.noTextOutput');
      sealLiveTextSegment(live);
    }
    // 回合收尾连做折叠(思考面板/过程组)+ markdown 定版，高度变化集中在这一步；
    // 同任务内补一次粘性跟随，避免回合结束时视口先塌后跳。
    maybeScrollToBottom();
  }
  // C6: insert an independent .msg-error block (red) into the live container. Text via textContent so
  // it is never markdown-parsed. Placed after the tools wrap so it reads as the turn's terminal state.
  function appendMsgError(main, live, text) {
    if (live) sealLiveTextSegment(live);
    const box = el('div', 'msg-error'); box.textContent = text;
    main.appendChild(box);
    if (live) live.errorShown = true;
    maybeScrollToBottom();
  }
  // C6: a neutral, muted variant for benign notes ("已停止"). Same structure, no alarm coloring.
  function appendMsgNote(main, live, text) {
    if (live) sealLiveTextSegment(live);
    const box = el('div', 'msg-note'); box.textContent = text;
    main.appendChild(box);
    if (live) live.noteShown = true;
    maybeScrollToBottom();
  }

  /* ---------------- ↓ 回到最新 (§4.4 / EC-D 57 chat-scroll domain) ---------------- */
  // 思维链流式渲染的 rAF 合批入口：thinking_delta 事件只累加 buffer，渲染收敛到每帧一次。
  // 后台标签页 rAF 会暂停，但回合结束时 flush 会把全部 buffer 落盘、切回前台后 rAF 恢复继续，
  // 内容不丢（原 setTimeout 方案的"后台也逐事件渲染"对不可见的页面没有价值）。
  function scheduleLiveThinkingFollow(live) {
    if (!live || live.thinkingRafId) return;
    live.thinkingRafId = requestAnimationFrame(() => {
      live.thinkingRafId = 0;
      flushThinkingBuffer(live);
      // 内层 think-body 跟随：每帧读一次布局；用户已上滑（距底 ≥36px）则不打扰。
      if (live.thinkingEl && live.thinkingPanelObj?.d.open
          && live.thinkingEl.scrollHeight - live.thinkingEl.scrollTop - live.thinkingEl.clientHeight < 36) {
        live.thinkingEl.scrollTop = live.thinkingEl.scrollHeight;
      }
      // 外层消息区跟随同样收敛到每帧一次（原实现在每个 thinking_delta 事件上各起一个
      // setTimeout(0)，事件风暴下产生大量定时器与重复布局读）。
      maybeScrollToBottom();
    });
  }
  // 把累积的思维链文本一次性写入 DOM 文本节点。所有 settle/flush 路径之前必须调用，
  // 确保折叠摘要字数（读 body.textContent）与面板正文一致。
  function flushThinkingBuffer(live) {
    if (!live || !live.thinkingBuffer) return;
    if (live.thinkingNode) live.thinkingNode.appendData(live.thinkingBuffer);
    live.thinkingBuffer = '';
  }

  function registerLiveSemanticCard(live, segment) {
    if (!live || !live.narrative) return null;
    sealLiveTextSegment(live);
    live.completedRun = []; live.completedGroup = null;
    const key = String(segment.requestId || segment.questionId || segment.workflowId || segment.missionId || segment.id || '');
    if (key && live.semanticCards.has(key)) return live.semanticCards.get(key);
    const card = segment.type === 'question' ? narrativeQuestionCard(segment) : narrativeSemanticCard(segment);
    live.narrative.appendChild(card);
    if (key) { live.semanticCards.set(key, card); live.semanticData.set(key, { ...segment }); }
    return card;
  }
  function updateLiveSemanticCard(live, key, segment) {
    if (!live) return;
    const normalizedKey = String(key || '');
    const old = live.semanticCards.get(normalizedKey);
    if (!old) return;
    const merged = { ...(live.semanticData.get(normalizedKey) || {}), ...segment };
    const fresh = merged.type === 'question' ? narrativeQuestionCard(merged) : narrativeSemanticCard(merged);
    old.replaceWith(fresh);
    live.semanticCards.set(normalizedKey, fresh);
    live.semanticData.set(normalizedKey, merged);
  }

  function handleStreamLine(line, live, main, streamSessionId) {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    // Any real event after a reasoning delta closes that phase. This covers thinking → tool/plan/question,
    // not only thinking → assistant text, so interleaved turns never leave completed reasoning panels open.
    if (live?.thinkingActive && evt.type !== 'thinking_delta' && evt.type !== 'raw_line') {
      flushThinkingBuffer(live); // 面板收拢前把合批中的思维链增量写进 DOM
      settleLiveThinking(live);
      compactNarrativeProcessRuns(live.narrative);
      // 思考面板折叠是一次大幅高度塌陷：同任务内立即重新跟随，否则塌陷帧先画出、
      // 下一个事件才把视口拽回底部，表现为页面先跳上去再跳下来（上下抖动）。
      maybeScrollToBottom();
    }
    switch (evt.type) {
      case 'session':
        if (evt.session && state.currentSession?.id === streamSessionId) { state.currentSession = evt.session; renderSessions(); }
        break;
      case 'raw_line':
        pushRawEvent(evt.seq, evt.line);
        break;
      case 'meta': {
        // Engine-aware prefix: provider turns show the provider label, claude turns show 'claude'.
        const engTag = evt.engine === 'openai' ? (evt.providerLabel || 'provider') : (evt.agentCliLabel || (evt.agentCliType === 'kimi' ? 'Kimi Code' : 'claude'));
        const mc = evt.memoryCheck;
        const memoryLine = !mc ? '' : (!mc.enabled
          ? '\n' + t('memory.check.disabled')
          : (!mc.checked ? '\n' + t('memory.check.unavailable') : '\n' + t('memory.check.done', { candidates: mc.candidateCount || 0, matches: mc.matchCount || 0, project: mc.projectMatches || 0, global: mc.globalMatches || 0 })));
        appendToolOutput(`[${engTag}] ${evt.command} ${(evt.args || []).join(' ')}\ncwd=${evt.cwd}\n模型=${evt.model} 权限=${evt.permissionMode}${memoryLine}`);
        // v0.8-S0 cwd guardrail: warn once per turn when the working dir is the user's home/Desktop/
        // Documents/Downloads root (acting on everything the user owns is the highest-risk misfire).
        if (evt.cwdWarning && live && !live.cwdWarned) {
          live.cwdWarned = true;
          toast(t("toast.homeCwdWarn"), 'err');
        }
        break;
      }
      case 'process':
        setProc(evt.state);
        break;
      case 'assistant_delta':
        ensureLiveTextSegment(live);
        live.bufferText += evt.text || '';
        scheduleRender(live);
        break;
      case 'thinking_delta':
        {
        if (!live.thinkingActive) {
          sealLiveTextSegment(live);
          // Reasoning is a real chronological boundary: tools on opposite sides must never be pulled into
          // one tool group, or their expanded order would disagree with the actual event stream.
          live.completedRun = [];
          live.completedGroup = null;
          const tp = thinkingPanel('', true); // live shimmer summary "思考中…"
          live.thinkingEl = tp.body; live.thinkingPanelObj = tp;
          live.thinkingEl.textContent = '';
          live.thinkingNode = document.createTextNode(''); live.thinkingEl.appendChild(live.thinkingNode);
          // Respect a manual toggle when this reasoning phase settles.
          tp.summary.addEventListener('click', () => { tp.userToggled = true; });
          (live.narrative || main).appendChild(tp.d); tp.d.open = true;
          live.thinkingActive = true;
        }
        live.thinkingText += evt.text || '';
        // 超长超快思维链合批：事件只入 buffer，DOM 写与滚动跟随收敛到每帧最多一次。
        // 正文 assistant_delta 已有 scheduleRender 合批；思维链此前每事件同步 appendData +
        // 读一次布局 + 起一个 setTimeout(0)（内部再读布局写两个容器），事件风暴下形成
        // "读-写-读"布局抖动（单 textNode 全文换行重排 O(n·L)），是长链卡死的根源。
        if (live.thinkingBuffer == null) live.thinkingBuffer = '';
        live.thinkingBuffer += evt.text || '';
        scheduleLiveThinkingFollow(live);
        break;
        }
      case 'subagent':
        // v0.9-S6 (子代理): a delegated sub-turn started/ended. `start` opens a nested collapsed card that will
        // hold the sub-turn's own tool_use/tool_result (routed here by subagentId). `end` stamps the head with
        // ✓/✗ + a short conclusion summary. See handleSubagentEvent.
        if (evt.state === 'start') { live.thinkingActive = false; sealLiveTextSegment(live); }
        handleSubagentEvent(evt, live, streamSessionId);
        maybeScrollToBottom(); // EC-D 56: 子代理卡入列也走粘性跟随
        break;
      case 'subagent_progress':
        // v1.4.6 (C): a tool-less Claude sub-turn reporting streamed-text growth. Refresh its card head so the
        // live chat view shows "生成中 · N 字" instead of a silent stall until the ✓/✗ (routed by subagentId).
        handleSubagentEvent(evt, live, streamSessionId);
        break;
      case 'agent_workflow':
        if (evt.state === 'start' || evt.state === 'running') { live.thinkingActive = false; sealLiveTextSegment(live); }
        handleAgentWorkflowEvent(evt, live);
        maybeScrollToBottom(); // EC-D 56: 工作流卡入列也走粘性跟随
        break;
      case 'tool_use': {
        live.thinkingActive = false;
        const card = toolCard({ name: evt.name, input: evt.input });
        card.t0 = performance.now(); // start the clock; tool_result computes the elapsed seconds
        const updateDuration = () => {
          if (card.dur && card.t0 != null) card.dur.textContent = `· ${((performance.now() - card.t0) / 1000).toFixed(0)}s`;
        };
        card.durationTimer = setInterval(updateDuration, 1000);
        live.toolCards.set(evt.id, card);
        // v0.9-S6: a sub-turn's tool_use carries subagentId → nest it inside that sub-agent's card body (indented,
        // via toolCard reuse). No subagentId → the normal top-level tools wrap.
        const subHost = evt.subagentId && live.subCards.get(evt.subagentId);
        if (subHost) {
          subHost.body.appendChild(card.d);
        } else {
          registerNarrativeTool(live, evt, card);
        }
        maybeScrollToBottom(); // EC-D 56: 工具卡入列也走粘性跟随(用户要"页面跟着滚动",上滑阅读时不打扰)
        break;
      }
      case 'tool_use_update': {
        const card = live.toolCards.get(evt.id);
        if (card) {
          if (evt.name) {
            card.name = evt.name;
            if (card.nameEl) card.nameEl.textContent = evt.name;
            if (card.verbEl) card.verbEl.textContent = humanizeToolName(evt.name);
          }
          if (evt.input && typeof evt.input === 'object') {
            if (card.inp) card.inp.textContent = safeStringify(evt.input);
            const arg = toolArgSummary(evt.input);
            if (card.argEl) { card.argEl.textContent = arg; card.argEl.title = arg || ''; }
          }
        }
        break;
      }
      case 'tool_result': {
        const card = live.toolCards.get(evt.id);
        if (card) {
          if (card.durationTimer) { clearInterval(card.durationTimer); card.durationTimer = 0; }
          card.resPre.textContent = safeStringify(evt.content);
          // v1.0-S4: if this was git_diff, paint the colorized diff view now that the result is in.
          if (!evt.isError) renderGitDiffInto(card.diffHost, card.name, evt.content);
          card.status.textContent = evt.isError ? t('status.error') : t('status.done');
          card.status.classList.remove('ok', 'err'); card.status.classList.add(evt.isError ? 'err' : 'ok');
          // Status bar: running → ok/err.
          if (card.statusbar) { card.statusbar.classList.remove('running', 'ok', 'err'); card.statusbar.classList.add(evt.isError ? 'err' : 'ok'); }
          // Duration: performance.now() delta since tool_use, shown as "· 1.2s".
          if (card.dur && card.t0 != null) card.dur.textContent = `· ${((performance.now() - card.t0) / 1000).toFixed(1)}s`;
          settleNarrativeTool(live, evt.id, evt.isError);
          compactNarrativeProcessRuns(live.narrative);
          // 工具完成收组/过程段压实会塌陷高度（用户报告的「新工具展开→成功后快速收起」抽动源）：
          // 与 DOM 变更同帧重新跟随，浏览器只画一次终态，不再先陷后拽。
          maybeScrollToBottom();
        }
        break;
      }
      case 'todo':
        // v0.8-S3: live task-list update → refresh the step-bar and cache on the current session so a later
        // static re-render (session reload) keeps showing it.
        if (state.currentSession) state.currentSession.todos = evt.items || [];
        renderStepBar(evt.items || []);
        break;
      case 'mission':
        // 第26波b: 任务账本进度/状态。缓存到会话 + 刷新进度条;完成/停滞/预算耗尽额外插一张卡片。
        if (state.currentSession) state.currentSession.mission = evt.mission || null;
        renderMissionBar(evt.mission || null);
        {
          const mission = evt.mission || {};
          const missionId = String(mission.id || mission.createdAt || 'active');
          const milestones = Array.isArray(mission.milestones) ? mission.milestones : [];
          const segment = {
            type: 'mission', missionId, goal: mission.goal || '', state: evt.state || 'updated',
            completed: milestones.filter(item => item && item.status === 'done').length,
            total: milestones.length,
            status: evt.state === 'complete' ? 'done'
              : (evt.state === 'stuck' || evt.state === 'budget_exhausted' ? 'error' : 'updated'),
            note: evt.reason || '',
          };
          if (live.semanticCards.has(missionId)) updateLiveSemanticCard(live, missionId, segment);
          else registerLiveSemanticCard(live, segment);
          maybeScrollToBottom();
        }
        break;
      case 'autonomy_grant':
        // 第27波:授权书列表变更(签发/撤销/过期)→ 刷新抽屉。
        renderAutonomyBar(evt.grants || []);
        break;
      case 'autonomy_grant_consumed':
        // 第27波:一次范围内的免弹窗放行 —— 低调提示 + 刷新计数(可观测,不打断)。
        toast(t('toast.grantAuto', { tool: evt.tool || '', remaining: evt.remaining != null ? evt.remaining : '?' }), 'ok');
        loadAutonomyGrants();
        break;
      case 'steered': {
        // v0.8-S7: the server injected a steering interjection at a boundary. If this UI already rendered it
        // optimistically (steerPrompt pushed steeredSeen), dedup against that echo; else render it now.
        // 50-fix(用户真机报告「Steer 一次发两条」):provider 引擎的 echo 在【下一次迭代边界 drain】时才发,
        // 慢工具下可远超旧 15s 窗口 → 窗口失效回声双写。改为【不限时文本队列】去重:同文本逐条 splice,
        // 两条相同插话仍各消各的(正确),回声多晚到都能命中。cap 50 防无限积。
        const idx = steeredSeen.findIndex(s => s.text === evt.text);
        if (idx >= 0) { steeredSeen.splice(idx, 1); }
        // v1.9.1: 从 pendingList 移除已注入项。只移除 provider 排队项(!injected);
        //   Claude injected 项由 steerPrompt 的 setTimeout 管理--否则 steered 事件(与 POST 几乎同时到)立即移除,Claude 卡片一闪而过看不见。
        const pidx = steerPendingList.findIndex(p => p.text === evt.text && !p.injected);
        if (pidx >= 0) { steerPendingList.splice(pidx, 1); renderSteerQueue(); }
        // v1.9.1: 闪绿消息行「✓ 已注入」。关键:steered 行 append 到 $('messages') 顶层(非 assistant main 内部),
        //   旧代码用 main.querySelectorAll 永远匹配不到 -> 闪绿失效(用户报告"看不到插话插到哪里")。
        // v1.9.1: 闪绿只在 idx>=0(乐观行已存在)时做;idx<0(事件先到)交给 renderSteeredMessage justInjected 闪新行,
        //   否则预闪会打在历史同文本行上(跨回合闪错行)+ 双重闪绿(对抗验证发现)。匹配最后一个(DOM 序=最新)。
        if (evt.text && idx >= 0) {
          const box = $('messages');
          let target = null;
          for (const node of box.querySelectorAll('[data-steered="true"]')) {
            const md = node.querySelector('.bubble');
            if (md && md.textContent.trim() === evt.text.trim()) target = node;
          }
          if (target) flashSteerBadge(target);
        }
        // v1.9.1: justInjected-事件触发渲染直接闪绿(乐观行可能尚未出现,等不到事件来闪)
        if (idx < 0) renderSteeredMessage(evt.text || '', true);
        break;
      }
      case 'turn_summary':
        // v0.8-S3: render the 「本轮变更」card at the tail of the live assistant message. finalizeLive keeps
        // the streamed markdown bubble intact; this card sits after the tools wrap.
        { const record = turnToolIndexCard(live && live.toolIndex ? live.toolIndex : [], main); if (record) main.appendChild(record); }
        main.appendChild(turnSummaryCard(evt));
        { const chips = turnArtifactChips(evt); if (chips) main.appendChild(chips); } // v1.0.2 (G2)
        if (live && live.pendingUsage) { main.appendChild(usageLine(live.pendingUsage)); live.pendingUsage = null; }
        // v0.9-S1 (C6): remember whether anything actually changed, so a following error `result` can decide
        // whether to append the 「本次未改动任何文件」 reassurance line.
        if (live) live.filesTouched = (Array.isArray(evt.filesChanged) && evt.filesChanged.length > 0) || (Number(evt.commands) || 0) > 0;
        maybeScrollToBottom();
        break;
      case 'result':
        if (live) live.resultOk = evt.ok === true && !evt.errorClass && !evt.aborted;
        wbNativeClaudeFinalize(streamSessionId, evt);
        // v0.9-S1 (C6): error human-card. On a failed turn (or any turn carrying an errorClass) render a plain-
        // language card with the zh copy + one 「下一步」 action (from ERROR_CLASSES). A clean turn has no
        // errorClass and ok:true → nothing renders. noFilesChanged reassurance shows only when the turn_summary
        // was empty (live.filesTouched is falsy) — a failure that touched nothing shouldn't leave the user guessing.
        if (evt.errorClass || evt.ok === false) {
          // v1.0.2 (F6c): CLI 缺失 → 友好引导卡(向后兼容:无 code 字段走原 errorCard)。
          const noFiles = !(live && live.filesTouched);
          (live && live.narrative ? live.narrative : main).appendChild(evt.code === 'cli-missing' ? cliMissingCard() : errorCard(evt.errorClass, evt.error, noFiles));
          maybeScrollToBottom();
        }
        // v2.7.2: 每轮对话结束自动刷新工具面板(已打开页签;files/artifacts/changes/audit/usage/agent-runs)。
        refreshToolPane();
        break;
      case 'usage':
        if (live) live.pendingUsage = evt; else main.appendChild(usageLine(evt));
        renderContextMeter(evt);
        break;
      case 'compact': {
        const phase = evt.phase || (evt.afterTokens != null ? 'completed' : 'running');
        if (phase === 'started') {
          if (!compactState.active) beginCompactIndicator();
          const label = $('compactIndicator')?.querySelector('span:last-child');
          if (label) label.textContent = evt.mode === 'kimi-native' ? 'Kimi 正在压缩原生上下文…' : '正在分段汇总并重建上下文…';
        } else if (phase === 'running' || phase === 'applied') {
          const label = $('compactIndicator')?.querySelector('span:last-child');
          if (label) label.textContent = phase === 'applied'
            ? `摘要已应用${evt.compactedCount ? `，折叠 ${evt.compactedCount} 条记录` : ''}…`
            : `压缩进行中${evt.elapsedMs ? ` · ${Math.round(evt.elapsedMs / 1000)}s` : ''}…`;
        } else if (phase === 'completed') {
          if (evt.beforeTokens || evt.afterTokens) appendMsgNote(main, live, `🗜 自动压缩已完成：${fmtTokens(evt.beforeTokens || 0)} → ${fmtTokens(evt.afterTokens || 0)}`);
          endCompactIndicator();
        } else if (phase === 'failed') {
          appendMsgError(main, live, `自动压缩未完成：${evt.error || '未知错误'}`);
          endCompactIndicator();
        }
        break;
      }
      case 'stderr':
        appendToolOutput(`[stderr] ${evt.text}`, true);
        break;
      case 'ask_user':
        registerLiveSemanticCard(live, { ...evt, type: 'question', status: 'pending' });
        showAskUserModal(evt.questionId || evt.id, evt.questions, streamSessionId, evt.context || '');
        maybeScrollToBottom(); // EC-D 56: 提问卡入列走粘性跟随(模态浮层不影响消息区滚动)
        break;
      case 'question_answer':
        updateLiveSemanticCard(live, evt.questionId || evt.id, {
          ...evt, type: 'question', status: evt.ok === false ? 'cancelled' : 'answered',
          answerSummary: evt.summary || '',
        });
        // 回答落定后仍保持跟随最新：回答卡替换成已答状态，视口停在提问/最新位置。
        maybeScrollToBottom();
        break;
      case 'permission_request':
        registerLiveSemanticCard(live, { ...evt, type: 'permission', status: 'pending' });
        handlePermissionRequest(evt);
        maybeScrollToBottom(); // EC-D 56: 权限卡入列走粘性跟随
        break;
      case 'permission_paused':
        // 第27f波:无人值守回合的权限弹窗超时后【存档暂停】(不立即拒),延长等待窗口。弹窗仍在,你的决定仍被接受;
        // 超过设定时限(autonomyPauseTtlMs)才回落拒绝。低调提示,不打断。
        updateLiveSemanticCard(live, evt.requestId, { ...evt, type: 'permission', status: 'paused' });
        toast(t("toast.permPaused", { p1: Math.round((evt.ttlMs || 2700000) / 60000) }), 'warn');
        break;
      case 'permission_decision':
        updateLiveSemanticCard(live, evt.requestId, {
          ...evt, type: 'permission', status: evt.behavior === 'allow' ? 'allowed' : 'denied',
        });
        break;
      case 'plan':
        // v0.9-S5 (真流程 plan mode): the model proposed an execution plan and the turn is paused. Render an
        // in-flow plan card (assistant-bubble variant) with the plan markdown + 批准执行 / 修改意见 / 放弃; the
        // decision POSTs to /api/plan/decision and the turn resumes (or ends). Composer hints while pending.
        handlePlanEvent(evt, live && live.narrative ? live.narrative : main, live);
        break;
      case 'plan_note':
        // The user attached a note when approving (修改意见). Show it as a muted interjection so the flow reads.
        if (evt.text) appendMsgNote(live && live.narrative ? live.narrative : main, live, `已按你的补充意见继续：${evt.text}`);
        break;
      case 'plan_decision':
        // The interactive plan card settles synchronously after the decision POST. The stream event exists so
        // service-side replay can persist the same state without creating a second live card.
        break;
      case 'failover':
        // v1.0-S6 (B4): the provider's primary endpoint failed pre-first-byte and the turn switched to a backup.
        // Surface a warn-level toast so the user knows the request is now going elsewhere. The raw event is also
        // visible in the 调试 (debug) 原始事件流 automatically — no extra work needed there.
        toast(t("toast.failoverSwitched", { p1: evt.to || '' }), 'warn');
        break;
      case 'error':
        // v1.0.2 (F6c): CLI 缺失 → 友好引导卡(向后兼容:无 code 字段走原始 .msg-error 文本块)。
        if (evt.code === 'cli-missing') { (live && live.narrative ? live.narrative : main).appendChild(cliMissingCard()); if (live) live.errorShown = true; maybeScrollToBottom(); break; }
        // C6: a real .msg-error block (red tint + left bar), text via textContent — never folded into the
        // markdown buffer where it would render as bold prose and could be mis-parsed.
        appendMsgError(live && live.narrative ? live.narrative : main, live, String(evt.error ?? ''));
        break;
      default: break;
    }
  }

  /* ---------------- interactive: AskUserQuestion + permission modals ---------------- */
  // Dynamic modals are tagged 'dynamic' and carry a __cancel hook so Escape/✕/backdrop resolve the
  // held server request (deny/cancel) instead of leaving the CLI child hanging.


  function isNativeClaudeBackgroundAck(evt) {
    if (!evt || evt.native !== true || evt.engine !== 'claude' || typeof evt.result !== 'string') return false;
    const text = evt.result;
    return /\b(?:async|background)\s+(?:agent|task)\b[\s\S]{0,160}\b(?:launched|started|running)\b/i.test(text)
      || /\b(?:agentId|output_file)\s*[:=]/i.test(text)
      || /\b(?:agent|task)\b[\s\S]{0,160}\bworking in the background\b/i.test(text)
      || /(?:后台|异步)(?:代理|任务)?.{0,40}(?:已启动|运行中)/.test(text);
  }

  function handleSubagentEvent(evt, live, streamSessionId) {
    wbNativeClaudeOnSubagent(evt, streamSessionId);
    const id = evt.id || '';
    if (evt.type === 'subagent_progress') {
      // v1.4.6 (C): keyed by subagentId (not id); refresh the sub-card head with the streamed-text milestone
      // so a long tool-less Claude sub-turn shows "生成中 · N 字" instead of a silent stall until the ✓/✗.
      const host = live.subCards.get(evt.subagentId);
      if (host && host.status) host.status.textContent = `${evt.note || `生成中 · ${Number(evt.chars) || 0} 字`}${host.roleTag || ''}${host.tierTag || ''}${host.modelTag || ''}${host.driverTag || ''}${host.dependencyTag || ''}`;
      return;
    }
    if (evt.state === 'start') {
      if (live.subCards.has(id)) return; // idempotent (a duplicate start should never re-open)
      const d = el('details', 'subagent-card'); d.open = false; // collapsed by default (spec)
      const sum = el('summary', 'subagent-head');
      const task = String(evt.task || '').replace(/\s+/g, ' ').trim();
      const taskShort = task.length > 40 ? task.slice(0, 40) + '…' : task;
      const tierTag = evt.toolTier ? ` · ${evt.toolTier}` : '';
      const roleTag = (evt.roleLabel || evt.roleId) ? ` · ${evt.roleLabel || evt.roleId}` : '';
      const modelTag = evt.model ? ` · ${evt.model}` : '';
      const driverTag = evt.native && evt.engine === 'claude' ? t('chat.claudeNative') : '';
      const keyTag = evt.agentKey ? `[${evt.agentKey}] ` : '';
      const dependencyTag = Array.isArray(evt.dependsOn) && evt.dependsOn.length ? ` · 依赖 ${evt.dependsOn.join(', ')}` : '';
      sum.append(
        el('span', 'sa-icon', '🤖'),
        el('span', 'sa-title', `${keyTag}${t('chat.subtask',{desc:taskShort||t('chat.noDescription')})}`),
        el('span', 'sa-status', `执行中…${roleTag}${tierTag}${modelTag}${driverTag}${dependencyTag}`),
      );
      d.appendChild(sum);
      const body = el('div', 'subagent-body');
      d.appendChild(body);
      live.toolsWrap.appendChild(d);
      live.subCards.set(id, { d, body, status: sum.querySelector('.sa-status'), tierTag, roleTag, modelTag, driverTag, dependencyTag });
      return;
    }
    if (evt.state === 'background') {
      const host = live.subCards.get(id);
      if (host) {
        host.d.classList.add('sa-background');
        if (host.status) {
          host.status.textContent = `${t('chat.claudeBackgroundRunning')}${host.roleTag || ''}${host.tierTag || ''}${host.modelTag || ''}${host.driverTag || ''}${host.dependencyTag || ''}`;
          host.status.classList.remove('ok', 'err');
          host.status.classList.add('running');
        }
      }
      return;
    }
    if (evt.state === 'retry') {
      // v1.4.5: a Claude/CLI sub-agent's transient failure is being retried inline (bounded). Surface it
      // on the card head so the user sees "retrying" rather than a silent stall before the final ✓/✗.
      const host = live.subCards.get(id);
      if (host && host.status) host.status.textContent = `重试中 ${evt.attempt || ''}/${evt.maxAttempts || ''} · ${(String(evt.error || evt.reason || '')).slice(0, 80)}`;
      return;
    }
    if (evt.state === 'end') {
      const host = live.subCards.get(id);
      if (!host) return;
      const ok = evt.ok === true;
      const backgroundAck = ok && isNativeClaudeBackgroundAck(evt);
      host.d.classList.remove('sa-background', 'sa-ok', 'sa-err');
      host.d.classList.add(backgroundAck ? 'sa-background' : (ok ? 'sa-ok' : 'sa-err'));
      // Native Claude Agent/Task calls do not stream the child's internal tool events through the
      // parent CLI. The tool_result is either a real conclusion or a background-launch receipt.
      // Keep it visible and distinguish those states; textContent preserves the normal XSS boundary.
      if (typeof evt.result === 'string' && evt.result) {
        if (!host.resultWrap) {
          host.resultWrap = el('div', 'sa-result');
          host.resultLabel = el('div', 'sa-result-label');
          host.resultPre = el('pre', 'sa-result-text');
          host.resultWrap.append(host.resultLabel, wrapPreWithCopy(host.resultPre));
          host.body.appendChild(host.resultWrap);
        }
        host.resultLabel.textContent = backgroundAck ? t('chat.claudeCliReceipt') : (ok ? t('chat.subtaskConclusion') : t('chat.subtaskError'));
        host.resultPre.textContent = evt.result;
        if (evt.resultTruncated) {
          const note = el('div', 'sa-result-note', t('chat.resultTooLong'));
          if (host.resultNote) host.resultNote.replaceWith(note);
          else host.resultWrap.appendChild(note);
          host.resultNote = note;
        }
      }
      if (host.status) {
        const chars = Number(evt.resultChars) || 0;
        host.status.textContent = backgroundAck
          ? `后台执行中 · 已交给 Claude CLI${host.roleTag || ''}${host.tierTag}${host.modelTag || ''}${host.driverTag || ''}${host.dependencyTag || ''}`
          : `${ok ? '✓ 完成' : t('status.failed')} · ${chars} 字结论${host.roleTag || ''}${host.tierTag}${host.modelTag || ''}${host.driverTag || ''}${host.dependencyTag || ''}`;
        host.status.classList.remove('running', 'ok', 'err');
        host.status.classList.add(backgroundAck ? 'running' : (ok ? 'ok' : 'err'));
      }
      if (!ok) host.d.open = true; // surface a failed sub-turn automatically
    }
  }

  // v1.0.2 (F1d): 计划决策状态的前端持久化。实证:持久化的会话消息里【没有】planId / 计划决策字段 —— 计划在
  // provider 模式下就是一条 content 以 "PLAN:" 开头的普通 assistant 消息(见交付报告 F1d 取舍说明)。因此这里用
  // localStorage 按 planId 记 { decision, note, ts },只在【本次流式生命周期】内让已决策卡保持收起(不改 server /
  // 会话 schema)。跨整页重载时,由于消息无 planId 锚点无法把决策映射回去,计划会退回普通 "PLAN:" markdown 气泡
  // —— 这是硬约束(禁改 server)下的已知降级,已在报告注明。key 前缀 wcw.plan. 。

  /* ---------------- bindings ---------------- */
  return {
    activeTurns,
    buildNarrativeSteerSegment,
    compactContext,
    mountActiveTurn,
    scheduleRender,
    sealLiveTextSegment,
    sendPrompt,
    setStreaming,
    syncStreamingUi,
    steerPendingList,
    steeredSeen,
    stopTurn,
    toggleAgentTeamTurn,
    updateAgentTeamButton,
    updateSendBtn,
  };
}

'use strict';

// 33 号文 §4：子代理卡摘要的截短走 util.js 的【唯一口径】（按码点数，不再 slice 切半代理对）。
// 本模块此前零 import（一切靠 deps 注入，为 vm 直跑留门）；这里只引一个无状态纯字符串函数 ——
// 它是 util.js 里的叶子实现，注入路线需要动 app.js 的 deps 对象，而组合根已无行余量。
import { stewardShortTitle } from './util.js';

export function createChatStaticRenderer(deps = {}) {
  const {
    attachmentImageUrl,
    buildNarrativeSteerSegment,
    buildStaticToolGroup,
    el,
    highlightIn,
    icon,
    messageShell,
    metaFromMessage,
    msgActions,
    normalizeTurnSegments,
    renderMarkdown,
    t,
    tCount,
    thinkingPanel,
    toolCard,
    turnArtifactChips,
    turnSummaryCard,
    turnToolAnchorId,
    usageLine,
    wrapPreWithCopy,
  } = deps;
  // Formatting is synchronous in marked/sanitizer/highlight.js. Beyond this bounded size, keep the raw
  // source as selectable plain text so one answer cannot monopolize dragging/scrolling at settle/re-entry.
  const MARKDOWN_SYNC_MAX_CHARS = Number(deps.markdownSyncMaxChars) || 48_000;

  function renderStaticNativeAgent(record) {
    const ok = record && record.ok === true;
    const interrupted = record && (record.interrupted || record.status === 'interrupted');
    const d = el('details', `subagent-card ${ok ? 'sa-ok' : 'sa-err'}`);
    d.open = !ok;
    const sum = el('summary', 'subagent-head');
    const task = String(record && record.task || '').replace(/\s+/g, ' ').trim();
    const taskShort = stewardShortTitle(task, 40);
    const roleTag = record && (record.roleLabel || record.roleId) ? ` · ${record.roleLabel || record.roleId}` : '';
    const driverTag = t('chat.claudeNative');
    sum.append(
      el('span', 'sa-icon', '🤖'),
      el('span', 'sa-title', t('chat.subtask', { desc: taskShort || t('chat.noDescription') })),
      el('span', `sa-status ${ok ? 'ok' : 'err'}`, `${ok ? t('chat.nativeAgentCompleted') : (interrupted ? t('chat.nativeAgentInterrupted') : t('status.failed'))}${roleTag}${driverTag}`),
    );
    d.appendChild(sum);
    const body = el('div', 'subagent-body');
    if (record && record.result) {
      const wrap = el('div', 'sa-result');
      wrap.appendChild(el('div', 'sa-result-label', ok ? t('chat.subtaskConclusion') : t('chat.subtaskError')));
      const pre = el('pre', 'sa-result-text', record.result);
      wrap.appendChild(wrapPreWithCopy(pre));
      if (record.resultTruncated) wrap.appendChild(el('div', 'sa-result-note', t('chat.resultTooLong')));
      body.appendChild(wrap);
    }
    d.appendChild(body);
    return d;
  }

  // 第54波 EC-D: render one persisted ordered narrative for both engines. `segments` is additive; old
  // sessions keep the legacy content -> toolCalls -> turnSummary path below without guessed chronology.
  function validTurnSegments(msg) {
    return normalizeTurnSegments(msg);
  }
  function narrativeToolAnchor(toolCallId, scope) {
    return turnToolAnchorId(toolCallId, scope);
  }
  function narrativeTextBubble(text) {
    const bubble = el('div', 'bubble');
    const value = String(text || '');
    if (value.length <= MARKDOWN_SYNC_MAX_CHARS) {
      bubble.classList.add('md'); bubble.innerHTML = renderMarkdown(value); highlightIn(bubble);
    } else { bubble.classList.add('plain'); bubble.textContent = value; }
    return bubble;
  }
  function narrativePlanCard(segment) {
    const kimiSnapshot = segment && segment.readOnly === true && segment.source === 'kimi-acp';
    const card = el('div', `plan-card narrative-plan${kimiSnapshot ? ' kimi-plan-snapshot' : ''}`);
    if (kimiSnapshot) {
      card.dataset.planId = String(segment.planId || '');
      card.dataset.readOnly = 'true';
      card.dataset.source = 'kimi-acp';
      card.dataset.status = segment.status === 'removed' ? 'removed' : 'snapshot';
      card.classList.toggle('kimi-plan-snapshot-removed', segment.status === 'removed');
    }
    const head = el('div', 'plan-card-head');
    const status = kimiSnapshot
      ? (segment.status === 'removed' ? 'removed' : 'snapshot')
      : segment.status;
    head.append(
      el('span', '', kimiSnapshot ? t('plan.kimiSnapshot.heading') : t('chat.planSegment')),
      narrativeStatePill(status),
    );
    card.append(head);
    const body = el('div', 'plan-card-body md');
    const markdown = String(segment.markdown || '');
    if (markdown.length <= MARKDOWN_SYNC_MAX_CHARS) {
      body.innerHTML = renderMarkdown(markdown); highlightIn(body);
    } else { body.classList.add('plain'); body.textContent = markdown; }
    card.append(body);
    if (kimiSnapshot && segment.path) {
      card.append(el('div', 'narrative-state-note kimi-plan-snapshot-path', t('plan.kimiSnapshot.path', { path: String(segment.path).slice(0, 2000) })));
    } else if (segment.note) card.append(el('div', 'narrative-state-note', segment.note));
    return card;
  }
  function narrativeQuestionCard(segment) {
    const card = el('div', 'msg-note narrative-question narrative-state-card');
    card.dataset.segmentKey = String(segment.questionId || segment.id || '');
    const questions = Array.isArray(segment.questions) ? segment.questions : [];
    const labels = questions.map(q => q && (q.question || q.prompt || q.label)).filter(Boolean);
    const title = el('div', 'narrative-state-head');
    title.append(el('span', '', labels.length ? `${t('chat.questionSegment')}：${labels.join(' / ')}` : t('chat.questionSegment')), narrativeStatePill(segment.status));
    card.append(title);
    if (segment.answerSummary) card.append(el('div', 'narrative-state-note', segment.answerSummary));
    return card;
  }
  function narrativeStateLabel(status) {
    const key = {
      pending: 'narrative.status.pending', paused: 'narrative.status.paused',
      allowed: 'narrative.status.allowed', denied: 'narrative.status.denied',
      approved: 'narrative.status.approved', rejected: 'narrative.status.rejected',
      answered: 'narrative.status.answered', cancelled: 'narrative.status.cancelled',
      running: 'status.running', done: 'status.done', error: 'status.error',
      background: 'narrative.status.background', // 代理模式 v2:后台代理 run(回合收尾不标 cancelled)
      snapshot: 'narrative.status.snapshot', removed: 'narrative.status.removed',
      updated: 'narrative.status.updated',
    }[String(status || '')] || 'narrative.status.updated';
    return t(key);
  }
  function narrativeStatePill(status) {
    const value = String(status || 'updated');
    return el('span', `narrative-state-pill state-${value}`, narrativeStateLabel(value));
  }
  function narrativeSemanticCard(segment) {
    const type = String(segment.type || 'note');
    const card = el('div', `narrative-state-card narrative-${type}`);
    card.dataset.segmentKey = String(segment.requestId || segment.workflowId || segment.missionId || segment.id || '');
    const titleKey = {
      permission: 'narrative.permission',
      workflow: 'narrative.workflow',
      mission: 'narrative.mission',
    }[type] || 'narrative.event';
    let detail = '';
    if (type === 'permission') detail = segment.toolName || '';
    else if (type === 'workflow') {
      const total = Number(segment.nodeCount) || 0;
      detail = total ? t('narrative.workflowNodes', { count: total }) : '';
    } else if (type === 'mission') {
      const total = Number(segment.total) || 0;
      detail = total ? t('narrative.missionProgress', { done: Number(segment.completed) || 0, total }) : (segment.goal || '');
    }
    const head = el('div', 'narrative-state-head');
    head.append(el('span', 'narrative-state-title', `${t(titleKey)}${detail ? ' · ' + detail : ''}`), narrativeStatePill(segment.status));
    card.append(head);
    if (segment.note) card.append(el('div', 'narrative-state-note', segment.note));
    return card;
  }
  // 代理模式 v2:provider 编排的静态重绘 —— 工作流状态卡下挂交付信封(从同回合 toolCalls 里按 runId 找
  // orchestrate_agents 的结果,信封是持久化进消息的唯一形状),每个节点一张折叠小卡:摘要 + 产物路径 + 错误。
  function narrativeWorkflowCard(segment, tools) {
    const card = narrativeSemanticCard(segment);
    const runId = String(segment.workflowId || '');
    let envelope = null;
    for (const tc of (tools ? tools.values() : [])) {
      const r = tc && tc.result;
      if (r && typeof r === 'object' && r.kind === 'agent_envelope' && String(r.runId || '') === runId) { envelope = r; break; }
    }
    if (!envelope || !Array.isArray(envelope.nodes) || !envelope.nodes.length) return card;
    const list = el('div', 'subagent-body');
    for (const node of envelope.nodes) {
      const ok = node.status === 'succeeded';
      const bad = node.status === 'failed' || node.status === 'rejected' || node.status === 'blocked';
      const d = el('details', `subagent-card ${ok ? 'sa-ok' : (bad ? 'sa-err' : '')}`);
      d.open = bad;
      const sum = el('summary', 'subagent-head');
      const role = node.role ? ` · ${node.role}` : '';
      sum.append(
        el('span', 'sa-icon', '🤖'),
        el('span', 'sa-title', `[${node.nodeId || node.agentKey || ''}]${role}`),
        el('span', `sa-status ${ok ? 'ok' : (bad ? 'err' : '')}`, ok ? t('status.done') : (bad ? t('status.error') : String(node.status || ''))),
      );
      d.appendChild(sum);
      const body = el('div', 'subagent-body');
      if (node.summary) {
        const wrap = el('div', 'sa-result');
        wrap.appendChild(el('div', 'sa-result-label', t('chat.agentEnvelopeSummary')));
        wrap.appendChild(el('pre', 'sa-result-text', String(node.summary)));
        body.appendChild(wrap);
      }
      if (Array.isArray(node.artifacts) && node.artifacts.length) body.appendChild(el('div', 'sa-result-note', t('chat.agentEnvelopeArtifacts', { list: node.artifacts.join(', ') })));
      if (node.error) body.appendChild(el('div', 'msg-error', String(node.error)));
      d.appendChild(body);
      list.appendChild(d);
    }
    card.appendChild(list);
    return card;
  }
  function buildNarrativeToolBatch(items) {
    if (!Array.isArray(items) || items.length < 2 || items.some(item => item.status === 'error')) return null;
    const details = el('details', 'tool-group narrative-tool-batch');
    const sum = el('summary', 'tool-group-sum');
    sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', tCount('tool.group.completed', items.length)));
    details.append(sum);
    const body = el('div', 'tool-group-body');
    for (const item of items) body.append(item.card);
    details.append(body);
    return details;
  }
  function isNarrativeProcessNode(node) {
    return Boolean(node && node.nodeType === 1 && (
      node.classList.contains('thinking')
      || node.classList.contains('tool-card')
      || node.classList.contains('tool-group')
      || node.classList.contains('narrative-process-group')
    ));
  }
  function isSettledNarrativeProcessNode(node) {
    return isNarrativeProcessNode(node)
      && !node.querySelector('.thinking-live')
      && !node.querySelector('.tc-statusbar.running');
  }
  function narrativeProcessStats(nodes) {
    let tools = 0, thinking = 0;
    for (const node of nodes || []) {
      tools += node.classList.contains('tool-card') ? 1 : node.querySelectorAll('.tool-card').length;
      thinking += node.classList.contains('thinking') ? 1 : node.querySelectorAll('.thinking').length;
    }
    return { tools, thinking };
  }
  function refreshNarrativeProcessGroup(group) {
    if (!group) return;
    const body = group._processBody || group.querySelector('.narrative-process-body');
    const label = group._processLabel || group.querySelector('.narrative-process-label');
    if (!body || !label) return;
    const stats = narrativeProcessStats(Array.from(body.children));
    label.textContent = t('chat.processStage', stats);
  }
  function buildNarrativeProcessGroup(nodes) {
    if (!Array.isArray(nodes) || !nodes.length) return null;
    const group = el('details', 'narrative-process-group');
    const summary = el('summary', 'narrative-process-summary');
    const iconWrap = el('span', 'narrative-process-icon'); iconWrap.appendChild(icon('trace', 13));
    const label = el('span', 'narrative-process-label');
    const caret = el('span', 'narrative-process-caret');
    summary.append(iconWrap, label, caret);
    const body = el('div', 'narrative-process-body');
    group.append(summary, body);
    group._processBody = body;
    group._processLabel = label;
    for (const node of nodes) body.appendChild(node);
    refreshNarrativeProcessGroup(group);
    return group;
  }
  // A model may alternate reasoning and one or two tools for a long time without emitting prose. Keep the
  // current running step visible, but fold settled process-only stretches into one chronological stage row.
  // This rule is engine-neutral, so Claude CLI and OpenAI-compatible streams converge on the same density.
  function compactNarrativeProcessRuns(narrative) {
    if (!narrative) return;
    const flush = block => {
      if (!block.length) return;
      const existing = block.find(node => node.classList.contains('narrative-process-group'));
      const settled = block.filter(node => !node.classList.contains('narrative-process-group')
        && isSettledNarrativeProcessNode(node));
      if (existing) {
        const body = existing._processBody || existing.querySelector('.narrative-process-body');
        for (const node of settled) body.appendChild(node);
        refreshNarrativeProcessGroup(existing);
        return;
      }
      const stats = narrativeProcessStats(settled);
      if (settled.length < 5 || stats.tools + stats.thinking < 6 || stats.thinking < 2) return;
      const marker = document.createComment('narrative-process-stage');
      settled[0].before(marker);
      const group = buildNarrativeProcessGroup(settled);
      marker.replaceWith(group);
    };
    let block = [];
    for (const node of Array.from(narrative.children)) {
      if (isNarrativeProcessNode(node)) block.push(node);
      else { flush(block); block = []; }
    }
    flush(block);
  }
  function renderStaticTurnNarrative(msg, host, idScope = '') {
    const segments = validTurnSegments(msg);
    if (!segments.length) return null;
    const tools = new Map((Array.isArray(msg.toolCalls) ? msg.toolCalls : []).filter(Boolean).map(tc => [String(tc.id || ''), tc]));
    const nativeAgents = new Map((Array.isArray(msg.nativeAgents) ? msg.nativeAgents : []).filter(Boolean).map(record => [String(record.toolUseId || ''), record]));
    const narrative = el('div', 'turn-narrative');
    const toolIndex = [];
    const renderedNative = new Set();
    const kimiPlanCards = new Map();
    for (let i = 0; i < segments.length;) {
      const segment = segments[i];
      if (segment.type === 'tool') {
        const consecutive = [];
        while (i < segments.length && segments[i].type === 'tool') {
          const toolSegment = segments[i++];
          const tc = tools.get(String(toolSegment.toolCallId || '')) || { id: toolSegment.toolCallId, name: toolSegment.name || 'tool' };
          const staticTc = { ...tc, isError: toolSegment.status === 'error' || tc.isError === true };
          const card = toolCard(staticTc).d;
          const anchorScope = `${idScope ? idScope + '-' : ''}${msg.turnSeq || msg.createdAt || ''}`;
          const anchorId = narrativeToolAnchor(toolSegment.toolCallId || tc.id, anchorScope);
          if (anchorId !== 'turn-tool-') card.id = anchorId;
          consecutive.push({
            card, batchId: String(toolSegment.batchId || ''),
            status: toolSegment.status || (staticTc.isError ? 'error' : 'done'),
          });
          toolIndex.push({ tc: staticTc, status: toolSegment.status || (staticTc.isError ? 'error' : 'done'), anchorId });
        }
        if (consecutive.length > 1) {
          // A long tool-only stretch stays constant-height. Failures remain outside and split the completed
          // groups, preserving their chronological position instead of being swallowed by the fold.
          let completed = [];
          const flushCompleted = () => {
            if (!completed.length) return;
            const group = buildNarrativeToolBatch(completed);
            if (group) narrative.append(group); else for (const item of completed) narrative.append(item.card);
            completed = [];
          };
          for (const item of consecutive) {
            if (item.status === 'error' || item.status === 'running') {
              flushCompleted(); narrative.append(item.card);
            } else completed.push(item);
          }
          flushCompleted();
        } else {
          for (let cursor = 0; cursor < consecutive.length;) {
            const batchId = consecutive[cursor].batchId;
            const batch = [];
            while (cursor < consecutive.length && consecutive[cursor].batchId === batchId) batch.push(consecutive[cursor++]);
            const group = buildNarrativeToolBatch(batch);
            if (group) narrative.append(group); else for (const item of batch) narrative.append(item.card);
          }
        }
        continue;
      }
      i += 1;
      if (segment.type === 'text') narrative.append(narrativeTextBubble(segment.text));
      else if (segment.type === 'steer') narrative.append(buildNarrativeSteerSegment(segment.text)); // EC-D 56b: 刷新后插话内嵌在助手回合内(与 live 同源)
      else if (segment.type === 'thinking') narrative.append(thinkingPanel(segment.text || '').d);
      else if (segment.type === 'plan') {
        const isKimiSnapshot = segment.readOnly === true && segment.source === 'kimi-acp';
        const planId = String(segment.planId || '');
        const previous = isKimiSnapshot && planId ? kimiPlanCards.get(planId) : null;
        // A removal/update may carry only planId + status. Merge it with the last snapshot so static replay
        // preserves the same markdown/path that live rendering retained when those fields were omitted.
        const normalizedSegment = previous ? { ...previous.segment, ...segment } : segment;
        const card = narrativePlanCard(normalizedSegment);
        if (previous) previous.card.replaceWith(card);
        else narrative.append(card);
        if (isKimiSnapshot && planId) kimiPlanCards.set(planId, { card, segment: normalizedSegment });
      }
      else if (segment.type === 'question') narrative.append(narrativeQuestionCard(segment));
      else if (segment.type === 'workflow') narrative.append(narrativeWorkflowCard(segment, tools)); // 代理模式 v2:工作流卡 + 信封摘要
      else if (segment.type === 'permission' || segment.type === 'mission') narrative.append(narrativeSemanticCard(segment));
      else if (segment.type === 'note') narrative.append(el('div', 'msg-note', segment.text || ''));
      else if (segment.type === 'error') narrative.append(el('div', 'msg-error', segment.text || ''));
      else if (segment.type === 'subagent') {
        const record = nativeAgents.get(String(segment.toolCallId || ''));
        if (record) { narrative.append(renderStaticNativeAgent(record)); renderedNative.add(String(segment.toolCallId || '')); }
      }
    }
    compactNarrativeProcessRuns(narrative);
    host.append(narrative);
    return { toolIndex, renderedNative };
  }
  function revealNarrativeTarget(target) {
    if (!target) return;
    const ancestors = [];
    for (let node = target.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'DETAILS') ancestors.push(node);
    }
    for (const details of ancestors.reverse()) details.open = true;
    if (target.tagName === 'DETAILS') target.open = true;
    // Opening nested details changes layout. Wait for that layout before scrolling and focusing the tool.
    requestAnimationFrame(() => {
      target.tabIndex = -1;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.focus({ preventScroll: true });
      target.classList.add('narrative-located');
      setTimeout(() => target.classList.remove('narrative-located'), 1400);
    });
  }
  function turnToolIndexCard(items, scopeHost) {
    if (!Array.isArray(items) || !items.length) return null;
    const details = el('details', 'turn-record');
    const summary = el('summary', 'turn-record-head', t('chat.turnRecord', { count: items.length }));
    details.append(summary);
    const body = el('div', 'turn-record-body');
    for (const item of items) {
      const row = el('div', 'turn-record-tool');
      const name = String(item.tc && item.tc.name || 'tool');
      const status = item.status === 'error' ? t('status.error') : (item.status === 'running' ? t('status.running') : t('status.done'));
      row.append(el('span', 'turn-record-tool-name', name), el('span', `turn-record-tool-status ${item.status === 'error' ? 'err' : 'ok'}`, status));
      if (item.anchorId && item.anchorId !== 'turn-tool-') {
        const jump = el('button', 'turn-record-jump', t('chat.jumpToTool'));
        jump.type = 'button';
        jump.onclick = () => {
          const target = scopeHost
            ? scopeHost.querySelector(`#${CSS.escape(item.anchorId)}`)
            : document.getElementById(item.anchorId);
          revealNarrativeTarget(target);
        };
        row.append(jump);
      }
      body.append(row);
    }
    details.append(body);
    return details;
  }

  // 已发送附件回显:用户消息里展示「发了什么」——图片出缩略图(点击看大图),其余文件出名片。
  // 数据源是持久化的 msg.attachments(两引擎都在 user 消息上存),乐观行与历史重渲染同源。
  const ATTACHMENT_IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
  function messageAttachmentStrip(msg) {
    const list = Array.isArray(msg.attachments) ? msg.attachments.filter(a => a && (a.name || a.path)) : [];
    if (!list.length) return null;
    const strip = el('div', 'msg-attachment-strip');
    for (const att of list) {
      const name = String(att.name || att.path || '');
      if (ATTACHMENT_IMAGE_RE.test(name) && typeof attachmentImageUrl === 'function') {
        const btn = el('button', 'msg-attachment-thumb');
        btn.type = 'button';
        btn.title = name;
        btn.setAttribute('aria-label', t('chat.attachmentView', { name }));
        const img = document.createElement('img');
        img.alt = name;
        img.loading = 'lazy';
        btn.appendChild(img);
        let loadedUrl = '';
        attachmentImageUrl(att).then(url => {
          if (!url || !btn.isConnected) return;
          loadedUrl = url;
          img.src = url;
        }).catch(() => {});
        img.addEventListener('error', () => { if (btn.isConnected) btn.replaceWith(attachmentChip(att, name)); });
        btn.onclick = () => { if (loadedUrl) openAttachmentViewer(name, loadedUrl); };
        strip.appendChild(btn);
      } else {
        strip.appendChild(attachmentChip(att, name));
      }
    }
    return strip;
  }
  function attachmentChip(att, name) {
    const chip = el('span', 'msg-attachment-chip');
    chip.appendChild(icon('paperclip', 13));
    chip.appendChild(el('span', 'msg-attachment-name', name));
    chip.title = String(att.path || name);
    return chip;
  }
  function openAttachmentViewer(name, url) {
    const backdrop = el('div', 'attachment-viewer-backdrop');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-label', t('chat.attachmentViewerAria'));
    const figure = el('figure', 'attachment-viewer');
    const img = document.createElement('img');
    img.src = url;
    img.alt = name;
    const caption = el('figcaption', 'attachment-viewer-caption', name);
    figure.append(img, caption);
    backdrop.appendChild(figure);
    const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
  }

  function renderStaticMessage(msg, messageKey, renderSignature, options = {}) {
    const meta = msg.role === 'assistant' ? metaFromMessage(msg) : null;
    const { row, main } = messageShell(msg.role, msg.createdAt, meta);
    const segments = validTurnSegments(msg);
    // 50d(02 Phase D):插话卡静态重渲染 -- steered:true 消息(刷新/重进会话后从 session.messages 读出)
    //   统一在此加「插话」徽章,与流式期 renderSteeredMessage 同源(后者也传 steered:true 走此路径)。
    // v1.9.1: 同步设 data-steered,让全量重渲染的行也能被 renderSteeredMessage 幂等检查 + steered 事件闪绿匹配覆盖。
    if (msg.steered) main.appendChild(el('span', 'steered-badge', t('chat.steer')));
    if (msg.steered) row.dataset.steered = 'true'; // v1.9.1: 让全量重渲染的行也能被 renderSteeredMessage 幂等检查 + steered 事件闪绿匹配覆盖
    const nativeAgents = Array.isArray(msg.nativeAgents) ? msg.nativeAgents : [];
    const visibleToolCalls = Array.isArray(msg.toolCalls)
      ? msg.toolCalls.filter(tc => !nativeAgents.length || !['Agent', 'Task', 'TaskOutput'].includes(tc && tc.name))
      : [];
    let narrativeResult = null;
    if (msg.role === 'assistant' && segments.length) narrativeResult = renderStaticTurnNarrative(msg, main, options.idScope || '');
    else {
      if (msg.thinking) { const { d } = thinkingPanel(msg.thinking); main.appendChild(d); }
      const attachmentStrip = msg.role === 'user' ? messageAttachmentStrip(msg) : null;
      if (attachmentStrip) main.appendChild(attachmentStrip);
      const content = String(msg.content || '');
      if (content || !attachmentStrip) {
        const bubble = el('div', 'bubble');
        if (msg.role === 'assistant' && content.length <= MARKDOWN_SYNC_MAX_CHARS) {
          bubble.classList.add('md'); bubble.innerHTML = renderMarkdown(content); highlightIn(bubble);
        } else { bubble.classList.add('plain'); bubble.textContent = content; }
        main.appendChild(bubble);
      }
    }
    if (!narrativeResult && visibleToolCalls.length) {
      // v1.0.2 (G4): >3 top-level tool cards → collapse them all into one <details.tool-group>. ≤3 render flat.
      const cardEls = visibleToolCalls.map(tc => toolCard(tc).d);
      const group = buildStaticToolGroup(cardEls);
      if (group) main.appendChild(group);
      else for (const c of cardEls) main.appendChild(c);
    }
    for (const record of nativeAgents) {
      if (!narrativeResult || !narrativeResult.renderedNative.has(String(record && record.toolUseId || ''))) main.appendChild(renderStaticNativeAgent(record));
    }
    // 137x（用户 2026-09-24）：运行中的回合不出这张「本轮记录 · N 次工具调用」——它读着就是「回合结束」的
    // 总结语气，管家开的线程在跑的时候(session-experience.js 的 paintLiveTurnNarrative 传 running:true)
    // 每 3 秒/每条推送重画一次都会把它重画一遍，看着像是回合反复「结束」。回合真结束后(静态重渲染，
    // options.running 缺省为假)照常显示，不影响历史消息。
    if (narrativeResult && !options.running) {
      const record = turnToolIndexCard(narrativeResult.toolIndex, main);
      if (record) main.appendChild(record);
    }
    if (msg.turnSummary && !options.readonly) {
      main.appendChild(turnSummaryCard(msg.turnSummary)); // v0.8-S3 「本轮变更」
      const chips = turnArtifactChips(msg.turnSummary); if (chips) main.appendChild(chips); // v1.0.2 (G2)
    }
    if (msg.usage) main.appendChild(usageLine(msg.usage, meta));
    if (!options.readonly) main.appendChild(msgActions(msg));
    if (messageKey) row.dataset.messageKey = messageKey;
    if (renderSignature) row.dataset.renderSignature = renderSignature;
    return row;
  }


  return {
    compactNarrativeProcessRuns,
    narrativeQuestionCard,
    narrativeSemanticCard,
    narrativeToolAnchor,
    renderStaticMessage,
    turnToolIndexCard,
  };
}

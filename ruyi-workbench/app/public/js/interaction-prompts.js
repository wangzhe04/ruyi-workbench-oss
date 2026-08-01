'use strict';

// EC-D：动态模态、AskUser、权限确认、计划决策与工作流事件卡领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, toast } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function createInteractionPromptsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  engineLabel = () => '',
  activeTurns = new Map(),
  saveConfigPartial = async () => false,
} = {}) {
function buildModal(title, bodyEl, footEl, onCancel) {
  const backdrop = el('div', 'modal-backdrop dynamic');
  const trigger = document.activeElement; // §4.9: return focus here on close
  let done = false;
  const finish = (cancelled) => {
    if (done) return; done = true;
    if (cancelled && onCancel) { try { onCancel(); } catch { /* ignore */ } }
    backdrop.remove();
    if (trigger && typeof trigger.focus === 'function') { try { trigger.focus(); } catch { /* ignore */ } }
  };
  backdrop.__cancel = () => finish(true);
  backdrop.__close = () => finish(false);
  const modal = el('div', 'modal small');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
  const head = el('div', 'modal-head');
  head.append(el('h3', '', title));
  const x = el('button', 'icon-btn'); x.appendChild(icon('close', 16)); x.setAttribute('aria-label', t('common.close')); x.onclick = () => finish(true);
  head.append(x);
  const body = el('div', 'modal-body'); body.appendChild(bodyEl);
  const foot = el('div', 'modal-foot'); if (footEl) foot.appendChild(footEl);
  modal.append(head, body, foot);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(true); });
  backdrop.appendChild(modal);
  installFocusTrap(backdrop); // 第50波 a11y P0:Tab 焦点陷阱
  document.body.appendChild(backdrop);
  // §4.9: focus the first interactive element inside the modal (input/button), falling back to ✕.
  setTimeout(() => { (focusFirstInteractive(modal) || x)?.focus?.(); }, 0);
  return { backdrop, foot, close: () => finish(false) };
}
// §4.9 helper: find the first focusable control inside a container (visible input/select/textarea/
// button/[tabindex]≥0), preferring a real form field over a button. Returns the element or null.
function focusFirstInteractive(container) {
  if (!container) return null;
  const sel = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = [...container.querySelectorAll(sel)].filter(n => n.offsetParent !== null || n === document.activeElement);
  // Prefer a field the user is expected to type into over the leading ✕/close button.
  const field = nodes.find(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
  return field || nodes[0] || null;
}
// 第50波(a11y P0):模态焦点陷阱 —— Tab/Shift+Tab 在模态内循环,焦点不外泄到背景(ESC 与焦点归还
// 已由全局快捷键/buildModal 承担)。动态(buildModal)与静态(index.html)模态共用。
function installFocusTrap(backdrop) {
  if (!backdrop || backdrop.__trapInstalled) return;
  backdrop.__trapInstalled = true;
  backdrop.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const modal = backdrop.querySelector('.modal') || backdrop;
    const sel = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = [...modal.querySelectorAll(sel)].filter(n => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !modal.contains(active))) { e.preventDefault(); first.focus(); }
  });
}

function showAskUserModal(questionId, questions, streamSessionId) {
  const sid = streamSessionId || state.currentSession?.id; // pin the session the question belongs to
  const qid = String(questionId || '');
  const turn = sid ? activeTurns.get(sid) : null;
  if (!sid || !qid || turn?.answeredQuestions?.has(qid)) return;
  // Replaying a background turn can encounter the same ask_user event again. Reuse the existing modal;
  // closing it would send a cancellation before the user's real selection and silently win the race.
  const open = [...document.querySelectorAll('.modal-backdrop.ask-modal')];
  if (open.some(b => b.dataset.sessionId === sid && b.dataset.questionId === qid)) return;
  open.forEach(b => { if (b.__cancel) b.__cancel(); else b.remove(); });
  const list = Array.isArray(questions) ? questions : (questions && questions.questions) || [questions];
  const body = el('div', 'ask-sheet');
  const intro = el('div', 'ask-intro');
  const introMark = el('div', 'ask-intro-mark'); introMark.appendChild(icon('sparkles', 18));
  const introCopy = el('div', 'ask-intro-copy');
  introCopy.append(
    el('div', 'ask-intro-title', t('ask.introTitle')),
    el('div', 'ask-intro-detail', t('ask.introDetail', { engine: engineLabel() }))
  );
  intro.append(introMark, introCopy);
  body.appendChild(intro);
  const states = [];
  list.forEach((q, qi) => {
    if (!q) return;
    const options = Array.isArray(q.options) ? q.options : [];
    const requestedMode = String(q.answerMode || '').toLowerCase();
    let mode = ['single', 'multiple', 'text'].includes(requestedMode)
      ? requestedMode
      : (options.length ? (q.multiSelect ? 'multiple' : 'single') : 'text');
    if (!options.length && mode !== 'text') mode = 'text';
    const block = document.createElement('fieldset');
    block.className = 'ask-question-card';
    const legend = document.createElement('legend');
    legend.className = 'ask-question-legend';
    const header = el('span', 'ask-question-kicker', q.header || t('ask.questionLabel', { number: qi + 1 }));
    const modeHint = el('span', 'ask-mode-hint', mode === 'multiple' ? t('ask.chooseMany') : (mode === 'text' ? t('ask.writeAnswer') : t('ask.chooseOne')));
    legend.append(header, modeHint);
    block.appendChild(legend);
    block.appendChild(el('div', 'ask-question-text', q.question || q.header || t('ask.questionLabel', { number: qi + 1 })));
    const state = {
      questionId: String(q.id || `question_${qi + 1}`),
      question: q.question || q.header || `q${qi}`,
      mode,
      options: [],
      otherInput: null,
      otherText: null,
      textInput: null,
      block,
    };
    if (options.length && mode !== 'text') {
      const optionList = el('div', 'ask-option-list');
      options.forEach((opt, oi) => {
        const label = typeof opt === 'string' ? opt : (opt.label || opt.value || JSON.stringify(opt));
        const optionId = String((opt && typeof opt === 'object' && opt.id) || `option_${oi + 1}`);
        const description = typeof opt === 'object' ? String(opt.description || '') : '';
        const wrap = el('label', 'ask-option-card');
        const inp = document.createElement('input');
        inp.type = mode === 'multiple' ? 'checkbox' : 'radio';
        inp.name = `ask-${qid}-q${qi}`; inp.value = optionId;
        const indicator = el('span', 'ask-option-indicator'); indicator.setAttribute('aria-hidden', 'true');
        const copy = el('span', 'ask-option-copy');
        copy.appendChild(el('span', 'ask-option-label', label));
        if (description) copy.appendChild(el('span', 'ask-option-description', description));
        wrap.append(inp, indicator, copy);
        optionList.appendChild(wrap);
        state.options.push({ id: optionId, label, input: inp, wrap });
      });
      if (q.allowOther === true) {
        const other = el('div', 'ask-other-card');
        const choice = el('label', 'ask-option-card ask-other-choice');
        const inp = document.createElement('input');
        inp.type = mode === 'multiple' ? 'checkbox' : 'radio';
        inp.name = `ask-${qid}-q${qi}`; inp.value = '__other__';
        const indicator = el('span', 'ask-option-indicator'); indicator.setAttribute('aria-hidden', 'true');
        const copy = el('span', 'ask-option-copy');
        copy.appendChild(el('span', 'ask-option-label', q.otherLabel || t('ask.other')));
        copy.appendChild(el('span', 'ask-option-description', t('ask.otherDescription')));
        choice.append(inp, indicator, copy);
        const text = document.createElement('textarea');
        text.className = 'ask-text-input ask-other-input';
        text.rows = 2; text.maxLength = 4000;
        text.placeholder = q.otherPlaceholder || t('ask.otherPlaceholder');
        text.setAttribute('aria-label', q.otherLabel || t('ask.other'));
        text.disabled = true;
        other.append(choice, text);
        optionList.appendChild(other);
        state.otherInput = inp; state.otherText = text; state.otherWrap = choice;
      }
      block.appendChild(optionList);
    } else {
      const inp = document.createElement('textarea');
      inp.className = 'ask-text-input'; inp.rows = 3; inp.maxLength = 4000;
      inp.placeholder = q.otherPlaceholder || t('ask.textPlaceholder');
      inp.setAttribute('aria-label', q.question || q.header || t('ask.questionLabel', { number: qi + 1 }));
      block.appendChild(inp); state.textInput = inp;
    }
    body.appendChild(block);
    states.push(state);
  });
  const submit = el('button', 'primary ask-submit', t('ask.submit'));
  submit.disabled = true;
  const footHint = el('div', 'ask-foot-hint', t('ask.answerAll'));
  const footActions = el('div', 'ask-foot-actions');
  footActions.append(footHint, submit);
  // Fire-and-forget answer (used only by the cancel path — Esc/✕/backdrop). Cancelling still answers (empty)
  // so the turn doesn't hang waiting for a tool_result. F4④:已实证现有关闭路径确实空答放行,不会丢弃挂起。
  const markAnswered = () => { const active = activeTurns.get(sid); if (active?.answeredQuestions) active.answeredQuestions.add(qid); };
  const postAnswer = content => {
    if (!sid) { toast(t("toast.sessionEndedNoAnswer"), 'err'); return; }
    api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid, content, isError: true }) })
      .then(r => { if (r?.delivered) markAnswered(); }).catch(e => toast(apiErrText(e), 'err'));
  };
  const modal = buildModal(t('ask.title'), body, footActions, () => postAnswer(t('ask.cancelled')));
  // F4②:标记为 ask modal,供下一条提问到达时精确关旧的。
  modal.backdrop.classList.add('ask-modal');
  modal.backdrop.querySelector('.modal')?.classList.add('ask-question-modal');
  modal.backdrop.dataset.sessionId = sid;
  modal.backdrop.dataset.questionId = qid;
  const collectAnswers = () => states.map(state => {
    const selected = state.options.filter(option => option.input.checked);
    const otherText = state.otherInput?.checked ? String(state.otherText?.value || '').trim() : '';
    const text = state.mode === 'text' ? String(state.textInput?.value || '').trim() : otherText;
    return {
      questionId: state.questionId,
      question: state.question,
      selectedOptionIds: selected.map(option => option.id),
      otherText: text,
      // Legacy field keeps older Workbench servers/clients interoperable during overlay upgrades.
      answer: [...selected.map(option => option.label), ...(text ? [text] : [])],
    };
  });
  const syncState = () => {
    let allAnswered = states.length > 0;
    for (const state of states) {
      for (const option of state.options) option.wrap.classList.toggle('selected', option.input.checked);
      if (state.otherWrap) state.otherWrap.classList.toggle('selected', !!state.otherInput?.checked);
      if (state.otherText) state.otherText.disabled = !state.otherInput?.checked;
      const selectedCount = state.options.filter(option => option.input.checked).length;
      const otherReady = !!state.otherInput?.checked && !!String(state.otherText?.value || '').trim();
      const textReady = !!String(state.textInput?.value || '').trim();
      const otherComplete = !state.otherInput?.checked || otherReady;
      const answered = state.mode === 'text' ? textReady : (selectedCount > 0 || otherReady) && otherComplete;
      state.block.classList.toggle('needs-answer', !answered);
      allAnswered = allAnswered && answered;
    }
    submit.disabled = !allAnswered;
    footHint.textContent = allAnswered ? t('ask.ready') : t('ask.answerAll');
    footHint.classList.toggle('ready', allAnswered);
  };
  for (const state of states) {
    state.options.forEach(option => option.input.addEventListener('change', syncState));
    state.otherInput?.addEventListener('change', syncState);
    state.otherText?.addEventListener('input', () => {
      if (String(state.otherText.value || '').trim()) state.otherInput.checked = true;
      syncState();
    });
    state.textInput?.addEventListener('input', syncState);
  }
  body.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !submit.disabled) {
      event.preventDefault(); submit.click();
    }
  });
  syncState();
  // F4①:提交按钮点击后禁用 + 「发送中…」,await POST 回来再 close;失败则 toast + 恢复按钮(不 close,让用户重试)。
  submit.onclick = async () => {
    if (submit.disabled) return;
    if (!sid) { toast(t("toast.sessionEndedNoAnswer"), 'err'); modal.close(); return; }
    const answers = collectAnswers();
    const content = answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n');
    const prevLabel = submit.textContent;
    submit.disabled = true; submit.textContent = t('ask.sending');
    try {
      const r = await api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid, answers, content }) });
      if (!r?.ok || !r.delivered) throw new Error('answer was not delivered');
      markAnswered();
      modal.close();
    } catch (e) {
      toast(t("toast.answerFail", { p1: apiErrText(e) }), 'err');
      submit.disabled = false; submit.textContent = prevLabel;
      syncState();
    }
  };
}

// v0.8-S4b B3: plain-language tool-name map (人话化). ai_computer_control__ prefixed bridged tools →
// 「桌面操作：<去前缀名>」. shell_* → 终端操作. Unknown → the raw name.
// 第50波(i18n 清零):值改 i18n 键(tools.verb.*),humanizeToolName 经 t() 取文案。
const TOOL_VERB_MAP = {
  file_edit: 'tools.verb.file_edit', file_write: 'tools.verb.file_write', file_delete: 'tools.verb.file_delete',
  file_move: 'tools.verb.file_move', file_copy: 'tools.verb.file_copy', archive_zip: 'tools.verb.archive_zip', archive_unzip: 'tools.verb.archive_unzip', http_download: 'tools.verb.http_download',
  powershell_run: 'tools.verb.exec_command', script_run: 'tools.verb.exec_command',
  desktop_screenshot: 'tools.verb.desktop_screenshot', keyboard_send_keys: 'tools.verb.keyboard_send_keys', http_request: 'tools.verb.http_request',
  git_status: 'tools.verb.git_status', git_diff: 'tools.verb.git_diff', git_log: 'tools.verb.git_log', git_commit: 'tools.verb.git_commit',
};
function humanizeToolName(name) {
  const n = String(name || '');
  if (!n) return t('tools.verb.unknown');
  if (TOOL_VERB_MAP[n]) return t(TOOL_VERB_MAP[n]);
  if (n.startsWith('shell_')) return t('tools.verb.shell');
  if (n.startsWith('ai_computer_control__')) return t('tools.verb.desktop', { name: n.slice('ai_computer_control__'.length) });
  return n;
}
// Tier badge visuals — read 绿 / edit 黄 / exec 红. Kept here so the popup needn't re-derive tier from the
// tool name; the server sends `tier` on the permission_request event.
const TIER_META = {
  read: { labelKey: 'permission.read', cls: 'read' },
  edit: { labelKey: 'permission.edit', cls: 'edit' },
  exec: { labelKey: 'permission.execute', cls: 'exec' },
};
function permissionTierMeta(tier) {
  const meta = TIER_META[tier] || TIER_META.exec;
  return { ...meta, label: t(meta.labelKey) };
}

// v0.8-S4b: session-scoped auto-allow (front-end only). sessionId → Set<toolName>. Once a permission is
// allowed with the "本次会话自动允许" box ticked, later permission_requests for the SAME tool in the SAME
// session are auto-approved without a popup. Not persisted (cleared on reload); the PERSISTENT variant
// (config.toolAllowRules) is a separate, read/edit-only opt-in below.
const sessionAllow = new Map();
function sessionAllowHas(sid, tool) { const s = sessionAllow.get(sid); return !!(s && s.has(tool)); }
function sessionAllowAdd(sid, tool) { let s = sessionAllow.get(sid); if (!s) { s = new Set(); sessionAllow.set(sid, s); } s.add(tool); }

function decide(requestId, behavior, extra) {
  return api('/api/permission/decision', { method: 'POST', body: JSON.stringify({ requestId, behavior, ...(extra || {}) }) }).catch(e => toast(apiErrText(e), 'err'));
}
function handlePermissionRequest(evt) {
  const sid = state.currentSession?.id || '';
  const tool = evt.toolName || 'unknown';
  const tier = TIER_META[evt.tier] ? evt.tier : 'exec';
  const tierMeta = permissionTierMeta(tier);
  const revertible = evt.revertible === true;
  // Session-scoped auto-allow: skip the popup entirely for a tool the user already blessed this session.
  if (sessionAllowHas(sid, tool)) { decide(evt.requestId, 'allow'); return; }

  const body = el('div');
  // Humanized title + raw tool name (mono, secondary) so power users still see exactly what runs.
  body.appendChild(el('p', '', t('permission.request.intent', { engine: engineLabel() })));
  const titleRow = el('div', 'perm-title-row');
  titleRow.append(el('span', 'perm-verb', humanizeToolName(tool)));
  const badge = el('span', `perm-tier ${tierMeta.cls}`);
  badge.append(el('span', 'perm-tier-dot'), el('span', '', tierMeta.label));
  titleRow.append(badge);
  body.append(titleRow);
  body.appendChild(el('div', 's-title perm-rawname', tool));
  // Revertibility line — the decision-moment trust signal (B3). Uses the event's `revertible` field
  // (server truth); the front-end does NOT re-implement the tier→revertible table.
  const revLine = el('div', `perm-revert ${revertible ? 'yes' : 'no'}`,
    revertible ? t('permission.revertible') : t('permission.notRevertible'));
  body.append(revLine);
  const pre = el('pre'); pre.style.cssText = 'background:var(--code-bg);border-radius:6px;padding:8px;max-height:200px;overflow:auto;font-family:var(--mono);font-size:var(--fs-sm)';
  pre.textContent = (() => { try { return JSON.stringify(evt.input, null, 2); } catch { return String(evt.input); } })();
  body.appendChild(pre);
  // "本次会话自动允许" — session-scoped, always available. A secondary "永久" box appears only for
  // read/edit tier (never exec/desktop) → persists into config.toolAllowRules.
  const sessWrap = el('label', 'check');
  const sessBox = document.createElement('input'); sessBox.type = 'checkbox';
  sessWrap.append(sessBox, document.createTextNode(' ' + t('permission.allowSession')));
  body.appendChild(sessWrap);
  let permBox = null;
  if (tier === 'read' || tier === 'edit') {
    const permWrap = el('label', 'check perm-persist');
    permBox = document.createElement('input'); permBox.type = 'checkbox';
    permWrap.append(permBox, document.createTextNode(' ' + t('permission.allowPersistent')));
    body.appendChild(permWrap);
    // Ticking 永久 implies the session box (superset); keep them consistent.
    permBox.addEventListener('change', () => { if (permBox.checked) sessBox.checked = true; });
  }

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const deny = el('button', 'danger', t('permission.deny'));
  const allow = el('button', 'primary', t('permission.allow'));
  foot.append(deny, allow);
  // Cancel (Escape/✕/backdrop) denies, so the held bridge request is released immediately.
  const modal = buildModal(t('permission.request.title', { engine: engineLabel() }), body, foot, () => decide(evt.requestId, 'deny', { message: t('permission.request.cancelled') }));
  modal.backdrop.classList.add('permission-modal');
  modal.backdrop.dataset.sessionId = sid;
  modal.backdrop.dataset.interventionId = String(evt.requestId || '');
  deny.onclick = () => { decide(evt.requestId, 'deny', { message: t('permission.request.denied') }); modal.close(); };
  allow.onclick = () => {
    if (sessBox.checked) sessionAllowAdd(sid, tool);
    if (permBox && permBox.checked) {
      // Persist a read/edit allow rule. normalizeConfig will drop it server-side if the tier disqualifies
      // it, so this is safe even if the tier badge and the server disagree.
      const rules = { ...(state.config.toolAllowRules || {}), [tool]: 'allow' };
      saveConfigPartial({ toolAllowRules: rules });
      toast(t('permission.alwaysAllowed', { tool: humanizeToolName(tool) }), 'ok');
    }
    decide(evt.requestId, 'allow'); modal.close();
  };
}

// Wave 81: a decision made in the Preview global inbox must retire an already-open classic prompt
// without firing that prompt's cancel path (the authoritative command has already been delivered).
function resolveClassicPromptIntervention({ sessionId, interventionId, type } = {}) {
  const sid = String(sessionId || ''), id = String(interventionId || '');
  if (!id) return false;
  if (type === 'question') {
    const turn = sid ? activeTurns.get(sid) : null;
    if (turn?.answeredQuestions) turn.answeredQuestions.add(id);
  }
  const selector = type === 'question' ? '.modal-backdrop.ask-modal' : '.modal-backdrop.permission-modal';
  const backdrop = [...document.querySelectorAll(selector)].find(node => {
    if (node.dataset.sessionId !== sid) return false;
    return type === 'question' ? node.dataset.questionId === id : node.dataset.interventionId === id;
  });
  if (!backdrop) return false;
  if (typeof backdrop.__close === 'function') backdrop.__close();
  else backdrop.remove();
  return true;
}

/* ---------------- v0.9-S5 (真流程 plan mode): plan approval card ---------------- */
// Set/clear the composer hint shown while the turn is paused awaiting a plan decision.
function setComposerHint(text) {
  const h = $('composerHint');
  if (h) h.textContent = text || '';
}
// POST the plan decision. approve (optionally with a note = 修改意见) or reject. Returns the parsed response.
function decidePlan(planId, decision, note) {
  const sid = state.currentSession?.id || '';
  return api('/api/plan/decision', { method: 'POST', body: JSON.stringify({ sessionId: sid, planId, decision, note: note || '' }) })
    .catch(e => { toast(t('plan.decision.failed', { reason: apiErrText(e) }), 'err'); return null; });
}
// v0.9-S6 (子代理): render/close the nested sub-agent card. `start` opens a collapsed <details> with an accent
// left bar and a 「🤖 子任务：<task 前 40 字>」head; its `body` hosts the sub-turn's nested tool cards (routed by
// subagentId in the tool_use/tool_result handlers). `end` stamps the head with ✓/✗ + a short conclusion note.
// The card lives in live.toolsWrap so it sits with the turn's other tool activity, and is tracked in
// live.subCards keyed by the subagentId so tool events find their host.
function workflowStatusLabel(status) {
  const key = {
    running: 'workflow.node.running',
    succeeded: 'workflow.node.succeeded',
    failed: 'workflow.node.failed',
    waiting: 'workflow.node.waiting',
  }[status];
  return key ? t(key) : (status || t('workflow.run.endedDefault'));
}

function handleAgentWorkflowEvent(evt, live) {
  const id = evt.id || '';
  if (evt.state === 'start') {
    const d = el('details', 'subagent-card'); d.open = true;
    const sum = el('summary', 'subagent-head');
    sum.append(el('span', 'sa-icon', '🕸️'), el('span', 'sa-title', t('workflow.run.title', { count: evt.nodeCount || 0 })), el('span', 'sa-status', t('workflow.run.running', { count: evt.concurrency || 1 })));
    d.appendChild(sum); const body = el('div', 'subagent-body', t('workflow.run.description')); d.appendChild(body);
    live.toolsWrap.appendChild(d);
    live.workflowCards.set(id, { d, status: sum.querySelector('.sa-status'), done: 0, total: Number(evt.nodeCount) || 0 });
    return;
  }
  const host = live.workflowCards.get(id); if (!host) return;
  if (evt.state === 'heartbeat') {
    host.done = Math.max(host.done, Number(evt.completedNodes) || 0);
    const active = (Array.isArray(evt.activeNodes) ? evt.activeNodes : []).map(node => node && node.id).filter(Boolean).join(', ') || '—';
    host.status.textContent = t('workflow.run.heartbeat', {
      done: host.done, total: Number(evt.totalNodes) || host.total,
      seconds: Math.max(1, Math.round((Number(evt.elapsedMs) || 0) / 1000)), active,
    });
  } else if (evt.state === 'node_wrapup_requested') {
    host.status.textContent = t('workflow.run.wrapUpRequested', { nodeId: evt.nodeId || '' });
  } else if (evt.state === 'node_wrapup_forced') {
    host.status.textContent = t('workflow.run.wrapUpForced', { nodeId: evt.nodeId || '' });
  } else if (evt.state === 'node_retry') {
    host.status.textContent = t('workflow.run.retry', { nodeId: evt.nodeId || '', attempt: evt.attempt || 0, maxRetries: evt.maxRetries || 0 });
  } else if (evt.state === 'node_loop') {
    host.status.textContent = t('workflow.run.loop', { nodeId: evt.nodeId || '', iteration: evt.iteration || 0, maxIterations: evt.maxIterations || 0, count: evt.noProgressCount || 0 });
  } else if (evt.state === 'node_end') {
    host.done += 1;
    host.status.textContent = t('workflow.run.progress', { done: host.done, total: host.total, nodeId: evt.nodeId || '', status: workflowStatusLabel(evt.status) });
  } else if (evt.state === 'end') {
    const ok = evt.status === 'succeeded';
    host.d.classList.add(ok ? 'sa-ok' : 'sa-err');
    host.status.textContent = t('workflow.run.ended', { status: ok ? t('workflow.node.succeeded') : workflowStatusLabel(evt.status), succeeded: evt.succeeded || 0, failed: evt.failed || 0 });
    host.status.classList.add(ok ? 'ok' : 'err');
    if (ok) host.d.open = false;
  }
}
  return Object.freeze({
    buildModal,
    decide,
    decidePlan,
    focusFirstInteractive,
    handleAgentWorkflowEvent,
    handlePermissionRequest,
    humanizeToolName,
    installFocusTrap,
    resolveClassicPromptIntervention,
    setComposerHint,
    showAskUserModal,
  });
}

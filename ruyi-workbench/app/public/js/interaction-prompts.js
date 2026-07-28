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
  const body = el('div');
  const controls = [];
  list.forEach((q, qi) => {
    if (!q) return;
    const block = el('div', 'field-block');
    block.appendChild(el('label', '', q.question || q.header || `问题 ${qi + 1}`));
    const options = q.options || [];
    const multi = !!q.multiSelect;
    if (options.length) {
      options.forEach((opt, oi) => {
        const label = typeof opt === 'string' ? opt : (opt.label || opt.value || JSON.stringify(opt));
        const wrap = el('label', 'check');
        const inp = document.createElement('input');
        inp.type = multi ? 'checkbox' : 'radio';
        inp.name = `q${qi}`; inp.value = label; if (!multi && oi === 0) inp.checked = true;
        wrap.append(inp, document.createTextNode(' ' + label));
        block.appendChild(wrap);
        controls.push({ qi, multi, input: inp, label });
      });
    } else {
      const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = t('chat.inputPlaceholder');
      block.appendChild(inp); controls.push({ qi, multi: false, input: inp, free: true });
    }
    body.appendChild(block);
  });
  const submit = el('button', 'primary', t('chat.submit'));
  // Fire-and-forget answer (used only by the cancel path — Esc/✕/backdrop). Cancelling still answers (empty)
  // so the turn doesn't hang waiting for a tool_result. F4④:已实证现有关闭路径确实空答放行,不会丢弃挂起。
  const markAnswered = () => { const active = activeTurns.get(sid); if (active?.answeredQuestions) active.answeredQuestions.add(qid); };
  const postAnswer = content => {
    if (!sid) { toast(t("toast.sessionEndedNoAnswer"), 'err'); return; }
    api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid, content, isError: true }) })
      .then(r => { if (r?.delivered) markAnswered(); }).catch(e => toast(apiErrText(e), 'err'));
  };
  const modal = buildModal(`模型提问 · ${engineLabel()}`, body, submit, () => postAnswer(t('chat.userCancelled')));
  // F4②:标记为 ask modal,供下一条提问到达时精确关旧的。
  modal.backdrop.classList.add('ask-modal');
  modal.backdrop.dataset.sessionId = sid;
  modal.backdrop.dataset.questionId = qid;
  // F4①:提交按钮点击后禁用 + 「发送中…」,await POST 回来再 close;失败则 toast + 恢复按钮(不 close,让用户重试)。
  submit.onclick = async () => {
    if (submit.disabled) return;
    if (!sid) { toast(t("toast.sessionEndedNoAnswer"), 'err'); modal.close(); return; }
    const answers = list.map((q, qi) => {
      const mine = controls.filter(c => c.qi === qi);
      const picked = mine.filter(c => c.free ? c.input.value.trim() : c.input.checked)
        .map(c => c.free ? c.input.value.trim() : c.label);
      return { question: (q && (q.question || q.header)) || `q${qi}`, answer: picked };
    });
    const content = answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n');
    const prevLabel = submit.textContent;
    submit.disabled = true; submit.textContent = t('chat.sending');
    try {
      const r = await api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid, answers, content }) });
      if (!r?.ok || !r.delivered) throw new Error('answer was not delivered');
      markAnswered();
      modal.close();
    } catch (e) {
      toast(t("toast.answerFail", { p1: apiErrText(e) }), 'err');
      submit.disabled = false; submit.textContent = prevLabel;
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
  if (evt.state === 'node_retry') {
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
    setComposerHint,
    showAskUserModal,
  });
}

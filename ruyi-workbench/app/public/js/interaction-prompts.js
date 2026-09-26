'use strict';

// EC-D：动态模态、AskUser、权限确认、计划决策与工作流事件卡领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, toast, fileBasename } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
// 32 号文 §4（M2-a）：模态原语（背影／焦点陷阱／焦点归还／__cancel）落在叶子 js/modal.js，
// 3.0 管家壳的危险操作确认与这里共用同一份。
import { buildModal as openModal, focusFirstInteractive, installFocusTrap } from './modal.js';
// 135：多条提问／权限排队 + 右下角「等你处理」小窗（排队、计时、对账都在叶子里，弹窗长相仍归本域）。
import { createPromptQueue } from './prompt-queue.js';

export function createInteractionPromptsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  engineLabel = () => '',
  activeTurns = new Map(),
  saveConfigPartial = async () => false,
} = {}) {
// 32 号文 §4（M2-a）：模态原语搬进叶子 js/modal.js，3.0 管家壳的危险操作确认（js/confirm-panel.js）
// 与这里共用同一份。本域保留 2.0 自己的调用形状（title/body/foot/onCancel），实现只此一处。
function buildModal(title, bodyEl, footEl, onCancel) {
  return openModal({ title, body: bodyEl, foot: footEl, onCancel });
}
// §4.9 helper 与焦点陷阱（focusFirstInteractive / installFocusTrap）一并搬进 js/modal.js ——
// 静态模态（index.html）的焦点陷阱仍从本域的返回面取（app.js 那处一个字未动）。

// 135：提问与权限都先进队列（去重、排序、最小化、倒计时），轮到它才由下面两个 render* 画弹窗。
// 修前第二条提问到达会把第一条的弹窗 __cancel 掉（=替用户答了一句「取消」），现在两条都留着、依次答。
function sessionTitleOf(sessionId) {
  const id = String(sessionId || '');
  const hit = (state.sessions || []).find(s => s && String(s.id) === id) || (state.currentSession && String(state.currentSession.id) === id ? state.currentSession : null);
  return hit ? String(hit.title || '') : '';
}
const promptQueue = createPromptQueue({
  api, t, el,
  humanizeToolName: name => humanizeToolName(name),
  sessionTitle: sessionTitleOf,
  openItem: (item, ctx) => (item.type === 'question' ? renderAskModal(item, ctx) : renderPermissionModal(item, ctx)),
  allowToolForThread: async (sessionId, tool, payloads) => {
    sessionAllowAdd(sessionId, tool);
    await Promise.all(payloads.map(p => decide(p.requestId, 'allow', { scope: 'session' })));
  },
});
setTimeout(() => promptQueue.start(), 1500);   // 首拍对账：刷新前就挂着的、别的页面发起的申请

// 弹窗头下的一行：这一条已经等了多久／还剩多久，以及后面还排着几条。每秒刷新，弹窗关掉即停。
function attachQueueStatus(modal, item, { time: showTime = true } = {}) {
  const line = el('div', 'prompt-queue-status');
  const time = el('span', 'pq-time');
  const behind = el('span', 'pq-behind');
  line.append(time, behind);
  const bodyWrap = modal.backdrop.querySelector('.modal-body');
  if (bodyWrap) bodyWrap.prepend(line);
  const sync = () => {
    time.textContent = showTime ? promptQueue.timeText(item.id) : '';
    time.hidden = !showTime;
    const n = Math.max(0, promptQueue.size() - 1);
    behind.textContent = n ? t('promptQueue.modal.queued', { count: n }) : '';
    behind.hidden = !n;
    line.hidden = !showTime && !n;
  };
  sync();
  const timer = setInterval(() => { if (!modal.backdrop.isConnected) { clearInterval(timer); return; } sync(); }, 1000);
}
function minimizeButton(ctx, modalRef) {
  const b = el('button', 'ghost prompt-minimize', t('promptQueue.modal.minimize'));
  b.type = 'button';
  b.title = t('promptQueue.modal.minimizeHint');
  b.onclick = () => { ctx.minimize(); if (modalRef.current) modalRef.current.close(); };
  return b;
}

function showAskUserModal(questionId, questions, streamSessionId, context = '', deadlineAt = 0) {
  const sid = streamSessionId || state.currentSession?.id; // pin the session the question belongs to
  const qid = String(questionId || '');
  const turn = sid ? activeTurns.get(sid) : null;
  if (!sid || !qid || turn?.answeredQuestions?.has(qid) || promptQueue.isSettled(qid)) return;
  // 重放同一条 ask_user：队列按 id 去重，不会再弹第二个，也不会替用户发一句取消。
  promptQueue.offer({ id: qid, type: 'question', sessionId: sid, deadlineAt: Number(deadlineAt) || 0, payload: { questions, context } });
}
function renderAskModal(item, ctx) {
  const sid = item.sessionId;
  const qid = item.id;
  const questions = item.payload.questions;
  const context = item.payload.context || '';
  const deadlineAt = item.deadlineAt;
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
  // 135：别的线程的提问也会轮到这里,与权限弹窗同一行写清是谁在问。
  const askThreadTitle = sessionTitleOf(sid) || item.title || '';
  if (askThreadTitle && sid !== String(state.currentSession?.id || '')) body.appendChild(el('div', 'perm-thread', t('promptQueue.modal.fromThread', { title: askThreadTitle })));
  if (String(context || '').trim()) {
    const contextBox = el('section', 'ask-context');
    contextBox.append(el('div', 'ask-context-label', t('ask.contextLabel')),
      el('p', 'ask-context-copy', String(context).trim()));
    body.appendChild(contextBox);
  }
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
      if (q.allowOther !== false) {
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
  // Server broadcasts deadlineAt on ask_user; while this modal stays open a heartbeat keeps re-arming
  // the timer, so a long answer is never cut short. The countdown makes that window visible.
  let currentDeadline = Number(deadlineAt) || 0;
  const countdown = el('span', 'ask-countdown');
  const formatRemain = ms => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const syncCountdown = () => {
    const remain = currentDeadline - Date.now();
    countdown.textContent = t('ask.countdown', { time: formatRemain(remain) });
    countdown.classList.toggle('warn', remain <= 60000);
  };
  const footActions = el('div', 'ask-foot-actions');
  if (currentDeadline > 0) footActions.appendChild(countdown);
  const modalRef = { current: null };
  footActions.append(minimizeButton(ctx, modalRef), footHint, submit);
  const markAnswered = () => { const active = activeTurns.get(sid); if (active?.answeredQuestions) active.answeredQuestions.add(qid); };
  // 135：Esc／✕／点背影 = 收进右下角小窗，不再替用户答一句「取消」—— 这道题照样挂着，排在队列里等你回来。
  // 真要放弃就在小窗里打开它再答；超时仍按后端原语义（questionTimeoutMs）。
  const modal = buildModal(t('ask.title'), body, footActions, () => ctx.minimize());
  modalRef.current = modal;
  // F4②:标记为 ask modal(resolveClassicPromptIntervention 据此精确关掉它)。
  modal.backdrop.classList.add('ask-modal', 'prompt-queue-modal');
  modal.backdrop.querySelector('.modal')?.classList.add('ask-question-modal');
  modal.backdrop.dataset.sessionId = sid;
  modal.backdrop.dataset.questionId = qid;
  attachQueueStatus(modal, item, { time: false });
  if (currentDeadline > 0) {
    syncCountdown();
    // 修前两只定时器挂在一个从不触发的 'remove' 事件上(DOM 没有这个事件),弹窗关掉后还一直跑;改成自查在不在屏上。
    const tickTimer = setInterval(() => { if (!modal.backdrop.isConnected) { clearInterval(tickTimer); return; } syncCountdown(); }, 1000);
    const heartbeatTimer = setInterval(() => {
      if (!modal.backdrop.isConnected) { clearInterval(heartbeatTimer); return; }
      api('/api/question/heartbeat', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid }) })
        .then(r => {
          const next = Number(r && r.deadlineAt) || 0;
          if (next > 0) { currentDeadline = next; item.deadlineAt = next; syncCountdown(); }
        })
        .catch(() => { clearInterval(heartbeatTimer); }); // 409 → question already settled server-side
    }, 30000);
  }
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
    if (!sid) { toast(t("toast.sessionEndedNoAnswer"), 'err'); ctx.done(); return; }
    const answers = collectAnswers();
    const content = answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n');
    const prevLabel = submit.textContent;
    submit.disabled = true; submit.textContent = t('ask.sending');
    try {
      const r = await api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, questionId: qid, answers, content }) });
      if (!r?.ok || !r.delivered) throw new Error('answer was not delivered');
      markAnswered();
      ctx.done();   // 出队并关弹窗;队列里还有就轮到下一条
    } catch (e) {
      toast(t("toast.answerFail", { p1: apiErrText(e) }), 'err');
      submit.disabled = false; submit.textContent = prevLabel;
      syncState();
    }
  };
  return modal;
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
  // 128d(48 号文 §1,simple-mode.browser S5 查出):这张表当初是给【授权弹窗】写的,只收会弹窗的改/执行类工具;
  // 简易档的工具卡复用同一个函数,于是最常见的读类工具(file_read、web_search……)在出厂默认档里原样显示英文标识。
  // 现在补齐全部原生工具(管家与工作台记忆两族走下面的前缀);tool-verb-coverage.static 钉「每个原生工具都有人话」。
  audio_transcribe: 'tools.verb.audio_transcribe', browser_open: 'tools.verb.browser_open', claude_md_audit: 'tools.verb.claude_md_audit',
  code_review_scan: 'tools.verb.code_review_scan', codebase_symbol_search: 'tools.verb.codebase_symbol_search', data_profile: 'tools.verb.data_profile',
  debug_hypothesis: 'tools.verb.debug_hypothesis', dependency_inventory: 'tools.verb.dependency_inventory', docs_search: 'tools.verb.docs_search',
  file_list: 'tools.verb.file_list', file_read: 'tools.verb.file_read', file_search: 'tools.verb.file_search', frontend_audit: 'tools.verb.frontend_audit',
  agent_result: 'tools.verb.agent_result', // 代理模式 v2:按需读代理产出全文
  glob: 'tools.verb.glob', list_tools: 'tools.verb.list_tools', mcp_configure: 'tools.verb.mcp_configure', mcp_list: 'tools.verb.mcp_list',
  mission_update: 'tools.verb.mission_update', observation_recall: 'tools.verb.observation_recall', office_open: 'tools.verb.office_open',
  orchestrate_agents: 'tools.verb.orchestrate_agents', permission_prompt: 'tools.verb.permission_prompt', project_snapshot: 'tools.verb.project_snapshot',
  request_user_input: 'tools.verb.request_user_input', skill_read: 'tools.verb.skill_read', spawn_agent: 'tools.verb.spawn_agent',
  todo_write: 'tools.verb.todo_write', tool_invoke_read: 'tools.verb.tool_invoke', tool_invoke_edit: 'tools.verb.tool_invoke', tool_invoke_exec: 'tools.verb.tool_invoke',
  tool_load: 'tools.verb.tool_load', tool_search: 'tools.verb.tool_search', wait_agents: 'tools.verb.wait_agents', web_fetch: 'tools.verb.web_fetch',
  web_search: 'tools.verb.web_search', workbench_self_status: 'tools.verb.workbench_self_status',
};
function humanizeToolName(name) {
  const n = String(name || '');
  if (!n) return t('tools.verb.unknown');
  if (TOOL_VERB_MAP[n]) return t(TOOL_VERB_MAP[n]);
  if (n.startsWith('shell_')) return t('tools.verb.shell');
  if (n.startsWith('workbench_memory_')) return t('tools.verb.memory');
  if (n.startsWith('steward_')) return t('tools.verb.steward');
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
// 135：streamSessionId 是【这条事件所属的会话】。修前取 state.currentSession —— 后台线程的申请一律不经这里,
// 所以两者恒等;现在后台线程的申请也走这里(进队列),必须按事件自己的会话记「本次会话自动允许」。
function handlePermissionRequest(evt, streamSessionId) {
  const sid = String(streamSessionId || state.currentSession?.id || '');
  const id = String(evt && evt.requestId || '');
  if (!id || promptQueue.isSettled(id)) return;   // 回到线程时事件重放:已决定的不再弹
  const tool = evt.toolName || 'unknown';
  // Session-scoped auto-allow: skip the popup entirely for a tool the user already blessed this session.
  if (sessionAllowHas(sid, tool)) { decide(id, 'allow'); promptQueue.settle(id); return; }
  promptQueue.offer({ id, type: 'permission', sessionId: sid, payload: { ...evt, requestId: id } });
}
// 事件流里看到了结果(permission_decision / question_answer):不论是谁、在哪儿决定的,出队。
function settlePrompt(id) { promptQueue.settle(id); }

// 体验走查 #12：修前弹窗正文是「file_write」＋ 整段 JSON 参数（右侧还被截断）—— 那是给程序员看的。先用一句人话说清
// 「要干什么、对哪个文件」，要写入的内容给个预览；原始工具名与 JSON 收进「技术详情」（精简档默认收起，专业档默认展开）。
// 只认得的几种给人话；认不出的回 null，正文照旧只有人话动词＋技术详情（不编造）。
const PERMISSION_PREVIEW_MAX_LINES = 12;
function permissionPlainSummary(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = p => fileBasename(String(p || '')) || String(p || '');
  const lineCount = text => { const v = String(text ?? '').replace(/\r?\n$/, ''); return v ? v.split(/\r?\n/).length : 0; };   // 末尾那个换行不算一行
  if (tool === 'file_write' && i.path) return { text: t('permission.plain.write', { file: file(i.path), lines: lineCount(i.content) }), preview: String(i.content ?? '') };
  if (tool === 'file_edit' && i.path) return { text: t('permission.plain.edit', { file: file(i.path) }), preview: i.newText != null ? String(i.newText) : '' };
  if (tool === 'file_delete' && i.path) return { text: t('permission.plain.delete', { file: file(i.path) }), preview: '' };
  if ((tool === 'file_move' || tool === 'file_copy') && (i.from || i.to)) return { text: t(tool === 'file_move' ? 'permission.plain.move' : 'permission.plain.copy', { from: file(i.from), to: String(i.to || '') }), preview: '' };
  if (tool === 'powershell_run' && i.command) return { text: t('permission.plain.command'), preview: String(i.command) };
  if (tool === 'script_run' && i.code) return { text: t('permission.plain.script', { language: String(i.language || '') }), preview: String(i.code) };
  if (tool === 'http_download' && i.url) return { text: t('permission.plain.download', { url: String(i.url), file: file(i.dest) }), preview: '' };
  if (i.path) return { text: t('permission.plain.onFile', { verb: humanizeToolName(tool), file: file(i.path) }), preview: '' };
  return null;
}
function renderPermissionModal(item, ctx) {
  const evt = item.payload;
  const sid = item.sessionId;
  const tool = evt.toolName || 'unknown';
  const tier = TIER_META[evt.tier] ? evt.tier : 'exec';
  const tierMeta = permissionTierMeta(tier);
  const revertible = evt.revertible === true;

  const body = el('div');
  // 135：后台线程的申请也会轮到这里,得写清是哪条线程在要权限。
  const threadTitle = sessionTitleOf(sid) || item.title || '';
  if (threadTitle && sid !== String(state.currentSession?.id || '')) body.appendChild(el('div', 'perm-thread', t('promptQueue.modal.fromThread', { title: threadTitle })));
  // Humanized title + raw tool name (mono, secondary) so power users still see exactly what runs.
  body.appendChild(el('p', '', t('permission.request.intent', { engine: engineLabel() })));
  const titleRow = el('div', 'perm-title-row');
  titleRow.append(el('span', 'perm-verb', humanizeToolName(tool)));
  const badge = el('span', `perm-tier ${tierMeta.cls}`);
  badge.append(el('span', 'perm-tier-dot'), el('span', '', tierMeta.label));
  titleRow.append(badge);
  body.append(titleRow);
  const plain = permissionPlainSummary(tool, evt.input);
  if (plain) body.appendChild(el('p', 'perm-plain', plain.text));
  // Revertibility line — the decision-moment trust signal (B3). Uses the event's `revertible` field
  // (server truth); the front-end does NOT re-implement the tier→revertible table.
  const revLine = el('div', `perm-revert ${revertible ? 'yes' : 'no'}`,
    revertible ? t('permission.revertible') : t('permission.notRevertible'));
  body.append(revLine);
  const preStyle = 'background:var(--code-bg);border-radius:6px;padding:8px;max-height:200px;overflow:auto;font-family:var(--mono);font-size:var(--fs-sm);white-space:pre-wrap;word-break:break-word';
  if (plain && plain.preview) {
    const lines = plain.preview.split(/\r?\n/);
    const preview = el('pre', 'perm-preview'); preview.style.cssText = preStyle;
    preview.textContent = lines.slice(0, PERMISSION_PREVIEW_MAX_LINES).join('\n') + (lines.length > PERMISSION_PREVIEW_MAX_LINES ? '\n' + t('permission.plain.more', { count: lines.length - PERMISSION_PREVIEW_MAX_LINES }) : '');
    body.appendChild(preview);
  }
  const tech = document.createElement('details');
  tech.className = 'perm-tech';
  tech.open = document.documentElement.getAttribute('data-ui-mode') === 'pro' && !plain;   // 认得的动作：人话已经说清，技术详情收起
  tech.appendChild(el('summary', '', t('permission.plain.techDetails')));
  tech.appendChild(el('div', 's-title perm-rawname', tool));
  const pre = el('pre'); pre.style.cssText = preStyle;
  pre.textContent = (() => { try { return JSON.stringify(evt.input, null, 2); } catch { return String(evt.input); } })();
  tech.appendChild(pre);
  body.appendChild(tech);
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
  const modalRef = { current: null };
  foot.append(minimizeButton(ctx, modalRef), deny, allow);
  // 135：Esc／✕／点背影 = 收进右下角小窗。修前是「取消即拒绝」,叠着几个弹窗时一次 Esc 全部拒掉。
  // 拒绝只剩那枚明确的「拒绝」按钮;没人管的申请仍按后端超时自动拒绝(小窗里有倒计时)。
  const modal = buildModal(t('permission.request.title', { engine: engineLabel() }), body, foot, () => ctx.minimize());
  modalRef.current = modal;
  modal.backdrop.classList.add('permission-modal', 'prompt-queue-modal');
  modal.backdrop.dataset.sessionId = sid;
  modal.backdrop.dataset.interventionId = String(evt.requestId || '');
  attachQueueStatus(modal, item);
  deny.onclick = () => { decide(evt.requestId, 'deny', { message: t('permission.request.denied') }); ctx.done(); };
  allow.onclick = () => {
    if (sessBox.checked) {
      sessionAllowAdd(sid, tool);
      // 同一线程里已经排着的同一工具申请:勾了「本次会话自动允许」就一并放行,不再一个个弹。
      for (const queued of promptQueue.list()) {
        if (queued.id === item.id || queued.type !== 'permission' || queued.sessionId !== sid) continue;
        if (String(queued.payload.toolName || '') !== tool) continue;
        decide(queued.id, 'allow', { scope: 'session' });
        promptQueue.settle(queued.id);
      }
    }
    if (permBox && permBox.checked) {
      // Persist a read/edit allow rule. normalizeConfig will drop it server-side if the tier disqualifies
      // it, so this is safe even if the tier badge and the server disagree.
      const rules = { ...(state.config.toolAllowRules || {}), [tool]: 'allow' };
      saveConfigPartial({ toolAllowRules: rules });
      toast(t('permission.alwaysAllowed', { tool: humanizeToolName(tool) }), 'ok');
    }
    decide(evt.requestId, 'allow', sessBox.checked ? { scope: 'session' } : undefined); ctx.done();
  };
  return modal;
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
  // 135：先出队(队列持有的弹窗由它自己关,不走 cancel 路径);下面照旧兜住队列之外的老弹窗。
  const queued = promptQueue.has(id);
  promptQueue.settle(id);
  if (queued) return true;
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
  var shouldAutoFocus = evt.action === 'start' || evt.action === 'resume';
  if (evt && evt.runId && typeof syncAgentRunsPolling === 'function') {
    // A provider-side orchestrate_agents run is a separate persisted run; focus it as soon as the stream announces it.
    if (shouldAutoFocus) {
      if (typeof wbState !== 'undefined' && wbState) {
        wbState.selectedRunId = String(evt.runId);
        wbState.selectedNodeId = null;
      }
    }
    syncAgentRunsPolling().then(function () {
      if (shouldAutoFocus && typeof wbSelectRun === 'function') wbSelectRun(String(evt.runId));
    }).catch(function () {});
  }
  const id = evt.id || '';
  if (evt.state === 'start') {
    const d = el('details', 'subagent-card'); d.open = true;
    const sum = el('summary', 'subagent-head');
    const background = evt.background === true; // 代理模式 v2:后台 run —— 本回合不等待,卡片标后台样式
    sum.append(el('span', 'sa-icon', '🕸️'), el('span', 'sa-title', t('workflow.run.title', { count: evt.nodeCount || 0 })), el('span', 'sa-status', background ? t('workflow.run.background', { count: evt.concurrency || 1 }) : t('workflow.run.running', { count: evt.concurrency || 1 })));
    if (background) { d.classList.add('sa-background'); d.open = false; }
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
    settlePrompt,
    showAskUserModal,
    // 135:组合根把那一条共用的事件流交进来(app.js 里事件流建在本域之后)。
    bindPromptQueueEvents: eventStream => promptQueue.bindEventStream(eventStream),
  });
}

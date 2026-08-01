'use strict';

// EC-D：计划卡、原始事件、通用工具调用与 PowerShell 会话领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, escapeHtml, toast } from './util.js';
import { t } from './i18n.js';

export function createToolRuntimeDomain({
  apiErrText = error => String(error && error.message || error || ''),
  decidePlan = () => {},
  setComposerHint = () => {},
  engineLabel = () => '',
  renderMarkdown = text => String(text || ''),
  highlightIn = () => {},
  sealLiveTextSegment = () => {},
  maybeScrollToBottom = () => {},
} = {}) {
const PLAN_DECISION_PREFIX = 'wcw.plan.';
function loadPlanDecision(planId) {
  if (!planId) return null;
  try { const raw = localStorage.getItem(PLAN_DECISION_PREFIX + planId); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function savePlanDecision(planId, decision, note) {
  if (!planId) return;
  try { localStorage.setItem(PLAN_DECISION_PREFIX + planId, JSON.stringify({ decision, note: note || '', ts: Date.now() })); }
  catch { /* ignore */ }
}
// 已在本次页面生命周期内渲染过的 planId 集合 —— F1c 去重守卫:同一个 planId 的 plan 事件重放不再叠卡;
// 但新的 planId(第二次计划)永不被挡(见 handlePlanEvent 入口)。
const renderedPlanIds = new Set();

// 计划决策后收起的人话结果文案(F1a)。
function planResultLabel(decision, note) {
  if (decision === 'reject') return { text: t('plan.result.rejected'), cls: 'rej' };
  return { text: note ? t('plan.result.approvedWithNote') : t('plan.result.approved'), cls: 'ok' };
}

// 构建一张计划卡的 DOM。decidedState 非空 → 直接渲染为收起态(静态重渲染 / 已决策);否则渲染可操作态,
// 由调用方接线按钮。返回 { card, setDecided } 供 live 路径决策后收起。markdown 走 renderMarkdown(白名单消毒)。
function buildPlanCard(planId, markdown) {
  const card = el('div', 'plan-card');
  card.dataset.planId = String(planId || '');
  // 收起态点击展开:头部作为可点区域。展开=切换 .plan-expanded(CSS 收起态下也能重新露出正文)。
  const head = el('div', 'plan-card-head', t('plan.card.heading', { engine: engineLabel() }));
  card.appendChild(head);

  const md = el('div', 'plan-card-body md');
  md.innerHTML = renderMarkdown(markdown || ''); // renderMarkdown sanitizes (allowlist + protocol filter)
  card.appendChild(md);
  highlightIn(md);

  // 修改意见 textarea — hidden until 「修改意见」 is clicked; submitting it = approve carrying the note.
  const noteWrap = el('div', 'plan-card-note'); noteWrap.style.display = 'none';
  const noteTa = document.createElement('textarea');
  noteTa.rows = 2; noteTa.placeholder = t('plan.card.notePlaceholder');
  const noteSend = el('button', 'primary', t('plan.card.approveWithNote'));
  noteWrap.append(noteTa, noteSend);
  card.appendChild(noteWrap);

  const foot = el('div', 'plan-card-foot');
  const approve = el('button', 'primary', t('plan.card.approve'));
  const amend = el('button', 'ghost', t('plan.card.amend'));
  const reject = el('button', 'danger', t('plan.card.reject'));
  foot.append(approve, amend, reject);
  card.appendChild(foot);

  // 收起结果行(始终建好,decided 前不显示)。点击它或头部可展开/收起原文。
  const res = el('div', 'plan-card-result');
  card.appendChild(res);

  // F1a:收起态下点头部/结果行 → 切换展开,让用户重看原计划。
  const toggleExpand = () => { if (card.classList.contains('decided')) card.classList.toggle('plan-expanded'); };
  head.style.cursor = 'pointer';
  head.addEventListener('click', toggleExpand);
  res.addEventListener('click', toggleExpand);

  const setDecided = (decision, note) => {
    card.classList.add('decided');
    card.classList.remove('plan-expanded');
    [approve, amend, reject, noteSend].forEach(b => { b.disabled = true; });
    noteWrap.style.display = 'none';
    const lab = planResultLabel(decision, note);
    res.textContent = lab.text + t('plan.result.expandHint');
    res.className = `plan-card-result ${lab.cls}`;
  };

  return { card, head, approve, amend, reject, noteWrap, noteTa, noteSend, setDecided };
}

// Render the in-flow plan card. `main` is the live assistant message container. `live` is the streaming
// state (F1b: sealing the current text bubble so post-plan deltas land BELOW the card, not above it).
// The card shows the plan markdown + 批准执行 / 修改意见 / 放弃; a decision POSTs to /api/plan/decision and the
// turn resumes (approve) or ends (reject). After a decision the card collapses to a one-line result (F1a),
// and the decision is persisted by planId (F1d) so a session reload re-renders it collapsed.
function handlePlanEvent(evt, main, live) {
  const planId = evt.planId || '';
  // F1c 去重守卫:同一 planId 的重放不叠卡(新 planId —— 第二次计划 —— 不受影响,继续渲染)。
  if (planId && renderedPlanIds.has(planId)) return;
  if (planId) renderedPlanIds.add(planId);

  // 第54波: plan 本身通常已作为 assistant_delta 流过。若当前文本块与 markdown 相同，转成语义计划卡
  // 而不是重复显示；后续 assistant_delta 会在卡片后按需创建新的文本段。
  if (live) sealLiveTextSegment(live, evt.markdown || '');

  const built = buildPlanCard(planId, evt.markdown || '');
  const { card, approve, amend, reject, noteWrap, noteTa, noteSend, setDecided } = built;

  let decided = false;
  const finish = (decision, note) => {
    if (decided) return; decided = true;
    setComposerHint('');
    setDecided(decision, note);
    savePlanDecision(planId, decision, note); // F1d 持久化
  };
  card.__resolveIntervention = finish;

  approve.onclick = async () => { const r = await decidePlan(planId, 'approve'); if (r && r.ok) finish('approve'); else if (r) toast(r.error || t('plan.expired'), ''); };
  reject.onclick = async () => { const r = await decidePlan(planId, 'reject'); if (r && r.ok) finish('reject'); else if (r) toast(r.error || t('plan.expired'), ''); };
  amend.onclick = () => { noteWrap.style.display = ''; noteTa.focus(); };
  noteSend.onclick = async () => {
    const note = noteTa.value.trim();
    const r = await decidePlan(planId, 'approve', note);
    if (r && r.ok) finish('approve', note);
    else if (r) toast(r.error || t('plan.expired'), '');
  };

  const host = main || $('messages');
  // F1b:计划卡插在已封存的旧 bubble 之后、新 bubble(若已建)之前。此刻新 bubble 尚未建(finish 才建),
  // 所以直接 append 即可落在旧文本块之后。
  host.appendChild(card);
  setComposerHint(t('plan.awaitingApproval'));
  maybeScrollToBottom();
}

function resolveClassicPlanIntervention({ interventionId, action, feedback } = {}) {
  const id = String(interventionId || '');
  if (!id) return false;
  const card = [...document.querySelectorAll('.plan-card[data-plan-id]')].find(node => node.dataset.planId === id);
  if (!card || typeof card.__resolveIntervention !== 'function') return false;
  card.__resolveIntervention(action === 'reject' ? 'reject' : 'approve', String(feedback || ''));
  return true;
}

/* ---------------- debug panel ---------------- */
let rawEventDomQueue = [];
let rawEventRaf = 0;
function rawEventRow(item) {
  const row = el('div', 'rl');
  row.innerHTML = `<span class="seq">#${item.seq}</span> ${escapeHtml(String(item.line || '').slice(0, 4000))}`;
  return row;
}
function renderRawEventSnapshot() {
  const pre = $('rawEvents'); if (!pre) return;
  const frag = document.createDocumentFragment();
  for (const item of state.rawEvents) frag.appendChild(rawEventRow(item));
  pre.replaceChildren(frag);
  rawEventDomQueue = [];
  if ($('debugAutoscroll')?.checked) pre.scrollTop = pre.scrollHeight;
}
function scheduleRawEventDom(item) {
  // The debug feed used to build thousands of hidden DOM rows during normal chat streaming. Keep only the
  // bounded data cache while its tab is hidden; render it on demand when Debug is opened.
  const active = document.querySelector('.tool-pane .tool-tabs button[data-tab="debug"].active');
  if (!active) return;
  rawEventDomQueue.push(item);
  if (rawEventRaf) return;
  rawEventRaf = requestAnimationFrame(() => {
    rawEventRaf = 0;
    const pre = $('rawEvents'); if (!pre) { rawEventDomQueue = []; return; }
    const frag = document.createDocumentFragment();
    for (const queued of rawEventDomQueue.splice(0)) frag.appendChild(rawEventRow(queued));
    pre.appendChild(frag);
    while (pre.childElementCount > 2000) pre.firstChild.remove();
    if ($('debugAutoscroll')?.checked) pre.scrollTop = pre.scrollHeight;
  });
}
function pushRawEvent(seq, line) {
  const item = { seq, line };
  state.rawEvents.push(item);
  if (state.rawEvents.length > 2000) state.rawEvents.shift();
  scheduleRawEventDom(item);
}
function appendToolOutput(value, append = false) {
  const out = $('toolOutput');
  const txt = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  out.textContent = append ? `${out.textContent}\n${txt}`.slice(-20000) : txt;
}

/* ---------------- tools ---------------- */
async function runTool(name, body) {
  appendToolOutput(t('status.running'));
  try { const res = await api(`/api/tools/${name}`, { method: 'POST', body: JSON.stringify(body || {}) }); appendToolOutput(res.result); }
  catch (err) { appendToolOutput(err.message || String(err)); toast(t("toast.toolError", { p1: apiErrText(err) }), 'err'); }
}

/* 第59波：文件浏览与安全预览实现已拆入 ./js/file-browser.js。 */

/* 第59波：产物画廊实现已拆入 ./js/artifact-changes.js。 */

/* 第59波：审计、存储与性能观测实现已拆入 ./js/operations-observability.js。 */

/* 第59波：变更中心实现已拆入 ./js/artifact-changes.js。 */

/* ---------------- v0.8-S2: persistent shell sessions (provider engine only) ---------------- */
// The model drives shell_start/send/poll; this panel is an observability + control surface. Session
// state lives in the serve process, so it is provider-engine only (an empty state note says so). We
// poll shell_list every 2s ONLY while the PowerShell tab is active, and tail one expanded session's
// output via shell_poll every 1.5s (remembering its absolute-byte cursor for incremental append).
const shellUi = {
  listTimer: null,        // 2s shell_list poller (only while tab active)
  tailTimer: null,        // 1.5s shell_poll poller for the expanded session
  expanded: null,         // shellId currently expanded for output tailing
  cursor: 0,              // absolute byte cursor for the expanded session's tail
};

async function shellCall(name, body) {
  return api(`/api/tools/${name}`, { method: 'POST', body: JSON.stringify(body || {}) });
}

function shellTabActive() {
  const sec = $('tab-powershell');
  return sec && sec.classList.contains('active');
}

async function refreshShellList() {
  const host = $('shellSessionList');
  if (!host) return;
  let shells = [];
  try { const res = await shellCall('shell_list', {}); shells = (res.result && res.result.shells) || []; }
  catch { /* provider off or error — treated as empty below */ }
  // Preserve the currently-expanded <pre> so tailing isn't interrupted by a list refresh.
  const openPre = shellUi.expanded ? host.querySelector(`[data-shell-pre="${shellUi.expanded}"]`) : null;
  const openText = openPre ? openPre.textContent : '';
  host.innerHTML = '';
  if (!shells.length) {
    const empty = el('div', 'shell-empty', t('chat.shellHint'));
    host.appendChild(empty);
    return;
  }
  for (const s of shells) {
    const row = el('div', 'shell-item');
    const head = el('div', 'shell-item-head');
    const dot = el('span', 'shell-dot' + (s.running ? ' running' : ' stopped'));
    dot.title = s.running ? t('status.runningShort') : (t('status.ended') + (s.exitCode != null ? `(exit ${s.exitCode})` : ''));
    const meta = el('div', 'shell-meta');
    const title = el('div', 'shell-name');
    title.appendChild(dot);
    title.appendChild(el('span', 'shell-name-text', s.name || s.shellId));
    if (s.name && s.name !== s.shellId) title.appendChild(el('span', 'shell-id', s.shellId));
    meta.appendChild(title);
    meta.appendChild(el('div', 'shell-cwd', s.cwd || ''));
    head.appendChild(meta);
    const actions = el('div', 'shell-actions');
    const viewBtn = el('button', 'mini', shellUi.expanded === s.shellId ? t('common.collapse') : t('common.view'));
    viewBtn.onclick = () => toggleShellView(s.shellId);
    const killBtn = el('button', 'mini danger', t('common.end'));
    killBtn.onclick = () => killShell(s.shellId);
    actions.appendChild(viewBtn);
    actions.appendChild(killBtn);
    head.appendChild(actions);
    row.appendChild(head);
    if (shellUi.expanded === s.shellId) {
      const pre = el('pre', 'shell-output');
      pre.setAttribute('data-shell-pre', s.shellId);
      pre.textContent = openText; // carry over accumulated tail across the list refresh
      row.appendChild(pre);
    }
    host.appendChild(row);
  }
}

function toggleShellView(shellId) {
  if (shellUi.expanded === shellId) { stopShellTail(); shellUi.expanded = null; }
  else { stopShellTail(); shellUi.expanded = shellId; shellUi.cursor = 0; startShellTail(); }
  refreshShellList();
}

function startShellTail() {
  stopShellTail();
  const tick = async () => {
    if (!shellUi.expanded) return;
    try {
      const res = await shellCall('shell_poll', { shellId: shellUi.expanded, cursor: shellUi.cursor });
      const r = res.result || {};
      if (r.ok) {
        const pre = $('shellSessionList').querySelector(`[data-shell-pre="${shellUi.expanded}"]`);
        if (pre && typeof r.output === 'string' && r.output.length) {
          const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
          pre.textContent = (pre.textContent + r.output).slice(-40000);
          if (atBottom) pre.scrollTop = pre.scrollHeight; // auto-scroll to bottom while following
        }
        if (typeof r.cursor === 'number') shellUi.cursor = r.cursor;
      }
    } catch { /* transient — keep polling */ }
  };
  tick();
  shellUi.tailTimer = setInterval(tick, 1500);
}

function stopShellTail() {
  if (shellUi.tailTimer) { clearInterval(shellUi.tailTimer); shellUi.tailTimer = null; }
}

async function killShell(shellId) {
  try { await shellCall('shell_kill', { shellId }); toast(t("toast.shellEnded"), 'ok'); }
  catch (err) { toast(t("toast.endFail", { p1: apiErrText(err) }), 'err'); }
  if (shellUi.expanded === shellId) { stopShellTail(); shellUi.expanded = null; }
  refreshShellList();
}

async function newShellSession() {
  const cwd = (state.config && state.config.defaultWorkspace) || '';
  try { const res = await shellCall('shell_start', { cwd }); const r = res.result || {};
    if (r.ok) toast(t("toast.shellCreated", { p1: r.name || r.shellId }), 'ok');
    else toast(r.error || t('common.createFailed'), 'err');
  } catch (err) { toast(t("toast.createFail", { p1: apiErrText(err) }), 'err'); }
  refreshShellList();
}

// Start/stop the 2s list poll based on whether the PowerShell tab is active (cheap when hidden).
function updateShellPolling() {
  if (shellTabActive()) {
    if (!shellUi.listTimer) { refreshShellList(); shellUi.listTimer = setInterval(refreshShellList, 2000); }
    if (shellUi.expanded && !shellUi.tailTimer) startShellTail();
  } else {
    if (shellUi.listTimer) { clearInterval(shellUi.listTimer); shellUi.listTimer = null; }
    stopShellTail();
  }
}

/* ---------------- config / status ---------------- */
/* EC-D：技能与记忆实现已拆入 ./js/skills-memory.js。 */
  return Object.freeze({
    appendToolOutput,
    handlePlanEvent,
    newShellSession,
    pushRawEvent,
    renderRawEventSnapshot,
    resolveClassicPlanIntervention,
    runTool,
    updateShellPolling,
  });
}

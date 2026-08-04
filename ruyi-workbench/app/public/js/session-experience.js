'use strict';

// EC-D：会话侧栏、任务/授权状态、历史渲染、空态与 Playbook 领域。
import { state, MSG_WINDOW_STEP, MSG_WINDOW_TAIL, MSG_WINDOW_THRESHOLD } from './state.js';
import { api } from './net.js';
import { $, el, autoGrow, fileBasename, toast } from './util.js';
import { icon } from './icons.js';
import { getLocale, t, tCount } from './i18n.js';
import {
  captureScrollAnchor,
  messageDomKey,
  messageRenderSignature,
  restoreScrollAnchor,
  visibleSessionMessageEntries,
  weightedMessageTailStart,
} from './turn-narrative.js';
import { ARTIFACT_KIND_ICON } from './artifact-changes.js';

export function createSessionExperienceDomain({
  apiErrText = error => String(error && error.message || error || ''),
  openModal = () => {},
  switchSettingsTab = () => {},
  activeTurns = new Map(),
  openCapPopover = () => {},
  openPermPopover = () => {},
  sendPrompt = async () => {},
  syncStreamingUi = () => {},
  buildModal = () => null,
  renderContextMeter = () => {},
  isProviderMode = () => false,
  activeProviderObj = () => null,
  currentEngineMeta = () => ({}),
  engineVisual = () => ({}),
  engineLabel = () => '',
  currentModelId = () => '',
  openRenamePopover = () => {},
  steerPendingList = [],
  steeredSeen = [],
  resetStickyScroll = () => {},
  scrollMessagesToBottom = () => {},
  mountActiveTurn = () => false,
  renderWorkspacePicker = () => {},
  updateSkillBadge = () => {},
  renderStaticMessage = () => null,
  latestUsage = () => null,
  pickWorkspaceNative = async () => '',
  playbookDisplayName = playbook => String(playbook && playbook.title || ''),
  playbookDisplayDescription = playbook => String(playbook && playbook.desc || ''),
  playbookDisplayUnavailableReason = () => '',
  playbookInputLabel = (_playbook, input) => String(input && input.label || ''),
} = {}) {
function groupKey(iso) {
  const d = new Date(iso); const now = new Date();
  const days = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (days <= 0) return 'session.today';
  if (days === 1) return 'session.yesterday';
  if (days <= 7) return 'session.thisWeek';
  return 'session.earlier';
}
function renderSessions() {
  const list = $('sessionList');
  const q = $('sessionSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  const filtered = state.sessions.filter(s => !q || (s.title || '').toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  const pinned = filtered.filter(s => s.pinned);
  const rest = filtered.filter(s => !s.pinned);
  const groups = [];
  if (pinned.length) groups.push([`📌 ${t('session.pinned')}`, pinned]);
  const byGroup = {};
  for (const s of rest) { const g = groupKey(s.updatedAt); (byGroup[g] = byGroup[g] || []).push(s); }
  for (const g of ['session.today', 'session.yesterday', 'session.thisWeek', 'session.earlier']) if (byGroup[g]) groups.push([t(g), byGroup[g]]);

  for (const [label, items] of groups) {
    list.appendChild(el('div', 'session-group-label', label));
    for (const s of items) list.appendChild(sessionItem(s));
  }
  if (!filtered.length) list.appendChild(el('div', 'muted', q ? t('session.noMatch') : t('session.empty')));
}
function sessionItem(s) {
  const item = el('button', `session-item ${state.currentSession?.id === s.id ? 'active' : ''}`);
  const title = el('span', 's-title', (s.pinned ? '📌 ' : '') + sessionDisplayTitle(s)); // 50-fix:未命名显示本地化占位
  const running = activeTurns.has(s.id);
  if (running) item.classList.add('running');
  const subParts = [running ? `◐ ${t('session.running')}` : '', tCount('session.messageCount', s.messageCount || 0), s.summary || s.cwd || ''].filter(Boolean);
  const sub = el('span', 's-sub', subParts.join(' · '));
  const actions = el('span', 's-actions');
  const pinBtn = el('button', s.pinned ? 's-act pinned' : 's-act'); pinBtn.appendChild(icon('pin', 15)); pinBtn.title = s.pinned ? t('session.unpin') : t('session.pin'); pinBtn.setAttribute('aria-label', pinBtn.title);
  pinBtn.onclick = e => { e.stopPropagation(); patchSession(s.id, { pinned: !s.pinned }); };
  const renameBtn = el('button', 's-act'); renameBtn.appendChild(icon('edit', 15)); renameBtn.title = t('session.rename'); renameBtn.setAttribute('aria-label', renameBtn.title);
  renameBtn.onclick = e => { e.stopPropagation(); openRenamePopover(renameBtn, s); };
  const delBtn = el('button', 's-act'); delBtn.appendChild(icon('trash', 15)); delBtn.title = t('session.delete'); delBtn.setAttribute('aria-label', delBtn.title);
  delBtn.onclick = e => { e.stopPropagation(); if (confirm(t('session.delete.confirm'))) removeSession(s.id); };
  actions.append(pinBtn, renameBtn, delBtn);
  item.append(title, sub, actions);
  item.onclick = () => openSession(s.id);
  return item;
}

async function refreshSessions() {
  const res = await api('/api/sessions');
  state.sessions = res.sessions || [];
  renderSessions();
}
async function openSession(id) {
  const res = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const prevId = state.currentSession?.id;
  const switchedSession = prevId !== id;
  state.currentSession = res.session;
  state.resumable = res.resumable || null; // v0.8-S0 A6: dangling-turn info for the resume banner
  state.msgWindowStart = null; // v1.0-S7 (perf): each session opens windowed to its tail (recompute per open)
  try { localStorage.setItem('wcw.lastSession', id); } catch { /* ignore */ }
  // v1.9.1: 会话切换清空 steer 状态(模块级单例不按会话隔离,否则 A 的插话卡片/steeredSeen 残留到 B;
  //   切到流式会话 setStreaming(true) 不清空 -> B 看到 A 的插话 + ×按钮报错 + steeredSeen 孤儿吞事件)。对抗验证发现。
  if (switchedSession) {
    steerPendingList.length = 0; steeredSeen.length = 0; resetStickyScroll(); // EC-D 57: 切会话 -> 恢复跟随最新
    const h = $('composerHint'); if (h) { h.innerHTML = ''; h.style.display = 'none'; }
  }
  renderSessions();
  renderCurrentSession();
  if (switchedSession) scrollMessagesToBottom(); // 旧会话的阅读锚点不能泄漏到新会话
  renderResumeBanner();
  syncStreamingUi();
  mountActiveTurn(id);
}
// v0.8-S0 A6: show a lightweight banner above the composer when the opened session has a dangling
// (interrupted) turn. "继续" resends a prompt asking the model to finish; the banner then hides.
/* ---------------- v0.8-S3: task-list step-bar ---------------- */
// The step-bar shows the current task list. Summary (collapsed) reads "✓ 已完成 j/N · <in-progress text>";
// clicking the head expands the full list (pending ○ / in_progress ◐ / done ●). `todos` is an array of
// {id,text,status}; pass [] (or nothing) to hide the bar entirely.
const STEP_MARK = { done: '●', in_progress: '◐', pending: '○' };
function renderStepBar(todos) {
  const bar = $('stepBar');
  if (!bar) return;
  const items = Array.isArray(todos) ? todos : [];
  if (!items.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const done = items.filter(t => t && t.status === 'done').length;
  const current = items.find(t => t && t.status === 'in_progress') || items.find(t => t && t.status !== 'done') || items[items.length - 1];
  const sum = $('stepBarSummary');
  if (sum) {
    sum.innerHTML = '';
    sum.append(el('span', 'sb-count', `已完成 ${done}/${items.length}`));
    if (current && current.text) { sum.append(document.createTextNode(' · ')); sum.append(el('span', 'sb-cur', current.text)); }
  }
  const list = $('stepBarList');
  if (list) {
    list.innerHTML = '';
    for (const t of items) {
      if (!t) continue;
      const status = (t.status === 'done' || t.status === 'in_progress') ? t.status : 'pending';
      const li = el('li', status);
      li.append(el('span', 'sb-mark', STEP_MARK[status] || '○'), el('span', 'sb-text', t.text || ''));
      list.appendChild(li);
    }
  }
}
function toggleStepBar(force) {
  const head = $('stepBarToggle'), list = $('stepBarList');
  if (!head || !list) return;
  const open = force != null ? force : list.classList.contains('hidden');
  list.classList.toggle('hidden', !open);
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
}

// 第26波b: 任务账本进度条。mission=null 或无里程碑 → 隐藏(非账本会话零显示)。
const MISSION_MARK = { done: '●', blocked: '▲', pending: '○' };
const MISSION_MODE_KEY = { 'until-done': 'mission.autoProgress', supervised: 'mission.waitingConfirmation', off: '' };
function renderMissionBar(mission) {
  const bar = $('missionBar');
  if (!bar) return;
  const ms = mission && Array.isArray(mission.milestones) ? mission.milestones : [];
  if (!mission || !mission.goal || !ms.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const done = ms.filter(m => m && m.status === 'done').length;
  const sum = $('missionBarSummary');
  if (sum) { sum.innerHTML = ''; sum.append(el('span', 'mb-goal', mission.goal), el('span', 'mb-count', ` · ${done}/${ms.length}`)); }
  const modeEl = $('missionBarMode');
  if (modeEl) {
    const labelKey = MISSION_MODE_KEY[mission.autoMode] || '';
    const label = labelKey ? t(labelKey) : '';
    modeEl.textContent = label ? '· ' + label + (mission.autoMode === 'until-done' && mission.budget ? ` (${(mission.spent && mission.spent.autoTurns) || 0}/${mission.budget.maxAutoTurns})` : '') : '';
    modeEl.className = 'mission-bar-mode' + (mission.autoMode === 'until-done' ? ' mb-active' : mission.autoMode === 'supervised' ? ' mb-warn' : '');
  }
  const stopBtn = $('missionStopBtn');
  if (stopBtn) stopBtn.classList.toggle('hidden', mission.autoMode !== 'until-done');
  const list = $('missionBarList');
  if (list) {
    list.innerHTML = '';
    for (const m of ms) {
      if (!m) continue;
      const status = (m.status === 'done' || m.status === 'blocked') ? m.status : 'pending';
      const li = el('li', status);
      li.append(el('span', 'mb-mark', MISSION_MARK[status] || '○'), el('span', 'mb-text', m.desc || m.id));
      if (m.evidence) li.title = m.evidence;
      list.appendChild(li);
    }
  }
}
// 账本状态卡(完成/停滞/预算耗尽)—— 插入对话流,借用 plan/error 卡的视觉语言。
function missionStateCard(evt) {
  const meta = {
    complete: { cls: 'ok', icon: '✓', title: t('mission.complete.title'), body: t('mission.complete.description') },
    stuck: { cls: 'warn', icon: '⚠', title: t('mission.stuck.title'), body: evt.reason || t('mission.stuck.description') },
    budget_exhausted: { cls: 'warn', icon: '⏸', title: t('mission.budgetPaused.title'), body: evt.reason || t('mission.budgetPaused.description') },
  }[evt.state] || { cls: '', icon: '·', title: t('common.unknown'), body: '' };
  const card = el('div', 'mission-card mission-card-' + meta.cls);
  card.append(el('div', 'mission-card-head', `${meta.icon} ${meta.title}`));
  if (meta.body) card.append(el('div', 'mission-card-body', meta.body));
  return card;
}
async function stopMission() {
  const s = state.currentSession; if (!s || !s.mission) return;
  try { const r = await api('/api/mission', { method: 'POST', body: JSON.stringify({ sessionId: s.id, action: 'stop' }) }); if (r && r.ok) { s.mission = r.mission; renderMissionBar(r.mission); toast(t('mission.stop.success'), 'ok'); } }
  catch (e) { toast(t('mission.stop.failed', { reason: apiErrText(e) }), 'err'); }
}

/* ---------------- 第27波:自主性授权书 ---------------- */
// 档位色(复用权限徽章语义):read=安全 / edit=可撤 / exec=高危。exec 视觉上必须更重。
function grantTierLabel(tier) {
  return { read: t('permission.read'), edit: t('permission.edit'), exec: t('permission.execute') }[tier] || tier;
}
function grantTierOf(tool) {
  if (tool === 'powershell_run' || tool === 'script_run' || tool === 'Bash') return 'exec';
  if (tool === 'file_read' || tool === 'file_list') return 'read';
  return 'edit';
}
function fmtRemain(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60
    ? t('permission.duration.hours', { hours: Math.floor(m / 60), minutes: m % 60 })
    : t('permission.duration.minutes', { minutes: m });
}
// 渲染活动授权列表(read-only 展示 + 撤销)。grants 为 listGrantsView 形状。
function renderAutonomyBar(grants) {
  const bar = $('autonomyBar'); if (!bar) return;
  const list = Array.isArray(grants) ? grants : [];
  const ul = $('autonomyBarList');
  const count = $('autonomyBarCount');
  const revokeAll = $('autonomyRevokeAll');
  const formOpen = $('autonomyIssueForm') && !$('autonomyIssueForm').classList.contains('hidden');
  // 有活动授权、或签发表单展开时,抽屉显示。
  if (!list.length && !formOpen) { bar.classList.add('hidden'); }
  else bar.classList.remove('hidden');
  if (count) count.textContent = list.length ? '· ' + t('permission.activeCount', { count: list.length }) : '';
  if (revokeAll) revokeAll.classList.toggle('hidden', list.length < 2);
  if (!ul) return;
  ul.innerHTML = '';
  for (const g of list) {
    const tier = g.tier || grantTierOf(g.tool);
    const li = el('li', 'autonomy-grant tier-' + tier);
    const badge = el('span', 'ag-badge ag-' + tier, grantTierLabel(tier));
    const name = el('span', 'ag-tool', g.tool);
    const scope = el('span', 'ag-scope', g.scope === 'run' ? t('permission.scope.run') : t('permission.scope.session'));
    const detail = el('span', 'ag-detail', tier === 'exec' ? (g.cmdAllow || []).join(' / ') : (g.pathGlob || []).join(' , '));
    if (tier === 'exec' && g.netAllowed) detail.append(el('span', 'ag-net', ' ⚠' + t('permission.network')));
    const uses = el('span', 'ag-uses', t('permission.uses', { used: g.usedCount || 0, max: g.maxUses }));
    const ttl = el('span', 'ag-ttl', t('permission.remaining', { duration: fmtRemain(g.remainingMs) }));
    const x = el('button', 'ag-revoke', '✕'); x.title = t('permission.revoke'); x.onclick = () => revokeOneGrant(g.grantId);
    li.append(badge, name, scope, detail, uses, ttl, x);
    ul.appendChild(li);
  }
}
async function loadAutonomyGrants() {
  const s = state.currentSession; if (!s) { renderAutonomyBar([]); return; }
  try { const r = await api('/api/autonomy/grants?sessionId=' + encodeURIComponent(s.id)); renderAutonomyBar(r && r.ok ? r.grants : []); }
  catch { renderAutonomyBar([]); }
}
async function revokeOneGrant(grantId) {
  const s = state.currentSession; if (!s) return;
  try { const r = await api('/api/autonomy/revoke', { method: 'POST', body: JSON.stringify({ sessionId: s.id, grantId }) }); if (r && r.ok) { renderAutonomyBar(r.grants); toast(t('permission.grantRevoked'), 'ok'); } }
  catch (e) { toast(t('permission.revoke.failed', { reason: apiErrText(e) }), 'err'); }
}
async function revokeAllAutonomyGrants() {
  const s = state.currentSession; if (!s) return;
  if (!confirm(t('permission.revokeAll.confirm'))) return;
  try { const r = await api('/api/autonomy/revoke', { method: 'POST', body: JSON.stringify({ sessionId: s.id, all: true }) }); if (r && r.ok) { renderAutonomyBar(r.grants); toast(t('permission.revokeAll.success', { count: r.revoked }), 'ok'); } }
  catch (e) { toast(t('permission.revoke.failed', { reason: apiErrText(e) }), 'err'); }
}
// 签发表单:工具切换 → 联动显示 glob(文件族)或 cmdAllow(exec)。
function autonomyFormSync() {
  const tool = $('agTool') && $('agTool').value;
  const tier = grantTierOf(tool);
  document.querySelectorAll('.ag-file-only').forEach(e => e.classList.toggle('hidden', tier === 'exec'));
  document.querySelectorAll('.ag-exec-only').forEach(e => e.classList.toggle('hidden', tier !== 'exec'));
  const form = $('autonomyIssueForm');
  if (form) form.classList.toggle('is-exec', tier === 'exec');
}
function autonomyIssuePayload() {
  const s = state.currentSession; if (!s) return null;
  const tool = $('agTool').value;
  const tier = grantTierOf(tool);
  const splitList = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    sessionId: s.id, tool, scope: $('agScope').value,
    pathGlob: tier === 'exec' ? [] : splitList($('agGlob').value),
    cmdAllow: tier === 'exec' ? splitList($('agCmd').value) : [],
    netAllowed: tier === 'exec' && $('agNet') && $('agNet').checked,
    maxUses: Math.max(1, Number($('agMaxUses').value) || 10),
    ttlMs: Number($('agTtl').value) || 3600000,
  };
}
async function previewGrant() {
  const p = autonomyIssuePayload(); if (!p) return;
  const box = $('agDryRun'); if (box) box.textContent = t('permission.preview.loading');
  try {
    const r = await api('/api/autonomy/grant', { method: 'POST', body: JSON.stringify({ ...p, preview: true }) });
    if (r && r.ok) {
      const bits = [];
      if (grantTierOf(p.tool) !== 'exec') bits.push(t('permission.preview.files', { count: r.dryRun ? r.dryRun.count : 0, truncated: r.dryRun && r.dryRun.truncated ? t('permission.preview.truncated') : '' }));
      else bits.push(t('permission.preview.commands', { commands: (r.grant.cmdAllow || []).join(' / ') }));
      if (r.dropped && r.dropped.length) bits.push(t('permission.preview.dropped', { count: r.dropped.length, reasons: r.dropped.map(d => d.reason).join(';') }));
      if (box) box.textContent = bits.join(';');
    } else if (box) box.textContent = t('permission.preview.failed', { reason: r && r.error || t('common.unknown') });
  } catch (e) { if (box) box.textContent = t('permission.preview.failed', { reason: apiErrText(e) }); }
}
async function submitGrant(ev) {
  if (ev) ev.preventDefault();
  const p = autonomyIssuePayload(); if (!p) return;
  const tier = grantTierOf(p.tool);
  if (tier === 'exec') {
    if (!p.cmdAllow.length) { toast(t('permission.execution.required'), 'err'); return; }
    if (!confirm(t('permission.executionWarning', { tool: p.tool, commands: p.cmdAllow.join(' / '), network: p.netAllowed ? t('common.yes') : t('common.no'), uses: p.maxUses }))) return;
  }
  try {
    const r = await api('/api/autonomy/grant', { method: 'POST', body: JSON.stringify(p) });
    if (r && r.ok) {
      toast(r.dropped && r.dropped.length ? t('permission.grantIssuedWithDrops', { count: r.dropped.length }) : t('permission.grantIssued'), 'ok');
      $('autonomyIssueForm').classList.add('hidden');
      await loadAutonomyGrants();
    } else { toast(t('permission.grant.failed', { reason: r && r.error || t('common.unknown') }), 'err'); }
  } catch (e) { toast(t('permission.grant.failed', { reason: apiErrText(e) }), 'err'); }
}

/* ---------------- v0.8-S3: 「本轮变更」turn-summary card ---------------- */
// Renders message.turnSummary (static) or a live turn_summary event: a low-key card listing files changed
// (path + op) and a command count. When nothing changed AND no commands ran, shows the reassurance line
// 「本次未改动任何文件」(C5/C6 seed). Returns a DOM node.
function turnSummaryCard(summary) {
  const s = summary || {};
  const files = Array.isArray(s.filesChanged) ? s.filesChanged : [];
  const commands = Number(s.commands) || 0;
  const turnSeq = Number(s.turnSeq);
  const hasRevertible = files.some(f => f && f.revertible);
  const card = el('div', 'turn-summary');
  const head = el('div', 'turn-summary-head');
  head.append(el('span', '', t('changes.title')));
  // v0.8-S4b: 「撤销整轮」— rolls back every journaled file of this turn (default entrySeq). Only shown when
  // there is at least one revertible file AND we know the turnSeq (static or live event both carry it).
  if (hasRevertible && Number.isFinite(turnSeq)) {
    const undoAll = el('button', 'ts-undo-all', t('changes.revertTurn'));
    undoAll.onclick = () => { if (!confirm(t('changes.revertTurn.confirm'))) return; rollbackTurn(turnSeq, undefined, undoAll, t('changes.turnLabel')); };
    head.append(undoAll);
  }
  card.append(head);
  const body = el('div', 'turn-summary-body');
  if (!files.length && commands === 0) {
    body.append(el('div', 'turn-summary-empty', t('changes.empty')));
  } else {
    for (const f of files) {
      if (!f) continue;
      const row = el('div', 'turn-summary-file');
      const op = (f.op === 'create' || f.op === 'modify' || f.op === 'delete') ? f.op : 'unknown';
      const opLabel = op === 'create' ? t('changes.create') : op === 'modify' ? t('changes.modify') : op === 'delete' ? t('changes.delete') : t('common.unknown');
      row.append(el('span', `ts-op ${op}`, opLabel), el('span', 'ts-path', f.path || ''));
      // v0.8-S4b: per-file 「撤销」— rolls back a single entry (turnSeq + entrySeq). Only for revertible
      // files that carry an entrySeq (journal-driven). Non-revertible files show nothing extra.
      if (f.revertible && Number.isFinite(turnSeq) && Number.isFinite(Number(f.entrySeq))) {
        const undo = el('button', 'ts-undo', t('changes.revert'));
        undo.onclick = () => { if (!confirm(t('changes.revert.confirm', { path: f.path || '' }))) return; rollbackTurn(turnSeq, Number(f.entrySeq), undo, f.path || ''); };
        row.append(undo);
      }
      body.append(row);
    }
    const bits = [];
    if (files.length) bits.push(t('changes.fileCount', { count: files.length }));
    if (commands) bits.push(t('changes.commandCount', { count: commands }));
    if (bits.length) body.append(el('div', 'turn-summary-cmds', bits.join(' · ')));
    // commands can't be auto-undone — say so, once, when any command ran (C6/B3 discipline).
    if (commands > 0) body.append(el('div', 'turn-summary-warn', `⚠ ${t('changes.commandNotRevertible')}`));
  }
  card.append(body);
  return card;
}
// v1.0.2 (G2): 消息尾部生成文件 chip 行。数据源 summary.artifacts([{path, kind}])。每个 chip:kind 图标 +
// 文件名 + 两个小按钮(打开 / 📂 定位),走 POST /api/file/reveal。无 artifacts → 返回 null(调用处不追加)。
// 文件名一律 textContent(el 内部)——XSS 红线:artifacts 来自模型/文件系统。
function turnArtifactChips(summary) {
  const arts = summary && Array.isArray(summary.artifacts) ? summary.artifacts.filter(a => a && a.path) : [];
  if (!arts.length) return null;
  const wrap = el('div', 'turn-artifacts');
  // de-dup by path, keep first (newest-in-turn insertion order preserved).
  const seen = new Set();
  for (const a of arts) {
    const p = String(a.path);
    if (seen.has(p)) continue; seen.add(p);
    const chip = el('span', 'artifact-chip');
    chip.append(el('span', 'artifact-chip-icon', ARTIFACT_KIND_ICON[a.kind] || ARTIFACT_KIND_ICON.other));
    const nameEl = el('span', 'artifact-chip-name', fileBasename(p)); nameEl.title = p; // XSS-safe textContent
    chip.append(nameEl);
    const openBtn = el('button', 'artifact-chip-btn', t('file.open')); openBtn.type = 'button'; openBtn.title = t('file.open');
    openBtn.onclick = () => revealArtifact(p, 'open');
    const locBtn = el('button', 'artifact-chip-btn', `📂 ${t('file.reveal')}`); locBtn.type = 'button'; locBtn.title = t('file.reveal');
    locBtn.onclick = () => revealArtifact(p, 'select');
    chip.append(openBtn, locBtn);
    wrap.append(chip);
  }
  return wrap;
}
// v1.0.2 (G2): POST /api/file/reveal {sessionId, path, mode}. 成功时:若响应带 degradedTo(可执行/脚本文件
// 「打开」被降级为「定位」),toast 其 note;否则静默(资源管理器已弹出)。失败(400/403/404/非 win)toast 人话。
async function revealArtifact(fullPath, mode) {
  const sid = state.currentSession?.id || '';
  try {
    const r = await api('/api/file/reveal', { method: 'POST', body: JSON.stringify({ sessionId: sid, path: fullPath, mode }) });
    if (!r || !r.ok) { toast((r && r.error) || t('file.open.unavailable'), 'err'); return; }
    if (r.degradedTo && r.note) toast(r.note, '');
  } catch (e) {
    toast(t('file.open.failed', { reason: apiErrText(e) }), 'err');
  }
}
/* ---------------- v0.9-S1 (C6): error human-card ---------------- */
// Known machine classes render through the local catalog. The server's legacy zh/next table is retained only
// for unknown classes from an older/newer server, so it is no longer the UI's sole error-language contract.
const ERROR_CLASS_I18N = {
  provider_misconfigured: { title: 'error.providerMisconfigured', next: 'error.providerMisconfigured.next' },
  network_down: { title: 'error.networkDown', next: 'error.networkDown.next' },
  permission_denied: { title: 'error.permissionDenied', next: 'error.permissionDenied.next' },
  tool_error: { title: 'error.toolFailed' },
  idle_timeout: { title: 'error.idleTimeout' },
  tool_loop: { title: 'error.toolLoop' },
};
const ERROR_CLASSES_LEGACY = {
  provider_misconfigured: { zh: () => t('error.providerMisconfigured'), next: () => t('error.providerMisconfigured.next') },
  network_down: { zh: () => t('error.networkDown'), next: () => t('error.networkDown.next') },
  permission_denied: { zh: () => t('error.permissionDenied'), next: () => t('error.permissionDenied.next') },
  tool_error: { zh: () => t('error.toolFailed'), next: () => t('error.toolFailed.next') },
  idle_timeout: { zh: () => t('error.idleTimeout'), next: () => t('error.idleTimeout.next') },
  tool_loop: { zh: () => t('error.toolLoop'), next: () => t('error.toolLoop.next') },
};
function errorClassInfo(cls) {
  const local = ERROR_CLASS_I18N[cls];
  if (local) return { title: t(local.title), next: local.next ? t(local.next) : '' };
  const table = (state.status && state.status.errorClasses) || ERROR_CLASSES_LEGACY;
  const legacy = table[cls] || ERROR_CLASSES_LEGACY[cls];
  return legacy ? { title: (typeof legacy.zh === 'function' ? legacy.zh() : legacy.zh), next: (typeof legacy.next === 'function' ? legacy.next() : legacy.next) } : null;
}
// Map an errorClass → a concrete 「下一步」 action (button). Not every class gets a button (tool_loop is
// text-only per spec — there's nothing single-click actionable). Returns {label, run} or null.
function errorClassAction(cls) {
  switch (cls) {
    case 'provider_misconfigured':
      return { label: t('provider.configureApiKey'), run: () => { openModal('settingsModal'); switchSettingsTab('providers'); } };
    case 'network_down':
      return { label: t('capability.view'), run: () => { if (typeof openCapPopover === 'function') openCapPopover(); } };
    case 'permission_denied':
      // v1.0-S2 (IA): 权限收敛为顶栏「安全」chip + 安全弹层；此处打开该弹层并给出人话提示。
      return { label: t('permission.title'), run: () => { if (typeof openPermPopover === 'function') openPermPopover(); toast(t('error.permissionDenied.next'), 'ok'); } };
    default:
      return null; // tool_error / idle_timeout / tool_loop → text-only guidance
  }
}
// Render the human error card. `noFilesChanged` appends the reassurance line 「本次未改动任何文件」 (C6) when
// this turn's turn_summary was empty (a failed turn that touched nothing shouldn't leave the user unsure).
function errorCard(cls, rawError, noFilesChanged) {
  const info = errorClassInfo(cls);
  const card = el('div', 'error-card');
  const head = el('div', 'error-card-head');
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', (info && info.title) || t('error.generic.title')));
  card.append(head);
  const body = el('div', 'error-card-body');
  if (info && info.next) body.append(el('div', 'error-card-next', info.next));
  else body.append(el('div', 'error-card-next', rawError ? String(rawError) : t('error.generic.description')));
  const act = errorClassAction(cls);
  if (act) {
    const btn = el('button', 'error-card-btn', act.label);
    btn.onclick = () => { try { act.run(); } catch { /* ignore */ } };
    body.append(btn);
  }
  if (noFilesChanged) body.append(el('div', 'error-card-noop', t('changes.empty')));
  card.append(body);
  return card;
}
// v1.0.2 (F6c): CLI 缺失的友好引导卡。后端契约:聊天错误事件带 code:'cli-missing'(另一 agent 正在实现)。
// 向后兼容:没有 code 字段时走原始错误渲染,不依赖后端已上线 —— 只有 code==='cli-missing' 才走这张卡。
// 主张「推荐直接配置 API 引擎」+ 按钮直达设置 Providers 页签;次链接给「配置 Claude CLI 路径」。
function cliMissingCard() {
  const card = el('div', 'error-card cli-missing-card');
  const head = el('div', 'error-card-head');
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', t('error.cliMissing.title')));
  card.append(head);
  const body = el('div', 'error-card-body');
  body.append(el('div', 'error-card-next', t('error.cliMissing.description')));
  const btn = el('button', 'error-card-btn', t('error.cliMissing.configureApi'));
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  body.append(btn);
  const alt = el('button', 'error-card-alt', t('error.cliMissing.configureCli'));
  alt.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
  body.append(alt);
  card.append(body);
  return card;
}

// v0.8-S4b: roll back a turn (entrySeq omitted) or a single file (entrySeq given). On success the button
// becomes 「已撤销」+ disabled; on failure a toast surfaces the error. Uses api() (carries the UI token).
async function rollbackTurn(turnSeq, entrySeq, btn, label) {
  const sid = state.currentSession?.id;
  if (!sid) { toast(t('error.generic.description'), 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = t('changes.revert'); }
  try {
    const payload = { sessionId: sid, turnSeq };
    if (entrySeq !== undefined) payload.entrySeq = entrySeq;
    const r = await api('/api/checkpoints/rollback', { method: 'POST', body: JSON.stringify(payload) });
    if (!r || !r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? t('changes.revertTurn') : t('changes.revert'); }
      toast(t('changes.revert.failed', { reason: (r && r.error) || (r && r.failed && r.failed.length ? r.failed[0].reason : t('common.unknown')) }), 'err');
      return;
    }
    if (btn) { btn.textContent = t('changes.revert.done'); btn.classList.add('done'); btn.disabled = true; }
    const n = (r.reverted || []).length;
    toast(t('changes.reverted', { label: `${label}${n ? ` (${t('changes.fileCount', { count: n })})` : ''}` }), 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? t('changes.revertTurn') : t('changes.revert'); }
    toast(t('changes.revert.failed', { reason: apiErrText(e) }), 'err');
  }
}

function renderResumeBanner() {
  const box = $('resumeBanner');
  if (!box) return;
  box.innerHTML = '';
  const info = state.resumable;
  if (!info || !info.dangling) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const label = el('span', 'resume-banner-text', t('chat.resume.title'));
  const btn = el('button', 'resume-banner-btn', t('chat.resume.action'));
  btn.onclick = () => {
    state.resumable = null;
    box.classList.add('hidden');
    box.innerHTML = '';
    sendPrompt(t('chat.resume.prompt'));
  };
  box.append(label, btn);
}

// 50-fix:未命名标题的本地化占位显示(后端占位 'New session' / 历史中文占位 '新会话' 均视为未命名)。
function isUntitledTitle(tt) { const v = String(tt || '').trim(); return !v || v === 'New session' || v === t('chat.newSession'); }
function sessionDisplayTitle(s) { return isUntitledTitle(s && s.title) ? t('session.new') : String(s.title).trim(); }
async function newSession(options = {}) {
  const cwd = options.cwd != null ? String(options.cwd) : (state.config.defaultWorkspace || '');
  // 50-fix(标题不生成):不再把本地化占位名(新会话/New chat)当标题传给后端 —— 后端回合结束的
  // 自动命名以 'New session' 占位判定,中文占位名永不匹配导致所有会话标题卡死。传空串,
  // 后端默认 'New session' → 首轮结束自动命名生效;展示侧经 sessionDisplayTitle 本地化占位。
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: '', cwd }) });
  state.currentSession = res.session;
  state.resumable = null; // fresh session never dangles
  try { localStorage.setItem('wcw.lastSession', res.session.id); } catch { /* ignore */ }
  await refreshSessions();
  renderCurrentSession();
  renderResumeBanner();
  syncStreamingUi();
  if (options.focus !== false) $('promptInput').focus();
  return res.session;
}
async function patchSession(id, patch) {
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-http-method': 'PATCH' }, body: JSON.stringify(patch) });
  if (state.currentSession?.id === id) Object.assign(state.currentSession, patch);
  await refreshSessions();
  renderCurrentSession();
}
async function removeSession(id) {
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-http-method': 'DELETE' } });
  if (state.currentSession?.id === id) state.currentSession = null;
  await refreshSessions();
  renderCurrentSession();
}

function openBulkCleanupModal() {
  const currentId = state.currentSession?.id || '';
  // The server repeats these guards authoritatively. Keeping the preview aligned makes the destructive
  // action legible before the user confirms it.
  const candidates = state.sessions.filter(s => s && !s.pinned && s.id !== currentId && !activeTurns.has(s.id));
  if (!candidates.length) { toast(t('session.bulkCleanup.empty'), ''); return; }

  const count = candidates.length;
  const body = el('div');
  body.append(el('p', '', t('session.bulkCleanup.description', { count })));
  const note = el('p', 'muted', t('session.bulkCleanup.note'));
  body.append(note);
  const purgeLabel = el('label', 'check');
  const purgeBox = document.createElement('input');
  purgeBox.type = 'checkbox'; purgeBox.checked = true;
  purgeLabel.append(purgeBox, document.createTextNode(' ' + t('session.bulkCleanup.purgeAssociated')));
  body.append(purgeLabel);
  body.append(el('p', 'muted', t('session.bulkCleanup.purgeHint')));

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const go = el('button', 'danger', t('session.bulkCleanup.action', { count }));
  foot.append(cancel, go);
  const modal = buildModal(t('session.bulkCleanup.title'), body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = async () => {
    go.disabled = true; go.textContent = t('common.loading');
    try {
      const r = await api('/api/sessions/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ preserveSessionId: currentId, purgeAssociated: purgeBox.checked }),
      });
      if (!r || !r.ok) throw new Error((r && r.error) || 'unknown error');
      modal.close();
      await refreshSessions();
      toast(t('session.bulkCleanup.success', { count: r.deletedCount || 0 }), 'ok');
    } catch (e) {
      go.disabled = false; go.textContent = t('session.bulkCleanup.action', { count });
      toast(t('session.bulkCleanup.failed', { reason: apiErrText(e) }), 'err');
    }
  };
}

/* ---------------- message rendering ---------------- */
function renderCurrentSession() {
  const session = state.currentSession;
  state.shownUsage = null;
  $('sessionTitle').textContent = isUntitledTitle(session?.title) ? t('navigation.workbench') : session.title.trim(); // v0.8-S8 品牌落地(原「本地 Claude 工作台」);50-fix 未命名回落
  $('sessionMeta').textContent = session ? (session.cwd || '') : '';
  renderWorkspacePicker(); // v0.9-S3 (C3): keep the top-bar picker in sync with this session's cwd
  updateSkillBadge(); // v1 技能体系: 会话切换时刷新 composer 技能徽标(已启用技能数)
  renderStepBar(session && session.todos); // v0.8-S3: show the task-list bar if this session has todos
  renderMissionBar(session && session.mission); // 第26波b: 会话切换时刷新账本进度条(无账本→隐藏)
  loadAutonomyGrants(); // 第27波: 会话切换时拉取活动授权书(无授权→隐藏抽屉)
  const box = $('messages');
  const anchor = captureScrollAnchor(box);
  const previousLive = box.getAttribute('aria-live') || 'polite';
  box.setAttribute('aria-live', 'off'); // static reconciliation must not make a screen reader replay history
  box.setAttribute('aria-busy', 'true');
  const settleLog = () => {
    box.setAttribute('aria-busy', 'false');
    queueMicrotask(() => box.setAttribute('aria-live', previousLive === 'off' ? 'polite' : previousLive));
  };
  const liveForSession = session ? activeTurns.get(session.id) : null;
  if (!session || (!session.messages?.length && !liveForSession)) {
    box.replaceChildren(buildEmptyState());
    settleLog();
    renderContextMeter(null);
    return;
  }
  // v1.0-S7 / 第77波(perf): render only a count/weight bounded tail so opening a long or payload-heavy
  // conversation does not build an unbounded DOM. `start` = index of the first message we render.
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  const start = windowStartFor(msgs);
  // When windowed (start > 0), prepend a「加载更早的 N 条」button that reveals MSG_WINDOW_STEP more per click
  // (repeatable to full). It sits above the first rendered message so earlier turns become reachable — this
  // is what keeps rewind/checkpoint targets on off-screen messages recoverable (click up until they render).
  const existing = new Map(Array.from(box.querySelectorAll('[data-message-key]')).map(row => [row.dataset.messageKey, row]));
  const fragment = document.createDocumentFragment();
  if (start > 0) fragment.appendChild(buildLoadEarlierButton(start));
  // EC-D 56/56b: 插话已作为 segment 内嵌在助手回合 narrative 内时,跳过其独立 user 行防重复。
  //   ① 活动 live turn(已内嵌 live;turn 结束 activeTurns.delete 后 liveForSession 空 -> 此条失效);
  //   ② 助手回合 segments 已含 steer 段(刷新后静态内嵌,56b)-> 跳过独立行。
  //   旧会话(无 steer segment)不命中 ② -> 仍按独立行渲染(向后兼容)。steered 行恒在助手回合之前(push 顺序),
  //   故 steered 行在窗口内(i>=start)时其助手回合必也在窗口内(j>i>=start),跳过不会丢内容。
  const visibleEntries = visibleSessionMessageEntries(msgs, start, {
    activeTurnSeq: session.turnSeq,
    hasLiveTurn: Boolean(liveForSession),
  });
  for (const { message: m, index: i } of visibleEntries) {
    const key = messageDomKey(m, i, session.id);
    const signature = messageRenderSignature(m, getLocale());
    let row = existing.get(key);
    if (!row || row.dataset.renderSignature !== signature) row = renderStaticMessage(m, key, signature);
    fragment.appendChild(row);
  }
  const optimisticPersisted = liveForSession && msgs.some(message => message && message.role === 'user'
    && !message.steered && String(message.content || '') === String(liveForSession.message || ''));
  if (liveForSession?.optimisticUserRow && !optimisticPersisted) fragment.appendChild(liveForSession.optimisticUserRow);
  // Locale/config refreshes may legitimately call this while the current turn is streaming. Keep its live
  // keyed shell attached instead of reproducing the old "innerHTML clears the answer in progress" failure.
  const activeRow = activeTurns.get(session.id)?.live?.narrative?.closest('.message');
  if (activeRow && activeRow.isConnected) fragment.appendChild(activeRow);
  box.replaceChildren(fragment);
  settleLog();
  restoreScrollAnchor(box, anchor || { atBottom: true });
  renderContextMeter(latestUsage(session));
}
// v1.0-S7 (perf): compute the first-rendered-message index for the current window. Returns 0 (render all)
// for a small session or once the user has expanded to the top. state.msgWindowStart is the persisted
// expansion cursor: null means "not yet windowed" → default to the tail; a number is an explicit cursor set
// by「加载更早」(clamped so it can never exceed the tail default or go below 0).
function windowStartFor(msgs) {
  const n = Array.isArray(msgs) ? msgs.length : 0;
  const countTailStart = n <= MSG_WINDOW_THRESHOLD ? 0 : Math.max(0, n - MSG_WINDOW_TAIL);
  const weightedTailStart = weightedMessageTailStart(msgs, { maxMessages: MSG_WINDOW_TAIL });
  const tailStart = Math.max(countTailStart, weightedTailStart);
  if (tailStart === 0) return 0; // small/light session → full render, zero change
  if (state.msgWindowStart == null) return tailStart; // fresh open → show the tail window
  return Math.max(0, Math.min(state.msgWindowStart, tailStart));
}
// v1.0-S7 (perf): the「加载更早」control. Shows how many earlier messages are hidden; clicking reveals
// MSG_WINDOW_STEP more (or all remaining, whichever is smaller) by moving the window cursor up and
// re-rendering. Preserves the reading position by anchoring scroll to the previously-first row.
function buildLoadEarlierButton(start) {
  const wrap = el('div', 'load-earlier-wrap');
  const step = Math.min(MSG_WINDOW_STEP, start);
  const btn = el('button', 'load-earlier', t('chat.loadEarlier', { count: step, remaining: start }));
  btn.type = 'button';
  // v1.0 收官(对抗复核·视图):流式回合期间禁止窗口重绘。renderCurrentSession 会 innerHTML='' 抹掉在途的
  // 流式 row/live.bubble,导致「回答正在生成、点侧栏它就凭空消失」的信任观感事故(数据本身无损,已磁盘验证)。
  // 与 rewind/compact 同款守卫:流式中提示稍候,不重绘。
  btn.onclick = () => {
    if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; }
    state.msgWindowStart = Math.max(0, start - MSG_WINDOW_STEP);
    renderCurrentSession();
    // Anchor to the top so the newly-revealed batch reads from its start (don't jump to bottom).
    const box = $('messages');
    if (box) box.scrollTop = 0;
  };
  wrap.appendChild(btn);
  // 「展开全部」— one-click full expand (also the reachable path exercising expandMessageWindowFully, the
  // designated fallback for any future jump-to-message/search flow that must reach an off-screen message).
  const all = el('button', 'load-earlier load-all', t('chat.expandAll'));
  all.type = 'button';
  all.onclick = () => { if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; } expandMessageWindowFully(); const box = $('messages'); if (box) box.scrollTop = 0; };
  wrap.appendChild(all);
  return wrap;
}
// v1.0-S7 (perf): fully expand the window (render every message). Used as the fallback for jump-to-message /
// search flows so a target on an off-screen message is guaranteed reachable. Idempotent; re-renders once.
function expandMessageWindowFully() {
  state.msgWindowStart = 0;
  renderCurrentSession();
}
// v1.0-S3 (A): 首跑引导触发条件 —— 会话列表为空 && config.recentWorkspaces 为空数组。纯派生状态，无持久化
// 标记；一旦选了文件夹（recentWorkspaces 非空）或建了会话，条件不再满足，自动回到常规空状态。
function isFirstRun() {
  const noSessions = !(state.sessions && state.sessions.length);
  const rw = state.config && state.config.recentWorkspaces;
  const noWorkspaces = !(Array.isArray(rw) && rw.length);
  return noSessions && noWorkspaces;
}
// v1.0-S3 (A3): 从 state 派生「AI 引擎是否就绪」。就绪来源二选一：Claude CLI 被检出/已配置路径，或已配置任一 provider。
// 返回 { ready, name } —— name 是就绪引擎的人话名（供绿点行显示）。做成小函数，不嵌进模板。
function engineReadiness() {
  const claudeReady = !!((state.config && state.config.claudePath) || (state.status && state.status.detectedClaudePath));
  const providers = (state.config && state.config.providers) || [];
  const providerReady = providers.length > 0;
  if (isProviderMode()) {
    const p = activeProviderObj();
    if (p) return { ready: true, name: p.label || p.id };
  }
  if (claudeReady) return { ready: true, name: 'Claude CLI' };
  if (providerReady) { const p = providers[0]; return { ready: true, name: (p && (p.label || p.id)) || t('onboarding.engine.providerFallback') }; }
  return { ready: false, name: '' };
}
// v1.0-S3 (A2): 大拖放引导区 —— 点击走既有 pickWorkspace()；拖拽走既有的 shell 级 drop 处理（v0.9-S3 已实现，
// 这里只把心智可视化，不重做 drop 逻辑）。hover/dragover 用 --accent 描边 + --accent-soft 底（同 dropHint 心智）。
function buildOnboardDropZone() {
  const zone = el('button', 'onboard-drop');
  zone.type = 'button';
  zone.appendChild(el('div', 'onboard-drop-icon', '📁'));
  zone.appendChild(el('div', 'onboard-drop-title', t('onboarding.drop.title')));
  zone.appendChild(el('div', 'onboard-drop-sub', t('onboarding.drop.description')));
  // v1.0.2 (G6): 引导区「点击选择」保持一键直开原生选择器(不弹粘贴 popover —— 引导区语义即「点击选择」)。
  zone.onclick = () => pickWorkspaceNative();
  // dragover 视觉反馈：加 .dragging 类（CSS 用 --accent 描边 + --accent-soft 底）。真正的落盘解析仍由 shell
  // 级 drop 监听器处理——这里 preventDefault 让浏览器允许 drop 冒泡到 shell。
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', () => zone.classList.remove('dragging'));
  return zone;
}
// v1.0-S3 (A3): 引擎状态一眼判断卡。就绪 → 绿点 + 「AI 引擎已就绪：<引擎名>」；不可用 → 暖提示卡 + 「去设置」
// 按钮（打开设置 modal 的 Providers 页签）。
function buildOnboardEngine() {
  const r = engineReadiness();
  if (r.ready) {
    const line = el('div', 'onboard-engine ready');
    line.appendChild(el('span', 'onboard-eng-dot'));
    line.appendChild(el('span', '', t('onboarding.engine.readyWithName', { name: r.name })));
    return line;
  }
  // v1.0.2 (F6a):无可用引擎时 —— API 引擎优先。主卡片推荐配 API Key(DeepSeek 注册即得免费额度),
  // 「去配置」直达设置 Providers 页签;Claude CLI 收进折叠的次要入口(details),不再与 API 并列抢注意力。
  const card = el('div', 'onboard-engine warn');
  card.appendChild(el('div', 'onboard-eng-warn-title', t('onboarding.engine.configureKey.title')));
  card.appendChild(el('div', 'onboard-eng-sub', t('onboarding.engine.configureKey.description')));
  const btn = el('button', 'primary', t('onboarding.engine.configureKey.action'));
  btn.type = 'button';
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  card.appendChild(btn);
  // 次要入口:我有 Claude CLI（折叠）。展开后给一个直达 Claude CLI 设置页签的链接式按钮。
  const adv = document.createElement('details'); adv.className = 'onboard-eng-adv';
  const sum = document.createElement('summary'); sum.textContent = t('onboarding.engine.advancedClaude');
  adv.appendChild(sum);
  const advBtn = el('button', 'ghost onboard-eng-adv-btn', t('onboarding.engine.configureClaude'));
  advBtn.type = 'button';
  advBtn.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
  adv.appendChild(advBtn);
  card.appendChild(adv);
  return card;
}
// v1.0-S1 收官补:如意标(SVG)——JS 重建空状态时与 index.html 静态版完全同参(路径/填色/viewBox),
// 不再回退到旧 Claude 字母 "C"。theme.e2e.js 守着此模式不得回潮。
function buildRuyiLogo() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('width', '48'); svg.setAttribute('height', '48');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', t('brand.name'));
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('transform', 'rotate(42 60 60)');
  const head = document.createElementNS(NS, 'path');
  head.setAttribute('fill', 'var(--brand-qh)');
  head.setAttribute('d', 'M60 62 C46 55 30 44 30 32 A13 13 0 0 1 53 24 A7.5 7.5 0 1 1 67 24 A13 13 0 0 1 90 32 C90 44 74 55 60 62 Z');
  const stem = document.createElementNS(NS, 'path');
  stem.setAttribute('fill', 'none'); stem.setAttribute('stroke', 'var(--brand-qh)');
  stem.setAttribute('stroke-width', '11'); stem.setAttribute('stroke-linecap', 'round');
  stem.setAttribute('d', 'M60 57 C53.5 73.7 66.5 90.3 57.7 107');
  const star = document.createElementNS(NS, 'circle');
  star.setAttribute('fill', 'var(--brand-au)'); star.setAttribute('cx', '27'); star.setAttribute('cy', '21'); star.setAttribute('r', '7.5');
  g.append(head, stem); svg.append(g, star);
  const box = el('div', 'empty-logo'); box.setAttribute('aria-hidden', 'true'); box.appendChild(svg);
  return box;
}
function buildEmptyState() {
  // v1.0-S3 (A): 首跑引导变体 —— 会话空 && 无最近工作区时渲染，否则走常规空状态。
  if (isFirstRun()) return buildFirstRunState();
  const wrap = el('div', 'empty-state');
  wrap.appendChild(buildRuyiLogo());
  wrap.appendChild(el('h2', '', t('emptyState.title')));
  // Engine line: "当前引擎：{engineLabel} · {model}" with a colored engine dot.
  const meta = currentEngineMeta();
  const vis = engineVisual(meta);
  const engLine = el('div', 'empty-engine');
  const dot = el('span', 'empty-eng-dot'); dot.style.background = vis.colorVar;
  engLine.append(dot, el('span', '', t('emptyState.currentEngine', { engine: engineLabel(), model: currentModelId() || t('provider.defaultModel') })));
  wrap.appendChild(engLine);
  wrap.appendChild(el('p', '', t('emptyState.description')));
  // Conditional CTA (at most one). Claude + CLI not detected -> set path; provider + no key -> fill key.
  const cta = buildEmptyCTA();
  if (cta) wrap.appendChild(cta);
  // v0.9-S2 (C2): playbook card grid. In simple mode the cards are the primary entry (starters区 hidden by
  // [data-ui-mode]); pro mode keeps both. Unavailable cards render greyed + a one-line reason (never hidden).
  const pbSection = buildPlaybookSection();
  if (pbSection) wrap.appendChild(pbSection);
  return wrap;
}
// v1.0-S3 (A): 首跑引导变体。自上而下：如意标（buildRuyiLogo，与 index.html 静态版同参）；大拖放引导区；
// 引擎状态一眼判断；任务卡（既有 playbook 首页渲染，保留在引导变体下方，不动其逻辑）。DOM 全走
// createElement/textContent（禁 innerHTML）。
function buildFirstRunState() {
  const wrap = el('div', 'empty-state onboard');
  wrap.appendChild(buildRuyiLogo());
  wrap.appendChild(el('h2', '', t('onboarding.title')));
  wrap.appendChild(el('p', '', t('onboarding.description')));
  wrap.appendChild(buildOnboardDropZone());
  wrap.appendChild(buildOnboardEngine());
  // 任务卡（既有 playbook 首页渲染，不动其逻辑）。
  const pbSection = buildPlaybookSection();
  if (pbSection) wrap.appendChild(pbSection);
  return wrap;
}

/* ---------------- v0.9-S2: Playbooks (§7.8 / §4 C2) ---------------- */
// Fetch the playbook list (built-in ∪ user, each with availability) into state, then re-render the empty
// state if it's currently showing. Best-effort — a failure leaves the cards absent, never throws to boot.
async function refreshPlaybooks() {
  try { const r = await api('/api/playbooks'); state.playbooks = (r && r.playbooks) || []; }
  catch { state.playbooks = []; }
  // If the empty state is on screen, refresh it so the freshly-loaded cards appear.
  const box = $('messages');
  if (box && box.querySelector('.empty-state') && (!state.currentSession || !(state.currentSession.messages || []).length)) {
    box.innerHTML = ''; box.appendChild(buildEmptyState());
  }
}
// Build the playbook card grid section, filtered by the current uiMode (a card's uiMode:'simple'|'pro'|'both'
// gates where it shows). Returns null when there are no cards to show. XSS discipline: all playbook text goes
// through el()/textContent — never innerHTML.
function buildPlaybookSection() {
  const mode = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'simple' : 'pro';
  const cards = (state.playbooks || []).filter(pb => pb && (pb.uiMode === 'both' || pb.uiMode === mode || !pb.uiMode));
  if (!cards.length) return null;
  const sec = el('div', 'pb-section');
  sec.appendChild(el('div', 'pb-section-title', t('skills.group.playbooks')));
  const grid = el('div', 'pb-grid');
  for (const pb of cards) grid.appendChild(buildPlaybookCard(pb));
  sec.appendChild(grid);
  return sec;
}
// A single playbook card. Available → clickable (opens the input form modal). Unavailable → greyed +
// a one-line reason (C2: 不隐藏,给一行原因), not clickable.
function buildPlaybookCard(pb) {
  const available = pb.available !== false;
  const card = el(available ? 'button' : 'div', 'pb-card' + (available ? '' : ' unavailable'));
  const head = el('div', 'pb-card-head');
  head.append(el('span', 'pb-card-icon', pb.icon || '📄'), el('span', 'pb-card-title', playbookDisplayName(pb)));
  card.appendChild(head);
  const description = playbookDisplayDescription(pb);
  if (description) card.appendChild(el('div', 'pb-card-desc', description));
  if (!available) card.appendChild(el('div', 'pb-card-reason', playbookDisplayUnavailableReason(pb) || t('skills.unavailable')));
  if (available) card.onclick = () => openPlaybookModal(pb);
  return card;
}
// Open the input form modal for a playbook. Renders one field per input (folder type = textbox + a hint that
// visual选择 arrives in v0.9-S3). On confirm, assemble the prompt by substituting {key} placeholders and
// call sendPrompt. XSS-safe: labels/hints via el()/textContent.
function openPlaybookModal(pb) {
  const body = el('div', 'pb-form');
  const description = playbookDisplayDescription(pb);
  if (description) body.appendChild(el('p', 'pb-form-desc', description));
  const fields = new Map(); // key -> input element
  for (const inp of (pb.inputs || [])) {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', playbookInputLabel(pb, inp)));
    const ta = el('textarea', 'pb-field-input');
    ta.rows = (inp.type === 'text') ? 3 : 1;
    ta.placeholder = inp.type === 'folder' ? t('skills.playbook.folderPlaceholder') : (inp.type === 'file' ? t('skills.playbook.filePlaceholder') : '');
    // v0.9-S3 (C3): folder inputs get a 📁 button that pops the native picker and fills the field.
    if (inp.type === 'folder') {
      const row = el('div', 'pb-field-folder');
      const pick = el('button', 'file-label pb-pick', t('skills.playbook.pickFolder'));
      pick.onclick = async () => {
        let r;
        try { r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
        catch (e) { toast(t('skills.playbook.pickerError', { reason: apiErrText(e) }), 'err'); return; }
        if (r && r.ok && r.path) { ta.value = r.path; }
        else if (r && !r.ok) toast(t('skills.playbook.pickerUnavailable', { reason: r.error || t('common.unknown') }), 'err');
      };
      row.append(ta, pick);
      field.appendChild(row);
    } else {
      field.appendChild(ta);
    }
    fields.set(inp.key, ta);
    body.appendChild(field);
  }
  if (pb.promptTemplate) {
    const guide = el('details', 'pb-guide');
    guide.appendChild(el('summary', '', t('skills.playbook.viewGuide')));
    guide.appendChild(el('pre', 'pb-guide-text', pb.promptTemplate));
    body.appendChild(guide);
  }
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const go = el('button', 'primary', t('skills.playbook.start'));
  foot.append(cancel, go);
  const modal = buildModal(playbookDisplayName(pb) || t('skills.group.playbooks'), body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    const values = {};
    for (const [key, ta] of fields) values[key] = ta.value.trim();
    const prompt = assemblePlaybookPrompt(pb, values);
    modal.close();
    if (state.streaming) { toast(t('chat.waitCurrentTurn'), ''); return; }
    sendPrompt(prompt);
  };
}
// Pure placeholder substitution: replace every {key} in the template with the user's value (missing values
// become an empty string). Extracted so the e2e can drive the same assembly logic deterministically. Only
// keys the playbook declares are substituted (a stray {foo} in the template is left as-is).
function assemblePlaybookPrompt(pb, values) {
  let out = String(pb.promptTemplate || '');
  for (const inp of (pb.inputs || [])) {
    const v = (values && values[inp.key] != null) ? String(values[inp.key]) : '';
    out = out.split('{' + inp.key + '}').join(v);
  }
  return out;
}
// The single conditional call-to-action for the empty state (§4.7), or null when everything's healthy.
function buildEmptyCTA() {
  if (!isProviderMode()) {
    const detected = state.status && state.status.detectedClaudePath;
    const configured = state.config && state.config.claudePath;
    if (!detected && !configured) {
      const b = el('button', 'primary empty-cta', t('emptyState.configureClaude'));
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
      return b;
    }
  } else {
    const p = activeProviderObj();
    if (p && !(p.apiKey && String(p.apiKey).trim())) {
      const b = el('button', 'primary empty-cta', t('emptyState.configureProviderKey', { provider: p.label || p.id }));
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
      return b;
    }
  }
  return null;
}
// meta (optional, assistant only): engine identity used to render the source badge + colored avatar
// so a multi-engine session shows WHICH engine/model produced each reply (A4/§4.4).
  return Object.freeze({
    autonomyFormSync,
    buildEmptyState,
    cliMissingCard,
    errorCard,
    isFirstRun,
    isUntitledTitle,
    loadAutonomyGrants,
    newSession,
    openBulkCleanupModal,
    openPlaybookModal,
    openSession,
    patchSession,
    previewGrant,
    refreshPlaybooks,
    refreshSessions,
    renderAutonomyBar,
    renderCurrentSession,
    renderMissionBar,
    renderResumeBanner,
    renderSessions,
    renderStepBar,
    revokeAllAutonomyGrants,
    rollbackTurn,
    stopMission,
    submitGrant,
    toggleStepBar,
    turnArtifactChips,
    turnSummaryCard,
  });
}

'use strict';

/* ============================================================
   如意 Ruyi — client (overlay v0.3;原 Win Claude Workbench,v0.8-S8 品牌落地)
   ============================================================ */

// v1.3-FE1 前端模块化 Phase 1:纯搬家。以下三处曾是 app.js 顶部的定义,现拆入 ./js/ 下的
// 原生 ES Modules,在此 import 回同名绑定 —— 全文件 233×$()/482×el()/95×toast()/45×api() 等
// 调用点【一字未改】(import 绑定在本模块作用域全文件可见,调用时点解析,行为与经典脚本一致)。
//   · state.js  —— state 骨架 + 消息窗口化常量(并挂 window.state 兼容层)
//   · util.js   —— 无状态 DOM/格式化小工具($ / el / escapeHtml / fmt* / toast / setStatus / autoGrow)
//   · net.js    —— token 读取 + 带鉴权头的 api() 封装
// index.html 的 <script src="/app.js"> 已加 type="module" 以启用 import(head 内预绘脚本不受影响)。
import { state, MSG_WINDOW_THRESHOLD, MSG_WINDOW_TAIL, MSG_WINDOW_STEP } from './js/state.js';
import { $, el, escapeHtml, fmtBytes, fmtTime, fmtTokens, toast, setStatus, autoGrow } from './js/util.js';
import { wcwToken, authHeaders, api, apiErrText } from './js/net.js';
import { icon, hydrateIcons } from './js/icons.js';

// UI v3 (§2.15): icon+文字按钮统一重建器 —— 清空后 append [SVG 图标] + [文字]。文案会变的按钮
// (发送⇄停止 / 技能徽标)复用它:直接赋 textContent 会吞掉已插入的 SVG,故走 append。
function iconTextBtn(btn, name, label, size = 16) {
  if (!btn) return;
  btn.textContent = '';
  const ic = icon(name, size);
  if (ic) btn.appendChild(ic);
  if (label) btn.appendChild(document.createTextNode(label));
}

/* ---------------- markdown rendering (XSS-safe) ---------------- */
const ALLOWED_TAGS = new Set(['A','P','BR','HR','STRONG','B','EM','I','DEL','S','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','TABLE','THEAD','TBODY','TR','TH','TD','IMG','SPAN','DIV']);
function sanitizeNode(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
  const toRemove = [];
  let node = walker.nextNode();
  while (node) {
    if (!ALLOWED_TAGS.has(node.tagName)) {
      toRemove.push(node);
    } else {
      for (const attr of [...node.attributes]) {
        const name = attr.name.toLowerCase();
        const val = attr.value;
        if (name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
        if (name === 'href' || name === 'src') {
          // Strip control/whitespace chars (browsers ignore them in schemes, e.g. "java\tscript:")
          // then allowlist protocols: http/https/mailto + relative/fragment. Everything else out.
          const v = val.replace(/[\u0000-\u0020]+/g, '');
          let ok = false;
          try {
            const u = new URL(v, location.href);
            ok = ['http:', 'https:', 'mailto:'].includes(u.protocol);
          } catch { ok = false; }
          // allow pure relative/fragment refs (no scheme)
          if (!ok && /^[#/.?]/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v)) ok = true;
          if (!ok) { node.removeAttribute(attr.name); continue; }
        } else if (name !== 'class' && name !== 'alt' && name !== 'title') {
          node.removeAttribute(attr.name);
        }
      }
    }
    node = walker.nextNode();
  }
  for (const n of toRemove) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.remove(); }
}
function renderMarkdown(text) {
  try {
    if (typeof marked === 'undefined') return `<div class="plain">${escapeHtml(text)}</div>`;
    const html = marked.parse(String(text || ''), { gfm: true, breaks: true });
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    sanitizeNode(tpl.content);
    return tpl.innerHTML;
  } catch { return `<div class="plain">${escapeHtml(text)}</div>`; }
}
function highlightIn(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code').forEach(block => {
    if (block.dataset.hl) return;
    try { hljs.highlightElement(block); } catch { /* ignore */ }
    block.dataset.hl = '1';
    const pre = block.parentElement;
    if (pre && !pre.querySelector('.copy-code')) {
      const btn = el('button', 'copy-code', '复制');
      btn.onclick = () => { navigator.clipboard?.writeText(block.textContent).then(() => toast('已复制代码', 'ok')); };
      pre.appendChild(btn);
    }
  });
}

/* ---------------- theme ---------------- */
function applyTheme(theme) {
  // v1.0.2 (F5): 同 applyUiMode —— 值未变不重写 data-theme,避免 config 到达后与预绘同值时的无谓重排。
  // 主题预绘(index.html)默认 'dark',与 server defaultConfig().theme 一致,新装机无闪;此处仅回写 localStorage。
  if (document.documentElement.getAttribute('data-theme') !== theme) document.documentElement.setAttribute('data-theme', theme);
  $('hljs-dark').disabled = theme !== 'dark';
  $('hljs-light').disabled = theme === 'dark';
  $('themeToggle').textContent = theme === 'dark' ? '🌙' : '☀️';
  try { localStorage.setItem('wcw.theme', theme); } catch { /* ignore */ }
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  saveConfigPartial({ theme: next });
}

/* ---------------- v0.9-S1 (C1): uiMode simple/pro ---------------- */
// Mirrors applyTheme: sets [data-ui-mode] (CSS drives the simple-mode hides + font bump), swaps the toggle
// glyph/title, and caches to localStorage so the head pre-paint avoids a flash on next load.
function applyUiMode(mode) {
  const m = mode === 'simple' ? 'simple' : 'pro';
  // v1.0.2 (F5): 值未变时不写 DOM 属性(避免无谓的样式重算/重排 —— 尤其 config 到达后 applyUiMode 常与
  // 预绘值相同)。localStorage 仍回写以保证下次预绘一致。
  const cur = document.documentElement.getAttribute('data-ui-mode');
  if (cur !== m) document.documentElement.setAttribute('data-ui-mode', m);
  // v1.5 (§3.4): 密度随分级联动 —— 简易=舒适(更大点击区/留白)、专家=紧凑(信息密度高)。data-density
  // 驱动间距/点击区 token 缩放(styles.css [data-density] 块)。与 data-ui-mode 同步写,避免脱钩。
  const dens = m === 'simple' ? 'comfortable' : 'compact';
  if (document.documentElement.getAttribute('data-density') !== dens) document.documentElement.setAttribute('data-density', dens);
  // v3 (§B2): agent-runs 页签在简易模式显示「AI 工作」(聚合工作流+用量/审计 mini 入口),专家模式保留「Agent 工作流」。
  { const t = document.querySelector('.tool-pane .tool-tabs button[data-tab="agent-runs"]'); if (t) t.textContent = (m === 'simple' ? 'AI 工作' : 'Agent 工作流'); }
  const btn = $('uiModeToggle');
  if (btn) {
    btn.textContent = m === 'simple' ? '🧸' : '🔧';
    btn.title = m === 'simple' ? '切换到专家界面' : '切换到精简界面';
  }
  try { localStorage.setItem('wcw.uiMode', m); } catch { /* ignore */ }
  // v1.0-S2 (IA): 更新「⋯」菜单里的界面模式项文案（若菜单当前打开）。
  if (typeof syncMoreMenuLabels === 'function') syncMoreMenuLabels();
  // v1.0-S2 (IA): 简易模式兜底 — 若当前激活页签属开发者组，切回 files（开发者组在简易模式全隐藏）。
  if (m === 'simple') {
    const active = document.querySelector('.tool-pane .tool-tabs button.active');
    if (active && typeof DEV_TABS !== 'undefined' && DEV_TABS.has(active.dataset.tab)) switchTab('files');
    // v1.5 (§1.2): 设置弹窗若开着且当前停在开发者页签(Claude CLI/Agent/集成 MCP/高级),切回「基础」——
    // 简易模式这些页签被 CSS 隐藏,面板不该带着隐藏页签的内容悬空显示。
    const sm = document.getElementById('settingsModal');
    if (sm && !sm.classList.contains('hidden')) {
      const at = document.querySelector('#settingsTabs button.active');
      if (at && typeof SETTINGS_SIMPLE_TABS !== 'undefined' && !SETTINGS_SIMPLE_TABS.has(at.dataset.stab)) switchSettingsTab('basic');
    }
  }
}
function toggleUiMode() {
  const next = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'pro' : 'simple';
  applyUiMode(next);
  if (state.config) state.config.uiMode = next;
  saveConfigPartial({ uiMode: next });
  toast(next === 'simple' ? '已切到精简界面' : '已切到专家界面', 'ok');
}

/* ---------------- v0.9-S3 (C3): working-folder ---------------- */
// The effective working folder for the CURRENT session: session.cwd first (set by the picker / folder-drag
// switch), falling back to the configured defaultWorkspace, then '' (server folds that to home). The turn
// sender (sendPrompt) uses THIS as the request cwd so a per-session switch actually drives the next turn.
function currentWorkspace() {
  return (state.currentSession && state.currentSession.cwd) || (state.config && state.config.defaultWorkspace) || '';
}
// Reflect the top-bar picker: short (basename) label + full path in the title. Called on boot, session
// switch, and after a workspace change.
function renderWorkspacePicker() {
  const btn = $('workspacePicker'); if (!btn) return;
  const full = currentWorkspace();
  const nameEl = btn.querySelector('.wp-name');
  // basename that tolerates both \ and / and a trailing separator.
  const short = full ? (full.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || full) : '工作台';
  if (nameEl) nameEl.textContent = short;         // textContent → XSS-safe (paths are attacker-influenced)
  btn.title = full || '未设置工作文件夹（点击选择）';
}
// LRU-insert a path at the front of config.recentWorkspaces (≤10, de-duped case-insensitively) and persist.
// Kept in sync with the server's normalizeConfig cleansing (which also truncates to 10).
function pushRecentWorkspace(p) {
  if (!p) return;
  const prev = Array.isArray(state.config.recentWorkspaces) ? state.config.recentWorkspaces : [];
  const filtered = prev.filter(w => String(w).toLowerCase() !== String(p).toLowerCase());
  const next = [p, ...filtered].slice(0, 10);
  state.config.recentWorkspaces = next;
  saveConfigPartial({ recentWorkspaces: next });
}
// Switch the current session's working folder to `dir`. Persists session.cwd (patchSession) + LRU + toast +
// refreshes the picker and the file tree (if its tab is showing). When alsoDefault is true, also writes
// config.defaultWorkspace (the 「设为默认工作区」 secondary option).
async function setWorkspace(dir, { alsoDefault = false } = {}) {
  if (!dir) return;
  if (!state.currentSession) await newSession();
  try {
    await patchSession(state.currentSession.id, { cwd: dir });
  } catch (e) { toast(`切换工作目录失败：${apiErrText(e)}`, 'err'); return; }
  pushRecentWorkspace(dir);
  if (alsoDefault) { state.config.defaultWorkspace = dir; saveConfigPartial({ defaultWorkspace: dir }); }
  renderWorkspacePicker();
  const treeTabActive = document.querySelector('.tool-pane .tool-tabs button[data-tab="files"]')?.classList.contains('active');
  if (treeTabActive) loadFileTree();
  toast(`工作目录已切换到 ${dir}`, 'ok');
}
// Native folder dialog → on success, switch the workspace. Shared by the picker popover's 浏览 button.
async function pickWorkspaceNative() {
  toast('正在打开文件夹选择器…', '');
  let r;
  try { r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
  catch (e) { toast(`选择器出错：${apiErrText(e)}`, 'err'); return; }
  if (!r || !r.ok) { toast(`无法打开选择器：${(r && r.error) || '未知'}${r && r.hint ? '（' + r.hint + '）' : ''}`, 'err'); return; }
  if (r.cancelled) return; // silent — user backed out
  if (r.path) await setWorkspace(r.path);
}
// v1.0.2 (G6): 顶栏工作文件夹选择器点击 → 小 popover:「浏览文件夹…」(原生选择器,主力) + 「或粘贴文件夹路径」
// 输入框(兜底,视觉次要)。粘贴路径:前端仅初查非空 + 看起来是绝对路径,然后走现有 setWorkspace(带 cwd 护栏);
// 无效路径后端会拒,toast 其错误。回车提交。
// v1.0.2 返修:Windows「复制文件地址」会给路径包上双引号("C:\path"),部分终端复制还带单引号/全角引号——
// 先剥掉成对的包裹引号再校验,否则用户按系统习惯复制的路径全被误拒。只剥【成对且在首尾】的引号,不动路径内部。
function stripWrappingQuotes(p) {
  let s = String(p || '').trim();
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']];
  for (let guard = 0; guard < 3; guard++) { // 最多剥三层(防 ""C:\x"" 类粘贴),够用且防死循环
    const hit = pairs.find(([a, b]) => s.length >= 2 && s.startsWith(a) && s.endsWith(b));
    if (!hit) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}
function looksAbsolutePath(p) {
  const s = stripWrappingQuotes(p);
  if (!s) return false;
  // Windows 盘符 (C:\ / C:/) 或 UNC (\\server\share) 或 POSIX 绝对 (/foo)。
  return /^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s);
}
async function submitPastedWorkspace(input, close) {
  const raw = stripWrappingQuotes(input.value);
  if (!raw) { toast('请输入文件夹路径', 'err'); input.focus(); return; }
  if (!looksAbsolutePath(raw)) { toast('请输入完整的绝对路径（如 C:\\Users\\me\\project）', 'err'); input.focus(); return; }
  if (close) close();
  await setWorkspace(raw); // 现有链路带 cwd 护栏与人话警告;无效路径后端拒并 toast
}
function pickWorkspace() {
  const btn = $('workspacePicker'); if (!btn) return;
  popover(btn, close => {
    const wrap = el('div', 'wp-pop');
    const browse = el('button', 'wp-pop-browse', '📁 浏览文件夹…'); browse.type = 'button';
    browse.onclick = () => { close(); pickWorkspaceNative(); };
    wrap.append(browse);
    wrap.append(el('div', 'wp-pop-or', '或粘贴文件夹路径'));
    const row = el('div', 'wp-pop-row');
    const input = el('input', 'wp-pop-input'); input.type = 'text'; input.placeholder = 'C:\\Users\\me\\project';
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPastedWorkspace(input, close); } });
    const go = el('button', 'wp-pop-go', '确定'); go.type = 'button';
    go.onclick = () => submitPastedWorkspace(input, close);
    row.append(input, go);
    wrap.append(row);
    setTimeout(() => { browse.focus(); }, 0);
    return wrap;
  }, { placement: 'bottom-start' });
}

/* ---------------- sessions ---------------- */
function groupLabel(iso) {
  const d = new Date(iso); const now = new Date();
  const days = Math.floor((now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days <= 7) return '本周';
  return '更早';
}
function renderSessions() {
  const list = $('sessionList');
  const q = $('sessionSearch').value.trim().toLowerCase();
  list.innerHTML = '';
  const filtered = state.sessions.filter(s => !q || (s.title || '').toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  const pinned = filtered.filter(s => s.pinned);
  const rest = filtered.filter(s => !s.pinned);
  const groups = [];
  if (pinned.length) groups.push(['📌 置顶', pinned]);
  const byGroup = {};
  for (const s of rest) { const g = groupLabel(s.updatedAt); (byGroup[g] = byGroup[g] || []).push(s); }
  for (const g of ['今天', '昨天', '本周', '更早']) if (byGroup[g]) groups.push([g, byGroup[g]]);

  for (const [label, items] of groups) {
    list.appendChild(el('div', 'session-group-label', label));
    for (const s of items) list.appendChild(sessionItem(s));
  }
  if (!filtered.length) list.appendChild(el('div', 'muted', q ? '无匹配会话' : '暂无会话，点击「新会话」开始'));
}
function sessionItem(s) {
  const item = el('button', `session-item ${state.currentSession?.id === s.id ? 'active' : ''}`);
  const title = el('span', 's-title', (s.pinned ? '📌 ' : '') + (s.title || s.id));
  const running = activeTurns.has(s.id);
  if (running) item.classList.add('running');
  const sub = el('span', 's-sub', `${running ? '◐ 运行中 · ' : ''}${s.messageCount || 0} 条 · ${s.summary || s.cwd || ''}`);
  const actions = el('span', 's-actions');
  const pinBtn = el('button', s.pinned ? 's-act pinned' : 's-act'); pinBtn.appendChild(icon('pin', 15)); pinBtn.title = s.pinned ? '取消置顶' : '置顶'; pinBtn.setAttribute('aria-label', pinBtn.title);
  pinBtn.onclick = e => { e.stopPropagation(); patchSession(s.id, { pinned: !s.pinned }); };
  const renameBtn = el('button', 's-act'); renameBtn.appendChild(icon('edit', 15)); renameBtn.title = '重命名'; renameBtn.setAttribute('aria-label', '重命名');
  renameBtn.onclick = e => { e.stopPropagation(); openRenamePopover(renameBtn, s); };
  const delBtn = el('button', 's-act'); delBtn.appendChild(icon('trash', 15)); delBtn.title = '删除'; delBtn.setAttribute('aria-label', '删除');
  delBtn.onclick = e => { e.stopPropagation(); if (confirm('删除该会话？')) removeSession(s.id); };
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
  state.currentSession = res.session;
  state.resumable = res.resumable || null; // v0.8-S0 A6: dangling-turn info for the resume banner
  state.msgWindowStart = null; // v1.0-S7 (perf): each session opens windowed to its tail (recompute per open)
  try { localStorage.setItem('wcw.lastSession', id); } catch { /* ignore */ }
  renderSessions();
  renderCurrentSession();
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
  head.append(el('span', '', '本轮变更'));
  // v0.8-S4b: 「撤销整轮」— rolls back every journaled file of this turn (default entrySeq). Only shown when
  // there is at least one revertible file AND we know the turnSeq (static or live event both carry it).
  if (hasRevertible && Number.isFinite(turnSeq)) {
    const undoAll = el('button', 'ts-undo-all', '撤销整轮');
    undoAll.onclick = () => { if (!confirm('撤销整轮改动？将回滚本轮所有可撤销的文件到改动前的内容，且不可恢复。')) return; rollbackTurn(turnSeq, undefined, undoAll, '整轮'); };
    head.append(undoAll);
  }
  card.append(head);
  const body = el('div', 'turn-summary-body');
  if (!files.length && commands === 0) {
    body.append(el('div', 'turn-summary-empty', '本次未改动任何文件'));
  } else {
    for (const f of files) {
      if (!f) continue;
      const row = el('div', 'turn-summary-file');
      const op = (f.op === 'create' || f.op === 'modify' || f.op === 'delete') ? f.op : 'unknown';
      const opLabel = op === 'create' ? '新建' : op === 'modify' ? '修改' : op === 'delete' ? '删除' : '变更';
      row.append(el('span', `ts-op ${op}`, opLabel), el('span', 'ts-path', f.path || ''));
      // v0.8-S4b: per-file 「撤销」— rolls back a single entry (turnSeq + entrySeq). Only for revertible
      // files that carry an entrySeq (journal-driven). Non-revertible files show nothing extra.
      if (f.revertible && Number.isFinite(turnSeq) && Number.isFinite(Number(f.entrySeq))) {
        const undo = el('button', 'ts-undo', '撤销');
        undo.onclick = () => { if (!confirm(`撤销「${f.path || ''}」的改动？将恢复到改动前的内容，且不可恢复。`)) return; rollbackTurn(turnSeq, Number(f.entrySeq), undo, f.path || ''); };
        row.append(undo);
      }
      body.append(row);
    }
    const bits = [];
    if (files.length) bits.push(`文件 ${files.length} 个`);
    if (commands) bits.push(`命令 ${commands} 条`);
    if (bits.length) body.append(el('div', 'turn-summary-cmds', bits.join(' · ')));
    // commands can't be auto-undone — say so, once, when any command ran (C6/B3 discipline).
    if (commands > 0) body.append(el('div', 'turn-summary-warn', '⚠ 命令/终端操作不可自动撤销'));
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
    const openBtn = el('button', 'artifact-chip-btn', '打开'); openBtn.type = 'button'; openBtn.title = '用系统程序打开';
    openBtn.onclick = () => revealArtifact(p, 'open');
    const locBtn = el('button', 'artifact-chip-btn', '📂 定位'); locBtn.type = 'button'; locBtn.title = '在资源管理器中定位';
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
    if (!r || !r.ok) { toast((r && r.error) || '无法打开文件', 'err'); return; }
    if (r.degradedTo && r.note) toast(r.note, '');
  } catch (e) {
    toast('打开失败：' + apiErrText(e), 'err');
  }
}
/* ---------------- v0.9-S1 (C6): error human-card ---------------- */
// Built-in mirror of the server ERROR_CLASSES table (server /api/status also ships it top-level as
// `errorClasses`; we prefer that live copy and fall back to this so an old status payload still renders).
const ERROR_CLASSES_FALLBACK = {
  provider_misconfigured: { zh: '模型端点未配置或不可用', next: '到 设置→Providers 检查地址与密钥' },
  network_down: { zh: '网络不可用（当前离线）', next: '联网后重试；或改用离线可完成的任务' },
  permission_denied: { zh: '此操作被权限拒绝', next: '在弹窗中允许，或在 设置→权限 调整模式' },
  tool_error: { zh: '工具执行出错', next: '查看工具返回的错误详情，调整参数后重试' },
  idle_timeout: { zh: '回合空闲超时，已中止', next: '重新发送，或缩小单步任务范围' },
  tool_loop: { zh: '检测到重复的工具调用，已停止本轮', next: '换个说法或参数再试；若结果不对，先确认前一步的输出' },
};
function errorClassInfo(cls) {
  const table = (state.status && state.status.errorClasses) || ERROR_CLASSES_FALLBACK;
  return table[cls] || ERROR_CLASSES_FALLBACK[cls] || null;
}
// Map an errorClass → a concrete 「下一步」 action (button). Not every class gets a button (tool_loop is
// text-only per spec — there's nothing single-click actionable). Returns {label, run} or null.
function errorClassAction(cls) {
  switch (cls) {
    case 'provider_misconfigured':
      return { label: '打开 Providers 设置', run: () => { openModal('settingsModal'); switchSettingsTab('providers'); } };
    case 'network_down':
      return { label: '查看能力矩阵', run: () => { if (typeof openCapPopover === 'function') openCapPopover(); } };
    case 'permission_denied':
      // v1.0-S2 (IA): 权限收敛为顶栏「安全」chip + 安全弹层；此处打开该弹层并给出人话提示。
      return { label: '安全设置', run: () => { if (typeof openPermPopover === 'function') openPermPopover(); toast('在顶栏「安全」中调整权限模式', 'ok'); } };
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
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', (info && info.zh) || '出现了一个问题'));
  card.append(head);
  const body = el('div', 'error-card-body');
  if (info && info.next) body.append(el('div', 'error-card-next', info.next));
  else if (rawError) body.append(el('div', 'error-card-next', String(rawError)));
  const act = errorClassAction(cls);
  if (act) {
    const btn = el('button', 'error-card-btn', act.label);
    btn.onclick = () => { try { act.run(); } catch { /* ignore */ } };
    body.append(btn);
  }
  if (noFilesChanged) body.append(el('div', 'error-card-noop', '本次未改动任何文件'));
  card.append(body);
  return card;
}
// v1.0.2 (F6c): CLI 缺失的友好引导卡。后端契约:聊天错误事件带 code:'cli-missing'(另一 agent 正在实现)。
// 向后兼容:没有 code 字段时走原始错误渲染,不依赖后端已上线 —— 只有 code==='cli-missing' 才走这张卡。
// 主张「推荐直接配置 API 引擎」+ 按钮直达设置 Providers 页签;次链接给「配置 Claude CLI 路径」。
function cliMissingCard() {
  const card = el('div', 'error-card cli-missing-card');
  const head = el('div', 'error-card-head');
  head.append(el('span', 'error-card-icon', '⚠'), el('span', 'error-card-title', '没找到 Claude CLI'));
  card.append(head);
  const body = el('div', 'error-card-body');
  body.append(el('div', 'error-card-next', '推荐直接配置 API 引擎（如 DeepSeek，注册即得免费额度），无需安装 Claude CLI 即可开始。'));
  const btn = el('button', 'error-card-btn', '去配置 API Key');
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  body.append(btn);
  const alt = el('button', 'error-card-alt', '或：配置 Claude CLI 路径');
  alt.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
  body.append(alt);
  card.append(body);
  return card;
}

// v0.8-S4b: roll back a turn (entrySeq omitted) or a single file (entrySeq given). On success the button
// becomes 「已撤销」+ disabled; on failure a toast surfaces the error. Uses api() (carries the UI token).
async function rollbackTurn(turnSeq, entrySeq, btn, label) {
  const sid = state.currentSession?.id;
  if (!sid) { toast('无当前会话', 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '撤销中…'; }
  try {
    const payload = { sessionId: sid, turnSeq };
    if (entrySeq !== undefined) payload.entrySeq = entrySeq;
    const r = await api('/api/checkpoints/rollback', { method: 'POST', body: JSON.stringify(payload) });
    if (!r || !r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? '撤销整轮' : '撤销'; }
      toast(`撤销失败：${(r && r.error) || (r && r.failed && r.failed.length ? r.failed[0].reason : '未知错误')}`, 'err');
      return;
    }
    if (btn) { btn.textContent = '已撤销'; btn.classList.add('done'); btn.disabled = true; }
    const n = (r.reverted || []).length;
    toast(`已撤销${entrySeq === undefined ? '整轮' : ''}：${label}${n ? `(${n} 个文件)` : ''}`, 'ok');
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = entrySeq === undefined ? '撤销整轮' : '撤销'; }
    toast(`撤销失败：${apiErrText(e)}`, 'err');
  }
}

function renderResumeBanner() {
  const box = $('resumeBanner');
  if (!box) return;
  box.innerHTML = '';
  const info = state.resumable;
  if (!info || !info.dangling) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const label = el('span', 'resume-banner-text', '上次任务未完成');
  const btn = el('button', 'resume-banner-btn', '继续');
  btn.onclick = () => {
    state.resumable = null;
    box.classList.add('hidden');
    box.innerHTML = '';
    sendPrompt('请继续完成上一个未完成的任务。');
  };
  box.append(label, btn);
}

async function newSession() {
  const cwd = state.config.defaultWorkspace || '';
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'New session', cwd }) });
  state.currentSession = res.session;
  state.resumable = null; // fresh session never dangles
  try { localStorage.setItem('wcw.lastSession', res.session.id); } catch { /* ignore */ }
  await refreshSessions();
  renderCurrentSession();
  renderResumeBanner();
  syncStreamingUi();
  $('promptInput').focus();
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

/* ---------------- message rendering ---------------- */
function renderCurrentSession() {
  const session = state.currentSession;
  state.shownUsage = null;
  $('sessionTitle').textContent = session?.title || '如意工作台'; // v0.8-S8 品牌落地(原「本地 Claude 工作台」)
  $('sessionMeta').textContent = session ? (session.cwd || '') : '';
  renderWorkspacePicker(); // v0.9-S3 (C3): keep the top-bar picker in sync with this session's cwd
  updateSkillBadge(); // v1 技能体系: 会话切换时刷新 composer 技能徽标(已启用技能数)
  renderStepBar(session && session.todos); // v0.8-S3: show the task-list bar if this session has todos
  const box = $('messages');
  box.innerHTML = '';
  if (!session || !session.messages?.length) { box.appendChild(buildEmptyState()); renderContextMeter(null); return; }
  // v1.0-S7 (perf): message windowing. For a big conversation, render only the tail so opening it doesn't
  // build thousands of DOM nodes up front. `start` = index of the first message we render. Small sessions
  // (≤ MSG_WINDOW_THRESHOLD) always render in full (start=0), byte-for-byte the old behavior.
  const msgs = session.messages;
  const start = windowStartFor(msgs);
  // When windowed (start > 0), prepend a「加载更早的 N 条」button that reveals MSG_WINDOW_STEP more per click
  // (repeatable to full). It sits above the first rendered message so earlier turns become reachable — this
  // is what keeps rewind/checkpoint targets on off-screen messages recoverable (click up until they render).
  if (start > 0) box.appendChild(buildLoadEarlierButton(start));
  for (let i = start; i < msgs.length; i++) box.appendChild(renderStaticMessage(msgs[i]));
  box.scrollTop = box.scrollHeight;
  renderContextMeter(latestUsage(session));
}
// v1.0-S7 (perf): compute the first-rendered-message index for the current window. Returns 0 (render all)
// for a small session or once the user has expanded to the top. state.msgWindowStart is the persisted
// expansion cursor: null means "not yet windowed" → default to the tail; a number is an explicit cursor set
// by「加载更早」(clamped so it can never exceed the tail default or go below 0).
function windowStartFor(msgs) {
  const n = Array.isArray(msgs) ? msgs.length : 0;
  if (n <= MSG_WINDOW_THRESHOLD) return 0; // small session → full render, zero change
  const tailStart = Math.max(0, n - MSG_WINDOW_TAIL);
  if (state.msgWindowStart == null) return tailStart; // fresh open → show the tail window
  return Math.max(0, Math.min(state.msgWindowStart, tailStart));
}
// v1.0-S7 (perf): the「加载更早」control. Shows how many earlier messages are hidden; clicking reveals
// MSG_WINDOW_STEP more (or all remaining, whichever is smaller) by moving the window cursor up and
// re-rendering. Preserves the reading position by anchoring scroll to the previously-first row.
function buildLoadEarlierButton(start) {
  const wrap = el('div', 'load-earlier-wrap');
  const step = Math.min(MSG_WINDOW_STEP, start);
  const btn = el('button', 'load-earlier', `加载更早的 ${step} 条（还有 ${start} 条）`);
  btn.type = 'button';
  // v1.0 收官(对抗复核·视图):流式回合期间禁止窗口重绘。renderCurrentSession 会 innerHTML='' 抹掉在途的
  // 流式 row/live.bubble,导致「回答正在生成、点侧栏它就凭空消失」的信任观感事故(数据本身无损,已磁盘验证)。
  // 与 rewind/compact 同款守卫:流式中提示稍候,不重绘。
  btn.onclick = () => {
    if (state.streaming) { toast('请先等待当前回合结束', ''); return; }
    state.msgWindowStart = Math.max(0, start - MSG_WINDOW_STEP);
    renderCurrentSession();
    // Anchor to the top so the newly-revealed batch reads from its start (don't jump to bottom).
    const box = $('messages');
    if (box) box.scrollTop = 0;
  };
  wrap.appendChild(btn);
  // 「展开全部」— one-click full expand (also the reachable path exercising expandMessageWindowFully, the
  // designated fallback for any future jump-to-message/search flow that must reach an off-screen message).
  const all = el('button', 'load-earlier load-all', '展开全部');
  all.type = 'button';
  all.onclick = () => { if (state.streaming) { toast('请先等待当前回合结束', ''); return; } expandMessageWindowFully(); const box = $('messages'); if (box) box.scrollTop = 0; };
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
  if (providerReady) { const p = providers[0]; return { ready: true, name: (p && (p.label || p.id)) || 'Provider' }; }
  return { ready: false, name: '' };
}
// v1.0-S3 (A2): 大拖放引导区 —— 点击走既有 pickWorkspace()；拖拽走既有的 shell 级 drop 处理（v0.9-S3 已实现，
// 这里只把心智可视化，不重做 drop 逻辑）。hover/dragover 用 --accent 描边 + --accent-soft 底（同 dropHint 心智）。
function buildOnboardDropZone() {
  const zone = el('button', 'onboard-drop');
  zone.type = 'button';
  zone.appendChild(el('div', 'onboard-drop-icon', '📁'));
  zone.appendChild(el('div', 'onboard-drop-title', '把文件夹拖进来，或点击选择'));
  zone.appendChild(el('div', 'onboard-drop-sub', '选一个文件夹作为 AI 的工作区，它只会看到这里面的东西'));
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
    line.appendChild(el('span', '', `AI 引擎已就绪：${r.name}`));
    return line;
  }
  // v1.0.2 (F6a):无可用引擎时 —— API 引擎优先。主卡片推荐配 API Key(DeepSeek 注册即得免费额度),
  // 「去配置」直达设置 Providers 页签;Claude CLI 收进折叠的次要入口(details),不再与 API 并列抢注意力。
  const card = el('div', 'onboard-engine warn');
  card.appendChild(el('div', 'onboard-eng-warn-title', '配置 API Key 即可开始'));
  card.appendChild(el('div', 'onboard-eng-sub', '推荐 DeepSeek —— 注册即得免费额度，几分钟就能用起来。'));
  const btn = el('button', 'primary', '去配置 API Key');
  btn.type = 'button';
  btn.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
  card.appendChild(btn);
  // 次要入口:我有 Claude CLI（折叠）。展开后给一个直达 Claude CLI 设置页签的链接式按钮。
  const adv = document.createElement('details'); adv.className = 'onboard-eng-adv';
  const sum = document.createElement('summary'); sum.textContent = '高级：我有 Claude CLI';
  adv.appendChild(sum);
  const advBtn = el('button', 'ghost onboard-eng-adv-btn', '配置 Claude CLI 路径 →');
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
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '如意 Ruyi');
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
  wrap.appendChild(el('h2', '', '直接开始工作'));
  // Engine line: "当前引擎：{engineLabel} · {model}" with a colored engine dot.
  const meta = currentEngineMeta();
  const vis = engineVisual(meta);
  const engLine = el('div', 'empty-engine');
  const dot = el('span', 'empty-eng-dot'); dot.style.background = vis.colorVar;
  engLine.append(dot, el('span', '', `当前引擎：${engineLabel()} · ${currentModelId() || '默认'}`));
  wrap.appendChild(engLine);
  wrap.appendChild(el('p', '', '发送需求、拖入文件、选择项目目录。对话与本机工具会交给当前引擎处理。'));
  // Conditional CTA (at most one). Claude + CLI not detected -> set path; provider + no key -> fill key.
  const cta = buildEmptyCTA();
  if (cta) wrap.appendChild(cta);
  // v0.9-S2 (C2): playbook card grid. In simple mode the cards are the primary entry (starters区 hidden by
  // [data-ui-mode]); pro mode keeps both. Unavailable cards render greyed + a one-line reason (never hidden).
  const pbSection = buildPlaybookSection();
  if (pbSection) wrap.appendChild(pbSection);
  const starters = el('div', 'starters');
  ['阅读该项目并总结结构', '修复 Windows 下的启动问题', '给这段代码写单元测试', '审查未提交的改动'].forEach(txt => {
    const chip = el('button', 'starter-chip', txt);
    chip.onclick = () => { $('promptInput').value = txt; autoGrow($('promptInput')); $('promptInput').focus(); };
    starters.appendChild(chip);
  });
  wrap.appendChild(starters);
  return wrap;
}
// v1.0-S3 (A): 首跑引导变体。自上而下：如意标（buildRuyiLogo，与 index.html 静态版同参）；大拖放引导区；
// 引擎状态一眼判断；任务卡（既有 playbook 首页渲染，保留在引导变体下方，不动其逻辑）。DOM 全走
// createElement/textContent（禁 innerHTML）。
function buildFirstRunState() {
  const wrap = el('div', 'empty-state onboard');
  wrap.appendChild(buildRuyiLogo());
  wrap.appendChild(el('h2', '', '欢迎使用如意工作台'));
  wrap.appendChild(el('p', '', '第一步：选一个工作文件夹，然后描述你要做的事。'));
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
  sec.appendChild(el('div', 'pb-section-title', '一键任务'));
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
  head.append(el('span', 'pb-card-icon', pb.icon || '📄'), el('span', 'pb-card-title', pb.title || pb.id));
  card.appendChild(head);
  if (pb.desc) card.appendChild(el('div', 'pb-card-desc', pb.desc));
  if (!available) card.appendChild(el('div', 'pb-card-reason', pb.unavailableReason || '当前不可用'));
  if (available) card.onclick = () => openPlaybookModal(pb);
  return card;
}
// Open the input form modal for a playbook. Renders one field per input (folder type = textbox + a hint that
// visual选择 arrives in v0.9-S3). On confirm, assemble the prompt by substituting {key} placeholders and
// call sendPrompt. XSS-safe: labels/hints via el()/textContent.
function openPlaybookModal(pb) {
  const body = el('div', 'pb-form');
  if (pb.desc) body.appendChild(el('p', 'pb-form-desc', pb.desc));
  const fields = new Map(); // key -> input element
  for (const inp of (pb.inputs || [])) {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', inp.label || inp.key));
    const ta = el('textarea', 'pb-field-input');
    ta.rows = (inp.type === 'text') ? 3 : 1;
    ta.placeholder = inp.type === 'folder' ? '粘贴文件夹的完整路径,如 D:\\报表' : (inp.type === 'file' ? '粘贴文件的完整路径' : '');
    // v0.9-S3 (C3): folder inputs get a 📁 button that pops the native picker and fills the field.
    if (inp.type === 'folder') {
      const row = el('div', 'pb-field-folder');
      const pick = el('button', 'file-label pb-pick', '📁 选择');
      pick.onclick = async () => {
        let r;
        try { r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
        catch (e) { toast(`选择器出错：${apiErrText(e)}`, 'err'); return; }
        if (r && r.ok && r.path) { ta.value = r.path; }
        else if (r && !r.ok) toast(`无法打开选择器：${r.error || '未知'}`, 'err');
      };
      row.append(ta, pick);
      field.appendChild(row);
    } else {
      field.appendChild(ta);
    }
    fields.set(inp.key, ta);
    body.appendChild(field);
  }
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  const go = el('button', 'primary', '开始');
  foot.append(cancel, go);
  const modal = buildModal(pb.title || '一键任务', body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = () => {
    const values = {};
    for (const [key, ta] of fields) values[key] = ta.value.trim();
    const prompt = assemblePlaybookPrompt(pb, values);
    modal.close();
    if (state.streaming) { toast('请先等待当前回合结束', ''); return; }
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
      const b = el('button', 'primary empty-cta', '设置 Claude CLI 路径');
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('claude', true); };
      return b;
    }
  } else {
    const p = activeProviderObj();
    if (p && !(p.apiKey && String(p.apiKey).trim())) {
      const b = el('button', 'primary empty-cta', `填写 ${p.label || p.id} 密钥`);
      b.onclick = () => { openModal('settingsModal'); switchSettingsTab('providers'); };
      return b;
    }
  }
  return null;
}
// meta (optional, assistant only): engine identity used to render the source badge + colored avatar
// so a multi-engine session shows WHICH engine/model produced each reply (A4/§4.4).
function messageShell(role, whenIso, meta) {
  const row = el('div', `message ${role}`);
  // v3 (§C4): 头像从字母方块升级为品牌 SVG —— 用户=中性人形剪影 / 助手=如意云头(引擎色底白标) / 系统=无底色 ⚙。
  const avatar = el('div', 'avatar');
  buildMsgAvatar(avatar, role);
  const main = el('div', 'msg-main');
  const head = el('div', 'msg-head');
  if (role === 'assistant') {
    const vis = engineVisual(meta);
    // 云头底色沿用引擎色(Claude=青花蓝 via --accent,Provider 各品牌色),多引擎会话一眼识别归属。
    avatar.style.background = vis.colorVar;
    // Badge = colored dot + engine name; the dot/tint color comes from --eng-color set inline here.
    const badge = el('span', 'eng-badge', vis.label);
    badge.style.setProperty('--eng-color', vis.colorVar);
    head.appendChild(badge);
    const model = meta && meta.model;
    if (model) head.append(el('span', 'eng-model', model));
  } else {
    head.append(el('span', 'who', role === 'user' ? '你' : '系统'));
  }
  if (whenIso) head.append(el('span', 'when', fmtTime(whenIso)));
  main.appendChild(head);
  row.append(avatar, main);
  return { row, main, head };
}
// v3 (§C4): 消息头像 SVG 构建器。全 createElementNS(不用 innerHTML,守 XSS 纪律)。图形为常量,无用户数据注入。
function buildMsgAvatar(box, role) {
  const NS = 'http://www.w3.org/2000/svg';
  if (role === 'assistant') {
    // 如意云头(与 --ruyi-cloud 同一三瓣路径),fill=currentColor(=--accent-ink 白);底色由调用处按引擎色设。
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 120 70'); svg.setAttribute('width', '22'); svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'currentColor');
    const cloud = document.createElementNS(NS, 'path');
    cloud.setAttribute('d', 'M60 62 C46 55 30 44 30 32 A13 13 0 0 1 53 24 A7.5 7.5 0 1 1 67 24 A13 13 0 0 1 90 32 C90 44 74 55 60 62 Z');
    svg.appendChild(cloud); box.appendChild(svg);
  } else if (role === 'user') {
    // 中性人形剪影(头 + 肩),fill=currentColor(=--ink)。
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'currentColor');
    const head = document.createElementNS(NS, 'circle');
    head.setAttribute('cx', '12'); head.setAttribute('cy', '8.5'); head.setAttribute('r', '3.9');
    const body = document.createElementNS(NS, 'path');
    body.setAttribute('d', 'M12 13.4c-4.3 0-7.6 2.7-7.6 6.3V21h15.2v-1.3c0-3.6-3.3-6.3-7.6-6.3Z');
    svg.append(head, body); box.appendChild(svg);
  } else {
    // 系统:无底色 ⚙ 弱化(CSS 把 .message.system .avatar 去底、着 --muted)。
    box.textContent = '⚙';
  }
}
// Derive an engine meta from a stored message. New messages carry engine/providerId/providerLabel/model
// directly; older ones only have `source` ('provider:xxx' | 'claude-cli' | 'aborted'|…) — fall back to
// that, resolving the provider label from the current config when possible.
function metaFromMessage(msg) {
  if (!msg) return null;
  if (msg.engine === 'openai' || msg.providerId) {
    const pid = msg.providerId || '';
    const p = (state.config.providers || []).find(x => x.id === pid);
    return { engine: 'openai', providerId: pid, providerLabel: msg.providerLabel || (p && p.label) || pid, model: msg.model || '' };
  }
  if (msg.engine === 'claude') return { engine: 'claude', model: msg.model || '' };
  const src = String(msg.source || '');
  if (src.startsWith('provider:')) {
    const pid = src.slice('provider:'.length);
    const p = (state.config.providers || []).find(x => x.id === pid);
    return { engine: 'openai', providerId: pid, providerLabel: (p && p.label) || pid, model: msg.model || '' };
  }
  // 'claude-cli', 'fallback', 'aborted', 'stderr', or missing -> treat as Claude (the historical default).
  return { engine: 'claude', model: msg.model || '' };
}
// Count characters in a thinking transcript for the collapsed summary "思考过程 · N 字" (C2). Pure so
// it can be unit-tested; counts JS string length (code units), which is fine for a rough CJK-ish size.
function thinkingCharCount(text) { return String(text || '').length; }
// The summary label for a SETTLED thinking panel: "思考过程 · N 字" (N = char count), or plain "思考过程"
// when empty. The mid-stream "思考中…" + shimmer state is chosen by the caller (thinkingPanel/setLive),
// not here. Pure helper for testing the collapsed-state text.
function thinkingSummaryLabel(text) { const n = thinkingCharCount(text); return n > 0 ? `思考过程 · ${n} 字` : '思考过程'; }
// text (optional) seeds the body; `live` renders the streaming "思考中…" shimmer summary. Returns the
// <details>, the body element, and setLive(on)/refreshLabel() so the streaming path can settle it.
function thinkingPanel(text, live) {
  const d = el('details', 'thinking');
  const sum = el('summary', '', live ? '思考中…' : thinkingSummaryLabel(text));
  if (live) sum.classList.add('thinking-live');
  d.appendChild(sum);
  const body = el('div', 'think-body', text); d.appendChild(body);
  const setLive = on => {
    if (on) { sum.classList.add('thinking-live'); sum.textContent = '思考中…'; }
    else { sum.classList.remove('thinking-live'); sum.textContent = thinkingSummaryLabel(body.textContent); }
  };
  return { d, body, summary: sum, setLive };
}
// Pick the first present string field from a tool's input for the header summary (C1), in priority
// order, then middle-ellipsize to ≤44 chars keeping head+tail. Returns '' when nothing usable. Pure.
const TC_ARG_KEYS = ['path', 'url', 'command', 'pattern', 'root', 'query', 'title', 'text'];
function toolArgSummary(input, max = 44) {
  if (!input || typeof input !== 'object') return '';
  let raw = '';
  for (const k of TC_ARG_KEYS) { const v = input[k]; if (typeof v === 'string' && v.trim() !== '') { raw = v; break; } }
  return middleEllipsis(raw.replace(/\s+/g, ' ').trim(), max);
}
// Middle-ellipsize a string to at most `max` chars, keeping the head and tail (so long paths/urls stay
// recognizable at both ends). Uses a single '…' in the middle. Pure.
function middleEllipsis(s, max = 44) {
  s = String(s || '');
  if (s.length <= max) return s;
  if (max <= 1) return '…';
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
}
// Attach a floating "复制" button (reusing .copy-code) to a <pre>, wrapped so hover reveals it. Returns
// the wrapper to append. copies the pre's textContent to the clipboard.
function wrapPreWithCopy(pre) {
  const wrap = el('div', 'tc-pre-wrap');
  const btn = el('button', 'copy-code', '复制'); btn.type = 'button';
  btn.onclick = e => { e.preventDefault(); e.stopPropagation(); navigator.clipboard?.writeText(pre.textContent || '').then(() => toast('已复制', 'ok')); };
  wrap.append(pre, btn);
  return wrap;
}
// v1.0-S4: pull the unified-diff text out of a git_diff tool result (accepts an object with `.diff`, or a
// JSON string, or an MCP content-array wrapper). Returns '' when there is no usable diff text.
function gitDiffText(result) {
  let obj = result;
  if (Array.isArray(obj)) { obj = obj.map(p => (p && typeof p.text === 'string') ? p.text : '').join(''); }
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return obj.trim() ? obj : ''; } }
  if (obj && typeof obj === 'object' && typeof obj.diff === 'string') return obj.diff;
  return '';
}
// v1.0-S4: colorized unified-diff view. Builds a `.diff-view` block: one <div> per line, classed by the
// first char (+ add / - del / @@ hunk / else default). SECURITY: every line goes in via textContent — NEVER
// innerHTML (a diff can contain arbitrary source, including markup). Over 800 lines → collapse behind a
// 「展开全部」 button (only the first 800 render until expanded), keeping huge diffs from freezing the DOM.
const DIFF_COLLAPSE_LINES = 800;
function renderDiffView(diffText) {
  const view = el('div', 'diff-view');
  const lines = String(diffText || '').split('\n');
  const total = lines.length;
  const collapsed = total > DIFF_COLLAPSE_LINES;
  const appendLines = (from, to) => {
    for (let i = from; i < to; i++) {
      const line = lines[i];
      let cls = 'diff-line';
      // File headers (+++/---) must be checked before the +/- add/del classes so they don't miscolor.
      if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-file';
      else if (line.startsWith('@@')) cls += ' diff-hunk';
      else if (line.startsWith('+')) cls += ' diff-add';
      else if (line.startsWith('-')) cls += ' diff-del';
      const row = el('div', cls);
      row.textContent = line.length ? line : ' '; // keep blank lines a visible height
      view.appendChild(row);
    }
  };
  appendLines(0, collapsed ? DIFF_COLLAPSE_LINES : total);
  if (collapsed) {
    const btn = el('button', 'diff-expand', `展开全部（共 ${total} 行）`); btn.type = 'button';
    btn.onclick = e => {
      e.preventDefault(); e.stopPropagation();
      appendLines(DIFF_COLLAPSE_LINES, total);
      btn.remove();
    };
    view.appendChild(btn);
  }
  return view;
}
// tc: { name, input, result?, isError?, durationMs? }. Builds the upgraded card (C1): left status bar
// (running/ok/err), arg summary, optional duration, copy buttons on both <pre>. Fail auto-opens.
// Returns handles the streaming path uses to fill the result + timing + status bar post-render.
function toolCard(tc) {
  const d = el('details', 'tool-card');
  const done = tc.result !== undefined;
  const statusbar = el('div', 'tc-statusbar' + (done ? (tc.isError ? ' err' : ' ok') : ' running'));
  d.appendChild(statusbar);
  const sum = el('summary');
  // v0.7d: bridged desktop-control tools carry the ai_computer_control__ prefix — badge them with 🖥.
  const isDesktopTool = typeof tc.name === 'string' && tc.name.startsWith('ai_computer_control__'); // v3 (§2.15): tc-icon emoji → 线性 SVG(monitor/wrench)
  // v0.9-S1 (C1): both a raw name (pro) and a plain-language verb (simple) ship; CSS shows one per uiMode
  // via [data-ui-mode]. The verb reuses humanizeToolName (the shared 人话 map, also used by permission popups).
  const tcIconEl = el('span', 'tc-icon'); tcIconEl.appendChild(icon(isDesktopTool ? 'monitor' : 'wrench', 15));
  sum.append(
    tcIconEl,
    el('span', 'tc-name', tc.name || 'tool'),
    el('span', 'tc-verb', humanizeToolName(tc.name)),
  );
  const arg = toolArgSummary(tc.input);
  const argEl = el('span', 'tc-arg', arg); if (arg) argEl.title = arg;
  sum.appendChild(argEl);
  // Duration slot: filled now for static cards that carry durationMs; streaming fills it on tool_result.
  const dur = el('span', 'tc-dur'); if (done && Number.isFinite(tc.durationMs)) dur.textContent = `· ${(tc.durationMs / 1000).toFixed(1)}s`;
  sum.appendChild(dur);
  const status = el('span', 'tc-status', done ? (tc.isError ? '出错' : '完成') : '运行中…');
  if (done) status.classList.add(tc.isError ? 'err' : 'ok');
  sum.appendChild(status);
  d.appendChild(sum);
  const body = el('div', 'tc-body');
  // v1.0-S4: git_diff gets a colorized diff view at the TOP of the body (the 「改了什么」 primary view, useful
  // even in simple mode). The raw JSON still lives in the 详情 block below. diffHost is returned so the
  // streaming tool_result path can fill it once the result arrives.
  const diffHost = el('div', 'tc-diff-host');
  body.appendChild(diffHost);
  if (done && !tc.isError) renderGitDiffInto(diffHost, tc.name, tc.result);
  // v0.9-S1 (C1): the input/result JSON lives in a nested <details class="tc-detail"> (open by default). In
  // pro mode CSS hides the nested summary so it reads as a plain always-open body (unchanged look); in simple
  // mode the 「详情」summary shows so a 人人可用 user can collapse the raw JSON. It starts open either way,
  // so content is never hidden by default — simple users opt INTO folding.
  const detail = el('details', 'tc-detail'); detail.open = true;
  const detailSum = el('summary', 'tc-detail-sum'); detailSum.textContent = '详情'; detail.appendChild(detailSum);
  detail.appendChild(el('div', 'tc-label', '输入'));
  const inp = el('pre'); inp.textContent = safeStringify(tc.input); detail.appendChild(wrapPreWithCopy(inp));
  const resLabel = el('div', 'tc-label', '结果'); detail.appendChild(resLabel);
  const resPre = el('pre'); resPre.textContent = done ? safeStringify(tc.result) : '（等待结果）'; detail.appendChild(wrapPreWithCopy(resPre));
  body.appendChild(detail);
  d.appendChild(body);
  if (done && tc.isError) d.open = true; // failed static cards start expanded
  return { d, status, resPre, statusbar, dur, argEl, diffHost, name: tc.name };
}
// v1.0-S4: fill a tool card's diff-host with the colorized diff view IFF this is a git_diff result carrying
// non-empty diff text. Idempotent (clears the host first) so the streaming path can call it after the result
// lands. No-op for every other tool / empty diff — the host stays empty and collapses.
function renderGitDiffInto(host, name, result) {
  if (!host) return;
  host.textContent = '';
  if (name !== 'git_diff') return;
  const text = gitDiffText(result);
  if (!text || !text.trim()) return;
  host.appendChild(el('div', 'tc-label', '改动'));
  host.appendChild(renderDiffView(text));
}
function safeStringify(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
/* ---------------- v1.0.2 (G4): 同回合多工具卡折叠成组 ---------------- */
// A turn with >3 top-level tool cards collapses its COMPLETED cards into a single <details.tool-group>
// (summary counts them); the currently-running card stays outside the group, always visible. Each card's
// own DOM (details.tool-card) is untouched — it is merely re-parented into the group container, so the e2e
// contract on card internals holds. Nested sub-agent tool cards (subagentId → their own body) are never
// folded here (they already live in their own container).
//
// Live model: live.topTools = [{id, done, el}] in arrival order; live.toolGroup = the <details> (lazy).
// The group is inserted as the FIRST child of toolsWrap so folded (completed) cards sit above the running
// one, reading chronologically. buildToolGroup() makes an empty group; foldToolGroup() re-parents cards.
function toolGroupSummaryText(n) { return '已完成 ' + n + ' 个工具调用'; }
function ensureLiveToolGroup(live) {
  if (live.toolGroup) return live.toolGroup;
  const det = el('details', 'tool-group');
  const sum = el('summary', 'tool-group-sum');
  sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', toolGroupSummaryText(0)));
  det.appendChild(sum);
  const body = el('div', 'tool-group-body');
  det.appendChild(body);
  det._tgBody = body; det._tgLabel = sum.querySelector('.tg-label');
  live.toolGroup = det;
  // Insert at the top of the tools wrap so completed cards read above the running card.
  live.toolsWrap.insertBefore(det, live.toolsWrap.firstChild);
  return det;
}
function refreshLiveToolGroupCount(live) {
  if (!live.toolGroup) return;
  const n = live.toolGroup._tgBody.childElementCount;
  live.toolGroup._tgLabel.textContent = toolGroupSummaryText(n);
}
// Move every COMPLETED top-level card that is not already inside the group into the group body (in order).
// Running cards are left in place (outside the group, visible). Called after the 4th card appears and after
// each subsequent tool_result / at turn end.
function foldCompletedTopTools(live) {
  if (!live.toolGroup) return;
  const body = live.toolGroup._tgBody;
  for (const t of live.topTools) {
    if (t.done && t.el.parentNode !== body) body.appendChild(t.el);
  }
  refreshLiveToolGroupCount(live);
}
// Register a newly-appeared top-level tool card. When the 4th appears, create the group and fold the
// already-completed cards into it.
function registerTopToolCard(live, id, cardEl) {
  if (!live.topTools) live.topTools = [];
  live.topTools.push({ id, el: cardEl, done: false });
  if (live.topTools.length >= 4 && !live.toolGroup) {
    ensureLiveToolGroup(live);
    foldCompletedTopTools(live);
  }
}
// Mark a top-level card done (on tool_result) and fold it in if the group already exists.
function markTopToolDone(live, id) {
  if (!live.topTools) return;
  const t = live.topTools.find(x => x.id === id);
  if (t) t.done = true;
  if (live.toolGroup) foldCompletedTopTools(live);
}
// Turn end: fold the last completed card(s) in (finalizeLive calls this). No-op if the group never formed.
function foldToolGroupAtTurnEnd(live) {
  if (!live || !live.toolGroup) return;
  // Mark any card whose status bar shows a settled (ok/err) state as done, then fold.
  for (const t of (live.topTools || [])) {
    const sb = t.el.querySelector('.tc-statusbar');
    if (sb && !sb.classList.contains('running')) t.done = true;
  }
  foldCompletedTopTools(live);
}
// Static re-render (history): given an array of top-level tool-card elements, if there are >3, wrap them
// ALL into a collapsed <details.tool-group> (summary = 「N 个工具调用」). Returns the group element, or null
// when ≤3 (caller appends the cards individually). Sub-agent cards are handled by their own path and are
// NOT passed here.
function buildStaticToolGroup(cardEls) {
  if (!Array.isArray(cardEls) || cardEls.length <= 3) return null;
  const det = el('details', 'tool-group');
  const sum = el('summary', 'tool-group-sum');
  sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', cardEls.length + ' 个工具调用'));
  det.appendChild(sum);
  const body = el('div', 'tool-group-body');
  for (const c of cardEls) body.appendChild(c);
  det.appendChild(body);
  return det;
}
// meta (optional): engine identity so the line ends with a muted engine name (C3). Tokens go through
// fmtTokens (↑in ↓out); duration/cost only appear when present (provider turns usually lack cost).
function usageLine(u, meta) {
  const line = el('div', 'usage-line');
  const parts = [];
  const inp = u.usage?.input_tokens, out = u.usage?.output_tokens;
  // E4: providers that never send a usage frame get a server-side estimate flagged estimated:true — prefix
  // it with 约 (approx.) so the number does not read as an exact provider-reported count.
  if (inp != null || out != null) parts.push(`<b>${u.estimated ? '约' : ''}↑${fmtTokens(inp ?? 0)} ↓${fmtTokens(out ?? 0)}</b>`);
  if (u.durationMs != null) parts.push(`<b>${(u.durationMs / 1000).toFixed(1)}s</b>`);
  if (u.costUsd != null) parts.push(`<b>$${Number(u.costUsd).toFixed(4)}</b>`);
  if (u.numTurns != null) parts.push(`${u.numTurns} 轮`);
  let html = parts.join(' · ');
  // Trailing muted engine name from the message meta, or the current engine when rendered live.
  const engName = engineVisual(meta || currentEngineMeta()).label;
  if (engName) html += `${html ? ' · ' : ''}<span class="usage-eng">${escapeHtml(engName)}</span>`;
  line.innerHTML = html;
  return line;
}
/* ---------------- context-window meter (client-only; fed by per-turn usage) ---------------- */
// v1.3-FE1:fmtTokens 已搬入 ./js/util.js(纯格式化,顶部 import 取回);此处 ctx-meter 族仍用同名调用。
// Best-effort context limit by model name — LAST-RESORT fallback only (server's contextWindowResolved is
// preferred, see ctxWindow). v1.0.2 返修三:此前 deepseek 一律 65536 —— 电量表分母恒为 64K,deepseek-v4(1M)
// 被当 64K,「12K/64K·18%」而非真实「12K/1M·1%」,正是用户看到的 65.5k。表已与服务端 MODEL_CONTEXT_TABLE 对齐。
function ctxWindowGuess(model) {
  const m = String(model || '').toLowerCase();
  if (/haiku/.test(m)) return 200000;
  if (/opus-4|sonnet-5|sonnet-4|fable|mythos/.test(m)) return 1000000;
  if (/deepseek-v4/.test(m)) return 1000000;   // deepseek-v4 = 1M(此前被并入 65536)
  if (/deepseek/.test(m)) return 131072;        // 其余 deepseek(v3/chat/reasoner)= 128K
  if (/kimi|moonshot/.test(m)) return 262144;
  if (/glm/.test(m)) return 131072;
  if (/qwen.*(turbo|long)/.test(m)) return 1000000;
  if (/qwen|qwq/.test(m)) return 131072;
  if (/gpt-4o|gpt-4\.1/.test(m)) return 128000;
  if (/o3|o4/.test(m)) return 200000;
  return 200000;
}
// v1.0.2 返修三:上下文窗口的优先级 —— ①用户在电量表上手动设的上限(localStorage,最高优先);②服务端三级解析
// contextWindowResolved(manual>接口探测>名称表,权威;但 source==='fallback' 说明服务端也没辙——多为 Claude 引擎
// 或未知模型——此时【不】用它的 65536 兜底,落到客户端名称猜测,让 claude/opus 等仍走各自 heuristic);③客户端猜测。
// v1.4.1: 手动锁定的上下文上限改为【按模型】存(键名带 model id),避免一个模型的锁串到另一个模型
// (真机 foot-gun:在 qwen 上点过 128K,切到 deepseek-v4 也显示 128K)。旧的全局键 `wcw.ctxWindow` 首次读到时
// 一次性迁移进当前模型的键并删除,兼容存量。
function ctxWindowKey(model) { const m = String(model || currentModelId() || '').trim(); return m ? 'wcw.ctxWindow::' + m : 'wcw.ctxWindow'; }
function ctxWindowManual(model) {
  try {
    const k = parseInt(localStorage.getItem(ctxWindowKey(model)) || '0', 10);
    if (Number.isFinite(k) && k > 0) return k;
    const g = parseInt(localStorage.getItem('wcw.ctxWindow') || '0', 10); // 存量全局锁 → 迁移
    if (Number.isFinite(g) && g > 0) {
      try { localStorage.setItem(ctxWindowKey(model), String(g)); localStorage.removeItem('wcw.ctxWindow'); } catch { /* ignore */ }
      return g;
    }
  } catch { /* ignore */ }
  return 0;
}
function setCtxWindowManual(n, model) {
  try { if (n > 0) localStorage.setItem(ctxWindowKey(model), String(n)); else localStorage.removeItem(ctxWindowKey(model)); localStorage.removeItem('wcw.ctxWindow'); } catch { /* ignore */ }
}
function ctxWindow() {
  const o = ctxWindowManual();
  if (o > 0) return o;
  const r = state.status && state.status.contextWindowResolved;
  if (r && r.source && r.source !== 'fallback' && Number.isFinite(r.value) && r.value > 0) return r.value;
  return ctxWindowGuess(currentModelId());
}
// 当前上限读数的来源人话标签(供电量表 tooltip + 弹层)。「按名称推测」= 端点未报告真实上限、只能按模型名猜,可能不准。
function ctxWindowSourceLabel() {
  if (ctxWindowManual() > 0) return '手动锁定';
  const r = state.status && state.status.contextWindowResolved;
  if (r && r.source === 'probe' && r.value > 0) return '接口探测';
  if (r && r.source === 'manual' && r.value > 0) return '设置固定';
  return '按名称推测';
}
// Context "in play" after a turn. Prefer the server's accurate per-call figure (contextTokens);
// fall back to summing raw usage fields only for older payloads that lack it.
function ctxTokensOf(u) {
  if (u && Number.isFinite(u.contextTokens) && u.contextTokens > 0) return u.contextTokens;
  const g = u && u.usage;
  if (!g) return null;
  const n = (g.input_tokens || 0) + (g.cache_read_input_tokens || 0) + (g.cache_creation_input_tokens || 0) + (g.output_tokens || 0);
  return n > 0 ? n : null;
}
function latestUsage(session) {
  const msgs = session && session.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].usage) return msgs[i].usage;
  return null;
}
function renderContextMeter(u) {
  const box = $('contextMeter');
  if (!box) return;
  const n = ctxTokensOf(u);
  if (n == null) { state.shownUsage = null; box.classList.add('hidden'); return; }
  state.shownUsage = u;
  const win = ctxWindow(), pct = win > 0 ? n / win : 0;
  // Keep this visible in both UI modes once usage exists. The manual compact action lives in this
  // meter's popover, so hiding low usage also made context occupancy and compaction disappear.
  // Battery drains as context fills: fill width = remaining capacity (1 - pct) of the 17.8px interior.
  const fill = box.querySelector('.batt-fill');
  if (fill) fill.setAttribute('width', (Math.max(0, Math.min(1, 1 - pct)) * 17.8).toFixed(2));
  // v1.0.2 返修三跟进:上限若被【手动锁定】(localStorage 覆盖),在读数后标一个 🔒 —— 否则用户看不出上限是
  // 手动固定的,一次误点 128K 预设就永久盖过自动探测(deepseek-v4-pro 真机撞出:显示 131k 而非 1M,查明是
  // 早先手动设过 128K)。有锁时提示可点「自动」解锁。
  const manual = ctxWindowManual();
  const locked = manual > 0;
  box.querySelector('.ctx-text').textContent = `${fmtTokens(n)} / ${fmtTokens(win)}${locked ? ' 🔒' : ''} · ${Math.round(pct * 100)}%`;
  box.classList.remove('warn', 'crit');
  if (pct >= 0.9) box.classList.add('crit'); else if (pct >= 0.7) box.classList.add('warn');
  const g = u.usage || {};
  const srcLabel = ctxWindowSourceLabel();
  const srcLine = locked
    ? `上限来源:手动锁定 ${win.toLocaleString()}（点击电量表→「自动」可改回自动推断）`
    : `上限来源:${srcLabel}${srcLabel === '按名称推测' ? '（该端点未报告真实上限，按模型名推测，可能不准；点电量表可手动锁定实际值）' : ''}`;
  box.title = `上下文 ≈ ${n.toLocaleString()} / 上限 ${win.toLocaleString()} tokens\n` +
    `输入 ${g.input_tokens || 0} · 缓存读 ${g.cache_read_input_tokens || 0} · 缓存写 ${g.cache_creation_input_tokens || 0} · 输出 ${g.output_tokens || 0}\n${srcLine}`;
  box.classList.remove('hidden');
}
function updateContextMeter() { renderContextMeter(state.shownUsage || latestUsage(state.currentSession)); }

function msgActions(msg) {
  const bar = el('div', 'msg-actions');
  const copy = el('button', '', '复制');
  copy.onclick = () => { navigator.clipboard?.writeText(msg.content || '').then(() => toast('已复制', 'ok')); };
  bar.appendChild(copy);
  if (msg.role === 'user') {
    const edit = el('button', '', '编辑重发');
    edit.onclick = () => { $('promptInput').value = msg.content || ''; autoGrow($('promptInput')); $('promptInput').focus(); };
    const retry = el('button', '', '重试');
    retry.onclick = () => sendPrompt(msg.content || '');
    bar.append(edit, retry);
    // v0.8-S4b B2: 「⏪ 回溯到此处」— rewind the conversation to just before this message.
    const rewind = el('button', '', '⏪ 回溯到此处');
    rewind.onclick = () => openRewindModal(msg);
    bar.append(rewind);
  } else if (msg.role === 'assistant') {
    // v0.9-S2 (C2): 「存为 playbook」— turn this completed task into a reusable template. Provider engine
    // only (the draft uses the active provider). Hidden when no session or a turn is streaming.
    if (isProviderMode()) {
      const save = el('button', '', '存为 playbook');
      save.onclick = () => saveAsPlaybook(save);
      bar.append(save);
      // v2 跨会话记忆: 「存为记忆」(draft→编辑弹窗→保存)。draft 用 provider,故与「存为 playbook」同处 provider 分支。
      const mem = el('button', '', '存为记忆');
      mem.onclick = () => saveAsMemory(mem);
      bar.append(mem);
    }
  }
  return bar;
}

/* ---------------- v0.9-S2: 存为 playbook ---------------- */
// Ask the server to draft a playbook from the current session (most-recent user msg + turn_summary), then
// open an edit modal (title/desc/promptTemplate editable) → confirm → POST /api/playbooks.
async function saveAsPlaybook(btn) {
  const sid = state.currentSession && state.currentSession.id;
  if (!sid) { toast('没有可保存的会话', 'err'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '起草中…'; }
  try {
    const r = await api('/api/playbooks/draft', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
    if (!r || !r.ok || !r.draft) { toast(`起草失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
    openPlaybookEditModal(r.draft);
  } catch (e) { toast(`起草失败：${apiErrText(e)}`, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
// Edit modal for a drafted playbook: title / desc / promptTemplate are editable; on confirm, POST the
// normalized object to /api/playbooks (server re-normalizes). XSS-safe — values via el/value, never innerHTML.
function openPlaybookEditModal(draft) {
  const body = el('div', 'pb-form');
  const mkField = (label, value, rows) => {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', label));
    const ta = el(rows > 1 ? 'textarea' : 'input', 'pb-field-input');
    if (rows > 1) ta.rows = rows; else ta.type = 'text';
    ta.value = value || '';
    field.appendChild(ta);
    body.appendChild(field);
    return ta;
  };
  const titleEl = mkField('标题', draft.title, 1);
  const descEl = mkField('说明', draft.desc, 2);
  const tmplEl = mkField('任务模板(用 {参数名} 作占位符)', draft.promptTemplate, 8);
  // Show the detected input parameters read-only (they come from the draft; folder/file types preserved).
  if ((draft.inputs || []).length) {
    const info = el('div', 'pb-field-hint', '参数:' + draft.inputs.map(i => `{${i.key}}` + (i.type !== 'text' ? `(${i.type})` : '')).join('  '));
    body.appendChild(info);
  }
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  const save = el('button', 'primary', '保存');
  foot.append(cancel, save);
  const modal = buildModal('存为 playbook', body, foot);
  cancel.onclick = () => modal.close();
  save.onclick = async () => {
    const pb = { ...draft, title: titleEl.value.trim(), desc: descEl.value.trim(), promptTemplate: tmplEl.value };
    if (!pb.title || !pb.promptTemplate.trim()) { toast('标题和任务模板不能为空', 'err'); return; }
    save.disabled = true; save.textContent = '保存中…';
    try {
      const r = await api('/api/playbooks', { method: 'POST', body: JSON.stringify({ playbook: pb }) });
      modal.close();
      if (!r || !r.ok) { toast(`保存失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
      toast('已存为 playbook', 'ok');
      refreshPlaybooks(); // reflect the new card in the empty state
    } catch (e) { modal.close(); toast(`保存失败：${apiErrText(e)}`, 'err'); }
  };
}

/* ---------------- v0.8-S4b: conversation rewind ---------------- */
// Resolve the turnSeq to rewind to for a user message. Primary: the message's own turnSeq (S4b stamps it).
// Fallback for legacy messages: the turnSummary.turnSeq of the FOLLOWING assistant; else the 1-based
// ordinal among user messages (matches the server's fallback ladder).
function turnSeqForUserMessage(msg) {
  const session = state.currentSession;
  const msgs = (session && session.messages) || [];
  if (Number.isFinite(Number(msg.turnSeq))) return Number(msg.turnSeq);
  const idx = msgs.indexOf(msg);
  if (idx >= 0) {
    for (let j = idx + 1; j < msgs.length; j++) {
      const m = msgs[j];
      if (m && m.role === 'assistant' && m.turnSummary && Number.isFinite(Number(m.turnSummary.turnSeq))) return Number(m.turnSummary.turnSeq);
    }
  }
  // ordinal
  let n = 0; for (const m of msgs) { if (m && m.role === 'user') { n++; if (m === msg) return n; } }
  return null;
}
// Count the turns (user messages) and revertible files at/after the cut point, for the confirm modal.
function rewindImpact(msg) {
  const session = state.currentSession;
  const msgs = (session && session.messages) || [];
  const idx = msgs.indexOf(msg);
  let turns = 0; const filePaths = new Set();
  if (idx >= 0) {
    for (let i = idx; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m) continue;
      if (m.role === 'user') turns++;
      if (m.role === 'assistant' && m.turnSummary && Array.isArray(m.turnSummary.filesChanged)) {
        for (const f of m.turnSummary.filesChanged) { if (f && f.revertible && f.path) filePaths.add(f.path); }
      }
    }
  }
  return { turns, fileCount: filePaths.size };
}
function openRewindModal(msg) {
  if (state.streaming) { toast('请先停止当前回合再回溯', ''); return; }
  const sid = state.currentSession?.id;
  const targetTurnSeq = turnSeqForUserMessage(msg);
  if (!sid || targetTurnSeq == null) { toast('无法定位该消息的回合', 'err'); return; }
  const { turns, fileCount } = rewindImpact(msg);
  const body = el('div');
  body.append(el('p', '', `回到这条消息之前?将删除之后的 ${turns} 轮对话。`));
  const preview = el('div', 'rewind-preview'); preview.textContent = (msg.content || '').slice(0, 300);
  body.append(preview);
  let fileBox = null;
  if (fileCount > 0) {
    const wrap = el('label', 'check');
    fileBox = document.createElement('input'); fileBox.type = 'checkbox'; fileBox.checked = true; // default-on when M>0
    wrap.append(fileBox, document.createTextNode(` 同时撤销这些轮次的文件改动(${fileCount} 个文件)`));
    body.append(wrap);
  }
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  const go = el('button', 'danger', '回溯');
  foot.append(cancel, go);
  const modal = buildModal('回溯对话', body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = async () => {
    go.disabled = true; go.textContent = '回溯中…';
    try {
      const r = await api('/api/session/rewind', { method: 'POST', body: JSON.stringify({ sessionId: sid, targetTurnSeq, rollbackFiles: !!(fileBox && fileBox.checked) }) });
      modal.close();
      if (!r || !r.ok) { toast(`回溯失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
      // Reload the truncated session and re-render; refill the composer with the removed user text.
      // v1.0-S7 (perf): reset the window cursor so the shrunken conversation re-windows from its new tail.
      if (state.currentSession?.id === sid) { const s = await api(`/api/sessions/${sid}`); state.currentSession = s.session; state.resumable = s.resumable || null; state.msgWindowStart = null; renderCurrentSession(); renderResumeBanner(); }
      await refreshSessions();
      if (r.lastUserText != null) { $('promptInput').value = r.lastUserText; autoGrow($('promptInput')); $('promptInput').focus(); }
      const reverted = (r.filesReverted || []).length;
      const failed = (r.filesFailed || []).length;
      let m = `已回溯,删除 ${r.removedTurns || 0} 条消息`;
      if (reverted) m += ` · 撤销 ${reverted} 个文件`;
      if (failed) m += ` · ${failed} 个未能撤销`;
      toast(m, failed ? '' : 'ok');
    } catch (e) { modal.close(); toast(`回溯失败：${apiErrText(e)}`, 'err'); }
  };
}
function renderStaticMessage(msg) {
  const meta = msg.role === 'assistant' ? metaFromMessage(msg) : null;
  const { row, main } = messageShell(msg.role, msg.createdAt, meta);
  if (msg.thinking) { const { d } = thinkingPanel(msg.thinking); main.appendChild(d); }
  const bubble = el('div', 'bubble');
  if (msg.role === 'assistant') { bubble.classList.add('md'); bubble.innerHTML = renderMarkdown(msg.content || ''); highlightIn(bubble); }
  else { bubble.classList.add('plain'); bubble.textContent = msg.content || ''; }
  main.appendChild(bubble);
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length) {
    // v1.0.2 (G4): >3 top-level tool cards → collapse them all into one <details.tool-group>. ≤3 render flat.
    const cardEls = msg.toolCalls.map(tc => toolCard(tc).d);
    const group = buildStaticToolGroup(cardEls);
    if (group) main.appendChild(group);
    else for (const c of cardEls) main.appendChild(c);
  }
  if (msg.turnSummary) {
    main.appendChild(turnSummaryCard(msg.turnSummary)); // v0.8-S3 「本轮变更」
    const chips = turnArtifactChips(msg.turnSummary); if (chips) main.appendChild(chips); // v1.0.2 (G2)
  }
  if (msg.usage) main.appendChild(usageLine(msg.usage, meta));
  main.appendChild(msgActions(msg));
  return row;
}

/* ---------------- attachments ---------------- */
function renderAttachments() {
  const tray = $('attachmentTray');
  tray.innerHTML = '';
  state.attachments.forEach((f, i) => {
    const pill = el('span', 'attachment-pill');
    pill.append(el('span', '', `${f.name} · ${fmtBytes(f.size)}`));
    const x = el('button', 'attach-x'); x.appendChild(icon('close', 12)); x.setAttribute('aria-label', '移除附件'); x.title = '移除';
    x.onclick = () => { state.attachments.splice(i, 1); renderAttachments(); };
    pill.appendChild(x);
    tray.appendChild(pill);
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}
async function uploadFiles(files) {
  for (const file of files) {
    if (file.size > 90 * 1048576) { toast(`${file.name} 过大（>90MB）`, 'err'); continue; }
    try {
      const data = await fileToBase64(file);
      const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
      state.attachments.push(res.file);
    } catch (e) { toast(`上传失败：${apiErrText(e)}`, 'err'); }
  }
  renderAttachments();
}

/* ---------------- v0.9-S3 (C3): folder-drag → set workspace ---------------- */
// The browser never gives a dropped folder's absolute path (webkitGetAsEntry → name + child names only).
// So we read the folder's name + first-level child names (≤50) as a FINGERPRINT and POST it to the server,
// which searches its candidate roots for the real directory. handleDrop below splits dropped items: files
// go to the existing attachment flow; directories go here.
const DROP_CHILDREN_CAP = 50;
// Read up to DROP_CHILDREN_CAP first-level child names of a FileSystemDirectoryEntry (readEntries yields in
// batches, so loop until it returns [] — but stop at the cap). Names only; XSS-safe by construction.
function readDirEntryChildren(dirEntry) {
  return new Promise(resolve => {
    const reader = dirEntry.createReader();
    const names = [];
    const readBatch = () => {
      reader.readEntries(entries => {
        if (!entries.length || names.length >= DROP_CHILDREN_CAP) { resolve(names.slice(0, DROP_CHILDREN_CAP)); return; }
        for (const e of entries) names.push(e.name);
        readBatch();
      }, () => resolve(names.slice(0, DROP_CHILDREN_CAP)));
    };
    readBatch();
  });
}
// Resolve a folder fingerprint → server search → drive the UI: unique hit (1 match, or top score ≥0.95) →
// confirm bar; multiple → chooser; zero → toast + highlight the top-bar picker.
async function resolveDroppedFolder(name, children) {
  let r;
  try { r = await api('/api/workspace/resolve', { method: 'POST', body: JSON.stringify({ name, children }) }); }
  catch (e) { toast(`定位文件夹失败：${apiErrText(e)}`, 'err'); return; }
  const matches = (r && Array.isArray(r.matches)) ? r.matches : [];
  if (!matches.length) {
    // v1.0.2 返修二:浏览器安全模型拿不到拖入文件夹的完整路径,指纹搜索对深层目录(如 Videos\…\子目录)
    // 天然无解 —— 失败时别只闪图标,直接把选择弹层(含粘贴路径输入)送到手边,兜底一步可达。
    toast(`未能自动定位「${name}」——拖拽无法还原深层路径。可直接粘贴完整路径。`, 'err');
    flashWorkspacePicker();
    pickWorkspace();
    return;
  }
  // Unique when there is exactly one match, or the top match is a near-certain fingerprint (score ≥0.95).
  if (matches.length === 1 || matches[0].score >= 0.95) {
    confirmWorkspaceSwitch(name, matches[0].path);
    return;
  }
  chooseWorkspaceMatch(name, matches);
}
// Briefly ring the top-bar picker so a zero-hit user knows where the fallback lives.
function flashWorkspacePicker() {
  const btn = $('workspacePicker'); if (!btn) return;
  btn.classList.add('wp-flash');
  setTimeout(() => btn.classList.remove('wp-flash'), 2400);
}
// Confirm bar「将工作目录切换到 <名>?」[切换][取消] + a secondary「设为默认工作区」. Uses buildModal (the
// dynamic-modal helper) — a lightweight, dismissible sheet. Default action = switch the current session cwd.
function confirmWorkspaceSwitch(name, dir) {
  const body = el('div', 'ws-confirm');
  body.appendChild(el('p', 'ws-confirm-q', `将工作目录切换到「${name}」？`));
  body.appendChild(el('code', 'ws-confirm-path', dir)); // textContent via el → XSS-safe
  const defWrap = el('label', 'ws-confirm-def');
  const defChk = el('input'); defChk.type = 'checkbox';
  defWrap.append(defChk, document.createTextNode(' 同时设为默认工作区'));
  body.appendChild(defWrap);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  const go = el('button', 'primary', '切换');
  foot.append(cancel, go);
  const modal = buildModal('切换工作文件夹', body, foot);
  cancel.onclick = () => modal.close();
  go.onclick = async () => { modal.close(); await setWorkspace(dir, { alsoDefault: defChk.checked }); };
}
// Multiple candidates → a chooser list (score-ranked, server already sorted DESC). Click one to switch.
function chooseWorkspaceMatch(name, matches) {
  const body = el('div', 'ws-confirm');
  body.appendChild(el('p', 'ws-confirm-q', `找到多个名为「${name}」的文件夹，请选择：`));
  const list = el('div', 'ws-match-list');
  for (const m of matches) {
    const item = el('button', 'ws-match-item');
    item.append(el('code', 'ws-match-path', m.path), el('span', 'ws-match-score', '匹配度 ' + Math.round(m.score * 100) + '%'));
    item.onclick = async () => { modal.close(); await setWorkspace(m.path); };
    list.appendChild(item);
  }
  body.appendChild(list);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  foot.append(cancel);
  const modal = buildModal('选择工作文件夹', body, foot);
  cancel.onclick = () => modal.close();
}
// The unified drop handler. Splits dropped items via webkitGetAsEntry: files → attachment flow (existing),
// directories → fingerprint → resolve. Mixed drops handle both, independently. Falls back to the plain
// file list when the entry API is unavailable (older/edge browsers).
async function handleDrop(e) {
  const items = e.dataTransfer && e.dataTransfer.items ? [...e.dataTransfer.items] : [];
  const getEntry = it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null);
  const entries = items.map(getEntry).filter(Boolean);
  if (!entries.length) {
    // No entry API → treat everything as files (legacy behavior).
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]);
    return;
  }
  const fileEntries = entries.filter(en => en.isFile);
  const dirEntries = entries.filter(en => en.isDirectory);
  // Files → attachments (read each entry's File object).
  if (fileEntries.length) {
    const files = await Promise.all(fileEntries.map(en => new Promise(res => en.file(res, () => res(null)))));
    uploadFiles(files.filter(Boolean));
  }
  // Directories → resolve each (usually one; multiple dropped dirs each get their own confirm).
  for (const dir of dirEntries) {
    const children = await readDirEntryChildren(dir);
    await resolveDroppedFolder(dir.name, children);
  }
}

/* ---------------- streaming turn ---------------- */
// One live stream per session. Switching sessions only changes which entry drives the composer; it never
// aborts another session's request. Streams for background sessions keep draining so the server connection
// stays alive, and their final persisted message appears when that session is opened again.
const activeTurns = new Map(); // sessionId -> { abort, startedAt, eventLines, eventChars, live, main }
const ACTIVE_TURN_EVENT_CAP = 2_000_000;
function createLiveAssistantShell() {
  const box = $('messages');
  const { row, main } = messageShell('assistant', new Date().toISOString(), currentEngineMeta());
  const live = { thinkingText: '', bufferText: '', thinkingEl: null, bubble: null, toolCards: new Map(), subCards: new Map(), workflowCards: new Map(), rendered: false, rafPending: false, rafId: 0 };
  live.bubble = el('div', 'bubble md stream-cursor');
  main.appendChild(live.bubble);
  live.toolsWrap = el('div'); main.appendChild(live.toolsWrap);
  box.appendChild(row); box.scrollTop = box.scrollHeight;
  return { live, main };
}
function rememberTurnLine(turn, line) {
  if (!turn || !line || !line.trim()) return;
  // raw_line is already available in the debug stream and can be extremely large; the visible
  // progress replay only needs normalized events.
  try { if (JSON.parse(line).type === 'raw_line') return; } catch { return; }
  turn.eventLines.push(line); turn.eventChars += line.length;
  while (turn.eventChars > ACTIVE_TURN_EVENT_CAP && turn.eventLines.length > 1) turn.eventChars -= turn.eventLines.shift().length;
}
function mountActiveTurn(sessionId) {
  const turn = activeTurns.get(sessionId);
  if (!turn || state.currentSession?.id !== sessionId) return;
  const shell = createLiveAssistantShell(); turn.live = shell.live; turn.main = shell.main;
  for (const line of turn.eventLines) {
    try { if (JSON.parse(line).type === 'session') continue; } catch { continue; }
    handleStreamLine(line, turn.live, turn.main, sessionId);
  }
  finalizeLive(turn.live);
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
function setStreaming(on) {
  state.streaming = on;
  // v3 (§B6): 有活动回合即让上下文电量表现身(不再等 60%,两模式一致);无用量数据时 renderContextMeter 自持隐藏。
  if (on) { try { updateContextMeter(); } catch { /* ignore */ } }
  // v0.9-S5: clear any lingering 「AI 在等你批准计划」 hint when a turn ends (stop/error can bypass the card's
  // own finish()). Set fresh by handlePlanEvent while a plan is pending.
  if (!on) { const h = $('composerHint'); if (h) h.textContent = ''; }
  // v1.0.2 (F3): Claude 模式的 /compact 是流式回合 —— 回合结束(setStreaming(false))即压缩完成,收指示条。
  if (!on && compactState.active) endCompactIndicator();
  const btn = $('sendBtn');
  if (btn) {
    btn.classList.toggle('danger', on);
    btn.classList.toggle('primary', !on);
    if (on) iconTextBtn(btn, 'stop', '停止'); else iconTextBtn(btn, 'send', '发送'); // v3 (§C6/§2.15): 运行态换停止图标(danger 弱化描边),完成还原发送
    btn.onclick = on ? stopTurn : () => sendPrompt();
  }
  updateJumpLatest();
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
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '⏳ 压缩中…'; }
  // 持续指示条:插在 composer 顶部(resumeBanner 之上),复用 chip/toast 令牌,自带 spinner。
  let bar = $('compactIndicator');
  if (!bar) {
    bar = el('div', 'compact-indicator'); bar.id = 'compactIndicator';
    bar.append(el('span', 'compact-spinner'), el('span', '', '正在压缩上下文——这可能需要十几秒'));
    const composer = document.querySelector('.composer');
    if (composer) composer.insertBefore(bar, composer.firstChild);
  }
  bar.classList.remove('hidden');
  // 90s 兜底:即便完成路径没触发(异常/流未正常收束),也恢复按钮与指示条。
  clearTimeout(compactState.timer);
  compactState.timer = setTimeout(() => { if (compactState.active) { endCompactIndicator(); toast('压缩似乎超时,已恢复。可重试。', 'err'); } }, 90000);
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
  if (state.streaming) { toast('请等当前回合结束再压缩', ''); return; }
  if (!state.currentSession || !(state.currentSession.messages || []).length) { toast('还没有可压缩的对话', ''); return; }
  if (!isProviderMode()) {
    // Claude 模式:/compact 是流式回合。开指示,sendPrompt 走完流后 setStreaming(false) 会调 endCompactIndicator。
    beginCompactIndicator();
    toast('已请求压缩上下文（/compact）', 'ok');
    sendPrompt('/compact');
    return;
  }
  const sid = state.currentSession.id;
  beginCompactIndicator();
  try {
    const r = await api('/api/provider/compact', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
    if (!r || !r.ok) { toast(`压缩失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
    if (state.currentSession?.id === sid) { const s = await api(`/api/sessions/${sid}`); state.currentSession = s.session; renderCurrentSession(); }
    await refreshSessions();
    toast(`已压缩上下文：${fmtTokens(r.beforeTokens || 0)}→约 ${fmtTokens(r.afterTokens || 0)}（估算）`, 'ok');
  } catch (e) { toast(`压缩失败：${apiErrText(e)}`, 'err'); }
  finally { endCompactIndicator(); }
}

async function sendPrompt(overrideText) {
  // v0.8-S7 steering (§4 A3): while a PROVIDER turn streams, the composer is no longer inert — a send
  // becomes an interjection routed to /api/steer (enqueued + injected at the next tool-loop boundary).
  // The Claude engine keeps the old behavior (composer ignored mid-stream: its tools run in a transient
  // MCP child, out of this slice).
  const selectedId = state.currentSession?.id || '';
  if (selectedId && activeTurns.has(selectedId)) { if (isProviderMode()) return steerPrompt(overrideText); return; }
  const message = (overrideText != null ? overrideText : $('promptInput').value).trim();
  if (!message) return;
  if (!state.currentSession) await newSession();

  const turnSessionId = state.currentSession.id;
  if (overrideText == null) { $('promptInput').value = ''; autoGrow($('promptInput')); }
  try { localStorage.removeItem('wcw.draft'); } catch { /* ignore */ }

  const box = $('messages');
  box.querySelector('.empty-state')?.remove();
  // Capture & clear attachments now so a failed/aborted turn doesn't silently re-send them.
  const sentAttachments = state.attachments;
  state.attachments = []; renderAttachments();
  box.appendChild(renderStaticMessage({ role: 'user', content: message, createdAt: new Date().toISOString(), attachments: sentAttachments }));

  // Live assistant container — tag it with the current engine so its badge/avatar match the engine
  // producing this reply (the server sends the authoritative meta on the persisted message).
  const shell = createLiveAssistantShell();
  let live = shell.live, main = shell.main;

  const turnAbort = new AbortController();
  const turnState = { abort: turnAbort, startedAt: Date.now(), eventLines: [], eventChars: 0, live, main };
  activeTurns.set(turnSessionId, turnState);
  syncStreamingUi();
  renderSessions();
  try {
    const res = await fetch('/api/chat/stream', {
      method: 'POST', headers: authHeaders(), signal: turnAbort.signal,
      body: JSON.stringify({ sessionId: turnSessionId, message, cwd: currentWorkspace(), attachments: sentAttachments }),
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
        if (state.currentSession?.id === turnSessionId) {
          live = turnState.live; main = turnState.main;
          handleStreamLine(line, live, main, turnSessionId);
        }
      }
    }
    if (buf.trim()) {
      rememberTurnLine(turnState, buf);
      if (state.currentSession?.id === turnSessionId) handleStreamLine(buf, turnState.live, turnState.main, turnSessionId);
    }
    finalizeLive(turnState.live);
    await refreshSessions();
    if (state.currentSession?.id === turnSessionId) {
      const r = await api(`/api/sessions/${turnSessionId}`);
      state.currentSession = r.session; state.resumable = r.resumable || null;
      renderCurrentSession(); renderResumeBanner();
    }
  } catch (err) {
    // C6: aborts read as a neutral note (.msg-note), real failures as a red .msg-error block — not
    // stuffed into the markdown buffer. finalizeLive still renders whatever text streamed before this.
    if (err.name === 'AbortError') { appendMsgNote(main, live, '已停止'); toast('已停止当前回合'); }
    else { appendMsgError(main, live, apiErrText(err)); toast(`出错：${apiErrText(err)}`, 'err'); }
    finalizeLive(live);
  } finally {
    activeTurns.delete(turnSessionId);
    syncStreamingUi();
    renderSessions();
  }
}

// v0.8-S7 steering (§4 A3). Called when the composer sends WHILE a provider turn streams. POSTs the text
// to /api/steer (enqueues it on the live turn); on success clears the input, toasts, and optimistically
// renders the user's interjection in the message flow with a muted 「插话」 badge. The server also emits a
// `steered` event when it actually injects the text at the next boundary — steeredSeen dedups that echo
// against this optimistic render (by text within a short time window).
const steeredSeen = []; // [{text, ts}] recently rendered locally, for `steered`-event dedup
async function steerPrompt(overrideText) {
  const text = (overrideText != null ? overrideText : $('promptInput').value).trim();
  if (!text) return;
  if (!state.currentSession?.id) return;
  try {
    const r = await api('/api/steer', { method: 'POST', body: JSON.stringify({ sessionId: state.currentSession.id, text }) });
    if (!r || !r.ok) { toast(`插话失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
    if (overrideText == null) { $('promptInput').value = ''; autoGrow($('promptInput')); }
    steeredSeen.push({ text, ts: Date.now() });
    renderSteeredMessage(text);
    toast('已插话，下一步生效', 'ok');
  } catch (e) { toast(`插话失败：${apiErrText(e)}`, 'err'); }
}

// Render a user interjection row with a muted 「插话」 badge. Used by steerPrompt (optimistic) and by the
// `steered` stream event (when the UI didn't already show it locally — e.g. a steer from another tab).
function renderSteeredMessage(text) {
  const box = $('messages');
  box.querySelector('.empty-state')?.remove();
  const row = renderStaticMessage({ role: 'user', content: text, createdAt: new Date().toISOString() });
  const badge = el('span', 'steered-badge', '插话');
  const bubble = row.querySelector('.bubble');
  if (bubble && bubble.parentNode) bubble.parentNode.insertBefore(badge, bubble);
  box.appendChild(row);
  scrollMessagesToBottom();
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
    live.bubble.innerHTML = renderMarkdown(live.bufferText);
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (atBottom) box.scrollTop = box.scrollHeight;
    updateJumpLatest();
  });
}
function finalizeLive(live) {
  // Cancel any queued render so it can't overwrite the final highlighted markdown.
  if (live.rafId) { cancelAnimationFrame(live.rafId); live.rafId = 0; }
  live.rafPending = false;
  live.bubble.classList.remove('stream-cursor');
  // C2: whatever happened, the thinking panel ends on its settled "思考过程 · N 字" label (no shimmer).
  if (live.thinkingPanelObj) live.thinkingPanelObj.setLive(false);
  // If nothing streamed but an error/note block was shown, drop the empty bubble instead of the
  // "（无文本输出）" placeholder (the block already tells the story). Otherwise render the buffer.
  if (!live.bufferText && (live.errorShown || live.noteShown)) { live.bubble.remove(); return; }
  live.bubble.innerHTML = renderMarkdown(live.bufferText || '（无文本输出）');
  highlightIn(live.bubble);
  // v1.0.2 (G4): turn end — fold the last completed top-level card(s) into the group (if one formed).
  foldToolGroupAtTurnEnd(live);
}
// C6: insert an independent .msg-error block (red) into the live container. Text via textContent so
// it is never markdown-parsed. Placed after the tools wrap so it reads as the turn's terminal state.
function appendMsgError(main, live, text) {
  const box = el('div', 'msg-error'); box.textContent = text;
  main.appendChild(box);
  if (live) live.errorShown = true;
  scrollMessagesToBottom();
}
// C6: a neutral, muted variant for benign notes ("已停止"). Same structure, no alarm coloring.
function appendMsgNote(main, live, text) {
  const box = el('div', 'msg-note'); box.textContent = text;
  main.appendChild(box);
  if (live) live.noteShown = true;
  scrollMessagesToBottom();
}

/* ---------------- ↓ 回到最新 (§4.4) ---------------- */
// A round floating button over the messages area. Visible only while streaming AND the user has
// scrolled up (not near the bottom); clicking snaps to the newest content. Auto-hides at the bottom
// or when the turn ends. The scroll listener (bound once in bindEvents) recomputes on every scroll.
function messagesAtBottom() {
  const box = $('messages');
  if (!box) return true;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
function updateJumpLatest() {
  const btn = $('jumpLatest');
  if (!btn) return;
  const show = state.streaming && !messagesAtBottom();
  btn.classList.toggle('hidden', !show);
}
function scrollMessagesToBottom() {
  const box = $('messages');
  if (box) box.scrollTop = box.scrollHeight;
  updateJumpLatest();
}

function handleStreamLine(line, live, main, streamSessionId) {
  if (!line.trim()) return;
  let evt;
  try { evt = JSON.parse(line); } catch { return; }
  switch (evt.type) {
    case 'session':
      if (evt.session && state.currentSession?.id === streamSessionId) { state.currentSession = evt.session; renderSessions(); }
      break;
    case 'raw_line':
      pushRawEvent(evt.seq, evt.line);
      break;
    case 'meta': {
      // Engine-aware prefix: provider turns show the provider label, claude turns show 'claude'.
      const engTag = evt.engine === 'openai' ? (evt.providerLabel || 'provider') : 'claude';
      appendToolOutput(`[${engTag}] ${evt.command} ${(evt.args || []).join(' ')}\ncwd=${evt.cwd}\n模型=${evt.model} 权限=${evt.permissionMode}`);
      // v0.8-S0 cwd guardrail: warn once per turn when the working dir is the user's home/Desktop/
      // Documents/Downloads root (acting on everything the user owns is the highest-risk misfire).
      if (evt.cwdWarning && live && !live.cwdWarned) {
        live.cwdWarned = true;
        toast('⚠ 当前工作目录是用户主目录，建议为任务选择具体文件夹', 'err');
      }
      break;
    }
    case 'process':
      setProc(evt.state);
      break;
    case 'assistant_delta':
      // First real text delta (C2): auto-collapse the thinking panel + settle its summary to
      // "思考过程 · N 字" — UNLESS the user already toggled it open by hand (respect their choice).
      if (evt.text && !live.firstDeltaSeen) {
        live.firstDeltaSeen = true;
        if (live.thinkingPanelObj && !live.userToggledThinking) {
          live.thinkingPanelObj.d.open = false;
          live.thinkingPanelObj.setLive(false);
        } else if (live.thinkingPanelObj) {
          live.thinkingPanelObj.setLive(false); // keep it open, but stop the shimmer + label it
        }
      }
      live.bufferText += evt.text || '';
      scheduleRender(live);
      break;
    case 'thinking_delta':
      if (!live.thinkingEl) {
        const tp = thinkingPanel('', true); // live shimmer summary "思考中…"
        live.thinkingEl = tp.body; live.thinkingPanelObj = tp;
        // Record a manual toggle so the first-delta auto-collapse can defer to the user (C2).
        tp.summary.addEventListener('click', () => { live.userToggledThinking = true; });
        main.insertBefore(tp.d, live.bubble); tp.d.open = true;
      }
      live.thinkingText += evt.text || '';
      live.thinkingEl.textContent = live.thinkingText;
      break;
    case 'subagent':
      // v0.9-S6 (子代理): a delegated sub-turn started/ended. `start` opens a nested collapsed card that will
      // hold the sub-turn's own tool_use/tool_result (routed here by subagentId). `end` stamps the head with
      // ✓/✗ + a short conclusion summary. See handleSubagentEvent.
      handleSubagentEvent(evt, live);
      break;
    case 'subagent_progress':
      // v1.4.6 (C): a tool-less Claude sub-turn reporting streamed-text growth. Refresh its card head so the
      // live chat view shows "生成中 · N 字" instead of a silent stall until the ✓/✗ (routed by subagentId).
      handleSubagentEvent(evt, live);
      break;
    case 'agent_workflow':
      handleAgentWorkflowEvent(evt, live);
      break;
    case 'tool_use': {
      const card = toolCard({ name: evt.name, input: evt.input });
      card.t0 = performance.now(); // start the clock; tool_result computes the elapsed seconds
      live.toolCards.set(evt.id, card);
      // v0.9-S6: a sub-turn's tool_use carries subagentId → nest it inside that sub-agent's card body (indented,
      // via toolCard reuse). No subagentId → the normal top-level tools wrap.
      const subHost = evt.subagentId && live.subCards.get(evt.subagentId);
      if (subHost) {
        subHost.body.appendChild(card.d);
      } else {
        live.toolsWrap.appendChild(card.d);
        // v1.0.2 (G4): register this top-level card; the 4th one forms the fold group.
        registerTopToolCard(live, evt.id, card.d);
      }
      break;
    }
    case 'tool_result': {
      const card = live.toolCards.get(evt.id);
      if (card) {
        card.resPre.textContent = safeStringify(evt.content);
        // v1.0-S4: if this was git_diff, paint the colorized diff view now that the result is in.
        if (!evt.isError) renderGitDiffInto(card.diffHost, card.name, evt.content);
        card.status.textContent = evt.isError ? '出错' : '完成';
        card.status.classList.remove('ok', 'err'); card.status.classList.add(evt.isError ? 'err' : 'ok');
        // Status bar: running → ok/err.
        if (card.statusbar) { card.statusbar.classList.remove('running', 'ok', 'err'); card.statusbar.classList.add(evt.isError ? 'err' : 'ok'); }
        // Duration: performance.now() delta since tool_use, shown as "· 1.2s".
        if (card.dur && card.t0 != null) card.dur.textContent = `· ${((performance.now() - card.t0) / 1000).toFixed(1)}s`;
        if (evt.isError) card.d.open = true; // surface failures automatically
        // v1.0.2 (G4): this top-level card is now complete → fold it into the group (if formed).
        markTopToolDone(live, evt.id);
      }
      break;
    }
    case 'todo':
      // v0.8-S3: live task-list update → refresh the step-bar and cache on the current session so a later
      // static re-render (session reload) keeps showing it.
      if (state.currentSession) state.currentSession.todos = evt.items || [];
      renderStepBar(evt.items || []);
      break;
    case 'steered': {
      // v0.8-S7: the server injected a steering interjection at a boundary. If this UI already rendered it
      // optimistically (steerPrompt pushed steeredSeen), dedup within a short window; else render it now.
      const now = Date.now();
      const idx = steeredSeen.findIndex(s => s.text === evt.text && now - s.ts < 15000);
      if (idx >= 0) { steeredSeen.splice(idx, 1); break; } // already shown locally → drop the echo
      renderSteeredMessage(evt.text || '');
      break;
    }
    case 'turn_summary':
      // v0.8-S3: render the 「本轮变更」card at the tail of the live assistant message. finalizeLive keeps
      // the streamed markdown bubble intact; this card sits after the tools wrap.
      main.appendChild(turnSummaryCard(evt));
      { const chips = turnArtifactChips(evt); if (chips) main.appendChild(chips); } // v1.0.2 (G2)
      // v0.9-S1 (C6): remember whether anything actually changed, so a following error `result` can decide
      // whether to append the 「本次未改动任何文件」 reassurance line.
      if (live) live.filesTouched = (Array.isArray(evt.filesChanged) && evt.filesChanged.length > 0) || (Number(evt.commands) || 0) > 0;
      scrollMessagesToBottom();
      break;
    case 'result':
      // v0.9-S1 (C6): error human-card. On a failed turn (or any turn carrying an errorClass) render a plain-
      // language card with the zh copy + one 「下一步」 action (from ERROR_CLASSES). A clean turn has no
      // errorClass and ok:true → nothing renders. noFilesChanged reassurance shows only when the turn_summary
      // was empty (live.filesTouched is falsy) — a failure that touched nothing shouldn't leave the user guessing.
      if (evt.errorClass || evt.ok === false) {
        // v1.0.2 (F6c): CLI 缺失 → 友好引导卡(向后兼容:无 code 字段走原 errorCard)。
        const noFiles = !(live && live.filesTouched);
        main.appendChild(evt.code === 'cli-missing' ? cliMissingCard() : errorCard(evt.errorClass, evt.error, noFiles));
        scrollMessagesToBottom();
      }
      break;
    case 'usage':
      main.appendChild(usageLine(evt));
      renderContextMeter(evt);
      break;
    case 'stderr':
      appendToolOutput(`[stderr] ${evt.text}`, true);
      break;
    case 'ask_user':
      showAskUserModal(evt.id, evt.questions);
      break;
    case 'permission_request':
      handlePermissionRequest(evt);
      break;
    case 'plan':
      // v0.9-S5 (真流程 plan mode): the model proposed an execution plan and the turn is paused. Render an
      // in-flow plan card (assistant-bubble variant) with the plan markdown + 批准执行 / 修改意见 / 放弃; the
      // decision POSTs to /api/plan/decision and the turn resumes (or ends). Composer hints while pending.
      handlePlanEvent(evt, main, live);
      break;
    case 'plan_note':
      // The user attached a note when approving (修改意见). Show it as a muted interjection so the flow reads.
      if (evt.text) appendMsgNote(main, live, `已按你的补充意见继续：${evt.text}`);
      break;
    case 'failover':
      // v1.0-S6 (B4): the provider's primary endpoint failed pre-first-byte and the turn switched to a backup.
      // Surface a warn-level toast so the user knows the request is now going elsewhere. The raw event is also
      // visible in the 调试 (debug) 原始事件流 automatically — no extra work needed there.
      toast(`已切换到备用端点 ${evt.to || ''}`, 'warn');
      break;
    case 'error':
      // v1.0.2 (F6c): CLI 缺失 → 友好引导卡(向后兼容:无 code 字段走原始 .msg-error 文本块)。
      if (evt.code === 'cli-missing') { main.appendChild(cliMissingCard()); if (live) live.errorShown = true; scrollMessagesToBottom(); break; }
      // C6: a real .msg-error block (red tint + left bar), text via textContent — never folded into the
      // markdown buffer where it would render as bold prose and could be mis-parsed.
      appendMsgError(main, live, String(evt.error ?? ''));
      break;
    default: break;
  }
}

/* ---------------- interactive: AskUserQuestion + permission modals ---------------- */
// Dynamic modals are tagged 'dynamic' and carry a __cancel hook so Escape/✕/backdrop resolve the
// held server request (deny/cancel) instead of leaving the CLI child hanging.
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
  const x = el('button', 'icon-btn'); x.appendChild(icon('close', 16)); x.setAttribute('aria-label', '关闭'); x.onclick = () => finish(true);
  head.append(x);
  const body = el('div', 'modal-body'); body.appendChild(bodyEl);
  const foot = el('div', 'modal-foot'); if (footEl) foot.appendChild(footEl);
  modal.append(head, body, foot);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(true); });
  backdrop.appendChild(modal);
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

function showAskUserModal(toolUseId, questions) {
  const sid = state.currentSession?.id; // pin the session the question belongs to
  // v1.0.2 (F4②): 同屏只留一个 ask modal —— 新提问到达时先把旧的关掉(走其 __cancel 空答,不让旧回合卡死)。
  document.querySelectorAll('.modal-backdrop.ask-modal').forEach(b => { if (b.__cancel) b.__cancel(); else b.remove(); });
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
      const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = '输入回答';
      block.appendChild(inp); controls.push({ qi, multi: false, input: inp, free: true });
    }
    body.appendChild(block);
  });
  const submit = el('button', 'primary', '提交');
  // Fire-and-forget answer (used only by the cancel path — Esc/✕/backdrop). Cancelling still answers (empty)
  // so the turn doesn't hang waiting for a tool_result. F4④:已实证现有关闭路径确实空答放行,不会丢弃挂起。
  const postAnswer = content => {
    if (!sid) { toast('会话已结束，无法回答', 'err'); return; }
    api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, toolUseId, content }) }).catch(e => toast(apiErrText(e), 'err'));
  };
  const modal = buildModal(`模型提问 · ${engineLabel()}`, body, submit, () => postAnswer('(用户取消，未选择)'));
  // F4②:标记为 ask modal,供下一条提问到达时精确关旧的。
  modal.backdrop.classList.add('ask-modal');
  // F4①:提交按钮点击后禁用 + 「发送中…」,await POST 回来再 close;失败则 toast + 恢复按钮(不 close,让用户重试)。
  submit.onclick = async () => {
    if (submit.disabled) return;
    if (!sid) { toast('会话已结束，无法回答', 'err'); modal.close(); return; }
    const answers = list.map((q, qi) => {
      const mine = controls.filter(c => c.qi === qi);
      const picked = mine.filter(c => c.free ? c.input.value.trim() : c.input.checked)
        .map(c => c.free ? c.input.value.trim() : c.label);
      return { question: (q && (q.question || q.header)) || `q${qi}`, answer: picked };
    });
    const content = answers.map(a => `${a.question}: ${a.answer.join(', ')}`).join('\n');
    const prevLabel = submit.textContent;
    submit.disabled = true; submit.textContent = '发送中…';
    try {
      await api('/api/chat/answer', { method: 'POST', body: JSON.stringify({ sessionId: sid, toolUseId, content }) });
      modal.close();
    } catch (e) {
      toast(`回答发送失败：${apiErrText(e)}`, 'err');
      submit.disabled = false; submit.textContent = prevLabel;
    }
  };
}

// v0.8-S4b B3: plain-language tool-name map (人话化). ai_computer_control__ prefixed bridged tools →
// 「桌面操作：<去前缀名>」. shell_* → 终端操作. Unknown → the raw name.
const TOOL_VERB_MAP = {
  file_edit: '修改文件', file_write: '写入文件', file_delete: '删除文件',
  // v1.1-W2 (T1) 新内建工具 —— 人话动词
  file_move: '移动文件', file_copy: '复制文件', archive_zip: '压缩打包', archive_unzip: '解压缩', http_download: '下载文件',
  powershell_run: '执行命令', script_run: '执行命令',
  desktop_screenshot: '屏幕截图', keyboard_send_keys: '模拟按键', http_request: '网络请求',
  // v1.0-S4 git 工具族 —— 人话动词
  git_status: '查看版本状态', git_diff: '查看改动', git_log: '查看历史', git_commit: '保存版本',
};
function humanizeToolName(name) {
  const n = String(name || '');
  if (!n) return '未知操作';
  if (TOOL_VERB_MAP[n]) return TOOL_VERB_MAP[n];
  if (n.startsWith('shell_')) return '终端操作';
  if (n.startsWith('ai_computer_control__')) return `桌面操作：${n.slice('ai_computer_control__'.length)}`;
  return n;
}
// Tier badge visuals — read 绿 / edit 黄 / exec 红. Kept here so the popup needn't re-derive tier from the
// tool name; the server sends `tier` on the permission_request event.
const TIER_META = {
  read: { label: '只读', cls: 'read' },
  edit: { label: '可编辑', cls: 'edit' },
  exec: { label: '执行', cls: 'exec' },
};

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
  const revertible = evt.revertible === true;
  // Session-scoped auto-allow: skip the popup entirely for a tool the user already blessed this session.
  if (sessionAllowHas(sid, tool)) { decide(evt.requestId, 'allow'); return; }

  const body = el('div');
  // Humanized title + raw tool name (mono, secondary) so power users still see exactly what runs.
  body.appendChild(el('p', '', `${engineLabel()} 想执行：`));
  const titleRow = el('div', 'perm-title-row');
  titleRow.append(el('span', 'perm-verb', humanizeToolName(tool)));
  const badge = el('span', `perm-tier ${TIER_META[tier].cls}`);
  badge.append(el('span', 'perm-tier-dot'), el('span', '', TIER_META[tier].label));
  titleRow.append(badge);
  body.append(titleRow);
  body.appendChild(el('div', 's-title perm-rawname', tool));
  // Revertibility line — the decision-moment trust signal (B3). Uses the event's `revertible` field
  // (server truth); the front-end does NOT re-implement the tier→revertible table.
  const revLine = el('div', `perm-revert ${revertible ? 'yes' : 'no'}`,
    revertible ? '✓ 此操作可一键撤销' : '⚠ 此操作无法自动撤销,请确认');
  body.append(revLine);
  const pre = el('pre'); pre.style.cssText = 'background:var(--code-bg);border-radius:6px;padding:8px;max-height:200px;overflow:auto;font-family:var(--mono);font-size:var(--fs-sm)';
  pre.textContent = (() => { try { return JSON.stringify(evt.input, null, 2); } catch { return String(evt.input); } })();
  body.appendChild(pre);
  // "本次会话自动允许" — session-scoped, always available. A secondary "永久" box appears only for
  // read/edit tier (never exec/desktop) → persists into config.toolAllowRules.
  const sessWrap = el('label', 'check');
  const sessBox = document.createElement('input'); sessBox.type = 'checkbox';
  sessWrap.append(sessBox, document.createTextNode(' 本次会话自动允许'));
  body.appendChild(sessWrap);
  let permBox = null;
  if (tier === 'read' || tier === 'edit') {
    const permWrap = el('label', 'check perm-persist');
    permBox = document.createElement('input'); permBox.type = 'checkbox';
    permWrap.append(permBox, document.createTextNode(' 永久允许(记入配置)'));
    body.appendChild(permWrap);
    // Ticking 永久 implies the session box (superset); keep them consistent.
    permBox.addEventListener('change', () => { if (permBox.checked) sessBox.checked = true; });
  }

  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const deny = el('button', 'danger', '拒绝');
  const allow = el('button', 'primary', '允许');
  foot.append(deny, allow);
  // Cancel (Escape/✕/backdrop) denies, so the held bridge request is released immediately.
  const modal = buildModal(`工具权限请求 · ${engineLabel()}`, body, foot, () => decide(evt.requestId, 'deny', { message: '用户取消' }));
  deny.onclick = () => { decide(evt.requestId, 'deny', { message: '用户拒绝' }); modal.close(); };
  allow.onclick = () => {
    if (sessBox.checked) sessionAllowAdd(sid, tool);
    if (permBox && permBox.checked) {
      // Persist a read/edit allow rule. normalizeConfig will drop it server-side if the tier disqualifies
      // it, so this is safe even if the tier badge and the server disagree.
      const rules = { ...(state.config.toolAllowRules || {}), [tool]: 'allow' };
      saveConfigPartial({ toolAllowRules: rules });
      toast(`已永久允许「${humanizeToolName(tool)}」`, 'ok');
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
    .catch(e => { toast(`计划决策失败：${apiErrText(e)}`, 'err'); return null; });
}
// v0.9-S6 (子代理): render/close the nested sub-agent card. `start` opens a collapsed <details> with an accent
// left bar and a 「🤖 子任务：<task 前 40 字>」head; its `body` hosts the sub-turn's nested tool cards (routed by
// subagentId in the tool_use/tool_result handlers). `end` stamps the head with ✓/✗ + a short conclusion note.
// The card lives in live.toolsWrap so it sits with the turn's other tool activity, and is tracked in
// live.subCards keyed by the subagentId so tool events find their host.
function handleAgentWorkflowEvent(evt, live) {
  const id = evt.id || '';
  if (evt.state === 'start') {
    const d = el('details', 'subagent-card'); d.open = true;
    const sum = el('summary', 'subagent-head');
    sum.append(el('span', 'sa-icon', '🕸️'), el('span', 'sa-title', `Agent 工作流 · ${evt.nodeCount || 0} 个节点`), el('span', 'sa-status', `运行中 · 并发 ${evt.concurrency || 1}`));
    d.appendChild(sum); const body = el('div', 'subagent-body', '依赖图已持久化，节点将按依赖自动解锁。'); d.appendChild(body);
    live.toolsWrap.appendChild(d);
    live.workflowCards.set(id, { d, status: sum.querySelector('.sa-status'), done: 0, total: Number(evt.nodeCount) || 0 });
    return;
  }
  const host = live.workflowCards.get(id); if (!host) return;
  if (evt.state === 'node_retry') {
    host.status.textContent = `${evt.nodeId || ''} 自动重试 ${evt.attempt || 0}/${evt.maxRetries || 0}`;
  } else if (evt.state === 'node_loop') {
    host.status.textContent = `${evt.nodeId || ''} 循环 ${evt.iteration || 0}/${evt.maxIterations || 0} · 无进展 ${evt.noProgressCount || 0}`;
  } else if (evt.state === 'node_end') {
    host.done += 1;
    host.status.textContent = `${host.done}/${host.total} 完成 · ${evt.nodeId || ''} ${evt.status || ''}`;
  } else if (evt.state === 'end') {
    const ok = evt.status === 'succeeded';
    host.d.classList.add(ok ? 'sa-ok' : 'sa-err');
    host.status.textContent = `${ok ? '✓ 完成' : '⚠ ' + (evt.status || '结束')} · 成功 ${evt.succeeded || 0} / 失败 ${evt.failed || 0}`;
    host.status.classList.add(ok ? 'ok' : 'err');
    if (ok) host.d.open = false;
  }
}

let agentWorkflowLibrary = [];
function cloneWorkflow(value) { return JSON.parse(JSON.stringify(value || {})); }
async function loadAgentWorkflows() {
  try { const r = await api(`/api/agent-workflows?cwd=${encodeURIComponent(currentWorkspace())}`); agentWorkflowLibrary = r.workflows || []; }
  catch { agentWorkflowLibrary = []; }
  const select = $('workflowQuickSelect'); if (!select) return;
  const previous = select.value; select.textContent = '';
  for (const wf of agentWorkflowLibrary) { const o = document.createElement('option'); o.value = wf.id; o.textContent = `${wf.source === 'builtin' ? '内置' : wf.source === 'project' ? '项目' : '个人'} · ${wf.title}`; select.appendChild(o); }
  if (agentWorkflowLibrary.some(x => x.id === previous)) select.value = previous;
}
async function launchAgentWorkflow(workflow, context) {
  if (!state.currentSession?.id) await newSession();
  const wf = workflow || agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value); if (!wf) return toast('请选择工作流', 'err');
  try {
    const body = { token: wcwToken(), sessionId: state.currentSession.id, nodes: wf.nodes, workflowId: wf.id, async: true };
    if (context && context.trim()) body.context = context.trim();
    const r = await api('/api/agent-workflow/launch', { method: 'POST', body: JSON.stringify(body) });
    if (!r || (!r.ok && !r.runId)) throw new Error(r && r.error || '启动失败');
    toast(`工作流已启动：${wf.title}`, 'ok'); switchTab('agent-runs'); await loadAgentRuns();
  } catch (e) { toast(`工作流启动失败：${apiErrText(e)}`, 'err'); }
}
// Quick "运行模板" launch, from the dropdown in the Agent 工作流 tab. Unlike the graphical editor's own
// "保存并运行" (where the user has already written real per-node task text), a quick-select template's
// node tasks are generic placeholders with no actual subject — clicking straight through ran it blind
// with no relevant task context. Ask for one line of context first; it's prepended to every node's task.
function launchAgentWorkflowFromQuickSelect() {
  const wf = agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value);
  if (!wf) return toast('请选择工作流', 'err');
  const body = el('div');
  body.append(el('p', 'muted', `即将运行「${wf.title}」。补充这次运行的具体任务/主题，工作流的每个节点都会基于它展开（留空则按模板原文运行，多数情况下没有实际意义）。`));
  const ctx = document.createElement('textarea'); ctx.rows = 4; ctx.placeholder = '例如：评估是否要把订单服务从单体拆成微服务';
  body.appendChild(workflowField('任务背景', ctx));
  const foot = el('div', 'modal-actions');
  const cancel = el('button', '', '取消'); const run = el('button', 'primary', '运行');
  foot.append(cancel, run);
  const modal = buildModal(`运行模板：${wf.title}`, body, foot);
  cancel.onclick = () => modal.close();
  run.onclick = async () => { const context = ctx.value; modal.close(); await launchAgentWorkflow(wf, context); };
}
function workflowBlank() { return { id: `workflow-${Date.now().toString(36)}`, title: '新工作流', description: '', source: 'personal', nodes: [{ id: 'step_1', task: '描述这个节点要完成的任务', role: 'worker', dependsOn: [], failurePolicy: 'block', position: { x: 40, y: 120 } }] }; }
function workflowField(label, input) { const wrap = el('label', 'workflow-field'); wrap.append(el('span', '', label), input); return wrap; }
function workflowConditionText(value) { return value ? `${value.node ? value.node + '.' : ''}${value.path || ''} ${value.operator || 'truthy'}${value.value === undefined ? '' : ' ' + JSON.stringify(value.value)}` : ''; }
function parseWorkflowConditionText(text) {
  const match = String(text || '').trim().match(/^([A-Za-z0-9_-]+)\.([^ ]+)\s+(equals|not_equals|truthy|falsy|contains|greater|greater_equal|less|less_equal|status_is|==|!=|>=|<=|>|<)(?:\s+(.+))?$/);
  if (!match) return null;
  const aliases = { '==': 'equals', '!=': 'not_equals', '>': 'greater', '>=': 'greater_equal', '<': 'less', '<=': 'less_equal' };
  let value; if (match[4]) { try { value = JSON.parse(match[4]); } catch { value = match[4]; } }
  return { node: match[1], path: match[2], operator: aliases[match[3]] || match[3], value };
}
async function openWorkflowEditor(initialId) {
  await loadAgentWorkflows();
  let draft = initialId === '__blank' ? workflowBlank() : cloneWorkflow(agentWorkflowLibrary.find(x => x.id === initialId) || agentWorkflowLibrary.find(x => x.id === $('workflowQuickSelect')?.value) || workflowBlank());
  draft.source = draft.source === 'project' ? 'project' : 'personal'; let selectedId = draft.nodes[0] && draft.nodes[0].id;
  let connectFromId = '';
  let selectedEdge = null;
  let commitSelectedNode = null;
  let roles = []; try { roles = (await api(`/api/agent-roles?cwd=${encodeURIComponent(currentWorkspace())}`)).roles || []; } catch {}
  const body = el('div', 'workflow-editor');
  const meta = el('div', 'workflow-meta'); const idInput = document.createElement('input'); idInput.value = draft.id; const titleInput = document.createElement('input'); titleInput.value = draft.title; const descInput = document.createElement('input'); descInput.value = draft.description || '';
  const scopeSelect = document.createElement('select'); for (const [v,t] of [['personal','个人'],['project','项目']]) { const o=document.createElement('option');o.value=v;o.textContent=t;scopeSelect.appendChild(o); } scopeSelect.value=draft.source;
  meta.append(workflowField('ID', idInput), workflowField('名称', titleInput), workflowField('说明', descInput), workflowField('保存范围', scopeSelect)); body.appendChild(meta);
  const toolbar = el('div', 'workflow-editor-toolbar'); const templateSelect = document.createElement('select'); for (const wf of agentWorkflowLibrary) { const o=document.createElement('option');o.value=wf.id;o.textContent=`载入：${wf.source === 'builtin' ? '内置' : wf.source === 'project' ? '项目' : '个人'} · ${wf.title}`;templateSelect.appendChild(o); } templateSelect.value=draft.id;
  const nodeSelect = document.createElement('select'); nodeSelect.title = '快速选择节点';
  const loadBtn=el('button','mini workflow-btn','编辑所选模板'), blankBtn=el('button','mini workflow-btn','新建空白'), addBtn=el('button','mini workflow-btn','＋ 节点'), connectBtn=el('button','mini workflow-btn','连接箭头'), edgeDeleteBtn=el('button','mini danger workflow-btn','删除箭头'), deleteBtn=el('button','mini danger workflow-btn','删除节点'); toolbar.append(templateSelect,loadBtn,blankBtn,nodeSelect,addBtn,connectBtn,edgeDeleteBtn,deleteBtn); body.appendChild(toolbar);
  const layout=el('div','workflow-editor-layout'), graph=el('div','workflow-graph'), inspector=el('div','workflow-inspector'); layout.append(graph,inspector); body.appendChild(layout);
  const foot=el('div','modal-actions workflow-editor-foot'), footLeft=el('div','workflow-editor-foot-left'), footRight=el('div','workflow-editor-foot-right'), forkBtn=el('button','mini workflow-btn save-as','另存为新模板'), cancel=el('button','','取消'), remove=el('button','danger','删除保存'), save=el('button','primary','保存'), run=el('button','primary','保存并运行'); footLeft.append(forkBtn,remove); footRight.append(cancel,save,run); foot.append(footLeft,footRight); const modal=buildModal('工作流图形编辑器',body,foot); const modalEl=modal.backdrop.querySelector('.modal'); modalEl?.classList.add('workflow-modal'); const maxBtn=el('button','workflow-window-btn','□'); maxBtn.type='button'; maxBtn.title='最大化'; maxBtn.setAttribute('aria-label','最大化工作流编辑器'); modalEl?.querySelector('.modal-head button')?.before(maxBtn);
  graph.tabIndex=0;graph.addEventListener('contextmenu',e=>e.preventDefault());graph.addEventListener('pointerdown',e=>{if(e.button!==2)return;e.preventDefault();const sx=e.clientX,sy=e.clientY,sl=graph.scrollLeft,st=graph.scrollTop;graph.classList.add('panning');graph.setPointerCapture?.(e.pointerId);const move=ev=>{graph.scrollLeft=sl-(ev.clientX-sx);graph.scrollTop=st-(ev.clientY-sy);};const up=()=>{graph.classList.remove('panning');graph.removeEventListener('pointermove',move);graph.removeEventListener('pointerup',up);};graph.addEventListener('pointermove',move);graph.addEventListener('pointerup',up);},true);
  function syncMeta(){draft.id=idInput.value.trim();draft.title=titleInput.value.trim();draft.description=descInput.value.trim();draft.source=scopeSelect.value;}
  function edgeKey(edge){return edge ? `${edge.from}->${edge.to}` : '';}
  function edgeExists(edge){const to=draft.nodes.find(n=>n.id===edge?.to);return !!(to&&to.dependsOn||[]).includes(edge?.from);}
  function resetConnectMode(){connectFromId='';connectBtn.textContent='连接箭头';}
  function syncNodeSelect(){const prev=nodeSelect.value;nodeSelect.textContent='';for(const n of draft.nodes){const o=document.createElement('option');o.value=n.id;o.textContent=`节点：${n.id}`;nodeSelect.appendChild(o);}nodeSelect.value=draft.nodes.some(n=>n.id===selectedId)?selectedId:(draft.nodes.some(n=>n.id===prev)?prev:(draft.nodes[0]?.id||''));}
  function markSelectedCards(){graph.querySelectorAll('.workflow-node-card').forEach(x=>{x.classList.toggle('selected',x.dataset.nodeId===selectedId);x.classList.toggle('connect-source',x.dataset.nodeId===connectFromId);});nodeSelect.value=selectedId||'';}
  function markSelectedEdges(){graph.querySelectorAll('.workflow-edge').forEach(x=>x.classList.toggle('selected',x.dataset.edgeKey===edgeKey(selectedEdge)));edgeDeleteBtn.disabled=!selectedEdge;}
  function removeWorkflowEdge(edge){const to=draft.nodes.find(n=>n.id===edge?.to);if(!to)return false;const before=(to.dependsOn||[]).length;to.dependsOn=(to.dependsOn||[]).filter(x=>x!==edge.from);return to.dependsOn.length!==before;}
  function addWorkflowEdge(from,to){if(!from||!to||from===to)return false;if(!draft.nodes.some(n=>n.id===from)||!draft.nodes.some(n=>n.id===to))return false;const target=draft.nodes.find(n=>n.id===to);target.dependsOn=target.dependsOn||[];if(target.dependsOn.includes(from))return false;target.dependsOn.push(from);return true;}
  function replaceWorkflowEdge(edge, endpoint, nextNodeId){if(!edge||!nextNodeId)return false;const next=edge&&endpoint==='from'?{from:nextNodeId,to:edge.to}:{from:edge.from,to:nextNodeId};if(next.from===next.to)return false;if(edgeKey(next)!==edgeKey(edge)&&edgeExists(next))return false;removeWorkflowEdge(edge);const ok=addWorkflowEdge(next.from,next.to);if(ok)selectedEdge=next;else addWorkflowEdge(edge.from,edge.to);return ok;}
  function nodeIdAtClientPoint(x,y){const direct=document.elementFromPoint(x,y)?.closest?.('.workflow-node-card');if(direct&&graph.contains(direct))return direct.dataset.nodeId;for(const card of graph.querySelectorAll('.workflow-node-card')){const r=card.getBoundingClientRect();if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom)return card.dataset.nodeId;}return '';}
  function edgeEndpointByPointer(e,fromNode,toNode){const gr=graph.getBoundingClientRect();const sx=gr.left-graph.scrollLeft+(fromNode.position?.x||0)+210,sy=gr.top-graph.scrollTop+(fromNode.position?.y||0)+45,tx=gr.left-graph.scrollLeft+(toNode.position?.x||0),ty=gr.top-graph.scrollTop+(toNode.position?.y||0)+45;const ds=Math.hypot(e.clientX-sx,e.clientY-sy),dt=Math.hypot(e.clientX-tx,e.clientY-ty);return ds<=dt?'from':'to';}
  function forkWorkflowDraft(){
    syncMeta();
    const base = draft.id || 'workflow';
    const suffix = Date.now().toString(36);
    draft.id = `${base.replace(/-copy-[a-z0-9]+$/,'')}-copy-${suffix}`.toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'');
    draft.title = `${draft.title || '工作流'} 副本`;
    draft.source = 'personal';
    idInput.value = draft.id; titleInput.value = draft.title; scopeSelect.value = draft.source;
    toast('已切换为新模板副本，保存后不会覆盖原模板', 'ok');
  }
  function drawEdges(svg){
    const NS='http://www.w3.org/2000/svg'; const defs=document.createElementNS(NS,'defs'), marker=document.createElementNS(NS,'marker'); marker.setAttribute('id','wf-arrow');marker.setAttribute('markerWidth','8');marker.setAttribute('markerHeight','8');marker.setAttribute('refX','7');marker.setAttribute('refY','3');marker.setAttribute('orient','auto');const path=document.createElementNS(NS,'path');path.setAttribute('d','M0,0 L0,6 L8,3 z');marker.appendChild(path);defs.appendChild(marker);svg.appendChild(defs);
    for(const node of draft.nodes){for(const dep of node.dependsOn||[]){const from=draft.nodes.find(x=>x.id===dep);if(!from)continue;const edge={from:dep,to:node.id},x1=(from.position?.x||0)+210,y1=(from.position?.y||0)+45,x2=node.position?.x||0,y2=(node.position?.y||0)+45;const g=document.createElementNS(NS,'g');g.classList.add('workflow-edge');if(edgeKey(selectedEdge)===edgeKey(edge))g.classList.add('selected');g.dataset.from=dep;g.dataset.to=node.id;g.dataset.edgeKey=edgeKey(edge);const line=document.createElementNS(NS,'line');line.classList.add('workflow-edge-line');line.setAttribute('x1',String(x1));line.setAttribute('y1',String(y1));line.setAttribute('x2',String(x2));line.setAttribute('y2',String(y2));line.setAttribute('marker-end','url(#wf-arrow)');const hit=document.createElementNS(NS,'line');hit.classList.add('workflow-edge-hit');hit.setAttribute('x1',String(x1));hit.setAttribute('y1',String(y1));hit.setAttribute('x2',String(x2));hit.setAttribute('y2',String(y2));hit.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();selectedEdge=edge;selectedId='';resetConnectMode();markSelectedCards();markSelectedEdges();renderInspector();const endpoint=edgeEndpointByPointer(e,from,node);const sx=e.clientX,sy=e.clientY;let moved=false;hit.setPointerCapture?.(e.pointerId);const move=ev=>{if(Math.abs(ev.clientX-sx)+Math.abs(ev.clientY-sy)>4)moved=true;};const up=ev=>{hit.removeEventListener('pointermove',move);hit.removeEventListener('pointerup',up);if(moved){const targetId=nodeIdAtClientPoint(ev.clientX,ev.clientY);if(targetId&&(snapshot(),replaceWorkflowEdge(edge,endpoint,targetId))){selectedId='';renderGraph();renderInspector();toast(endpoint==='from'?'已调整箭头起点':'已调整箭头终点','ok');}else{renderGraph();renderInspector();if(targetId)toast('不能连接到自身或重复箭头','err');}}else markSelectedEdges();};hit.addEventListener('pointermove',move);hit.addEventListener('pointerup',up);});g.append(line,hit);svg.appendChild(g);}}
  }
  // ── 编辑器 v2 基础设施：撤销栈 / 实时校验 / 模型数据源（第14波）──
  let undoStack = [];
  function snapshot(){ try { undoStack.push(structuredClone(draft.nodes)); } catch { undoStack.push(cloneWorkflow(draft.nodes)); } if (undoStack.length > 20) undoStack.shift(); }
  function undo(){ if(!undoStack.length){ toast('没有可撤销的步骤',''); return; } const prev=undoStack.pop(); draft.nodes=prev; if(!draft.nodes.some(n=>n.id===selectedId)) selectedId=(draft.nodes[0]&&draft.nodes[0].id)||''; selectedEdge=null; resetConnectMode(); renderGraph(); renderInspector(); toast('已撤销','ok'); }
  const problemChip = el('button','wf-problem-chip'); problemChip.type='button'; problemChip.hidden=true; toolbar.appendChild(problemChip);
  let lastProblems=[];
  problemChip.onclick=()=>{ if(lastProblems.length) toast('校验问题：\n'+lastProblems.join('\n'),'err'); };
  function validateDraft(){
    const nodes=draft.nodes, ids=new Set(nodes.map(n=>n.id)), problems=[], bad=new Set(), seen=new Set();
    for(const n of nodes){ if(seen.has(n.id)){ problems.push('节点 ID 重复：'+n.id); bad.add(n.id); } seen.add(n.id); }
    for(const n of nodes){ if(!String(n.task||'').trim()){ problems.push('节点「'+n.id+'」任务为空'); bad.add(n.id); } }
    for(const n of nodes){ for(const d of n.dependsOn||[]){ if(!ids.has(d)){ problems.push('节点「'+n.id+'」依赖不存在的「'+d+'」'); bad.add(n.id); } } }
    const color=new Map(); let cyc=false;
    const dfs=id=>{ color.set(id,1); const n=nodes.find(x=>x.id===id); for(const d of (n&&n.dependsOn||[]).filter(x=>ids.has(x))){ const c=color.get(d)||0; if(c===1){ cyc=true; bad.add(id); bad.add(d); } else if(c===0) dfs(d); } color.set(id,2); };
    for(const n of nodes){ if((color.get(n.id)||0)===0) dfs(n.id); }
    if(cyc) problems.push('存在环依赖（节点相互依赖，无法排序）');
    return { problems, bad };
  }
  let validateTimer=null;
  function scheduleValidate(){ clearTimeout(validateTimer); validateTimer=setTimeout(()=>{ const r=validateDraft(); lastProblems=r.problems; graph.querySelectorAll('.workflow-node-card').forEach(c=>c.classList.toggle('wf-node-invalid',r.bad.has(c.dataset.nodeId))); if(r.problems.length){ problemChip.hidden=false; problemChip.textContent='⚠ '+r.problems.length+' 个问题'; } else problemChip.hidden=true; }, 300); }
  function roleById(id){ return roles.find(r=>r.id===id)||null; }
  function engineModelOptions(eng){
    if(eng==='openai'){ const p=activeProviderObj(); return (p&&p.models||[]).map(m=>({value:m.id,label:m.label||m.id})); }
    if(eng==='claude'){ const out=[],seen=new Set(); for(const raw of (state.config.extraModels||[])){ const parts=String(raw).split('|'); const v=(parts[0]||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:(parts[1]||'').trim()||v}); } } for(const id of (state.config.knownModels||[])){ const v=String(id||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:v}); } } for(const m of ((state.status&&state.status.models)||[])){ const v=String(m.id||'').trim(); if(v&&!seen.has(v)){ seen.add(v); out.push({value:v,label:m.label||v}); } } return out; }
    return [];
  }
  function roleModelFor(roleId,eng){ const r=roleById(roleId); if(!r||!r.models) return ''; return eng==='claude' ? (r.models.claude&&r.models.claude!=='inherit'?r.models.claude:'') : (r.models.openai||''); }
  function globalModelFor(eng){ return eng==='openai' ? ((activeProviderObj()||{}).model||'') : (state.config.model||''); }
  if(modalEl) modalEl.addEventListener('keydown',e=>{ const tag=(e.target&&e.target.tagName)||''; if(/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return; if(e.key==='Delete'){ if(selectedEdge){ e.preventDefault(); edgeDeleteBtn.click(); } else if(selectedId){ e.preventDefault(); deleteBtn.click(); } } else if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){ e.preventDefault(); undo(); } });
  function fitView(){ if(!draft.nodes.length) return; let a=Infinity,b=Infinity,c=-Infinity,d=-Infinity; for(const n of draft.nodes){ const x=n.position?.x||0,y=n.position?.y||0; a=Math.min(a,x); b=Math.min(b,y); c=Math.max(c,x+210); d=Math.max(d,y+96); } const cx=(a+c)/2,cy=(b+d)/2; graph.scrollTo({left:Math.max(0,cx-graph.clientWidth/2),top:Math.max(0,cy-graph.clientHeight/2),behavior:'smooth'}); }
  function clientToCanvas(cx,cy){ const r=graph.getBoundingClientRect(); return { x:cx-r.left+graph.scrollLeft, y:cy-r.top+graph.scrollTop }; }
  function renderGraph(){ graph.textContent=''; const NS='http://www.w3.org/2000/svg',svg=document.createElementNS(NS,'svg');svg.classList.add('workflow-edges');graph.appendChild(svg);drawEdges(svg);
    for(const node of draft.nodes){const card=el('button',`workflow-node-card${node.id===selectedId?' selected':''}${node.id===connectFromId?' connect-source':''}`);card.type='button';card.dataset.nodeId=node.id;card.style.left=`${node.position?.x||0}px`;card.style.top=`${node.position?.y||0}px`;
      const head=el('div','wf-node-head');head.appendChild(el('strong','',node.id));const badge=agentEngineBadge(node.engine);if(badge)head.appendChild(badge);if(node.gate&&node.gate.mode){const gm=el('span','wf-node-gate','⚖');gm.title='质量门：'+node.gate.mode;head.appendChild(gm);}card.appendChild(head);
      card.appendChild(el('span','wf-node-role',node.role||'无角色'));
      if(node.model){const mv=el('span','wf-node-model',node.model.length>18?node.model.slice(0,18)+'…':node.model);mv.title='模型：'+node.model;card.appendChild(mv);}
      card.appendChild(el('small','',(node.dependsOn||[]).length?`依赖 ${(node.dependsOn||[]).join(', ')}`:'起点'));
      const port=el('span','wf-port');port.title='从这里拖到目标节点，创建依赖箭头';
      port.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();const gsvg=graph.querySelector('svg.workflow-edges');const temp=document.createElementNS(NS,'line');temp.setAttribute('class','wf-temp-edge');const x1=(node.position?.x||0)+210,y1=(node.position?.y||0)+45;temp.setAttribute('x1',x1);temp.setAttribute('y1',y1);temp.setAttribute('x2',x1);temp.setAttribute('y2',y1);if(gsvg)gsvg.appendChild(temp);port.setPointerCapture?.(e.pointerId);const move=ev=>{const p=clientToCanvas(ev.clientX,ev.clientY);temp.setAttribute('x2',p.x);temp.setAttribute('y2',p.y);};const up=ev=>{port.removeEventListener('pointermove',move);port.removeEventListener('pointerup',up);temp.remove();const targetId=nodeIdAtClientPoint(ev.clientX,ev.clientY);if(targetId&&targetId!==node.id){snapshot();if(addWorkflowEdge(node.id,targetId)){selectedEdge=null;renderGraph();renderInspector();toast('已连线','ok');}else{undoStack.pop();toast('不能连接到自身或重复箭头','err');}}};port.addEventListener('pointermove',move);port.addEventListener('pointerup',up);});
      card.appendChild(port);
      card.addEventListener('dblclick',ev=>{ev.preventDefault();selectedId=node.id;selectedEdge=null;renderInspector();const t=inspector.querySelector('[data-wf-field="task"]');if(t)t.focus();});
      card.addEventListener('pointerdown',e=>{if(e.button!==0)return;if(connectFromId&&connectFromId!==node.id){snapshot();if(!(node.dependsOn||[]).includes(connectFromId))node.dependsOn=[...(node.dependsOn||[]),connectFromId];else undoStack.pop();selectedId=node.id;selectedEdge=null;resetConnectMode();syncNodeSelect();renderGraph();renderInspector();toast('已新增依赖箭头','ok');return;}selectedId=node.id;selectedEdge=null;renderInspector();markSelectedCards();markSelectedEdges();const sx=e.clientX,sy=e.clientY,ox=node.position?.x||0,oy=node.position?.y||0;let moved=false;card.setPointerCapture(e.pointerId);const move=ev=>{const dx=ev.clientX-sx,dy=ev.clientY-sy;if(Math.abs(dx)+Math.abs(dy)>3){if(!moved){moved=true;snapshot();}node.position={x:Math.max(0,ox+dx),y:Math.max(0,oy+dy)};card.style.left=`${node.position.x}px`;card.style.top=`${node.position.y}px`;}};const up=()=>{card.removeEventListener('pointermove',move);card.removeEventListener('pointerup',up);if(moved)renderGraph();else{markSelectedCards();markSelectedEdges();}};card.addEventListener('pointermove',move);card.addEventListener('pointerup',up);});
      graph.appendChild(card); }
    if(!draft.nodes.length){const guide=el('div','wf-canvas-empty');guide.appendChild(el('div','wf-canvas-empty-title','画布还是空的，从这里开始'));const row=el('div','wf-canvas-empty-actions');const fromTpl=el('button','mini','从模板开始');fromTpl.type='button';fromTpl.onclick=()=>{templateSelect.focus();};const addFirst=el('button','mini primary','＋ 添加第一个节点');addFirst.type='button';addFirst.onclick=()=>addBtn.click();row.append(fromTpl,addFirst);guide.appendChild(row);graph.appendChild(guide);}
    const controls=el('div','wf-canvas-controls');const fitBtn=el('button','mini wf-fit-btn','适应视图');fitBtn.type='button';fitBtn.title='把所有节点居中到视口';fitBtn.onclick=fitView;controls.appendChild(fitBtn);graph.appendChild(controls);
    syncNodeSelect();
    markSelectedEdges();
    scheduleValidate();
  }
  // Remap any OTHER node's reference to a node id across all three reference kinds (dependsOn, its own
  // condition, and its loop's until condition) — rename must keep all three in sync, not just dependsOn,
  // or a save is rejected server-side with no indication of which reference broke it.
  function remapWorkflowNodeRef(fromId,toId){
    for(const n of draft.nodes){
      n.dependsOn=(n.dependsOn||[]).map(x=>x===fromId?toId:x);
      if(n.condition&&n.condition.node===fromId)n.condition={...n.condition,node:toId};
      if(n.loop&&n.loop.until&&n.loop.until.node===fromId)n.loop={...n.loop,until:{...n.loop.until,node:toId}};
    }
  }
  // Clear (not remap) any OTHER node's reference to a deleted node id, across the same three kinds.
  // Returns how many condition/loop references were cleared (dependsOn silently drops — that's just a
  // graph edge — but clearing a condition changes the node's behavior, so the caller should tell the user).
  function clearWorkflowNodeRef(deadId){
    let cleared=0;
    for(const n of draft.nodes){
      n.dependsOn=(n.dependsOn||[]).filter(x=>x!==deadId);
      if(n.condition&&n.condition.node===deadId){n.condition=null;cleared++;}
      if(n.loop&&n.loop.until&&n.loop.until.node===deadId){n.loop={...n.loop,until:null};cleared++;}
    }
    return cleared;
  }
  function renderInspector(){inspector.textContent='';commitSelectedNode=null;if(selectedEdge&&!edgeExists(selectedEdge))selectedEdge=null;if(selectedEdge){const fromSel=document.createElement('select'),toSel=document.createElement('select');for(const n of draft.nodes){const a=document.createElement('option');a.value=n.id;a.textContent=n.id;fromSel.appendChild(a);const b=document.createElement('option');b.value=n.id;b.textContent=n.id;toSel.appendChild(b);}fromSel.value=selectedEdge.from;toSel.value=selectedEdge.to;const applyEdge=el('button','mini primary','应用箭头'),delEdge=el('button','mini danger','删除箭头');inspector.append(el('p','workflow-help','已选择箭头。可在这里改起点/终点，也可直接拖动箭头靠近某一端的位置到目标节点。'),workflowField('起点节点',fromSel),workflowField('结束节点',toSel));applyEdge.onclick=()=>{const next={from:fromSel.value,to:toSel.value};if(next.from===next.to)return toast('箭头不能连接到自身','err');if(edgeKey(next)!==edgeKey(selectedEdge)&&edgeExists(next))return toast('重复箭头','err');snapshot();const old=selectedEdge;removeWorkflowEdge(old);if(!addWorkflowEdge(next.from,next.to)){addWorkflowEdge(old.from,old.to);return toast('无法应用箭头','err');}selectedEdge=next;renderGraph();renderInspector();};delEdge.onclick=()=>{snapshot();if(removeWorkflowEdge(selectedEdge)){selectedEdge=null;renderGraph();renderInspector();toast('已删除箭头','ok');}};inspector.append(applyEdge,delEdge);return;}const node=draft.nodes.find(x=>x.id===selectedId);
    if(!node){ inspector.append(el('p','muted','选择一个节点')); return; }
    const oldId=node.id;
    // ── 身份 ──
    const nid=document.createElement('input'); nid.value=node.id;
    const task=document.createElement('textarea'); task.rows=5; task.value=node.task||''; task.dataset.wfField='task';
    const role=document.createElement('select'); { const empty=document.createElement('option'); empty.value=''; empty.textContent='无角色'; role.appendChild(empty); for(const r of roles){ const o=document.createElement('option'); o.value=r.id; o.textContent=r.label||r.id; role.appendChild(o); } role.value=node.role||''; }
    // ── 执行 ──
    const engine=document.createElement('select'); for(const [v,t] of [['','自动（跟随可用引擎）'],['openai','OpenAI Provider'],['claude','Claude CLI']]){ const o=document.createElement('option'); o.value=v; o.textContent=t; engine.appendChild(o); } engine.value=node.engine||'';
    const model=document.createElement('select');
    const modelCustom=document.createElement('input'); modelCustom.className='wf-model-custom'; modelCustom.placeholder='输入自定义模型 id'; modelCustom.style.display='none';
    const modelHint=el('div','wf-model-hint');
    function currentModelChoice(){ return model.value==='__custom' ? modelCustom.value.trim() : model.value; }
    function updateModelHint(){ const eng=engine.value; if(!eng){ modelHint.textContent='引擎为自动时不单独指定模型，跟随角色/引擎默认'; return; } const chosen=currentModelChoice(); if(chosen){ modelHint.textContent='当前生效：节点指定 · '+chosen; return; } const rm=roleModelFor(role.value,eng); if(rm){ modelHint.textContent='当前生效：角色默认 · '+rm; return; } const g=globalModelFor(eng); modelHint.textContent = g ? '当前生效：全局默认 · '+g : '当前生效：引擎内置默认'; }
    function rebuildModelOptions(){ const eng=engine.value; const cur=node.model||''; model.textContent=''; const inh=document.createElement('option'); inh.value=''; inh.textContent='继承（角色/全局默认）'; model.appendChild(inh); for(const m of engineModelOptions(eng)){ const o=document.createElement('option'); o.value=m.value; o.textContent=m.label; model.appendChild(o); } const cus=document.createElement('option'); cus.value='__custom'; cus.textContent='自定义…'; model.appendChild(cus); if(eng===''){ model.value=''; model.disabled=true; modelCustom.style.display='none'; } else { model.disabled=false; if(!cur) model.value=''; else if([...model.options].some(o=>o.value===cur)) model.value=cur; else { model.value='__custom'; modelCustom.value=cur; } modelCustom.style.display = model.value==='__custom' ? '' : 'none'; } updateModelHint(); }
    model.onchange=()=>{ modelCustom.style.display = model.value==='__custom' ? '' : 'none'; if(model.value==='__custom') modelCustom.focus(); updateModelHint(); };
    modelCustom.oninput=updateModelHint;
    engine.onchange=()=>{ rebuildModelOptions(); };
    role.onchange=updateModelHint;
    rebuildModelOptions();
    const maxIters=document.createElement('input'); maxIters.type='number'; maxIters.min='1'; maxIters.max='100'; maxIters.placeholder='默认'; maxIters.value=(node.maxIters!=null&&node.maxIters!=='')?node.maxIters:'';
    const toolTier=document.createElement('select'); for(const [v,t] of [['','继承角色'],['read','只读 read'],['edit','可编辑 edit'],['exec','可执行 exec']]){ const o=document.createElement('option'); o.value=v; o.textContent=t; toolTier.appendChild(o); } toolTier.value=node.toolTier||'';
    // ── 编排 ──
    const deps=document.createElement('select'); deps.multiple=true; deps.size=Math.min(8,Math.max(3,draft.nodes.length-1)); for(const other of draft.nodes.filter(x=>x.id!==node.id)){ const o=document.createElement('option'); o.value=other.id; o.textContent=other.id; o.selected=(node.dependsOn||[]).includes(other.id); deps.appendChild(o); }
    const condition=document.createElement('input'); condition.placeholder='如 review.verdict == "fail"'; condition.value=workflowConditionText(node.condition);
    const loopMax=document.createElement('input'); loopMax.type='number'; loopMax.min='1'; loopMax.max='20'; loopMax.value=node.loop?.maxIterations||1;
    const loopUntil=document.createElement('input'); loopUntil.placeholder='可选，如 loop.done == true'; loopUntil.value=workflowConditionText(node.loop?.until);
    const noProgress=document.createElement('input'); noProgress.type='number'; noProgress.min='1'; noProgress.max='10'; noProgress.value=node.loop?.noProgressLimit||2;
    // ── 质量 ──
    const gate=document.createElement('select'); for(const [v,t] of [['','无（不设质量门）'],['review','review 复核'],['verify','verify 验收'],['vote','vote 投票'],['cross_review','cross_review 交叉审查'],['dedupe','dedupe 去重']]){ const o=document.createElement('option'); o.value=v; o.textContent=t; gate.appendChild(o); } gate.value=(node.gate&&node.gate.mode)||'';
    const failure=document.createElement('select'); for(const [v,t] of [['block','阻塞下游'],['continue','降级继续'],['retry','自动重试']]){ const o=document.createElement('option'); o.value=v; o.textContent=t; failure.appendChild(o); } failure.value=node.failurePolicy||'block';
    const maxRetries=document.createElement('input'); maxRetries.type='number'; maxRetries.min='1'; maxRetries.max='5'; maxRetries.value=node.maxRetries||1;
    // ── 高级 JSON ──
    const adv=el('details','wf-insp-advanced'); adv.appendChild(el('summary','','高级（直接编辑节点 JSON：resources / outputSchema / isolation 等长尾）')); const advTa=document.createElement('textarea'); advTa.className='wf-adv-json'; advTa.rows=8; advTa.spellcheck=false; advTa.value=JSON.stringify(node,null,2); const advApply=el('button','mini','应用 JSON'); advApply.type='button'; adv.append(workflowField('节点完整 JSON',advTa),advApply);
    advApply.onclick=()=>{ let parsed; try{ parsed=JSON.parse(advTa.value); }catch(err){ return toast('JSON 解析失败：'+err.message,'err'); } if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) return toast('必须是一个 JSON 对象','err'); const nextId=String(parsed.id||'').trim(); if(!/^[A-Za-z0-9_-]+$/.test(nextId)) return toast('JSON 中 id 非法（仅字母/数字/_/-）','err'); if(nextId!==oldId&&draft.nodes.some(x=>x.id===nextId)) return toast('JSON 中 id 与其他节点重复','err'); snapshot(); for(const k of Object.keys(node)) delete node[k]; Object.assign(node,parsed); node.id=nextId; if(nextId!==oldId) remapWorkflowNodeRef(oldId,nextId); selectedId=nextId; renderGraph(); renderInspector(); toast('已应用节点 JSON','ok'); };
    // ── 分组装配（身份 / 执行 / 编排 / 质量）──
    const group=(title,...items)=>{ const g=el('div','wf-insp-group'); g.appendChild(el('div','wf-insp-group-title',title)); for(const it of items) if(it) g.appendChild(it); return g; };
    const modelField=workflowField('模型（可为该职位指派更强模型）',model); modelField.append(modelCustom,modelHint);
    inspector.append(
      group('身份', workflowField('节点 ID',nid), workflowField('任务',task), workflowField('角色',role)),
      group('执行', workflowField('执行引擎',engine), modelField, workflowField('迭代预算 maxIters（空=默认）',maxIters), workflowField('工具权限 toolTier',toolTier)),
      group('编排', workflowField('依赖节点（多选）',deps), el('div','workflow-help','依赖表示箭头方向：被选节点 → 当前节点。也可点“连接箭头”，或从节点右侧圆点手柄拖到目标节点。'), workflowField('运行条件',condition), workflowField('最大循环次数',loopMax), workflowField('循环停止条件',loopUntil), workflowField('连续无进展停止',noProgress)),
      group('质量', workflowField('质量门 gate',gate), workflowField('失败策略',failure), workflowField('自动重试次数（失败策略=自动重试 时生效）',maxRetries)),
      adv
    );
    const apply=el('button','mini primary','应用节点设置');
    const doApplyNode=()=>{
      // Validate EVERYTHING first — nothing on `node`/`draft` is written until every field parses.
      const nextId=nid.value.trim();
      if(!/^[A-Za-z0-9_-]+$/.test(nextId)){ toast('节点 ID 只能用字母、数字、_、-','err'); return false; }
      if(nextId!==oldId&&draft.nodes.some(x=>x.id===nextId)){ toast('节点 ID 重复','err'); return false; }
      const nextDependsOn=[...deps.selectedOptions].map(x=>x.value).filter(x=>x&&x!==nextId);
      const nextCondition=parseWorkflowConditionText(condition.value);
      if(condition.value.trim()&&!nextCondition){ toast('运行条件格式无效','err'); return false; }
      const lm=Math.max(1,Number(loopMax.value)||1);
      const nextUntil=parseWorkflowConditionText(loopUntil.value);
      if(loopUntil.value.trim()&&!nextUntil){ toast('循环停止条件格式无效','err'); return false; }
      const mi=maxIters.value.trim();
      const modelVal=currentModelChoice();
      // All parsed OK — snapshot then commit.
      snapshot();
      if(nextCondition?.node&&nextCondition.node!==nextId&&!nextDependsOn.includes(nextCondition.node)) nextDependsOn.push(nextCondition.node);
      const nextLoop=lm>1?{maxIterations:lm,until:nextUntil,noProgressLimit:Math.max(1,Number(noProgress.value)||2),onNoProgress:'continue'}:null;
      node.id=nextId; node.task=task.value.trim(); node.role=role.value; node.engine=engine.value;
      node.model = engine.value ? modelVal : '';
      node.dependsOn=nextDependsOn; node.failurePolicy=failure.value;
      node.maxRetries=failure.value==='retry'?Math.max(1,Math.min(5,Math.round(Number(maxRetries.value)||1))):0;
      node.condition=nextCondition; node.loop=nextLoop;
      node.gate = gate.value ? { ...(node.gate&&typeof node.gate==='object'?node.gate:{}), mode:gate.value } : null;
      if(mi) node.maxIters=Math.max(1,Math.min(100,Math.round(Number(mi)||100))); else delete node.maxIters;
      if(toolTier.value) node.toolTier=toolTier.value; else delete node.toolTier;
      if(nextId!==oldId) remapWorkflowNodeRef(oldId,nextId);
      selectedId=nextId; renderGraph(); renderInspector();
      return true;
    };
    apply.onclick=doApplyNode; commitSelectedNode=doApplyNode;
    inspector.appendChild(apply);
  }
  loadBtn.onclick=()=>{const wf=agentWorkflowLibrary.find(x=>x.id===templateSelect.value);if(!wf)return;undoStack.length=0;draft=cloneWorkflow(wf);draft.source=wf.source==='project'?'project':'personal';idInput.value=draft.id;titleInput.value=draft.title;descInput.value=draft.description||'';scopeSelect.value=draft.source;selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();toast('已载入模板；保存会覆盖同 ID 的个人/项目模板，内置模板会保存为个人副本','');};
  blankBtn.onclick=()=>{undoStack.length=0;draft=workflowBlank();idInput.value=draft.id;titleInput.value=draft.title;descInput.value=draft.description||'';scopeSelect.value=draft.source;selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();toast('已新建空白模板，保存后生成新模板','ok');};
  forkBtn.onclick=()=>{undoStack.length=0;selectedEdge=null;forkWorkflowDraft();renderGraph();renderInspector();};
  nodeSelect.onchange=()=>{selectedId=nodeSelect.value;selectedEdge=null;renderGraph();renderInspector();};
  connectBtn.onclick=()=>{if(connectFromId){resetConnectMode();markSelectedCards();return;}selectedEdge=null;connectFromId=selectedId||draft.nodes[0]?.id||'';connectBtn.textContent='取消连接';markSelectedCards();markSelectedEdges();toast('连接模式：点击目标节点，创建“当前节点 → 目标节点”的依赖箭头','');};
  edgeDeleteBtn.onclick=()=>{if(!selectedEdge)return;snapshot();if(removeWorkflowEdge(selectedEdge)){selectedEdge=null;renderGraph();renderInspector();toast('已删除箭头','ok');}};
  maxBtn.onclick=()=>{const on=modalEl?.classList.toggle('workflow-fullscreen');maxBtn.textContent=on?'❐':'□';maxBtn.title=on?'还原':'最大化';maxBtn.setAttribute('aria-label',on?'还原工作流编辑器':'最大化工作流编辑器');setTimeout(()=>{renderGraph();renderInspector();},0);};
  addBtn.onclick=()=>{snapshot();let i=draft.nodes.length+1,id=`step_${i}`;while(draft.nodes.some(x=>x.id===id))id=`step_${++i}`;draft.nodes.push({id,task:'描述任务',role:'worker',dependsOn:[],failurePolicy:'block',position:{x:60+(i%3)*250,y:80+Math.floor(i/3)*150}});selectedId=id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();};
  deleteBtn.onclick=()=>{
    if(draft.nodes.length<=1)return toast('至少保留一个节点','err');
    if(!confirm(`删除节点「${selectedId}」？其依赖它的运行条件/循环停止条件将被清除，且此操作不可撤销。`))return;
    snapshot();const deadId=selectedId;
    draft.nodes=draft.nodes.filter(x=>x.id!==deadId);
    const cleared=clearWorkflowNodeRef(deadId);
    selectedId=draft.nodes[0]?.id;selectedEdge=null;resetConnectMode();renderGraph();renderInspector();
    if(cleared)toast(`已删除节点，并清除 ${cleared} 处指向它的运行条件/循环停止条件（这些节点将变为无条件执行）`,'');
  };
  async function saveDraft(){if(commitSelectedNode){const okc=commitSelectedNode();if(okc===false)throw new Error('检查器有字段无效，请修正后再保存');}syncMeta();const r=await api('/api/agent-workflows',{method:'POST',body:JSON.stringify({scope:draft.source,cwd:currentWorkspace(),workflow:draft})});if(!r.ok)throw new Error(r.error||'保存失败');draft=cloneWorkflow(r.workflow);await loadAgentWorkflows();return draft;}
  cancel.onclick=()=>modal.close();save.onclick=async()=>{try{await saveDraft();toast('工作流已保存','ok');modal.close();}catch(e){toast(apiErrText(e),'err');}};run.onclick=async()=>{try{const wf=await saveDraft();modal.close();await launchAgentWorkflow(wf);}catch(e){toast(apiErrText(e),'err');}};remove.onclick=async()=>{syncMeta();if(draft.source==='builtin')return toast('内置模板不可删除','err');if(!confirm(`删除工作流模板「${draft.title||draft.id}」？此操作不可恢复。`))return;try{await api(`/api/agent-workflows/${encodeURIComponent(draft.id)}`,{method:'POST',headers:{'x-http-method':'DELETE'},body:JSON.stringify({scope:draft.source,cwd:currentWorkspace()})});await loadAgentWorkflows();toast('已删除工作流','ok');modal.close();}catch(e){toast(apiErrText(e),'err');}};
  renderGraph();renderInspector();
}

let agentRunsPoll = null;
const agentRunSummarySeen = new Set();
// 团队模式 v2: waiting_pool(收尾宽限窗,等待任务池审批)是活跃 live 态,并入 ACTIVE 集(卡片自动展开、不当作已完成)。
const AGENT_RUN_ACTIVE = new Set(['running', 'paused', 'waiting_pool']);
function agentRunStatusLabel(status) {
  return ({ queued: '等待中', waiting_resource: '等待资源', blocked: '被依赖阻塞', running: '运行中', paused: '已暂停', waiting_pool: '等待任务池审批', succeeded: '已完成', skipped: '条件跳过', partial: '部分完成', failed: '失败', rejected: '质量门判否', degraded: '降级完成', interrupted: '已中断', cancelled: '已取消', stopped: '已停止' })[status] || status || '未知';
}
// 团队模式 v2 (A4): 任务池提案状态人话标签。
function poolStatusLabel(s) { return ({ proposed: '待审批', approved: '已批准', materialized: '已加入', rejected: '已拒绝', expired: '已过期' })[s] || s || ''; }
// 团队模式 v2 (A4): 审批/拒绝一条任务池提案 → POST pool_approve/pool_reject（服务器要求 run 仍 live 且未收尾）。
async function poolDecide(runId, poolId, approve) {
  const sid = state.currentSession?.id; if (!sid) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action: approve ? 'pool_approve' : 'pool_reject', poolId }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '操作失败');
    toast(approve ? '已同意，新任务已加入工作流' : '已拒绝该提案', 'ok');
    await loadAgentRuns();
  } catch (e) { toast(`任务池：${apiErrText(e)}`, 'err'); }
}
// v1.5 运行监控：展示态状态语义。把「质量门判否」从「执行失败」里分出来——后端可能已直接发 'rejected'，也可能
// 仍发 'failed' 但带 gateVerdict/structuredResult.verdict==='fail'。两种都归一到 rejected（琥珀，语义=「发现问题
// ≠崩了」），条件下游据此评估而非阻塞。defensive：后端没发 rejected 也不崩，退化为 failed。
function nodeDisplayStatus(node) {
  const s = (node && node.status) || 'unknown';
  if (s === 'rejected') return 'rejected';
  if (s === 'failed') {
    const verdict = (node && node.gateVerdict) || (node && node.structuredResult && node.structuredResult.verdict);
    if (verdict && String(verdict).toLowerCase() === 'fail') return 'rejected';
  }
  if (s === 'succeeded' && node && node.degraded) return 'degraded';
  return s;
}
// 状态徽标图标（符号，不含色；颜色由 CSS 的 .st-<status> 语义 token 驱动，不硬编码）。
const AGENT_STATUS_ICON = { queued: '○', running: '◐', succeeded: '✓', failed: '✗', rejected: '⚑', skipped: '↷', waiting_resource: '⏸', blocked: '⊘', cancelled: '⏹', stopped: '⏹', interrupted: '⚠', degraded: '⚠', paused: '⏸', partial: '◑' };
function agentStatusIcon(s) { return AGENT_STATUS_ICON[s] || '○'; }
// 毫秒 → mm:ss / h:mm:ss（运行时长/节点计时用；2s 轮询即刷新，无需秒级 ticker）。
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
// run 已运行/总时长（live 用 now，历史用 completedAt/updatedAt）。
function runElapsedMs(run) {
  const start = run && run.createdAt ? Date.parse(run.createdAt) : NaN;
  if (!Number.isFinite(start)) return 0;
  const end = run.live ? Date.now() : (run.completedAt ? Date.parse(run.completedAt) : (run.updatedAt ? Date.parse(run.updatedAt) : Date.now()));
  return Number.isFinite(end) ? Math.max(0, end - start) : 0;
}
// 累计 token/成本聚合（defensive：字段可能不存在——后端并行落地中——此时返回 '' 不显示 chip）。
function runCostLabel(run) {
  const u = (run && (run.usage || run.usageTotals)) || null;
  const tok = (u && (Number(u.input_tokens || 0) + Number(u.output_tokens || 0))) || Number((run && run.totalTokens) || 0) || 0;
  const cost = Number(run && run.costUsd != null ? run.costUsd : run && run.totalCostUsd != null ? run.totalCostUsd : (u && u.costUsd) || 0) || 0;
  const parts = [];
  if (tok) parts.push(`${fmtTokens(tok)} tok`);
  if (cost) parts.push(`$${cost.toFixed(cost < 1 ? 4 : 2)}`);
  return parts.join(' · ');
}
// 引擎徽标：Claude=青花蓝(--accent)、Provider=釉里红/赭(--wf-provider)，双色区分（§3.2）。engine 为空则不渲染。
function agentEngineBadge(engine) {
  if (engine === 'claude') return el('span', 'wf-engine-badge eng-claude', 'Claude');
  if (engine === 'openai') return el('span', 'wf-engine-badge eng-provider', 'Provider');
  return null;
}
async function agentRunAction(runId, action, extra) {
  const sid = state.currentSession?.id; if (!sid) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action, ...(extra || {}) }) });
    if (!r.ok) throw new Error(r.error || '操作失败');
    toast('Agent 工作流操作已提交', 'ok'); await loadAgentRuns();
  } catch (e) { toast(`Agent 工作流：${apiErrText(e)}`, 'err'); }
}
// v1 定向插话（steer 到指定运行中子代理节点）：对某个运行中/排队中的 OpenAI 引擎节点插一句话，服务器在该节点
// 下一次 API 调用前把它注入为 user 消息。prompt() 取文本（与现有 confirm 风格一致，不引入新组件）；成功后刷新
// 运行列表让「插话」里程碑尽快显现。失败用 apiErrText 提示。
// v3 P3b:presetText 提供时走内联提交（工作台右板段1 的插话框直接传输入值，不弹 prompt）；不提供时保留原
// prompt() 交互（右栏 agent-runs tab 的「插话」按钮仍是 3 参调用）。两条路径共用同一 steer_node action 与 toast。
async function steerAgentNode(runId, nodeId, nodeStatus, presetText) {
  const sid = state.currentSession?.id; if (!sid) return;
  const text = (presetText != null ? presetText : (prompt(`对节点 ${nodeId} 插话（下一次调用前生效）：`) || '')).trim();
  if (!text) return;
  try {
    const r = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, { method: 'POST', body: JSON.stringify({ sessionId: sid, action: 'steer_node', nodeId, text }) });
    if (!r || !r.ok) throw new Error((r && r.error) || '插话失败');
    // running 节点在下一次迭代边界（下一次模型调用前）就会消费队列；queued/waiting_resource 节点要等它真正
    // 开跑才会消费——如果节点在那之前被跳过/阻塞/工作流停止，排队的插话会被直接丢弃，成功提示要如实区分这两种情况。
    const msg = nodeStatus === 'running' ? '已插话，下一次调用前生效' : '已排队，节点开跑时投递（若节点被跳过/阻塞则丢弃）';
    toast(msg, 'ok');
    await loadAgentRuns();
  } catch (e) { toast(`插话失败：${apiErrText(e)}`, 'err'); }
}
async function deleteAgentRun(runId) {
  const sid = state.currentSession?.id; if (!sid || !confirm('删除这条 Agent 工作流记录？')) return;
  try { await api(`/api/agent-runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sid)}`, { method: 'DELETE' }); await loadAgentRuns(); }
  catch (e) { toast(`删除失败：${apiErrText(e)}`, 'err'); }
}
// v1.5 运行监控重设计（§2 多 Agent 编排实时监控）：把纵向 <details> 列表升级为「聚合头 + 状态徽标节点卡」的
// 实时监控。数据仍来自 /api/agent-runs 的 2s 轮询（协议不变）。所有不可信内容一律 el()/textContent 渲染，
// 绝不 innerHTML 拼接。保留 .agent-run-card/.agent-node 基类与 data-* 以复用展开态保存逻辑。
// v3 (§2.9 P2):宽限窗进度条的客户端窗宽提示(与服务端 POOL_GRACE_MS 默认 60s 对齐;env 覆写时条比例近似)。
const POOL_GRACE_HINT_MS = 60000;
function renderAgentRuns(runs) {
  const host = $('agentRunsList'); if (!host) return;
  const knownRuns = new Set([...host.querySelectorAll('.agent-run-card')].map(x => x.dataset.runId).filter(Boolean));
  const openRuns = new Set([...host.querySelectorAll('.agent-run-card[open]')].map(x => x.dataset.runId).filter(Boolean));
  const knownNodes = new Set([...host.querySelectorAll('.agent-node')].map(x => `${x.dataset.runId}:${x.dataset.nodeId}`).filter(Boolean));
  const openNodes = new Set([...host.querySelectorAll('.agent-node[open]')].map(x => `${x.dataset.runId}:${x.dataset.nodeId}`).filter(Boolean));
  host.textContent = '';
  if (!runs.length) { host.appendChild(el('div', 'muted', '本会话还没有 Agent 工作流。')); return; }
  for (const run of runs) {
    const card = el('details', `agent-run-card ar-${run.status || 'unknown'}`); card.dataset.runId = run.id; card.open = knownRuns.has(run.id) ? openRuns.has(run.id) : (AGENT_RUN_ACTIVE.has(run.status) || run.status === 'interrupted');
    const nodes = Array.isArray(run.nodes) ? run.nodes : [];
    const done = nodes.filter(n => n.status === 'succeeded' || n.status === 'skipped').length;
    // ── 聚合头（§2.7）：状态 chip + 已运行时长 + 节点 done/total +（若有）累计 token/成本 ──
    const sum = el('summary', 'agent-run-head');
    sum.appendChild(el('span', 'ar-title', `🕸️ ${run.id}`));
    const agg = el('div', 'ar-agg');
    agg.appendChild(el('span', `ar-agg-chip st-${run.status || 'unknown'}`, agentRunStatusLabel(run.status)));
    agg.appendChild(el('span', 'ar-agg-nodes', `${done}/${nodes.length} 节点`));
    const elapsed = runElapsedMs(run); if (elapsed) agg.appendChild(el('span', 'ar-agg-time', (run.live ? '已运行 ' : '用时 ') + fmtDuration(elapsed)));
    const cost = runCostLabel(run); if (cost) agg.appendChild(el('span', 'ar-agg-cost', cost));
    sum.appendChild(agg);
    // v3 (§2.9 P2):当前活动行提升到聚合头 —— 收起态也能看到「现在谁在干嘛」。取运行中节点 progressLog 末条。
    if (run.live) {
      const runningNode = nodes.find(n => n.status === 'running');
      const rlog = runningNode && Array.isArray(runningNode.progressLog) ? runningNode.progressLog : [];
      const rlast = rlog.length ? rlog[rlog.length - 1] : null;
      if (runningNode && rlast && rlast.text) {
        const live = el('div', 'ar-agg-live');
        live.appendChild(el('span', 'ar-agg-live-dot'));
        live.appendChild(el('span', 'ar-agg-live-text num', `${runningNode.id}：${rlast.text}`));
        sum.appendChild(live);
      }
    }
    card.appendChild(sum);
    // ── 停滞/失败横幅（§2.5）：run.idleAborted 或有节点在资源上等待且有 blocker → 琥珀横幅 + [查看][停止] ──
    const waitingBlocked = nodes.filter(n => nodeDisplayStatus(n) === 'waiting_resource' && Array.isArray(n.resourceBlockers) && n.resourceBlockers.length);
    if (run.idleAborted || (run.live && waitingBlocked.length)) {
      const banner = el('div', 'wf-stall-banner'); banner.setAttribute('role', 'alert');
      const stallMsg = run.idleAborted ? '疑似停滞：工作流长时间无进展，已中止' : `疑似停滞：${waitingBlocked.length} 个节点在等待资源`;
      banner.append(el('span', 'wf-stall-icon', '⚠'), el('span', 'wf-stall-text', stallMsg));
      const stallActions = el('div', 'wf-stall-actions');
      const view = el('button', 'mini', '查看'); view.setAttribute('aria-label', '定位到停滞节点');
      view.onclick = () => {
        const target = waitingBlocked[0] || nodes.find(n => n.status !== 'succeeded' && n.status !== 'skipped');
        if (target) { const rowEl = card.querySelector(`.agent-node[data-node-id="${CSS.escape(target.id)}"]`); if (rowEl) { rowEl.open = true; rowEl.scrollIntoView({ block: 'nearest' }); } }
      };
      stallActions.appendChild(view);
      if (run.live) { const stop = el('button', 'mini danger', '停止'); stop.setAttribute('aria-label', '停止此工作流'); stop.onclick = () => agentRunAction(run.id, 'stop'); stallActions.appendChild(stop); }
      banner.appendChild(stallActions);
      card.appendChild(banner);
    }
    // ── 运行控制（§5.3 失败一键处置）：运行中=暂停/继续/停止；已结束未完成=恢复；结束=删除记录。wire 到 POST
    //    /api/agent-runs/:id（action: pause/resume/stop）。按钮均带 aria-label。 ──
    const controls = el('div', 'agent-run-controls');
    if (run.live && !run.paused) {
      const pause = el('button', 'mini', '暂停'); pause.setAttribute('aria-label', '暂停此工作流'); pause.onclick = () => agentRunAction(run.id, 'pause'); controls.appendChild(pause);
      const stop = el('button', 'mini danger', '停止'); stop.setAttribute('aria-label', '停止此工作流'); stop.onclick = () => agentRunAction(run.id, 'stop'); controls.appendChild(stop);
    } else if (run.live && run.paused) {
      const resume = el('button', 'mini primary', '继续'); resume.setAttribute('aria-label', '继续此工作流'); resume.onclick = () => agentRunAction(run.id, 'resume'); controls.appendChild(resume);
      const stop = el('button', 'mini danger', '停止'); stop.setAttribute('aria-label', '停止此工作流'); stop.onclick = () => agentRunAction(run.id, 'stop'); controls.appendChild(stop);
    } else if (run.status !== 'succeeded') {
      const resume = el('button', 'mini primary', '恢复未完成节点'); resume.setAttribute('aria-label', '恢复未完成的节点'); resume.onclick = () => agentRunAction(run.id, 'resume'); controls.appendChild(resume);
    }
    if (!run.live) { const del = el('button', 'mini', '删除记录'); del.setAttribute('aria-label', '删除此运行记录'); del.onclick = () => deleteAgentRun(run.id); controls.appendChild(del); }
    card.appendChild(controls);
    if (run.summary) card.appendChild(el('pre', 'agent-run-summary', run.summary));
    // ── 团队模式 v2 (A4) 共享任务池分区：simple 模式仅当有 proposed 时浮出「待批准的新任务 N」徽标+审批卡；pro 模式
    //    常驻全状态列表。审批卡三行人话（谁提议/做什么≤60字/预计消耗）+「同意添加 / 不用了」→ POST pool_approve/reject。
    //    waiting_pool（宽限窗）显示剩余秒数。所有文本走 el()/textContent（XSS 安全，绝不 innerHTML）。 ──
    const pool = Array.isArray(run.taskPool) ? run.taskPool : [];
    const proposedItems = pool.filter(p => p && p.status === 'proposed');
    const simpleMode = document.documentElement.getAttribute('data-ui-mode') === 'simple';
    if (pool.length && (proposedItems.length || !simpleMode)) {
      const section = el('div', 'pool-section');
      const ptitle = el('div', 'pool-title');
      ptitle.appendChild(el('span', 'pool-title-text', '共享任务池'));
      if (proposedItems.length) ptitle.appendChild(el('span', 'pool-badge', `待批准的新任务 ${proposedItems.length}`));
      section.appendChild(ptitle);
      if (run.status === 'waiting_pool' && run.live) {
        // v3 (§2.9 P2):宽限窗倒计时改细进度条(发丝倒计时)替代纯秒数文字。
        const remainMs = run.poolGraceUntil ? Math.max(0, Number(run.poolGraceUntil) - Date.now()) : 0;
        const grace = el('div', 'pool-grace');
        const bar = el('div', 'pool-grace-bar'); const fill = el('i');
        fill.style.width = `${Math.max(0, Math.min(100, Math.round((remainMs / POOL_GRACE_HINT_MS) * 100)))}%`;
        bar.appendChild(fill); grace.appendChild(bar);
        grace.appendChild(el('span', 'pool-grace-label num', `等待审批 · 剩余 ${Math.round(remainMs / 1000)}s`));
        section.appendChild(grace);
      }
      const listItems = simpleMode ? proposedItems : pool;
      for (const item of listItems) {
        const pcard = el('div', `pool-card ps-${item.status || 'proposed'}`);
        const whoNode = (run.nodes || []).find(n => n.id === item.proposedBy);
        const whoLabel = whoNode ? (whoNode.roleLabel || whoNode.id) : (item.proposedBy || '某节点');
        pcard.appendChild(el('div', 'pool-line pool-who', `谁提议：${whoLabel}`));
        // 团队模式 v2 (P3-6): pro 模式渲染 task 全文(完整可读);simple 模式截 60 字并把全文挂 title 属性(hover tooltip 看全文)。
        const taskFull = String(item.task || '').trim();
        const taskShort = taskFull.replace(/\s+/g, ' ').slice(0, 60);
        const whatLine = el('div', 'pool-line pool-what', `做什么：${simpleMode ? taskShort : taskFull}`);
        if (simpleMode && taskFull.replace(/\s+/g, ' ').length > taskShort.length) whatLine.title = taskFull;
        pcard.appendChild(whatLine);
        pcard.appendChild(el('div', 'pool-line pool-cost', `预计消耗：新增 1 个节点，至多约 ${item.maxIters || 100} 轮调用`));
        if (!simpleMode && item.reason) pcard.appendChild(el('div', 'pool-line pool-reason', `理由：${item.reason}`));
        if (!simpleMode && item.status !== 'proposed') pcard.appendChild(el('div', 'pool-line pool-status', `状态：${poolStatusLabel(item.status)}${item.resultNodeId ? ` · 节点 ${item.resultNodeId}` : ''}`));
        if (item.status === 'proposed' && run.live) {
          const pactions = el('div', 'pool-actions');
          const yes = el('button', 'mini primary', '同意添加'); yes.setAttribute('aria-label', '同意添加此任务'); yes.onclick = () => poolDecide(run.id, item.id, true);
          const no = el('button', 'mini', '不用了'); no.setAttribute('aria-label', '拒绝此任务'); no.onclick = () => poolDecide(run.id, item.id, false);
          pactions.append(yes, no);
          pcard.appendChild(pactions);
        }
        section.appendChild(pcard);
      }
      card.appendChild(section);
    }
    const graph = el('div', 'agent-run-graph');
    for (const node of nodes) {
      const disp = nodeDisplayStatus(node);
      const row = el('details', `agent-node wf-node an-${disp}`); row.dataset.runId = run.id; row.dataset.nodeId = node.id;
      const nodeKey = `${run.id}:${node.id}`; row.open = knownNodes.has(nodeKey) ? openNodes.has(nodeKey) : ['running', 'waiting_resource', 'failed', 'rejected', 'blocked'].includes(disp);
      // ── 节点卡头（§2.3）：状态徽标 + 标题(id·角色) + 引擎徽标 + 状态文案 ──
      const head = el('summary', 'agent-node-head wf-node-head');
      head.appendChild(el('span', `wf-status-badge st-${disp}`, agentStatusIcon(disp)));
      const titleWrap = el('span', 'wf-node-title');
      titleWrap.appendChild(el('span', 'wf-node-id', node.id));
      if (node.roleLabel || node.roleId) titleWrap.appendChild(el('span', 'wf-node-role', node.roleLabel || node.roleId));
      head.appendChild(titleWrap);
      const engBadge = agentEngineBadge(node.engine); if (engBadge) head.appendChild(engBadge);
      head.appendChild(el('span', 'wf-node-status-label', agentRunStatusLabel(disp)));
      row.appendChild(head);
      const body = el('div', 'agent-node-body');
      // 元信息条：依赖 / 门 / 失败策略 / 尝试次数。
      const metaBits = [];
      if (Array.isArray(node.dependsOn) && node.dependsOn.length) metaBits.push(`← ${node.dependsOn.join(', ')}`);
      if (node.gate && node.gate.mode) metaBits.push(`门 ${node.gate.mode}`);
      if (node.failurePolicy) metaBits.push(`失败:${node.failurePolicy}`);
      if (node.loopStopReason) metaBits.push(`停止:${node.loopStopReason}`);
      metaBits.push(`尝试 ${node.attempts || 0}`);
      const meta = el('div', 'wf-node-meta'); for (const bit of metaBits) meta.appendChild(el('span', 'wf-meta-chip', bit)); body.appendChild(meta);
      body.appendChild(el('div', 'agent-node-task', node.task || ''));
      // v1.4.6: 当前活动行——node.progressLog 末条（后端把 live 子代理事件折进它并节流落盘，轮询即见）。运行/等待
      // 中的节点带旋转点；succeeded/skipped 不在这里显示（历史在下方「最近进展」）。
      const activityLog = Array.isArray(node.progressLog) ? node.progressLog : [];
      const lastActivity = activityLog.length ? activityLog[activityLog.length - 1] : null;
      if (lastActivity && lastActivity.text && node.status !== 'succeeded' && node.status !== 'skipped') {
        const active = node.status === 'running' || node.status === 'waiting_resource';
        const act = el('div', `agent-node-activity${active ? ' active' : ''}`);
        act.append(el('span', 'agent-node-activity-dot', active ? '◐' : '·'), el('span', 'agent-node-activity-text', lastActivity.text));
        body.appendChild(act);
      }
      // ── 迭代/预算 mini 进度（§2.3）：loop 优先显示 loopIteration；否则 iters/maxIters（迭代预算）。 ──
      let budgetLabel = '', budgetCur = 0, budgetMax = 0;
      if (node.loop) { budgetLabel = '循环'; budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
      else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = '迭代'; budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
      if (budgetMax > 0) {
        const bwrap = el('div', 'wf-node-budget');
        bwrap.appendChild(el('span', 'wf-budget-label', `${budgetLabel} ${budgetCur}/${budgetMax}`));
        const bar = el('div', 'wf-budget-bar'); const fill = el('div', 'wf-budget-fill'); fill.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(fill); bwrap.appendChild(bar);
        if (node.noProgressCount) bwrap.appendChild(el('span', 'wf-budget-warn', `无进展 ${node.noProgressCount}`));
        body.appendChild(bwrap);
      }
      // ── 计时（§2.3）：已运行/用时 now-startedAt。 ──
      if (node.startedAt) {
        const st = Date.parse(node.startedAt);
        if (Number.isFinite(st)) {
          const active = node.status === 'running' || node.status === 'waiting_resource';
          const end = node.completedAt ? Date.parse(node.completedAt) : Date.now();
          const dur = fmtDuration(end - st);
          if (dur) body.appendChild(el('div', 'wf-node-timer', `${active ? '已运行' : '用时'} ${dur}`));
        }
      }
      // ── 质量门 verdict + 置信度（§2.3）：仅门/带 verdict 的节点。 ──
      const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
      if (verdict || (node.confidence != null && Number.isFinite(Number(node.confidence)))) {
        const g = el('div', 'wf-node-gate');
        if (verdict) g.appendChild(el('span', `wf-gate-verdict gv-${String(verdict).toLowerCase()}`, `判定 ${verdict}`));
        if (node.confidence != null && Number.isFinite(Number(node.confidence))) g.appendChild(el('span', 'wf-gate-conf', `置信度 ${(Number(node.confidence) * 100).toFixed(0)}%`));
        body.appendChild(g);
      }
      // ── 资源锁 chip（§2.3）：等待中高亮 blocker。 ──
      if (Array.isArray(node.resources) && node.resources.length) {
        const waitingSet = new Set(Array.isArray(node.waitingForResources) ? node.waitingForResources : []);
        const resourceRow = el('div', 'agent-node-resources');
        resourceRow.appendChild(el('span', 'agent-resource-label', disp === 'waiting_resource' ? '等待：' : '资源：'));
        for (const resource of node.resources) resourceRow.appendChild(el('span', `agent-resource-chip${waitingSet.has(resource) ? ' blocking' : ''}`, resource));
        body.appendChild(resourceRow);
      }
      if (Array.isArray(node.resourceBlockers) && node.resourceBlockers.length) body.appendChild(el('div', 'agent-resource-wait', `被 ${node.resourceBlockers.map(b => b.group).join(', ')} 占用`));
      if (node.isolation && node.isolation.mode === 'worktree') {
        const iso = el('div', `agent-isolation ai-${node.isolation.status || 'unknown'}`);
        const shortCommit = node.isolation.commit ? String(node.isolation.commit).slice(0, 10) : '';
        iso.appendChild(el('span', 'agent-isolation-status', `隔离工作树：${node.isolation.status || 'unknown'}${shortCommit ? ` · ${shortCommit}` : ''}`));
        if (!run.live && node.isolation.status === 'ready' && node.isolation.commit) {
          const apply = el('button', 'mini primary', '应用到当前工作区'); apply.setAttribute('aria-label', `应用节点 ${node.id} 的隔离工作树`);
          apply.onclick = () => agentRunAction(run.id, 'apply_isolation', { nodeId: node.id });
          iso.appendChild(apply);
        }
        if (Array.isArray(node.isolation.changeSummary) && node.isolation.changeSummary.length) iso.appendChild(el('pre', 'agent-isolation-changes', node.isolation.changeSummary.join('\n')));
        body.appendChild(iso);
      }
      if (Array.isArray(node.progressLog) && node.progressLog.length) {
        const prog = el('div', 'agent-node-progress');
        prog.appendChild(el('div', 'agent-progress-title', '最近进展'));
        for (const item of node.progressLog.slice(-12)) prog.appendChild(el('div', 'agent-progress-line', `${item.at ? new Date(item.at).toLocaleTimeString() + ' · ' : ''}${item.text || ''}`));
        body.appendChild(prog);
      }
      // 结果/错误摘要：pre + textContent（el 内部用 textContent，XSS 安全，绝不 innerHTML）。
      if (node.result) body.appendChild(el('pre', 'agent-node-result', node.result));
      if (Array.isArray(node.schemaErrors) && node.schemaErrors.length) body.appendChild(el('pre', 'agent-node-error', `Schema: ${node.schemaErrors.join('; ')}`));
      if (node.error) body.appendChild(el('pre', 'agent-node-error', node.error));
      // ── 失败一键处置（§5.3）：非运行态给「仅重试此节点」「重试此节点及下游」；失败/判否节点另给「查看错误」。
      //    retry_node wire 到 POST /api/agent-runs/:id（action: retry_node，服务器要求 run 非 live）。 ──
      if (!run.live) {
        const actions = el('div', 'agent-node-actions');
        const retry = el('button', 'mini', '仅重试此节点'); retry.setAttribute('aria-label', `仅重试节点 ${node.id}`); retry.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: false });
        const cascade = el('button', 'mini', '重试此节点及下游'); cascade.setAttribute('aria-label', `重试节点 ${node.id} 及其下游`); cascade.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: true });
        actions.append(retry, cascade);
        if ((disp === 'failed' || disp === 'rejected') && (node.error || (Array.isArray(node.schemaErrors) && node.schemaErrors.length))) {
          const viewErr = el('button', 'mini', '查看错误'); viewErr.setAttribute('aria-label', `查看节点 ${node.id} 的错误`);
          viewErr.onclick = () => { row.open = true; const errEl = body.querySelector('.agent-node-error'); if (errEl) errEl.scrollIntoView({ block: 'nearest' }); };
          actions.appendChild(viewErr);
        }
        body.appendChild(actions);
      }
      // v1 定向插话（steer）：对 live run 中运行/排队/等待资源的非 Claude 引擎节点给一个「插话」按钮。Claude 引擎
      // 节点是 -p 单发进程，任务写入后 stdin 即关，无迭代边界可注入，故不提供（与后端 steer_node 拒绝一致）。
      // vote/dedupe 质量门节点是确定性短路，从不调用模型、没有迭代边界会消费插话队列，同样不提供（与后端一致）。
      const isDeterministicGate = node.gate && ['vote', 'dedupe'].includes(node.gate.mode);
      if (run.live && ['running', 'queued', 'waiting_resource'].includes(node.status) && (node.engine || 'openai') !== 'claude' && !isDeterministicGate) {
        const steerActions = el('div', 'agent-node-actions');
        const steer = el('button', 'mini', '插话'); steer.setAttribute('aria-label', `对节点 ${node.id} 插话`);
        steer.onclick = () => steerAgentNode(run.id, node.id, node.status);
        steerActions.appendChild(steer);
        body.appendChild(steerActions);
      }
      row.appendChild(body); graph.appendChild(row);
    }
    card.appendChild(graph); host.appendChild(card);
  }
}
async function loadAgentRuns() {
  const sid = state.currentSession?.id; const host = $('agentRunsList'); if (!host) return;
  if (!sid) { renderAgentRuns([]); return; }
  try {
    const r = await api(`/api/agent-runs?sessionId=${encodeURIComponent(sid)}`);
    const runs = Array.isArray(r.runs) ? r.runs : [];
    renderAgentRuns(runs);
    wbOnRuns(runs); // v3 P3a:同一份轮询数据喂工作台画布(缓存 + 亮点标 + 画布态重绘),不新增请求
    const finishedWithSummary = runs.find(run => run && run.summary && !run.live && !AGENT_RUN_ACTIVE.has(run.status) && !agentRunSummarySeen.has(`${sid}:${run.id}`));
    if (finishedWithSummary) {
      agentRunSummarySeen.add(`${sid}:${finishedWithSummary.id}`);
      const fresh = await api(`/api/sessions/${encodeURIComponent(sid)}`).catch(() => null);
      if (fresh && fresh.session && state.currentSession?.id === sid) { state.currentSession = fresh.session; renderCurrentSession(); renderSessions(); }
    }
  }
  catch (e) { host.textContent = `加载失败：${apiErrText(e)}`; }
}
// v3 P3a:轮询期望态由「监控页签激活」∪「工作台画布视图激活」共同决定 —— 画布复用同一份 2s 轮询(loadAgentRuns
// 内联刷新画布),不新增请求。tab 参数保留兼容既有 switchTab 调用点;实际期望态从 DOM(激活页签)+ wbState 派生。
function agentRunsPollWanted() {
  const tabActive = !!document.querySelector('.tool-pane .tool-tabs button[data-tab="agent-runs"].active');
  return tabActive || (typeof wbState !== 'undefined' && wbState.view === 'canvas');
}
function syncAgentRunsPolling() {
  if (agentRunsPoll) { clearInterval(agentRunsPoll); agentRunsPoll = null; }
  if (agentRunsPollWanted()) { loadAgentRuns(); agentRunsPoll = setInterval(loadAgentRuns, 2000); }
}
function updateAgentRunsPolling(tab) { syncAgentRunsPolling(); }

/* ============================================================
   UI v3 P3a「工作台」全宽只读画布视图(设计稿 docs/UI-DESIGN-P3-WORKBENCH.md §5;视觉基线
   docs/mockups/p3-workbench-r2.html + R2-NOTES)。P3a 只读范围:
     · 主视图状态机 switchMainView(data-main-view=chat|canvas,localStorage 记忆)
     · 顶部 run chips(复用 /api/agent-runs 轮询数据;live 脉动点 + 待批准池徽标)
     · 只读 DAG 画布:零依赖分层布局(layoutWorkbenchDAG 纯函数,记忆化 DFS + 环保护)
       + SVG 三次贝塞尔连线(源状态着色 + r2 userSpaceOnUse 方向渐变 + 源实点/靶空环端口)
       + 节点卡 220×88(状态徽标/引擎徽标/模型/活动行/迭代条·门 verdict,渗透语言与 P2 同族)
     · 底部用量迷你条(累计 tokens/成本/时长,大数字仪表;点击跳右栏用量页)
     · 空态引导卡 + 节点点击跳右栏监控卡高亮。交互(右板/插话/审批/缩放)留 P3b。
   所有不可信文本走 el()/textContent,绝不 innerHTML(XSS 纪律)。
   ============================================================ */
// 画布布局常量(§5.2 伪码)。V_GAP 取伪码值 64(r2 建议 72 属「需评审」项,未落地伪码,故不采,见交付报告)。
const WB_NODE_W = 220, WB_NODE_H = 88, WB_H_GAP = 48, WB_V_GAP = 64, WB_PAD = 32;

// 纯函数:零依赖分层布局。输入 nodes 数组(含 id / dependsOn),输出 {id:{x,y,cx,layer}}。
// 记忆化 DFS 拓扑分层(层号 = 1 + max(依赖层号),无依赖 = 0)+ 环保护(成环回退层 0,防御编辑器已禁的环);
// 层内按 nodes 原序均布、居中对称(稳定不抖动);只认存在的依赖(忽略悬空/自指)。复杂度 O(V+E)。
function layoutWorkbenchDAG(nodes) {
  const list = Array.isArray(nodes) ? nodes.filter(n => n && n.id != null) : [];
  const byId = new Map(list.map(n => [n.id, n]));
  const layer = new Map();
  function computeLayer(id, visiting) {
    if (layer.has(id)) return layer.get(id);
    if (visiting.has(id)) return 0;                     // 环保护:成环节点回退层 0
    visiting.add(id);
    const node = byId.get(id);
    const deps = (node && Array.isArray(node.dependsOn) ? node.dependsOn : []).filter(d => byId.has(d) && d !== id);
    const L = deps.length ? 1 + Math.max(...deps.map(d => computeLayer(d, visiting))) : 0;
    visiting.delete(id);
    layer.set(id, L);
    return L;
  }
  for (const n of list) computeLayer(n.id, new Set());
  // 层内分组(保持原序 → 稳定不抖动)。
  const byLayer = new Map();
  for (const n of list) { const L = layer.get(n.id); if (!byLayer.has(L)) byLayer.set(L, []); byLayer.get(L).push(n); }
  let maxWidth = 0;
  for (const arr of byLayer.values()) { const w = arr.length * WB_NODE_W + (arr.length - 1) * WB_H_GAP; if (w > maxWidth) maxWidth = w; }
  const centerX = WB_PAD + maxWidth / 2;
  const pos = {};
  for (const L of [...byLayer.keys()].sort((a, b) => a - b)) {
    const arr = byLayer.get(L); const n = arr.length;
    const rowW = n * WB_NODE_W + (n - 1) * WB_H_GAP;
    const x0 = centerX - rowW / 2;
    const y = WB_PAD + L * (WB_NODE_H + WB_V_GAP);
    for (let i = 0; i < n; i++) { const x = x0 + i * (WB_NODE_W + WB_H_GAP); pos[arr[i].id] = { x, y, cx: x + WB_NODE_W / 2, layer: L }; }
  }
  return pos;
}
// preview/调试可及(同 window.state 兼容层):供 eval 单测直接调分层函数断言层号/坐标。
try { window.layoutWorkbenchDAG = layoutWorkbenchDAG; } catch { /* ignore */ }

// P3a 视图状态(§5.3)。selectedRunId 决定画布画哪个 run;lastRuns 缓存最近一次轮询数据供切视图即时重绘;
// posCache 按 run 记忆布局(拓扑签名不变则复用坐标 → 状态/进度变化时节点不抖动)。
// v3 P3b 追加交互态:zoom(画布缩放挡位)/panelOpen(右板三段折叠记忆,轮询重绘不丢)/sideOpen(窄屏抽屉开合)。
const wbState = { view: 'chat', selectedRunId: null, selectedNodeId: null, lastRuns: [], posCache: {}, zoom: 1, panelOpen: { detail: true, pool: true, mail: true }, detailExpand: { task: false, result: false }, sideOpen: false };
try { window.wbState = wbState; } catch { /* ignore */ } // preview/调试可及(同 window.state 兼容层)
// v3 P3b 缩放挡位(§5.4:0.75/1/1.25;画布只读，整容器 CSS transform:scale，坐标系不变，无指针耦合)。
const WB_ZOOM_GEARS = [0.75, 1, 1.25];
// 窄屏(<1180)右板走抽屉:点节点/手动开合从右滑出;≤760 全宽浮层。matchMedia 判定，SSR/无 window 时防御回退。
function wbIsNarrow() { try { return window.matchMedia('(max-width: 1180px)').matches; } catch { return false; } }
const WB_SVGNS = 'http://www.w3.org/2000/svg';
function wbSvg(tag, attrs) { const e = document.createElementNS(WB_SVGNS, tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
// run 友好名:runs 目前不持久化 title(见 server.js run 对象),回退占位 + 由 id chip 承载唯一标识。
function wbRunName(run) { return (run && (run.title || run.workflowTitle || run.label)) || '工作流'; }
// 首个活动 run(无则首个)作为默认选中。
function wbPickDefaultRun(runs) {
  const arr = Array.isArray(runs) ? runs : [];
  const active = arr.find(r => AGENT_RUN_ACTIVE.has(r.status));
  return (active || arr[0] || {}).id || null;
}
// 拓扑签名(id + dependsOn)—— 不变则复用缓存坐标,防轮询重排时节点抖动。
function wbTopoSig(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map(n => `${n.id}<${(Array.isArray(n.dependsOn) ? n.dependsOn : []).join('|')}`).join(';');
}
function wbLayoutFor(run) {
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const sig = wbTopoSig(nodes);
  const cached = wbState.posCache[run.id];
  if (cached && cached.sig === sig) return cached.pos;   // 拓扑未变 → 复用位置(id 记忆,防抖动)
  const pos = layoutWorkbenchDAG(nodes);
  wbState.posCache[run.id] = { sig, pos };
  return pos;
}
// 主视图状态机:切 data-main-view + tab 激活态 + localStorage 记忆;进画布启轮询并即时重绘,离开按需停轮询。
function switchMainView(v) {
  v = (v === 'canvas') ? 'canvas' : 'chat';
  wbState.view = v;
  const pane = document.querySelector('.chat-pane');
  if (pane) pane.setAttribute('data-main-view', v);
  document.querySelectorAll('.wb-mainview-tabs .wb-mv-tab').forEach(b => {
    const on = b.dataset.mainView === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  try { localStorage.setItem('wcw.mainView', v); } catch { /* ignore */ }
  if (v === 'canvas') {
    if (!wbState.selectedRunId) wbState.selectedRunId = wbPickDefaultRun(wbState.lastRuns);
    renderWorkbench(wbState.lastRuns);
  }
  syncAgentRunsPolling(); // 复用 agent-runs 轮询:画布态需要它,离开则按监控页签是否激活决定停/留
}
function restoreMainView() {
  let v = 'chat'; try { v = localStorage.getItem('wcw.mainView') || 'chat'; } catch { /* ignore */ }
  switchMainView(v === 'canvas' ? 'canvas' : 'chat');
}
// 主 Tab「工作台」在有活动 run 时亮点标(每次轮询刷新调用)。
function wbUpdateActivityDot(runs) {
  const tab = $('mainViewTabCanvas'); if (!tab) return;
  tab.classList.toggle('has-activity', (Array.isArray(runs) ? runs : []).some(r => AGENT_RUN_ACTIVE.has(r.status)));
}
// 画布数据入口(loadAgentRuns 每轮调用):缓存 runs、刷新亮点标,画布态则重绘。
function wbOnRuns(runs) {
  wbState.lastRuns = Array.isArray(runs) ? runs : [];
  wbUpdateActivityDot(wbState.lastRuns);
  if (wbState.view === 'canvas') renderWorkbench(wbState.lastRuns);
}
// 渲染分派:校正选中 run → runbar + 画布 + 右板 + 用量条;无 run → 空态。
function renderWorkbench(runs) {
  const arr = Array.isArray(runs) ? runs : [];
  let run = arr.find(r => r.id === wbState.selectedRunId);
  if (!run) { wbState.selectedRunId = wbPickDefaultRun(arr); run = arr.find(r => r.id === wbState.selectedRunId); }
  renderWorkbenchRunbar(arr, wbState.selectedRunId);
  if (!run) { renderWorkbenchEmpty(); return; }
  // 选中节点若已不在当前 run(切 run/节点被移除)则清空,避免右板串到别的 run 的节点。
  if (wbState.selectedNodeId && !(Array.isArray(run.nodes) ? run.nodes : []).some(n => n.id === wbState.selectedNodeId)) wbState.selectedNodeId = null;
  renderWorkbenchCanvas(run);
  renderWorkbenchSide(run);
  renderWorkbenchUsage(run);
}
// 当前选中 run(供缩放/适应视图重绘时取数)。
function wbCurrentRun() { return (Array.isArray(wbState.lastRuns) ? wbState.lastRuns : []).find(r => r.id === wbState.selectedRunId) || null; }
// ① Run 选择器 chips。状态点(live 脉动)+ id + 状态词 +(完成 ✦)+ 待批准池徽标;点击切画布。
function renderWorkbenchRunbar(runs, selectedRunId) {
  const bar = $('wbRunbar'); if (!bar) return;
  bar.textContent = '';
  if (!runs.length) return;
  const label = el('span', 'wb-rb-label'); label.appendChild(el('span', 'wb-rb-cloud')); label.appendChild(document.createTextNode('运行'));
  bar.appendChild(label);
  for (const run of runs) {
    const st = AGENT_RUN_ACTIVE.has(run.status) ? 'running' : (run.status === 'succeeded' ? 'succeeded' : ((run.status === 'failed' || run.status === 'rejected') ? 'failed' : 'other'));
    const on = run.id === selectedRunId;
    const chip = el('button', `wb-chip wb-st-${st}${on ? ' active' : ''}`);
    chip.setAttribute('role', 'tab'); chip.setAttribute('aria-selected', on ? 'true' : 'false');
    chip.appendChild(el('span', 'wb-rc-dot'));
    chip.appendChild(document.createTextNode(wbRunName(run) + ' '));
    chip.appendChild(el('span', 'wb-rc-id', run.id));
    if (run.status === 'succeeded') chip.appendChild(el('span', 'wb-rc-gold', '✦'));
    chip.appendChild(el('span', 'wb-rc-st', agentRunStatusLabel(run.status)));
    const proposed = Array.isArray(run.taskPool) ? run.taskPool.filter(p => p && p.status === 'proposed') : [];
    if (proposed.length) chip.appendChild(el('span', 'wb-rc-pool num', `待批准 ${proposed.length}`));
    chip.onclick = () => { wbState.selectedRunId = run.id; wbState.selectedNodeId = null; renderWorkbench(wbState.lastRuns); };
    bar.appendChild(chip);
  }
}
// 边着色分类(按源节点显示状态)。
function wbEdgeKind(srcDisp) {
  if (srcDisp === 'running') return 'run';
  if (srcDisp === 'rejected') return 'reject';
  if (srcDisp === 'waiting_resource' || srcDisp === 'blocked' || srcDisp === 'paused') return 'wait';
  if (srcDisp === 'failed') return 'fail';
  if (srcDisp === 'succeeded' || srcDisp === 'degraded') return 'done';
  return 'idle';
}
function wbEdgeColor(kind) {
  return kind === 'run' ? 'var(--accent)' : (kind === 'reject' || kind === 'wait') ? 'var(--warn)' : kind === 'fail' ? 'var(--danger)' : kind === 'done' ? 'var(--ok)' : 'var(--line-2)';
}
// ② 只读画布:分层布局 → 缩放容器 .wb-canvas-inner(节点 + SVG 同容器整体 CSS transform:scale，坐标系不变，
//    点击命中随视觉变换，无编辑器那种指针坐标耦合)。外层 .wb-canvas 尺寸 = 内容 × zoom，撑出正确滚动区。
//    轮询重绘保留滚动位置(避免 2s 一跳)+ 右下缩放胶囊(0.75/1/1.25 挡 + 适应视图)+ 泳道层淡标签(§5.4)。
function renderWorkbenchCanvas(run) {
  const wrap = $('wbCanvasWrap'); if (!wrap) return;
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const pos = wbLayoutFor(run);
  let maxRight = 0, maxBottom = 0;
  for (const n of nodes) { const p = pos[n.id]; if (!p) continue; maxRight = Math.max(maxRight, p.x + WB_NODE_W); maxBottom = Math.max(maxBottom, p.y + WB_NODE_H); }
  const W = Math.max(WB_NODE_W + WB_PAD * 2, maxRight + WB_PAD);
  const H = Math.max(WB_NODE_H + WB_PAD * 2, maxBottom + WB_PAD);
  const z = wbState.zoom || 1;
  const prevSL = wrap.scrollLeft, prevST = wrap.scrollTop;   // 保留滚动位置，轮询重绘不跳
  wrap.textContent = '';
  const canvas = el('div', 'wb-canvas'); canvas.style.width = `${(W * z).toFixed(0)}px`; canvas.style.height = `${(H * z).toFixed(0)}px`;
  const inner = el('div', 'wb-canvas-inner'); inner.style.width = `${W}px`; inner.style.height = `${H}px`; inner.style.transform = `scale(${z})`;
  inner.appendChild(wbBuildEdges(run, nodes, pos, W, H));
  wbBuildLayerTags(nodes, pos).forEach(t => inner.appendChild(t));
  for (const node of nodes) { const p = pos[node.id]; if (p) inner.appendChild(wbBuildNode(run, node, p)); }
  canvas.appendChild(inner);
  wrap.appendChild(canvas);
  wrap.scrollLeft = prevSL; wrap.scrollTop = prevST;
  // 缩放胶囊挂到非滚动的 .wb-main(而非滚动的画布容器)→ 滚动画布时胶囊固定在右下不跟着跑。单实例:先移除旧的。
  const main = wrap.parentElement;
  if (main) { const old = main.querySelector(':scope > .wb-cvtools'); if (old) old.remove(); main.appendChild(wbBuildZoomCapsule()); }
}
// 泳道层淡标签(§5.4):每层一个「第 N 层」淡 pill，落在该层行上缘的空隙带(gap/pad 区)，左对齐 —— 节点行居中
// 排布、左侧留白，标签置于行**上方**空隙 → 垂直方向与节点不同带，避开重叠;随内容一起缩放(在 .wb-canvas-inner 内)。
function wbBuildLayerTags(nodes, pos) {
  const layers = new Map();   // layer -> 该层最小 y(行上缘)
  for (const n of nodes) { const p = pos[n.id]; if (!p) continue; if (!layers.has(p.layer) || p.y < layers.get(p.layer)) layers.set(p.layer, p.y); }
  const out = [];
  for (const [L, y] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    const tag = el('div', 'wb-layer-tag num', `第 ${L} 层`);
    tag.style.left = '8px'; tag.style.top = `${Math.max(2, y - 22)}px`;   // 行上缘上方空隙带
    tag.setAttribute('aria-hidden', 'true');
    out.push(tag);
  }
  return out;
}
// 右下缩放胶囊(§5.4):− / 读数 / ＋ / 适应视图。挡位循环 0.75/1/1.25;适应视图取能容下的最大挡并居中滚动。
function wbBuildZoomCapsule() {
  const z = wbState.zoom || 1;
  const cap = el('div', 'wb-cvtools'); cap.setAttribute('role', 'group'); cap.setAttribute('aria-label', '画布缩放');
  const idx = WB_ZOOM_GEARS.indexOf(z);
  const minus = el('button', 'wb-cv-btn', '−'); minus.title = '缩小'; minus.setAttribute('aria-label', '缩小');
  minus.disabled = idx <= 0; minus.onclick = () => wbSetZoom(WB_ZOOM_GEARS[Math.max(0, (idx < 0 ? 1 : idx) - 1)]);
  const read = el('span', 'wb-cv-zoom num', `${Math.round(z * 100)}%`);
  const plus = el('button', 'wb-cv-btn', '＋'); plus.title = '放大'; plus.setAttribute('aria-label', '放大');
  plus.disabled = idx >= WB_ZOOM_GEARS.length - 1; plus.onclick = () => wbSetZoom(WB_ZOOM_GEARS[Math.min(WB_ZOOM_GEARS.length - 1, (idx < 0 ? 1 : idx) + 1)]);
  const fit = el('button', 'wb-cv-btn wb-cv-fit', '⤢'); fit.title = '适应视图'; fit.setAttribute('aria-label', '适应视图');
  fit.onclick = () => wbFitView();
  cap.append(minus, read, plus, fit);
  return cap;
}
// 设挡位并重绘(挡位吸附到 WB_ZOOM_GEARS 之一)。
function wbSetZoom(z) {
  const snap = WB_ZOOM_GEARS.reduce((a, g) => Math.abs(g - z) < Math.abs(a - z) ? g : a, WB_ZOOM_GEARS[1]);
  wbState.zoom = snap;
  const run = wbCurrentRun(); if (run) renderWorkbenchCanvas(run);
}
// 适应视图:按画布包围盒挑能容下宽度的最大挡位，重绘后水平居中滚动(纵向 DAG 顶对齐)。
function wbFitView() {
  const wrap = $('wbCanvasWrap'); const run = wbCurrentRun(); if (!wrap || !run) return;
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const pos = wbLayoutFor(run);
  let maxRight = 0; for (const n of nodes) { const p = pos[n.id]; if (p) maxRight = Math.max(maxRight, p.x + WB_NODE_W); }
  const W = Math.max(WB_NODE_W + WB_PAD * 2, maxRight + WB_PAD);
  const avail = Math.max(0, wrap.clientWidth - 24);
  const ratio = avail / W;
  let gear = WB_ZOOM_GEARS[0];
  for (const g of WB_ZOOM_GEARS) if (g <= ratio) gear = g;     // 能容下的最大挡；都容不下则最小挡 0.75
  wbState.zoom = gear;
  renderWorkbenchCanvas(run);
  wrap.scrollLeft = Math.max(0, (W * gear - wrap.clientWidth) / 2);   // 水平居中
  wrap.scrollTop = 0;
}
// SVG 边层:每条边一个 userSpaceOnUse 方向渐变(源色 → --line-2 沿依赖方向衰减)+ 源实点/靶空环端口。
function wbBuildEdges(run, nodes, pos, W, H) {
  const svg = wbSvg('svg', { class: 'wb-edges', viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
  const defs = wbSvg('defs'); svg.appendChild(defs);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ports = [];
  let gi = 0;
  for (const node of nodes) {
    const to = pos[node.id]; if (!to) continue;
    for (const depId of (Array.isArray(node.dependsOn) ? node.dependsOn : [])) {
      const from = pos[depId]; const src = byId.get(depId); if (!from || !src) continue;
      const fx = from.cx, fy = from.y + WB_NODE_H, tx = to.cx, ty = to.y;       // 源底缘中点 → 靶顶缘中点
      const dy = (ty - fy) * 0.5;                                               // 控制点落中垂线(§5.2)
      const d = `M${fx.toFixed(1)},${fy.toFixed(1)} C${fx.toFixed(1)},${(fy + dy).toFixed(1)} ${tx.toFixed(1)},${(ty - dy).toFixed(1)} ${tx.toFixed(1)},${ty.toFixed(1)}`;
      const kind = wbEdgeKind(nodeDisplayStatus(src));
      const gid = `wbg-${run.id}-${gi++}`;
      const grad = wbSvg('linearGradient', { id: gid, gradientUnits: 'userSpaceOnUse', x1: fx.toFixed(1), y1: fy.toFixed(1), x2: tx.toFixed(1), y2: ty.toFixed(1) });
      const near = wbSvg('stop', { offset: '0' }); near.setAttribute('style', `stop-color:${wbEdgeColor(kind)}`);
      const far = wbSvg('stop', { offset: '1' }); far.setAttribute('style', 'stop-color:var(--line-2)');
      grad.append(near, far); defs.appendChild(grad);
      svg.appendChild(wbSvg('path', { class: `wb-edge wb-e-${kind}`, d, stroke: `url(#${gid})`, 'data-from': depId, 'data-to': node.id }));
      ports.push(['src', fx, fy, kind], ['dst', tx, ty, kind]);
    }
  }
  for (const [k, x, y, kind] of ports) {
    if (k === 'src') { const c = wbSvg('circle', { class: 'wb-port src', cx: x.toFixed(1), cy: y.toFixed(1), r: '2.6' }); c.setAttribute('style', `fill:${wbEdgeColor(kind)}`); svg.appendChild(c); }
    else svg.appendChild(wbSvg('circle', { class: 'wb-port dst', cx: x.toFixed(1), cy: y.toFixed(1), r: '3.2' }));
  }
  return svg;
}
// 节点卡 220×88(渗透语言,与 P2 监控卡同族;运行态脉动 + glow)。字段全复用 renderAgentRuns 同源纯函数。
function wbBuildNode(run, node, p) {
  const disp = nodeDisplayStatus(node);
  const card = el('div', `wb-node wb-st-${disp}${node.id === wbState.selectedNodeId ? ' selected' : ''}`);
  card.dataset.runId = run.id; card.dataset.nodeId = node.id;
  card.style.left = `${p.x}px`; card.style.top = `${p.y}px`;
  card.setAttribute('role', 'button'); card.tabIndex = 0;
  card.setAttribute('aria-label', `节点 ${node.id} · ${agentRunStatusLabel(disp)}(点击定位到监控卡)`);
  // 头:状态徽标 + 标题(id·角色) + 引擎徽标
  const hd = el('div', 'wb-node-hd');
  hd.appendChild(el('span', 'wb-badge', agentStatusIcon(disp)));
  const title = el('span', 'wb-node-title');
  const idb = el('b'); idb.textContent = node.id; title.appendChild(idb);
  if (node.roleLabel || node.roleId) title.appendChild(el('span', 'role', ` · ${node.roleLabel || node.roleId}`));
  hd.appendChild(title);
  const eng = agentEngineBadge(node.engine); if (eng) { eng.classList.add('wb-eng-inline'); hd.appendChild(eng); }
  card.appendChild(hd);
  // 模型名(muted;无则省)
  if (node.model) card.appendChild(el('div', 'wb-node-model', node.model));
  // 活动行:progressLog 末条(运行/等待态显,succeeded/skipped 不显)
  const plog = Array.isArray(node.progressLog) ? node.progressLog : [];
  const last = plog.length ? plog[plog.length - 1] : null;
  const activeState = node.status === 'running' || node.status === 'waiting_resource';
  if (last && last.text && node.status !== 'succeeded' && node.status !== 'skipped') {
    const act = el('div', `wb-node-act${(disp === 'rejected' || disp === 'waiting_resource' || disp === 'failed') ? ' warn' : ''}`);
    if (activeState) act.appendChild(el('span', 'wb-act-dot', '◐'));
    act.appendChild(el('span', 'wb-act-text', last.text));
    card.appendChild(act);
  }
  // 底行(择一):门 verdict + 置信度 / 迭代·循环条 / 依赖·状态词
  const foot = el('div', 'wb-node-foot');
  const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
  let budgetLabel = '', budgetCur = 0, budgetMax = 0;
  if (node.loop) { budgetLabel = '循环'; budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
  else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = '迭代'; budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
  if (verdict) {
    const v = String(verdict).toLowerCase();
    foot.appendChild(el('span', `wb-verdict ${v === 'pass' ? 'pass' : 'fail'}`, `判定 ${verdict}`));
    if (node.confidence != null && Number.isFinite(Number(node.confidence))) foot.appendChild(el('span', 'wb-foot-label num', `置信度 ${(Number(node.confidence) * 100).toFixed(0)}%`));
  } else if (budgetMax > 0) {
    const bar = el('div', 'wb-bar'); const i = el('i'); i.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(i); foot.appendChild(bar);
    foot.appendChild(el('span', 'wb-foot-label num', `${budgetLabel} ${budgetCur}/${budgetMax}`));
  } else {
    const deps = Array.isArray(node.dependsOn) && node.dependsOn.length ? `← 依赖 ${node.dependsOn.join(', ')}` : agentRunStatusLabel(disp);
    foot.appendChild(el('span', 'wb-foot-label', deps));
  }
  card.appendChild(foot);
  // 点击/回车 → 填右板段1「选中节点详情」(P3b:不再 switchTab 跳右栏)。悬停 → 高亮其入/出边(§2.3 依赖链)。
  const go = () => wbFocusRunNode(run.id, node.id);
  card.addEventListener('click', go);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  card.addEventListener('mouseenter', () => wbHighlightChain(node.id, true));
  card.addEventListener('mouseleave', () => wbHighlightChain(node.id, false));
  return card;
}
// 悬停依赖链高亮(§2.3):点亮与该节点相连的入/出边(data-from|data-to 命中),其余边降透明度;移出复原。
function wbHighlightChain(nodeId, on) {
  const edges = document.querySelectorAll('#wbCanvasWrap .wb-edge');
  edges.forEach(e => {
    if (!on) { e.classList.remove('lit', 'dim'); return; }
    const hit = e.getAttribute('data-from') === nodeId || e.getAttribute('data-to') === nodeId;
    e.classList.toggle('lit', hit); e.classList.toggle('dim', !hit);
  });
}
// P3b 节点点击:画布内标选中 + 填充右板段1(选中节点详情),不再跳右栏 agent-runs(取代 P3a 的 switchTab)。
// 窄屏(<1180)则同时把右板抽屉滑出;详情段滚入视野。
function wbFocusRunNode(runId, nodeId) {
  wbState.selectedNodeId = nodeId;
  wbState.detailExpand = { task: false, result: false };
  wbState.panelOpen.detail = true;
  document.querySelectorAll('#wbCanvasWrap .wb-node.selected').forEach(n => n.classList.remove('selected'));
  const card = document.querySelector(`#wbCanvasWrap .wb-node[data-node-id="${CSS.escape(nodeId)}"]`);
  if (card) card.classList.add('selected');
  const run = wbCurrentRun();
  if (run) renderWorkbenchSide(run);
  if (wbIsNarrow()) wbOpenSide(true);
  const sec = document.querySelector('#wbSide .wb-sec[data-sec="detail"]');
  if (sec) sec.scrollIntoView({ block: 'nearest' });
}
// 窄屏右板抽屉开合:切 .wb-view 上的状态类 + backdrop 显隐(≥1180 常驻，此开关无副作用)。
function wbOpenSide(open) {
  wbState.sideOpen = !!open;
  const view = $('workbenchView'); if (view) view.classList.toggle('wb-side-open', !!open);
}
// ④ 底部用量迷你条:本 run 累计 tokens/成本/时长(大数字仪表)。字段缺失显「—」(防御,后端并行落地中)。
function wbRunMetrics(run) {
  const u = (run && (run.usage || run.usageTotals)) || null;
  const tok = (u && (Number(u.input_tokens || 0) + Number(u.output_tokens || 0))) || Number((run && run.totalTokens) || 0) || 0;
  const cost = Number(run && run.costUsd != null ? run.costUsd : run && run.totalCostUsd != null ? run.totalCostUsd : (u && u.costUsd) || 0) || 0;
  return { tok, cost, elapsed: runElapsedMs(run) };
}
function renderWorkbenchUsage(run) {
  const host = $('wbUsage'); if (!host) return;
  host.textContent = '';
  const m = wbRunMetrics(run);
  const runLbl = el('span', 'wb-usage-run');
  if (run.live) runLbl.appendChild(el('span', 'wb-usage-dot'));
  runLbl.appendChild(document.createTextNode(wbRunName(run) + ' '));
  runLbl.appendChild(el('span', 'wb-rc-id', run.id));
  host.appendChild(runLbl);
  const metrics = el('div', 'wb-usage-metrics');
  const um = (big, unit, lbl) => { const box = el('div', 'wb-um'); const b = el('b', 'num', big); if (unit) b.appendChild(el('span', 'wb-um-u', unit)); box.appendChild(b); box.appendChild(el('span', 'wb-um-lbl', lbl)); return box; };
  metrics.appendChild(um(m.tok ? fmtTokens(m.tok) : '—', m.tok ? 'tok' : '', '令牌'));
  metrics.appendChild(el('div', 'wb-um-sep'));
  metrics.appendChild(um(m.cost ? `$${m.cost.toFixed(m.cost < 1 ? 4 : 2)}` : '—', '', '成本'));
  metrics.appendChild(el('div', 'wb-um-sep'));
  metrics.appendChild(um(m.elapsed ? fmtDuration(m.elapsed) : '—', '', run.live ? '已运行' : '用时'));
  host.appendChild(metrics);
  const link = el('button', 'wb-usage-link', '查看用量看板 →');
  link.setAttribute('aria-label', '跳转到右栏用量看板');
  link.onclick = () => { openToolPane(); switchTab('usage'); };
  host.appendChild(link);
}
// ⑤ 空态:无 run → 画布区居中引导卡(云纹水印 + 「去对话交办任务」/「从模板运行」);同时清空 chips/用量条/右板。
function renderWorkbenchEmpty() {
  const runbar = $('wbRunbar'); if (runbar) runbar.textContent = '';
  const usage = $('wbUsage'); if (usage) usage.textContent = '';
  const side = $('wbSide'); if (side) side.textContent = '';   // 右板清空 → .wb-main :has(:empty) 收单列，无空右条
  wbOpenSide(false);
  const wrap = $('wbCanvasWrap'); if (!wrap) return;
  wrap.textContent = '';
  const box = el('div', 'wb-empty');
  box.appendChild(el('div', 'wb-empty-cloud'));
  box.appendChild(el('div', 'wb-empty-title', '本会话还没有 Agent 工作流'));
  box.appendChild(el('div', 'wb-empty-sub', '交办一个多 Agent 任务，这里会实时画出它们的协作图 —— 谁在跑、跑到哪、卡在哪。'));
  const acts = el('div', 'wb-empty-acts');
  const goChat = el('button', 'wb-empty-btn primary', '去对话交办任务');
  goChat.onclick = () => { switchMainView('chat'); const pi = $('promptInput'); if (pi) pi.focus(); };
  const goTpl = el('button', 'wb-empty-btn', '从模板运行');
  goTpl.onclick = () => { openToolPane(); switchTab('agent-runs'); };
  acts.append(goChat, goTpl);
  box.appendChild(acts);
  wrap.appendChild(box);
}

/* ============================================================
   UI v3 P3b「工作台」交互完整版:右侧三段折叠板(选中节点详情 / 任务池审批 / 邮箱消息流)+ 节点插话 +
   缩放/适应视图/泳道层标 + 响应式抽屉。设计稿 §5.4 / §6#5-#8/#10 + 视觉基线 p3-workbench-r2.html 右三段板。
   数据 100% 复用轮询下发的 run.nodes/taskPool/messages;动作复用 steer_node / retry_node / pool_approve|reject。
   所有不可信文本走 el()/textContent(XSS 纪律,绝不 innerHTML)。轮询 2s 重绘:段折叠态记忆于 wbState.panelOpen、
   插话输入焦点+文本跨重绘保留(防打字被冲掉)。
   ============================================================ */
// ③ 右侧三段折叠板渲染。轮询每 2s 调用 → 重建;段开合读 wbState.panelOpen(记忆),插话输入焦点/值跨重绘保留。
function renderWorkbenchSide(run) {
  const host = $('wbSide'); if (!host) return;
  // 保留插话框焦点 + 文本 + 光标(2s 轮询重绘不打断打字)。
  const ae = document.activeElement;
  const keepSteer = ae && ae.id === 'wbSteerInput';
  const steerVal = keepSteer ? ae.value : null;
  const caret = keepSteer ? ae.selectionStart : null;
  host.textContent = '';
  // 窄屏抽屉的关闭按钮(≥1180 由 CSS 隐藏;抽屉态点它或点 backdrop 关闭)。
  const close = el('button', 'wb-side-close', '收起 ✕'); close.setAttribute('aria-label', '收起上下文板抽屉'); close.onclick = () => wbOpenSide(false); host.appendChild(close);
  const nodes = Array.isArray(run.nodes) ? run.nodes : [];
  const sel = wbState.selectedNodeId ? nodes.find(n => n.id === wbState.selectedNodeId) : null;
  const proposed = (Array.isArray(run.taskPool) ? run.taskPool : []).filter(p => p && p.status === 'proposed');
  const mails = Array.isArray(run.messages) ? run.messages : [];
  host.appendChild(wbSection('detail', '选中节点详情', sel ? { text: sel.id } : null, wbNodeDetailBody(run, sel)));
  host.appendChild(wbSection('pool', '任务池审批', proposed.length ? { text: `待批准 ${proposed.length}`, warn: true } : ((run.taskPool || []).length ? { text: String((run.taskPool || []).length) } : null), wbPoolBody(run)));
  host.appendChild(wbSection('mail', '邮箱消息流', mails.length ? { text: String(mails.length) } : null, wbMailBody(run)));
  if (keepSteer) { const inp = $('wbSteerInput'); if (inp) { inp.value = steerVal; inp.focus(); try { inp.setSelectionRange(caret, caret); } catch { /* ignore */ } } }
}
// 折叠段外壳:头(caret + 标题 + 计数徽标)+ 体。头点击切 wbState.panelOpen[key] 并就地开合(不整板重绘,防抖动)。
function wbSection(key, title, count, bodyNode) {
  const open = wbState.panelOpen[key] !== false;
  const sec = el('section', `wb-sec${open ? ' open' : ''}`); sec.dataset.sec = key;
  const hd = el('button', 'wb-sec-hd'); hd.setAttribute('aria-expanded', open ? 'true' : 'false');
  hd.appendChild(el('span', 'wb-sec-caret', '▸'));
  hd.appendChild(el('span', 'wb-sec-title', title));
  if (count && count.text) hd.appendChild(el('span', `wb-sec-count num${count.warn ? ' warn' : ''}`, count.text));
  hd.onclick = () => { const nowOpen = !sec.classList.contains('open'); wbState.panelOpen[key] = nowOpen; sec.classList.toggle('open', nowOpen); hd.setAttribute('aria-expanded', nowOpen ? 'true' : 'false'); };
  sec.appendChild(hd);
  const body = el('div', 'wb-sec-body'); if (bodyNode) body.appendChild(bodyNode);
  sec.appendChild(body);
  return sec;
}
// 段1 体:选中节点详情(id/角色/引擎/模型/状态/计时/迭代·门 verdict+置信度环/进度时间线/task 全文/结果·错误)
//   + 插话框(资格判定,§6#6)+ 重试入口(非 live)。无选中 → 占位提示。
function wbNodeDetailBody(run, node) {
  if (!node) { const ph = el('div', 'wb-det-empty', '点击画布中的节点，这里显示它的模型、进度、门判定与操作。'); return ph; }
  const disp = nodeDisplayStatus(node);
  const box = el('div', 'wb-det');
  // 头:标题(角色/id) + 引擎徽标 + 模型 chip
  const top = el('div', 'wb-det-top');
  top.appendChild(el('span', 'wb-det-title', node.roleLabel || node.roleId || node.id));
  const eng = agentEngineBadge(node.engine); if (eng) { eng.classList.add('wb-eng-inline'); top.appendChild(eng); }
  if (node.model) top.appendChild(el('span', 'wb-det-model num', node.model));
  box.appendChild(top);
  // 状态行 + 计时
  const strow = el('div', 'wb-det-row');
  strow.appendChild(el('span', 'wb-det-k', '状态'));
  strow.appendChild(el('span', `wb-det-chip wb-st-${disp}`, agentRunStatusLabel(disp)));
  if (node.startedAt) { const st = Date.parse(node.startedAt); if (Number.isFinite(st)) { const active = node.status === 'running' || node.status === 'waiting_resource'; const end = node.completedAt ? Date.parse(node.completedAt) : Date.now(); const dur = fmtDuration(end - st); if (dur) strow.appendChild(el('span', 'wb-det-time num', `${active ? '已运行' : '用时'} ${dur}`)); } }
  box.appendChild(strow);
  // 迭代/循环预算条
  let budgetLabel = '', budgetCur = 0, budgetMax = 0;
  if (node.loop) { budgetLabel = '循环'; budgetCur = node.loopIteration || 0; budgetMax = node.loop.maxIterations || 0; }
  else if (Number.isFinite(Number(node.maxIters))) { budgetLabel = '迭代'; budgetCur = Number(node.iters) || 0; budgetMax = Number(node.maxIters) || 0; }
  if (budgetMax > 0) {
    const row = el('div', 'wb-det-row'); row.appendChild(el('span', 'wb-det-k', budgetLabel));
    const bar = el('div', 'wb-det-bar'); const i = el('i'); i.style.width = `${Math.max(0, Math.min(100, Math.round((budgetCur / budgetMax) * 100)))}%`; bar.appendChild(i); row.appendChild(bar);
    row.appendChild(el('span', 'wb-det-num num', `${budgetCur}/${budgetMax}`)); box.appendChild(row);
  }
  // 门 verdict + 置信度环
  const verdict = node.gateVerdict || (node.structuredResult && node.structuredResult.verdict);
  const hasConf = node.confidence != null && Number.isFinite(Number(node.confidence));
  if (verdict || hasConf) {
    const row = el('div', 'wb-det-row'); row.appendChild(el('span', 'wb-det-k', '质量门'));
    if (hasConf) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(node.confidence) * 100)));
      const pass = !verdict || String(verdict).toLowerCase() === 'pass';
      const ring = el('div', 'wb-det-ring'); ring.style.setProperty('--deg', `${(pct / 100 * 360).toFixed(1)}deg`); ring.style.setProperty('--ring-col', pass ? 'var(--ok)' : 'var(--warn)');
      ring.appendChild(el('span', 'num', `${pct}%`)); row.appendChild(ring);
    }
    if (verdict) row.appendChild(el('span', `wb-det-verdict ${String(verdict).toLowerCase() === 'pass' ? 'pass' : 'fail'}`, `判定 ${verdict}`));
    box.appendChild(row);
  }
  // 进度时间线(全量 progressLog;末条 live 高亮)
  const plog = Array.isArray(node.progressLog) ? node.progressLog : [];
  if (plog.length) {
    const tl = el('div', 'wb-det-timeline');
    const active = node.status === 'running' || node.status === 'waiting_resource';
    plog.slice(-16).forEach((it, idx, a) => {
      const isLast = idx === a.length - 1;
      const cls = `wb-tl-item${node.status === 'succeeded' || node.status === 'skipped' ? ' done' : (isLast && active ? ' live' : (isLast ? '' : ' done'))}`;
      const item = el('div', cls);
      if (it.at) { const t = new Date(it.at); if (!isNaN(t)) item.appendChild(el('span', 'wb-tl-t num', t.toLocaleTimeString())); }
      item.appendChild(document.createTextNode(it.text || '')); tl.appendChild(item);
    });
    box.appendChild(tl);
  }
  // task 全文
  if (node.task) { const tw = el('details', 'wb-det-task'); tw.appendChild(el('summary', 'wb-det-task-sum', '任务全文')); tw.appendChild(el('pre', 'wb-det-pre', node.task)); tw.open = !!wbState.detailExpand.task; tw.addEventListener('toggle', () => { wbState.detailExpand.task = tw.open; }); box.appendChild(tw); }
  // 插话框(§6#6):live run + 资格判定;不符合显禁用 + 原因(与后端 409 文案一致)。
  box.appendChild(wbSteerBox(run, node));
  // 操作区:非 live 显重试入口(retry_node);失败/判否有错误显查看错误。
  if (!run.live) {
    const acts = el('div', 'wb-det-actions');
    const retry = el('button', 'wb-btn', '重试此节点'); retry.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: false });
    const cascade = el('button', 'wb-btn', '重试及下游'); cascade.onclick = () => agentRunAction(run.id, 'retry_node', { nodeId: node.id, cascade: true });
    acts.append(retry, cascade);
    if ((disp === 'failed' || disp === 'rejected') && (node.error || (Array.isArray(node.schemaErrors) && node.schemaErrors.length))) {
      const view = el('button', 'wb-btn', '查看错误'); view.onclick = () => { const err = box.querySelector('.wb-det-error'); if (err) err.scrollIntoView({ block: 'nearest' }); };
      acts.appendChild(view);
    }
    box.appendChild(acts);
  }
  // 结果 / 错误全文
  if (node.result) { const rw = el('details', 'wb-det-result'); rw.appendChild(el('summary', 'wb-det-task-sum', '查看结果')); rw.appendChild(el('pre', 'wb-det-pre', node.result)); rw.open = !!wbState.detailExpand.result; rw.addEventListener('toggle', () => { wbState.detailExpand.result = rw.open; }); box.appendChild(rw); }
  if (Array.isArray(node.schemaErrors) && node.schemaErrors.length) box.appendChild(el('pre', 'wb-det-pre wb-det-error', `Schema: ${node.schemaErrors.join('; ')}`));
  if (node.error) box.appendChild(el('pre', 'wb-det-pre wb-det-error', node.error));
  return box;
}
// 插话资格判定(§6#6):镜像后端 nodeDeliveryEligibility + run.live 要求。返回 {ok, reason, msg}。禁用文案与
// 服务端 steer_node 409 返回逐字一致(claude_engine / deterministic_gate / terminal),非 live 则整段不出插话框。
function wbSteerEligibility(run, node) {
  if (!run.live) return { ok: false, reason: 'not_live', msg: '' };
  if ((node.engine || 'openai') === 'claude') return { ok: false, reason: 'claude_engine', msg: 'Claude 引擎节点为单发进程，暂不支持中途插话' };
  if (node.gate && ['vote', 'dedupe'].includes(node.gate.mode)) return { ok: false, reason: 'deterministic_gate', msg: '确定性质量门节点不经过模型，无法插话' };
  if (!['running', 'queued', 'waiting_resource'].includes(node.status)) return { ok: false, reason: 'terminal', msg: '节点已结束，无法插话' };
  return { ok: true, reason: 'ok', msg: '' };
}
// 插话框:资格命中显输入 + 发送(复用 steer_node action，内联提交不弹 prompt);不命中显禁用输入 + 原因(与 409 一致);
// 非 live run 不出插话框(返回空文档片段)。
function wbSteerBox(run, node) {
  const elig = wbSteerEligibility(run, node);
  if (elig.reason === 'not_live') return el('span', 'wb-steer-none');
  const wrap = el('div', 'wb-steer');
  wrap.appendChild(el('div', 'wb-steer-label', elig.ok ? '插话（下一次调用前生效）' : '插话不可用'));
  const boxrow = el('div', 'wb-steer-box');
  const input = el('input', 'wb-steer-input'); input.id = 'wbSteerInput'; input.type = 'text';
  input.placeholder = elig.ok ? `给 ${node.id} 补一句指令…` : elig.msg;
  const send = el('button', 'wb-btn primary', '发送');
  if (!elig.ok) { input.disabled = true; send.disabled = true; input.title = elig.msg; }
  else {
    const submit = () => { const t = (input.value || '').trim(); if (!t) return; input.value = ''; steerAgentNode(run.id, node.id, node.status, t); };
    send.onclick = submit;
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  }
  boxrow.append(input, send); wrap.appendChild(boxrow);
  if (!elig.ok) wrap.appendChild(el('div', 'wb-steer-why', elig.msg));   // 禁用原因(与后端 409 文案一致)
  return wrap;
}
// 段2 体:任务池审批(§6#7)。proposed 项 → 三行人话卡(谁提议/做什么/预计消耗)+ 同意添加/不用了(pool_approve|reject)。
//   waiting_pool 宽限窗倒计时细进度条。已决项 → 紧凑状态行。空池 → 占位。
function wbPoolBody(run) {
  const pool = Array.isArray(run.taskPool) ? run.taskPool : [];
  if (!pool.length) return el('div', 'wb-det-empty', '暂无任务池提案。运行中的子代理可提议新增任务，经你审批后加入。');
  const box = el('div', 'wb-pool');
  if (run.status === 'waiting_pool' && run.live) {
    const remainMs = run.poolGraceUntil ? Math.max(0, Number(run.poolGraceUntil) - Date.now()) : 0;
    const grace = el('div', 'wb-pool-grace'); const bar = el('div', 'wb-pool-grace-bar'); const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(100, Math.round((remainMs / POOL_GRACE_HINT_MS) * 100)))}%`; bar.appendChild(fill); grace.appendChild(bar);
    grace.appendChild(el('span', 'wb-pool-grace-label num', `宽限窗剩余 ${Math.round(remainMs / 1000)}s`)); box.appendChild(grace);
  }
  for (const item of pool) {
    if (item.status === 'proposed') {
      const whoNode = (run.nodes || []).find(n => n.id === item.proposedBy);
      const whoLabel = whoNode ? (whoNode.roleLabel || whoNode.id) : (item.proposedBy || '某节点');
      const card = el('div', 'wb-pool-card');
      const who = el('div', 'wb-pool-line'); who.appendChild(el('span', 'k', '谁提议：')); who.appendChild(document.createTextNode(whoLabel)); card.appendChild(who);
      const what = el('div', 'wb-pool-line'); what.appendChild(el('span', 'k', '做什么：')); what.appendChild(document.createTextNode(String(item.task || '').trim())); card.appendChild(what);
      card.appendChild(el('div', 'wb-pool-line muted num', `预计消耗：新增 1 个节点，至多约 ${item.maxIters || 100} 轮调用`));
      if (run.live) {
        const acts = el('div', 'wb-pool-actions');
        const yes = el('button', 'wb-btn primary', '同意添加'); yes.setAttribute('aria-label', '同意添加此任务'); yes.onclick = () => poolDecide(run.id, item.id, true);
        const no = el('button', 'wb-btn', '不用了'); no.setAttribute('aria-label', '拒绝此任务'); no.onclick = () => poolDecide(run.id, item.id, false);
        acts.append(yes, no); card.appendChild(acts);
      }
      box.appendChild(card);
    } else {
      box.appendChild(el('div', 'wb-pool-decided', `${poolStatusLabel(item.status)}${item.resultNodeId ? ` · 节点 ${item.resultNodeId}` : ''}：${String(item.task || '').replace(/\s+/g, ' ').slice(0, 40)}`));
    }
  }
  return box;
}
// 段3 体:邮箱消息流(§6#8)。run.messages 时间线,每条 sender → target · 摘要 + 送达/未送达状态。只读。空 → 占位。
function wbMailBody(run) {
  const mails = Array.isArray(run.messages) ? run.messages : [];
  if (!mails.length) return el('div', 'wb-det-empty', '暂无 Agent 间消息。子代理可用 send_to_agent 互相传话，这里按时间列出。');
  const box = el('div', 'wb-mail');
  for (const m of mails) {
    const item = el('div', `wb-mail-item${m.dropped ? ' dropped' : ''}`);
    item.appendChild(el('div', 'wb-mail-ico', '✉'));
    const body = el('div', 'wb-mail-body');
    const route = el('div', 'wb-mail-route num'); route.appendChild(document.createTextNode(m.sender || '?')); route.appendChild(el('span', 'wb-mail-arw', '→')); route.appendChild(document.createTextNode(m.target || '?')); body.appendChild(route);
    body.appendChild(el('div', 'wb-mail-text', String(m.text || '')));
    const meta = el('div', 'wb-mail-meta num');
    if (m.dropped) { meta.appendChild(document.createTextNode(m.createdAt ? new Date(m.createdAt).toLocaleTimeString() : '')); meta.appendChild(el('span', 'wb-mail-badge', '未送达')); }
    else if (m.deliveredAt) meta.appendChild(document.createTextNode(`已送达 · ${new Date(m.deliveredAt).toLocaleTimeString()}`));
    else meta.appendChild(document.createTextNode('投递中…'));
    body.appendChild(meta); item.appendChild(body); box.appendChild(item);
  }
  return box;
}

/* ============================================================
   成本 / 用量看板（前端面板 + 手绘 SVG 图表）。数据来自只读端点
   GET /api/usage/summary?range=today|week|month|all（默认 month），
   经 api() 带 token 拉取。所有不可信内容一律 el()/textContent 渲染，
   SVG 数值自算 round，绝不 innerHTML 拼接。成本按币种分组（不换算），
   措辞用「约/估算」（非实际扣费）；第三方 Coding Plan（planBased/
   costTrusted=false）只显 token 消耗 + 来源，不伪造金额。
   ============================================================ */
const usageState = { loaded: false, range: 'month', data: null };
// 币种符号 + 排序权重（¥ 在前，与需求示例「¥1.80 · $0.42」一致）。未知币种回退为「CODE 」前缀。
const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: 'JP¥', HKD: 'HK$', TWD: 'NT$', KRW: '₩' };
const CURRENCY_ORDER = { CNY: 0, USD: 1, EUR: 2, GBP: 3, JPY: 4 };
const PRICING_CURRENCIES = [
  { code: 'CNY', label: '人民币 ¥ (CNY)' }, { code: 'USD', label: '美元 $ (USD)' },
  { code: 'EUR', label: '欧元 € (EUR)' }, { code: 'GBP', label: '英镑 £ (GBP)' }, { code: 'JPY', label: '日元 ¥ (JPY)' },
];
// 数值小工具：整数千分位、金额（round 到合理精度，避免 0.30000004）、SVG 坐标两位小数。
function fmtInt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
function round2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
function fmtMoney(amount, currency) {
  const n = Number(amount) || 0;
  const sym = CURRENCY_SYMBOL[currency] || (currency ? currency + ' ' : '');
  // <1 的小额保留至多 4 位有效小数（如 $0.0032），其余 2 位；toLocaleString 负责千分位与裁尾零。
  const maxFrac = (n !== 0 && Math.abs(n) < 1) ? 4 : 2;
  return sym + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}
// costsByCurrency({USD:0.42,CNY:1.8}) → 「约 ¥1.80 · 约 $0.42」。空/全 0 → ''。prefix 用于「约 」前缀。
function fmtCostsByCurrency(costs, prefix) {
  const entries = Object.entries(costs || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return '';
  entries.sort((a, b) => ((CURRENCY_ORDER[a[0]] ?? 9) - (CURRENCY_ORDER[b[0]] ?? 9)) || (a[0] < b[0] ? -1 : 1));
  return entries.map(([cur, v]) => (prefix || '') + fmtMoney(v, cur)).join(' · ');
}
// 诚实渲染判定：后端可能给 planBased(true)=第三方计划内计费，或 costTrusted(false)=成本不可当真实金额。
// 二者任一命中即视为「计划内 / 成本不可信」——只显 token，不显伪造金额。
function entryPlanBased(e) { return !!(e && (e.planBased === true || e.costTrusted === false)); }
function engineDisplayName(engine) { return engine === 'claude' ? 'Claude' : engine === 'openai' ? 'Provider（原生 API）' : (engine || '其他'); }

async function loadUsage(force) {
  const host = $('usagePanel'); if (!host) return;
  const range = usageState.range || 'month';
  host.setAttribute('aria-busy', 'true');
  if (force || !usageState.data) { host.textContent = ''; host.appendChild(usageNoticeCard('正在汇总用量…')); }
  try {
    const r = await api(`/api/usage/summary?range=${encodeURIComponent(range)}`);
    usageState.data = r; usageState.loaded = true;
    renderUsage(r);
  } catch (e) {
    usageState.loaded = true; usageState.data = null;
    host.textContent = ''; host.appendChild(usageNoticeCard(`加载用量失败：${apiErrText(e)}`));
  } finally { host.removeAttribute('aria-busy'); }
}
function setUsageRange(range) {
  if (!['today', 'week', 'month', 'all'].includes(range) || usageState.range === range) return;
  usageState.range = range;
  document.querySelectorAll('.usage-range-btn').forEach(b => { const on = b.dataset.range === range; b.classList.toggle('active', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  loadUsage(true);
}
// 空态 / 加载态 / 错误态统一卡片（带如意云纹水印，textContent 安全）。
function usageNoticeCard(msg) {
  const card = el('div', 'usage-empty');
  card.appendChild(el('div', 'usage-empty-cloud'));
  card.appendChild(el('p', 'usage-empty-text', msg));
  return card;
}
function renderUsage(data) {
  const host = $('usagePanel'); if (!host) return;
  host.textContent = '';
  if (!data || data.ok === false) { host.appendChild(usageNoticeCard('暂时拿不到用量数据，请稍后刷新。')); return; }
  const totals = data.totals || {};
  const byEngine = Array.isArray(data.byEngine) ? data.byEngine : [];
  const byProvider = Array.isArray(data.byProvider) ? data.byProvider : [];
  const bySession = Array.isArray(data.bySession) ? data.bySession : [];
  const byDay = Array.isArray(data.byDay) ? data.byDay : [];
  // 预算软告警：budget 非 null 时常驻（超支=琥珀 alert；未超=进度条软提示）。放在最顶，不阻断。
  if (data.budget && (Number(data.budget.monthly) > 0 || Number(data.budget.spentThisMonth) > 0)) host.appendChild(usageBudgetBanner(data.budget));
  const hasAny = (Number(totals.inTok) || 0) + (Number(totals.outTok) || 0) + (Number(totals.turns) || 0) > 0
    || byEngine.length || byProvider.length || bySession.length || byDay.length;
  if (!hasAny) { host.appendChild(usageNoticeCard('还没有用量记录，发起对话后这里会汇总花费。')); return; }
  host.appendChild(usageAggHead(totals, byEngine.concat(byProvider)));
  if (byEngine.length) host.appendChild(usageGroup('按引擎', byEngine, 'engine'));
  if (byProvider.length) host.appendChild(usageGroup('按服务商', byProvider, 'provider'));
  if (bySession.length) host.appendChild(usageGroup('按会话', bySession, 'session'));
  if (byDay.length) host.appendChild(usageTrend(byDay));
}
// 预算横幅。over=超支 → 琥珀 role=alert；未超 → 软进度条 role=status。措辞带「约/估算」。
function usageBudgetBanner(b) {
  const monthly = Number(b.monthly) || 0, spent = Number(b.spentThisMonth) || 0, cur = b.currency || 'CNY';
  const over = monthly > 0 && spent > monthly;
  const wrap = el('div', 'usage-budget-banner' + (over ? ' over' : ''));
  wrap.setAttribute('role', over ? 'alert' : 'status');
  if (over) {
    wrap.appendChild(el('span', 'usage-budget-icon', '⚠'));
    wrap.appendChild(el('span', 'usage-budget-text', `本月已用约 ${fmtMoney(spent, cur)} / 预算 ${fmtMoney(monthly, cur)}，超出约 ${fmtMoney(spent - monthly, cur)}（估算）`));
  } else {
    const pct = monthly > 0 ? Math.min(100, Math.round(spent / monthly * 100)) : 0;
    wrap.appendChild(el('span', 'usage-budget-text', monthly > 0 ? `本月预算：约 ${fmtMoney(spent, cur)} / ${fmtMoney(monthly, cur)}（${pct}%，估算）` : `本月已用约 ${fmtMoney(spent, cur)}（未设预算上限）`));
    if (monthly > 0) { const track = el('div', 'usage-budget-bar'); const fill = el('div', 'usage-budget-fill'); fill.style.width = pct + '%'; track.appendChild(fill); wrap.appendChild(track); }
  }
  return wrap;
}
// 聚合头：输入/输出 tokens + 轮次(含估算标注) + 各币种成本(约/估算) + 诚实脚注。
function usageAggHead(totals, mixedEntries) {
  const wrap = el('div', 'usage-agg');
  const stats = el('div', 'usage-agg-stats');
  stats.appendChild(usageStat('输入 tokens', fmtInt(totals.inTok)));
  stats.appendChild(usageStat('输出 tokens', fmtInt(totals.outTok)));
  const est = Number(totals.estimatedTurns) || 0;
  // v1.4-OSS 用量看板(补): 工作流子代理回合与辅助调用(压缩/起草)也计入总回合数，附一条小注记说明其构成。
  const subAgents = Number(totals.subagentTurns) || 0;
  const auxCalls = Number(totals.auxCalls) || 0;
  const turnSub = [est > 0 ? `含 ${fmtInt(est)} 轮估算` : '', subAgents > 0 ? `其中工作流子代理 ${fmtInt(subAgents)} 回合` : '', auxCalls > 0 ? `辅助调用 ${fmtInt(auxCalls)} 次` : ''].filter(Boolean).join(' · ');
  stats.appendChild(usageStat('对话轮次', fmtInt(totals.turns), turnSub));
  wrap.appendChild(stats);
  const cost = el('div', 'usage-agg-cost');
  cost.appendChild(el('span', 'usage-agg-cost-label', '成本估算'));
  const costStr = fmtCostsByCurrency(totals.costsByCurrency, '约 ');
  cost.appendChild(el('span', 'usage-agg-cost-val' + (costStr ? '' : ' muted'), costStr || '暂无成本估算（未配置单价或为计划内计费）'));
  wrap.appendChild(cost);
  // 诚实脚注：优先用后端 totals.planBasedTurns（第三方 Coding Plan/订阅计费的轮数）；forward-compat 再兜底逐条 flag。
  const planTurns = Number(totals.planBasedTurns) || 0;
  let note = '成本为按量计价的等价估算，非实际扣费。';
  if (planTurns > 0) note += `其中约 ${fmtInt(planTurns)} 轮为计划内（订阅）计费，只计 token、未计入上方成本。`;
  else if ((mixedEntries || []).some(entryPlanBased)) note += '部分用量为计划内（订阅）计费，只计 token，未计入上方成本。';
  wrap.appendChild(el('p', 'usage-agg-note muted', note));
  return wrap;
}
function usageStat(label, value, sub) {
  const box = el('div', 'usage-stat');
  box.appendChild(el('div', 'usage-stat-val', value));
  box.appendChild(el('div', 'usage-stat-label', label));
  if (sub) box.appendChild(el('div', 'usage-stat-sub', sub));
  return box;
}
// 分组条：按 tokens(币种无关)归一。sr-only 概述 + 逐条手绘 SVG 水平条。
function usageGroup(title, list, kind) {
  const wrap = el('div', 'usage-group');
  wrap.appendChild(el('div', 'usage-group-title', title));
  const rows = list.map(e => ({ e, tok: (Number(e.inTok) || 0) + (Number(e.outTok) || 0) }));
  const max = Math.max(1, ...rows.map(r => r.tok));
  const names = rows.map(r => `${usageEntryName(r.e, kind)} ${fmtTokens(r.tok)} tok`).join('；');
  wrap.appendChild(el('p', 'sr-only', `${title}：共 ${rows.length} 项。${names}。`));
  const bars = el('div', 'usage-bars');
  for (const r of rows) bars.appendChild(usageBar(r.e, r.tok, max, kind));
  wrap.appendChild(bars);
  return wrap;
}
function usageEntryName(e, kind) {
  if (kind === 'engine') return engineDisplayName(e.engine);
  if (kind === 'session') return e.title || e.sessionId || '未命名会话';
  return e.label || e.provider || '未知服务商';
}
function usageBar(entry, tok, max, kind) {
  const row = el('div', 'usage-bar-row');
  const labelWrap = el('div', 'usage-bar-label');
  labelWrap.appendChild(el('span', 'usage-bar-name', usageEntryName(entry, kind)));
  const src = entry.sourceLabel || entry.source;
  if (src && kind !== 'session') labelWrap.appendChild(el('span', 'usage-bar-src', src));
  const plan = entryPlanBased(entry);
  if (plan) { const pb = el('span', 'usage-bar-plan', '计划内计费'); pb.title = '订阅套餐,按月付费,token 不另计钱。'; labelWrap.appendChild(pb); } // v3 (§2.8): 术语人话 tooltip
  // 会话条可点击 → 打开该会话（openSession 走 /api/sessions/:id）。键盘可达。
  if (kind === 'session' && entry.sessionId) {
    row.classList.add('clickable'); row.setAttribute('role', 'button'); row.tabIndex = 0;
    row.setAttribute('aria-label', `打开会话「${usageEntryName(entry, kind)}」`);
    const go = () => { openSession(entry.sessionId).catch(e => toast('打开会话失败：' + apiErrText(e), 'err')); };
    row.onclick = go; row.onkeydown = ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); } };
  }
  const pct = Math.max(0, Math.min(100, Math.round(tok / max * 100)));
  const colorVar = kind === 'engine' ? (entry.engine === 'claude' ? 'var(--wf-claude)' : 'var(--wf-provider)') : 'var(--accent)';
  row.appendChild(labelWrap);
  row.appendChild(usageBarSvg(pct, colorVar));
  const valWrap = el('div', 'usage-bar-val');
  valWrap.appendChild(el('span', 'usage-bar-tok', `${fmtTokens(tok)} tok`));
  if (plan) valWrap.appendChild(el('span', 'usage-bar-cost muted', '计划内'));
  else { const c = fmtCostsByCurrency(entry.costsByCurrency, '约 '); if (c) valWrap.appendChild(el('span', 'usage-bar-cost', c)); }
  row.appendChild(valWrap);
  return row;
}
// 手绘 SVG 水平条：底轨 rect + 填充 rect(宽 = round(pct))。preserveAspectRatio=none 横向拉伸铺满。装饰性 → aria-hidden。
function usageBarSvg(pct, colorVar) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'usage-bar-svg'); svg.setAttribute('viewBox', '0 0 100 10');
  svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(NS, 'rect');
  track.setAttribute('class', 'usage-bar-track'); track.setAttribute('x', '0'); track.setAttribute('y', '0'); track.setAttribute('width', '100'); track.setAttribute('height', '10'); track.setAttribute('rx', '2');
  const fill = document.createElementNS(NS, 'rect');
  fill.setAttribute('class', 'usage-bar-fill'); fill.setAttribute('x', '0'); fill.setAttribute('y', '0'); fill.setAttribute('width', String(round2(pct))); fill.setAttribute('height', '10'); fill.setAttribute('rx', '2'); fill.setAttribute('fill', colorVar);
  svg.appendChild(track); svg.appendChild(fill);
  return svg;
}
// 日趋势：手绘 SVG 迷你柱状。按 tokens 归一，深浅主题用 --accent 着色。sr-only 概述 + 首末日期 caption。
function usageTrend(byDay) {
  const wrap = el('div', 'usage-group usage-trend');
  wrap.appendChild(el('div', 'usage-group-title', '每日趋势'));
  const days = byDay.map(d => ({ date: d.date || '', tok: (Number(d.inTok) || 0) + (Number(d.outTok) || 0) }));
  const max = Math.max(1, ...days.map(d => d.tok));
  const peak = days.reduce((a, b) => (b.tok > a.tok ? b : a), days[0] || { tok: 0, date: '' });
  wrap.appendChild(el('p', 'sr-only', `每日 token 趋势，共 ${days.length} 天，最高约 ${fmtTokens(peak.tok)} tok（${peak.date}）。`));
  wrap.appendChild(usageTrendSvg(days, max));
  if (days.length) { const cap = el('div', 'usage-trend-cap'); cap.appendChild(el('span', '', days[0].date)); cap.appendChild(el('span', '', days[days.length - 1].date)); wrap.appendChild(cap); }
  return wrap;
}
function usageTrendSvg(days, max) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 100, H = 40, n = days.length, gap = n > 1 ? Math.min(2, 40 / n) : 0;
  const bw = n > 0 ? (W - gap * (n - 1)) / n : W;
  const peakTok = Math.max(0, ...days.map(d => d.tok));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'usage-trend-svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  days.forEach((d, i) => {
    const h = d.tok > 0 ? Math.max(1, Math.round(d.tok / max * (H - 2))) : 0;
    const x = round2(i * (bw + gap)), y = round2(H - h);
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('class', 'usage-trend-bar' + (d.tok > 0 && d.tok === peakTok ? ' peak' : ''));
    r.setAttribute('x', String(x)); r.setAttribute('y', String(y)); r.setAttribute('width', String(round2(bw))); r.setAttribute('height', String(h)); r.setAttribute('rx', '0.6');
    const t = document.createElementNS(NS, 'title'); t.textContent = `${d.date}：${fmtTokens(d.tok)} tok`; r.appendChild(t);
    svg.appendChild(r);
  });
  return svg;
}
function handleSubagentEvent(evt, live) {
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
    const driverTag = evt.native && evt.engine === 'claude' ? ' · Claude 原生' : '';
    const keyTag = evt.agentKey ? `[${evt.agentKey}] ` : '';
    const dependencyTag = Array.isArray(evt.dependsOn) && evt.dependsOn.length ? ` · 依赖 ${evt.dependsOn.join(', ')}` : '';
    sum.append(
      el('span', 'sa-icon', '🤖'),
      el('span', 'sa-title', `${keyTag}子任务：${taskShort || '(无描述)'}`),
      el('span', 'sa-status', `执行中…${roleTag}${tierTag}${modelTag}${driverTag}${dependencyTag}`),
    );
    d.appendChild(sum);
    const body = el('div', 'subagent-body');
    d.appendChild(body);
    live.toolsWrap.appendChild(d);
    live.subCards.set(id, { d, body, status: sum.querySelector('.sa-status'), tierTag, roleTag, modelTag, driverTag, dependencyTag });
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
    host.d.classList.add(ok ? 'sa-ok' : 'sa-err');
    if (host.status) {
      const chars = Number(evt.resultChars) || 0;
      host.status.textContent = `${ok ? '✓ 完成' : '✗ 失败'} · ${chars} 字结论${host.roleTag || ''}${host.tierTag}${host.modelTag || ''}${host.driverTag || ''}${host.dependencyTag || ''}`;
      host.status.classList.add(ok ? 'ok' : 'err');
    }
    if (!ok) host.d.open = true; // surface a failed sub-turn automatically
  }
}

// v1.0.2 (F1d): 计划决策状态的前端持久化。实证:持久化的会话消息里【没有】planId / 计划决策字段 —— 计划在
// provider 模式下就是一条 content 以 "PLAN:" 开头的普通 assistant 消息(见交付报告 F1d 取舍说明)。因此这里用
// localStorage 按 planId 记 { decision, note, ts },只在【本次流式生命周期】内让已决策卡保持收起(不改 server /
// 会话 schema)。跨整页重载时,由于消息无 planId 锚点无法把决策映射回去,计划会退回普通 "PLAN:" markdown 气泡
// —— 这是硬约束(禁改 server)下的已知降级,已在报告注明。key 前缀 wcw.plan. 。
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
  if (decision === 'reject') return { text: '✕ 已放弃该计划', cls: 'rej' };
  return { text: note ? '✓ 计划已批准（带修改意见）' : '✓ 计划已批准', cls: 'ok' };
}

// 构建一张计划卡的 DOM。decidedState 非空 → 直接渲染为收起态(静态重渲染 / 已决策);否则渲染可操作态,
// 由调用方接线按钮。返回 { card, setDecided } 供 live 路径决策后收起。markdown 走 renderMarkdown(白名单消毒)。
function buildPlanCard(planId, markdown) {
  const card = el('div', 'plan-card');
  // 收起态点击展开:头部作为可点区域。展开=切换 .plan-expanded(CSS 收起态下也能重新露出正文)。
  const head = el('div', 'plan-card-head', `${engineLabel()} 提出了执行计划，待你批准`);
  card.appendChild(head);

  const md = el('div', 'plan-card-body md');
  md.innerHTML = renderMarkdown(markdown || ''); // renderMarkdown sanitizes (allowlist + protocol filter)
  card.appendChild(md);
  highlightIn(md);

  // 修改意见 textarea — hidden until 「修改意见」 is clicked; submitting it = approve carrying the note.
  const noteWrap = el('div', 'plan-card-note'); noteWrap.style.display = 'none';
  const noteTa = document.createElement('textarea');
  noteTa.rows = 2; noteTa.placeholder = '补充你的修改意见，然后批准执行…';
  const noteSend = el('button', 'primary', '带意见批准');
  noteWrap.append(noteTa, noteSend);
  card.appendChild(noteWrap);

  const foot = el('div', 'plan-card-foot');
  const approve = el('button', 'primary', '批准执行');
  const amend = el('button', 'ghost', '修改意见');
  const reject = el('button', 'danger', '放弃');
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
    res.textContent = lab.text + '（点此展开原文）';
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

  // F1b(时序):plan 事件到达时先「封存」当前流式文本块 —— 去掉光标并新起一个空 bubble,让 plan 之后的
  // assistant_delta 写进新块(append 在计划卡之后),保证消息自上而下:文本 → 计划卡 → 后续文本。
  if (live && live.bubble) {
    live.bubble.classList.remove('stream-cursor');
    if (live.bufferText) { live.bubble.innerHTML = renderMarkdown(live.bufferText); highlightIn(live.bubble); }
    else { live.bubble.remove(); } // 空块无意义,直接丢弃,避免留一个空气泡
  }

  const built = buildPlanCard(planId, evt.markdown || '');
  const { card, approve, amend, reject, noteWrap, noteTa, noteSend, setDecided } = built;

  let decided = false;
  const finish = (decision, note) => {
    if (decided) return; decided = true;
    setComposerHint('');
    setDecided(decision, note);
    savePlanDecision(planId, decision, note); // F1d 持久化
    // F1b(续):决策后为后续 assistant_delta 备好一个新 bubble,append 在计划卡之后。
    if (live) {
      live.bufferText = '';
      live.firstDeltaSeen = false;
      const nb = el('div', 'bubble md stream-cursor');
      (main || $('messages')).appendChild(nb);
      live.bubble = nb;
    }
  };

  approve.onclick = async () => { const r = await decidePlan(planId, 'approve'); if (r && r.ok) finish('approve'); else if (r) toast(r.error || '该计划已失效', ''); };
  reject.onclick = async () => { const r = await decidePlan(planId, 'reject'); if (r && r.ok) finish('reject'); else if (r) toast(r.error || '该计划已失效', ''); };
  amend.onclick = () => { noteWrap.style.display = ''; noteTa.focus(); };
  noteSend.onclick = async () => {
    const note = noteTa.value.trim();
    const r = await decidePlan(planId, 'approve', note);
    if (r && r.ok) finish('approve', note);
    else if (r) toast(r.error || '该计划已失效', '');
  };

  const host = main || $('messages');
  // F1b:计划卡插在已封存的旧 bubble 之后、新 bubble(若已建)之前。此刻新 bubble 尚未建(finish 才建),
  // 所以直接 append 即可落在旧文本块之后。
  host.appendChild(card);
  setComposerHint('AI 在等你批准计划');
  scrollMessagesToBottom();
}

/* ---------------- debug panel ---------------- */
function pushRawEvent(seq, line) {
  state.rawEvents.push({ seq, line });
  if (state.rawEvents.length > 2000) state.rawEvents.shift();
  const pre = $('rawEvents');
  const row = el('div', 'rl');
  row.innerHTML = `<span class="seq">#${seq}</span> ${escapeHtml(line.slice(0, 4000))}`;
  pre.appendChild(row);
  while (pre.childElementCount > 2000) pre.firstChild.remove();
  if ($('debugAutoscroll').checked) pre.scrollTop = pre.scrollHeight;
}
function appendToolOutput(value, append = false) {
  const out = $('toolOutput');
  const txt = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  out.textContent = append ? `${out.textContent}\n${txt}`.slice(-20000) : txt;
}

/* ---------------- tools ---------------- */
async function runTool(name, body) {
  appendToolOutput('运行中…');
  try { const res = await api(`/api/tools/${name}`, { method: 'POST', body: JSON.stringify(body || {}) }); appendToolOutput(res.result); }
  catch (err) { appendToolOutput(err.message || String(err)); toast(`工具出错：${apiErrText(err)}`, 'err'); }
}

/* ---------------- v0.9-S3 (C3): file tree ---------------- */
// A lazy-loaded tree of the current session's working folder. `/api/tools/file_list root=<dir>` returns the
// first level (non-recursive); expanding a directory fetches its children on demand. Clicking a text file
// (≤200KB) previews it via file_read; images/binaries show a placeholder (a real gallery arrives in S4).
// The 「@」button inserts the file's path (relative to the workspace when possible) into the composer.
// XSS discipline: every path/name goes through textContent (el(tag,cls,text)), never innerHTML.
const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/i;
const FILE_PREVIEW_MAX = 200 * 1024; // ≤200KB text preview cap (spec)

function fileBasename(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || ''); }
// Path of `full` relative to the workspace root, using forward slashes; falls back to the basename when
// `full` is outside the root (or the root is unknown). Purely a display/@-mention convenience.
function pathRelativeToWorkspace(full) {
  const root = currentWorkspace();
  if (!root || !full) return fileBasename(full);
  const nr = root.replace(/[\\/]+$/, '');
  const lf = full.toLowerCase(), lr = nr.toLowerCase();
  if (lf === lr) return '.';
  if (lf.startsWith(lr + '\\') || lf.startsWith(lr + '/')) return full.slice(nr.length + 1).replace(/\\/g, '/');
  return fileBasename(full);
}
// Fetch one directory level. file_list returns { files:[{path,type,name?,relativePath?}] }. We only need
// path + type; a name is derived from the path. Directories first, then files, each alphabetical.
async function fetchDirLevel(dir) {
  const res = await api('/api/tools/file_list', { method: 'POST', body: JSON.stringify({ root: dir, recursive: false }) });
  const r = res && res.result;
  if (!r || !r.ok || !Array.isArray(r.files)) return [];
  const entries = r.files.map(f => ({ path: f.path, type: f.type === 'directory' ? 'directory' : 'file', name: fileBasename(f.path) }));
  entries.sort((a, b) => (a.type === b.type) ? a.name.localeCompare(b.name) : (a.type === 'directory' ? -1 : 1));
  return entries;
}
// Build one row (dir or file). Directories get a lazy-expand caret; files get a click-to-preview + 「@」.
function fileTreeRow(entry, depth) {
  const row = el('div', 'ftree-row');
  row.style.paddingLeft = (6 + depth * 14) + 'px';
  if (entry.type === 'directory') {
    const caret = el('span', 'ftree-caret', '▸');
    const label = el('span', 'ftree-name', entry.name);
    row.append(caret, el('span', 'ftree-icon', '📁'), label);
    const childWrap = el('div', 'ftree-children hidden');
    let loaded = false;
    row.onclick = async () => {
      const open = childWrap.classList.toggle('hidden');
      caret.textContent = open ? '▸' : '▾';
      if (!open && !loaded) {
        loaded = true;
        childWrap.textContent = '';
        childWrap.appendChild(el('div', 'ftree-loading', '加载中…'));
        try {
          const kids = await fetchDirLevel(entry.path);
          childWrap.textContent = '';
          if (!kids.length) childWrap.appendChild(el('div', 'ftree-empty', '（空文件夹）'));
          for (const k of kids) childWrap.appendChild(fileTreeRow(k, depth + 1));
        } catch (e) { childWrap.textContent = ''; childWrap.appendChild(el('div', 'ftree-empty', '读取失败')); loaded = false; }
      }
    };
    const frag = document.createDocumentFragment();
    frag.append(row, childWrap);
    return frag;
  }
  // file row
  row.append(el('span', 'ftree-caret', ''), el('span', 'ftree-icon', IMG_EXT.test(entry.name) ? '🖼' : '📄'), el('span', 'ftree-name', entry.name));
  const at = el('button', 'ftree-at', '@');
  at.title = '@提及：把相对路径插入输入框';
  at.onclick = e => { e.stopPropagation(); mentionFile(entry.path); };
  row.appendChild(at);
  row.onclick = () => previewFile(entry.path);
  return row;
}
// Load the whole tree for the current workspace root.
async function loadFileTree() {
  const rootEl = $('fileTreeRoot'), treeEl = $('fileTree');
  if (!rootEl || !treeEl) return;
  const root = currentWorkspace();
  rootEl.textContent = root ? ('📂 ' + fileBasename(root)) : '（未设置工作文件夹）';
  rootEl.title = root || '';
  $('filePreview').classList.add('hidden');
  treeEl.textContent = '';
  if (!root) return;
  treeEl.appendChild(el('div', 'ftree-loading', '加载中…'));
  try {
    const entries = await fetchDirLevel(root);
    treeEl.textContent = '';
    if (!entries.length) { treeEl.appendChild(el('div', 'ftree-empty', '（空文件夹）')); return; }
    for (const e of entries) treeEl.appendChild(fileTreeRow(e, 0));
  } catch (e) { treeEl.textContent = ''; treeEl.appendChild(el('div', 'ftree-empty', '读取失败：' + apiErrText(e))); }
}
// Preview a file into #filePreview (file tree). v0.9-S4: delegates to the shared renderer, which now uses
// /api/file/preview so images render for real (was a placeholder in S3).
function previewFile(full) { return renderFilePreviewInto($('filePreview'), full); }

// v0.9-S4 (C4): shared file-preview renderer — used by both the file tree (#filePreview) and the产物 gallery
// (#artifactPreview). Calls GET /api/file/preview?path=&sessionId= and renders by kind:
//   image      → <img src=dataUri>  (max-width 100%)
//   text/md    → md via renderMarkdown (XSS-sanitized), csv → table (≤200 rows, all textContent),
//                txt/其它文本 → <pre> textContent
//   html       → SANDBOX iframe: <iframe sandbox="" srcdoc=…>. The sandbox attribute is left EMPTY = fully
//                locked: no scripts, no forms, no top navigation, no same-origin. This is what prevents a
//                malicious <script> inside a产物 html from executing. (Verified: an alert() script never runs.)
//   binary     → 「用系统程序打开」button = office_open
//   image-toobig / truncated → a note line
// XSS discipline: filenames/paths/csv cells all go through el()/textContent; only markdown goes through
// renderMarkdown (which sanitizes); html goes into srcdoc of a locked iframe (never innerHTML of the page).
async function renderFilePreviewInto(box, full) {
  if (!box) return;
  box.classList.remove('hidden');
  box.textContent = '';
  const head = el('div', 'file-preview-head');
  head.append(el('span', 'fp-name', fileBasename(full)));
  const openBtn = el('button', 'mini', '打开');
  openBtn.onclick = () => runTool('office_open', { path: full });
  head.appendChild(openBtn);
  box.appendChild(head);
  const body = el('div', 'fp-body-wrap');
  body.appendChild(el('div', 'fp-loading', '加载中…'));
  box.appendChild(body);
  const sid = state.currentSession && state.currentSession.id;
  try {
    const qs = '?path=' + encodeURIComponent(full) + (sid ? '&sessionId=' + encodeURIComponent(sid) : '');
    const r = await api('/api/file/preview' + qs);
    body.textContent = '';
    if (!r || r.ok === false) {
      body.appendChild(el('div', 'fp-placeholder', (r && (r.error + (r.hint ? '（' + r.hint + '）' : ''))) || '预览失败'));
      return;
    }
    if (r.truncated) head.appendChild(el('span', 'fp-trunc', `（仅预览前 ${Math.round(1024)}KB，内容已截断）`));
    if (r.kind === 'image') {
      const img = el('img', 'fp-image');
      img.src = r.dataUri; img.alt = fileBasename(full);
      body.appendChild(img);
    } else if (r.kind === 'image-toobig') {
      body.appendChild(el('div', 'fp-placeholder', `图片超过 5MB（${fmtBytes(r.size)}），请点「打开」查看。`));
    } else if (r.kind === 'html') {
      // Fully-locked sandbox: sandbox="" blocks scripts/forms/same-origin/top-nav. Content goes via srcdoc.
      const frame = document.createElement('iframe');
      frame.className = 'fp-html-frame';
      frame.setAttribute('sandbox', ''); // EMPTY = maximally restrictive; DO NOT add allow-scripts here.
      frame.setAttribute('srcdoc', String(r.content || ''));
      body.appendChild(el('div', 'fp-html-note', '（HTML 已在隔离沙箱中渲染：禁脚本、禁网络、禁表单）'));
      body.appendChild(frame);
    } else if (r.kind === 'text') {
      renderTextPreview(body, full, r.content);
    } else if (r.kind === 'binary') {
      body.appendChild(el('div', 'fp-placeholder', `二进制/文档文件（${(r.ext || '').toUpperCase() || '未知格式'}）——请点「打开」用系统程序查看。`));
    } else {
      body.appendChild(el('div', 'fp-placeholder', '无法预览此文件。'));
    }
  } catch (e) { body.textContent = ''; body.appendChild(el('div', 'fp-placeholder', '预览失败：' + apiErrText(e))); }
}
// Render a text payload by sub-kind: .md → sanitized markdown; .csv → a small table (≤200 rows, every cell
// textContent); everything else → <pre> textContent.
function renderTextPreview(body, full, content) {
  const s = String(content || '');
  if (/\.(md|markdown)$/i.test(full)) {
    const md = el('div', 'fp-md markdown');
    md.innerHTML = renderMarkdown(s); // renderMarkdown sanitizes (allowlist + protocol filter)
    highlightIn(md);
    body.appendChild(md);
  } else if (/\.csv$/i.test(full)) {
    body.appendChild(renderCsvTable(s));
  } else {
    body.appendChild(el('pre', 'fp-body', s));
  }
}
// Naive CSV → table. Splits on newlines then commas (no quote-aware parsing — this is a lightweight preview,
// not a spreadsheet). First 200 rows. EVERY cell is set via textContent (el(...)) — zero innerHTML, so a
// cell containing "<script>" renders as literal text.
function renderCsvTable(s) {
  const wrap = el('div', 'fp-csv-wrap');
  const rows = s.replace(/\r/g, '').split('\n').filter((r, i, a) => r.length || i < a.length - 1).slice(0, 200);
  const table = el('table', 'fp-csv');
  rows.forEach((line, ri) => {
    const tr = el('tr');
    const cells = line.split(',');
    for (const c of cells) {
      const cell = el(ri === 0 ? 'th' : 'td', '', c);
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  if (rows.length >= 200) wrap.appendChild(el('div', 'fp-trunc', '（仅显示前 200 行）'));
  return wrap;
}
// Insert a file's path (relative to the workspace when possible) into the composer at the caret.
function mentionFile(full) {
  const rel = pathRelativeToWorkspace(full);
  const ta = $('promptInput'); if (!ta) return;
  const insert = '@' + rel + ' ';
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
  const pos = start + insert.length;
  ta.setSelectionRange(pos, pos);
  ta.focus();
  autoGrow(ta);
  try { localStorage.setItem('wcw.draft', ta.value); } catch { /* ignore */ }
}

/* ---------------- v0.9-S4 (C4): 产物画廊 (artifacts gallery) ---------------- */
// This session's CUMULATIVE artifacts: walk session.messages, collect each turnSummary.artifacts, group by
// turnSeq (new→old), de-dupe by path keeping the newest occurrence. Each item = kind icon + filename +
// 预览 / 打开. Preview opens #artifactPreview via the shared renderer. Empty state when nothing produced yet.
const ARTIFACT_KIND_ICON = { img: '🖼', md: '📝', csv: '📊', txt: '📄', html: '🌐', xlsx: '📊', docx: '📄', pdf: '📕', other: '📎' };
function collectSessionArtifacts(session) {
  // Map<path, {path, kind, turnSeq}> — later (newer) messages overwrite → newest kept.
  const byPath = new Map();
  for (const msg of ((session && session.messages) || [])) {
    const ts = msg && msg.turnSummary;
    if (!ts || !Array.isArray(ts.artifacts)) continue;
    for (const a of ts.artifacts) {
      if (!a || !a.path) continue;
      byPath.set(String(a.path), { path: String(a.path), kind: a.kind || 'other', turnSeq: Number(ts.turnSeq) || 0 });
    }
  }
  // Group by turnSeq, newest turn first; within a turn keep insertion order.
  const byTurn = new Map();
  for (const a of byPath.values()) {
    if (!byTurn.has(a.turnSeq)) byTurn.set(a.turnSeq, []);
    byTurn.get(a.turnSeq).push(a);
  }
  return [...byTurn.entries()].sort((x, y) => y[0] - x[0]).map(([turnSeq, items]) => ({ turnSeq, items }));
}
// v1.0.2 (F7): 打开产物页签 / 点刷新时,先重新拉取当前会话数据(后端在修 turnSummary.artifacts 持久化,契约:
// GET /api/sessions/{id} 响应的 messages[].turnSummary.artifacts 会带产物),再从刷新后的 state 渲染。拉取失败
// 静默沿用旧数据(不清空、不报错弹窗)。此函数被 switchTab('artifacts') 与刷新钮调用 —— 均可 fire-and-forget。
async function renderArtifactsGallery() {
  const sid = state.currentSession?.id;
  if (sid) {
    try {
      const r = await api(`/api/sessions/${sid}`);
      // 会话可能在等待期间被切走 —— 只有仍是同一会话才写回 state,避免串数据。
      if (r && r.session && state.currentSession?.id === sid) state.currentSession = r.session;
    } catch { /* F7②:拉取失败静默沿用旧数据 */ }
  }
  renderArtifactsFromState();
}
// 纯渲染:从当前 state 的会话产物画产物列表(不发网络)。renderArtifactsGallery 拉取后调它;也可单独复用。
function renderArtifactsFromState() {
  const list = $('artifactsList'); if (!list) return;
  list.textContent = '';
  $('artifactPreview')?.classList.add('hidden');
  const groups = collectSessionArtifacts(state.currentSession);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (!total) {
    // F7③:空状态文案人话化。
    list.appendChild(el('div', 'artifacts-empty', '还没有产物——让 AI 生成文件后会出现在这里。'));
    return;
  }
  for (const g of groups) {
    const head = el('div', 'artifacts-turn-head', '第 ' + g.turnSeq + ' 轮');
    list.appendChild(head);
    for (const a of g.items) {
      const row = el('div', 'artifact-row');
      row.append(
        el('span', 'artifact-icon', ARTIFACT_KIND_ICON[a.kind] || ARTIFACT_KIND_ICON.other),
        el('span', 'artifact-name', fileBasename(a.path)),
      );
      row.querySelector('.artifact-name').title = a.path;
      const actions = el('span', 'artifact-actions');
      const prev = el('button', 'mini', '预览');
      prev.onclick = () => renderFilePreviewInto($('artifactPreview'), a.path);
      const open = el('button', 'mini', '打开');
      open.onclick = () => runTool('office_open', { path: a.path });
      actions.append(prev, open);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }
}

/* ---------------- v0.9-S8 (§4 B4): 审计中心 (audit timeline) ---------------- */
// Merged read-only timeline of workbench logs + desktop MCP audit_tail. Fetched once when the tab opens
// (no polling). Source/type filters run client-side over the already-fetched list. Every rendered value is
// set via textContent (el() sets text) — the expanded detail JSON is a <pre> textContent, never innerHTML.
const auditState = { entries: [], sources: null, loaded: false, loading: false };

async function loadAudit() {
  if (auditState.loading) return;
  auditState.loading = true;
  const list = $('auditList');
  if (list && !auditState.loaded) { list.textContent = ''; list.appendChild(el('div', 'audit-empty', '加载中…')); }
  try {
    // Pull a generous window; client-side filters narrow it. limit clamped server-side to ≤500.
    const res = await api('/api/audit?limit=200');
    auditState.entries = Array.isArray(res.entries) ? res.entries : [];
    auditState.sources = res.sources || null;
    auditState.loaded = true;
  } catch (e) {
    auditState.entries = [];
    auditState.sources = null;
    if (list) { list.textContent = ''; list.appendChild(el('div', 'audit-empty', '加载审计记录失败：' + apiErrText(e))); }
    auditState.loading = false;
    return;
  }
  auditState.loading = false;
  renderAuditList();
}

function renderAuditList() {
  const list = $('auditList');
  if (!list) return;
  list.textContent = '';
  // Desktop-source unavailable → a grey note line at the top (spec: 桌面操作审计需要 ai-computer-control 桥接).
  if (auditState.sources && auditState.sources.desktop === 'unavailable') {
    list.appendChild(el('div', 'audit-note', '桌面操作审计需要 ai-computer-control 桥接'));
  }
  const srcFilter = $('auditSourceFilter') ? $('auditSourceFilter').value : '';
  const typeFilter = ($('auditTypeFilter') ? $('auditTypeFilter').value : '').trim().toLowerCase();
  const rows = auditState.entries.filter(e => {
    if (srcFilter && e.source !== srcFilter) return false;
    if (typeFilter && !String(e.type || '').toLowerCase().includes(typeFilter)) return false;
    return true;
  });
  if (!rows.length) {
    list.appendChild(el('div', 'audit-empty', '暂无审计记录'));
    return;
  }
  for (const e of rows) {
    const row = el('div', 'audit-row');
    const head = el('div', 'audit-head');
    head.appendChild(el('span', 'audit-time', formatAuditTime(e.ts)));
    const badge = el('span', 'audit-badge ' + (e.source === 'desktop' ? 'src-desktop' : 'src-workbench'));
    badge.appendChild(el('span', 'audit-dot'));
    badge.appendChild(el('span', null, e.source === 'desktop' ? '桌面' : '工作台'));
    head.appendChild(badge);
    head.appendChild(el('span', 'audit-type', String(e.type || '')));
    head.appendChild(el('span', 'audit-summary', String(e.summary || '')));
    head.appendChild(el('span', 'audit-caret', '▸'));
    row.appendChild(head);
    let detailEl = null;
    head.onclick = () => {
      if (row.classList.contains('open')) {
        row.classList.remove('open');
        if (detailEl) { detailEl.remove(); detailEl = null; }
        return;
      }
      row.classList.add('open');
      // XSS: detail is untrusted (log/audit content) → render as textContent in a <pre>, never innerHTML.
      detailEl = el('pre', 'audit-detail');
      try { detailEl.textContent = JSON.stringify(e.detail, null, 2); }
      catch { detailEl.textContent = String(e.detail); }
      row.appendChild(detailEl);
    };
    list.appendChild(row);
  }
}

function formatAuditTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  // Local time, HH:MM:SS + date; tabular in the timeline. toLocaleString respects the browser locale.
  return d.toLocaleString();
}

/* ---------------- v1.0.2 (G1): 变更中心 (change/rollback center) ---------------- */
// GET /api/checkpoints?sessionId=<id> → {ok, entries:[{turnSeq, entrySeq, tool, path, op, bytes, skipped?, ts}], totalBytes}.
// Group by file path; within a file, newest checkpoint first (time desc). Each revertible entry gets a
// 「回撤到此前状态」button → confirm modal → POST /api/checkpoints/rollback {sessionId, turnSeq, entrySeq}.
// skipped entries render greyed + non-actionable (their before-content was too large to snapshot).
// Rolled-back entries are removed server-side, so a re-fetch after success naturally drops them.
const CHANGE_OP_LABEL = { create: '新建', modify: '修改', delete: '删除' };
// v1.4.1: 「用什么改的」人话标签 —— checkpoint 条目自带 tool 字段(如 file_edit / excel_beautify / acc__write_file)。
// 只标注「修改」用户不知道具体改了什么;补上工具名(+ 原大小)让每条变更能一眼看出是哪种改动。
const CHANGE_TOOL_LABEL = {
  // 内建文件工具
  file_write: '写入', file_edit: '编辑', file_delete: '删除', file_move: '移动', file_copy: '复制',
  archive_zip: '压缩', archive_unzip: '解压', http_download: '下载',
  // ACC(ai-computer-control)工具名
  write_file: '写入', delete_file: '删除', move_file: '移动', copy_file: '复制',
  write_document: '生成 Word', write_excel: '生成 Excel', write_pdf: '导出 PDF',
  excel_beautify: '美化 Excel', excel_chart: 'Excel 图表', write_pptx: '生成 PPT', chart_image: '制图',
  image_resize: '缩放图片',
};
function changeToolLabel(e) {
  const tool = String(e && e.tool || '').replace(/^.+?__/, '');   // 去桥接前缀 <serverId>__
  return tool ? (CHANGE_TOOL_LABEL[tool] || tool) : '';
}
// v1.4.1「改了什么」的量化:大小变化(原 → 现)。currentBytes 由 /api/checkpoints 附带(改动后磁盘大小)。
function changeSizeTransition(e) {
  const b = Number(e && e.bytes), c = Number(e && e.currentBytes);
  const bb = Number.isFinite(b) && b > 0 ? fmtBytes(b) : null;
  const cc = Number.isFinite(c) && c >= 0 ? fmtBytes(c) : null;
  if (e && e.op === 'create') return cc ? `新建 ${cc}` : '新建';
  if (e && e.op === 'delete') return bb ? `删除前 ${bb}` : '已删除';
  if (bb && cc) return `${bb} → ${cc}`;   // 修改:一眼看出变大/变小
  return bb ? `原 ${bb}` : '';
}
// 文本类扩展(可逐行看改动);其余(xlsx/docx/pptx/图片/pdf 等)只能开文件看。与后端 diff 端点判定对齐。
const CHANGE_TEXTISH_EXT = new Set(['txt','log','md','markdown','csv','tsv','json','js','ts','jsx','tsx','py','css','html','htm','xml','yml','yaml','ini','cfg','conf','sh','ps1','bat','cmd','sql','java','c','h','cpp','go','rs','rb','php','toml']);
function isTextishPath(p) {
  const m = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? CHANGE_TEXTISH_EXT.has(m[1]) : true; // 无扩展名默认按文本试(后端会再判二进制)
}
// v0.9-S4 icon map keys on artifact kind; here classify by file extension for a familiar kind icon.
function changeKindIcon(p) {
  const ext = String(p || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  if (/^(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)$/.test(e)) return ARTIFACT_KIND_ICON.img;
  if (e === 'md' || e === 'markdown') return ARTIFACT_KIND_ICON.md;
  if (e === 'csv' || e === 'tsv') return ARTIFACT_KIND_ICON.csv;
  if (e === 'xlsx' || e === 'xls') return ARTIFACT_KIND_ICON.xlsx;
  if (e === 'docx' || e === 'doc') return ARTIFACT_KIND_ICON.docx;
  if (e === 'pdf') return ARTIFACT_KIND_ICON.pdf;
  if (e === 'html' || e === 'htm') return ARTIFACT_KIND_ICON.html;
  if (/^(txt|log|json|js|ts|py|md|css|xml|yml|yaml|ini|cfg|conf)$/.test(e)) return ARTIFACT_KIND_ICON.txt;
  return ARTIFACT_KIND_ICON.other;
}
const changesState = { loading: false };
// Fetch the checkpoint index for the current session and render the grouped list. Fire-and-forget from
// switchTab / the refresh button. Fetch failure → a non-alarming inline error line (list is quiet).
async function loadChanges() {
  if (changesState.loading) return;
  const list = $('changesList'); if (!list) return;
  const sid = state.currentSession?.id;
  if (!sid) { list.textContent = ''; list.appendChild(el('div', 'changes-empty', '本会话还没有可回撤的文件变更。AI 用文件工具或 ACC 写文件后会出现在这里。')); return; }
  changesState.loading = true;
  list.textContent = ''; list.appendChild(el('div', 'changes-empty', '加载中…'));
  let entries = [];
  try {
    const r = await api('/api/checkpoints?sessionId=' + encodeURIComponent(sid));
    entries = (r && Array.isArray(r.entries)) ? r.entries : [];
  } catch (e) {
    // 会话可能已切走 —— 只有仍是同一会话才写 UI(避免串数据/覆盖新会话的空态)。
    if (state.currentSession?.id === sid) { list.textContent = ''; list.appendChild(el('div', 'changes-empty', '加载变更记录失败：' + apiErrText(e))); }
    changesState.loading = false;
    return;
  }
  changesState.loading = false;
  if (state.currentSession?.id !== sid) return; // switched away mid-fetch
  renderChanges(entries);
}
// v1.4.1: 改为【按轮次】分组、新轮在上 —— 与右侧「产物」画廊(collectSessionArtifacts 同样按轮次新→旧)统一,
// 用户反馈两个面板顺序此前「反着的」。每轮一张卡:「第 N 轮」头 +(可整轮撤销)+ 该轮各文件行(操作/文件名/
// 用什么改的+原大小/单条回撤)。轮内按 entrySeq 新→旧。
function renderChanges(entries) {
  const list = $('changesList'); if (!list) return;
  list.textContent = '';
  $('changesPreview')?.classList.add('hidden');
  const valid = (entries || []).filter(e => e && e.path);
  if (!valid.length) {
    list.appendChild(el('div', 'changes-empty', '本会话还没有可回撤的文件变更。AI 用文件工具或 ACC 写文件后会出现在这里。'));
    return;
  }
  const byTurn = new Map();
  for (const e of valid) { const t = Number(e.turnSeq) || 0; if (!byTurn.has(t)) byTurn.set(t, []); byTurn.get(t).push(e); }
  const rounds = [...byTurn.entries()].sort((a, b) => b[0] - a[0]); // 新轮在上
  for (const [turnSeq, items] of rounds) {
    items.sort((a, b) => (Number(b.entrySeq) - Number(a.entrySeq))); // 轮内新→旧
    const card = el('div', 'change-card');
    const head = el('div', 'change-card-head');
    head.append(el('span', 'change-round-title', '第 ' + turnSeq + ' 轮'));
    head.append(el('span', 'change-round-count muted', items.length + ' 个'));
    if (items.some(e => !e.skipped)) {
      const undoAll = el('button', 'mini change-undo-all', '撤销整轮');
      undoAll.onclick = () => rollbackTurn(turnSeq, undefined, undoAll, '整轮');
      head.append(undoAll);
    }
    card.append(head);
    const body = el('div', 'change-card-body');
    for (const e of items) {
      const p = String(e.path);
      const op = (e.op === 'create' || e.op === 'modify' || e.op === 'delete') ? e.op : 'unknown';
      const row = el('div', 'change-row' + (e.skipped ? ' skipped' : ''));
      // 第一行:操作徽章 + 图标 + 文件名(整行宽,少截断)+ 回撤
      const r1 = el('div', 'change-row-head');
      r1.append(el('span', 'change-op ' + op, CHANGE_OP_LABEL[op] || '变更'));
      r1.append(el('span', 'change-icon', changeKindIcon(p)));
      const nameEl = el('span', 'change-name', fileBasename(p)); nameEl.title = p; // XSS: textContent via el()
      r1.append(nameEl);
      if (e.skipped) { r1.append(el('span', 'change-skip', '过大未存,不可撤')); }
      else { const undo = el('button', 'mini change-undo', '回撤'); undo.title = '回撤到此前状态'; undo.onclick = () => confirmRollbackEntry(e, p, undo); r1.append(undo); }
      row.append(r1);
      // 第二行(浅色小字):用什么改的 · 大小变化(原→现) · 查看改动/打开
      const r2 = el('div', 'change-row-meta muted');
      const tool = changeToolLabel(e); if (tool) r2.append(el('span', 'change-tool', tool));
      const sz = changeSizeTransition(e); if (sz) r2.append(el('span', 'change-size', sz));
      if (!e.skipped && e.op !== 'delete') {
        if (isTextishPath(p)) { const v = el('button', 'link-mini change-view', '查看改动'); v.onclick = () => openChangeDiff(e); r2.append(v); }
        else { const o = el('button', 'link-mini change-view', '打开'); o.onclick = () => runTool('office_open', { path: p }); r2.append(o); }
      }
      row.append(r2);
      body.append(row);
    }
    card.append(body);
    list.append(card);
  }
}
// v1.4.1「曾经」:拉取单条变更的「改动前↔现在」,渲染进 #changesPreview。文本文件逐行 diff;二进制只报大小 + 打开。
async function openChangeDiff(entry) {
  const box = $('changesPreview'); if (!box) return;
  const sid = state.currentSession?.id; if (!sid) return;
  box.classList.remove('hidden'); box.textContent = '';
  box.append(el('div', 'cdiff-note muted', '加载改动…'));
  let d = null;
  try { d = await api(`/api/checkpoints/diff?sessionId=${encodeURIComponent(sid)}&turnSeq=${Number(entry.turnSeq)}&entrySeq=${Number(entry.entrySeq)}`); }
  catch (err) { box.textContent = ''; box.append(el('div', 'cdiff-note muted', '加载改动失败:' + apiErrText(err))); return; }
  box.textContent = '';
  renderChangeDiffInto(box, d, entry);
}
function renderChangeDiffInto(box, d, entry) {
  const head = el('div', 'cdiff-head');
  head.append(el('span', 'cdiff-name', fileBasename(entry.path)));
  const close = el('button', 'link-mini', '收起'); close.onclick = () => box.classList.add('hidden'); head.append(close);
  box.append(head);
  if (!d || d.ok === false) { box.append(el('div', 'cdiff-note muted', '无法读取改动:' + ((d && d.error) || '未知'))); return; }
  if (d.skipped) { box.append(el('div', 'cdiff-note muted', '此条改动前的内容过大未保存快照,无法比对。')); return; }
  if (!d.isText) {
    const bb = Number.isFinite(d.beforeBytes) ? fmtBytes(d.beforeBytes) : '—';
    const aa = Number.isFinite(d.afterBytes) ? fmtBytes(d.afterBytes) : '—';
    box.append(el('div', 'cdiff-note muted', `二进制文件(Excel/Word/PPT/图片等),无法逐行比对。大小:${bb} → ${aa}。`));
    if (d.op !== 'delete') { const o = el('button', 'mini', '打开文件查看'); o.onclick = () => runTool('office_open', { path: entry.path }); box.append(o); }
    return;
  }
  const diff = crudeLineDiff(d.before || '', d.after || '');
  box.append(el('div', 'cdiff-note muted', `+${diff.added.length} 行 / −${diff.removed.length} 行`));
  const pre = el('div', 'cdiff-body');
  const addLine = (cls, gutter, text) => { const ln = el('div', 'cdiff-line ' + cls); ln.append(el('span', 'cdiff-gutter', gutter)); ln.append(el('span', 'cdiff-text', text)); pre.append(ln); };
  for (const l of diff.ctxBefore) addLine('ctx', ' ', l);
  for (const l of diff.removed) addLine('del', '−', l);
  for (const l of diff.added) addLine('add', '+', l);
  for (const l of diff.ctxAfter) addLine('ctx', ' ', l);
  if (!diff.removed.length && !diff.added.length) pre.append(el('div', 'cdiff-line ctx', el('span', 'cdiff-text', '(内容未变化)')));
  box.append(pre);
}
// 轻量行级 diff:裁掉公共前缀/后缀,中间即改动区(单块连续编辑=精确;分散编辑=改动区略大但仍正确)。
function crudeLineDiff(before, after) {
  const a = String(before).split('\n'), b = String(after).split('\n');
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const CTX = 2, CAP = 400; // 上下文 2 行;改动区各侧最多 400 行(防超大 diff 卡浏览器)
  return {
    ctxBefore: a.slice(Math.max(0, s - CTX), s),
    removed: a.slice(s, Math.min(ea, s + CAP)),
    added: b.slice(s, Math.min(eb, s + CAP)),
    ctxAfter: a.slice(ea, Math.min(a.length, ea + CTX)),
  };
}
// Confirm-then-rollback a single checkpoint entry. Reuses buildModal (the shared confirm-modal shell).
// On success: toast + re-fetch the list (the reverted entry is gone server-side). On failure: toast err.
function confirmRollbackEntry(entry, fullPath, btn) {
  const turnSeq = Number(entry.turnSeq);
  const entrySeq = Number(entry.entrySeq);
  const bodyEl = el('div', 'confirm-body');
  bodyEl.append(el('p', '', '将把 ' + fileBasename(fullPath) + ' 恢复到第 ' + (turnSeq || 0) + ' 轮修改前的内容，当前内容会被覆盖。'));
  const foot = el('div', 'confirm-foot');
  const cancel = el('button', '', '取消');
  const ok = el('button', 'primary', '回撤');
  foot.append(cancel, ok);
  const m = buildModal('确认回撤', bodyEl, foot);
  cancel.onclick = () => m.close();
  ok.onclick = async () => {
    m.close();
    await rollbackChangeEntry(turnSeq, entrySeq, fullPath, btn);
  };
}
async function rollbackChangeEntry(turnSeq, entrySeq, fullPath, btn) {
  const sid = state.currentSession?.id;
  if (!sid) { toast('无当前会话', 'err'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '回撤中…'; }
  try {
    const r = await api('/api/checkpoints/rollback', { method: 'POST', body: JSON.stringify({ sessionId: sid, turnSeq, entrySeq }) });
    if (!r || !r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '回撤到此前状态'; }
      const reason = (r && r.error) || (r && r.failed && r.failed.length ? r.failed[0].reason : '') || '未知错误';
      toast('回撤失败：' + reason, 'err');
      return;
    }
    if ((r.failed || []).length) {
      if (btn) { btn.disabled = false; btn.textContent = '回撤到此前状态'; }
      toast('回撤失败：' + (r.failed[0].reason || '未知错误'), 'err');
      return;
    }
    toast('已回撤：' + fileBasename(fullPath), 'ok');
    loadChanges(); // re-fetch: the reverted entry is removed from the index server-side
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '回撤到此前状态'; }
    toast('回撤失败：' + apiErrText(e), 'err');
  }
}

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
    const empty = el('div', 'shell-empty', '模型可通过 shell_start/send/poll 使用持久终端;仅 provider 引擎可用。');
    host.appendChild(empty);
    return;
  }
  for (const s of shells) {
    const row = el('div', 'shell-item');
    const head = el('div', 'shell-item-head');
    const dot = el('span', 'shell-dot' + (s.running ? ' running' : ' stopped'));
    dot.title = s.running ? '运行中' : ('已结束' + (s.exitCode != null ? `(exit ${s.exitCode})` : ''));
    const meta = el('div', 'shell-meta');
    const title = el('div', 'shell-name');
    title.appendChild(dot);
    title.appendChild(el('span', 'shell-name-text', s.name || s.shellId));
    if (s.name && s.name !== s.shellId) title.appendChild(el('span', 'shell-id', s.shellId));
    meta.appendChild(title);
    meta.appendChild(el('div', 'shell-cwd', s.cwd || ''));
    head.appendChild(meta);
    const actions = el('div', 'shell-actions');
    const viewBtn = el('button', 'mini', shellUi.expanded === s.shellId ? '收起' : '查看');
    viewBtn.onclick = () => toggleShellView(s.shellId);
    const killBtn = el('button', 'mini danger', '结束');
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
  try { await shellCall('shell_kill', { shellId }); toast('已结束 shell 会话', 'ok'); }
  catch (err) { toast(`结束失败：${apiErrText(err)}`, 'err'); }
  if (shellUi.expanded === shellId) { stopShellTail(); shellUi.expanded = null; }
  refreshShellList();
}

async function newShellSession() {
  const cwd = (state.config && state.config.defaultWorkspace) || '';
  try { const res = await shellCall('shell_start', { cwd }); const r = res.result || {};
    if (r.ok) toast(`已新建 shell 会话 ${r.name || r.shellId}`, 'ok');
    else toast(r.error || '新建失败', 'err');
  } catch (err) { toast(`新建失败：${apiErrText(err)}`, 'err'); }
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
async function refreshStatus() {
  state.status = await api('/api/status');
  state.config = state.status.config || {};
  applyTheme(state.config.theme || 'dark');
  applyUiMode(state.config.uiMode || 'pro'); // v0.9-S1 (C1)
  renderWorkspacePicker(); // v0.9-S3 (C3): reflect the default/session workspace once config is loaded
  renderModelChip();
  populatePermSelect();
  updateEngineDependentUI();
  fillSettings();
  // v1.0.2 (F6b): statusLine 引擎感知。provider 模式下不再显示「未找到 Claude CLI」(那与当前引擎无关) —— 显示
  // 当前 provider·model;claude 模式才在缺 CLI 时提示去配置。CLI 已配置/检出时显示 CLI 路径。
  if (isProviderMode()) {
    const p = activeProviderObj();
    const label = (p && (p.label || p.id)) || '当前 Provider';
    const model = (p && p.model) || currentModelId() || '默认';
    setStatus(`${label} · ${model}`);
  } else {
    const ok = state.config.claudePath || state.status.detectedClaudePath;
    setStatus(ok ? `CLI: ${ok}` : '未找到 Claude CLI（点设置配置）');
  }
  renderDoctor();
  refreshModels(); // background: enrich the model list from the proxy without blocking status
  fetchCapabilities(false); // v0.8-S6: refresh the capability badge (cached; one-shot on status refresh)
}
// The model id currently in effect: the active provider's model when a native provider is selected,
// otherwise the Claude-CLI model.
function currentModelId() {
  const ap = state.config.activeProvider;
  if (ap && ap !== 'claude-cli') { const p = (state.config.providers || []).find(x => x.id === ap); return (p && p.model) || ''; }
  return state.config.model || '';
}
// True when a native OpenAI-compatible provider is the active engine (activeProvider is a non-empty
// string other than the legacy 'claude-cli' sentinel). This is the single gate for provider-mode UI.
function isProviderMode() {
  const ap = state.config.activeProvider;
  return typeof ap === 'string' && ap !== '' && ap !== 'claude-cli';
}
// The active provider object (or null in Claude mode / if the id is missing).
function activeProviderObj() {
  if (!isProviderMode()) return null;
  return (state.config.providers || []).find(p => p.id === state.config.activeProvider) || null;
}
// Human-readable name of the current engine: the provider's label (fallback id) or 'Claude CLI'.
function engineLabel() {
  const p = activeProviderObj();
  if (p) return p.label || p.id;
  return isProviderMode() ? state.config.activeProvider : 'Claude CLI';
}
// Meta describing the CURRENT engine, shaped like the per-message meta the server now sends, so the
// live streaming container and empty state can reuse the same badge/avatar renderer.
function currentEngineMeta() {
  const p = activeProviderObj();
  if (p) return { engine: 'openai', providerId: p.id, providerLabel: p.label || p.id, model: p.model || '' };
  if (isProviderMode()) return { engine: 'openai', providerId: state.config.activeProvider, providerLabel: state.config.activeProvider, model: currentModelId() };
  return { engine: 'claude', model: state.config.model || '' };
}
// Map an engine meta -> { letter, colorVar, label } for the avatar + badge (§3). Providers are keyed
// by id/label keyword so DeepSeek/Qwen/GLM get their brand color; anything else is the neutral custom.
function engineVisual(meta) {
  meta = meta || {};
  if (meta.engine === 'claude' || (!meta.engine && !meta.providerId)) {
    return { letter: 'C', colorVar: 'var(--accent)', label: 'Claude' }; // v3 (§A5): Claude 统一青花蓝(与工作流 --wf-claude 同族),消除消息区赭 vs 工作流蓝的自相矛盾
  }
  const id = String(meta.providerId || '').toLowerCase();
  const label = meta.providerLabel || meta.providerId || 'provider';
  if (/deepseek/.test(id)) return { letter: 'DS', colorVar: 'var(--eng-deepseek)', label };
  if (/dashscope|qwen|tongyi/.test(id)) return { letter: 'Q', colorVar: 'var(--eng-qwen)', label };
  if (/glm|zhipu|bigmodel/.test(id)) return { letter: 'G', colorVar: 'var(--eng-glm)', label };
  const two = (meta.providerId || 'P').replace(/[^a-z0-9]/gi, '').slice(0, 2).toUpperCase() || 'P';
  return { letter: two, colorVar: 'var(--eng-custom)', label };
}
// Recompute every piece of engine-dependent UI: provider mode hides Claude-only composer buttons and
// swaps the placeholder + proc-dot title to the active engine. Called after status refresh + engine
// switch so the two stay in lockstep.
function updateEngineDependentUI() {
  const prov = isProviderMode();
  // §5.2 (v0.7b): compactBtn is now visible in BOTH engines (provider goes through the server summary
  // endpoint). skillBtn stays Claude-only (A2: /skill is a CLI concept). Titles follow the engine.
  const compactBtn = $('compactBtn');
  if (compactBtn) { compactBtn.classList.remove('hidden'); compactBtn.title = prov ? '压缩上下文：服务端摘要压缩对话历史，释放上下文空间' : '压缩上下文：让 Claude 概括并压缩对话历史（/compact），释放上下文空间'; }
  // v1 技能体系: 「技能库」在两个引擎都可用(技能面板承载技能开关 + 命令 + Playbook),不再 Claude-only 隐藏。
  const skillBtn = $('skillBtn'); if (skillBtn) skillBtn.classList.remove('hidden');
  updateSkillBadge();
  // A3: composer placeholder follows the active engine label.
  const ta = $('promptInput');
  if (ta) ta.placeholder = `发给 ${engineLabel()} · ${currentModelId() || '默认'}…（Enter 发送，Shift+Enter 换行）`;
  renderModelChip();
  // If the empty state is currently showing, rebuild it so its engine line + CTA track the switch.
  const box = $('messages');
  if (box && box.querySelector('.empty-state') && (!state.currentSession || !(state.currentSession.messages || []).length)) {
    box.innerHTML = ''; box.appendChild(buildEmptyState());
  }
}
// Enrich the model list from GET /api/models (proxy ∪ offline for Claude; provider models ∪ live for a
// provider). Best-effort. For a provider it also folds the fresh models into that provider's config
// entry so the chip popover shows them. `announce` shows a toast (used by the popover's ↻ action).
async function refreshModels(announce) {
  try {
    const r = await api('/api/models');
    if (r && Array.isArray(r.models) && r.models.length) {
      if (r.engine === 'openai' && r.provider) {
        // Fold the live list into the active provider's models so the chip popover reflects it.
        state.config.providers = (state.config.providers || []).map(p => (p.id === r.provider ? { ...p, models: r.models } : p));
      } else if (state.status) {
        state.status.models = r.models; // Claude engine: status.models feeds the chip's Claude group
      }
      renderModelChip();
      if (announce) toast(r.proxyCount ? `模型已刷新（代理 ${r.proxyCount} 个）` : '模型已刷新（内置清单；代理未返回）', 'ok');
    } else if (announce) { toast('模型未变化', ''); }
  } catch (e) { if (announce) toast(`刷新模型失败：${apiErrText(e)}`, 'err'); }
}
function populatePermSelect() {
  const sel = $('permSelect'); sel.innerHTML = '';
  const labels = { default: '默认(询问)', acceptEdits: '接受编辑', plan: '计划模式', auto: '智能自动', bypass: '⚠ 跳过权限' };
  for (const m of (state.status?.permissionModes || ['default','acceptEdits','plan','bypass'])) {
    const o = el('option'); o.value = m; o.textContent = labels[m] || m; if (m === state.config.permissionMode) o.selected = true; sel.appendChild(o);
  }
  sel.style.color = state.config.permissionMode === 'bypass' ? 'var(--danger)' : (state.config.permissionMode === 'auto' ? 'var(--accent)' : '');
  renderPermChip(); // v1.0-S2 (IA): keep the topbar 安全 chip in sync with the mode.
}

/* ---------------- v1.0-S2 (IA): 安全 chip + 安全弹层（四档单选卡） ---------------- */
// 每档：人话短名 + 一句场景描述；bypass 为警示样式。原始模式名（default/acceptEdits/…）在专家模式作小字。
const PERM_MODE_META = {
  default:     { short: '每步都问',   desc: '每个操作先征得你同意，最稳妥' },
  acceptEdits: { short: '小改动自动做', desc: '文件编辑自动执行，命令等敏感操作仍会问你' },
  plan:        { short: '先计划再动手', desc: 'AI 先给完整计划，你批准后才执行' },
  auto:        { short: '智能自动',   desc: 'AI 自动判断风险，低风险自动执行，高风险仍会问你' },
  bypass:      { short: '全自动',     desc: '不再询问（警示样式）', danger: true },
};
function permModeShort(mode) { const m = PERM_MODE_META[mode]; return (m && m.short) || mode || '未知'; }
// Reflect the current permissionMode on the topbar 安全 chip: 人话短名 + bypass 警示着色（沿用 bypass 红色心智）。
function renderPermChip() {
  const chip = $('permChip'); if (!chip) return;
  const mode = state.config.permissionMode || 'default';
  const nameEl = chip.querySelector('.pc-name');
  if (nameEl) nameEl.textContent = permModeShort(mode); // textContent → 人话短名，XSS 安全
  chip.classList.toggle('warn', mode === 'bypass');
  chip.classList.toggle('info', mode === 'auto');
  chip.title = `安全 / 权限：${permModeShort(mode)}（点击设置）`;
}
// 安全弹层：四档单选卡（枚举来自 state.status.permissionModes，与 permSelect 一致）。点击卡片 =
// 设置 permSelect.value + dispatch('change')，完全复用既有 onchange（持久化 / bypass 确认 / toast 全部白拿）。
// 专家模式把真正的 <select id="permSelect"> 挪进弹层可见作为原始下拉；关闭时挪回 host。DOM 全 createElement/
// textContent 构建，禁 innerHTML 拼接动态内容（F 安全红线）。
function openPermPopover() {
  const chip = $('permChip'); if (!chip) return;
  const pro = document.documentElement.getAttribute('data-ui-mode') !== 'simple';
  const handle = popover(chip, close => {
    const wrap = el('div', 'perm-pop');
    wrap.appendChild(el('h4', null, '安全 / 权限模式'));
    const cards = el('div', 'perm-cards'); cards.setAttribute('role', 'radiogroup');
    const modes = (state.status && state.status.permissionModes) || ['default', 'acceptEdits', 'plan', 'bypass'];
    const cur = state.config.permissionMode || 'default';
    modes.forEach(mode => {
      const meta = PERM_MODE_META[mode] || { short: mode, desc: '' };
      const card = el('button', 'perm-card' + (meta.danger ? ' danger' : '') + (mode === cur ? ' active' : ''));
      card.type = 'button'; card.setAttribute('role', 'radio'); card.setAttribute('aria-checked', mode === cur ? 'true' : 'false');
      const top = el('div', 'perm-card-top');
      top.append(el('span', 'perm-card-radio', mode === cur ? '◉' : '○'), el('span', 'perm-card-short', meta.short));
      card.appendChild(top);
      card.appendChild(el('div', 'perm-card-desc', meta.desc));
      if (pro) card.appendChild(el('div', 'perm-card-raw', mode)); // 专家模式附原始模式名小字
      card.onclick = () => {
        const sel = $('permSelect');
        if (sel && sel.value !== mode) { sel.value = mode; sel.dispatchEvent(new Event('change')); }
        else if (sel && sel.value === mode) { /* 无变化 */ }
        close();
      };
      cards.appendChild(card);
    });
    wrap.appendChild(cards);
    // 专家模式：把真正的 <select id="permSelect"> 移进弹层可见（作为原始下拉）。关闭时须挪回 host，
    // 否则它会随弹层 DOM 一起被移除。移进的是「host + 内含 select」整块，restore 时把整块挪回锚点旁。
    if (pro) {
      const host = $('permSelectHost');
      if (host) { host.classList.remove('hidden'); wrap.appendChild(host); }
    }
    // 信任脚注。
    wrap.appendChild(el('div', 'perm-pop-foot', '文件改动都有检查点，可在审计中回看、可撤销'));
    return wrap;
  });
  // popover() 关闭（Esc/外点/重点击）时会**同步**移除弹层节点——若原始 select 的 host 被挪进弹层，它会一起被移除。
  // 用 MutationObserver 盯住弹层节点从 body 的移除：一旦被移除，立刻把 host（含 select）挪回顶栏、重新隐藏。
  // 直接持有 host 引用（不再靠 getElementById，detached 元素查不到），故顺序/时序都可靠。
  if (handle && pro && handle.node) {
    const host = $('permSelectHost');
    const parkHost = () => {
      if (!host) return;
      const bar = document.querySelector('.topbar-actions'); const chipEl = $('permChip');
      if (bar) { if (chipEl && chipEl.nextSibling) bar.insertBefore(host, chipEl.nextSibling); else bar.appendChild(host); }
      host.classList.add('hidden');
    };
    const obs = new MutationObserver(muts => {
      for (const mu of muts) { for (const n of mu.removedNodes) { if (n === handle.node) { parkHost(); obs.disconnect(); return; } } }
    });
    obs.observe(document.body, { childList: true });
  }
}
async function saveConfigPartial(patch) {
  try { const res = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) }); state.config = res.config; } catch (e) { toast(`保存失败：${apiErrText(e)}`, 'err'); }
}

let agentRoleLibraryData = null;
let agentRoleDraft = [];
function mergeRoleDraft(base, override) {
  return { ...base, ...override, models: { ...(base.models || {}), ...(override.models || {}) }, budgets: { ...(base.budgets || {}), ...(override.budgets || {}) } };
}
function splitRoleList(value) { return String(value || '').split(/[\n,]/).map(s => s.trim()).filter(Boolean); }
function captureAgentRoleDraft() {
  const cards = [...document.querySelectorAll('#agentRoleEditorList .agent-role-edit-card')];
  if (!cards.length) return agentRoleDraft;
  agentRoleDraft = cards.map(card => ({
    id: card.querySelector('[data-role-field="id"]').value.trim(),
    label: card.querySelector('[data-role-field="label"]').value.trim(),
    description: card.querySelector('[data-role-field="description"]').value.trim(),
    prompt: card.querySelector('[data-role-field="prompt"]').value.trim(),
    toolTier: card.querySelector('[data-role-field="toolTier"]').value,
    models: { openai: card.querySelector('[data-role-field="openaiModel"]').value.trim(), claude: card.querySelector('[data-role-field="claudeModel"]').value.trim() || 'inherit' },
    openaiTools: splitRoleList(card.querySelector('[data-role-field="openaiTools"]').value),
    claudeTools: splitRoleList(card.querySelector('[data-role-field="claudeTools"]').value),
    mcpServers: splitRoleList(card.querySelector('[data-role-field="mcpServers"]').value),
    permissionMode: card.querySelector('[data-role-field="permissionMode"]').value,
    budgets: { openai: Number(card.querySelector('[data-role-field="openaiBudget"]').value) || 100, claude: Number(card.querySelector('[data-role-field="claudeBudget"]').value) || 100 },
    isolation: card.querySelector('[data-role-field="isolation"]').value,
    builtin: card.dataset.builtin === '1',
  })).filter(r => r.id);
  return agentRoleDraft;
}
function roleInput(field, value, type = 'text') { const input = document.createElement('input'); input.type = type; input.value = value == null ? '' : value; input.dataset.roleField = field; return input; }
function roleField(label, control) { const wrap = el('label', 'agent-role-field'); wrap.append(el('span', '', label), control); return wrap; }
function roleSelect(field, value, choices) { const s = document.createElement('select'); s.dataset.roleField = field; for (const [v, label] of choices) { const o = el('option', '', label); o.value = v; if (v === value) o.selected = true; s.appendChild(o); } return s; }
function renderAgentRoleEditors() {
  const host = $('agentRoleEditorList'); if (!host) return; host.textContent = '';
  const scope = $('agentRoleScope')?.value || 'global';
  $('agentRoleScopeHint').textContent = scope === 'project' ? `保存到 ${currentWorkspace()}\\.ruyi\\agents.json；适合随项目共享。` : '保存在本机配置中，对所有项目生效；内置角色可在这里覆盖。';
  for (const role of agentRoleDraft) {
    const card = el('details', 'agent-role-edit-card'); card.open = agentRoleDraft.length <= 5; card.dataset.builtin = role.builtin ? '1' : '0';
    card.appendChild(el('summary', 'agent-role-edit-head', `${role.label || role.id} · ${role.toolTier || 'read'} · ${role.permissionMode || 'inherit'}`));
    const body = el('div', 'agent-role-edit-body');
    const idInput = roleInput('id', role.id); if (role.builtin) idInput.readOnly = true;
    body.append(roleField('角色 ID', idInput), roleField('显示名', roleInput('label', role.label)), roleField('用途描述', roleInput('description', role.description)));
    const prompt = document.createElement('textarea'); prompt.rows = 3; prompt.value = role.prompt || ''; prompt.dataset.roleField = 'prompt'; body.appendChild(roleField('角色指令', prompt));
    body.append(
      roleField('工具级别', roleSelect('toolTier', role.toolTier || 'read', [['read','只读'],['edit','可编辑'],['exec','可执行']])),
      roleField('角色权限', roleSelect('permissionMode', role.permissionMode || 'inherit', [['inherit','继承父级'],['default','逐项确认'],['acceptEdits','自动接受编辑'],['dontAsk','不询问，未授权即拒绝'],['plan','只读计划'],['auto','智能自动'],['bypass','跳过权限']])),
      roleField('隔离', roleSelect('isolation', role.isolation || 'none', [['none','不隔离'],['worktree','Git worktree']])),
      roleField('OpenAI 模型', roleInput('openaiModel', role.models?.openai || '')),
      roleField('Claude 模型', roleInput('claudeModel', role.models?.claude || 'inherit')),
      roleField('OpenAI 迭代', roleInput('openaiBudget', role.budgets?.openai || 100, 'number')),
      roleField('Claude 轮次', roleInput('claudeBudget', role.budgets?.claude || 100, 'number')),
      roleField('OpenAI 工具白名单', roleInput('openaiTools', (role.openaiTools || []).join(', '))),
      roleField('Claude 工具白名单', roleInput('claudeTools', (role.claudeTools || []).join(', '))),
      roleField('MCP 服务 ID', roleInput('mcpServers', (role.mcpServers || []).join(', ')))
    );
    const remove = el('button', 'mini danger', role.builtin ? '恢复内置默认' : '删除角色');
    remove.type = 'button'; remove.onclick = () => { captureAgentRoleDraft(); if (role.builtin && agentRoleLibraryData) { const base = (agentRoleLibraryData.builtinRoles || []).find(r => r.id === role.id); agentRoleDraft = agentRoleDraft.map(r => r.id === role.id ? JSON.parse(JSON.stringify(base)) : r); } else agentRoleDraft = agentRoleDraft.filter(r => r.id !== role.id); renderAgentRoleEditors(); };
    body.appendChild(remove); card.appendChild(body); host.appendChild(card);
  }
  const nativeHost = $('nativeClaudeRoleList'); nativeHost.textContent = '';
  const native = agentRoleLibraryData?.nativeClaudeRoles || [];
  if (native.length) { nativeHost.appendChild(el('h4', 'settings-subhead', 'Claude 项目原生角色（只读）')); for (const r of native) nativeHost.appendChild(el('div', 'native-claude-role', `${r.label} · ${r.file || ''}`)); }
}
function resetAgentRoleDraft() {
  if (!agentRoleLibraryData) return;
  const scope = $('agentRoleScope')?.value || 'global';
  if (scope === 'project') agentRoleDraft = JSON.parse(JSON.stringify(agentRoleLibraryData.projectRoles || []));
  else {
    const map = new Map((agentRoleLibraryData.builtinRoles || []).map(r => [r.id, JSON.parse(JSON.stringify(r))]));
    for (const r of (agentRoleLibraryData.globalRoles || [])) map.set(r.id, map.has(r.id) ? mergeRoleDraft(map.get(r.id), r) : JSON.parse(JSON.stringify(r)));
    agentRoleDraft = [...map.values()];
  }
  renderAgentRoleEditors();
}
async function loadAgentRoles() {
  try {
    const data = await api(`/api/agent-roles?cwd=${encodeURIComponent(currentWorkspace())}`); agentRoleLibraryData = data;
    const d = data.drivers || {}, omitted = d.claude?.omitted || [];
    $('agentRoleDriverStatus').textContent = `OpenAI：工作台原生执行 · Claude：原生 --agents 已同步 ${(d.claude?.synced || []).length} 个${omitted.length ? `，${omitted.length} 个因命令长度未同步` : ''}`;
    resetAgentRoleDraft();
  } catch (e) { toast(`角色库加载失败：${apiErrText(e)}`, 'err'); }
}
async function saveAgentRoles() {
  captureAgentRoleDraft(); const scope = $('agentRoleScope')?.value || 'global';
  try { await api('/api/agent-roles', { method: 'POST', body: JSON.stringify({ scope, cwd: currentWorkspace(), roles: agentRoleDraft }) }); toast('Agent 角色已保存', 'ok'); await loadAgentRoles(); }
  catch (e) { toast(`角色保存失败：${apiErrText(e)}`, 'err'); }
}
function addAgentRole() {
  captureAgentRoleDraft(); const used = new Set(agentRoleDraft.map(r => r.id)); let n = 1, id = 'custom-agent'; while (used.has(id)) id = `custom-agent-${++n}`;
  agentRoleDraft.push({ id, label: '自定义角色', description: '', prompt: '', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, isolation: 'none' }); renderAgentRoleEditors();
}
function fillSettings() {
  const c = state.config;
  $('workspaceInput').value = c.defaultWorkspace || '';
  { const el0 = $('cfgUiMode'); if (el0) el0.value = (c.uiMode === 'simple' ? 'simple' : 'pro'); } // v0.9-S1
  { const el0 = $('cfgOutputStyle'); if (el0) el0.value = (c.outputStyle === 'concise' ? 'concise' : 'detailed'); } // v0.9-S1
  $('claudePathInput').value = c.claudePath || state.status?.detectedClaudePath || '';
  $('cfgPartial').checked = !!c.includePartialMessages;
  $('cfgBeta').checked = !!c.betaInterleavedThinking;
  $('cfgResume').checked = !!c.autoResumeClaudeSessions;
  $('cfgKillDisc').checked = !!c.killOnDisconnect;
  $('cfgThinkBudget').value = c.thinkingBudget || '';
  $('cfgMaxTurns').value = c.maxTurns || '';
  $('cfgExtraArgs').value = (c.extraClaudeArgs || []).join('\n');
  $('cfgMcpMode').value = c.mcpCommandMode || 'auto';
  $('cfgEngineMode').value = c.engineMode || 'legacy';
  $('cfgPermBridge').checked = !!c.permissionBridge;
  $('cfgDiscoverModels').checked = c.discoverModelsFromProxy !== false;
  $('cfgExtraModels').value = (c.extraModels || []).join('\n');
  $('cfgModelsApiBase').value = c.modelsApiBase || '';
  $('cfgModelsApiKey').value = c.modelsApiKey || '';
  { const el0 = $('cfgClaudeAuthMode'); if (el0) el0.value = ['auto', 'bearer', 'x-api-key'].includes(c.claudeAuthMode) ? c.claudeAuthMode : 'auto'; }
  populateClaudeEndpointPresets();
  const kp = $('cfgKillPort'); if (kp) kp.checked = c.killPortOnStart !== false;
  // v1.0.2 (G5a): 单回合工具调用上限 (openaiMaxToolIterations, 1..100, 默认 100)。
  { const el0 = $('cfgOpenaiMaxToolIterations'); if (el0) el0.value = Number.isFinite(Number(c.openaiMaxToolIterations)) && c.openaiMaxToolIterations ? c.openaiMaxToolIterations : 100; }
  { const el0 = $('cfgSubagentMaxConcurrent'); if (el0) el0.value = Math.max(1, Math.min(8, Number(c.subagentMaxConcurrent) || 8)); }
  { const el0 = $('cfgSubagentMaxPerTurn'); if (el0) el0.value = Math.max(0, Math.min(32, Number.isFinite(Number(c.subagentMaxPerTurn)) ? Number(c.subagentMaxPerTurn) : 32)); }
  { const el0 = $('cfgAgentWorkflowMaxNodes'); if (el0) el0.value = Math.max(1, Math.min(32, Number(c.agentWorkflowMaxNodes) || 32)); }
  // v0.7d: integrations / MCP tab.
  const dm = c.desktopMcp || {};
  const dmEn = $('cfgDesktopMcpEnabled'); if (dmEn) dmEn.checked = dm.enabled !== false;
  const dmCmd = $('cfgDesktopMcpCommand'); if (dmCmd) dmCmd.value = dm.command || '';
  const dmArgs = $('cfgDesktopMcpArgs'); if (dmArgs) dmArgs.value = (dm.args || []).join('\n');
  const dmCwd = $('cfgDesktopMcpCwd'); if (dmCwd) dmCwd.value = dm.cwd || '';
  const brEx = $('cfgBridgeExternal'); if (brEx) brEx.checked = c.bridgeExternalToolsToProvider !== false;
  // v1.0-S3 (B1): 联网搜索 (searchBackend {type,baseUrl,apiKey}). apiKey arrives masked from GET /api/status
  // (••••<last4> when hasKey); seed the field with the mask and, if the user leaves it untouched, echo it
  // straight back so the server's unmaskSecrets restores the real key — same discipline as providers[].apiKey.
  const sb = c.searchBackend || {};
  // v1.1-W1a 把关补:白名单加 'builtin'(免费内置搜索,新装默认)。缺了它,builtin 配置在设置页会被显示成
  // 「不启用」(纯显示 bug,后端不受影响);fallback 也改 'builtin' 与 normalizeConfig 的迁移语义一致。
  { const el0 = $('cfgSearchType'); if (el0) el0.value = ['none', 'builtin', 'searxng', 'bing', 'brave', 'tavily', 'bocha', 'custom'].includes(sb.type) ? sb.type : 'builtin'; }
  { const el0 = $('cfgSearchBaseUrl'); if (el0) el0.value = sb.baseUrl || ''; }
  { const el0 = $('cfgSearchApiKey'); if (el0) el0.value = sb.apiKey || ''; }
  updateSearchBackendVisibility();
  const dmStat = $('cfgDesktopMcpStatus');
  if (dmStat) {
    const info = (state.status && state.status.desktopMcp) || null;
    if (!info || info.enabled === false) dmStat.textContent = '（未启用）';
    else if (info.resolved && info.resolved.command) dmStat.textContent = '已发现桌面 MCP: ' + info.resolved.command + (info.resolved.args && info.resolved.args.length ? ' ' + info.resolved.args.join(' ') : '');
    else if (info.detected && info.detected.command) dmStat.textContent = '已探测: ' + info.detected.command + (info.detected.args && info.detected.args.length ? ' ' + info.detected.args.join(' ') : '');
    else dmStat.textContent = '未发现（请填写命令覆盖，或确认 ai-computer-control 已安装）';
  }
  // Advanced tab: read-only diagnostics.
  const s = state.status || {};
  const dr = $('advDataRoot'); if (dr) dr.textContent = s.dataRoot || '';
  const av = $('advVersion'); if (av) av.textContent = 'v' + (s.version || '') + ' · ' + (s.launchMode || '');
  const ao = $('advOverlayId'); if (ao) ao.textContent = s.overlayId || '';
  // 月度成本预算（基础 tab，简易模式可见）+ Claude 第三方端点可选单价（Claude CLI tab）。留空=不设/不估。
  { const b = c.usageBudget || {}; const m = $('cfgUsageBudgetMonthly'); if (m) m.value = (b.monthly === 0 || b.monthly) ? String(b.monthly) : ''; const cur = $('cfgUsageBudgetCurrency'); if (cur) cur.value = b.currency || 'CNY'; }
  { const cpr = c.claudePricing || {}; const pi = $('cfgClaudePriceIn'); if (pi) pi.value = (cpr.inputPerM === 0 || cpr.inputPerM) ? String(cpr.inputPerM) : ''; const po = $('cfgClaudePriceOut'); if (po) po.value = (cpr.outputPerM === 0 || cpr.outputPerM) ? String(cpr.outputPerM) : ''; const pc = $('cfgClaudePriceCurrency'); if (pc) pc.value = cpr.currency || 'CNY'; }
  populateProviderPresets();
  // A8: a background refreshStatus() calls fillSettings on a timer. If the settings modal is OPEN the
  // user may be mid-edit on a provider draft — re-seeding it here would silently discard their edits.
  // Skip the draft replay + re-render while open; everything else (read-only-ish fields) is fine to set.
  if ($('settingsModal').classList.contains('hidden')) {
    state.providersDraft = JSON.parse(JSON.stringify(c.providers || []));
    renderProviders();
  }
}
// v1.0-S3 (B1): 按搜索服务类型联动显隐相关字段。searxng/custom → 显 Base URL；bing/brave → 显 API 密钥；
// none → 都藏。不改任何值，只切 .hidden。
// v1.0-S6 (A): tavily/bocha → 显 API 密钥 + 显 Base URL（Base URL 可选，留空用官方地址）。Base URL 的 label
// 文案随类型切换：tavily/bocha 时注明「可选」，其余类型保持「Base URL」。
function updateSearchBackendVisibility() {
  const sel = $('cfgSearchType'); if (!sel) return;
  const type = sel.value;
  const baseRow = $('cfgSearchBaseUrlRow');
  const keyRow = $('cfgSearchApiKeyRow');
  const optionalBase = type === 'tavily' || type === 'bocha'; // 官方地址已内置 → baseUrl 仅作覆写，可留空
  const showBase = type === 'searxng' || type === 'custom' || optionalBase;
  const showKey = type === 'bing' || type === 'brave' || type === 'tavily' || type === 'bocha';
  if (baseRow) {
    baseRow.classList.toggle('hidden', !showBase);
    const lbl = baseRow.querySelector('label');
    if (lbl) lbl.textContent = optionalBase ? 'Base URL（可选，留空用官方地址）' : 'Base URL';
  }
  if (keyRow) keyRow.classList.toggle('hidden', !showKey);
}
async function saveSettings() {
  const patch = {
    defaultWorkspace: $('workspaceInput').value.trim(),
    uiMode: $('cfgUiMode') ? $('cfgUiMode').value : (state.config.uiMode || 'pro'),           // v0.9-S1 (C1)
    outputStyle: $('cfgOutputStyle') ? $('cfgOutputStyle').value : (state.config.outputStyle || 'detailed'), // v0.9-S1 (C1)
    claudePath: $('claudePathInput').value.trim(),
    includePartialMessages: $('cfgPartial').checked,
    betaInterleavedThinking: $('cfgBeta').checked,
    autoResumeClaudeSessions: $('cfgResume').checked,
    killOnDisconnect: $('cfgKillDisc').checked,
    thinkingBudget: $('cfgThinkBudget').value.trim(),
    maxTurns: $('cfgMaxTurns').value.trim(),
    extraClaudeArgs: $('cfgExtraArgs').value.split('\n').map(s => s.trim()).filter(Boolean),
    mcpCommandMode: $('cfgMcpMode').value,
    engineMode: $('cfgEngineMode').value,
    permissionBridge: $('cfgPermBridge').checked,
    discoverModelsFromProxy: $('cfgDiscoverModels').checked,
    extraModels: $('cfgExtraModels').value.split('\n').map(s => s.trim()).filter(Boolean),
    modelsApiBase: $('cfgModelsApiBase').value.trim(),
    modelsApiKey: $('cfgModelsApiKey').value,
    claudeAuthMode: $('cfgClaudeAuthMode') ? $('cfgClaudeAuthMode').value : (state.config.claudeAuthMode || 'auto'),
    killPortOnStart: $('cfgKillPort') ? $('cfgKillPort').checked : (state.config.killPortOnStart !== false),
    // v1.0.2 (G5a): 单回合工具调用上限。Number() 转换 + 夹到 1..100(后端 normalizeConfig 亦再夹一次)。
    openaiMaxToolIterations: (() => {
      const el0 = $('cfgOpenaiMaxToolIterations');
      if (!el0) return state.config.openaiMaxToolIterations || 100;
      const n = Math.round(Number(el0.value));
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(100, n));
    })(),
    subagentMaxConcurrent: (() => {
      const el0 = $('cfgSubagentMaxConcurrent');
      const n = Math.round(Number(el0 ? el0.value : state.config.subagentMaxConcurrent));
      return Number.isFinite(n) ? Math.max(1, Math.min(8, n)) : 8;
    })(),
    subagentMaxPerTurn: (() => {
      const el0 = $('cfgSubagentMaxPerTurn');
      const n = Math.round(Number(el0 ? el0.value : state.config.subagentMaxPerTurn));
      return Number.isFinite(n) ? Math.max(0, Math.min(32, n)) : 32;
    })(),
    agentWorkflowMaxNodes: (() => {
      const el0 = $('cfgAgentWorkflowMaxNodes');
      const n = Math.round(Number(el0 ? el0.value : state.config.agentWorkflowMaxNodes));
      return Number.isFinite(n) ? Math.max(1, Math.min(32, n)) : 32;
    })(),
    providers: state.providersDraft || [],
    // v0.7d: desktop MCP + bridge switch. autodetect stays on so a blank command keeps auto-discovering.
    desktopMcp: {
      enabled: $('cfgDesktopMcpEnabled') ? $('cfgDesktopMcpEnabled').checked : true,
      command: $('cfgDesktopMcpCommand') ? $('cfgDesktopMcpCommand').value.trim() : '',
      args: $('cfgDesktopMcpArgs') ? $('cfgDesktopMcpArgs').value.split('\n').map(s => s.trim()).filter(Boolean) : [],
      cwd: $('cfgDesktopMcpCwd') ? $('cfgDesktopMcpCwd').value.trim() : '',
      autodetect: true,
    },
    bridgeExternalToolsToProvider: $('cfgBridgeExternal') ? $('cfgBridgeExternal').checked : true,
    // v1.0-S3 (B1): 联网搜索。apiKey 走 providers 同款掩码回存——若框内仍是 ••••<last4> 掩码（用户没动它），
    // 原样回传，后端 unmaskSecrets 会还原真 key；用户输入了新明文则原样提交。
    searchBackend: {
      type: $('cfgSearchType') ? $('cfgSearchType').value : ((state.config.searchBackend && state.config.searchBackend.type) || 'none'),
      baseUrl: $('cfgSearchBaseUrl') ? $('cfgSearchBaseUrl').value.trim() : '',
      apiKey: $('cfgSearchApiKey') ? $('cfgSearchApiKey').value : '',
    },
    // 月度成本预算：留空 → null（不设预算，用量看板不显进度）。后端接纳 {monthly,currency}。
    usageBudget: (() => {
      const m = $('cfgUsageBudgetMonthly'); const cur = $('cfgUsageBudgetCurrency');
      const v = m ? m.value.trim() : '';
      if (v === '') return null;
      const n = Number(v);
      return { monthly: Number.isFinite(n) ? Math.max(0, n) : 0, currency: cur ? cur.value : 'CNY' };
    })(),
    // Claude 第三方端点可选单价（次要）：两项皆空 → null。后端若支持 config.claudePricing 则据以估算成本。
    claudePricing: (() => {
      const pi = $('cfgClaudePriceIn'), po = $('cfgClaudePriceOut'), pc = $('cfgClaudePriceCurrency');
      const iv = pi ? pi.value.trim() : '', ov = po ? po.value.trim() : '';
      if (iv === '' && ov === '') return null;
      const out = { currency: pc ? pc.value : 'CNY' };
      if (iv !== '') { const n = Number(iv); if (Number.isFinite(n)) out.inputPerM = Math.max(0, n); }
      if (ov !== '') { const n = Number(ov); if (Number.isFinite(n)) out.outputPerM = Math.max(0, n); }
      return out;
    })(),
  };
  await saveConfigPartial(patch);
  $('settingsStatus').textContent = '已保存 ✓';
  setTimeout(() => { $('settingsStatus').textContent = ''; }, 2000);
  await refreshStatus();
}

/* ---------------- Claude CLI third-party endpoint presets (Coding Plan) ---------------- */
// Fills the flat modelsApiBase/modelsApiKey/claudeAuthMode/extraModels fields for the Claude CLI engine
// (not a Provider — those stay in providersDraft). One click replaces the manual setx steps in
// docs/manuals/ADMIN-GUIDE_CN.md §2.1.1.
function populateClaudeEndpointPresets() {
  const sel = $('cfgClaudeEndpointPreset'); if (!sel) return;
  const previous = sel.value;
  sel.innerHTML = '';
  const presets = (state.status && state.status.claudeEndpointPresets) || [];
  for (const p of presets) { const o = el('option'); o.value = p.id; o.textContent = p.label || p.id; sel.appendChild(o); }
  if (presets.some(p => p.id === previous)) sel.value = previous;
}
function applyClaudeEndpointPreset() {
  const sel = $('cfgClaudeEndpointPreset'); if (!sel) return;
  const presets = (state.status && state.status.claudeEndpointPresets) || [];
  const preset = presets.find(p => p.id === sel.value) || presets[0];
  if (!preset) return;
  $('cfgModelsApiBase').value = preset.baseUrl || '';
  const authSel = $('cfgClaudeAuthMode'); if (authSel) authSel.value = ['auto', 'bearer', 'x-api-key'].includes(preset.authMode) ? preset.authMode : 'auto';
  // Never clobber a key the user already typed; a preset only ever supplies endpoint/model shape, not secrets.
  const keyInput = $('cfgModelsApiKey');
  if (keyInput && !keyInput.value.trim() && preset.authKeyHint) keyInput.placeholder = preset.authKeyHint;
  if (preset.models && preset.models.length) {
    $('cfgExtraModels').value = preset.models.filter(m => m.id).map(m => `${m.id}|${m.label || m.id}`).join('\n');
  }
  toast(`已应用预设：${preset.label}${preset.defaultModelHint ? '（' + preset.defaultModelHint + '）' : ''}，请填入密钥后保存`, 'ok');
}
/* ---------------- providers (native OpenAI-compatible engines) ---------------- */
function populateProviderPresets() {
  const sel = $('providerPresetSelect'); if (!sel) return;
  sel.innerHTML = '';
  const presets = (state.status && state.status.providerPresets) || [];
  for (const p of presets) { const o = el('option'); o.value = p.id; o.textContent = p.label || p.id; sel.appendChild(o); }
}
function addProviderFromPreset() {
  const sel = $('providerPresetSelect'); if (!sel) return;
  const presets = (state.status && state.status.providerPresets) || [];
  const preset = presets.find(p => p.id === sel.value) || presets[0];
  if (!preset) return;
  state.providersDraft = state.providersDraft || [];
  const existing = new Set(state.providersDraft.map(p => p.id));
  let id = preset.id, n = 2; while (existing.has(id)) { id = `${preset.id}-${n++}`; }
  state.providersDraft.push({
    id, label: preset.label || id, type: 'openai-compat',
    baseUrl: preset.baseUrl || '', apiKey: '',
    model: preset.defaultModel || (preset.models && preset.models[0] && preset.models[0].id) || '',
    models: (preset.models || []).map(m => ({ id: m.id, label: m.label || m.id })),
    reasoning: !!preset.reasoning, systemPrompt: '', temperature: '',
  });
  renderProviders();
}
function renderProviders() {
  const box = $('providersList'); if (!box) return;
  box.innerHTML = '';
  const list = state.providersDraft || [];
  if (!list.length) { box.appendChild(el('div', 'muted', '未配置 Provider。下方选模板（DeepSeek / 通义千问 / 自定义）添加，再填密钥。')); return; }
  list.forEach((p, idx) => box.appendChild(providerCard(p, idx)));
}
function providerCard(p, idx) {
  const card = el('div', 'prov-card');
  const head = el('div', 'prov-head');
  const labelIn = el('input', 'prov-label'); labelIn.value = p.label || ''; labelIn.placeholder = '显示名'; labelIn.oninput = () => { p.label = labelIn.value; };
  const idTag = el('span', 'prov-id', p.id);
  const modChip = el('span', 'prov-modct', `${(p.models || []).length} 个模型`);
  const reason = el('label', 'check prov-reason'); const rc = el('input'); rc.type = 'checkbox'; rc.checked = !!p.reasoning; rc.onchange = () => { p.reasoning = rc.checked; };
  reason.appendChild(rc); reason.appendChild(document.createTextNode(' 推理链'));
  // v1.0-S3 (B2): per-provider vision 开关（能力矩阵/视觉回路读 provider.vision）。同 reasoning 开关的模式。
  const visionLbl = el('label', 'check prov-reason'); const vc = el('input'); vc.type = 'checkbox'; vc.checked = !!p.vision; vc.onchange = () => { p.vision = vc.checked; };
  visionLbl.appendChild(vc); visionLbl.appendChild(document.createTextNode(' 支持视觉（能看图/截图）'));
  const testBtn = el('button', 'file-label', '测试连接'); testBtn.type = 'button'; testBtn.onclick = () => testProvider(idx, testBtn);
  const delBtn = el('button', 'file-label prov-del', '删除'); delBtn.type = 'button';
  // A6: deleting a provider also drops its API key — confirm so a misclick can't silently lose it.
  delBtn.onclick = () => { if (!confirm('删除 Provider「' + (p.label || p.id) + '」？其 API 密钥将一并移除')) return; state.providersDraft.splice(idx, 1); renderProviders(); };
  head.append(labelIn, idTag, modChip, reason, visionLbl, testBtn, delBtn);

  const b2 = el('div', 'field-block'); b2.append(el('label', '', 'Base URL'));
  const bi = el('input'); bi.type = 'text'; bi.value = p.baseUrl || ''; bi.placeholder = 'https://api.deepseek.com'; bi.oninput = () => { p.baseUrl = bi.value.trim(); }; b2.append(bi);

  const grid = el('div', 'field-grid');
  const kb = el('div', 'field-block'); kb.append(el('label', '', 'API 密钥'));
  const keyWrap = el('div', 'prov-key-wrap');
  const ki = el('input'); ki.type = 'password'; ki.autocomplete = 'off'; ki.value = p.apiKey || ''; ki.placeholder = 'sk-...'; ki.oninput = () => { p.apiKey = ki.value; };
  const eye = el('button', 'prov-key-eye', '👁'); eye.type = 'button'; eye.title = '显示/隐藏密钥';
  eye.onclick = () => { const show = ki.type === 'password'; ki.type = show ? 'text' : 'password'; eye.classList.toggle('on', show); };
  keyWrap.append(ki, eye); kb.append(keyWrap);
  const mb = el('div', 'field-block'); mb.append(el('label', '', '模型'));
  const mi = el('input'); mi.type = 'text'; mi.value = p.model || ''; mi.placeholder = 'deepseek-chat'; mi.setAttribute('list', `provModels_${idx}`); mi.oninput = () => { p.model = mi.value.trim(); };
  const dl = el('datalist'); dl.id = `provModels_${idx}`; for (const m of (p.models || [])) { const o = el('option'); o.value = m.id; o.textContent = m.label || m.id; dl.appendChild(o); }
  mb.append(mi, dl); grid.append(kb, mb);

  // v1.0.2 (G5b): 上下文窗口手动覆盖(留空=自动检测)。其下小字显示当前生效值(仅当前激活 provider 有,取
  // /api/status.contextWindowResolved),source 人话映射。空串保存时删该字段(providerCard 写 p.contextWindow)。
  const cwB = el('div', 'field-block'); cwB.append(el('label', '', '上下文窗口'));
  const cwi = el('input'); cwi.type = 'text'; cwi.value = (p.contextWindow === 0 || p.contextWindow) ? String(p.contextWindow) : '';
  cwi.placeholder = '自动检测';
  cwi.oninput = () => { const v = cwi.value.trim(); if (v === '') { delete p.contextWindow; } else { const n = Math.round(Number(v)); p.contextWindow = Number.isFinite(n) ? n : ''; } };
  cwB.append(cwi);
  cwB.append(contextResolvedHint(p));

  // 单价 · 成本估算（可选）：inputPerM/outputPerM(每百万 token)+ currency → p.pricing。留空=不估成本，
  // 「用量」看板只显 token 数。填了后端接纳并据以估算该 provider 的成本（按币种分组，不换算）。
  const priceB = el('div', 'field-block prov-pricing');
  priceB.append(el('label', '', '单价 · 成本估算（可选，每百万 token）'));
  const pr = p.pricing || {};
  const pgrid = el('div', 'prov-pricing-grid');
  const inCell = el('label', 'prov-pricing-cell'); inCell.append(el('span', 'prov-pricing-cap', '输入 / 百万'));
  const inI = el('input'); inI.type = 'number'; inI.min = '0'; inI.step = '0.01'; inI.placeholder = '如 2'; inI.value = (pr.inputPerM === 0 || pr.inputPerM) ? String(pr.inputPerM) : ''; inCell.append(inI);
  const outCell = el('label', 'prov-pricing-cell'); outCell.append(el('span', 'prov-pricing-cap', '输出 / 百万'));
  const outI = el('input'); outI.type = 'number'; outI.min = '0'; outI.step = '0.01'; outI.placeholder = '如 8'; outI.value = (pr.outputPerM === 0 || pr.outputPerM) ? String(pr.outputPerM) : ''; outCell.append(outI);
  const curCell = el('label', 'prov-pricing-cell'); curCell.append(el('span', 'prov-pricing-cap', '币种'));
  const curSel = el('select'); for (const c of PRICING_CURRENCIES) { const o = el('option'); o.value = c.code; o.textContent = c.label; curSel.appendChild(o); } curSel.value = pr.currency || 'CNY'; curCell.append(curSel);
  pgrid.append(inCell, outCell, curCell); priceB.append(pgrid);
  priceB.append(el('p', 'field-help muted', '填了才能算该服务商的成本，不填只显示 token 数。单价 = 每百万 token 价格。'));
  const syncPricing = () => {
    const iv = inI.value.trim(), ov = outI.value.trim();
    if (iv === '' && ov === '') { delete p.pricing; return; }
    p.pricing = {};
    if (iv !== '') { const n = Number(iv); if (Number.isFinite(n)) p.pricing.inputPerM = Math.max(0, n); }
    if (ov !== '') { const n = Number(ov); if (Number.isFinite(n)) p.pricing.outputPerM = Math.max(0, n); }
    p.pricing.currency = curSel.value || 'CNY';
  };
  inI.oninput = syncPricing; outI.oninput = syncPricing; curSel.onchange = syncPricing;

  const adv = el('details', 'prov-adv'); adv.append(el('summary', '', '高级（系统提示 / 采样温度 / 备用端点）'));
  const sb = el('div', 'field-block'); sb.append(el('label', '', '系统提示（留空=内置）'));
  const st = el('textarea'); st.rows = 2; st.value = p.systemPrompt || ''; st.oninput = () => { p.systemPrompt = st.value; }; sb.append(st);
  const tb = el('div', 'field-block'); tb.append(el('label', '', '温度（0–2，留空=不发送）'));
  const ti = el('input'); ti.type = 'text'; ti.value = (p.temperature === 0 || p.temperature) ? String(p.temperature) : ''; ti.placeholder = '例如 0.7';
  ti.oninput = () => { const v = ti.value.trim(); p.temperature = v === '' ? '' : (Number.isFinite(Number(v)) ? Number(v) : ''); }; tb.append(ti);
  // v1.0-S6 (B4): 备用端点（每行一个，最多 3）。主端点「预首字节」失败（连不上 / 502·503·504）时按顺序切换。
  // 读写 p.extraBaseUrls，空行过滤；后端 sanitizeProvider 会再做 trim/去重/去主端点/截断≤3 的清洗。
  const eb = el('div', 'field-block'); eb.append(el('label', '', '备用端点（每行一个，最多 3；主端点连不上时按序切换）'));
  const eti = el('textarea'); eti.rows = 2; eti.placeholder = 'https://backup1.example.com\nhttps://backup2.example.com';
  eti.value = Array.isArray(p.extraBaseUrls) ? p.extraBaseUrls.join('\n') : '';
  eti.oninput = () => { p.extraBaseUrls = eti.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3); }; eb.append(eti);
  adv.append(sb, tb, eb);

  const status = el('div', 'prov-status muted'); status.id = `provStatus_${idx}`;
  card.append(head, b2, grid, cwB, priceB, adv, status);
  return card;
}
// v1.0.2 (G5b): 「当前生效」小字。仅当此 provider 是当前激活引擎时,从 /api/status.contextWindowResolved 取
// 生效值 + 来源。source 人话:manual=手动 / probe=接口探测 / table=内置表 / fallback=保守默认。非激活 provider
// 或无数据时给一句静态说明(手动填的值下一次该引擎生效时才会体现在这里)。返回一个 .prov-ctx-hint 元素。
const CTX_SOURCE_LABEL = { manual: '手动', probe: '接口探测', table: '内置表', fallback: '保守默认' };
function contextResolvedHint(p) {
  const hint = el('div', 'prov-ctx-hint muted');
  const r = state.status && state.status.contextWindowResolved;
  if (r && r.provider && p && r.provider === p.id && Number(r.value) > 0) {
    const src = CTX_SOURCE_LABEL[r.source] || r.source || '未知';
    hint.textContent = '当前生效：' + Number(r.value).toLocaleString('en-US') + '（来源：' + src + '）';
  } else {
    hint.textContent = '留空自动检测。把此引擎切为当前引擎后，这里会显示实际生效值与来源。';
  }
  return hint;
}
async function testProvider(idx, btn) {
  const p = state.providersDraft[idx]; if (!p) return;
  const status = $(`provStatus_${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
  try {
    const r = await api('/api/provider/test', { method: 'POST', body: JSON.stringify({ provider: p }) });
    if (r && r.ok) {
      if (Array.isArray(r.models) && r.models.length) p.models = r.models;
      if (status) { status.textContent = `✓ 连接成功，返回 ${r.models ? r.models.length : 0} 个模型`; status.classList.remove('bad'); status.classList.add('good'); }
      renderProviders();
    } else if (status) { status.textContent = `✗ ${(r && r.error) || '连接失败'}`; status.classList.remove('good'); status.classList.add('bad'); }
  } catch (e) { if (status) { status.textContent = `✗ ${apiErrText(e)}`; status.classList.add('bad'); } }
  finally { if (btn) { btn.disabled = false; btn.textContent = '测试连接'; } }
}

// v1.0.2 (G5c): 从文件夹导入外部 MCP。POST /api/pick-folder(原生选择器)→ 取 path → POST /api/mcp/import-folder。
// 成功 toast「已添加/已更新 <label|id>」+ 刷新状态(refreshStatus 会重拉 config → fillSettings)。失败且响应
// 带 template 时弹说明 modal(可复制的模板 JSON,textContent 渲染)。
async function importMcpFromFolder(btn) {
  if (btn) { btn.disabled = true; }
  let pf;
  try { pf = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
  catch (e) { toast('选择器出错：' + apiErrText(e), 'err'); if (btn) btn.disabled = false; return; }
  if (!pf || !pf.ok) { toast('无法打开选择器：' + ((pf && pf.error) || '未知'), 'err'); if (btn) btn.disabled = false; return; }
  if (pf.cancelled || !pf.path) { if (btn) btn.disabled = false; return; } // user backed out
  try {
    const r = await api('/api/mcp/import-folder', { method: 'POST', body: JSON.stringify({ path: pf.path }) });
    if (r && r.ok) {
      const srv = r.server || {};
      const name = srv.label || srv.id || '外部 MCP';
      toast((r.updated ? '已更新 ' : '已添加 ') + name, 'ok');
      await refreshStatus(); // re-pull config → fillSettings re-seeds the integrations view
    } else {
      // 缺少/无效清单 → 弹模板说明 modal(若响应带 template);否则纯 toast。
      if (r && r.template) showMcpTemplateModal(r.error || '该文件夹缺少 ruyi-mcp.json 清单', r.template);
      else toast('导入失败：' + ((r && r.error) || '未知错误'), 'err');
    }
  } catch (e) {
    toast('导入失败：' + apiErrText(e), 'err');
  } finally { if (btn) btn.disabled = false; }
}
// v1.0.2 (G5c): 缺清单说明 modal。展示可复制的 ruyi-mcp.json 模板(textContent — 绝不 innerHTML 拼接)。
function showMcpTemplateModal(reason, template) {
  const body = el('div', 'mcp-tpl-body');
  body.append(el('p', 'mcp-tpl-reason', reason));
  body.append(el('p', 'muted', '在该文件夹下创建一个 ruyi-mcp.json 文件，内容参考下面的模板（至少填 id 与 command），再重新导入即可。'));
  const preWrap = el('div', 'mcp-tpl-pre-wrap');
  const pre = el('pre', 'mcp-tpl-pre');
  let tplText = '';
  try { tplText = JSON.stringify(template, null, 2); } catch { tplText = String(template); }
  pre.textContent = tplText; // XSS: textContent, never innerHTML
  const copyBtn = el('button', 'mini mcp-tpl-copy', '复制');
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(tplText); copyBtn.textContent = '已复制 ✓'; setTimeout(() => { copyBtn.textContent = '复制'; }, 1500); }
    catch { toast('复制失败，请手动选择文本复制', 'err'); }
  };
  preWrap.append(copyBtn, pre);
  body.append(preWrap);
  const foot = el('div', 'confirm-foot');
  const ok = el('button', 'primary', '知道了');
  foot.append(ok);
  const m = buildModal('缺少 MCP 清单', body, foot);
  ok.onclick = () => m.close();
}

/* ---------------- doctor ---------------- */
function renderDoctor() {
  const panel = $('doctorPanel'); if (!panel) return;
  panel.innerHTML = '';
  const s = state.status;
  panel.appendChild(healthRow(true, '版本', `v${s.version} · 启动=${s.launchMode} · overlay=${s.overlayId}`));
  for (const h of (s.health || [])) panel.appendChild(healthRow(h.ok, h.id, h.detail));
}
function healthRow(ok, id, detail) {
  const row = el('div', `health-row ${ok ? 'ok' : 'bad'}`);
  row.append(el('span', 'h-dot', ok ? '●' : '●'));
  const body = el('div', 'h-body'); body.append(el('div', 'h-id', id), el('div', 'h-detail', detail || ''));
  row.appendChild(body);
  return row;
}

/* ---------------- v4: export/import, templates, MCP inspector ---------------- */
function exportSession(fmt) {
  const s = state.currentSession;
  if (!s) { toast('先打开一个会话', 'err'); return; }
  let content, mime, ext;
  if (fmt === 'json') {
    content = JSON.stringify(s, null, 2); mime = 'application/json'; ext = 'json';
  } else if (fmt === 'html') {
    const rows = (s.messages || []).map(m => `<div class="m ${escapeHtml(m.role)}"><b>${escapeHtml(m.role)}</b><pre>${escapeHtml(m.content || '')}</pre></div>`).join('\n');
    content = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(s.title || '')}</title><style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}pre{white-space:pre-wrap;background:#f4f4f4;padding:8px;border-radius:6px}.m{margin:1rem 0}</style><h1>${escapeHtml(s.title || '')}</h1>${rows}`;
    mime = 'text/html'; ext = 'html';
  } else {
    content = `# ${s.title || 'Session'}\n\n` + (s.messages || []).map(m => `## ${m.role}\n\n${m.content || ''}`).join('\n\n'); mime = 'text/markdown'; ext = 'md';
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${(s.title || 'session').replace(/[^\w一-龥-]+/g, '_').slice(0, 40)}.${ext}`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importSession() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
  inp.onchange = async () => {
    const file = inp.files[0]; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: (data.title || file.name) + ' (导入)', cwd: data.cwd || '', messages }) });
      await refreshSessions(); await openSession(res.session.id); toast('已导入会话', 'ok');
    } catch (e) { toast('导入失败：' + apiErrText(e), 'err'); }
  };
  inp.click();
}
function getTemplates() { try { return JSON.parse(localStorage.getItem('wcw.templates') || '[]'); } catch { return []; } }
function saveTemplates(t) { try { localStorage.setItem('wcw.templates', JSON.stringify(t)); } catch { /* ignore */ } }
function addTemplateFromPrompt() {
  const text = $('promptInput').value.trim(); if (!text) { toast('输入框为空', 'err'); return; }
  const name = prompt('模板名称', text.slice(0, 24)); if (!name) return;
  const t = getTemplates(); t.push({ name, text }); saveTemplates(t); toast('已保存模板', 'ok');
}
function insertTemplate(text) { const ta = $('promptInput'); ta.value = text; autoGrow(ta); ta.focus(); }

async function openMcpInspector() {
  switchTab('mcp'); openToolPane();
  const box = $('mcpToolList'); if (!box) return;
  box.innerHTML = '运行中…';
  const tools = state.status?.tools || [];
  box.innerHTML = '';
  for (const t of tools) {
    const card = el('details', 'tool-card');
    const sum = el('summary'); sum.append(el('span', 'tc-name', t.name)); card.appendChild(sum);
    const bodyEl = el('div', 'tc-body');
    bodyEl.appendChild(el('div', 'muted', t.description || ''));
    const props = t.inputSchema?.properties || {};
    const inputs = {};
    for (const key of Object.keys(props)) {
      bodyEl.appendChild(el('div', 'tc-label', key + (props[key].type ? ` (${props[key].type})` : '')));
      const inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = key; inputs[key] = inp; bodyEl.appendChild(inp);
    }
    const run = el('button', 'mini', '运行');
    run.onclick = () => {
      const args = {};
      for (const [k, inp] of Object.entries(inputs)) { if (inp.value !== '') { const t2 = props[k]?.type; args[k] = t2 === 'number' ? Number(inp.value) : t2 === 'boolean' ? inp.value === 'true' : inp.value; } }
      runTool(t.name, args);
    };
    bodyEl.appendChild(run);
    card.appendChild(bodyEl);
    box.appendChild(card);
  }
}

/* ---------------- skill library panel (v1 技能体系) ---------------- */
// 「技能库」升级(原「技能 / 命令面板」):三分组——技能(可启用/停用,两个引擎通用)、命令(仅 Claude 模式,
// 沿用插入 /name)、一键任务(Playbook,走 openPlaybookModal 流程)。技能启用状态存在 session.skills,
// 通过 POST /api/session/skills 落盘。skillFiltered 是「按显示顺序拍平」的当前可选项(供键盘上下 + Enter)。
let skillRegistry = [];
let skillFiltered = [];
let skillIndex = 0;
// P3-5: 技能开关串行化 —— 模块级单飞 promise 链(并发点击按序落盘,避免读改写竞态覆盖)+ 在途 id 集合(禁用对应行开关)。
let skillToggleChain = Promise.resolve();
const skillTogglePending = new Set();
// P2-2: session.skills 元素为 {id, source}(或旧裸字符串);统一取出 id 列表。
function enabledSkillIds() {
  const arr = (state.currentSession && Array.isArray(state.currentSession.skills)) ? state.currentSession.skills : [];
  return arr.map(x => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);
}
async function openSkillPanel() {
  openModal('skillModal');
  const s = $('skillSearch'); s.value = ''; skillIndex = 0; s.focus();
  $('skillList').innerHTML = '<div class="muted">加载中…</div>';
  // 每次打开都刷新:项目级技能随 cwd 变、可用性随能力矩阵变、启用状态随会话变。cwd 传当前会话工作目录。
  try { skillRegistry = (await api('/api/skills?cwd=' + encodeURIComponent(currentWorkspace() || ''))).skills || []; }
  catch { skillRegistry = []; }
  renderSkillList();
}
function renderSkillList() {
  const q = $('skillSearch').value.trim().toLowerCase();
  const all = skillRegistry || [];
  const match = s => !q || (s.name || '').toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q) || (s.id || '').toLowerCase().includes(q);
  const claudeMode = !isProviderMode();
  const skills = all.filter(s => s.kind === 'skill' && match(s));
  const commands = claudeMode ? all.filter(s => s.kind === 'command' && match(s)) : []; // 命令仅 Claude 模式(CLI 原生认 /name)
  const playbooks = all.filter(s => s.kind === 'playbook' && match(s));
  skillFiltered = [...skills, ...commands, ...playbooks]; // 拍平的显示顺序(与 .skill-item DOM 顺序一致)
  if (skillIndex >= skillFiltered.length) skillIndex = Math.max(0, skillFiltered.length - 1);
  const list = $('skillList'); list.innerHTML = '';
  const enabledIds = enabledSkillIds();
  const enabled = new Set(enabledIds);
  // P3-6: 幽灵启用项 —— session.skills 里但注册表已无对应技能(被删/改名/随 cwd 丢失)。收集以便渲染「已失效」行。
  const regSkillIds = new Set(all.filter(s => s.kind === 'skill').map(s => s.id));
  const ghosts = enabledIds.filter(id => !regSkillIds.has(id) && (!q || id.toLowerCase().includes(q)));
  if (!skillFiltered.length && !ghosts.length) {
    list.appendChild(el('div', 'muted', all.length ? '无匹配' : '未发现技能/命令（可在数据目录 skills/ 或项目 .ruyi/skills/ 放置 SKILL.md）'));
    return;
  }
  // v3 (§2.12 P2 r2):分段控件锚点导航 + 两列卡片网格。分组顺序与 skillFiltered 拍平顺序一致(键盘导航 flatIdx 对齐)。
  const groups = [
    { id: 'skill', label: '技能', sub: '复杂任务的专家流程', items: skills, builder: buildSkillRow },
    { id: 'cmd', label: '命令', sub: '斜杠触发的动作', items: commands, builder: buildCommandRow },
    { id: 'play', label: '一键任务', sub: '首页任务卡', items: playbooks, builder: buildPlaybookRow },
  ].filter(g => g.items.length);
  if (groups.length > 1) list.appendChild(buildSkAnchorNav(groups.map(g => ({ id: 'g-' + g.id, label: g.label, count: g.items.length }))));
  let flatIdx = 0;
  for (const g of groups) {
    const grp = el('div', 'sk-group'); grp.id = 'g-' + g.id;
    grp.appendChild(buildSkGroupTitle(g.label, g.sub, g.items.length));
    const grid = el('div', 'sk-grid');
    for (const s of g.items) grid.appendChild(g.builder(s, flatIdx++, enabled));
    grp.appendChild(grid);
    list.appendChild(grp);
  }
  if (ghosts.length) {
    const grp = el('div', 'sk-group');
    grp.appendChild(buildSkGroupTitle('已失效', '', ghosts.length));
    const grid = el('div', 'sk-grid');
    for (const gid of ghosts) grid.appendChild(buildGhostRow(gid)); // 不带 .skill-item → 键盘导航忽略
    grp.appendChild(grid);
    list.appendChild(grp);
  }
}
// 分段控件式锚点子导航(§2.12):chips 置顶,点击/回车滚动到对应组并高亮。容器可复用(技能库/记忆同构)。
function buildSkAnchorNav(entries) {
  const seg = el('nav', 'sk-seg'); seg.setAttribute('aria-label', '分组导航');
  entries.forEach((en, i) => {
    const a = el('a', i === 0 ? 'active' : '');
    a.append(el('span', '', en.label), el('span', 'n num', String(en.count)));
    a.tabIndex = 0; a.setAttribute('role', 'button');
    const go = () => {
      seg.querySelectorAll('a').forEach(x => x.classList.remove('active')); a.classList.add('active');
      const target = document.getElementById(en.id); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    a.onclick = e => { e.preventDefault(); go(); };
    a.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    seg.appendChild(a);
  });
  return seg;
}
// 分组题(§2.12):字距标题 + 副标 + 计数 + 渐隐发丝线 + 云纹端符。
function buildSkGroupTitle(label, sub, count) {
  const t = el('h3', 'sk-group-t');
  t.appendChild(el('span', 't', label));
  if (sub) t.appendChild(el('span', 'sub', sub));
  t.appendChild(el('span', 'cnt num', String(count)));
  t.appendChild(el('span', 'line'));
  const cloud = el('span', 'cloud'); cloud.setAttribute('aria-hidden', 'true'); t.appendChild(cloud);
  return t;
}
// 卡片图标块(§2.12):技能→青花 sparkles SVG;命令→斜杠;一键任务→ playbook emoji(用户数据,保留)/兜底 sparkles。
function skillCardIco(kind, s) {
  const ico = el('span', 'sk-ico');
  const pb = s && s.playbook;
  if (kind === 'playbook' && pb && pb.icon) { ico.textContent = pb.icon; return ico; }
  if (kind === 'command') { ico.textContent = '/'; return ico; }
  const svg = icon('sparkles', 16); if (svg) ico.appendChild(svg); else ico.textContent = '✦';
  return ico;
}
// P3-6: 已失效技能行 —— 展示 id + 移除按钮(POST 过滤后由服务端自动清掉该无效 id)。不带 .skill-item 类,不参与键盘选中。
function buildGhostRow(id) {
  const it = el('div', 'skill-ghost');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', id));
  head.appendChild(el('span', 'skill-src', '已失效'));
  const rm = el('button', 'skill-toggle', '移除');
  rm.onclick = e => { e.stopPropagation(); removeGhostSkill(id); };
  head.appendChild(rm);
  it.appendChild(head);
  it.appendChild(el('div', 'skill-reason', '此技能已不在注册表中（可能已删除，或随工作目录变化而不可见）。'));
  return it;
}
// P3-6: 移除一个失效技能 —— 从启用集里剔除该 id 并落盘(服务端只保留注册表里存在的技能,失效 id 自然被清)。
async function removeGhostSkill(id) {
  const session = state.currentSession;
  if (!session) return;
  const next = enabledSkillIds().filter(x => x !== id);
  try {
    const r = await api('/api/session/skills', { method: 'POST', body: JSON.stringify({ sessionId: session.id, skills: next }) });
    session.skills = (r && Array.isArray(r.skills)) ? r.skills : next.map(x => ({ id: x, source: '' }));
    toast(`已移除失效技能：${id}`);
  } catch (e) { toast('移除失败：' + apiErrText(e), 'err'); return; }
  renderSkillList();
  updateSkillBadge();
}
// 技能卡(§2.12 r2):中文名主显 + mono id 小字 + 来源标签 + 描述 + 启用开关。启用态 .on 触发青花描边/渗透洗。
// 保留 .skill-item 类以复用键盘导航(updateSkillSel 查 .skill-item);.sk-card 承载卡片视觉。不可用置灰。
function buildSkillRow(s, i, enabled) {
  const unavailable = s.available === false;
  const on = enabled.has(s.id);
  const pending = skillTogglePending.has(s.id); // P3-5: 该行有在途请求 → 开关禁用 + 显示「…」
  const it = el('div', `skill-item sk-card${on ? ' on' : ''}${i === skillIndex ? ' sel' : ''}${unavailable ? ' unavailable' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('skill', s));
  head.appendChild(el('span', 'sk-name', s.name || s.id)); // 中文名主显
  head.appendChild(el('span', 'sk-src', s.source === 'project' ? '项目' : (s.source === 'user' ? '用户' : '内置')));
  it.appendChild(head);
  it.appendChild(el('div', 'sk-id', s.id)); // mono id 降为小字
  if (s.description) it.appendChild(el('div', 'sk-desc', s.description));
  if (unavailable && s.unavailableReason) it.appendChild(el('div', 'sk-reason', s.unavailableReason));
  const foot = el('div', 'sk-foot');
  const toggle = el('button', 'skill-toggle' + (on ? ' on' : ''), unavailable ? '不可用' : (pending ? '…' : (on ? '已启用' : '启用')));
  if (unavailable || pending) toggle.disabled = true;
  toggle.onclick = e => { e.stopPropagation(); toggleSkill(s); };
  foot.appendChild(toggle);
  it.appendChild(foot);
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => { if (!unavailable && !pending) toggleSkill(s); };
  return it;
}
// 命令卡(仅 Claude 模式):中文名主显 + mono /insert 小字。点击插入 /name 到输入框(保留旧行为)。
function buildCommandRow(s, i) {
  const it = el('div', `skill-item sk-card${i === skillIndex ? ' sel' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('command', s));
  head.appendChild(el('span', 'sk-name', s.name || s.id));
  it.appendChild(head);
  it.appendChild(el('code', 'sk-id', s.insert || ('/' + s.id)));
  if (s.description) it.appendChild(el('div', 'sk-desc', s.description));
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => { insertSkill(s.insert || ('/' + s.id)); closeModal('skillModal'); };
  return it;
}
// 一键任务卡(Playbook):中文名主显 + playbook emoji 图标。点击走既有 openPlaybookModal。不可用置灰 + 原因。
function buildPlaybookRow(s, i) {
  const unavailable = s.available === false;
  const pb = s.playbook || null;
  const it = el('div', `skill-item sk-card${i === skillIndex ? ' sel' : ''}${unavailable ? ' unavailable' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('playbook', s));
  head.appendChild(el('span', 'sk-name', s.name || s.id));
  it.appendChild(head);
  it.appendChild(el('div', 'sk-id', s.id));
  if (s.description) it.appendChild(el('div', 'sk-desc', s.description));
  if (unavailable && s.unavailableReason) it.appendChild(el('div', 'sk-reason', s.unavailableReason));
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => {
    if (unavailable) { toast(s.unavailableReason || '当前不可用', 'err'); return; }
    if (!pb) { toast('该任务模板数据缺失', 'err'); return; }
    closeModal('skillModal'); openPlaybookModal(pb);
  };
  return it;
}
// 启用/停用一个技能:更新 session.skills 并 POST 落盘。上限 8;不可用技能拒启用。
// P3-5: 串行化 —— 接到模块级单飞链尾,并把该 id 记为在途(禁用其开关),避免快速连点产生读改写竞态/覆盖。
function toggleSkill(entry) {
  const session = state.currentSession;
  if (!session) { toast('请先新建或选择一个会话', 'err'); return; }
  if (entry.available === false) { toast(entry.unavailableReason || '该技能当前不可用', 'err'); return; }
  if (skillTogglePending.has(entry.id)) return; // 该行已有在途请求 → 忽略重复点击
  skillTogglePending.add(entry.id);
  renderSkillList(); // 立刻反映 disabled 态
  skillToggleChain = skillToggleChain.then(() => doToggleSkill(entry)).catch(() => {}).then(() => {
    skillTogglePending.delete(entry.id);
    renderSkillList();
    updateSkillBadge();
  });
}
async function doToggleSkill(entry) {
  const session = state.currentSession;
  if (!session) return;
  const cur = enabledSkillIds(); // 链上串行执行,每次读取最新启用集(以 id 列表比较)
  const on = cur.includes(entry.id);
  let next;
  if (on) next = cur.filter(x => x !== entry.id);
  else { if (cur.length >= 8) { toast('最多同时启用 8 个技能', 'err'); return; } next = cur.concat(entry.id); }
  try {
    const r = await api('/api/session/skills', { method: 'POST', body: JSON.stringify({ sessionId: session.id, skills: next }) });
    session.skills = (r && Array.isArray(r.skills)) ? r.skills : next.map(id => ({ id, source: '' }));
    toast(on ? `已停用技能：${entry.name || entry.id}` : `已启用技能：${entry.name || entry.id}`);
  } catch (e) { toast('设置技能失败：' + apiErrText(e), 'err'); }
}
// composer 技能按钮的数量徽标(已启用技能数)。会话切换/启用变更时刷新。
function updateSkillBadge() {
  const btn = $('skillBtn'); if (!btn) return;
  const n = (state.currentSession && Array.isArray(state.currentSession.skills)) ? state.currentSession.skills.length : 0;
  iconTextBtn(btn, 'sparkles', n > 0 ? `技能 · ${n}` : '技能'); // v3 (§B1/§2.15): ✨→sparkles 线性 SVG(⌘ 曾是 Mac 心智,已弃)
}
function updateSkillSel() {
  const items = [...$('skillList').querySelectorAll('.skill-item')];
  items.forEach((it, i) => it.classList.toggle('sel', i === skillIndex));
  items[skillIndex]?.scrollIntoView({ block: 'nearest' });
}
function moveSkillSel(d) {
  if (!skillFiltered.length) return;
  skillIndex = Math.max(0, Math.min(skillFiltered.length - 1, skillIndex + d));
  updateSkillSel();
}
// Enter/点选:技能→切换启用(不关面板,便于连续操作);命令→插入并关;一键任务→关面板并打开输入表单。
function pickSkill(i) {
  const s = skillFiltered[i]; if (!s) return;
  if (s.kind === 'skill') { toggleSkill(s); return; }
  if (s.kind === 'command') { insertSkill(s.insert || ('/' + s.id)); closeModal('skillModal'); return; }
  if (s.kind === 'playbook') {
    if (s.available === false || !s.playbook) { toast(s.unavailableReason || '该任务当前不可用', 'err'); return; }
    closeModal('skillModal'); openPlaybookModal(s.playbook);
  }
}
function insertSkill(cmd) {
  const ta = $('promptInput');
  const cur = ta.value;
  const sep = (!cur || /\s$/.test(cur)) ? '' : ' ';
  ta.value = cur + sep + cmd + ' ';
  autoGrow(ta); ta.focus();
}

/* ---------------- workbench memory panel (v2 跨会话记忆) ---------------- */
// 「工作台记忆」面板:global / 当前项目两组,启停 toggle(POST /api/session/memories,串行化仿 toggleSkill)、
// 删除(confirm)、编辑、「迁移到当前项目」、手写新建、「从当前会话起草」(provider 才显示)。幽灵启用项可移除。
let memoryRegistry = [];
let memoryOtherProjects = [];
let memoryCurrentProjectKey = '';
let memoryToggleChain = Promise.resolve();
const memoryTogglePending = new Set();
// 会话有效启用集(effectiveMemorySelection 的前端镜像):显式设置过 → session.memories;否则默认——当前项目记忆全启用。
function enabledMemoryKeySet() {
  const session = state.currentSession;
  if (session && session.memoriesExplicit === true) {
    const arr = Array.isArray(session.memories) ? session.memories : [];
    return new Set(arr.map(m => ((m && m.scope === 'global') ? 'global' : 'project') + ':' + (m && m.id)).filter(k => !k.endsWith(':')));
  }
  return new Set((memoryRegistry || []).filter(e => e.scope === 'project').slice(0, 8).map(e => 'project:' + e.id));
}
async function openMemoryPanel() {
  openModal('memoryModal');
  $('memoryList').innerHTML = '<div class="muted">加载中…</div>';
  try {
    const r = await api('/api/memory?cwd=' + encodeURIComponent(currentWorkspace() || ''));
    memoryRegistry = (r && r.memories) || [];
    memoryOtherProjects = (r && r.otherProjects) || [];
    memoryCurrentProjectKey = (r && r.projectKey) || '';
  } catch { memoryRegistry = []; memoryOtherProjects = []; memoryCurrentProjectKey = ''; }
  renderMemoryList();
}
function renderMemoryList() {
  const list = $('memoryList'); if (!list) return; list.innerHTML = '';
  const session = state.currentSession;
  // 顶部动作:手写新建 + (provider)从当前会话起草
  const actions = el('div', 'memory-actions');
  const newBtn = el('button', 'mini', '＋ 手写新建记忆');
  newBtn.onclick = () => openMemoryEditModal(null);
  actions.appendChild(newBtn);
  if (isProviderMode() && session) {
    const draftBtn = el('button', 'mini', '✎ 从当前会话起草');
    draftBtn.onclick = () => saveAsMemory(draftBtn);
    actions.appendChild(draftBtn);
  }
  list.appendChild(actions);
  if (!session) list.appendChild(el('div', 'muted', '新建或选择一个会话后可启用记忆。'));
  const explicit = session && session.memoriesExplicit === true;
  if (session && !explicit) list.appendChild(el('div', 'memory-hint muted', '当前项目的记忆默认全部启用（可手动调整）；全局记忆需手动启用。'));
  const enabled = enabledMemoryKeySet();
  const globals = (memoryRegistry || []).filter(e => e.scope === 'global');
  const projects = (memoryRegistry || []).filter(e => e.scope === 'project');
  // v3 (§2.12 P2 r2):记忆面板与技能库同构 —— 分段控件锚点导航 + 两列卡片网格(复用 buildSkAnchorNav/buildSkGroupTitle)。
  const memGroups = [
    { id: 'global', label: '全局记忆', sub: '随工作台走', items: globals },
    { id: 'project', label: '当前项目记忆', sub: '随本项目走', items: projects },
  ];
  if (memGroups.some(g => g.items.length)) list.appendChild(buildSkAnchorNav(memGroups.map(g => ({ id: 'm-' + g.id, label: g.label, count: g.items.length }))));
  for (const g of memGroups) {
    const grp = el('div', 'sk-group'); grp.id = 'm-' + g.id;
    grp.appendChild(buildSkGroupTitle(g.label, g.sub, g.items.length));
    if (!g.items.length) { grp.appendChild(el('div', 'muted', '（暂无）')); }
    else { const grid = el('div', 'sk-grid'); for (const m of g.items) grid.appendChild(buildMemoryRow(m, enabled)); grp.appendChild(grid); }
    list.appendChild(grp);
  }
  // 幽灵项:显式启用集里但注册表已无对应文件(被删/改名/随 cwd 丢失)。
  if (explicit && session) {
    const regKeys = new Set((memoryRegistry || []).map(e => e.scope + ':' + e.id));
    const arr = Array.isArray(session.memories) ? session.memories : [];
    const ghosts = arr.filter(m => m && m.id && !regKeys.has(((m.scope === 'global') ? 'global' : 'project') + ':' + m.id));
    if (ghosts.length) {
      list.appendChild(el('div', 'skill-group-title', `已失效 · ${ghosts.length}`));
      for (const g of ghosts) list.appendChild(buildMemoryGhostRow(g));
    }
  }
  // 其它项目组(迁移到当前项目)
  if ((memoryOtherProjects || []).length) {
    list.appendChild(el('div', 'skill-group-title', '其它项目组'));
    for (const p of memoryOtherProjects) list.appendChild(buildOtherProjectRow(p));
  }
}
function buildMemoryRow(m, enabled) {
  const key = m.scope + ':' + m.id;
  const on = enabled.has(key);
  const pending = memoryTogglePending.has(key);
  // P3-3: 已启用但会话锁定的 projectKey 与当前项目组不符 → 服务端实际会跳过注入,给用户一个失配提示。
  let stale = false;
  if (on && m.scope === 'project' && memoryCurrentProjectKey) {
    const session = state.currentSession;
    const ent = (session && Array.isArray(session.memories) ? session.memories : []).find(x => x && x.id === m.id && x.scope !== 'global');
    if (ent && ent.projectKey && ent.projectKey !== memoryCurrentProjectKey) stale = true;
  }
  // v3 (§2.12 r2):记忆卡同构 —— 名称主显 + 类型标 + 描述 + 元信息,底部 启用/编辑/删除。启用态 .on 触发青花描边。
  const it = el('div', `skill-item sk-card${on ? ' on' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('skill', null));
  head.appendChild(el('span', 'sk-name', m.name || m.id));
  const typeLabel = m.type === 'convention' ? '惯例' : (m.type === 'lesson' ? '教训' : '参考');
  head.appendChild(el('span', 'sk-src', typeLabel));
  it.appendChild(head);
  if (m.description) it.appendChild(el('div', 'sk-desc', m.description));
  const meta = el('div', 'sk-reason');
  meta.textContent = (m.createdAt ? String(m.createdAt).slice(0, 10) + ' · ' : '') + (m.scope === 'global' ? '全局' : '项目');
  it.appendChild(meta);
  if (stale) it.appendChild(el('div', 'sk-reason', '⚠ 来源项目已变化，已暂停注入（重新启用可锁定到当前项目）。'));
  const foot = el('div', 'sk-foot');
  const toggle = el('button', 'skill-toggle' + (on ? ' on' : ''), pending ? '…' : (on ? '已启用' : '启用'));
  if (pending) toggle.disabled = true;
  toggle.onclick = e => { e.stopPropagation(); toggleMemory(m); };
  const editB = el('button', 'mini', '编辑');
  editB.onclick = e => { e.stopPropagation(); openMemoryEditModal(m); };
  const delB = el('button', 'mini danger', '删除');
  delB.onclick = e => { e.stopPropagation(); deleteMemoryRow(m); };
  foot.append(toggle, editB, delB);
  it.appendChild(foot);
  return it;
}
// 幽灵行:显示 id + 移除(POST 过滤后由服务端清掉该无效 id)。
function buildMemoryGhostRow(m) {
  const it = el('div', 'skill-ghost');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', m.id));
  head.appendChild(el('span', 'skill-src', '已失效'));
  const rm = el('button', 'skill-toggle', '移除');
  rm.onclick = e => { e.stopPropagation(); removeGhostMemory(m); };
  head.appendChild(rm);
  it.appendChild(head);
  it.appendChild(el('div', 'skill-reason', '此记忆已不在库中（可能已删除，或随项目目录变化而不可见）。'));
  return it;
}
// 其它项目组行:显示 label/path/条目数 + 「全部迁移到当前项目」。
function buildOtherProjectRow(p) {
  const it = el('div', 'skill-item');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', p.label || p.projectKey));
  head.appendChild(el('span', 'skill-type', `${p.count} 条`));
  const btn = el('button', 'skill-toggle', '迁移到当前项目');
  btn.onclick = e => { e.stopPropagation(); migrateGroupToCurrent(p); };
  head.appendChild(btn);
  it.appendChild(head);
  if (p.path) it.appendChild(el('div', 'skill-reason', p.path));
  return it;
}
function toggleMemory(m) {
  const session = state.currentSession;
  if (!session) { toast('请先新建或选择一个会话', 'err'); return; }
  const key = m.scope + ':' + m.id;
  if (memoryTogglePending.has(key)) return;
  memoryTogglePending.add(key);
  renderMemoryList();
  memoryToggleChain = memoryToggleChain.then(() => doToggleMemory(m)).catch(() => {}).then(() => {
    memoryTogglePending.delete(key);
    renderMemoryList();
  });
}
async function doToggleMemory(m) {
  const session = state.currentSession;
  if (!session) return;
  const enabled = enabledMemoryKeySet();
  const key = m.scope + ':' + m.id;
  // P3-3: 重建启用集时保留各 project 条目锁定的 projectKey(服务端会以 session.cwd 权威重盖,前端如实回传避免丢字段)。
  const pkByKey = new Map((Array.isArray(session.memories) ? session.memories : []).filter(x => x && x.id).map(x => [((x.scope === 'global') ? 'global' : 'project') + ':' + x.id, x.projectKey]));
  const cur = [...enabled].map(k => { const i = k.indexOf(':'); const scope = k.slice(0, i), id = k.slice(i + 1); const o = { scope, id }; if (scope === 'project' && pkByKey.get(k)) o.projectKey = pkByKey.get(k); return o; });
  let next;
  if (enabled.has(key)) next = cur.filter(x => (x.scope + ':' + x.id) !== key);
  else { if (cur.length >= 8) { toast('最多同时启用 8 条记忆', 'err'); return; } next = cur.concat({ scope: m.scope, id: m.id }); }
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: next }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : next;
    session.memoriesExplicit = true;
    toast(enabled.has(key) ? `已停用记忆：${m.name || m.id}` : `已启用记忆：${m.name || m.id}`);
  } catch (e) { toast('设置记忆失败：' + apiErrText(e), 'err'); }
}
async function removeGhostMemory(m) {
  const session = state.currentSession;
  if (!session) return;
  const cur = (Array.isArray(session.memories) ? session.memories : []).filter(x => x && x.id);
  const next = cur.filter(x => !(x.id === m.id && ((x.scope === 'global') ? 'global' : 'project') === ((m.scope === 'global') ? 'global' : 'project')));
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: next }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : next;
    session.memoriesExplicit = true;
    toast(`已移除失效记忆：${m.id}`);
  } catch (e) { toast('移除失败：' + apiErrText(e), 'err'); return; }
  renderMemoryList();
}
async function deleteMemoryRow(m) {
  if (!confirm(`删除记忆「${m.name || m.id}」？此操作不可撤销。`)) return;
  try {
    const r = await api('/api/memory/' + encodeURIComponent(m.id), { method: 'POST', headers: { 'x-http-method': 'DELETE' }, body: JSON.stringify({ scope: m.scope, cwd: currentWorkspace() || '' }) });
    if (!r || !r.ok) { toast(`删除失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
    toast('已删除记忆', 'ok');
  } catch (e) { toast('删除失败：' + apiErrText(e), 'err'); return; }
  openMemoryPanel();
}
async function migrateGroupToCurrent(p) {
  if (!(p.items || []).length) return;
  if (!confirm(`把「${p.label || p.projectKey}」的 ${p.count} 条记忆迁移到当前项目？`)) return;
  // P2-4: 逐条结果上浮,不静默——迁移 N 条、M 条冲突(目标已有同名 → 409）跳过、K 条其它失败。
  let okCount = 0, conflictCount = 0, errCount = 0;
  for (const item of p.items) {
    try {
      const r = await api('/api/memory/migrate', { method: 'POST', body: JSON.stringify({ id: item.id, fromKey: p.projectKey, cwd: currentWorkspace() || '' }) });
      if (r && r.ok) okCount++; else errCount++;
    } catch (e) {
      // api() 对非 2xx 抛错,错误体(JSON)带 conflict 标记 → 归入「冲突跳过」,其它失败单列。
      let conflict = false; try { const j = JSON.parse((e && e.message) || ''); conflict = j && j.conflict === true; } catch { /* not json */ }
      if (conflict) conflictCount++; else errCount++;
    }
  }
  const parts = [];
  if (okCount) parts.push(`迁移 ${okCount} 条`);
  if (conflictCount) parts.push(`${conflictCount} 条冲突跳过`);
  if (errCount) parts.push(`${errCount} 条失败`);
  toast(parts.length ? parts.join('，') : '没有可迁移的记忆', okCount ? 'ok' : 'err');
  openMemoryPanel();
}
// 从当前会话起草(provider 引擎):draft → 编辑弹窗 → 保存。
async function saveAsMemory(btn) {
  const sid = state.currentSession && state.currentSession.id;
  if (!sid) { toast('没有可保存的会话', 'err'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '起草中…'; }
  try {
    const r = await api('/api/memory/draft', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
    if (!r || !r.ok || !r.draft) { toast(`起草失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
    openMemoryEditModal({ ...r.draft, scope: 'project', _isDraft: true });
  } catch (e) { toast(`起草失败：${apiErrText(e)}`, 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
// 编辑/新建弹窗。编辑现有项时先拉全文回填正文(注册表不带 body)。
async function openMemoryEditModal(m) {
  let full = m;
  if (m && m.id && !m._isDraft && m.body == null) {
    try {
      const r = await api(`/api/memory/item?id=${encodeURIComponent(m.id)}&scope=${m.scope}&cwd=${encodeURIComponent(currentWorkspace() || '')}`);
      if (r && r.ok && r.memory) full = { ...m, ...r.memory };
    } catch { /* 回填失败则空正文 */ }
  }
  const editing = !!(m && m.id && !m._isDraft);
  const body = el('div', 'pb-form');
  const mkField = (label, value, rows) => {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', label));
    const ta = el(rows > 1 ? 'textarea' : 'input', 'pb-field-input');
    if (rows > 1) ta.rows = rows; else ta.type = 'text';
    ta.value = value || '';
    field.appendChild(ta); body.appendChild(field);
    return ta;
  };
  const nameEl = mkField('名称', full ? full.name : '', 1);
  const descEl = mkField('说明（何时有用）', full ? full.description : '', 2);
  const typeField = el('div', 'pb-field'); typeField.appendChild(el('label', 'pb-field-label', '类型'));
  const typeSel = el('select', 'pb-field-input');
  for (const [v, t] of [['convention', '项目惯例'], ['lesson', '教训'], ['reference', '参考资料']]) { const o = el('option', '', t); o.value = v; if (full && full.type === v) o.selected = true; typeSel.appendChild(o); }
  typeField.appendChild(typeSel); body.appendChild(typeField);
  const scopeField = el('div', 'pb-field'); scopeField.appendChild(el('label', 'pb-field-label', '范围'));
  const scopeSel = el('select', 'pb-field-input');
  for (const [v, t] of [['project', '当前项目'], ['global', '全局']]) { const o = el('option', '', t); o.value = v; if (((full && full.scope) || 'project') === v) o.selected = true; scopeSel.appendChild(o); }
  if (editing) scopeSel.disabled = true; // 编辑不改范围(改范围=另存,请新建)
  scopeField.appendChild(scopeSel); body.appendChild(scopeField);
  const bodyTa = mkField('正文（markdown）', full ? full.body : '', 8);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', '取消');
  const save = el('button', 'primary', '保存');
  foot.append(cancel, save);
  const modal = buildModal(editing ? '编辑记忆' : '新建工作台记忆', body, foot);
  cancel.onclick = () => modal.close();
  save.onclick = async () => {
    const memory = { name: nameEl.value.trim(), description: descEl.value.trim(), type: typeSel.value, body: bodyTa.value, scope: scopeSel.value };
    if (editing) memory.id = m.id;
    if (full && full.sourceSessionId) memory.sourceSessionId = full.sourceSessionId;
    if (!memory.name || !memory.body.trim()) { toast('名称和正文不能为空', 'err'); return; }
    save.disabled = true; save.textContent = '保存中…';
    try {
      const r = await api('/api/memory', { method: 'POST', body: JSON.stringify({ memory, cwd: currentWorkspace() || '' }) });
      modal.close();
      if (!r || !r.ok) { toast(`保存失败：${(r && r.error) || '未知错误'}`, 'err'); return; }
      toast('已保存工作台记忆', 'ok');
      if (!$('memoryModal').classList.contains('hidden')) openMemoryPanel();
    } catch (e) { modal.close(); toast(`保存失败：${apiErrText(e)}`, 'err'); }
  };
}

/* ---------------- command palette ---------------- */
function paletteActions() {
  const acts = [
    { label: '新会话', hint: 'Ctrl+N', run: newSession },
    { label: '切换主题', hint: '', run: toggleTheme },
    { label: '压缩上下文', hint: '', run: compactContext },
    { label: '打开设置', hint: '', run: () => openModal('settingsModal') },
    { label: '打开 Providers 设置', hint: '', run: () => { openModal('settingsModal'); switchSettingsTab('providers'); } },
    { label: '打开数据目录', hint: '', run: () => { const dr = (state.status && state.status.dataRoot) || ''; if (dr) runTool('browser_open', { url: dr }); else toast('数据目录未知', 'err'); } },
    { label: '刷新体检', hint: '', run: () => { refreshStatus(); switchTab('doctor'); } },
    { label: '停止当前回合', hint: 'Esc', run: stopTurn },
    { label: '导出会话 · Markdown', hint: 'export', run: () => exportSession('md') },
    { label: '导出会话 · JSON', hint: 'export', run: () => exportSession('json') },
    { label: '导出会话 · HTML', hint: 'export', run: () => exportSession('html') },
    { label: '导入会话 (JSON)', hint: 'import', run: importSession },
    { label: '把当前输入存为模板', hint: 'template', run: addTemplateFromPrompt },
    { label: 'MCP 工具检查器', hint: 'tools', run: openMcpInspector },
    { label: '技能库（技能 / 命令 / 一键任务）', hint: '/', run: openSkillPanel },
    { label: '工作台记忆（跨会话）', hint: 'memory', run: openMemoryPanel },
  ];
  for (const t of getTemplates()) acts.push({ label: `模板 → ${t.name}`, hint: 'template', run: () => insertTemplate(t.text) });
  // Engine/model actions across ALL engines (C4): Claude CLI group + every provider. Each row switches
  // engine AND model in one setEngineModel call. Label reads "引擎 → {engineLabel} · {model}".
  const curPid = isProviderMode() ? state.config.activeProvider : '';
  const curModel = currentModelId();
  const claudeModels = (state.status && state.status.models) || [{ id: '', label: '默认' }];
  for (const m of claudeModels) {
    const isCur = curPid === '' && (m.id || '') === (curModel || '');
    acts.push({ label: `引擎 → Claude CLI · ${m.label || m.id || '默认'}`, hint: isCur ? '当前' : 'engine', run: () => setEngineModel('', m.id || '') });
  }
  for (const p of (state.config.providers || [])) {
    for (const m of (p.models || [])) {
      if (!m.id) continue;
      const isCur = curPid === p.id && (m.id || '') === (curModel || '');
      acts.push({ label: `引擎 → ${p.label || p.id} · ${m.label || m.id}`, hint: isCur ? '当前' : 'engine', run: () => setEngineModel(p.id, m.id) });
    }
  }
  for (const s of state.sessions.slice(0, 12)) acts.push({ label: `会话 → ${s.title}`, hint: 'session', run: () => openSession(s.id) });
  return acts;
}
function openPalette() {
  openModal('paletteModal');
  const input = $('paletteInput'); input.value = ''; state.paletteIndex = 0;
  renderPalette(); input.focus();
}
function renderPalette() {
  const q = $('paletteInput').value.trim().toLowerCase();
  const acts = paletteActions().filter(a => !q || a.label.toLowerCase().includes(q));
  state._paletteActs = acts;
  if (state.paletteIndex >= acts.length) state.paletteIndex = 0;
  const list = $('paletteList'); list.innerHTML = '';
  acts.forEach((a, i) => {
    const item = el('div', `palette-item ${i === state.paletteIndex ? 'sel' : ''}`);
    item.append(el('span', '', a.label), el('span', 'p-hint', a.hint));
    item.onclick = () => { closeModal('paletteModal'); a.run(); };
    list.appendChild(item);
  });
}

/* ---------------- popover primitive (§4.2) ---------------- */
// Anchored, fixed-position popover shared by the model chip + context meter. buildContent(close)
// returns the popover's inner Element (call close() to dismiss). Positions below the anchor, right-
// aligned; flips above / clamps horizontally on viewport overflow. Closes on Esc, outside mousedown,
// or a re-click of the anchor; focus returns to the anchor. Only one popover open at a time.
let activePopover = null;
function closePopover() {
  if (!activePopover) return;
  const { node, anchor, onKey, onDown, onScroll } = activePopover;
  activePopover = null;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('resize', onScroll, true);
  window.removeEventListener('scroll', onScroll, true);
  node.remove();
  if (anchor && typeof anchor.focus === 'function') { try { anchor.focus(); } catch { /* ignore */ } }
}
function popover(anchorEl, buildContent, opts = {}) {
  if (activePopover && activePopover.anchor === anchorEl) { closePopover(); return null; }
  closePopover();
  const node = el('div', 'popover');
  const close = () => closePopover();
  node.appendChild(buildContent(close));
  document.body.appendChild(node);
  const place = () => {
    const r = anchorEl.getBoundingClientRect();
    const pw = node.offsetWidth, ph = node.offsetHeight;
    const gap = 6, margin = 8;
    // Vertical: below by default; flip above if it would overflow the bottom and there's more room up.
    let top = r.bottom + gap;
    if (top + ph > window.innerHeight - margin && r.top - gap - ph > margin) top = r.top - gap - ph;
    top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
    // Horizontal: right-aligned to the anchor's right edge; clamp into the viewport.
    let left = (opts.placement === 'bottom-start') ? r.left : (r.right - pw);
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    node.style.top = top + 'px';
    node.style.left = left + 'px';
  };
  place();
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const onDown = e => { if (!node.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close(); };
  const onScroll = () => place();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', onScroll, true);
  window.addEventListener('scroll', onScroll, true);
  activePopover = { node, anchor: anchorEl, onKey, onDown, onScroll };
  return { node, close };
}

/* ---------------- model chip (§4.1) ---------------- */
// Render the topbar chip's engine/model text + dot state. Claude: "Claude CLI · {model或默认}";
// provider: "{label} · {model}". The .mc-engine foreground is the engine color (engineVisual map).
function renderModelChip() {
  const chip = $('modelChip'); if (!chip) return;
  const meta = currentEngineMeta();
  const vis = engineVisual(meta);
  const engEl = chip.querySelector('.mc-engine');
  const modEl = chip.querySelector('.mc-model');
  if (engEl) { engEl.textContent = isProviderMode() ? vis.label : 'Claude CLI'; engEl.style.color = vis.colorVar; }
  if (modEl) { const m = currentModelId(); modEl.textContent = isProviderMode() ? (m || '(未选模型)') : (m || '默认'); }
  chip.title = `${engineLabel()} · ${currentModelId() || '默认'}（点击切换引擎/模型）`;
}
// Write activeProvider + model in ONE POST /api/config, then refresh chip + dependent UI + meter +
// (silently) the live model list. providerId ''(or 'claude-cli') selects the Claude engine; a provider
// id writes the model INTO that provider's entry, Claude writes config.model.
async function setEngineModel(providerId, modelId) {
  const pid = providerId || '';
  const patch = { activeProvider: pid };
  if (pid && pid !== 'claude-cli') {
    patch.providers = (state.config.providers || []).map(p => (p.id === pid ? { ...p, model: modelId || '' } : p));
  } else {
    patch.model = modelId || '';
  }
  // Optimistic local update so the chip/meter reflect the choice immediately.
  Object.assign(state.config, patch);
  await saveConfigPartial(patch);
  renderModelChip();
  updateEngineDependentUI();
  updateContextMeter();
  refreshModels(); // silent enrich for the newly-active engine
  const label = engineLabel();
  toast(state.streaming ? `引擎/模型：${label} · ${modelId || '默认'}（下一轮生效）` : `引擎/模型：${label} · ${modelId || '默认'}`, 'ok');
}
// Build + open the chip popover: grouped single-select list (Claude CLI group + one group per
// provider), current row ✓ + highlighted, disabled placeholder for provider groups with no models,
// footer actions (refresh / manage providers). Keyboard: ↑↓ move, Enter select, Esc close.
// v1.0.2 (G3): compact context-length badge — >=1e6 → 「1M」, >=1e3 → 「128K」, else raw. null/0 → ''.
function ctxLenBadge(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6) { const m = v / 1e6; return (Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M'; }
  if (v >= 1e3) { const k = v / 1e3; return (Number.isInteger(k) ? String(k) : Math.round(k)) + 'K'; }
  return String(v);
}
function openModelChipPopover() {
  const chip = $('modelChip'); if (!chip) return;
  popover(chip, close => {
    const wrap = el('div', 'mc-pop');
    const rows = []; // flat list of selectable rows for keyboard nav (in visual order)
    const curPid = isProviderMode() ? state.config.activeProvider : '';
    const curModel = currentModelId();
    // v1.0.2 (G3): 分组折叠 — 当前激活引擎组展开置顶；其它引擎组折叠(details/summary)。组头显示引擎名 + 模型数,
    // 非当前引擎组注明「选择将切换引擎」。模型行有 contextLength 时显示紧凑徽标(128K / 1M)。当前模型 ✓ 保持。
    // buildRows(container, pid, models, emptyHint, isActive) — appends model rows into `container`.
    const buildRows = (container, pid, models, emptyHint, isActive) => {
      const list = (models && models.length) ? models : [];
      if (!list.length) { container.appendChild(el('div', 'mc-row disabled', emptyHint)); return; }
      for (const m of list) {
        const isCur = (pid === curPid) && ((m.id || '') === (curModel || ''));
        const row = el('button', 'mc-row' + (isCur ? ' active' : ''));
        row.type = 'button';
        row.append(el('span', 'mc-check', isCur ? '✓' : ''), el('span', 'mc-rlabel', m.label || m.id || '默认'));
        const badge = ctxLenBadge(m.contextLength);
        if (badge) row.append(el('span', 'mc-ctxlen', badge));
        row.onclick = () => { close(); setEngineModel(pid, m.id || ''); };
        rows.push(row);
        container.appendChild(row);
      }
    };
    // Render one engine group. Active engine → open <div> with a plain group head. Non-active → collapsed
    // <details> whose summary shows the label + model count + 「选择将切换引擎」note.
    const addGroup = (pid, label, colorVar, models, emptyHint) => {
      const isActive = (pid === curPid);
      const count = (models && models.length) || 0;
      if (isActive) {
        const gh = el('div', 'mc-group');
        const dot = el('span', 'mc-gdot'); dot.style.background = colorVar;
        gh.append(dot, el('span', 'mc-glabel', label), el('span', 'mc-gcount', '· ' + count + ' 个模型'));
        wrap.appendChild(gh);
        buildRows(wrap, pid, models, emptyHint, true);
      } else {
        const det = el('details', 'mc-groupd');
        const sum = el('summary', 'mc-group mc-group-sum');
        const dot = el('span', 'mc-gdot'); dot.style.background = colorVar;
        sum.append(dot, el('span', 'mc-glabel', label), el('span', 'mc-gcount', '· ' + count + ' 个模型'),
          el('span', 'mc-switch-note', '选择将切换引擎'));
        det.appendChild(sum);
        buildRows(det, pid, models, emptyHint, false);
        wrap.appendChild(det);
      }
    };
    // Claude CLI group (models from status.models — the claude-side offline/proxy list, includes '默认').
    const claudeModels = (state.status && state.status.models) || [{ id: '', label: '默认' }];
    addGroup('', 'Claude CLI', 'var(--eng-claude)', claudeModels, '');
    // One group per configured provider.
    for (const p of (state.config.providers || [])) {
      const vis = engineVisual({ engine: 'openai', providerId: p.id, providerLabel: p.label || p.id });
      addGroup(p.id, p.label || p.id, vis.colorVar, (p.models || []), '（先在设置→Providers 测试连接）');
    }
    // Footer actions.
    wrap.appendChild(el('div', 'mc-sep'));
    const refreshRow = el('button', 'mc-row mc-action'); refreshRow.type = 'button';
    refreshRow.append(el('span', 'mc-check', '↻'), el('span', 'mc-rlabel', '刷新模型列表'));
    refreshRow.onclick = async () => { await refreshModels(true); close(); openModelChipPopover(); };
    const manageRow = el('button', 'mc-row mc-action'); manageRow.type = 'button';
    manageRow.append(el('span', 'mc-check', '⚙'), el('span', 'mc-rlabel', '管理 Providers…'));
    manageRow.onclick = () => { close(); openModal('settingsModal'); switchSettingsTab('providers'); };
    wrap.append(refreshRow, manageRow);
    rows.push(refreshRow, manageRow);
    // Keyboard nav: focus the current row (or first), ↑↓ move, Enter activates focused row.
    let idx = Math.max(0, rows.findIndex(r => r.classList.contains('active')));
    setTimeout(() => { (rows[idx] || rows[0])?.focus(); }, 0);
    wrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(rows.length - 1, idx + 1); rows[idx].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); rows[idx].focus(); }
      else if (e.key === 'Enter') { e.preventDefault(); (document.activeElement && rows.includes(document.activeElement) ? document.activeElement : rows[idx])?.click(); }
    });
    return wrap;
  });
}

/* ---------------- context-meter popover (§4.6) ---------------- */
// Click the battery → popover with used/limit + %, limit source (model-inferred / manual), preset
// chips (64K 128K 200K 1M 自动) + custom input, and a 🗜 compact button. Replaces the native prompt().
function openContextPopover() {
  const meter = $('contextMeter'); if (!meter || meter.classList.contains('hidden')) return;
  const handle = popover(meter, close => {
    const wrap = el('div', 'ctx-pop');
    const u = state.shownUsage || latestUsage(state.currentSession);
    const used = ctxTokensOf(u);
    const win = ctxWindow();
    const manual = ctxWindowManual();
    const srcLabel = ctxWindowSourceLabel();
    const pct = win > 0 && used != null ? Math.round((used / win) * 100) : 0;
    wrap.appendChild(el('div', 'ctx-pop-row', used != null ? `已用 ${fmtTokens(used)} / 上限 ${fmtTokens(win)} · ${pct}%` : `上限 ${fmtTokens(win)}（暂无用量数据）`));
    // Percent bar in the meter color.
    const bar = el('div', 'ctx-pop-bar'); const barIn = el('div', 'ctx-pop-bar-in');
    barIn.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (pct >= 90) barIn.style.background = 'var(--danger)'; else if (pct >= 70) barIn.style.background = 'var(--warn)'; else barIn.style.background = 'var(--ok)';
    bar.appendChild(barIn); wrap.appendChild(bar);
    wrap.appendChild(el('div', 'ctx-pop-src muted', `当前模型：${currentModelId() || '默认'} · 上限来源：${srcLabel}`));
    // v1.4.1: 端点未报告真实上限时(名称推测),明确提示可能不准 + 手动锁定仅对当前模型生效。
    if (manual <= 0 && srcLabel === '按名称推测') {
      wrap.appendChild(el('div', 'ctx-pop-hint muted', '该端点未报告真实上限，下面数字为按模型名推测、可能不准。点选实际上限即锁定（仅对当前模型生效）。'));
    }
    // Preset chips + custom input.
    const chips = el('div', 'ctx-chips');
    const presets = [['64K', 65536], ['128K', 131072], ['200K', 200000], ['1M', 1000000], ['自动', 0]];
    const applyWin = n => { setCtxWindowManual(n); updateContextMeter(); close(); };
    for (const [label, n] of presets) {
      const c = el('button', 'ctx-chip'); c.type = 'button'; c.textContent = label;
      if ((n === 0 && manual <= 0) || (n > 0 && manual === n)) c.classList.add('active');
      c.onclick = () => applyWin(n);
      chips.appendChild(c);
    }
    wrap.appendChild(chips);
    const custom = el('input', 'ctx-custom'); custom.type = 'text'; custom.placeholder = '自定义上限（Enter 生效）';
    custom.value = manual > 0 ? String(manual) : '';
    custom.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const v = custom.value.replace(/[,\s]/g, ''); const n = parseInt(v, 10); if (v === '') applyWin(0); else if (Number.isFinite(n) && n > 0) applyWin(n); }
    });
    wrap.appendChild(custom);
    // v1.0-S2 (IA): 「立即压缩」= 复用移出 composer 的真实 #compactBtn（保留 id + 既有 compactContext handler，
    // 只挪 DOM 位置）。把整个 host（含 #compactBtn）挪进弹层并去掉 hidden；关闭时挪回 composer 尾。两引擎均
    // 可用；简易模式亦可用（压缩是用户友好功能）。
    const cbHost = $('compactBtnHost'); const compactBtn = $('compactBtn');
    if (cbHost) { cbHost.classList.remove('hidden'); if (compactBtn) compactBtn.classList.add('ctx-compact', 'full'); wrap.appendChild(cbHost); }
    setTimeout(() => custom.focus(), 0);
    return wrap;
  });
  // popover() 关闭时**同步**移除弹层节点——#compactBtnHost 若在弹层内会一起被移除。用 MutationObserver 盯住
  // 弹层节点从 body 的移除：被移除时立刻把 host（含按钮）挪回 composer 尾、重新隐藏、去掉弹层专用样式类。
  if (handle && handle.node) {
    const host = $('compactBtnHost'); const composer = document.querySelector('.composer');
    const parkHost = () => {
      if (!host) return;
      const btn = host.querySelector('#compactBtn'); if (btn) btn.classList.remove('ctx-compact', 'full');
      if (composer) composer.appendChild(host);
      host.classList.add('hidden');
    };
    const obs = new MutationObserver(muts => {
      for (const mu of muts) { for (const n of mu.removedNodes) { if (n === handle.node) { parkHost(); obs.disconnect(); return; } } }
    });
    obs.observe(document.body, { childList: true });
  }
}

/* ---------------- v0.8-S6 capability badge ---------------- */
// Cache of the last /api/capabilities payload so the badge + popover share one fetch. Refreshed once on
// boot/status and (while open) polled every 60s; opening also triggers an immediate fetch.
let _caps = null;
let _capPoll = null;
async function fetchCapabilities(force) {
  try { const r = await api('/api/capabilities' + (force ? '?force=1' : '')); if (r && r.ok) { _caps = r; renderCapBadge(); } return r; }
  catch { return null; }
}
// Count "configured-but-unavailable" gaps (rg/git absence is NOT counted — only a configured endpoint that
// is unreachable, and a desktop MCP that is enabled in config but failed to come up / be probed).
function capGapCount(caps) {
  if (!caps) return 0;
  let n = 0;
  if (caps.provider && caps.network && caps.network.online === false) n += 1; // active endpoint unreachable
  const deskEnabled = !!(state.config && state.config.desktopMcp && state.config.desktopMcp.enabled);
  if (deskEnabled && caps.desktopMcp && caps.desktopMcp.present === false) n += 1; // desktop bridge configured but absent
  return n;
}
function renderCapBadge() {
  const badge = $('capBadge'); if (!badge) return;
  const caps = _caps;
  // Show the badge only in provider mode OR whenever we have a probe result (Claude mode still reports
  // binaries/desktop, but network is often unknown; keep it visible so the matrix is always reachable).
  badge.classList.remove('hidden');
  const net = badge.querySelector('.cap-net');
  const gaps = badge.querySelector('.cap-gaps');
  const online = caps && caps.network ? caps.network.online : null;
  badge.classList.remove('cap-online', 'cap-offline', 'cap-unknown');
  if (online === true) { net.textContent = '●'; badge.classList.add('cap-online'); badge.title = '能力矩阵：在线（点击查看）'; }
  else if (online === false) { net.textContent = '○'; badge.classList.add('cap-offline'); badge.title = '能力矩阵：离线（点击查看）'; }
  else { net.textContent = '◐'; badge.classList.add('cap-unknown'); badge.title = '能力矩阵：联网状态未知（点击查看）'; }
  const g = capGapCount(caps);
  if (g > 0) { gaps.textContent = String(g); gaps.classList.remove('hidden'); }
  else { gaps.classList.add('hidden'); gaps.textContent = ''; }
}
// anchorOverride (v1.0-S2 IA): capBadge 移出顶栏后 display:none，从「⋯」菜单打开时锚点改用 #moreMenuBtn，
// 免得定位到不可见元素（getBoundingClientRect 全 0）。默认仍锚在 badge（供别处直接调用/回归）。
function openCapPopover(anchorOverride) {
  const badge = $('capBadge'); if (!badge || badge.classList.contains('hidden')) return;
  const anchor = anchorOverride || $('moreMenuBtn') || badge;
  // Immediate refresh + poll every 60s WHILE OPEN only (spec §4). closePopover stops the poll via onClose.
  fetchCapabilities(true);
  if (_capPoll) clearInterval(_capPoll);
  _capPoll = setInterval(() => fetchCapabilities(true), 60000);
  const handle = popover(anchor, () => {
    const wrap = el('div', 'cap-pop');
    const caps = _caps || {};
    const netLabel = (caps.network && caps.network.online === true) ? '在线'
      : (caps.network && caps.network.online === false) ? '离线' : '未知';
    const netCls = (caps.network && caps.network.online === true) ? 'ok'
      : (caps.network && caps.network.online === false) ? 'bad' : 'muted';
    const item = (k, v, cls) => {
      const row = el('div', 'cap-item');
      row.appendChild(el('span', 'cap-k', k));
      row.appendChild(el('span', 'cap-v' + (cls ? ' ' + cls : ''), v));
      return row;
    };
    wrap.appendChild(el('h4', null, '网络与引擎'));
    wrap.appendChild(item('网络', netLabel, netCls));
    wrap.appendChild(item('引擎', caps.engine === 'openai' ? 'Provider（原生）' : 'Claude CLI'));
    if (caps.provider) {
      wrap.appendChild(item('视觉输入', caps.provider.vision ? '支持' : '不支持', caps.provider.vision ? 'ok' : 'muted'));
      wrap.appendChild(item('推理模型', caps.provider.reasoning ? '是' : '否', 'muted'));
    }
    wrap.appendChild(el('h4', null, '本地工具'));
    wrap.appendChild(item('git', caps.binaries && caps.binaries.git ? '可用' : '缺失', caps.binaries && caps.binaries.git ? 'ok' : 'muted'));
    wrap.appendChild(item('ripgrep 快搜', caps.binaries && caps.binaries.rg ? '可用' : '缺失（用内置搜索）', caps.binaries && caps.binaries.rg ? 'ok' : 'muted'));
    wrap.appendChild(el('h4', null, '桌面操控'));
    const dm = caps.desktopMcp || {};
    wrap.appendChild(item('桌面 MCP', dm.present ? `已连接（${dm.toolCount || 0} 工具）` : '未连接', dm.present ? 'ok' : 'muted'));
    const opt = dm.optional || {};
    const optStr = ['ocr', 'uia', 'cv2', 'playwright'].filter(k => opt[k]).join('、') || '（无）';
    wrap.appendChild(item('可选模块', optStr, opt.ocr || opt.uia ? 'ok' : 'muted'));
    return wrap;
  });
  // Stop the poll when the popover closes (popover() returns {node, close}; but close via outside-click
  // won't call our code — hook the badge: when activePopover clears, clear the interval on next tick).
  if (handle) {
    const stop = () => { if (!activePopover || activePopover.anchor !== anchor) { if (_capPoll) { clearInterval(_capPoll); _capPoll = null; } clearInterval(mon); } };
    const mon = setInterval(stop, 500);
  }
}

// Session rename via an inline popover (§4.6) — replaces the native prompt(). Input + 确定 button.
function openRenamePopover(anchorEl, s) {
  popover(anchorEl, close => {
    const wrap = el('div', 'rename-pop');
    const inp = el('input', 'rename-input'); inp.type = 'text'; inp.value = s.title || ''; inp.placeholder = '会话名称';
    const commit = () => { const t = inp.value.trim(); close(); if (t && t !== s.title) patchSession(s.id, { title: t }); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    const ok = el('button', 'primary', '确定'); ok.type = 'button'; ok.onclick = commit;
    const row = el('div', 'rename-row'); row.append(inp, ok);
    wrap.appendChild(row);
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    return wrap;
  }, { placement: 'bottom-start' });
}

// ≤560px composer fold (§4.3 tail): the composerMoreBtn(＋)opens a popover listing 添加文件 / 技能 /
// 压缩 — the same three actions that are tiled on wider screens(P1 §2.15:emoji → 线性 SVG)。Skill is omitted in provider mode
// (A2: it is a Claude-CLI concept). Uses the shared popover primitive; sendBtn is never folded.
function openComposerMorePopover() {
  const anchor = $('composerMoreBtn'); if (!anchor) return;
  popover(anchor, close => {
    const wrap = el('div', 'composer-more-pop');
    // 添加文件 — reuse the existing hidden #fileInput by clicking it.
    const attach = el('button', 'cm-item'); attach.type = 'button'; attach.append(icon('paperclip', 16), document.createTextNode('添加文件'));
    attach.onclick = () => { close(); $('fileInput')?.click(); };
    wrap.appendChild(attach);
    // 技能 — Claude mode only.
    if (!isProviderMode()) {
      const skill = el('button', 'cm-item'); skill.type = 'button'; skill.append(icon('sparkles', 16), document.createTextNode('技能 / 命令'));
      skill.onclick = () => { close(); openSkillPanel(); };
      wrap.appendChild(skill);
    }
    // 🗜 压缩 — both engines (provider goes through the server summary endpoint).
    const compact = el('button', 'cm-item'); compact.type = 'button'; compact.append(icon('compress', 16), document.createTextNode('压缩上下文'));
    compact.onclick = () => { close(); compactContext(); };
    wrap.appendChild(compact);
    return wrap;
  }, { placement: 'bottom-start' });
}

/* ---------------- v1.0-S2 (IA): 顶栏「⋯」更多菜单 ---------------- */
// 轻量 popover 菜单（role="menu"）：主题切换 / 界面模式切换 / 能力矩阵 / 快捷键。Esc/点外/重点击关闭（popover
// 原语已实现），菜单项 role="menuitem"。每项复用既有 handler（toggleTheme/toggleUiMode/openCapPopover/openModal），
// 迁移自原顶栏控件。DOM 全 createElement/textContent 构建（F 安全红线）。
function themeMenuLabel() { return document.documentElement.getAttribute('data-theme') === 'dark' ? '主题：深色' : '主题：浅色'; }
function uiModeMenuLabel() { return document.documentElement.getAttribute('data-ui-mode') === 'simple' ? '界面：精简' : '界面：专家'; }
// 菜单打开时若主题/界面被切换，更新对应项文案（无 DOM 时静默）。
function syncMoreMenuLabels() {
  const t = document.getElementById('mm-theme-label'); if (t) t.textContent = themeMenuLabel();
  const u = document.getElementById('mm-uimode-label'); if (u) u.textContent = uiModeMenuLabel();
}
function openMoreMenu() {
  const anchor = $('moreMenuBtn'); if (!anchor) return;
  popover(anchor, close => {
    const menu = el('div', 'more-menu'); menu.setAttribute('role', 'menu');
    const item = (label, id, onClick, keepOpen) => {
      const b = el('button', 'mm-item'); b.type = 'button'; b.setAttribute('role', 'menuitem');
      const span = el('span', 'mm-label', label); if (id) span.id = id;
      b.appendChild(span);
      b.onclick = () => { try { onClick(); } catch { /* ignore */ } if (!keepOpen) close(); };
      return b;
    };
    // 主题：切换后更新本项文案，菜单保持打开（即时看到状态）。
    menu.appendChild(item(themeMenuLabel(), 'mm-theme-label', () => { toggleTheme(); syncMoreMenuLabels(); }, true));
    // 界面：精简/专家。切换后更新文案，菜单保持打开。
    menu.appendChild(item(uiModeMenuLabel(), 'mm-uimode-label', () => { toggleUiMode(); syncMoreMenuLabels(); }, true));
    menu.appendChild(el('div', 'mm-sep'));
    // 能力矩阵：◐/●/○ 网络点 + 缺口数。点击先关本菜单，再在下一 tick 打开既有能力矩阵 popover（避免同 tick
    // 内「关菜单」与「开新弹层」相互抵消——popover 原语一次只允许一个）。keepOpen=true 让 item 包装不重复关闭。
    { const caps = _caps; const online = caps && caps.network ? caps.network.online : null;
      const netGlyph = online === true ? '●' : online === false ? '○' : '◐';
      const g = capGapCount(caps);
      const b = item(`能力矩阵  ${netGlyph}${g > 0 ? ' · 缺口 ' + g : ''}`, null, () => { close(); setTimeout(() => openCapPopover($('moreMenuBtn')), 0); }, true);
      menu.appendChild(b);
    }
    // 快捷键：打开既有 helpModal（modal 与 popover 不冲突，可同 tick）。
    menu.appendChild(item('快捷键', null, () => { close(); openModal('helpModal'); }));
    return menu;
  });
}

/* ---------------- modals ---------------- */
// §4.9: opening records the trigger on the backdrop so closeModal (Esc/✕/backdrop/programmatic) can
// return focus to it; on open we focus the first interactive element inside the modal/palette panel.
const _modalTriggers = new WeakMap();
function openModal(id) {
  const bd = $(id);
  _modalTriggers.set(bd, document.activeElement);
  bd.classList.remove('hidden');
  if (id === 'settingsModal') switchSettingsTab(state._settingsTab || 'basic');
  const panel = bd.querySelector('.modal, .palette');
  setTimeout(() => { focusFirstInteractive(panel)?.focus?.(); }, 0);
}
function closeModal(id) {
  const bd = $(id);
  bd.classList.add('hidden');
  const t = _modalTriggers.get(bd); _modalTriggers.delete(bd);
  if (t && typeof t.focus === 'function') { try { t.focus(); } catch { /* ignore */ } }
}
function anyModalOpen() { return [...document.querySelectorAll('.modal-backdrop')].some(m => !m.classList.contains('hidden')); }
// v1.5 (§1.2): 简易模式可见的设置页签白名单 —— 只留「基础/服务商/联网搜索」。其余(Claude CLI/Agent 角色/
// 集成 MCP/高级)含 MAX_THINKING_TOKENS / --max-turns / Overlay ID 等开发者字段,对非程序员主画像纯劝退,
// 一律隐藏。CSS(styles.css)隐藏页签按钮,这里的 JS 兜底防「隐藏页签的面板悬空显示」。
const SETTINGS_SIMPLE_TABS = new Set(['basic', 'providers', 'network']);
// Settings tab switcher (§4.5): toggles the tab-bar button + the matching .settings-tab panel.
// v1.5 (§1.2): 简易模式下,非白名单页签一律落回「基础」;force=true 供明确的开发者入口(如引导页
// 「配置 Claude CLI」逃生门)绕过收敛,直达目标页签。
function switchSettingsTab(name, force) {
  if (!force && document.documentElement.getAttribute('data-ui-mode') === 'simple' && !SETTINGS_SIMPLE_TABS.has(name)) name = 'basic';
  state._settingsTab = name;
  document.querySelectorAll('#settingsTabs button').forEach(b => b.classList.toggle('active', b.dataset.stab === name));
  document.querySelectorAll('.settings-tab').forEach(s => s.classList.toggle('active', s.id === `stab-${name}`));
  if (name === 'agents') loadAgentRoles();
}

/* ---------------- composer helpers ---------------- */
// v1.3-FE1:autoGrow 已搬入 ./js/util.js(纯 DOM 尺寸计算,顶部 import 取回);调用点(sendPrompt/boot 等)不变。

// v1.0-S2 (IA): 开发者组页签集合（简易模式全部隐藏；JS 兜底切回 files）。
const DEV_TABS = new Set(['powershell', 'desktop', 'mcp', 'debug', 'doctor']);
// v1.0-S2 (IA): #toolOutput 全局原始输出槽只在这些页签下可见——常驻组(文件/产物/审计)有各自的预览区，
// 不该冒无关原始输出；文件/终端/桌面/MCP 的搜索/读取/运行确实写入此槽。简易模式一律隐藏（CSS 兜底）。
const TOOLOUT_TABS = new Set(['powershell', 'files', 'desktop', 'mcp']);
function switchTab(tab) {
  // v1.0-S2 (IA): 简易模式兜底 — 若目标页签属开发者组（如旧 localStorage 恢复的激活态），切回 files。
  if (DEV_TABS.has(tab) && document.documentElement.getAttribute('data-ui-mode') === 'simple') tab = 'files';
  // Scope to the tool pane's tab bar: the settings modal now also uses .tool-tabs (with data-stab),
  // so an unscoped selector would wrongly clear the active settings tab. Match by data-tab only.
  document.querySelectorAll('.tool-pane .tool-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tool-section').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  // v1.0-S2 (IA): 原始输出槽显隐随激活页签（常驻组不显示无关原始输出）。
  { const to = $('toolOutput'); if (to) to.classList.toggle('toolout-hidden', !TOOLOUT_TABS.has(tab)); }
  // v0.8-S2: only poll the shell-session list while its tab is showing.
  updateShellPolling();
  // v0.9-S3 (C3): (re)load the file tree when the files tab is opened, if empty.
  if (tab === 'files' && $('fileTree') && !$('fileTree').childElementCount) loadFileTree();
  // v0.9-S4 (C4): render the artifacts gallery from this session's turn summaries when its tab opens.
  if (tab === 'artifacts') renderArtifactsGallery();
  // v1.0.2 (G1): (re)load the checkpoint change list when the 变更 tab opens.
  if (tab === 'changes') loadChanges();
  // v0.9-S8 (§4 B4): load the audit timeline once when its tab opens (no polling — the audit view is quiet).
  if (tab === 'audit') { if (!auditState.loaded) loadAudit(); else renderAuditList(); }
  // 用量看板：打开时才拉取（懒加载，同审计）。已加载则用缓存重绘，避免重复请求；刷新/切范围会强制重拉。
  if (tab === 'usage') { if (!usageState.loaded) loadUsage(); else renderUsage(usageState.data); }
  if (tab === 'agent-runs') loadAgentWorkflows();
  updateAgentRunsPolling(tab);
  maybeSuggestWideRight(tab); // v3 (§2.7/§2.8): 监控/用量页签在 340px 下一次性软提示切 480
}

// A5: on narrow screens (≤1180px) the tool pane is an overlay drawer toggled by `tools-open`; on the
// desktop grid (≥1181px) it is a column shown/hidden by the `tools-collapsed` class. matchMedia picks.
function isNarrow() { return window.matchMedia('(max-width: 1180px)').matches; }
// v1.0.2 (F2): 折叠侧栏统一入口。加/去 .sidebar-collapsed(CSS 把侧栏栅格轨道归 0),同步 ☰ 恢复钮显隐,
// 并持久化到 localStorage 供下次启动恢复。恢复态在 boot() 里调用(applyUiMode 之后、拉数据之前均可)。
function setSidebarCollapsed(collapsed, persist = true) {
  document.querySelector('.app-shell').classList.toggle('sidebar-collapsed', collapsed);
  const showBtn = $('showSidebarBtn');
  if (showBtn) showBtn.classList.toggle('hidden', !collapsed);
  // v3 (§A2): 只有用户经 «/☰ 的显式选择才持久化;响应式默认(手机首启折叠)不写 localStorage,免污染桌面偏好。
  if (persist) { try { localStorage.setItem('wcw.sidebarCollapsed', collapsed ? '1' : '0'); } catch { /* ignore */ } }
}
function restoreSidebarCollapsed() {
  let v = null;
  try { v = localStorage.getItem('wcw.sidebarCollapsed'); } catch { /* ignore */ }
  if (v === '1') { setSidebarCollapsed(true); return; }
  if (v === '0') return; // 用户显式选择保持展开 —— 尊重之(即便窄屏)
  // v3 (§A2): 无用户偏好时,≤760px 手机默认收起侧栏(否则 absolute 浮层开机盖住对话区);不持久化,仅作响应式默认。
  if (window.matchMedia('(max-width: 760px)').matches) setSidebarCollapsed(true, false);
}
function toggleToolPane() {
  const shell = document.querySelector('.app-shell');
  if (isNarrow()) shell.classList.toggle('tools-open');
  else shell.classList.toggle('tools-collapsed');
}
// Ensure the tool pane is visible (used by "open MCP inspector" / "体检" entry points), respecting
// which mechanism applies at the current width.
function openToolPane() {
  const shell = document.querySelector('.app-shell');
  if (isNarrow()) shell.classList.add('tools-open');
  else shell.classList.remove('tools-collapsed');
}
function closeToolDrawer() { document.querySelector('.app-shell').classList.remove('tools-open'); }

/* ---------------- v3 (§2.7 P2): 右栏三档宽(340/480/全屏)—— 拖拽手柄 + 双击循环 + localStorage 记忆 ---------------- */
// 档位存 'wcw.rightWidth'(值 '340'|'480'|'full')。桌面栅格档专属;窄屏(≤1180)走既有抽屉,仅记偏好不改布局。
// 全屏档 = tool-pane 转 fixed 覆盖中栏(CSS .tools-fullscreen),Esc / 双击手柄退出。
const RIGHT_TIERS = ['340', '480', 'full'];
const RIGHT_FULL_THRESHOLD = 620; // 拖过此像素宽度 → 吸附到全屏档
function applyRightWidth(tier, persist = true) {
  if (!RIGHT_TIERS.includes(tier)) tier = '340';
  const shell = document.querySelector('.app-shell'); if (!shell) return;
  // Chrome 无法可靠过渡「var() 驱动的 grid 轨」的变化(会卡在起始宽度);切档时抑制过渡让新轨宽即时落定。
  // 末尾强制同步重排后立即移除(不用 rAF —— 后台/空闲渲染时 rAF 可能不触发,会把过渡永久关死)。
  // (侧栏折叠的过渡不受影响 —— 它变的是【具体值】首轨 288<->0,不走此路径。)
  shell.classList.add('right-resizing');
  if (tier === 'full' && !isNarrow()) {
    state._preFullTier = (state._rightTier && state._rightTier !== 'full') ? state._rightTier : '480';
    shell.classList.remove('tools-collapsed'); // 全屏必然展开工具面板
    shell.classList.add('tools-fullscreen', 'rp-wide');
    shell.style.setProperty('--right-w', '480px'); // 底层保留轨宽(被 fixed 面板覆盖,无空隙)
  } else {
    shell.classList.remove('tools-fullscreen');
    shell.style.setProperty('--right-w', (tier === 'full' ? '480' : tier) + 'px');
    shell.classList.toggle('rp-wide', tier === '480' || tier === 'full'); // §2.8 用量瓦片三列开关
  }
  void shell.offsetWidth; // 强制同步重排,让新轨宽在无过渡下即时落定
  shell.classList.remove('right-resizing');
  state._rightTier = tier;
  if (persist) { try { localStorage.setItem('wcw.rightWidth', tier); } catch { /* ignore */ } }
}
function restoreRightWidth() {
  let v = '340'; try { v = localStorage.getItem('wcw.rightWidth') || '340'; } catch { /* ignore */ }
  applyRightWidth(v, false);
}
function cycleRightWidth() {
  const cur = state._rightTier || '340';
  applyRightWidth(RIGHT_TIERS[(RIGHT_TIERS.indexOf(cur) + 1) % RIGHT_TIERS.length]);
}
// Esc 退出右栏全屏(回到进入前的档位)。返回是否处理了(供全局 Esc 链短路)。
function exitRightFullscreen() {
  const shell = document.querySelector('.app-shell');
  if (shell && shell.classList.contains('tools-fullscreen')) { applyRightWidth(state._preFullTier || '340'); return true; }
  return false;
}
// §2.8 软提示:切到监控/用量页签且当前 340px 时,一次性建议 480(不强切;localStorage 记忆已提示过)。
function maybeSuggestWideRight(tab) {
  if ((tab !== 'agent-runs' && tab !== 'usage') || isNarrow()) return;
  if ((state._rightTier || '340') !== '340') return;
  try { if (localStorage.getItem('wcw.rightWidthHintShown') === '1') return; localStorage.setItem('wcw.rightWidthHintShown', '1'); } catch { /* ignore */ }
  toast('监控和用量在更宽的面板里更好读 —— 拖右栏左缘或双击手柄可切到 480');
}
function initRightResize() {
  const handle = $('rightResizeHandle'); if (!handle) return;
  handle.addEventListener('dblclick', () => cycleRightWidth());
  handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleRightWidth(); } });
  handle.addEventListener('pointerdown', e => {
    if (isNarrow() || e.button !== 0) return;
    e.preventDefault();
    const shell = document.querySelector('.app-shell');
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    shell.classList.add('right-resizing');
    shell.classList.remove('tools-fullscreen'); // 拖动即回到可变轨宽预览
    let tier = state._rightTier === 'full' ? '480' : (state._rightTier || '340');
    const onMove = ev => {
      const desired = window.innerWidth - ev.clientX;
      if (desired > RIGHT_FULL_THRESHOLD) { tier = 'full'; shell.style.setProperty('--right-w', Math.min(desired, window.innerWidth - 360) + 'px'); }
      else { const clamped = Math.max(300, Math.min(desired, 560)); shell.style.setProperty('--right-w', clamped + 'px'); tier = Math.abs(clamped - 480) <= Math.abs(clamped - 340) ? '480' : '340'; }
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      shell.classList.remove('right-resizing');
      applyRightWidth(tier); // 松手吸附到最近档并记忆
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  });
}

/* ---------------- bindings ---------------- */
function bindEvents() {
  // sidebar
  $('newSessionBtn').onclick = () => newSession();
  $('sessionSearch').oninput = renderSessions;
  $('openSettingsBtn').onclick = () => openModal('settingsModal');
  $('openDoctorBtn').onclick = () => { refreshStatus(); openToolPane(); switchTab('doctor'); };
  $('helpBtn').onclick = () => openModal('helpModal');
  // v1.0.2 (F2): 折叠/展开侧栏走同一函数,状态持久化到 localStorage('wcw.sidebarCollapsed'),boot 时恢复。
  $('collapseSidebarBtn').onclick = () => setSidebarCollapsed(true);
  $('showSidebarBtn').onclick = () => setSidebarCollapsed(false);

  // topbar
  { const chip = $('modelChip'); if (chip) chip.onclick = openModelChipPopover; }
  { const cm = $('contextMeter'); if (cm) cm.onclick = openContextPopover; }
  { const cb = $('capBadge'); if (cb) cb.onclick = openCapPopover; } // v0.8-S6 capability matrix
  $('permSelect').onchange = e => {
    // v0.9-S1 (C1): in simple mode the bypass option stays visible but selecting it prompts a confirm once —
    // 精简界面用户更需要一道明确的确认闸门（bypass = 跳过所有权限弹窗）。Cancelling reverts the select.
    if ((e.target.value === 'bypass' || e.target.value === 'auto') && document.documentElement.getAttribute('data-ui-mode') === 'simple') {
      var modeLabel = e.target.value === 'bypass' ? '跳过权限' : '智能自动';
      if (!confirm('切换到「' + modeLabel + '」模式？' + (e.target.value === 'bypass' ? '模型无需确认即可修改文件、运行命令。' : 'AI将自动判断风险并执行低风险操作。') + '确定切换？')) {
        e.target.value = state.config.permissionMode || 'bypass'; populatePermSelect(); return;
      }
    }
    saveConfigPartial({ permissionMode: e.target.value }); state.config.permissionMode = e.target.value; populatePermSelect(); if (e.target.value === 'bypass') toast('⚠ 已切到跳过权限模式', 'err'); else if (e.target.value === 'auto') toast('已切到智能自动模式', 'ok');
  };
  $('themeToggle').onclick = toggleTheme;
  { const um = $('uiModeToggle'); if (um) um.onclick = toggleUiMode; } // v0.9-S1 (C1)
  // v1.0-S2 (IA): 安全 chip 开安全弹层；「⋯」开更多菜单（主题/界面/能力矩阵/快捷键）。
  { const pc = $('permChip'); if (pc) pc.onclick = openPermPopover; }
  { const mm = $('moreMenuBtn'); if (mm) mm.onclick = openMoreMenu; }
  { const wp = $('workspacePicker'); if (wp) wp.onclick = pickWorkspace; } // v0.9-S3 (C3)
  $('toggleToolsBtn').onclick = toggleToolPane;
  // v0.8-S3 step-bar: click the head to expand/collapse the full task list.
  { const sbt = $('stepBarToggle'); if (sbt) sbt.onclick = () => toggleStepBar(); }
  // ↓ 回到最新: click snaps to bottom; the messages scroll listener toggles its visibility.
  { const jl = $('jumpLatest'); if (jl) jl.onclick = scrollMessagesToBottom; }
  { const mb = $('messages'); if (mb) mb.addEventListener('scroll', updateJumpLatest, { passive: true }); }
  // A5: clicking the dimmed backdrop closes the narrow-screen drawer.
  { const bd = $('drawerBackdrop'); if (bd) bd.onclick = closeToolDrawer; }

  // composer
  const ta = $('promptInput');
  ta.addEventListener('input', () => { autoGrow(ta); try { localStorage.setItem('wcw.draft', ta.value); } catch { /* ignore */ } });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); }
  });
  $('sendBtn').onclick = () => sendPrompt();
  $('skillBtn').onclick = openSkillPanel;
  // v3 (§B2): 「AI 工作」面板顶部的用量/审计 mini 链接 —— 简易模式经此切到隐藏页签(switchTab 不拦这两个 tab)。
  { const u = $('usageMiniLink'); if (u) u.onclick = () => { switchTab('usage'); }; }
  { const a = $('auditMiniLink'); if (a) a.onclick = () => { switchTab('audit'); }; }
  { const cb = $('compactBtn'); if (cb) cb.onclick = compactContext; }
  // ≤560px composer fold: composerMoreBtn opens the popover with 添加文件/技能/压缩 (§4.3 tail).
  { const mb = $('composerMoreBtn'); if (mb) mb.onclick = openComposerMorePopover; }
  $('skillSearch').addEventListener('input', () => { skillIndex = 0; renderSkillList(); });
  $('skillSearch').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSkillSel(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSkillSel(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pickSkill(skillIndex); }
  });
  // "/" at the very start of an empty composer opens the skill panel (「技能库」). v1 技能体系: 面板现承载
  // 技能开关(两个引擎通用),故不再限 Claude 模式——两个引擎都用 "/" 唤出。
  ta.addEventListener('keydown', e => {
    if (e.key === '/' && ta.value === '') { e.preventDefault(); openSkillPanel(); }
  });
  $('fileInput').addEventListener('change', e => { uploadFiles([...e.target.files]); e.target.value = ''; });
  ta.addEventListener('paste', e => {
    const imgs = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); uploadFiles(imgs.map(i => i.getAsFile()).filter(Boolean)); }
  });

  // full-window dropzone
  const shell = document.body;
  let dragDepth = 0;
  shell.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('dropHint').classList.remove('hidden'); });
  shell.addEventListener('dragover', e => e.preventDefault());
  shell.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
  // v0.9-S3 (C3): drop splits into files (attachments) + folders (workspace fingerprint) — see handleDrop.
  shell.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('dropHint').classList.add('hidden'); handleDrop(e); });

  // tool pane
  document.querySelectorAll('.tool-pane .tool-tabs button').forEach(b => { b.onclick = () => { switchTab(b.dataset.tab); if (b.dataset.tab === 'mcp') openMcpInspector(); }; });
  // v3 P3a:中栏主视图 Tab(对话 | 工作台)→ switchMainView 状态机。
  document.querySelectorAll('.wb-mainview-tabs .wb-mv-tab').forEach(b => { b.onclick = () => switchMainView(b.dataset.mainView); });
  // v3 P3b:窄屏右板抽屉 backdrop 点击关闭(§6#10;宽屏右板常驻，backdrop 由 CSS 隐藏，此监听无副作用)。
  const wbBd = $('wbSideBackdrop'); if (wbBd) wbBd.onclick = () => wbOpenSide(false);
  const rm = $('refreshMcpBtn'); if (rm) rm.onclick = openMcpInspector;
  $('runPsBtn').onclick = () => runTool('powershell_run', { command: $('psCommand').value, cwd: state.config.defaultWorkspace || '', timeoutMs: 60000 });
  { const sn = $('shellNewBtn'); if (sn) sn.onclick = newShellSession; }
  { const ft = $('fileTreeRefreshBtn'); if (ft) ft.onclick = loadFileTree; } // v0.9-S3 (C3)
  { const ar = $('artifactsRefreshBtn'); if (ar) ar.onclick = renderArtifactsGallery; } // v0.9-S4 (C4)
  { const ar = $('agentRunsRefreshBtn'); if (ar) ar.onclick = loadAgentRuns; }
  // 用量看板：刷新按钮强制重拉；范围段控切换范围并重拉（默认本月）。
  { const ur = $('usageRefreshBtn'); if (ur) ur.onclick = () => loadUsage(true); }
  document.querySelectorAll('.usage-range-btn').forEach(b => { b.onclick = () => setUsageRange(b.dataset.range); });
  { const we = $('workflowEditorBtn'); if (we) we.onclick = () => openWorkflowEditor(); }
  { const wr = $('workflowQuickRunBtn'); if (wr) wr.onclick = launchAgentWorkflowFromQuickSelect; }
  { const cr = $('changesRefreshBtn'); if (cr) cr.onclick = loadChanges; } // v1.0.2 (G1)
  // v0.9-S8 (§4 B4): audit tab — refresh re-pulls (resets loaded so loadAudit re-fetches); filters are
  // client-side over the already-fetched list (instant, no re-fetch).
  { const au = $('auditRefreshBtn'); if (au) au.onclick = () => { auditState.loaded = false; loadAudit(); }; }
  { const asf = $('auditSourceFilter'); if (asf) asf.onchange = renderAuditList; }
  { const atf = $('auditTypeFilter'); if (atf) atf.oninput = renderAuditList; }
  $('searchBtn').onclick = () => runTool('file_search', { root: currentWorkspace(), pattern: $('searchPattern').value || 'TODO|FIXME', maxResults: 200 });
  $('readFileBtn').onclick = () => runTool('file_read', { path: $('readPath').value.trim(), limit: 200000 });
  $('browserOpenBtn').onclick = () => runTool('browser_open', { url: $('browserUrl').value.trim() });
  $('screenshotBtn').onclick = () => runTool('desktop_screenshot', {});
  $('refreshDoctorBtn').onclick = () => refreshStatus();
  $('debugClearBtn').onclick = () => { state.rawEvents = []; $('rawEvents').innerHTML = ''; };
  $('debugDownloadBtn').onclick = downloadRawEvents;

  // settings modal
  $('saveConfigBtn').onclick = saveSettings;
  { const ap = $('addProviderBtn'); if (ap) ap.onclick = addProviderFromPreset; }
  { const cp0 = $('applyClaudeEndpointPresetBtn'); if (cp0) cp0.onclick = applyClaudeEndpointPreset; }
  { const im = $('importMcpFolderBtn'); if (im) im.onclick = () => importMcpFromFolder(im); } // v1.0.2 (G5c)
  { const b = $('agentRoleRefreshBtn'); if (b) b.onclick = loadAgentRoles; }
  { const b = $('agentRoleAddBtn'); if (b) b.onclick = addAgentRole; }
  { const b = $('agentRoleSaveBtn'); if (b) b.onclick = saveAgentRoles; }
  { const s = $('agentRoleScope'); if (s) s.onchange = resetAgentRoleDraft; }
  document.querySelectorAll('#settingsTabs button').forEach(b => { b.onclick = () => switchSettingsTab(b.dataset.stab); });
  { const st = $('cfgSearchType'); if (st) st.onchange = updateSearchBackendVisibility; } // v1.0-S3 (B1)
  { const od = $('openDataDirBtn'); if (od) od.onclick = () => { const dr = (state.status && state.status.dataRoot) || ''; if (dr) runTool('browser_open', { url: dr }); }; }
  // Route static-modal closes through closeModal(id) so focus returns to the trigger (§4.9). Dynamic
  // buildModal backdrops have no id / no [data-close-modal] and manage their own focus restore.
  document.querySelectorAll('[data-close-modal]').forEach(b => { b.onclick = () => { const bd = b.closest('.modal-backdrop'); if (bd && bd.id) closeModal(bd.id); else if (bd) bd.classList.add('hidden'); }; });
  document.querySelectorAll('.modal-backdrop').forEach(m => { m.addEventListener('mousedown', e => { if (e.target === m) { if (m.id) closeModal(m.id); else m.classList.add('hidden'); } }); });

  // palette
  $('paletteInput').addEventListener('input', () => { state.paletteIndex = 0; renderPalette(); });
  $('paletteInput').addEventListener('keydown', e => {
    const acts = state._paletteActs || [];
    if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = Math.min(acts.length - 1, state.paletteIndex + 1); renderPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); renderPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); const a = acts[state.paletteIndex]; if (a) { closeModal('paletteModal'); a.run(); } }
  });

  // global shortcuts
  window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newSession(); }
    else if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.modal-backdrop:not(.hidden)')];
      // Dynamic modals resolve their held request via __cancel; static ones go through closeModal so
      // focus returns to the trigger (§4.9).
      if (open.length) open.forEach(m => { if (m.__cancel) m.__cancel(); else if (m.id) closeModal(m.id); else m.classList.add('hidden'); });
      // v3 (§2.7 P2): 无模态时 Esc 先退出右栏全屏档,再关抽屉,再停止回合。
      else if (exitRightFullscreen()) { /* 已退出全屏 */ }
      // A5: with no modal open, Esc first closes the narrow-screen tool drawer, then stops a turn.
      else if (document.querySelector('.app-shell').classList.contains('tools-open')) closeToolDrawer();
      else if (state.streaming) stopTurn();
    }
    else if (e.key === '?' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { openModal('helpModal'); }
  });
}
function downloadRawEvents() {
  const blob = new Blob([state.rawEvents.map(r => r.line).join('\n')], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `claude-events-${Date.now()}.ndjson`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- v1.5 (§1.3): 首次连接失败故障卡 ---------------- */
// 占满对话区的显式故障卡:大标题「无法连接本地服务」+ 三条可能原因(端口被占/服务未启动/被安全软件拦截)
// +「重试连接」(重跑 bootData,不重复 bindEvents)+「查看日志/诊断」(展开原始错误详情,供排查/反馈)。
// 全中文人话,主卡不暴露英文栈 —— 原始 message 收进折叠的诊断面板(专家才需要)。DOM 全 createElement/
// textContent(F 安全红线,err 内容不可信)。故障卡可键盘操作:重试是真 <button> 且自动聚焦,诊断按钮
// 带 aria-expanded/aria-controls。
function buildBootFailureCard(err) {
  const wrap = el('div', 'boot-failure');
  wrap.setAttribute('role', 'alert');
  wrap.appendChild(el('div', 'boot-failure-icon', '⚠'));
  wrap.appendChild(el('h2', 'boot-failure-title', '无法连接本地服务'));
  wrap.appendChild(el('p', 'boot-failure-lead', '如意工作台需要本机后台服务才能工作。刚才尝试连接时没有成功。'));
  const ul = el('ul', 'boot-failure-reasons');
  [
    ['端口被占用', '可能有旧的实例还在后台运行，占着同一个端口。'],
    ['服务未启动', '本机后台服务可能没起来，或者已经退出了。'],
    ['被安全软件拦截', '防火墙或杀毒软件可能挡住了本机连接。'],
  ].forEach(([t, d]) => {
    const li = el('li', 'boot-failure-reason');
    li.appendChild(el('span', 'boot-failure-reason-t', t));
    li.appendChild(el('span', 'boot-failure-reason-d', d));
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  const actions = el('div', 'boot-failure-actions');
  const retry = el('button', 'primary boot-retry', '重试连接');
  retry.type = 'button';
  retry.setAttribute('aria-label', '重试连接本地服务');
  retry.onclick = async () => {
    retry.disabled = true; retry.textContent = '正在重连…';
    setStatus('正在重连本地服务…');
    try { await bootData(); } // 成功后 bootData 会重绘 #messages(会话/空状态),故障卡自然被替换
    catch (e) { renderBootFailure(e); }
  };
  actions.appendChild(retry);
  // 诊断面板:默认折叠;原始错误文本(可能含英文栈)只在这里出现。用 el/textContent 构建,永不 innerHTML。
  const panel = el('div', 'boot-failure-diag');
  panel.id = 'bootDiagPanel'; panel.hidden = true;
  panel.appendChild(el('pre', 'boot-failure-diag-pre', apiErrText(err) || '未知错误'));
  panel.appendChild(el('p', 'boot-failure-hint', '若多次重试仍失败：请关闭本页并重新启动如意工作台；仍不行时，把上面的技术详情反馈给维护者。'));
  const diag = el('button', 'ghost boot-diag', '查看日志 / 诊断');
  diag.type = 'button';
  diag.setAttribute('aria-controls', 'bootDiagPanel');
  diag.setAttribute('aria-expanded', 'false');
  diag.onclick = () => { panel.hidden = !panel.hidden; diag.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true'); };
  actions.appendChild(diag);
  wrap.appendChild(actions);
  wrap.appendChild(panel);
  return wrap;
}
function renderBootFailure(err) {
  try { setStatus('无法连接本地服务'); } catch { /* ignore */ }
  try { toast('无法连接本地服务，请点「重试连接」', 'err'); } catch { /* ignore */ }
  const box = $('messages');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(buildBootFailureCard(err));
  const retry = box.querySelector('.boot-retry');
  if (retry) setTimeout(() => { try { retry.focus(); } catch { /* ignore */ } }, 0);
}

/* ---------------- boot ---------------- */
async function boot() {
  hydrateIcons(); // UI v3 (§2.15): 把 index.html 静态 chrome 按钮/徽标的 [data-icon] 填充为内联 SVG
  bindEvents();
  applyTheme((() => { try { return localStorage.getItem('wcw.theme') || 'dark'; } catch { return 'dark'; } })());
  applyUiMode((() => { try { return localStorage.getItem('wcw.uiMode') || 'simple'; } catch { return 'simple'; } })()); // v0.9-S1 (C1) / v1.0.2 (F5): 默认 simple 对齐 server
  restoreSidebarCollapsed(); // v1.0.2 (F2): 恢复上次的折叠侧栏状态
  restoreRightWidth(); initRightResize(); // v3 (§2.7 P2): 恢复右栏三档宽 + 绑定拖拽手柄
  restoreMainView(); // v3 P3a: 恢复中栏主视图(对话/工作台)记忆
  try { const d = localStorage.getItem('wcw.draft'); if (d) { $('promptInput').value = d; autoGrow($('promptInput')); } } catch { /* ignore */ }
  await bootData();
}
// v1.5 (§1.3): boot 的「连本地服务 + 拉数据」段拆出成独立函数,供故障卡「重试连接」在不重跑 bindEvents
// (会重复绑 addEventListener)的前提下重试。任何一步抛错都冒泡给调用方(boot().catch / 重试处理)渲染故障卡。
async function bootData() {
  await refreshStatus();
  await refreshSessions();
  loadAgentWorkflows();
  refreshPlaybooks(); // v0.9-S2: load playbook cards for the empty state (best-effort, non-blocking)
  let last = null; try { last = localStorage.getItem('wcw.lastSession'); } catch { /* ignore */ }
  const target = state.sessions.find(s => s.id === last) || state.sessions[0];
  if (target) await openSession(target.id);
  // v1.0-S3 (A): no session to open (fresh install) → render the empty state now so the first-run 引导
  // variant appears deterministically (isFirstRun() reads the now-loaded sessions + config, not just the
  // best-effort playbook re-render).
  else renderCurrentSession();
  // v0.8-S2: PowerShell is the default-active tab, so start the shell-session poll now.
  updateShellPolling();
}
// v1.5 (§1.3): 首次连接本地服务失败 —— 不再只把英文错误塞进状态行 + toast,而是在对话区渲染显式故障卡
// (大标题 +「无法连接本地服务」+ 三条可能原因 +「重试连接」+「查看日志/诊断」)。主画像第一次翻车最狠的点。
boot().catch(err => renderBootFailure(err));

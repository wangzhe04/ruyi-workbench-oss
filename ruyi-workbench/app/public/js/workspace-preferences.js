'use strict';

// EC-D：主题、界面密度、工作区选择与最近工作区领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, toast } from './util.js';
import { t } from './i18n.js';

export function createWorkspacePreferencesDomain({
  apiErrText = error => String(error && error.message || error || ''),
  saveConfigPartial = async () => false,
  iconTextBtn = () => {},
  syncMoreMenuLabels = () => {},
  normalizeTabsForUiMode = () => {},
  newSession = async () => {},
  patchSession = async () => {},
  loadFileTree = async () => {},
  popover = () => null,
} = {}) {
function effectiveTheme(pref) {
  return pref === 'system'
    ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : (pref === 'light' ? 'light' : 'dark');
}
function themeOverrideFromUrl() {
  try {
    const value = new URLSearchParams(window.location.search).get('theme');
    return value === 'dark' || value === 'light' ? value : '';
  } catch { return ''; }
}
let _themeMediaWired = false;
function applyTheme(theme) {
  // Deterministic visual-regression entry point. It affects only this page load and never broadens the
  // persisted three-state preference contract.
  const forced = themeOverrideFromUrl();
  const pref = forced || (theme === 'light' || theme === 'system' ? theme : 'dark');
  const eff = effectiveTheme(pref);
  // v1.0.2 (F5): 同 applyUiMode —— 值未变不重写 data-theme,避免 config 到达后与预绘同值时的无谓重排。
  // 主题预绘(index.html)默认 'dark',与 server defaultConfig().theme 一致,新装机无闪;此处仅回写 localStorage。
  if (document.documentElement.getAttribute('data-theme') !== eff) document.documentElement.setAttribute('data-theme', eff);
  $('hljs-dark').disabled = eff !== 'dark';
  $('hljs-light').disabled = eff === 'dark';
  const tbtn = $('themeToggle');
  if (tbtn) {
    iconTextBtn(tbtn, pref === 'system' ? 'monitor' : 'theme', '');
    tbtn.title = t('navigation.switchTheme') + ' · ' + t('navigation.theme.' + pref);
    tbtn.setAttribute('aria-label', tbtn.title);
  }
  // system 档监听 OS 主题变更(注册一次;非 system 档变更时无害——applyTheme 只在 pref=system 时响应)。
  if (!_themeMediaWired && window.matchMedia) {
    _themeMediaWired = true;
    try {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        let cur = 'dark'; try { cur = localStorage.getItem('wcw.theme') || 'dark'; } catch { /* ignore */ }
        if (cur === 'system') applyTheme('system');
      });
    } catch { /* ignore */ }
  }
  if (!forced) { try { localStorage.setItem('wcw.theme', pref); } catch { /* ignore */ } }
}
function toggleTheme() {
  const cur = (() => { try { return localStorage.getItem('wcw.theme') || 'dark'; } catch { return 'dark'; } })();
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'system' : 'dark';
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
  { const tab = document.querySelector('.tool-pane .tool-tabs button[data-tab="agent-runs"]'); if (tab) tab.textContent = (m === 'simple' ? t('workflow.simpleTitle') : t('workflow.title')); }
  const btn = $('uiModeToggle');
  if (btn) {
    btn.textContent = m === 'simple' ? '🧸' : '🔧';
    btn.title = t(m === 'simple' ? 'navigation.switchToExpert' : 'navigation.switchToSimple');
    btn.setAttribute('aria-label', t('navigation.toggleUiMode'));
  }
  try { localStorage.setItem('wcw.uiMode', m); } catch { /* ignore */ }
  // v1.0-S2 (IA): 更新「⋯」菜单里的界面模式项文案（若菜单当前打开）。
  syncMoreMenuLabels();
  normalizeTabsForUiMode(m);
}
function toggleUiMode() {
  const next = document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 'pro' : 'simple';
  applyUiMode(next);
  if (state.config) state.config.uiMode = next;
  saveConfigPartial({ uiMode: next });
  toast(next === 'simple' ? t('toast.uiModeSimple') : t('toast.uiModeExpert'), 'ok');
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
  const short = full ? (full.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || full) : t('navigation.workbench');
  if (nameEl) nameEl.textContent = short;         // textContent → XSS-safe (paths are attacker-influenced)
  btn.title = full || t('workspace.select');
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
  } catch (e) { toast(t('workspace.switch.failed', { reason: apiErrText(e) }), 'err'); return; }
  pushRecentWorkspace(dir);
  if (alsoDefault) { state.config.defaultWorkspace = dir; saveConfigPartial({ defaultWorkspace: dir }); }
  renderWorkspacePicker();
  const treeTabActive = document.querySelector('.tool-pane .tool-tabs button[data-tab="files"]')?.classList.contains('active');
  if (treeTabActive) loadFileTree();
  toast(t('workspace.switch.success', { directory: dir }), 'ok');
}
// Native folder dialog → on success, switch the workspace. Shared by the picker popover's 浏览 button.
async function pickWorkspaceNative() {
  toast(t('workspace.picker.opening'), '');
  let r;
  try { r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
  catch (e) { toast(t('workspace.picker.failed', { reason: apiErrText(e) }), 'err'); return; }
  if (!r || !r.ok) { toast(t('workspace.picker.failed', { reason: `${(r && r.error) || t('common.unknown')}${r && r.hint ? ' (' + r.hint + ')' : ''}` }), 'err'); return; }
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
  if (!raw) { toast(t('workspace.pathRequired'), 'err'); input.focus(); return; }
  if (!looksAbsolutePath(raw)) { toast(t('workspace.pathAbsoluteRequired'), 'err'); input.focus(); return; }
  if (close) close();
  await setWorkspace(raw); // 现有链路带 cwd 护栏与人话警告;无效路径后端拒并 toast
}
function pickWorkspace() {
  const btn = $('workspacePicker'); if (!btn) return;
  popover(btn, close => {
    const wrap = el('div', 'wp-pop');
    const browse = el('button', 'wp-pop-browse', `📁 ${t('workspace.browse')}`); browse.type = 'button';
    browse.onclick = () => { close(); pickWorkspaceNative(); };
    wrap.append(browse);
    wrap.append(el('div', 'wp-pop-or', t('workspace.pastePath')));
    const row = el('div', 'wp-pop-row');
    const input = el('input', 'wp-pop-input'); input.type = 'text'; input.placeholder = t('workspace.pathPlaceholder');
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPastedWorkspace(input, close); } });
    const go = el('button', 'wp-pop-go', t('common.confirm')); go.type = 'button';
    go.onclick = () => submitPastedWorkspace(input, close);
    row.append(input, go);
    wrap.append(row);
    setTimeout(() => { browse.focus(); }, 0);
    return wrap;
  }, { placement: 'bottom-start' });
}

/* ---------------- sessions ---------------- */
  return Object.freeze({
    applyTheme,
    applyUiMode,
    currentWorkspace,
    pickWorkspace,
    pickWorkspaceNative,
    renderWorkspacePicker,
    setWorkspace,
    toggleTheme,
    toggleUiMode,
  });
}

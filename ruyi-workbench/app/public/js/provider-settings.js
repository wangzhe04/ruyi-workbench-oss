'use strict';

// EC-D：运行时引擎状态、Provider 配置、设置保存与诊断领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, escapeHtml, autoGrow, setStatus, toast } from './util.js';
import { getLocale, setLocale, t, tCount } from './i18n.js';

export function createProviderSettingsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  renderModelChip = () => {},
  updateAgentTeamButton = () => {},
  applyTheme = () => {},
  applyUiMode = () => {},
  renderWorkspacePicker = () => {},
  fetchCapabilities = async () => null,
  updateSkillBadge = () => {},
  buildEmptyState = () => null,
  popover = () => null,
  populateSubagentPreferenceSelects = () => {},
  buildModal = () => null,
  refreshSessions = async () => {},
  openSession = async () => {},
  switchTab = () => {},
  openToolPane = () => {},
  runTool = async () => {},
} = {}) {
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
  renderStatusLine();
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
  if (compactBtn) { compactBtn.classList.remove('hidden'); compactBtn.title = prov ? t('chat.compactContextProvider') : t('chat.compactContextClaude'); }
  // v1 技能体系: 「技能库」在两个引擎都可用(技能面板承载技能开关 + 命令 + Playbook),不再 Claude-only 隐藏。
  const skillBtn = $('skillBtn'); if (skillBtn) skillBtn.classList.remove('hidden');
  updateSkillBadge();
  updateAgentTeamButton();
  // A3: composer placeholder follows the active engine label.
  const ta = $('promptInput');
  if (ta) ta.placeholder = t('chat.placeholder');
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
      if (announce) toast(r.proxyCount ? tCount('modelMenu.refreshSuccessProxy', r.proxyCount) : t('modelMenu.refreshSuccessBuiltin'), 'ok');
    } else if (announce) { toast(t('modelMenu.refreshUnchanged'), ''); }
  } catch (e) { if (announce) toast(t('modelMenu.refreshFailed', { error: apiErrText(e) }), 'err'); }
}
// Keep the compact sidebar status line language-aware as well as engine-aware. It is invoked after
// status refreshes and on locale changes, rather than leaving a startup-language string behind.
function renderStatusLine() {
  if (isProviderMode()) {
    const p = activeProviderObj();
    const label = (p && (p.label || p.id)) || t('status.currentProvider');
    const model = (p && p.model) || currentModelId() || t('provider.defaultModel');
    setStatus(`${label} · ${model}`);
    return;
  }
  const ok = state.config?.claudePath || state.status?.detectedClaudePath;
  setStatus(ok ? `CLI: ${ok}` : t('status.claudeMissing'));
}
function populatePermSelect() {
  const sel = $('permSelect'); sel.innerHTML = '';
  for (const m of (state.status?.permissionModes || ['default','acceptEdits','plan','bypass'])) {
    const o = el('option'); o.value = m; o.textContent = permModeOption(m); if (m === state.config.permissionMode) o.selected = true; sel.appendChild(o);
  }
  sel.style.color = state.config.permissionMode === 'bypass' ? 'var(--danger)' : (state.config.permissionMode === 'auto' ? 'var(--accent)' : '');
  renderPermChip(); // v1.0-S2 (IA): keep the topbar 安全 chip in sync with the mode.
}

/* ---------------- v1.0-S2 (IA): 安全 chip + 安全弹层（四档单选卡） ---------------- */
// 每档：人话短名 + 一句场景描述；bypass 为警示样式。原始模式名（default/acceptEdits/…）在专家模式作小字。
const PERM_MODE_META = {
  default:     { optionKey: 'permission.mode.default.option', shortKey: 'permission.mode.default.short', descriptionKey: 'permission.mode.default.description' },
  acceptEdits: { optionKey: 'permission.mode.acceptEdits.option', shortKey: 'permission.mode.acceptEdits.short', descriptionKey: 'permission.mode.acceptEdits.description' },
  plan:        { optionKey: 'permission.mode.plan.option', shortKey: 'permission.mode.plan.short', descriptionKey: 'permission.mode.plan.description' },
  auto:        { optionKey: 'permission.mode.auto.option', shortKey: 'permission.mode.auto.short', descriptionKey: 'permission.mode.auto.description' },
  bypass:      { optionKey: 'permission.mode.bypass.option', shortKey: 'permission.mode.bypass.short', descriptionKey: 'permission.mode.bypass.description', danger: true },
};
function permModeText(mode, field) {
  const meta = PERM_MODE_META[mode];
  const key = meta && meta[`${field}Key`];
  return key ? t(key) : (mode || t('common.unknown'));
}
function permModeOption(mode) { return permModeText(mode, 'option'); }
function permModeShort(mode) { return permModeText(mode, 'short'); }
function permModeDescription(mode) {
  const meta = PERM_MODE_META[mode];
  return meta?.descriptionKey ? t(meta.descriptionKey) : '';
}
// Reflect the current permissionMode on the topbar 安全 chip: 人话短名 + bypass 警示着色（沿用 bypass 红色心智）。
function renderPermChip() {
  const chip = $('permChip'); if (!chip) return;
  const mode = state.config.permissionMode || 'default';
  const nameEl = chip.querySelector('.pc-name');
  if (nameEl) nameEl.textContent = permModeShort(mode); // textContent → 人话短名，XSS 安全
  chip.classList.toggle('warn', mode === 'bypass');
  chip.classList.toggle('info', mode === 'auto');
  chip.title = t('permission.mode.chipTitle', { mode: permModeShort(mode) });
}
// 安全弹层：只展示一套单选卡（枚举来自 state.status.permissionModes）。点击卡片 =
// 设置 permSelect.value + dispatch('change')，完全复用既有 onchange（持久化 / bypass 确认 / toast 全部白拿）。
// 隐藏的 permSelect 只作为状态/事件载体，不再形成第二套可见选择器。DOM 全 createElement/textContent 构建。
function openPermPopover(anchor) {
  // Keep one permission selector, but allow Preview to anchor it to its visible safety fact.
  // Classic's direct onclick supplies a MouseEvent, which intentionally uses the legacy chip.
  const chip = anchor && anchor.nodeType === 1 ? anchor : $('permChip'); if (!chip) return;
  const pro = document.documentElement.getAttribute('data-ui-mode') !== 'simple';
  popover(chip, close => {
    const wrap = el('div', 'perm-pop');
    wrap.appendChild(el('h4', null, t('permission.mode.title')));
    const cards = el('div', 'perm-cards'); cards.setAttribute('role', 'radiogroup');
    const modes = (state.status && state.status.permissionModes) || ['default', 'acceptEdits', 'plan', 'bypass'];
    const cur = state.config.permissionMode || 'default';
    modes.forEach(mode => {
      const meta = PERM_MODE_META[mode];
      const card = el('button', 'perm-card' + (meta?.danger ? ' danger' : '') + (mode === cur ? ' active' : ''));
      card.type = 'button'; card.setAttribute('role', 'radio'); card.setAttribute('aria-checked', mode === cur ? 'true' : 'false');
      const top = el('div', 'perm-card-top');
      top.append(el('span', 'perm-card-radio', mode === cur ? '◉' : '○'), el('span', 'perm-card-short', permModeShort(mode)));
      card.appendChild(top);
      card.appendChild(el('div', 'perm-card-desc', permModeDescription(mode)));
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
    // 信任脚注。
    wrap.appendChild(el('div', 'perm-pop-foot', t('permission.mode.footer')));
    return wrap;
  });
}
async function saveConfigPartial(patch) {
  try {
    const res = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    state.config = res.config;
    return true;
  } catch (e) {
    toast(t("toast.saveFail", { p1: apiErrText(e) }), 'err');
    return false;
  }
}

/* 第61波：Agent 角色设置与子代理偏好选择已拆入 ./js/agent-roles.js。 */
function fillSettings() {
  const c = state.config;
  updateAgentTeamButton();
  $('workspaceInput').value = c.defaultWorkspace || '';
  { const el0 = $('cfgLocale'); if (el0) el0.value = ['auto', 'zh-CN', 'en-US'].includes(c.locale) ? c.locale : 'auto'; }
  { const el0 = $('cfgUiMode'); if (el0) el0.value = (c.uiMode === 'simple' ? 'simple' : 'pro'); } // v0.9-S1
  { const el0 = $('cfgOutputStyle'); if (el0) el0.value = (c.outputStyle === 'concise' ? 'concise' : 'detailed'); } // v0.9-S1
  $('claudePathInput').value = c.claudePath || state.status?.detectedClaudePath || '';
  $('cfgPartial').checked = !!c.includePartialMessages;
  $('cfgBeta').checked = !!c.betaInterleavedThinking;
  $('cfgResume').checked = !!c.autoResumeClaudeSessions;
  $('cfgKillDisc').checked = !!c.killOnDisconnect;
  { const el0 = $('cfgThinkingEffort'); if (el0) el0.value = ['', 'low', 'medium', 'high', 'xhigh', 'max'].includes(c.claudeThinkingEffort) ? c.claudeThinkingEffort : ''; }
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
  { const el0 = $('cfgToolLoadingMode'); if (el0) el0.value = c.toolLoadingMode === 'full' ? 'full' : 'auto'; }
  // v1.6.3: 普通任务基础工具预算 (1..200, 默认 100；长任务可自动续到硬上限 300)。
  { const el0 = $('cfgOpenaiMaxToolIterations'); if (el0) el0.value = Number.isFinite(Number(c.openaiMaxToolIterations)) && c.openaiMaxToolIterations ? c.openaiMaxToolIterations : 100; }
  { const el0 = $('cfgSubagentMaxConcurrent'); if (el0) el0.value = Math.max(1, Math.min(8, Number(c.subagentMaxConcurrent) || 8)); }
  { const el0 = $('cfgSubagentMaxPerTurn'); if (el0) el0.value = Math.max(0, Math.min(32, Number.isFinite(Number(c.subagentMaxPerTurn)) ? Number(c.subagentMaxPerTurn) : 32)); }
  populateSubagentPreferenceSelects(c.subagentPreferredProvider, c.subagentPreferredModel);
  { const el0 = $('cfgAgentWorkflowMaxNodes'); if (el0) el0.value = Math.max(1, Math.min(64, Number(c.agentWorkflowMaxNodes) || 48)); }
  { const el0 = $('cfgAgentNodeWrapUpMinutes'); if (el0) el0.value = Math.max(0, Math.min(120, Math.round((Number(c.agentNodeWrapUpMs) || 0) / 60000))); }
  // v0.7d: integrations / MCP tab.
  const dm = c.desktopMcp || {};
  const dmEn = $('cfgDesktopMcpEnabled'); if (dmEn) dmEn.checked = dm.enabled !== false;
  const dmCmd = $('cfgDesktopMcpCommand'); if (dmCmd) dmCmd.value = dm.command || '';
  const dmArgs = $('cfgDesktopMcpArgs'); if (dmArgs) dmArgs.value = (dm.args || []).join('\n');
  const dmCwd = $('cfgDesktopMcpCwd'); if (dmCwd) dmCwd.value = dm.cwd || '';
  const browser = c.browserAutomation || {};
  { const el0 = $('cfgBrowserMode'); if (el0) el0.value = ['system', 'managed', 'custom', 'cdp', 'bundled'].includes(browser.mode) ? browser.mode : 'system'; }
  { const el0 = $('cfgBrowserExecutable'); if (el0) el0.value = browser.executable || ''; }
  { const el0 = $('cfgBrowserCdpUrl'); if (el0) el0.value = browser.cdpUrl || 'http://127.0.0.1:9222'; }
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
    if (!info || info.enabled === false) dmStat.textContent = t('mcp.notEnabled');
    else if (info.resolved && info.resolved.command) dmStat.textContent = t('mcp.desktopFound') + info.resolved.command + (info.resolved.args && info.resolved.args.length ? ' ' + info.resolved.args.join(' ') : '');
    else if (info.detected && info.detected.command) dmStat.textContent = t('mcp.probed') + info.detected.command + (info.detected.args && info.detected.args.length ? ' ' + info.detected.args.join(' ') : '');
    else dmStat.textContent = t('mcp.notFound');
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
    if (lbl) lbl.textContent = optionalBase ? t('mcp.baseUrl') : 'Base URL';
  }
  if (keyRow) keyRow.classList.toggle('hidden', !showKey);
}
async function saveSettings() {
  const requestedLocale = $('cfgLocale')?.value || state.config.locale || 'auto';
  const resolvedLocale = await setLocale(requestedLocale);
  const patch = {
    defaultWorkspace: $('workspaceInput').value.trim(),
    locale: resolvedLocale,
    uiMode: $('cfgUiMode') ? $('cfgUiMode').value : (state.config.uiMode || 'pro'),           // v0.9-S1 (C1)
    outputStyle: $('cfgOutputStyle') ? $('cfgOutputStyle').value : (state.config.outputStyle || 'detailed'), // v0.9-S1 (C1)
    claudePath: $('claudePathInput').value.trim(),
    includePartialMessages: $('cfgPartial').checked,
    betaInterleavedThinking: $('cfgBeta').checked,
    autoResumeClaudeSessions: $('cfgResume').checked,
    killOnDisconnect: $('cfgKillDisc').checked,
    claudeThinkingEffort: $('cfgThinkingEffort') ? $('cfgThinkingEffort').value : (state.config.claudeThinkingEffort || ''),
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
    toolLoadingMode: $('cfgToolLoadingMode') ? $('cfgToolLoadingMode').value : (state.config.toolLoadingMode || 'auto'),
    // v1.6.3: 普通任务基础预算夹到 1..200；后端负责长任务与按进展续额。
    openaiMaxToolIterations: (() => {
      const el0 = $('cfgOpenaiMaxToolIterations');
      if (!el0) return state.config.openaiMaxToolIterations || 100;
      const n = Math.round(Number(el0.value));
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(200, n));
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
    subagentPreferredProvider: (() => { const el0 = $('cfgSubagentPreferredProvider'); return String(el0 ? el0.value : state.config.subagentPreferredProvider || '').trim().slice(0, 120); })(),
    subagentPreferredModel: (() => { const el0 = $('cfgSubagentPreferredModel'); return String(el0 ? el0.value : state.config.subagentPreferredModel || '').trim().slice(0, 160); })(),
    agentWorkflowMaxNodes: (() => {
      const el0 = $('cfgAgentWorkflowMaxNodes');
      const n = Math.round(Number(el0 ? el0.value : state.config.agentWorkflowMaxNodes));
      return Number.isFinite(n) ? Math.max(1, Math.min(64, n)) : 48;
    })(),
    agentNodeWrapUpMs: (() => {
      const el0 = $('cfgAgentNodeWrapUpMinutes');
      const n = Math.round(Number(el0 ? el0.value : (Number(state.config.agentNodeWrapUpMs) || 0) / 60000));
      return Number.isFinite(n) ? Math.max(0, Math.min(120, n)) * 60000 : 480000;
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
    browserAutomation: {
      mode: $('cfgBrowserMode') ? $('cfgBrowserMode').value : 'system',
      executable: $('cfgBrowserExecutable') ? $('cfgBrowserExecutable').value.trim() : '',
      cdpUrl: $('cfgBrowserCdpUrl') ? $('cfgBrowserCdpUrl').value.trim() : 'http://127.0.0.1:9222',
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
  if (!await saveConfigPartial(patch)) return;
  $('settingsStatus').textContent = `${t('common.saved')} ✓`;
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
  toast(t("toast.presetApplied", { p1: preset.label, p2: preset.defaultModelHint ? t('toast.presetHint', { m: preset.defaultModelHint }) : '' }), 'ok');
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
    // v1.7: DeepSeek 预设模板带 apiStyle:'responses'(走官方新增的 Responses API, Codex/agent 工具循环)。
    // 其它预设不带 → providerCard 里默认 chat, 行为与旧版完全一致。
    ...(preset.apiStyle ? { apiStyle: preset.apiStyle } : {}),
    // v1.8.2: DeepSeek 预设声明 serverWebSearch:true(Responses 服务端 web_search)。
    // 透传进草稿,否则从 UI 添加的 DeepSeek 会静默退化为本地搜索保底(后端 sanitize 兜底默认 false)。
    ...(preset.serverWebSearch ? { serverWebSearch: true } : {}),
  });
  renderProviders();
}
// Provider 单价编辑器的受控币种清单；属于设置写模型，不随只读用量看板迁移。
const PRICING_CURRENCIES = ['CNY', 'USD', 'EUR', 'GBP', 'JPY'];
// 对抗轮(critic B):prov-cap 折叠分组的 open 状态记忆。renderProviders 全量 innerHTML='' 重建会丢
// open 状态(旧头部开关常驻可见,无此问题;收进折叠组后,locale 切换/加卡/删卡/测连都会整组收起)。
// 用 provider id 作键的模块级 Map,重绘后恢复 —— 不入 draft、不入库,纯 UI 状态。
const providerCapOpen = new Map();
function renderProviders() {
  const box = $('providersList'); if (!box) return;
  box.innerHTML = '';
  const list = state.providersDraft || [];
  if (!list.length) { box.appendChild(el('div', 'muted', t('provider.empty'))); return; }
  list.forEach((p, idx) => box.appendChild(providerCard(p, idx)));
}
function providerCard(p, idx) {
  const card = el('div', 'prov-card');
  const head = el('div', 'prov-head');
  const labelIn = el('input', 'prov-label'); labelIn.value = p.label || ''; labelIn.placeholder = t('provider.displayNamePlaceholder'); labelIn.oninput = () => { p.label = labelIn.value; };
  const idTag = el('span', 'prov-id', p.id);
  const modChip = el('span', 'prov-modct', tCount('provider.modelCount', (p.models || []).length));
  const testBtn = el('button', 'file-label', t('provider.testConnection')); testBtn.type = 'button'; testBtn.onclick = () => testProvider(idx, testBtn);
  const delBtn = el('button', 'file-label prov-del', t('common.delete')); delBtn.type = 'button';
  // A6: deleting a provider also drops its API key — confirm so a misclick can't silently lose it.
  // 对抗轮(reverify A):删卡时清 providerCapOpen 记忆,避免 id 复用时新卡继承旧卡折叠状态。
  delBtn.onclick = () => { if (!confirm(t('provider.deleteConfirm', { name: p.label || p.id }))) return; state.providersDraft.splice(idx, 1); providerCapOpen.delete(p.id); renderProviders(); };
  head.append(labelIn, idTag, modChip, testBtn, delBtn);

  // v1.8.2 重构:把零散的「协议与能力」开关(reasoning / vision / apiStyle / serverWebSearch)从头部收进
  // 一个折叠分组,头部只留身份 + 操作按钮。原有文本模式( p.vision = / checked = !!p.vision / t('provider.vision')
  // / card.append(...priceB) )全部保留,不破坏前端契约断言。
  const cap = el('details', 'prov-cap'); cap.append(el('summary', '', t('provider.capabilities')));
  // 对抗轮(critic B):重绘后恢复 open 状态;toggle 时写入记忆 Map(按 provider id)。
  if (providerCapOpen.get(p.id)) cap.open = true;
  cap.addEventListener('toggle', () => providerCapOpen.set(p.id, cap.open));
  const reason = el('label', 'check prov-reason'); const rc = el('input'); rc.type = 'checkbox'; rc.checked = !!p.reasoning; rc.onchange = () => { p.reasoning = rc.checked; };
  reason.appendChild(rc); reason.appendChild(document.createTextNode(' ' + t('provider.reasoning')));
  // v1.7: protocol 选择 — chat (Chat Completions, 默认) / responses (OpenAI Responses API, DeepSeek
  // Codex/agent 场景官方新增端点)。存 p.apiStyle;后端 sanitizeProvider 归一为 'chat'|'responses'。
  const styleLbl = el('label', 'check prov-style'); styleLbl.appendChild(document.createTextNode(' ' + t('provider.apiStyle') + ' '));
  const sc = el('select'); sc.className = 'prov-style-select';
  for (const [val, key] of [['chat', 'provider.apiStyle.chat'], ['responses', 'provider.apiStyle.responses']]) {
    const o = el('option'); o.value = val; o.textContent = t(key); sc.appendChild(o);
  }
  sc.value = p.apiStyle === 'responses' ? 'responses' : 'chat';
  // v1.8.2: 协议与能力联动 —— 只有 responses 才可能用服务端 web_search;切回 chat 自动隐藏该开关。
  // 对抗轮(critic C):sync 只做【显隐 + 视觉 uncheck】,绝不 delete p.serverWebSearch —— 否则渲染期
  // (locale 切换/加卡/测连触发 renderProviders)会静默丢弃用户已勾选的意图,responses→chat→responses
  // 往返后已持久化的 true 会被降为 false。删除语义只发生在用户显式切换协议时(sc.onchange 里 delete)。
  const serverSearchLbl = el('label', 'check prov-server-search');
  const ssc = el('input'); ssc.type = 'checkbox'; ssc.checked = !!p.serverWebSearch;
  const syncServerSearchVisibility = () => {
    const isResponses = sc.value === 'responses';
    serverSearchLbl.style.display = isResponses ? '' : 'none';
    if (!isResponses) ssc.checked = false; // 视觉 uncheck;字段留给显式用户操作
    // 对抗轮(reverify B):responses 时让显示镜像字段(外部手编 chat+true 切到 responses 时,显示与落盘一致)。
    else ssc.checked = !!p.serverWebSearch;
  };
  sc.onchange = () => { if (sc.value === 'responses') p.apiStyle = 'responses'; else { delete p.apiStyle; delete p.serverWebSearch; } syncServerSearchVisibility(); };
  styleLbl.appendChild(sc);
  // 对抗轮(P2-2):协议选择下的帮助文字(解释 Responses API 适用场景 + 其它服务商无 /v1/responses 的警告),
  // 由双 locale 的 provider.apiStyle.hint 提供;此前该键定义了但 UI 从不渲染(死键)。
  const styleHint = el('p', 'field-help muted prov-style-hint'); styleHint.textContent = t('provider.apiStyle.hint');
  styleLbl.appendChild(styleHint);
  // v1.0-S3 (B2): per-provider vision 开关（能力矩阵/视觉回路读 provider.vision）。同 reasoning 开关的模式。
  const visionLbl = el('label', 'check prov-reason'); const vc = el('input'); vc.type = 'checkbox'; vc.checked = !!p.vision; vc.onchange = () => { p.vision = vc.checked; };
  visionLbl.appendChild(vc); visionLbl.appendChild(document.createTextNode(' ' + t('provider.vision')));
  // v1.8.2: serverWebSearch —— 仅 DeepSeek Responses 端点支持服务端 web_search({type:'web_search'})。
  // 开启后 web_search 由服务端执行(更省一轮往返);关闭/不支持时自动回退本地内置搜索(builtin/searxng/…)。
  ssc.onchange = () => { p.serverWebSearch = ssc.checked; };
  serverSearchLbl.appendChild(ssc); serverSearchLbl.appendChild(document.createTextNode(' ' + t('provider.serverWebSearch')));
  const serverSearchHint = el('p', 'field-help muted prov-server-search-hint'); serverSearchHint.textContent = t('provider.serverWebSearch.hint');
  serverSearchLbl.appendChild(serverSearchHint);
  cap.append(reason, visionLbl, styleLbl, serverSearchLbl);
  syncServerSearchVisibility();

  const b2 = el('div', 'field-block'); b2.append(el('label', '', 'Base URL'));
  const bi = el('input'); bi.type = 'text'; bi.value = p.baseUrl || ''; bi.placeholder = 'https://api.deepseek.com'; bi.oninput = () => { p.baseUrl = bi.value.trim(); }; b2.append(bi);

  const grid = el('div', 'field-grid');
  const kb = el('div', 'field-block'); kb.append(el('label', '', t('provider.apiKey')));
  const keyWrap = el('div', 'prov-key-wrap');
  const ki = el('input'); ki.type = 'password'; ki.autocomplete = 'off'; ki.value = p.apiKey || ''; ki.placeholder = 'sk-...'; ki.oninput = () => { p.apiKey = ki.value; };
  const eye = el('button', 'prov-key-eye', '👁'); eye.type = 'button'; eye.title = t('provider.toggleApiKeyVisibility');
  eye.onclick = () => { const show = ki.type === 'password'; ki.type = show ? 'text' : 'password'; eye.classList.toggle('on', show); };
  keyWrap.append(ki, eye); kb.append(keyWrap);
  const mb = el('div', 'field-block'); mb.append(el('label', '', t('provider.model')));
  const mi = el('input'); mi.type = 'text'; mi.value = p.model || ''; mi.placeholder = 'deepseek-chat'; mi.setAttribute('list', `provModels_${idx}`); mi.oninput = () => { p.model = mi.value.trim(); };
  const dl = el('datalist'); dl.id = `provModels_${idx}`; for (const m of (p.models || [])) { const o = el('option'); o.value = m.id; o.textContent = m.label || m.id; dl.appendChild(o); }
  mb.append(mi, dl); grid.append(kb, mb);

  // v1.0.2 (G5b): 上下文窗口手动覆盖(留空=自动检测)。其下小字显示当前生效值(仅当前激活 provider 有,取
  // /api/status.contextWindowResolved),source 人话映射。空串保存时删该字段(providerCard 写 p.contextWindow)。
  const cwB = el('div', 'field-block'); cwB.append(el('label', '', t('provider.contextWindow')));
  const cwi = el('input'); cwi.type = 'text'; cwi.value = (p.contextWindow === 0 || p.contextWindow) ? String(p.contextWindow) : '';
  cwi.placeholder = t('provider.autoDetect');
  cwi.oninput = () => { const v = cwi.value.trim(); if (v === '') { delete p.contextWindow; } else { const n = Math.round(Number(v)); p.contextWindow = Number.isFinite(n) ? n : ''; } };
  cwB.append(cwi);
  cwB.append(contextResolvedHint(p));

  // Provider 默认价 + 精确模型覆盖。缓存命中价留空时后端按普通输入价保守估算。
  const priceB = el('div', 'field-block prov-pricing');
  priceB.append(el('label', '', t('provider.pricing.title')));
  const pr = p.pricing || {};
  const pgrid = el('div', 'prov-pricing-grid');
  const inCell = el('label', 'prov-pricing-cell'); inCell.append(el('span', 'prov-pricing-cap', t('provider.pricing.inputPerM')));
  const inI = el('input'); inI.type = 'number'; inI.min = '0'; inI.step = '0.01'; inI.placeholder = t('provider.pricing.inputPlaceholder'); inI.value = (pr.inputPerM === 0 || pr.inputPerM) ? String(pr.inputPerM) : ''; inCell.append(inI);
  const cachedCell = el('label', 'prov-pricing-cell'); cachedCell.append(el('span', 'prov-pricing-cap', t('provider.pricing.cachedInputPerM')));
  const cachedI = el('input'); cachedI.type = 'number'; cachedI.min = '0'; cachedI.step = '0.01'; cachedI.placeholder = t('provider.pricing.cachedPlaceholder'); cachedI.value = (pr.cachedInputPerM === 0 || pr.cachedInputPerM) ? String(pr.cachedInputPerM) : ''; cachedCell.append(cachedI);
  const outCell = el('label', 'prov-pricing-cell'); outCell.append(el('span', 'prov-pricing-cap', t('provider.pricing.outputPerM')));
  const outI = el('input'); outI.type = 'number'; outI.min = '0'; outI.step = '0.01'; outI.placeholder = t('provider.pricing.outputPlaceholder'); outI.value = (pr.outputPerM === 0 || pr.outputPerM) ? String(pr.outputPerM) : ''; outCell.append(outI);
  const curCell = el('label', 'prov-pricing-cell'); curCell.append(el('span', 'prov-pricing-cap', t('provider.pricing.currency')));
  const curSel = el('select'); for (const code of PRICING_CURRENCIES) { const o = el('option'); o.value = code; o.textContent = t('settings.currency.' + code); curSel.appendChild(o); } curSel.value = pr.currency || 'CNY'; curCell.append(curSel);
  pgrid.append(inCell, cachedCell, outCell, curCell); priceB.append(pgrid);
  priceB.append(el('p', 'field-help muted', t('provider.pricing.help')));

  const modelPricing = el('details', 'prov-model-pricing');
  const modelSummary = el('summary', '', '');
  const modelSummaryLabel = el('span', '', t('provider.pricing.modelOverrides'));
  const modelSummaryCount = el('span', 'prov-model-pricing-count', '0');
  modelSummary.append(modelSummaryLabel, modelSummaryCount);
  const modelHelp = el('p', 'field-help muted', t('provider.pricing.modelHelp'));
  const modelRows = el('div', 'prov-model-pricing-rows');
  const addModelPrice = el('button', 'file-label prov-model-pricing-add', t('provider.pricing.addModel')); addModelPrice.type = 'button';
  modelPricing.append(modelSummary, modelHelp, modelRows, addModelPrice);
  priceB.append(modelPricing);

  const initialModelPrices = Array.isArray(pr.models) ? pr.models.map(row => ({ ...row })) : [];
  const rateValue = input => {
    const value = input.value.trim();
    const number = Number(value);
    return value !== '' && Number.isFinite(number) ? Math.max(0, number) : null;
  };
  const syncPricing = () => {
    const inputPrice = rateValue(inI), cachedPrice = rateValue(cachedI), outputPrice = rateValue(outI);
    const models = [...modelRows.querySelectorAll('.prov-model-price-row')].map(row => {
      const model = String(row.querySelector('[data-model-price-model]')?.value || '').trim();
      const inputPerM = rateValue(row.querySelector('[data-model-price-input]'));
      const cachedInputPerM = rateValue(row.querySelector('[data-model-price-cached]'));
      const outputPerM = rateValue(row.querySelector('[data-model-price-output]'));
      if (!model || (inputPerM == null && cachedInputPerM == null && outputPerM == null)) return null;
      return { model, ...(inputPerM == null ? {} : { inputPerM }), ...(cachedInputPerM == null ? {} : { cachedInputPerM }), ...(outputPerM == null ? {} : { outputPerM }) };
    }).filter(Boolean);
    modelSummaryCount.textContent = String(models.length);
    if (inputPrice == null && cachedPrice == null && outputPrice == null && !models.length) { delete p.pricing; return; }
    p.pricing = {
      ...(inputPrice == null ? {} : { inputPerM: inputPrice }),
      ...(cachedPrice == null ? {} : { cachedInputPerM: cachedPrice }),
      ...(outputPrice == null ? {} : { outputPerM: outputPrice }),
      currency: curSel.value || 'CNY',
      ...(models.length ? { models } : {}),
    };
  };
  const appendModelPriceRow = (value = {}) => {
    const row = el('div', 'prov-model-price-row');
    const modelInput = el('input'); modelInput.type = 'text'; modelInput.placeholder = t('provider.pricing.modelPlaceholder'); modelInput.value = value.model || ''; modelInput.setAttribute('list', `provModels_${idx}`); modelInput.dataset.modelPriceModel = 'true';
    const rowInput = el('input'); rowInput.type = 'number'; rowInput.min = '0'; rowInput.step = '0.01'; rowInput.placeholder = t('provider.pricing.inputShort'); rowInput.value = value.inputPerM === 0 || value.inputPerM ? String(value.inputPerM) : ''; rowInput.dataset.modelPriceInput = 'true';
    const rowCached = el('input'); rowCached.type = 'number'; rowCached.min = '0'; rowCached.step = '0.01'; rowCached.placeholder = t('provider.pricing.cachedShort'); rowCached.value = value.cachedInputPerM === 0 || value.cachedInputPerM ? String(value.cachedInputPerM) : ''; rowCached.dataset.modelPriceCached = 'true';
    const rowOutput = el('input'); rowOutput.type = 'number'; rowOutput.min = '0'; rowOutput.step = '0.01'; rowOutput.placeholder = t('provider.pricing.outputShort'); rowOutput.value = value.outputPerM === 0 || value.outputPerM ? String(value.outputPerM) : ''; rowOutput.dataset.modelPriceOutput = 'true';
    const remove = el('button', 'prov-model-price-remove', '×'); remove.type = 'button'; remove.title = t('provider.pricing.removeModel'); remove.setAttribute('aria-label', remove.title);
    for (const input of [modelInput, rowInput, rowCached, rowOutput]) input.oninput = syncPricing;
    remove.onclick = () => { row.remove(); syncPricing(); };
    row.append(modelInput, rowInput, rowCached, rowOutput, remove); modelRows.appendChild(row);
  };
  for (const row of initialModelPrices) appendModelPriceRow(row);
  addModelPrice.onclick = () => { appendModelPriceRow({ model: p.model || '' }); modelPricing.open = true; modelRows.lastElementChild?.querySelector('input')?.focus(); syncPricing(); };
  inI.oninput = syncPricing; cachedI.oninput = syncPricing; outI.oninput = syncPricing; curSel.onchange = syncPricing;
  modelSummaryCount.textContent = String(initialModelPrices.length);

  const adv = el('details', 'prov-adv'); adv.append(el('summary', '', t('provider.advanced')));
  const sb = el('div', 'field-block'); sb.append(el('label', '', t('provider.systemPrompt')));
  const st = el('textarea'); st.rows = 2; st.value = p.systemPrompt || ''; st.oninput = () => { p.systemPrompt = st.value; }; sb.append(st);
  const tb = el('div', 'field-block'); tb.append(el('label', '', t('provider.temperature')));
  const ti = el('input'); ti.type = 'text'; ti.value = (p.temperature === 0 || p.temperature) ? String(p.temperature) : ''; ti.placeholder = t('provider.temperaturePlaceholder');
  ti.oninput = () => { const v = ti.value.trim(); p.temperature = v === '' ? '' : (Number.isFinite(Number(v)) ? Number(v) : ''); }; tb.append(ti);
  // v1.0-S6 (B4): 备用端点（每行一个，最多 3）。主端点「预首字节」失败（连不上 / 502·503·504）时按顺序切换。
  // 读写 p.extraBaseUrls，空行过滤；后端 sanitizeProvider 会再做 trim/去重/去主端点/截断≤3 的清洗。
  const eb = el('div', 'field-block'); eb.append(el('label', '', t('provider.backupEndpoints')));
  const eti = el('textarea'); eti.rows = 2; eti.placeholder = 'https://backup1.example.com\nhttps://backup2.example.com';
  eti.value = Array.isArray(p.extraBaseUrls) ? p.extraBaseUrls.join('\n') : '';
  eti.oninput = () => { p.extraBaseUrls = eti.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 3); }; eb.append(eti);
  adv.append(sb, tb, eb);

  const status = el('div', 'prov-status muted'); status.id = `provStatus_${idx}`;
  card.append(head, cap, b2, grid, cwB, priceB, adv, status);
  return card;
}
// v1.0.2 (G5b): 「当前生效」小字。仅当此 provider 是当前激活引擎时,从 /api/status.contextWindowResolved 取
// 生效值 + 来源。source 人话:manual=手动 / probe=接口探测 / table=内置表 / fallback=保守默认。非激活 provider
// 或无数据时给一句静态说明(手动填的值下一次该引擎生效时才会体现在这里)。返回一个 .prov-ctx-hint 元素。
const CTX_SOURCE_KEY = { manual: 'provider.contextSource.manual', probe: 'provider.contextSource.probe', table: 'provider.contextSource.table', fallback: 'provider.contextSource.fallback' };
function contextResolvedHint(p) {
  const hint = el('div', 'prov-ctx-hint muted');
  const r = state.status && state.status.contextWindowResolved;
  if (r && r.provider && p && r.provider === p.id && Number(r.value) > 0) {
    const src = t(CTX_SOURCE_KEY[r.source] || 'provider.contextSource.unknown');
    hint.textContent = t('provider.contextResolved', { value: Number(r.value).toLocaleString(getLocale()), source: src });
  } else {
    hint.textContent = t('provider.contextAutoHint');
  }
  return hint;
}
async function testProvider(idx, btn) {
  const p = state.providersDraft[idx]; if (!p) return;
  const status = $(`provStatus_${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = t('provider.testing'); }
  try {
    const r = await api('/api/provider/test', { method: 'POST', body: JSON.stringify({ provider: p }) });
    if (r && r.ok) {
      if (Array.isArray(r.models) && r.models.length) p.models = r.models;
      if (status) { status.textContent = tCount('provider.testSuccess', r.models ? r.models.length : 0); status.classList.remove('bad'); status.classList.add('good'); }
      renderProviders();
    } else if (status) { status.textContent = `✗ ${(r && r.error) || t('provider.testFailure')}`; status.classList.remove('good'); status.classList.add('bad'); }
  } catch (e) { if (status) { status.textContent = `✗ ${apiErrText(e)}`; status.classList.add('bad'); } }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('provider.testConnection'); } }
}

// v1.0.2 (G5c): 从文件夹导入外部 MCP。POST /api/pick-folder(原生选择器)→ 取 path → POST /api/mcp/import-folder。
// 成功 toast「已添加/已更新 <label|id>」+ 刷新状态(refreshStatus 会重拉 config → fillSettings)。失败且响应
// 带 template 时弹说明 modal(可复制的模板 JSON,textContent 渲染)。
async function importMcpFromFolder(btn) {
  if (btn) { btn.disabled = true; }
  let pf;
  try { pf = await api('/api/pick-folder', { method: 'POST', body: '{}' }); }
  catch (e) { toast(t("toast.error", { p1: apiErrText(e) }), 'err'); if (btn) btn.disabled = false; return; }
  if (!pf || !pf.ok) { toast(t('toast.pickerOpenFail', { err: (pf && pf.error) || t('common.unknownError') }), 'err'); if (btn) btn.disabled = false; return; }
  if (pf.cancelled || !pf.path) { if (btn) btn.disabled = false; return; } // user backed out
  try {
    const r = await api('/api/mcp/import-folder', { method: 'POST', body: JSON.stringify({ path: pf.path }) });
    if (r && r.ok) {
      const srv = r.server || {};
      const name = srv.label || srv.id || t('mcp.external');
      toast((r.updated ? t('mcp.updated') : t('mcp.added')) + name, 'ok');
      await refreshStatus(); // re-pull config → fillSettings re-seeds the integrations view
    } else {
      // 缺少/无效清单 → 弹模板说明 modal(若响应带 template);否则纯 toast。
      if (r && r.template) showMcpTemplateModal(r.error || t('mcp.missingManifest'), r.template);
      else toast(t('toast.importFail', { err: (r && r.error) || t('common.unknownError') }), 'err');
    }
  } catch (e) {
    toast(t('toast.importFail', { err: apiErrText(e) }), 'err');
  } finally { if (btn) btn.disabled = false; }
}
// v1.0.2 (G5c): 缺清单说明 modal。展示可复制的 ruyi-mcp.json 模板(textContent — 绝不 innerHTML 拼接)。
function showMcpTemplateModal(reason, template) {
  const body = el('div', 'mcp-tpl-body');
  body.append(el('p', 'mcp-tpl-reason', reason));
  body.append(el('p', 'muted', t('mcp.createManifestHint')));
  const preWrap = el('div', 'mcp-tpl-pre-wrap');
  const pre = el('pre', 'mcp-tpl-pre');
  let tplText = '';
  try { tplText = JSON.stringify(template, null, 2); } catch { tplText = String(template); }
  pre.textContent = tplText; // XSS: textContent, never innerHTML
  const copyBtn = el('button', 'mini mcp-tpl-copy', t('common.copy'));
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(tplText); copyBtn.textContent = t('common.copied'); setTimeout(() => { copyBtn.textContent = '复制'; }, 1500); }
    catch { toast(t("toast.copyFail"), 'err'); }
  };
  preWrap.append(copyBtn, pre);
  body.append(preWrap);
  const foot = el('div', 'confirm-foot');
  const ok = el('button', 'primary', t('common.gotIt'));
  foot.append(ok);
  const m = buildModal(t('mcp.missingManifestTitle'), body, foot);
  ok.onclick = () => m.close();
}

/* ---------------- doctor ---------------- */
function renderDoctor() {
  const panel = $('doctorPanel'); if (!panel) return;
  panel.innerHTML = '';
  const s = state.status;
  panel.appendChild(healthRow(true, t('common.version'), `v${s.version} · 启动=${s.launchMode} · overlay=${s.overlayId}`));
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
  if (!s) { toast(t("toast.openSessionFirst"), 'err'); return; }
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
      const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title: (data.title || file.name) + t('session.imported'), cwd: data.cwd || '', messages }) });
      await refreshSessions(); await openSession(res.session.id); toast(t("toast.sessionImported"), 'ok');
    } catch (e) { toast(t('toast.importFail', { err: apiErrText(e) }), 'err'); }
  };
  inp.click();
}
function getTemplates() { try { return JSON.parse(localStorage.getItem('wcw.templates') || '[]'); } catch { return []; } }
function saveTemplates(t) { try { localStorage.setItem('wcw.templates', JSON.stringify(t)); } catch { /* ignore */ } }
function addTemplateFromPrompt() {
  const text = $('promptInput').value.trim(); if (!text) { toast(t("toast.inputEmpty"), 'err'); return; }
  const name = prompt(t('mcp.templateName'), text.slice(0, 24)); if (!name) return;
  const t = getTemplates(); t.push({ name, text }); saveTemplates(t); toast(t("toast.templateSaved"), 'ok');
}
function insertTemplate(text) { const ta = $('promptInput'); ta.value = text; autoGrow(ta); ta.focus(); }

/* ---------------- skill library panel (v1 技能体系) ---------------- */
// 「技能库」三分组:技能支持本会话启用 + 全局常驻;命令在 Claude 下插入 /name,Provider 下插入同一
// 命令正文作为可编辑任务模板;一键任务走 Playbook 表单。skillFiltered 供键盘上下 + Enter。
  return Object.freeze({
    activeProviderObj,
    addProviderFromPreset,
    applyClaudeEndpointPreset,
    currentEngineMeta,
    currentModelId,
    engineLabel,
    engineVisual,
    exportSession,
    fillSettings,
    getTemplates,
    importMcpFromFolder,
    importSession,
    insertTemplate,
    isProviderMode,
    openPermPopover,
    populatePermSelect,
    refreshModels,
    refreshStatus,
    renderPermChip,
    renderProviders,
    renderStatusLine,
    saveConfigPartial,
    saveSettings,
    updateEngineDependentUI,
    updateSearchBackendVisibility,
  });
}

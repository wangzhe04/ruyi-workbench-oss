'use strict';
import { providerModels, bindModelSelect } from './model-catalog.js';

// EC-D：命令面板、模型/能力弹层、模态、页签与工具栏布局领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, fmtTokens, toast, chatProviders } from './util.js';
import { icon } from './icons.js';
import { t, tCount } from './i18n.js';
// 32 号文 §4（M1-b）：浮层原语（popover/closePopover）搬成叶子模块 js/popover.js —— 两壳共用同一份
// 「开合」，而 3.0 不必为了它把本域的组合根（help-menu / help-viewer / onboarding-wizard）一起拉进来。
import { popover, popoverAnchor } from './popover.js';
// 118d: 常驻帮助菜单。菜单本体是壳无关工厂,住在这里只因为 popover 原语在本域;手册阅读器与新手向导
// 都走各自模块的「共用实例登记处」(help-viewer / onboarding-wizard),所以组合根不必再多注入两条依赖。
import { createHelpMenuDomain } from './help-menu.js';
import { openSharedHelpDoc } from './help-viewer.js';
import { openSharedOnboarding } from './onboarding-wizard.js';

export function createNavigationControlsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  newSession = async () => {},
  runTool = async () => {},
  stopTurn = () => {},
  exportSession = () => {},
  importSession = () => {},
  addTemplateFromPrompt = () => {},
  openMcpInspector = async () => {},
  openMemoryPanel = async () => {},
  openMemoryToolbox = async () => {},
  getTemplates = () => [],
  insertTemplate = () => {},
  openSession = async () => {},
  currentEngineMeta = () => ({}),
  updateEngineDependentUI = () => {},
  latestUsage = () => null,
  ctxTokensOf = () => 0,
  ctxWindow = () => 0,
  ctxWindowManual = () => 0,
  ctxWindowSourceLabel = () => '',
  setCtxWindowManual = () => {},
  currentModelId = () => '',
  isProviderMode = () => false,
  engineLabel = () => '',
  saveConfigPartial = async () => false,
  refreshModels = async () => {},
  // 121-K5（34 号文 §3.1）：顶栏那枚 #modelChip 退役之后，「引擎／模型／强度的全局配置刚刚变了」
  // 这件事仍然要有人接 —— 线程头那一组 chip 里「跟随全局」的显示值就是从它读出来的。
  // 本域原来七处 renderModelChip() 一对一换成它；缺省空操作（不注入就只是不重画，行为可退化）。
  onEngineConfigChanged = () => {},
  updateContextMeter = () => {},
  toggleTheme = () => {},
  compactContext = async () => {},
  refreshStatus = async () => {},
  // 118b: openModal('settingsModal') 一直在调一个从未注入的 fillSettings -- 领域拆分时漏掉的自由标识符,
  // 每次程序化打开设置都抛 ReferenceError,并把调用点后面的语句(例如「切到某个页签」)一起吃掉。
  fillSettings = () => {},
  openSkillPanel = async () => {},
  patchSession = async () => {},
  toggleUiMode = () => {},
  focusFirstInteractive = () => null,
  loadAgentRoles = async () => {},
  refreshOverlayStatus = async () => {},
  refreshMcpOps = async () => {},
  updateShellPolling = () => {},
  loadFileTree = async () => {},
  renderArtifactsGallery = () => {},
  loadChanges = async () => {},
  openAuditTab = () => {},
  openUsageDashboard = () => {},
  openStorageTab = () => {},
  loadAgentWorkflows = async () => {},
  loadUsage = async () => {},
  loadAgentRuns = async () => {},
  renderRawEventSnapshot = () => {},
  updateAgentRunsPolling = () => {},
  // 118d: 日志面板用的动态模态构建器(interaction-prompts 那一份,组合根透进来)。
  buildModal = () => null,
} = {}) {
// 118d: 帮助菜单实例。手册与向导都取各自模块的共用实例,拿不到时(理论上只有预览壳单跑)静默不动作。
const helpMenu = createHelpMenuDomain({
  api, el, t, toast, apiErrText, buildModal,
  popover: (...args) => popover(...args),
  openHelpDoc: options => openSharedHelpDoc(options),
  openOnboarding: () => openSharedOnboarding(),
  currentSessionId: () => String((state.currentSession && state.currentSession.id) || ''),
});
function openHelpMenu() { return helpMenu.openHelpMenu($('helpMenuBtn')); }
// 上下文帮助:按当前设置页签打开手册对应小节(state._settingsTab 由 switchSettingsTab 维护)。
function openSettingsTabHelp() { return helpMenu.openSettingsTabHelp(state._settingsTab || 'basic'); }
// 帮助入口的接线,合并成一次调用,组合根只加一行。
// 118g 顺带治理:高级页的「打开数据目录」原来把 state.status.dataRoot 这个【客户端持有的路径串】
// 交给 runTool('browser_open') 去开;改走 /api/open-path 的枚举通道后,前端一个路径都不再经手。
function initHelpEntries() {
  const menuBtn = $('helpMenuBtn'); if (menuBtn) menuBtn.onclick = () => openHelpMenu();
  const tabBtn = $('settingsHelpBtn'); if (tabBtn) tabBtn.onclick = () => openSettingsTabHelp();
  const dataBtn = $('openDataDirBtn'); if (dataBtn) dataBtn.onclick = () => helpMenu.openWorkbenchFolder('data');
}
function paletteActions() {
  const acts = [
    { label: t('palette.newSession'), hint: 'Ctrl+N', run: newSession },
    { label: t('palette.toggleTheme'), hint: '', run: toggleTheme },
    { label: t('palette.compactContext'), hint: '', run: compactContext },
    { label: t('palette.openSettings'), hint: '', run: () => openModal('settingsModal') },
    { label: t('palette.openProviders'), hint: '', run: () => { openModal('settingsModal'); switchSettingsTab('providers'); } },
    { label: t('palette.openDataDirectory'), hint: '', run: () => helpMenu.openWorkbenchFolder('data') }, // 118g: 走 /api/open-path 枚举,前端不再经手路径串
    { label: t('palette.refreshDiagnostics'), hint: '', run: () => { openModal('settingsModal'); switchSettingsTab('doctor', true); refreshStatus(); } },
    { label: t('palette.stopCurrentTurn'), hint: 'Esc', run: stopTurn },
    { label: t('palette.exportMarkdown'), hint: 'export', run: () => exportSession('md') },
    { label: t('palette.exportJson'), hint: 'export', run: () => exportSession('json') },
    { label: t('palette.exportHtml'), hint: 'export', run: () => exportSession('html') },
    { label: t('palette.importJson'), hint: 'import', run: importSession },
    { label: t('palette.saveInputAsTemplate'), hint: 'template', run: addTemplateFromPrompt },
    { label: t('palette.skills'), hint: '/', run: openSkillPanel },
    { label: t('palette.memories'), hint: 'memory', run: openMemoryPanel },
  ];
  for (const template of getTemplates()) acts.push({ label: t('palette.template', { name: template.name }), hint: 'template', run: () => insertTemplate(template.text) });
  // Engine/model actions across ALL engines (C4): Claude CLI group + every provider. Each row switches
  // engine AND model in one setEngineModel call. Label reads "引擎 → {engineLabel} · {model}".
  // 124（用户 2026-09-14 走查「前后端还没完全对上」的第三处，与前两处同族）：这一组列的【永远】是
  // Agent CLI 的候选（点它 = setEngineModel('', id) = 把这条线程切到 CLI 路由），可修前印的名字用的是
  // engineLabel() —— 那个函数跟着【这条会话的路由】走。于是线程头把这条线程切到某个 provider 之后，
  // 这里长出「引擎 → Qwen · kimi-code/k3-256k」这种话：名字是 Qwen 的，id 是 Kimi 的，点下去还会把线程
  // 从 Qwen 切回 CLI。名字改成按【服务端造这份列表时用的那个 CLI】印（/api/status 的判据是
  // conversationConfig.agentCliType，provider 路由不改它 = 全局那一个）；顺带把 curPid 也从
  // 「全局 activeProvider」改成「这条会话路由到的 provider」—— 修前线程切到 B 而全局是 A 时，
  // 下面 provider 那一组的「当前」标记要么标错要么一个都不标（与 121 走查1-⑤ 修状态行 title 同一条账）。
  const curPid = isProviderMode() ? String(currentEngineMeta().providerId || '') : '';
  const curModel = currentModelId();
  const cliGroupLabel = String(currentEngineMeta().agentCliLabel || '') || engineLabel();
  const claudeModels = (state.status && state.status.models) || [{ id: '', label: t('palette.defaultModel') }];
  for (const m of claudeModels) {
    const isCur = curPid === '' && (m.id || '') === (curModel || '');
    acts.push({ label: t('palette.engine', { engine: cliGroupLabel, model: m.label || m.id || t('palette.defaultModel') }), hint: isCur ? t('palette.current') : 'engine', run: () => setEngineModel('', m.id || '') });
  }
  for (const p of chatProviders(state.config)) {   // 只做语音的服务商不进对话候选(state.js)
    for (const m of providerModels(p)) {
      if (!m.id) continue;
      const isCur = curPid === p.id && (m.id || '') === (curModel || '');
      acts.push({ label: t('palette.engine', { engine: p.label || p.id, model: m.label || m.id }), hint: isCur ? t('palette.current') : 'engine', run: () => setEngineModel(p.id, m.id) });
    }
  }
  for (const s of state.sessions.slice(0, 12)) acts.push({ label: t('palette.session', { title: s.title }), hint: 'session', run: () => openSession(s.id) });
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
// 32 号文 §4（M1-b）：原语本体已搬进 js/popover.js（叶子模块）—— 本域各弹层（模型 chip / 上下文电池 /
// 会话改名 / 更多菜单）仍从同一条 import 取它，类的用法与 DOM/关闭路径逐字未变。

/* ---------------- 线程配置的两件全局事实（121-K5，34 号文 §3.1）---------------- */
// 顶栏那枚 #modelChip 与它的弹层（renderModelChip / openModelChipPopover）整段退役：线程的
// 权限／模型／引擎自此只有 js/steward-chips.js 那一份工厂画一次（写口恒为 PATCH /api/sessions/:id）。
// 留在本域的是它【独有】的那几件 —— 它们动的是全局配置，不是这条线程：
//   · 思考强度 / 推理强度（setClaudeThinkingEffort / setProviderReasoningEffort）
//   · 删模型行（deleteCustomModel ／ deleteProviderModel）
//   · 刷新模型列表、管理服务商…
// 三者经本文件末尾导出的 modelMenuExtras 挂进 chips 模型菜单的尾部（组合根一处接线）。
const CLAUDE_THINKING_EFFORTS_UI = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDER_REASONING_EFFORTS_UI = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function activeProvider() {
  const id = isProviderMode() ? String(currentEngineMeta().providerId || '') : '';
  return id && id !== 'claude-cli' ? (state.config?.providers || []).find(p => p.id === id) || null : null;
}
async function setClaudeThinkingEffort(value) {
  const effort = CLAUDE_THINKING_EFFORTS_UI.includes(value) ? value : '';
  const previous = state.config?.claudeThinkingEffort || '';
  if (effort === previous) return true;
  state.config.claudeThinkingEffort = effort;
  onEngineConfigChanged();
  const saved = await saveConfigPartial({ claudeThinkingEffort: effort });
  if (!saved) {
    state.config.claudeThinkingEffort = previous;
    onEngineConfigChanged();
    return false;
  }
  onEngineConfigChanged();
  toast(state.streaming
    ? t('modelMenu.effortChangedNextTurn', { effort: t(`thinkingEffort.${effort || 'default'}`) })
    : t('modelMenu.effortChanged', { effort: t(`thinkingEffort.${effort || 'default'}`) }), 'ok');
  return true;
}
async function setProviderReasoningEffort(providerId, value) {
  const effort = PROVIDER_REASONING_EFFORTS_UI.includes(value) ? value : '';
  const previousProviders = state.config?.providers || [];
  const current = previousProviders.find(p => p.id === providerId);
  if (!current || String(current.reasoningEffort || '') === effort) return true;
  const providers = previousProviders.map(p => p.id === providerId ? { ...p, reasoningEffort: effort } : p);
  state.config.providers = providers;
  onEngineConfigChanged();
  const saved = await saveConfigPartial({ providers });
  if (!saved) {
    state.config.providers = previousProviders;
    onEngineConfigChanged();
    return false;
  }
  toast(state.streaming
    ? t('modelMenu.effortChangedNextTurn', { effort: t(`provider.reasoningEffort.${effort || 'default'}`) })
    : t('modelMenu.effortChanged', { effort: t(`provider.reasoningEffort.${effort || 'default'}`) }), 'ok');
  return true;
}
// Write activeProvider + model in ONE POST /api/config, then refresh chip + dependent UI + meter +
// (silently) the live model list. providerId ''(or 'claude-cli') selects the Claude engine; a provider
// id writes the model INTO that provider's entry, Claude writes config.model.
// 32 号文 §4（M1-b）：opts.scope === 'session' 时【只】把路由钉到当前会话（patchSession），不装配全局
// config、不写 POST /api/config —— 会话级选择不该改「新会话的默认值」。不传 opts（2.0 的调用点）时
// 逐字就是修前那条全局路径。
async function setEngineModel(providerId, modelId, opts = {}) {
  const scope = opts.scope || 'global';
  const pid = providerId || '';
  const previousRoute = state.currentSession?.engineRoute ? { ...state.currentSession.engineRoute } : null;
  const agentMeta = currentEngineMeta();
  const engineRoute = pid && pid !== 'claude-cli'
    ? { engine: 'openai', providerId: pid, model: modelId || '' }
    : { engine: 'agent', agentCliType: agentMeta.agentCliType === 'kimi' ? 'kimi' : (state.config?.agentCliType === 'kimi' ? 'kimi' : 'claude'), model: modelId || '' };
  // 全局 config 的装配：只有 scope==='global' 才做（会话级选择只活在 engineRoute 里，不动新会话默认值）。
  let patch = null;
  if (scope === 'global') {
    patch = { activeProvider: pid };
    if (pid && pid !== 'claude-cli') {
      patch.providers = (state.config.providers || []).map(p => (p.id === pid ? { ...p, model: modelId || '' } : p));
    } else {
      patch.model = modelId || '';
    }
  }
  // Pin the choice to the opened conversation before changing the global new-session default. This makes
  // switching A→B restore B's route instead of showing/running whichever route was selected most recently.
  if (state.currentSession?.id) {
    state.currentSession.engineRoute = engineRoute;
    try { await patchSession(state.currentSession.id, { engineRoute }); }
    catch (error) {
      if (previousRoute) state.currentSession.engineRoute = previousRoute; else delete state.currentSession.engineRoute;
      toast(apiErrText(error), 'err');
      return;
    }
  }
  // Optimistic local update so the chip/meter reflect the choice immediately.
  if (scope === 'global') Object.assign(state.config, patch);
  state.shownUsage = null;
  const routeKey = `${pid || 'agent'}\u0000${modelId || ''}`;
  // The previous /api/status and usage row belong to the old route. Clear only the resolved denominator;
  // the numerator remains useful and ctxWindow now rejects a route-mismatched usage limit.
  if (state.status) state.status.contextWindowResolved = null;
  updateContextMeter();
  const saved = scope === 'global' ? await saveConfigPartial(patch) : false;
  onEngineConfigChanged();
  updateEngineDependentUI();
  updateContextMeter();
  // Re-resolve after persistence so probe/manual/table values (including learned provider caps) appear
  // without waiting for a restart or another chat turn. Ignore a late response after a second switch.
  if (saved) {
    const statusUrl = state.currentSession?.id ? `/api/status?sessionId=${encodeURIComponent(state.currentSession.id)}` : '/api/status';
    api(statusUrl).then(fresh => {
      const nowMeta = currentEngineMeta();
      const nowPid = isProviderMode() ? String(nowMeta.providerId || '') : '';
      if (`${nowPid || 'agent'}\u0000${currentModelId() || ''}` !== routeKey) return;
      if (state.status) state.status.contextWindowResolved = fresh && fresh.contextWindowResolved;
      updateContextMeter();
    }).catch(() => {});
  }
  refreshModels(); // silent enrich for the newly-active engine
  const label = engineLabel();
  toast(state.streaming
    ? t('modelMenu.selectionChangedNextTurn', { engine: label, model: modelId || t('provider.defaultModel') })
    : t('modelMenu.selectionChanged', { engine: label, model: modelId || t('provider.defaultModel') }), 'ok');
}
// 第44波: 删除 Claude 引擎下的自定义模型(extraModels 的 "id|label" 条目 ∪ knownModels 记忆条目)——之前只增不删,
// 列表越用越脏。若删的是当前选中模型,一并重置为「默认」。写一次 POST /api/config,再静默刷新列表。
// 注意:代理发现缓存里的 API 条目不受影响(那是端点真实清单,非用户数据)——删完仍显示的行说明它来自代理。
async function deleteCustomModel(modelId) {
  const id = String(modelId || '').trim(); if (!id) return;
  const patch = {
    extraModels: (state.config.extraModels || []).filter(raw => String(raw).split('|')[0].trim() !== id),
    knownModels: (state.config.knownModels || []).filter(k => String(k || '').trim() !== id),
  };
  if ((state.config.model || '') === id) patch.model = '';
  Object.assign(state.config, patch); // 乐观更新,失败由 toast 告知(下次刷新会回弹真实值)
  try {
    await saveConfigPartial(patch);
    toast(t('modelMenu.modelDeleted', { model: id }), 'ok');
  } catch (e) { toast(t('modelMenu.deleteFailed', { error: apiErrText(e) }), 'err'); }
  onEngineConfigChanged();
  await refreshModels(); // 静默重建 status.models
}
// provider 那一组（引擎 = OpenAI 兼容端点）：候选清单就是这个端点自己的 providers[].models（手填 ∪
// 测试连接／刷新发现）。删一行 = 从这份清单里去掉，并把 id 记进 providers[].hiddenModels —— 服务端
// GET /api/models 在【合并点】按它过滤，于是 ↻ 刷新也不会把刚删掉的那一行原样还回来（这是本波与
// 命令行那一组的唯一差别：那一组删的是用户自己的条目，端点清单不归我们删）。
// 删掉的正好是这个端点的默认模型时，默认跟着挪到剩下的第一条（一条不剩就清空）—— 否则「默认」会
// 指着列表里已经不存在的模型。这条线程此刻正在用哪个模型不受影响（那是会话级路由，不是本行的账）。
async function deleteProviderModel(providerId, modelId) {
  const id = String(modelId || '').trim();
  const pid = String(providerId || '').trim();
  if (!id || !pid) return;
  const current = (Array.isArray(state.config?.providers) ? state.config.providers : []).find(p => p && p.id === pid) || null;
  if (!current) return;
  const modelIdOf = m => String((m && m.id) || m || '').trim();
  const models = (Array.isArray(current.models) ? current.models : []).filter(m => modelIdOf(m) && modelIdOf(m) !== id);
  const hidden = [...new Set([
    ...(Array.isArray(current.hiddenModels) ? current.hiddenModels : []).map(v => String(v || '').trim()).filter(Boolean),
    id,
  ])];
  const next = {
    ...current,
    models,
    hiddenModels: hidden,
    model: String(current.model || '') === id ? (models.length ? modelIdOf(models[0]) : '') : String(current.model || ''),
  };
  const patch = { providers: (state.config.providers || []).map(p => (p && p.id === pid ? next : p)) };
  Object.assign(state.config, patch); // 乐观更新，失败由 toast 告知（下次刷新会回弹真实值）
  try {
    await saveConfigPartial(patch);
    toast(t('modelMenu.modelRemoved', { model: id }), 'ok');
  } catch (e) { toast(t('modelMenu.deleteFailed', { error: apiErrText(e) }), 'err'); }
  onEngineConfigChanged();
}
// provider 那一组里「哪些行有 ×」：就是这个端点当前候选清单上的全部 id（含这一回合刚折回来的发现项）。
function providerModelIdSet(providerId) {
  const pid = String(providerId || '').trim();
  const provider = (Array.isArray(state.config?.providers) ? state.config.providers : []).find(p => p && p.id === pid) || null;
  if (!provider) return null;
  const ids = new Set();
  for (const row of (Array.isArray(provider.models) ? provider.models : [])) {
    const v = String((row && row.id) || row || '').trim();
    if (v) ids.add(v);
  }
  return ids;
}
// v1.0.2 (G3): compact context-length badge — >=1e6 → 「1M」, >=1e3 → 「128K」, else raw. null/0 → ''.
function ctxLenBadge(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1e6) { const m = v / 1e6; return (Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M'; }
  if (v >= 1e3) { const k = v / 1e3; return (Number.isInteger(k) ? String(k) : Math.round(k)) + 'K'; }
  return String(v);
}
// ── 121-K5（34 号文 §3.1）：2.0 模型弹层独有的三件事，挂到 chips 模型菜单的尾部 ──────────
// openModelChipPopover 与它的容器 #modelChip 整段退役。留下来的是它【独有】的那三件 —— 它们动的
// 都是【全局配置】而不是这条线程，所以不能塞进 chips 那个会话级写口，只能作为菜单尾部的附加件：
//   ① 思考强度 / 推理强度：按当前引擎选一份（命令行引擎用 thinkingEffort，provider 用 reasoningEffort）；
//   ② 删模型行：行尾那枚「×」——命令行引擎删 extraModels ∪ knownModels（代理发现的条目不可删），
//      provider 那一组删这个端点候选清单里的一行，并记进 providers[].hiddenModels（见下面两个函数）；
//   ③ 刷新模型列表 ／ 管理服务商…（后者直达设置的「服务商」页签）。
// 每一件的函数体都是原弹层里那一份（appendClaudeEffort／appendProviderEffort／actions 那两条）逐字
// 搬过来的，只是宿主从 .popover 换成了 .steward-chip-menu，并把两个强度分支合成一个（原来两份
// 只差键名与写回函数，合起来之后「选哪一档」这件事仍然只有一处）。
function customModelIdSet() {
  const ids = new Set();
  for (const raw of (state.config.extraModels || [])) { const v = String(raw).split('|')[0].trim(); if (v) ids.add(v); }
  for (const id of (state.config.knownModels || [])) { const v = String(id || '').trim(); if (v) ids.add(v); }
  return ids;
}
function appendEffortControl(container, close) {
  const providerMode = isProviderMode();
  const provider = activeProvider();
  if (providerMode && !provider) return;
  const control = el('label', 'mc-effort-control');
  control.appendChild(el('span', 'mc-effort-label', t(providerMode ? 'provider.reasoningEffort' : 'modelMenu.thinkingEffort')));
  const select = el('select', 'mc-effort-select');
  const values = providerMode
    ? PROVIDER_REASONING_EFFORTS_UI
    : (state.config?.agentCliType === 'kimi' ? ['', 'low', 'medium', 'high', 'max'] : CLAUDE_THINKING_EFFORTS_UI);
  const keyOf = value => (providerMode ? `provider.reasoningEffort.${value || 'default'}` : `thinkingEffort.${value || 'default'}`);
  for (const value of values) {
    const option = el('option');
    option.value = value;
    option.textContent = t(keyOf(value));
    select.appendChild(option);
  }
  const current = providerMode ? String(provider.reasoningEffort || '') : String(state.config?.claudeThinkingEffort || '');
  select.value = values.includes(current) ? current : '';
  select.onchange = async () => {
    select.disabled = true;
    const saved = providerMode
      ? await setProviderReasoningEffort(provider.id, select.value)
      : await setClaudeThinkingEffort(select.value);
    if (saved) close(); else select.disabled = false;
  };
  control.appendChild(select);
  container.appendChild(control);
}
// 尾部动作用的是 chips 自己的行类名（.steward-chip-option）——它们因此天然进那张菜单的 ↑↓ 行序
// （steward-chips.js 的 stewardVisibleOptions 只认这一个类名），不必在 chips 那边为它们开第二条键盘路。
function chipMenuAction(labelKey, action, onClick) {
  const button = el('button', 'steward-chip-option steward-chip-config-action');
  button.type = 'button';
  button.dataset.chipAction = action;
  button.appendChild(el('span', 'steward-chip-option-label', t(labelKey)));
  button.onclick = onClick;
  return button;
}
const modelMenuExtras = Object.freeze({
  // 「×」的判据按【这张菜单自己的路由】分岔（宿主 chips 把 route 递进来）：
  //   · 命令行引擎那一组 —— 只有用户自己加的条目（extraModels ∪ knownModels）可删，代理发现的条目
  //     是端点真实清单、不是用户数据（第 44 波那条口径，一字未改）；
  //   · provider 那一组 —— 这个端点候选清单上的每一行都可删，删完记进 providers[].hiddenModels。
  // 宿主没给 route（旧调用形状）时退回原口径：全局是 provider 就不给删。
  deletableIds: route => {
    if (route && route.engine === 'openai') return providerModelIdSet(route.providerId);
    if (route && route.engine) return customModelIdSet();
    return isProviderMode() ? null : customModelIdSet();
  },
  onDelete: async (modelId, route) => {
    if (route && route.engine === 'openai') await deleteProviderModel(route.providerId, modelId);
    else await deleteCustomModel(modelId);
  },
  appendTail: (menu, ctx) => {
    const close = (ctx && typeof ctx.close === 'function') ? ctx.close : () => {};
    const redraw = () => { if (ctx && typeof ctx.redraw === 'function') ctx.redraw(); };
    appendEffortControl(menu, close);
    // 用户走查①：「刷新模型列表」不该把选择界面关掉 —— 关完还得重开一次才能切到刚刷出来的那个模型。
    // 现在：数据刷完就地重画这张菜单（新出现的行当场可点），期间把这一行禁用，防连点发两发请求。
    menu.appendChild(chipMenuAction('modelMenu.refreshModels', 'refreshModels', async event => {
      const button = event && event.currentTarget ? event.currentTarget : null;
      if (button) button.disabled = true;
      try { await refreshModels(true, ctx); } finally { if (button) button.disabled = false; }
      redraw();
    }));
    menu.appendChild(chipMenuAction('modelMenu.manageProviders', 'manageProviders',
      () => { close(); openModal('settingsModal'); switchSettingsTab('providers'); }));
  },
});
/* ---------------- context-meter popover (§4.6) ---------------- */
// Click the battery → popover with used/limit + %, limit source (model-inferred / manual), preset
// chips (64K 128K 200K 256K 512K 1M 自动) + custom input, and a 🗜 compact button. Replaces the native prompt().
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
    wrap.appendChild(el('div', 'ctx-pop-row ctx-pop-usage', used != null ? `已用 ${fmtTokens(used)} / 上限 ${fmtTokens(win)} · ${pct}%` : `上限 ${fmtTokens(win)}（暂无用量数据）`));
    // Percent bar in the meter color.
    const bar = el('div', 'ctx-pop-bar'); const barIn = el('div', 'ctx-pop-bar-in');
    barIn.style.width = Math.max(0, Math.min(100, pct)) + '%';
    if (pct >= 90) barIn.style.background = 'var(--danger)'; else if (pct >= 70) barIn.style.background = 'var(--warn)'; else barIn.style.background = 'var(--ok)';
    bar.appendChild(barIn); wrap.appendChild(bar);
    wrap.appendChild(el('div', 'ctx-pop-src muted', `${t('ctx.currentModel', {model: currentModelId() || t('common.default')})} · ${t('ctx.limitSource', {src: srcLabel})}`));
    // v1.4.1: 端点未报告真实上限时(名称推测),明确提示可能不准 + 手动锁定仅对当前模型生效。
    if (manual <= 0 && srcLabel === t('ctx.sourceLabel.guessed')) {
      wrap.appendChild(el('div', 'ctx-pop-hint muted', t('ctx.pop.hint')));
    }
    // Preset chips + custom input.
    const chips = el('div', 'ctx-chips');
    // Keep 200K: it is a real advertised limit (not a rounded 256K). Add binary 256K and a useful 512K
    // midpoint rather than making users jump directly from 200K to 1M.
    const presets = [['64K', 65536], ['128K', 131072], ['200K', 200000], ['256K', 262144], ['512K', 524288], ['1M', 1000000], [t('ctx.auto'), 0]];
    const applyWin = async n => {
      try { await setCtxWindowManual(n); updateContextMeter(); close(); }
      catch (e) { toast(apiErrText(e), 'err'); }
    };
    for (const [label, n] of presets) {
      const c = el('button', 'ctx-chip'); c.type = 'button'; c.textContent = label;
      if ((n === 0 && manual <= 0) || (n > 0 && manual === n)) c.classList.add('active');
      c.onclick = () => applyWin(n);
      chips.appendChild(c);
    }
    wrap.appendChild(chips);
    const custom = el('input', 'ctx-custom'); custom.type = 'text'; custom.placeholder = t('ctx.customLimit');
    custom.value = manual > 0 ? String(manual) : '';
    custom.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const v = custom.value.replace(/[,\s]/g, ''); const n = parseInt(v, 10); if (v === '') applyWin(0); else if (Number.isFinite(n) && n > 0) applyWin(n); }
    });
    wrap.appendChild(custom);
    // Universal compaction model: default follows the current access mode (Claude/Kimi native or active
    // Provider); every explicitly configured Provider/Ollama model is available across all three modes.
    const compactLabel = el('label', 'ctx-compact-model-label muted', t('ctx.compact.label'));
    const compactSelect = el('select', 'ctx-compact-model');
    const defaultName = isProviderMode() ? t('ctx.compact.defaultProvider')
      : (currentEngineMeta().agentCliType === 'kimi' ? t('ctx.compact.defaultKimi') : t('ctx.compact.defaultClaude'));
    const selectedProvider = String(state.config?.compactProviderId || '');
    const selectedModel = String(state.config?.compactModel || '');
    bindModelSelect(compactSelect, {
      models: () => chatProviders(state.config).filter(p => p.enabled !== false).flatMap(provider =>
        providerModels(provider).map(model => ({ id: provider.id + String.fromCharCode(31) + model.id, label: (provider.label || provider.id) + ' / ' + model.label }))),
      value: selectedProvider && selectedModel ? selectedProvider + String.fromCharCode(31) + selectedModel : '',
      emptyLabel: defaultName, labelOnly: true,
    });
    const compactModelHint = el('span', 'ctx-pop-hint muted');
    const renderCompactHint = () => {
      const [providerId = '', selectedId = ''] = compactSelect.value.split('\u001f');
      const model = selectedId.toLowerCase();
      const provider = (state.config?.providers || []).find(item => item && item.id === providerId);
      const modelRow = provider && providerModels(provider).find(item => String((item && item.id) || item || '') === selectedId);
      const compactWindow = Number(modelRow && modelRow.contextLength) || Number(provider && provider.contextWindow) || 0;
      const windowNote = compactWindow > 0 ? t('ctx.compact.windowNote', { window: ctxLenBadge(compactWindow) }) : '';
      compactModelHint.textContent = !compactSelect.value
        ? t('ctx.compact.hintDefault')
        : (/1b|1\.\d+b/.test(model)
          ? t('ctx.compact.hintRisky1b', { windowNote })
          : (/2b|2\.\d+b/.test(model)
            ? t('ctx.compact.hintLossy2b', { windowNote })
            : t('ctx.compact.hintExternal', { windowNote })));
    };
    renderCompactHint();
    compactSelect.onchange = async () => {
      const [compactProviderId = '', compactModel = ''] = compactSelect.value.split('\u001f');
      compactSelect.disabled = true;
      const saved = await saveConfigPartial({ compactProviderId, compactModel });
      compactSelect.disabled = false;
      if (saved) { renderCompactHint(); toast(compactProviderId ? t('ctx.compact.toastSet', { model: compactSelect.options[compactSelect.selectedIndex].text }) : t('ctx.compact.toastReset'), 'ok'); }
    };
    compactLabel.appendChild(compactSelect);
    compactLabel.appendChild(compactModelHint);
    wrap.appendChild(compactLabel);
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
  // Existing Kimi sessions may predate usage synchronization. Refresh the authoritative native status
  // whenever the meter is opened and patch both the battery and this popover without requiring a restart.
  if (handle && !isProviderMode() && currentEngineMeta().agentCliType === 'kimi' && state.currentSession?.id) {
    const sid = state.currentSession.id;
    api(`/api/kimi/status?sessionId=${encodeURIComponent(sid)}`).then(r => {
      if (!r || !r.ok || !r.usage || state.currentSession?.id !== sid) return;
      state.shownUsage = r.usage;
      updateContextMeter();
      if (!handle.node.isConnected) return;
      const usedNow = ctxTokensOf(r.usage), winNow = ctxWindow();
      const pctNow = winNow > 0 && usedNow != null ? Math.round((usedNow / winNow) * 100) : 0;
      const row = handle.node.querySelector('.ctx-pop-usage');
      if (row) row.textContent = usedNow != null ? `已用 ${fmtTokens(usedNow)} / 上限 ${fmtTokens(winNow)} · ${pctNow}%` : `上限 ${fmtTokens(winNow)}（暂无用量数据）`;
      const bar = handle.node.querySelector('.ctx-pop-bar-in');
      if (bar) { bar.style.width = Math.max(0, Math.min(100, pctNow)) + '%'; bar.style.background = pctNow >= 90 ? 'var(--danger)' : (pctNow >= 70 ? 'var(--warn)' : 'var(--ok)'); }
    }).catch(() => {});
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
  if (online === true) { net.textContent = '●'; badge.classList.add('cap-online'); badge.title = t('capability.badge.online'); }
  else if (online === false) { net.textContent = '○'; badge.classList.add('cap-offline'); badge.title = t('capability.badge.offline'); }
  else { net.textContent = '◐'; badge.classList.add('cap-unknown'); badge.title = t('capability.badge.unknown'); }
  const g = capGapCount(caps);
  if (g > 0) { gaps.textContent = String(g); gaps.classList.remove('hidden'); }
  else { gaps.classList.add('hidden'); gaps.textContent = ''; }
}
// anchorOverride (v1.0-S2 IA): capBadge 移出顶栏后 display:none，锚点要换一个【看得见】的元素，
// 免得定位到不可见元素（getBoundingClientRect 全 0）。
// 122-L1b（36 号文 §2.12）：回退锚点从退役的 #moreMenuBtn 换成齿轮钮 #appGearBtn —— 齿轮菜单
// 一点开就会被 app-frame 的「点菜单外收起」收掉，#capBadge 那一刻已经不可见了，所以不能锚它自己。
function openCapPopover(anchorOverride) {
  const badge = $('capBadge'); if (!badge || badge.classList.contains('hidden')) return;
  const anchor = anchorOverride || $('appGearBtn') || badge;
  // Immediate refresh + poll every 60s WHILE OPEN only (spec §4). closePopover stops the poll via onClose.
  fetchCapabilities(true);
  if (_capPoll) clearInterval(_capPoll);
  _capPoll = setInterval(() => fetchCapabilities(true), 60000);
  const handle = popover(anchor, () => {
    const wrap = el('div', 'cap-pop');
    const caps = _caps || {};
    const netLabel = (caps.network && caps.network.online === true) ? t('capability.network.online')
      : (caps.network && caps.network.online === false) ? t('capability.network.offline') : t('capability.network.unknown');
    const netCls = (caps.network && caps.network.online === true) ? 'ok'
      : (caps.network && caps.network.online === false) ? 'bad' : 'muted';
    const item = (k, v, cls) => {
      const row = el('div', 'cap-item');
      row.appendChild(el('span', 'cap-k', k));
      row.appendChild(el('span', 'cap-v' + (cls ? ' ' + cls : ''), v));
      return row;
    };
    wrap.appendChild(el('h4', null, t('capability.networkAndEngine')));
    wrap.appendChild(item(t('capability.network.label'), netLabel, netCls));
    wrap.appendChild(item(t('capability.engine.label'), caps.engine === 'openai' ? t('capability.engine.providerNative') : engineLabel()));
    if (caps.provider) {
      wrap.appendChild(item(t('capability.visionInput'), caps.provider.vision ? t('capability.supported') : t('capability.unsupported'), caps.provider.vision ? 'ok' : 'muted'));
      wrap.appendChild(item(t('capability.reasoningModel'), caps.provider.reasoning ? t('common.yes') : t('common.no'), 'muted'));
    }
    wrap.appendChild(el('h4', null, t('capability.localTools')));
    wrap.appendChild(item('git', caps.binaries && caps.binaries.git ? t('capability.available') : t('capability.missing'), caps.binaries && caps.binaries.git ? 'ok' : 'muted'));
    wrap.appendChild(item(t('capability.projectSearch'), caps.binaries && caps.binaries.rg ? t('capability.ripgrepAccelerated') : t('capability.builtinSearch'), 'ok'));
    wrap.appendChild(el('h4', null, t('capability.desktopControl')));
    const dm = caps.desktopMcp || {};
    wrap.appendChild(item(t('capability.desktopMcp'), dm.present ? tCount('capability.connected', dm.toolCount || 0) : t('capability.notConnected'), dm.present ? 'ok' : 'muted'));
    const opt = dm.optional || {};
    const optStr = ['ocr', 'uia', 'cv2', 'playwright'].filter(k => opt[k]).join(', ') || t('capability.none');
    wrap.appendChild(item(t('capability.optionalModules'), optStr, opt.ocr || opt.uia ? 'ok' : 'muted'));
    return wrap;
  });
  // Stop the poll when the popover closes (popover() returns {node, close}; but close via outside-click
  // won't call our code — hook the badge: when the active popover's anchor is no longer ours, clear the
  // interval on the next tick). 32 号文 §4（M1-b）：原语搬走后 activePopover 不再住本文件，走 accessor。
  if (handle) {
    const stop = () => { if (popoverAnchor() !== anchor) { if (_capPoll) { clearInterval(_capPoll); _capPoll = null; } clearInterval(mon); } };
    const mon = setInterval(stop, 500);
  }
}

// Session rename via an inline popover (§4.6) — replaces the native prompt(). Input + 确定 button.
function openRenamePopover(anchorEl, s) {
  popover(anchorEl, close => {
    const wrap = el('div', 'rename-pop');
    const inp = el('input', 'rename-input'); inp.type = 'text'; inp.value = s.title || ''; inp.placeholder = t('session.name');
    const commit = () => { const t = inp.value.trim(); close(); if (t && t !== s.title) patchSession(s.id, { title: t }); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    const ok = el('button', 'primary', t('common.confirm')); ok.type = 'button'; ok.onclick = commit;
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
    const attach = el('button', 'cm-item'); attach.type = 'button'; attach.append(icon('paperclip', 16), document.createTextNode(t('composer.attachFile')));
    attach.onclick = () => { close(); $('fileInput')?.click(); };
    wrap.appendChild(attach);
    // 技能 — Claude mode only.
    if (!isProviderMode()) {
      const skill = el('button', 'cm-item'); skill.type = 'button'; skill.append(icon('sparkles', 16), document.createTextNode(t('skills.menuLabel')));
      skill.onclick = () => { close(); openSkillPanel(); };
      wrap.appendChild(skill);
    }
    // 🗜 压缩 — both engines (provider goes through the server summary endpoint).
    const compact = el('button', 'cm-item'); compact.type = 'button'; compact.append(icon('compress', 16), document.createTextNode(t('composer.compactContext')));
    compact.onclick = () => { close(); compactContext(); };
    wrap.appendChild(compact);
    return wrap;
  }, { placement: 'bottom-start' });
}

/* ---------------- 齿轮菜单里「主题／界面」两项的文案 ---------------- */
// 122-L1b（36 号文 §2.12）：v1.0-S2 那个顶栏「⋯」更多菜单（openMoreMenu，一层 popover 里放
// 主题／界面／能力矩阵／快捷键）**整个退役** —— 它的四项在齿轮菜单里本来就各有一枚真控件
// （#themeToggle／#uiModeToggle／#capBadge 三枚状态载体 ＋ 旁边的 #helpBtn 就是快捷键），
// 「更多」只是把它们又画了一遍。留下的只有下面这两个纯文案函数：现在它们写的是**那三枚真
// 按钮自己**的标签，不再是 popover 里的影子项。
// 为什么标签要每次「补出来」而不是写死在 index.html 里：applyTheme／applyUiMode 用
// iconTextBtn 换图标，那个函数第一句就是 `btn.textContent = ''` —— 写死的 span 会被它清掉。
function themeMenuLabel() {
  // 第50波三态:菜单项显示当前偏好(含 system),不再只看有效值。
  let pref = 'dark'; try { pref = localStorage.getItem('wcw.theme') || 'dark'; } catch { /* ignore */ }
  return t('navigation.theme.' + (pref === 'light' || pref === 'system' ? pref : 'dark'));
}
function uiModeMenuLabel() { return document.documentElement.getAttribute('data-ui-mode') === 'simple' ? t('navigation.uiMode.simple') : t('navigation.uiMode.expert'); }
// 把一段文案写进齿轮菜单里某枚按钮的 .mm-label 上；span 不在（被 iconTextBtn 清过）就补一枚。
// 名字沿用原「⋯」菜单那两个 id（mm-theme-label／mm-uimode-label），别处的引用因此一个不用改。
function setGearItemLabel(hostId, spanId, text) {
  const host = document.getElementById(hostId);
  if (!host) return null;
  let span = document.getElementById(spanId);
  if (!span || span.parentNode !== host) {
    span = el('span', 'mm-label', '');
    span.id = spanId;
    host.appendChild(span);
  }
  span.textContent = text;
  return span;
}
// 主题／界面被切换（或语言变了）之后更新两项文案（无 DOM 时静默）。
function syncMoreMenuLabels() {
  setGearItemLabel('themeToggle', 'mm-theme-label', themeMenuLabel());
  setGearItemLabel('uiModeToggle', 'mm-uimode-label', uiModeMenuLabel());
}

/* ---------------- modals ---------------- */
// §4.9: opening records the trigger on the backdrop so closeModal (Esc/✕/backdrop/programmatic) can
// return focus to it; on open we focus the first interactive element inside the modal/palette panel.
const _modalTriggers = new WeakMap();
function openModal(id) {
  const bd = $(id);
  _modalTriggers.set(bd, document.activeElement);
  bd.classList.remove('hidden');
  if (id === 'settingsModal') { fillSettings(); switchSettingsTab(state._settingsTab || 'basic'); }
  const panel = bd.querySelector('.modal, .palette');
  setTimeout(() => { focusFirstInteractive(panel)?.focus?.(); }, 0);
}
// 128d(keyboard-walkthrough K5):触发者可能已经看不见了 —— 齿轮菜单里的「设置」按下去菜单就收起,那一项跟着藏起来,
// 往藏起来的节点上 focus() 是空操作,焦点于是掉到 body,键盘用户得从页首重新 Tab。退一步还给「拥有这张菜单的按钮」
// (aria-controls 指向菜单的那一枚,就是齿轮钮)。
function modalReturnTarget(trigger) {
  if (!trigger || typeof trigger.focus !== 'function') return null;
  if (trigger.isConnected && trigger.offsetParent !== null) return trigger;
  const menu = trigger.closest ? trigger.closest('[role="menu"]') : null;
  const owner = menu && menu.id ? document.querySelector(`[aria-controls="${menu.id}"]`) : null;
  return owner && owner.offsetParent !== null ? owner : null;
}
function closeModal(id) {
  const bd = $(id);
  bd.classList.add('hidden');
  const t = modalReturnTarget(_modalTriggers.get(bd)); _modalTriggers.delete(bd);
  if (t) { try { t.focus(); } catch { /* ignore */ } }
}
function anyModalOpen() { return [...document.querySelectorAll('.modal-backdrop')].some(m => !m.classList.contains('hidden')); }
// v1.5 (§1.2): 简易模式可见的设置页签白名单 —— 只留「基础/服务商/联网搜索」。其余(Claude CLI/Agent 角色/
// 集成 MCP/高级)含 MAX_THINKING_TOKENS / --max-turns / Overlay ID 等开发者字段,对非程序员主画像纯劝退,
// 一律隐藏。CSS(styles.css)隐藏页签按钮,这里的 JS 兜底防「隐藏页签的面板悬空显示」。
// 117k（用户走查①）：这张白名单必须与 ui-modes.css 那条隐藏清单互补 —— 只被 JS 拦、没被 CSS
// 藏的页签就是一枚【死键】：看得见、点了静默落回「基础」。steward 与 update 正是漏的两枚，
// 而管家总开关只住在管家页，于是「第一次把管家打开」在出厂默认（uiMode='simple'）下无路可走。
// 互补关系由 uimode-style 的 S1b 机械看住（新增页签时忘了这里，那条断言会红）。
// W6 设置重组：三枚公用页（权限与安全／用量与限额／模型分配）简易模式可见 —— 全局默认权限、月度预算与主模型
// 本来就在简易可见的页里，搬家不能搬丢；页内开发者向的行由 .settings-expert-only 在 ui-modes.css 收起。
const SETTINGS_SIMPLE_TABS = new Set(['basic', 'security', 'limits', 'steward', 'models', 'providers', 'network', 'doctor', 'update']);
// W6：「MCP 运维」并进「集成与 MCP」。旧页签名（程序化入口、state._settingsTab 里记着的上一次）一律改投新家，不落空。
const SETTINGS_TAB_ALIASES = Object.freeze({ mcp: 'integrations' });
// 123-S2 设置弹窗左侧导航：五枚分组升级为可折叠二级菜单。全部纯新增 ——
// 折叠态存 localStorage（wcw.* 前缀，与 stewardDetails 同一惯例），缺省只展开「通用」；
// 切页签（含 openModal 恢复上次页签）自动展开其所在组并落盘；组头点击走一次事件委托，
// 零定时器、不改任何既有函数签名。组头没有 data-stab，页签接线与简易模式隐藏的规则不受影响。
const SETTINGS_NAV_STORE_KEY = 'wcw.settingsNavGroups';
function readSettingsNavOpen() {
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_NAV_STORE_KEY) || 'null');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : null;
  } catch { return null; }
}
function persistSettingsNavOpen() {
  const open = [...document.querySelectorAll('#settingsTabs .settings-nav-group.is-open')]
    .map(group => group.dataset.group).filter(Boolean);
  try { localStorage.setItem(SETTINGS_NAV_STORE_KEY, JSON.stringify(open)); } catch { /* ignore */ }
}
function setSettingsNavGroup(group, open, persist) {
  if (!group) return;
  group.classList.toggle('is-open', open);
  const head = group.querySelector('.settings-nav-label');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (persist) persistSettingsNavOpen();
}
function syncSettingsNavFromStore() {
  const stored = readSettingsNavOpen();
  document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(group => {
    const open = stored ? stored.includes(group.dataset.group) : group.dataset.group === 'general';
    setSettingsNavGroup(group, open, false);
  });
}
function openSettingsNavGroupFor(stabName) {
  const tab = document.querySelector(`#settingsTabs button[data-stab="${stabName}"]`);
  const group = tab && tab.closest ? tab.closest('.settings-nav-group') : null;
  if (group && !group.classList.contains('is-open')) setSettingsNavGroup(group, true, true);
}
let _settingsNavWired = false;
function ensureSettingsNavWiring() {
  if (_settingsNavWired) return;
  const tabs = document.getElementById('settingsTabs');
  if (!tabs) return;
  _settingsNavWired = true;
  syncSettingsNavFromStore();
  tabs.addEventListener('click', event => {
    const head = event.target && event.target.closest ? event.target.closest('.settings-nav-label') : null;
    if (!head || !tabs.contains(head)) return;
    const group = head.closest('.settings-nav-group');
    if (group) setSettingsNavGroup(group, !group.classList.contains('is-open'), true);
  });
}
// 123-S2 长面板段内锚点 chip 条：从【已翻译的】段标题现取文案（零新增 i18n 键），每次切页签
// 重建（语言切换后标签不会留在旧语言）。候选段：basic 的四个折叠分组 / steward 的九张
// section / claude 的两枚段标题；缺 id 的段标题按「面板 id-sec-N」补一个确定性 id。
// W6：三枚公用页与合并后的「集成与 MCP」也按段出锚点（段是 section.settings-section，权限页里还有一段搬来的
// section.steward-settings-group）；只有一段的页（模型分配）不出（下面 targets.length < 2 自动跳过）。
const SETTINGS_SECTION_SELECTOR = 'section.settings-section, section.steward-settings-group';
const SETTINGS_JUMP_PANELS = Object.freeze({
  'stab-basic': 'details.settings-fold',
  'stab-security': SETTINGS_SECTION_SELECTOR,
  'stab-limits': SETTINGS_SECTION_SELECTOR,
  'stab-steward': 'section.steward-settings-group',
  'stab-claude': 'h4.settings-subhead',
  'stab-integrations': SETTINGS_SECTION_SELECTOR,
});
function jumpTargetLabel(node) {
  if (node.matches('details.settings-fold')) return node.querySelector('summary')?.textContent.trim() || '';
  if (node.matches(SETTINGS_SECTION_SELECTOR)) return node.querySelector('h4')?.textContent.trim() || '';
  return node.textContent.trim();
}
function buildSettingsJumpList(panelId) {
  const panel = document.getElementById(panelId);
  const selector = SETTINGS_JUMP_PANELS[panelId];
  if (!panel || !selector) return;
  panel.querySelector('.settings-jumplist')?.remove();
  const targets = [...panel.querySelectorAll(selector)]
    .map((node, index) => {
      if (!node.id) node.id = `${panelId}-sec-${index + 1}`;
      return { id: node.id, label: jumpTargetLabel(node) };
    })
    .filter(item => item.label);
  if (targets.length < 2) return;
  const nav = document.createElement('nav');
  nav.className = 'settings-jumplist';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const item of targets) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'settings-jump-chip';
    chip.textContent = item.label;
    chip.addEventListener('click', () => {
      document.getElementById(item.id)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
    nav.appendChild(chip);
  }
  panel.insertBefore(nav, panel.firstChild);
}
// Settings tab switcher (§4.5): toggles the tab-bar button + the matching .settings-tab panel.
// v1.5 (§1.2): 简易模式下,非白名单页签一律落回「基础」;force=true 供明确的开发者入口(如引导页
// 「配置 Claude CLI」逃生门)绕过收敛,直达目标页签。
function switchSettingsTab(name, force) {
  if (Object.prototype.hasOwnProperty.call(SETTINGS_TAB_ALIASES, name)) name = SETTINGS_TAB_ALIASES[name];
  if (!force && document.documentElement.getAttribute('data-ui-mode') === 'simple' && !SETTINGS_SIMPLE_TABS.has(name)) name = 'basic';
  state._settingsTab = name;
  ensureSettingsNavWiring();        // 123-S2：首挂事件委托 ＋ 按 localStorage 还原各组折叠态
  openSettingsNavGroupFor(name);    // 123-S2：切到哪个页签就展开它所在的组（含 openModal 恢复上次页签）
  buildSettingsJumpList(`stab-${name}`); // 123-S2：长面板顶部重建段内锚点 chip 条（无候选段的面板自动跳过）
  document.querySelectorAll('#settingsTabs button[data-stab]').forEach(b => b.classList.toggle('active', b.dataset.stab === name)); // 118d: 排尾的「?」不是页签
  document.querySelectorAll('.settings-tab').forEach(s => s.classList.toggle('active', s.id === `stab-${name}`));
  if (name === 'agents') loadAgentRoles();
  if (name === 'doctor') {
    refreshStatus();
    openStorageTab();
    renderRawEventSnapshot();
  }
  if (name === 'update') refreshOverlayStatus();
  if (name === 'integrations') refreshMcpOps(false); // 55c:打开页签先取清单(不 probe);「全部重测」按钮才 probe=1。W6:连接器清单并进了「集成与 MCP」
}

/* 第58波：更新中心与 MCP 运维实现已拆入 ./js/settings-operations.js。 */

/* ---------------- composer helpers ---------------- */
// v1.3-FE1:autoGrow 已搬入 ./js/util.js(纯 DOM 尺寸计算,顶部 import 取回);调用点(sendPrompt/boot 等)不变。

// The right pane is a user-facing workspace surface. Model-only execution tools have no tabs here;
// raw output remains a hidden compatibility sink for internal actions such as "open data directory".
const DEV_TABS = new Set([]);
const TOOLOUT_TABS = new Set([]);
// v2.7.2: 每轮对话结束自动刷新工具面板——只刷新「打开过」的页签,未打开过的保持懒加载;memory 为跨会话
// 内容不随单轮结果刷新;files 为默认激活页签恒在集合。主动点击页签由 noteToolTabOpened 纳入集合。
const toolTabsOpened = new Set(['files']);
function refreshToolPane() {
  const active = document.querySelector('.tool-pane .tool-tabs button.active')?.dataset.tab;
  if (active) toolTabsOpened.add(active);
  for (const tab of toolTabsOpened) {
    if (tab === 'files') loadFileTree();
    else if (tab === 'artifacts') renderArtifactsGallery();
    else if (tab === 'changes') loadChanges();
    else if (tab === 'audit') openAuditTab(true);
    else if (tab === 'usage') loadUsage(true);
    else if (tab === 'agent-runs') loadAgentRuns(true);
  }
}
function noteToolTabOpened(tab) { if (tab) toolTabsOpened.add(tab); }
function switchTab(tab) {
  // Old saved developer-tab ids are normalized to the safe workspace default.
  if (DEV_TABS.has(tab) && document.documentElement.getAttribute('data-ui-mode') === 'simple') tab = 'files';
  // Scope to the tool pane's tab bar: the settings modal now also uses .tool-tabs (with data-stab),
  // so an unscoped selector would wrongly clear the active settings tab. Match by data-tab only.
  document.querySelectorAll('.tool-pane .tool-tabs button').forEach(b => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tool-section').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  // Raw tool output is intentionally never exposed in the workspace pane.
  { const to = $('toolOutput'); if (to) to.classList.toggle('toolout-hidden', !TOOLOUT_TABS.has(tab)); }
  // v0.8-S2: only poll the shell-session list while its tab is showing.
  updateShellPolling();
  // v0.9-S3 (C3): (re)load the file tree when the files tab is opened, if empty.
  if (tab === 'files' && $('fileTree') && !$('fileTree').childElementCount) loadFileTree();
  // v0.9-S4 (C4): render the artifacts gallery from this session's turn summaries when its tab opens.
  if (tab === 'artifacts') renderArtifactsGallery();
  // v1.0.2 (G1): (re)load the checkpoint change list when the 变更 tab opens.
  if (tab === 'changes') loadChanges();
  if (tab === 'memory') openMemoryToolbox();
  // v0.9-S8 (§4 B4): load the audit timeline once when its tab opens (no polling — the audit view is quiet).
  if (tab === 'audit') openAuditTab();
  // 用量看板：打开时才拉取（懒加载，同审计）。已加载则用缓存重绘，避免重复请求；刷新/切范围会强制重拉。
  if (tab === 'usage') openUsageDashboard();
  if (tab === 'agent-runs') loadAgentWorkflows();
  updateAgentRunsPolling(tab);
  maybeSuggestWideRight(tab); // v3 (§2.7/§2.8): 监控/用量页签在基准档(392px)下一次性软提示切 480
}

// A5: on narrow screens (≤1180px) the tool pane is an overlay drawer toggled by `tools-open`; on the
// desktop grid (≥1181px) it is a column shown/hidden by the `tools-collapsed` class. matchMedia picks.
function isNarrow() { return window.matchMedia('(max-width: 1180px)').matches; }
// 121-K4(34 号文 §2.3／§7.3):手动折叠侧栏的整条路径退役 —— 左栏搬进外框、两视角共用同一份 DOM,
// 宽度由 §7.3 的容器查询决定(≤980 折成 56px 图标栏,内容一个节点不少)。随之删掉的是
// setSidebarCollapsed / restoreSidebarCollapsed 两个函数、它们写的 .sidebar-collapsed 类与
// 本机偏好 wcw.sidebarCollapsed、以及 ☰ 与 « 两枚按钮(见 index.html)。
// 「手机首启默认收起」这件事没有丢:≤980 那一档现在【永远】是图标栏,不需要一个会被记住的偏好。
function toggleToolPane() {
  const shell = document.querySelector('.app-shell');
  if (isNarrow()) shell.classList.toggle('tools-open');
  else {
    shell.classList.toggle('tools-collapsed');
    // 桌面栅格档持久化开合偏好（同 sidebarCollapsed 口径）；窄屏抽屉不记忆。
    try { localStorage.setItem('wcw.toolsCollapsed', shell.classList.contains('tools-collapsed') ? '1' : '0'); } catch { /* ignore */ }
  }
}
// 恢复工具面板开合：用户偏好优先；无偏好时桌面外壳（__ruyiDesktop 注入标记）首启默认收起，浏览器保持展开默认。
function restoreToolsCollapsed() {
  if (isNarrow()) return;
  const shell = document.querySelector('.app-shell'); if (!shell) return;
  let v = null;
  try { v = localStorage.getItem('wcw.toolsCollapsed'); } catch { /* ignore */ }
  if (v === '1') { shell.classList.add('tools-collapsed'); return; }
  if (v === '0') return;
  if (window.__ruyiDesktop) shell.classList.add('tools-collapsed');
}
// Ensure the tool pane is visible (used by "open MCP inspector" / "体检" entry points), respecting
// which mechanism applies at the current width.
function openToolPane() {
  const shell = document.querySelector('.app-shell');
  if (isNarrow()) shell.classList.add('tools-open');
  else shell.classList.remove('tools-collapsed');
}
function closeToolDrawer() { document.querySelector('.app-shell').classList.remove('tools-open'); }

/* ---------------- v3 (§2.7 P2): 右栏三档宽(392/480/全屏)—— 拖拽手柄 + 双击循环 + localStorage 记忆 ---------------- */
// 档位存 'wcw.rightWidth'(值 '392'|'480'|'full')。桌面栅格档专属;窄屏(≤1180)走既有抽屉,仅记偏好不改布局。
// 全屏档 = tool-pane 转 fixed 覆盖中栏(CSS .tools-fullscreen),Esc / 双击手柄退出。
// 121-K4(34 号文 §7.1):两处改动,都是「一台两视共用一个右栏宽度」逼出来的 ——
//   ① 基准档 340 → 392:设计稿定的右栏就是 392px,而这个档位是全仓唯一写 --right-w 的地方。
//      存量偏好里的 '340' 不在表里,会被下面那句 fallback 归一到 '392'(迁移即自愈,不留死值)。
//   ② --right-w 写在【.app-body】而不是 .app-shell 上:两个视角容器都在它里面,于是读的是同一个
//      自定义属性;写在 .app-shell 上的话管家视角看不见它,切视角就会跳一次宽度(实测 340 ↔ 392 差 52px)。
//      内联值同时压得住 layout.css 里 ≥1600 那条容器查询(它也落在 .app-body 上,用户拖过之后不被改回去)。
//      .rp-wide / .tools-fullscreen / .right-resizing 三个类仍然写在 .app-shell 上(它们只管 2.0 那一栏)。
const RIGHT_TIERS = ['392', '480', 'full'];
const RIGHT_FULL_THRESHOLD = 620; // 拖过此像素宽度 → 吸附到全屏档
function applyRightWidth(tier, persist = true) {
  if (!RIGHT_TIERS.includes(tier)) tier = '392';
  const shell = document.querySelector('.app-shell'); if (!shell) return;
  // 宽度写在 .app-body 上(两视角共用);类仍写在 .app-shell 上。缺外框时退回 shell,行为与 K4 之前一致。
  const widthHost = document.querySelector('.app-body') || shell;
  // Chrome 无法可靠过渡「var() 驱动的 grid 轨」的变化(会卡在起始宽度);切档时抑制过渡让新轨宽即时落定。
  // 末尾强制同步重排后立即移除(不用 rAF —— 后台/空闲渲染时 rAF 可能不触发,会把过渡永久关死)。
  // (侧栏折叠的过渡不受影响 —— 它变的是【具体值】首轨 288<->0,不走此路径。)
  shell.classList.add('right-resizing');
  if (tier === 'full' && !isNarrow()) {
    state._preFullTier = (state._rightTier && state._rightTier !== 'full') ? state._rightTier : '480';
    shell.classList.remove('tools-collapsed'); // 全屏必然展开工具面板
    shell.classList.add('tools-fullscreen', 'rp-wide');
    widthHost.style.setProperty('--right-w', '480px'); // 底层保留轨宽(被 fixed 面板覆盖,无空隙)
  } else {
    shell.classList.remove('tools-fullscreen');
    widthHost.style.setProperty('--right-w', (tier === 'full' ? '480' : tier) + 'px');
    shell.classList.toggle('rp-wide', tier === '480' || tier === 'full'); // §2.8 用量瓦片三列开关
  }
  void shell.offsetWidth; // 强制同步重排,让新轨宽在无过渡下即时落定
  shell.classList.remove('right-resizing');
  state._rightTier = tier;
  if (persist) { try { localStorage.setItem('wcw.rightWidth', tier); } catch { /* ignore */ } }
}
function restoreRightWidth() {
  let v = '392'; try { v = localStorage.getItem('wcw.rightWidth') || '392'; } catch { /* ignore */ }
  applyRightWidth(v, false);
}
function cycleRightWidth() {
  const cur = state._rightTier || '392';
  applyRightWidth(RIGHT_TIERS[(RIGHT_TIERS.indexOf(cur) + 1) % RIGHT_TIERS.length]);
}
// Esc 退出右栏全屏(回到进入前的档位)。返回是否处理了(供全局 Esc 链短路)。
function exitRightFullscreen() {
  const shell = document.querySelector('.app-shell');
  if (shell && shell.classList.contains('tools-fullscreen')) { applyRightWidth(state._preFullTier || '392'); return true; }
  return false;
}
// §2.8 软提示:切到监控/用量页签且当前是基准档(392px)时,一次性建议 480(不强切;localStorage 记忆已提示过)。
function maybeSuggestWideRight(tab) {
  if ((tab !== 'agent-runs' && tab !== 'usage') || isNarrow()) return;
  if ((state._rightTier || '392') !== '392') return;
  try { if (localStorage.getItem('wcw.rightWidthHintShown') === '1') return; localStorage.setItem('wcw.rightWidthHintShown', '1'); } catch { /* ignore */ }
  toast(t("toast.widenPanelHint"));
}
function initRightResize() {
  const handle = $('rightResizeHandle'); if (!handle) return;
  handle.addEventListener('dblclick', () => cycleRightWidth());
  handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cycleRightWidth(); } });
  handle.addEventListener('pointerdown', e => {
    if (isNarrow() || e.button !== 0) return;
    e.preventDefault();
    const shell = document.querySelector('.app-shell');
    const widthHost = document.querySelector('.app-body') || shell;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    shell.classList.add('right-resizing');
    shell.classList.remove('tools-fullscreen'); // 拖动即回到可变轨宽预览
    let tier = state._rightTier === 'full' ? '480' : (state._rightTier || '392');
    const onMove = ev => {
      const desired = window.innerWidth - ev.clientX;
      if (desired > RIGHT_FULL_THRESHOLD) { tier = 'full'; widthHost.style.setProperty('--right-w', Math.min(desired, window.innerWidth - 360) + 'px'); }
      else { const clamped = Math.max(300, Math.min(desired, 560)); widthHost.style.setProperty('--right-w', clamped + 'px'); tier = Math.abs(clamped - 480) <= Math.abs(clamped - 392) ? '480' : '392'; }
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
  function normalizeTabsForUiMode(mode) {
    if (mode !== 'simple') return;
    const active = document.querySelector('.tool-pane .tool-tabs button.active');
    if (active && DEV_TABS.has(active.dataset.tab)) switchTab('files');
    const settings = document.getElementById('settingsModal');
    if (settings && !settings.classList.contains('hidden')) {
      const activeSettings = document.querySelector('#settingsTabs button.active');
      if (activeSettings && !SETTINGS_SIMPLE_TABS.has(activeSettings.dataset.stab)) switchSettingsTab('basic');
    }
  }

  return Object.freeze({
    closeModal,
    closeToolDrawer,
    exitRightFullscreen,
    fetchCapabilities,
    initHelpEntries,
    initRightResize,
    normalizeTabsForUiMode,
    noteToolTabOpened,
    openCapPopover,
    openComposerMorePopover,
    openContextPopover,
    openModal,
    openPalette,
    openRenamePopover,
    openToolPane,
    popover,
    renderCapBadge,
    modelMenuExtras,   // 121-K5：chips 模型菜单尾部那三件全局事（强度／删自定义模型／刷新与管理服务商）
    renderPalette,
    refreshToolPane,
    restoreRightWidth,
      restoreToolsCollapsed,
      switchSettingsTab,
    switchTab,
    syncMoreMenuLabels,
    toggleToolPane,
  });
}

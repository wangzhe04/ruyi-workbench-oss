'use strict';

// EC-D：运行时引擎状态、Provider 配置、设置保存与诊断领域。
import { state } from './state.js';
import { bindModelSelect, providerModels, agentModels, publishProviderModels, publishAgentModels, refreshModelSelects } from './model-catalog.js';
import { fillProviderSelect } from './model-catalog.js';   // W6：「模型分配」每一行服务商下拉的唯一选项构建器

import { api, apiErrorInfo } from './net.js';   // 107-S2：掩码闸的拒绝要按【码】分支，不按中文（否则又是一句「请求失败。」）
import { $, el, escapeHtml, autoGrow, setStatus, setStatusDetail, toast, chatProviders } from './util.js';
import { canonicalJson, rebaseProvidersDraft } from './util.js';   // W6：服务商草稿的三方合并（修「草稿过期会回滚」）
import { getLocale, setLocale, t, tCount } from './i18n.js';
// 118b: 体检项 id -> 人话(label/hint/next/severity)的唯一映射表,以及「怎么办」的落点定义。
import { describeHealthItem, healthSummaryText, HEALTH_ACTIONS, HEALTH_ALIAS_IDS } from './health-i18n.js';
// 118b: 「怎么办」跳手册时复用经典壳登记的那一个阅读器实例(见 help-viewer.js 的登记处说明)。
import { openSharedHelpDoc } from './help-viewer.js';
// 118e: 本机零配置预设(Ollama / LM Studio)的三条纯判定 -- 免 Key、探测失败的人话、手册小节锚点。
// 事实源在 onboarding-wizard.js(零 import 的纯函数层),设置页与向导共用同一口径,不各写一份。
import { providerKeyOptional, localEndpointDownKey, LOCAL_MODELS_ANCHOR_KEY, ONBOARDING_MANUAL_DOC_ID } from './onboarding-wizard.js';

// 118a: the ONE place a PROVIDER_PRESETS template turns into a providers[] entry. Extracted from
// addProviderFromPreset() verbatim (zero behavior change) so the welcome wizard writes byte-identical
// provider entries instead of growing a second serializer. `existingIds` is the list of ids already in
// the draft/config; a collision gets the historical `<id>-2`, `<id>-3` suffix.
export function providerDraftFromPreset(preset, existingIds = []) {
  if (!preset) return null;
  const taken = new Set((Array.isArray(existingIds) ? existingIds : []).map(value => String(value || '')));
  let id = preset.id;
  let n = 2;
  while (taken.has(id)) { id = `${preset.id}-${n++}`; }
  return {
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
  };
}

export function createProviderSettingsDomain({
  apiErrText = error => String(error && error.message || error || ''),
  // 121-K5：顶栏那枚 #modelChip 退役，这条注入随之改名 —— 要刷的是线程头那一组 chip（会话级），
  // 刷的理由一字未变：全局配置刚变，「跟随全局」的显示值要跟上。
  onEngineConfigChanged = () => {},
  // 128f-⑫（审计 D）：缺清单弹窗「一键应用」之后「MCP 运维」那张表重读（settings-operations 那一份）。
  refreshMcpOps = async () => {},
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
  // 118b: 体检行「怎么办」要能切到设置里的目标页签。走注入而不是在 DOM 里点那个按钮,是因为需要 force:
  // 简易模式会把非白名单页签(集成 / MCP、更新中心)收敛回「基础」,而体检页的「怎么办」正是 SPEC 说的
  // 「明确的排障逃生门」,必须直达。
  switchSettingsTab = () => {},
  openToolPane = () => {},
  runTool = async () => {},
  updateContextMeter = () => {},
  // 117a: 管家壳是第三种壳模式，它的可选性由 config.stewardEnabledV1 决定。config 只在这里刷新，
  // 所以「第三项能不能选」的同步点也只有这里一处（判据住 steward-shell.js，本文件不复制门）。
  syncStewardShellAvailability = () => {},
  // 117e: the steward settings tab re-seeds from the same config refresh (its own panels lazy-load).
  fillStewardSettings = () => {},
} = {}) {
// 设置 →「集成 / MCP」里桌面组件那一行状态。128f-③ 从 fillSettings 里单拎出来:探测跟进拿到结果后只重画这一行,
// 不整页回填(fillSettings 会把用户正在改的输入框冲回服务端的值)。
function renderDesktopMcpStatus() {
  const dmStat = $('cfgDesktopMcpStatus');
  if (!dmStat) return;
  const info = (state.status && state.status.desktopMcp) || null;
  if (!info || info.enabled === false) dmStat.textContent = t('mcp.notEnabled');
  else if (info.probing) dmStat.textContent = t('mcp.probing');
  else if (info.resolved && info.resolved.command) dmStat.textContent = t('mcp.desktopFound') + info.resolved.command + (info.resolved.args && info.resolved.args.length ? ' ' + info.resolved.args.join(' ') : '');
  else if (info.detected && info.detected.command) dmStat.textContent = t('mcp.probed') + info.detected.command + (info.detected.args && info.detected.args.length ? ' ' + info.detected.args.join(' ') : '');
  else dmStat.textContent = t('mcp.notFound');
}
// 128f-③(48 号文 §2-c):服务端在桌面组件的 Python 探测还在飞时不再让 /api/status 等它,而是回 desktopMcp.probing。
// 这里起一个【有界】跟进(每 1.5 s 一发,至多 60 s,同一时刻只一条),拿到非 probing 的那一份后【只】替换
// desktopMcp／health／mcpConfigPath 三个字段、只重画桌面那一行与体检面板 —— 不调 fillSettings、不动别的字段。
let desktopProbeFollow = null;
const DESKTOP_PROBE_FOLLOW_MS = 1500;
const DESKTOP_PROBE_FOLLOW_TRIES = 40;
function followDesktopMcpProbe() {
  if (desktopProbeFollow || !(state.status && state.status.desktopMcp && state.status.desktopMcp.probing)) return;
  desktopProbeFollow = (async () => {
    try {
      for (let i = 0; i < DESKTOP_PROBE_FOLLOW_TRIES; i++) {
        await new Promise(resolve => setTimeout(resolve, DESKTOP_PROBE_FOLLOW_MS));
        if (!(state.status && state.status.desktopMcp && state.status.desktopMcp.probing)) return; // 别处已刷到结果
        let fresh = null;
        try { fresh = await api('/api/status'); } catch { continue; }
        if (!fresh || !fresh.desktopMcp || fresh.desktopMcp.probing) continue;
        if (!state.status) return;
        state.status.desktopMcp = fresh.desktopMcp;
        state.status.health = fresh.health;
        state.status.mcpConfigPath = fresh.mcpConfigPath;
        renderDesktopMcpStatus();
        renderDoctor();
        return;
      }
    } finally { desktopProbeFollow = null; }
  })();
}
// W6：设置页改成「改了就存」之后，一发慢的 GET /api/status（体检页、导入 MCP 之后都会拉）若在几次即存【之后】才回来，
// 会把 state.config 换回发请求那一刻的旧快照 —— 下一次即存的补丁（主模型写 providers[].model、管家两档合并
// stewardThreadModels、工作区清单）就从这份旧值上构造，等于把刚存的改动又写回去（真浏览器件 settings-ia 抓到过）。
// 判据：请求在飞期间有一次配置保存落了盘，就保留那次保存回包里的 config（它更新），状态其余字段照常换新。
let configWriteSeq = 0;
async function refreshStatus() {
  const seqAtRequest = configWriteSeq;
  const fresh = await api('/api/status');
  if (configWriteSeq !== seqAtRequest && state.config && fresh) fresh.config = state.config;
  state.status = fresh;
  state.config = state.status.config || {};
  for (const provider of state.config.providers || []) provider.models = providerModels(provider);
  applyTheme(state.config.theme || 'dark');
  applyUiMode(state.config.uiMode || 'pro'); // v0.9-S1 (C1)
  renderWorkspacePicker(); // v0.9-S3 (C3): reflect the default/session workspace once config is loaded
  // 121-K5：顶栏那两枚 chip（#modelChip / #permChip）与隐藏的 #permSelect 一起退役 —— 线程的
  // 权限／模型／引擎由线程头那一组 chip 画（会话级），新任务的两个默认值在盾牌与模型菜单里改。
  onEngineConfigChanged();
  updateEngineDependentUI();
  fillSettings();
  renderStatusLine();
  renderStartNotice(); // 118c: 启动提示条(上次启动失败 / 本次改用端口)
  renderDoctor();
  refreshModels(); // background: enrich the model list from the proxy without blocking status
  fetchCapabilities(false); // v0.8-S6: refresh the capability badge (cached; one-shot on status refresh)
  followDesktopMcpProbe(); // 128f-③: 桌面组件还在探测时有界跟进,拿到结果只重画那两处
  try { announceNewToolboxComponents(); } catch (error) { console.warn('[toolbox] announce failed', error); }
  followToolboxStartup(); // toolbox 组件还在起时有界跟进:起好之后语音识别会被自动配上,页面得知道
}
// 开箱即用的最后一步在页面这头:桌面壳一见服务就绪就加载页面,而 toolbox 组件(本地语音识别之类)这时多半还在起 ——
// 服务端要等它健康了才把它配成语音识别端点。不跟进的话,用户看到的是一枚「待开启」的灰麦克风,要刷新页面才变亮。
// 与 followDesktopMcpProbe 同模具:有界(每 1.5 s 一发、至多 30 s、同一时刻只一条),等到没有组件处在 starting／idle 就
// 整份 refreshStatus 一次(config 变了,麦克风、设置页、提示都靠那一趟);自己不改任何状态。
let toolboxFollow = null;
const toolboxSettling = status => ((status && status.toolbox && status.toolbox.components) || []).some(c => c.enabled !== false && (c.state === 'starting' || c.state === 'idle'));
function followToolboxStartup() {
  if (toolboxFollow || !toolboxSettling(state.status)) return;
  toolboxFollow = (async () => {
    try {
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        let fresh = null;
        try { fresh = await api('/api/status'); } catch { continue; }
        if (toolboxSettling(fresh)) continue;
        toolboxFollow = null;
        await refreshStatus();
        return;
      }
    } finally { toolboxFollow = null; }
  })();
}
function normalizeConversationRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = String(raw.model || '').trim();
  if (raw.engine === 'openai') {
    const providerId = String(raw.providerId || '').trim();
    return providerId ? { engine: 'openai', providerId, model } : null;
  }
  if (raw.engine === 'agent' || raw.engine === 'claude') {
    return { engine: 'agent', agentCliType: raw.agentCliType === 'kimi' ? 'kimi' : 'claude', model };
  }
  return null;
}
function currentConversationRoute() {
  const explicit = normalizeConversationRoute(state.currentSession?.engineRoute);
  if (explicit) return explicit;
  const messages = Array.isArray(state.currentSession?.messages) ? state.currentSession.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    const inferred = normalizeConversationRoute(msg.engine === 'openai' || msg.providerId
      ? { engine: 'openai', providerId: msg.providerId, model: msg.model }
      : { engine: 'agent', agentCliType: msg.agentCliType, model: msg.model });
    if (inferred) return inferred;
  }
  const providerId = String(state.config?.activeProvider || '').trim();
  if (providerId && providerId !== 'claude-cli') {
    const provider = (state.config?.providers || []).find(item => item && item.id === providerId);
    return { engine: 'openai', providerId, model: String(provider?.model || '') };
  }
  return { engine: 'agent', agentCliType: state.config?.agentCliType === 'kimi' ? 'kimi' : 'claude', model: String(state.config?.model || '') };
}
// The model id currently in effect for the opened conversation. Global config is only the fallback used
// before a session exists; switching sessions restores that session's pinned route.
function currentModelId() { return currentConversationRoute().model || ''; }
// True when a native OpenAI-compatible provider is the active engine (activeProvider is a non-empty
// string other than the legacy 'claude-cli' sentinel). This is the single gate for provider-mode UI.
function isProviderMode() {
  return currentConversationRoute().engine === 'openai';
}
// The active provider object (or null in Claude mode / if the id is missing).
function activeProviderObj() {
  if (!isProviderMode()) return null;
  const route = currentConversationRoute();
  return (state.config.providers || []).find(p => p.id === route.providerId) || null;
}
const AGENT_CLI_LABELS = { claude: 'Claude Code', kimi: 'Kimi Code' };
function currentAgentCliType() {
  const type = String(currentConversationRoute().agentCliType || state.config?.agentCliType || 'claude');
  return Object.prototype.hasOwnProperty.call(AGENT_CLI_LABELS, type) ? type : 'claude';
}
function currentAgentCliLabel() {
  return AGENT_CLI_LABELS[currentAgentCliType()];
}
function currentAgentCliPath() {
  const type = currentAgentCliType();
  const pathKey = type === 'kimi' ? 'kimiPath' : 'claudePath';
  const detectedKey = type === 'kimi' ? 'detectedKimiPath' : 'detectedClaudePath';
  return state.config?.[pathKey] || state.status?.[detectedKey] || '';
}
// W6：「用哪个命令行引擎」并进了「模型分配」的主模型那一行（原 #cfgAgentCliType 那枚选择器退役），所以这里按
// 【全局】config.agentCliType 显隐 —— 设置页讲的是全局默认，不是正在看的那条线程（修前退回 currentAgentCliType()
// 会跟着线程路由走）。命令行引擎页顶上那一行说明也在这里写（写的是哪一个、去哪儿换）。
function settingsAgentCliType() {
  const type = String((state.config && state.config.agentCliType) || 'claude');
  return Object.prototype.hasOwnProperty.call(AGENT_CLI_LABELS, type) ? type : 'claude';
}
function updateAgentCliSettingsVisibility() {
  const type = settingsAgentCliType();
  { const note = $('agentCliCurrentHint'); if (note) note.textContent = t('settings.agentCli.current', { name: AGENT_CLI_LABELS[type] }); }
  document.querySelectorAll('[data-agent-cli-path]').forEach(node => node.classList.toggle('hidden', node.dataset.agentCliPath !== type));
  document.querySelectorAll('[data-agent-cli-only]').forEach(node => node.classList.toggle('hidden', node.dataset.agentCliOnly !== type));
  const effort = $('cfgThinkingEffort');
  if (effort) {
    const supported = type === 'kimi' ? new Set(['', 'low', 'high', 'max']) : null;
    for (const option of effort.options) {
      const unavailable = Boolean(supported && !supported.has(option.value));
      option.disabled = unavailable;
      option.hidden = unavailable;
    }
    if (supported && !supported.has(effort.value)) effort.value = '';
  }
  const hint = $('agentCliCapabilityHint');
  if (hint) hint.textContent = t(`settings.agentCli.hint.${type}`);
}
// 123-N2:设置页那一行说明 —— 「上次用的」现在【具体是什么】。没有这一行,那个选项就是一句
// 无法验证的承诺(用户看不出它记住的是哪一个),而这正是用户报的那条病的反面。
// 人话【不另起炉灶】:走本文件既有的 engineVisual(meta).label(线程头 chip、消息徽标用的同一份),
// 模型名附在后面。零 innerHTML —— 调用点写的是 textContent。
function lastUsedEngineText() {
  const c = state.config || {};
  const raw = c.lastUsedEngineRoute;
  if (!raw || typeof raw !== 'object') return t('settings.newThreadEngine.lastNone');
  let meta;
  if (raw.engine === 'openai' && raw.providerId) {
    const p = (c.providers || []).find(item => item && item.id === raw.providerId) || null;
    meta = { engine: 'openai', providerId: String(raw.providerId), providerLabel: (p && (p.label || p.id)) || String(raw.providerId), model: String(raw.model || '') };
  } else {
    const type = raw.agentCliType === 'kimi' ? 'kimi' : 'claude';
    meta = { engine: 'claude', agentCliType: type, agentCliLabel: AGENT_CLI_LABELS[type], model: String(raw.model || '') };
  }
  const label = engineVisual(meta).label;
  return t('settings.newThreadEngine.lastIs', { p1: meta.model ? `${label} · ${meta.model}` : label });
}
// 133d（用户 2026-09-21「默认的对话主模型似乎没法在设置里改」）：「对话主模型」—— 全局主端点（activeProvider）
// 与主模型。顶栏 #modelChip 退役（121-K5）后这两个键再没有界面能改；线程头 chip 写的是会话级路由，不动它们。
// 两枚选择器【选中即存】：
//   · 引擎 = 两个命令行引擎之一，或某个能对话的服务商（只做语音的、toolbox- 自动接入的不列）；
//   · 模型 = 该服务商 models 里的一条（写进 providers[].model），命令行引擎时是它自己的模型清单（写 config.model）。
// W6（引擎三处合一处）：修前「用哪个命令行引擎」是 Agent CLI 页另一枚 #cfgAgentCliType（走页脚整份保存），与这里那一项
// 「Agent CLI（兼容用）」、Agent CLI 页的「新线程默认引擎」三处各管一截。现在两个命令行引擎在这枚下拉里各是一项：
// 选它 = 一次写 activeProvider:'' ＋ agentCliType ＋ config.model；「新线程默认引擎」就在这一行正下方。
// 这一行随「模型分配」页搬家；服务商草稿不再需要在这里手动同步 —— saveConfigPartial 成功之后统一三方合并（见 syncProvidersDraft）。
// 命令行两项的值带一个 US 分隔符前缀（fromCharCode(31) 构造，与 ASR_VALUE_SEP 同一条纪律），不会与任何服务商 id 撞车。
const CLI_ENGINE_PREFIX = String.fromCharCode(31) + 'cli:';
const cliEngineValue = type => CLI_ENGINE_PREFIX + type;
function parseMainEngineValue(value) {
  const raw = String(value || '');
  if (raw.startsWith(CLI_ENGINE_PREFIX)) {
    const type = raw.slice(CLI_ENGINE_PREFIX.length);
    return { cli: Object.prototype.hasOwnProperty.call(AGENT_CLI_LABELS, type) ? type : 'claude', providerId: '' };
  }
  return raw ? { cli: '', providerId: raw } : { cli: settingsAgentCliType(), providerId: '' };
}
function fillMainEngineSelects() {
  const provSel = $('cfgMainProvider'), modelSel = $('cfgMainModel'), hint = $('mainEngineHint');
  if (!provSel || !modelSel) return;
  const c = state.config || {};
  const cur = String(c.activeProvider || '');
  const pid = cur && cur !== 'claude-cli' ? cur : '';
  fillProviderSelect(provSel, {
    lead: Object.keys(AGENT_CLI_LABELS).map(type => ({ value: cliEngineValue(type), label: t('settings.models.cliOption', { name: AGENT_CLI_LABELS[type] }) })),
    providers: chatProviders(c),
    value: pid || cliEngineValue(settingsAgentCliType()),
    savedLabel: value => t('settings.steward.providerSaved', { value }),
  });
  const fillModels = () => {
    const pick = parseMainEngineValue(provSel.value);
    const provider = () => (state.config.providers || []).find(p => p.id === pick.providerId);
    // 换到另一个命令行引擎时，旧引擎的模型名对新引擎没有意义：清成它自己的缺省。
    const sameCli = Boolean(pick.cli) && pick.cli === settingsAgentCliType();
    bindModelSelect(modelSel, {
      provider,
      ...(pick.providerId ? {} : { models: () => agentModels(pick.cli, sameCli ? (state.status?.models || []) : []) }),
      value: pick.providerId ? provider()?.model || '' : (sameCli ? state.config.model || '' : ''),
      emptyLabel: () => t(pick.providerId ? 'settings.models.providerDefault' : 'settings.mainEngine.defaultModel'),
    });
  };
  fillModels();
  if (hint) hint.textContent = t(c.newThreadEngine === 'global' ? 'settings.mainEngine.hintGlobal' : 'settings.mainEngine.hintLast');
  provSel.onchange = () => { fillModels(); void setGlobalEngineDefault(provSel.value, modelSel.value); };
  modelSel.onchange = () => { void setGlobalEngineDefault(provSel.value, modelSel.value); };
}
async function setGlobalEngineDefault(engineValue, modelId) {
  const pick = parseMainEngineValue(engineValue);
  const pid = pick.providerId, model = String(modelId || '');
  const patch = { activeProvider: pid };
  if (pid) patch.providers = (Array.isArray(state.config.providers) ? state.config.providers : []).map(p => (p && p.id === pid ? { ...p, model } : p));
  else { patch.model = model; patch.agentCliType = pick.cli; }
  const cliChanged = !pid && pick.cli !== settingsAgentCliType();
  // 修前页脚「保存」里的那一段原样搬来：全局命令行引擎换了、而正打开的这条线程走的就是命令行引擎 —— 这条线程跟着换。
  // 判据必须在落盘【之前】取：没钉路由的线程会回落到全局，落盘之后再问就问成了新值。
  const followOpened = cliChanged && Boolean(state.currentSession?.id && currentConversationRoute().engine === 'agent');
  const provSel = $('cfgMainProvider'), modelSel = $('cfgMainModel');
  if (provSel) provSel.disabled = true; if (modelSel) modelSel.disabled = true;
  const saved = await saveConfigPartial(patch);
  if (provSel) provSel.disabled = false; if (modelSel) modelSel.disabled = false;
  if (!saved) { fillMainEngineSelects(); return false; }
  if (cliChanged) {
    updateAgentCliSettingsVisibility();
    if (followOpened) await followOpenedAgentRoute(pick.cli);
    void refreshModels();
  }
  updateEngineDependentUI();
  toast(t('settings.mainEngine.toast'), 'ok');
  return true;
}
async function followOpenedAgentRoute(type) {
  if (!state.currentSession?.id) return;
  const engineRoute = { engine: 'agent', agentCliType: type === 'kimi' ? 'kimi' : 'claude', model: currentModelId() };
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(state.currentSession.id)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-http-method': 'PATCH' }, body: JSON.stringify({ engineRoute }),
    });
    if (result?.session) state.currentSession = result.session;
    else state.currentSession.engineRoute = engineRoute;
  } catch (error) { toast(t('toast.saveFail', { p1: apiErrText(error) }), 'err'); }
}
// W6「模型分配」里 provider-settings 管的另两行：上下文压缩、子代理（管家三行归 steward-settings.js，句尾改错归语音那一段）。
// 同一个组件：左边 fillProviderSelect、右边 bindModelSelect；服务商一换模型清空（＝那一家的缺省模型），选中即存。
function bindAssignRow(provSel, modelSel, { providers, providerValue, modelValue, follow, followModelKey, onPick }) {
  if (!provSel || !modelSel) return;
  fillProviderSelect(provSel, { providers: providers(), value: providerValue, follow, savedLabel: value => t('settings.steward.providerSaved', { value }) });
  const fillModels = value => bindModelSelect(modelSel, {
    provider: () => providers().find(p => p && p.id === provSel.value) || null,
    value, emptyLabel: () => t(provSel.value ? 'settings.models.providerDefault' : followModelKey),
  });
  fillModels(String(modelValue || ''));
  provSel.onchange = () => { fillModels(''); void onPick({ provider: String(provSel.value || ''), model: '' }); };
  modelSel.onchange = () => { void onPick({ provider: String(provSel.value || ''), model: String(modelSel.value || '') }); };
}
function fillCompactAssignRow() {
  const c = state.config || {};
  bindAssignRow($('cfgCompactProviderId'), $('cfgCompactModel'), {
    // 与电量表弹层那一枚同一份候选（能对话、没停用的服务商）；两处写的是同一对键。
    providers: () => chatProviders(state.config).filter(p => p.enabled !== false),
    providerValue: c.compactProviderId, modelValue: c.compactModel,
    follow: t('settings.models.compactFollow'), followModelKey: 'settings.models.followModel',
    onPick: ({ provider, model }) => saveConfigPartial({ compactProviderId: provider, compactModel: provider ? model : '' }),
  });
}
// 子代理那一行的选项与模型清单仍由 agent-roles.js 的 populateSubagentPreferenceSelects 建（D32 锁：那个函数归角色域），
// 这里只接「选中即存」。服务商一换，模型【一并】写空 —— 不读模型下拉的当前值（那枚下拉与这里谁先被通知不确定）。
let subagentRowWired = false;
function wireSubagentAssignRow() {
  if (subagentRowWired) return;
  const provSel = $('cfgSubagentPreferredProvider'), modelSel = $('cfgSubagentPreferredModel');
  if (!provSel || !modelSel) return;
  subagentRowWired = true;
  provSel.addEventListener('change', () => { void saveConfigPartial({ subagentPreferredProvider: String(provSel.value || '').trim().slice(0, 120), subagentPreferredModel: '' }); });
  modelSel.addEventListener('change', () => { void saveConfigPartial({ subagentPreferredModel: String(modelSel.value || '').trim().slice(0, 160) }); });
}
// Human-readable name of the current engine: the provider's label (fallback id) or selected Agent CLI.
function engineLabel() {
  const route = currentConversationRoute();
  const p = activeProviderObj();
  if (p) return p.label || p.id;
  return isProviderMode() ? route.providerId : currentAgentCliLabel();
}
// Meta describing the CURRENT engine, shaped like the per-message meta the server now sends, so the
// live streaming container and empty state can reuse the same badge/avatar renderer.
function currentEngineMeta() {
  const route = currentConversationRoute();
  const p = activeProviderObj();
  if (p) return { engine: 'openai', providerId: p.id, providerLabel: p.label || p.id, agentCliLabel: currentAgentCliLabel(), model: route.model || p.model || '' };
  if (isProviderMode()) return { engine: 'openai', providerId: route.providerId, providerLabel: route.providerId, agentCliLabel: currentAgentCliLabel(), model: route.model };
  return { engine: 'claude', agentCliType: route.agentCliType, agentCliLabel: currentAgentCliLabel(), model: route.model };
}
// Map an engine meta -> { letter, colorVar, label } for the avatar + badge (§3). Providers are keyed
// by id/label keyword so DeepSeek/Qwen/GLM get their brand color; anything else is the neutral custom.
function engineVisual(meta) {
  meta = meta || {};
  if (meta.engine === 'claude' || (!meta.engine && !meta.providerId)) {
    const type = meta.agentCliType || currentAgentCliType();
    const label = meta.agentCliLabel || AGENT_CLI_LABELS[type] || 'Agent CLI';
    return { letter: type === 'kimi' ? 'K' : 'C', colorVar: 'var(--accent)', label }; // Agent CLI drivers share the local-engine color family.
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
  onEngineConfigChanged();
  // If the empty state is currently showing, rebuild it so its engine line + CTA track the switch.
  const box = $('messages');
  if (box && box.querySelector('.empty-state') && (!state.currentSession || !(state.currentSession.messages || []).length)) {
    box.innerHTML = ''; box.appendChild(buildEmptyState());
  }
}
// Enrich the model list from GET /api/models (proxy ∪ offline for Claude; provider models ∪ live for a
// provider). Best-effort. For a provider it also folds the fresh models into that provider's config
// entry so the chip popover shows them. `announce` shows a toast (used by the popover's ↻ action).
async function refreshModels(announce, context = {}) {
  // 124（用户 2026-09-14 走查①的前端那一半，与 GET /api/models 的服务端改动成对）：刷新要打在
  // 【正在看的这条会话】的引擎路由上 —— 服务端现在认 ?sessionId=（与 GET /api/status 同一个判据），
  // 不带会话时才退回全局路由。切换会话后仍更新原服务商目录，只有当前会话的状态栏刷新需要作废。
  const routeSessionId = String(context.sessionId || state.currentSession?.id || '');
  const requestedProvider = context.route?.engine === 'openai' ? (state.config.providers || []).find(p => p.id === context.route.providerId) : activeProviderObj();
  const requestedEndpoint = requestedProvider ? { ...requestedProvider } : null;
  const routeQuery = routeSessionId ? `?sessionId=${encodeURIComponent(routeSessionId)}` : '';
  try {
    const r = await api('/api/models' + routeQuery);
    const fresh = r && Array.isArray(r.models) ? r.models : [];
    // ok:false 只说明【探测那一步】没成（典型：Kimi Code CLI 没检测到），载荷里的 models 仍是这个端点
    // 自己的离线兜底清单 —— 有货就照样折回列表，只有「既没成也没货」才算刷新失败。
    if (r && r.ok === false && !fresh.length) throw new Error(r.error || t('modelMenu.refreshUnchanged'));
    if (fresh.length) {
      if (r.engine === 'openai' && r.provider) {
        // Fold the live list into the ROUTED provider's models so the chip popover reflects it.
        // 修前 r.provider 是【全局 activeProvider】那一个，折回的也就是全局那一份；线程头把这条线程切到
        // 别的 provider 之后，菜单读的是自己那条路由的 providers[].models —— 两边永不见面。
        // 2026-09-20：折回时按 id 把原来那条的 caps（能力标记，如 ['asr']）带上 —— 刷新回来的清单是「名字清单」，
        // 不是能力的事实源；修前一折回，语音识别选择器的候选就从内存里消失，随后的整份保存再把盘上的也抹掉。
        const provider = (state.config.providers || []).find(p => p.id === r.provider);
        if (provider && requestedEndpoint?.id === provider.id && requestedEndpoint.baseUrl === provider.baseUrl && requestedEndpoint.apiKey === provider.apiKey) publishProviderModels(provider, fresh, state.providersDraft || []);
      } else if (state.status) {
        publishAgentModels(r.agentCliType || 'claude', fresh);
        if (!routeSessionId || state.currentSession?.id === routeSessionId) state.status.models = fresh;
      }
      onEngineConfigChanged();
      if (announce) toast(r.proxyCount ? tCount('modelMenu.refreshSuccessProxy', r.proxyCount) : t('modelMenu.refreshSuccessBuiltin'), 'ok');
    } else if (announce) { toast(t('modelMenu.refreshUnchanged'), ''); }
    // /api/models may have populated the server's per-model context probe cache. Pull just the freshly
    // resolved limit so the context meter does not keep the pre-refresh table/fallback value.
    // 这一发也要带 sessionId：不带拿回来的是【新任务默认值】那条路由的分母，会把这条线程刚对齐好的
    // 电量分母又盖回全局那一个（session-experience.js 换会话时用的正是带 sessionId 的同一条路）。
    try {
      const status = await api('/api/status' + routeQuery);
      if (routeSessionId && state.currentSession?.id !== routeSessionId) return;
      if (state.status && status) state.status.contextWindowResolved = status.contextWindowResolved;
      updateContextMeter();
    } catch { /* model discovery still succeeded; keep the previous best-effort denominator */ }
  } catch (e) { if (announce) toast(t('modelMenu.refreshFailed', { error: apiErrText(e) }), 'err'); }
}
// Keep the compact sidebar status line language-aware as well as engine-aware. It is invoked after
// status refreshes and on locale changes, rather than leaving a startup-language string behind.
// 118c: 启动提示条。事实源是 GET /api/status 的 startNotice(进程内一次性数据 -- 服务端读出
// last-start-error.json 后立刻把文件删了,所以整台机器上同一条失败只会说一次)。
// kind -> 文案键走查表:kind 是带连字符的机器码,文案键保持点号 + 驼峰的目录习惯。
const START_NOTICE_ERROR_KEYS = Object.freeze({
  'port-unavailable': 'startNotice.error.portUnavailable',
  'data-dir-unwritable': 'startNotice.error.dataDirUnwritable',
  'startup-failed': 'startNotice.error.startupFailed',
});
let startNoticeDismissed = false;
function startNoticeEntries() {
  const notice = state.status && state.status.startNotice;
  const out = [];
  if (!notice || typeof notice !== 'object') return out;
  const fallback = notice.portFallback;
  if (fallback && Number.isFinite(Number(fallback.actual)) && Number.isFinite(Number(fallback.requested))) {
    out.push({ text: t('startNotice.portFallback', { actual: String(fallback.actual), requested: String(fallback.requested) }), next: '' });
  }
  const failure = notice.lastError;
  if (failure && typeof failure === 'object' && failure.kind) {
    const key = START_NOTICE_ERROR_KEYS[failure.kind];
    // 未知 kind(旧版本写的文件/手工改过)时退回服务端写在文件里的那句话 -- 它本来就是给用户看的人话。
    out.push({ text: key ? t(key) : String(failure.message || ''), next: String(failure.next || '') });
  }
  return out.filter(entry => entry.text);
}
function renderStartNotice() {
  const bar = $('startNoticeBar');
  const body = $('startNoticeBody');
  if (!bar || !body) return;
  const entries = startNoticeDismissed ? [] : startNoticeEntries();
  bar.classList.toggle('hidden', entries.length === 0);
  body.replaceChildren(...entries.map(entry => {
    const row = el('div', 'start-notice-row');
    row.append(el('span', 'start-notice-text', entry.text));
    if (entry.next) row.append(el('span', 'start-notice-next muted', entry.next));
    return row;
  }));
  const dismiss = $('startNoticeDismiss');
  if (dismiss) dismiss.onclick = () => { startNoticeDismissed = true; renderStartNotice(); };
}
// 121-K5（§13.7 登记⑦）：这一行从「服务商 · 模型」改回它本来该说的那件事 —— 【连上了没有】。
// 它现在落在线程头第二行右端那个真看得见的位置（K4 之前它是侧栏底部、K4 之后是顶栏里一个 sr-only
// 的藏身处），所以印什么就真的会被看见：模型名（§2.2 末条）与命令行引擎的可执行文件路径
// （§8.1 第 4 条）都不许上可见层，它们进 title（setStatusDetail）——悬停与读屏照样问得到。
function renderStatusLine() {
  if (isProviderMode()) {
    const p = activeProviderObj();
    const label = (p && (p.label || p.id)) || t('status.currentProvider');
    // 121 走查1-⑤：两个来源的次序修前反了 —— p.model 是【新线程的默认值】（全局 config），
    // currentModelId() 才是【正在看的这条线程】真会用的那一个（currentConversationRoute() 先读
    // state.currentSession.engineRoute）。次序反着写时，在线程头把这条线程切到别的模型，这一行的
    // title 仍然报全局默认那一个（真浏览器实测 walkthrough-round1.browser 的 F6）。
    const model = currentModelId() || (p && p.model) || t('provider.defaultModel');
    setStatus(t('status.connected'), 'ok');
    setStatusDetail(`${label} · ${model}`);
    return;
  }
  const ok = currentAgentCliPath();
  if (ok) {
    setStatus(t('status.connected'), 'ok');
    setStatusDetail(`${currentAgentCliLabel()}: ${ok}`);
    return;
  }
  setStatus(t('status.agentCliMissing', { engine: currentAgentCliLabel() }), 'warn');
  setStatusDetail('');
}
/* ---------------- 121-K5（34 号文 §2.5／§3.1）：权限自此只有两处 ---------------- */
// 顶栏那枚 #permChip、它背后的隐藏载体 #permSelect／#permSelectHost 与那张四档单选卡一起退役。
// 修前同一屏上有两套权限控件、两种语义：顶栏那一套改的是【新会话的默认值】（POST /api/config），
// 线程 chip 改的是【这条线程】（PATCH /api/sessions/:id）—— 33 号文 §0 记下的那笔账。收法：
//   · 新任务默认权限 → 外框顶栏的盾牌（js/steward-settings.js 的 setDefaultPermission，唯一写口）；
//   · 这条线程的权限 → 线程头那一枚 chip（js/steward-chips.js，唯一写口）。
// 本函数留着【名字与调用点】（命令面板的「权限」、错误恢复的「去改权限」、118a 向导），把人送到
// 线程那一枚上 —— 「这一步被拒了」要改的是这条线程，不是以后所有的新线程。
function openPermPopover() {
  const chip = document.querySelector('#threadChips [data-chip="permission"]');
  if (!chip) return false;
  chip.click();
  return true;
}
// 用一份新的模型清单换掉旧的时候，按 id 把旧条目上的能力标记（caps）带过去。新清单自己带了 caps 的以新的为准。
function keepModelCaps(next, previous) {
  const caps = new Map();
  for (const m of (Array.isArray(previous) ? previous : [])) {
    if (m && typeof m === 'object' && Array.isArray(m.caps) && m.caps.length) caps.set(String(m.id || ''), m.caps);
  }
  if (!caps.size) return next;
  const out = (Array.isArray(next) ? next : []).map(m => (m && typeof m === 'object' && !Array.isArray(m.caps) && caps.has(String(m.id || '')) ? { ...m, caps: caps.get(String(m.id || '')).slice() } : m));
  // 2026-09-21（用户真机）：刷新回来的是服务商的「名字清单」，用户亲手标成可语音识别的模型未必在里面（手填的
  // qwen3-asr-flash、百炼清单里没有的名字）。修前一折回它就从内存里没了 → 选择器回落「无候选」→ 再添加、再折回，
  // 永远配不上。带标记的条目是用户标的、不是发现来的，不在新清单里就补回末尾（盘上那份本来就还有它）。
  // 手动清单那条路（用户逐行删）在调用处自己按打出来的行再筛一遍，删除语义不受这里影响。
  const have = new Set(out.map(m => String((m && typeof m === 'object' ? m.id : m) || '')));
  for (const m of (Array.isArray(previous) ? previous : [])) {
    if (m && typeof m === 'object' && Array.isArray(m.caps) && m.caps.length && !have.has(String(m.id || ''))) out.push(m);
  }
  return out;
}
async function saveConfigPartial(patch) {
  try {
    const res = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
    state.config = res.config;
    configWriteSeq += 1;   // W6：在飞的 refreshStatus 回来时认得出「我那份 config 已经过期」（见 refreshStatus 头注）
    for (const provider of state.config.providers || []) provider.models = providerModels(provider);
    refreshModelSelects();
    // 117j B2（权限口径同步）：谁写全局配置都在这一处刷一次读面，不必给每个调用方各补一遍
    // （那正是当初漏掉三处的原因）。121-K5：要刷的那一面从退役的 #permChip 换成线程头那一组
    // chip —— 权限档与引擎路由的「跟随全局」显示值都是从 state.config 读出来的。
    onEngineConfigChanged();
    // W6（修「草稿过期会回滚」）：同一个道理用在设置页的服务商草稿上 —— 推理强度、线程头「设为新任务默认」之外的
    // 全局写口、删模型行、主模型、语音识别……都经这里，所以草稿在这一处统一对齐一次，不再逐个写口各补一段。
    syncProvidersDraft(state.config.providers);
    flashSettingsSaved();
    return true;
  } catch (e) {
    // 107-S2（46 号文 §5 ⑦b M5）：服务端拒绝了这一次保存，因为某条 Provider 的地址变了、而密钥框里
    // 回传的还是掩码。这一族【不能只用 toast】——toast 2 秒就没了，而用户接下来要做的是「回到那条
    // Provider 重填一次密钥」。所以同一句话再写进设置页的状态行（常驻到下一次保存），并且按稳定码
    // 分支、不匹配中文。服务端已经给了完整人话，前端不另造第二份文案（也就不新增 i18n 键）。
    const info = apiErrorInfo(e);
    if (info.code === 'config.masked_secret_vector_changed') {
      const bar = $('settingsStatus');
      if (bar) bar.textContent = info.message;
    }
    toast(t("toast.saveFail", { p1: apiErrText(e) }), 'err');
    return false;
  }
}

/* ---------------- W6：服务商草稿（设置页唯一一处还要「改完再保存」的地方）---------------- */
// 草稿三件事：
//   · providersDraftBase  —— 草稿上一次与配置对齐时那份 providers 的快照（三方合并的共同祖先）；
//   · providersDraftDirty —— 用户在卡片上真的动过（输入、增删卡片）；只有这种改动才需要「保存服务商」；
//   · 对齐（syncProvidersDraft）—— 配置一变（任何写口经 saveConfigPartial、refreshStatus、打开设置），草稿干净就整份换成新值，
//     草稿脏就三方合并（util.js 的 rebaseProvidersDraft）：用户没动过的字段跟新值走、动过的留用户的。
// 修前（缺陷①）：推理强度、全局切模型、删模型行、线程头「设为新任务默认」这几个写口只改 config 不碰草稿，openModal 又在
// fillSettings 之前摘 hidden（「弹窗隐藏才播种」恒为假）—— 草稿停在第一次打开设置时的样子，之后按页脚「保存」就把旧的
// model／reasoningEffort／hiddenModels 整份写回去。草稿对象【就地】更新（卡片的输入回调抓着的就是它们），焦点在卡片里时不重画。
const isToolboxProvider = p => Boolean(p && String(p.id || '').startsWith('toolbox-'));
const cloneJson = value => JSON.parse(JSON.stringify(value));
function adoptProvidersInPlace(current, next) {
  const live = new Map((Array.isArray(current) ? current : []).filter(p => p && p.id).map(p => [String(p.id), p]));
  return next.map(p => {
    const same = p && p.id ? live.get(String(p.id)) : null;
    if (!same || same === p) return p;
    for (const key of Object.keys(same)) if (!Object.prototype.hasOwnProperty.call(p, key)) delete same[key];
    Object.assign(same, p);
    return same;
  });
}
function seedProvidersDraft(providers) {
  state.providersDraft = cloneJson(Array.isArray(providers) ? providers : []);
  state.providersDraftBase = cloneJson(Array.isArray(providers) ? providers : []);
  state.providersDraftDirty = false;
}
function providersListFocused() {
  const box = $('providersList');
  const active = document.activeElement;
  return Boolean(box && active && active !== document.body && box.contains(active));
}
function syncProvidersDraft(nextProviders) {
  if (state.providersDraftSeeded !== true || !Array.isArray(state.providersDraft) || !Array.isArray(nextProviders)) return false;
  let changed = false;
  if (state.providersDraftDirty !== true) {
    changed = canonicalJson(state.providersDraft) !== canonicalJson(nextProviders);
    if (changed) state.providersDraft = adoptProvidersInPlace(state.providersDraft, cloneJson(nextProviders));
  } else {
    const merged = rebaseProvidersDraft(state.providersDraftBase || [], state.providersDraft, nextProviders, { serverOwned: isToolboxProvider });
    changed = merged.changed;
    if (changed) state.providersDraft = adoptProvidersInPlace(state.providersDraft, merged.providers);
  }
  state.providersDraftBase = cloneJson(nextProviders);
  if (changed && !providersListFocused()) renderProviders();
  paintProvidersDirty();
  return changed;
}
function markProvidersDirty() {
  if (state.providersDraftSeeded !== true) return;
  state.providersDraftDirty = true;
  paintProvidersDirty();
}
// 保存条、导航页签上的小圆点与两枚按钮读同一个真值：草稿有没有用户动过、还没存的改动。
function paintProvidersDirty() {
  const dirty = state.providersDraftSeeded === true && state.providersDraftDirty === true;
  const bar = $('providersSaveBar'); if (bar) bar.dataset.dirty = dirty ? 'true' : 'false';
  const note = $('providersDirtyNote'); if (note) note.textContent = t(dirty ? 'settings.providers.dirty' : 'settings.providers.clean');
  const save = $('saveConfigBtn'); if (save) save.disabled = !dirty;
  const discard = $('providersDiscardBtn'); if (discard) discard.disabled = !dirty;
  const tab = document.querySelector('#settingsTabs button[data-stab="providers"]');
  if (tab) { if (dirty) tab.dataset.dirty = 'true'; else delete tab.dataset.dirty; }
}
function discardProvidersDraft() {
  const providers = state.config && state.config.providers;
  seedProvidersDraft(providers);
  state.providersDraftSeeded = Array.isArray(providers);
  renderProviders();
  paintProvidersDirty();
}
let providersDraftUiWired = false;
function wireProvidersDraftUi() {
  if (providersDraftUiWired) return;
  const box = $('providersList');
  if (!box) return;
  providersDraftUiWired = true;
  // 事件委托：卡片会整张重画，监听挂在容器上。只认用户的输入／选择（程序回填下拉不派发事件）。
  box.addEventListener('input', markProvidersDirty);
  box.addEventListener('change', markProvidersDirty);
  const discard = $('providersDiscardBtn');
  if (discard) discard.onclick = () => discardProvidersDraft();
}
// 保存成功的轻量回执：设置弹窗开着时在页脚状态行闪一句（每一处「改了就存」共用这一句，不各自弹 toast）。
let settingsSavedTimer = null;
function flashSettingsSaved() {
  const modal = $('settingsModal');
  const bar = $('settingsStatus');
  if (!modal || !bar || modal.classList.contains('hidden')) return;
  bar.textContent = `${t('common.saved')} ✓`;
  if (settingsSavedTimer) clearTimeout(settingsSavedTimer);
  settingsSavedTimer = setTimeout(() => { settingsSavedTimer = null; if (bar.textContent === `${t('common.saved')} ✓`) bar.textContent = ''; }, 2000);
}
// 等你回话的两条时限（permissionTimeoutMs／questionTimeoutMs；0 = 不限时是出厂值）。档位只是候选：落盘值不在档位里（手改过
// config.json、或管家改过）就补一条显示它本身，不静默改写；钳位只在服务端 normalizeConfig 做。
const PERMISSION_WAIT_CHOICES = Object.freeze([0, 30000, 60000, 120000, 300000, 600000]);
const QUESTION_WAIT_CHOICES = Object.freeze([0, 300000, 900000, 1800000, 3600000]);
function waitChoiceLabel(ms) {
  if (!(ms > 0)) return t('settings.security.wait.none');
  return ms % 60000 === 0 ? t('settings.security.wait.minutes', { n: ms / 60000 }) : t('settings.security.wait.seconds', { n: Math.round(ms / 1000) });
}
function fillWaitSelect(id, choices, current) {
  const select = $(id);
  if (!select) return;
  const value = Number(current) > 0 ? Math.round(Number(current)) : 0;
  const values = choices.includes(value) ? [...choices] : [...choices, value].sort((a, b) => a - b);
  select.replaceChildren(...values.map(ms => { const option = el('option', '', waitChoiceLabel(ms)); option.value = String(ms); return option; }));
  select.value = String(value);
}

/* 第61波：Agent 角色设置与子代理偏好选择已拆入 ./js/agent-roles.js。 */
function fillSettings() {
  const c = state.config;
  // W6：fillSettings 会在弹窗开着时重入（打开、任一次 refreshStatus）。别处的控件都已「改了就存」，唯一会丢的是
  // 【正在打字、还没失焦】的那一格 —— 回填前记下它，回填后原样放回去。
  const focused = document.activeElement;
  const keepTyping = focused && /^(INPUT|TEXTAREA)$/.test(focused.tagName) && !/^(checkbox|radio)$/.test(focused.type || '')
    && $('settingsModal') && $('settingsModal').contains(focused) && !($('providersList') && $('providersList').contains(focused))
    ? { node: focused, value: focused.value } : null;
  bindInstantSettings();
  wireProvidersDraftUi();
  wireSubagentAssignRow();
  updateAgentTeamButton();
  $('workspaceInput').value = c.defaultWorkspace || '';
  renderWorkspacePerms(); // v2.7 workspace permissions
  { const el0 = $('cfgLocale'); if (el0) el0.value = ['auto', 'zh-CN', 'en-US'].includes(c.locale) ? c.locale : 'auto'; }
  { const el0 = $('cfgUiMode'); if (el0) el0.value = (c.uiMode === 'simple' ? 'simple' : 'pro'); } // v0.9-S1
  { const el0 = $('cfgOutputStyle'); if (el0) el0.value = (c.outputStyle === 'concise' ? 'concise' : 'detailed'); } // v0.9-S1
  $('claudePathInput').value = c.claudePath || state.status?.detectedClaudePath || '';
  $('kimiPathInput').value = c.kimiPath || state.status?.detectedKimiPath || '';
  // W6：权限与安全页的两条等待时限；用量与限额页的回合看门狗（turnIdleTimeoutMs，按分钟显示）。
  fillWaitSelect('cfgPermissionTimeout', PERMISSION_WAIT_CHOICES, c.permissionTimeoutMs);
  fillWaitSelect('cfgQuestionTimeout', QUESTION_WAIT_CHOICES, c.questionTimeoutMs);
  { const el0 = $('cfgTurnIdleMinutes'); if (el0) el0.value = String(Math.max(1, Math.min(60, Math.round((Number(c.turnIdleTimeoutMs) || 600000) / 60000)))); }
  try { fillCompactAssignRow(); } catch (err) { console.warn('compact assign row', err); }   // W6：模型分配 · 上下文压缩
  // 123-N2:新线程默认引擎(last/global)＋「上次用的」现在是什么。
  { const el0 = $('cfgNewThreadEngine'); if (el0) el0.value = c.newThreadEngine === 'global' ? 'global' : 'last'; }
  { const el0 = $('newThreadEngineHint'); if (el0) el0.textContent = lastUsedEngineText(); }
  try { fillMainEngineSelects(); } catch (err) { console.warn('main engine selects', err); }   // 133d：「对话主模型」（W6 起在模型分配页）
  updateAgentCliSettingsVisibility();
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
  // 105f: 摘要单发上限三档(16K/32K/64K);非法值落回 32K(与后端 sanitize 钳位同默认值)。
  { const el0 = $('cfgSummarySingleShotMax'); if (el0) el0.value = ['16384', '32768', '65536'].includes(String(c.summarySingleShotMaxTokensV1)) ? String(c.summarySingleShotMaxTokensV1) : '32768'; }
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
  renderDesktopMcpStatus();
  // Advanced tab: read-only diagnostics.
  const s = state.status || {};
  const dr = $('advDataRoot'); if (dr) dr.textContent = s.dataRoot || '';
  const av = $('advVersion'); if (av) av.textContent = 'v' + (s.version || '') + ' · ' + (s.launchMode || '');
  const ao = $('advOverlayId'); if (ao) ao.textContent = s.overlayId || '';
  // 月度成本预算（W6 起在「用量与限额」页，简易模式可见）+ Claude 第三方端点可选单价（Agent CLI 页）。留空=不设/不估。
  { const b = c.usageBudget || {}; const m = $('cfgUsageBudgetMonthly'); if (m) m.value = (b.monthly === 0 || b.monthly) ? String(b.monthly) : ''; const cur = $('cfgUsageBudgetCurrency'); if (cur) cur.value = b.currency || 'CNY'; }
  { const cpr = c.claudePricing || {}; const pi = $('cfgClaudePriceIn'); if (pi) pi.value = (cpr.inputPerM === 0 || cpr.inputPerM) ? String(cpr.inputPerM) : ''; const po = $('cfgClaudePriceOut'); if (po) po.value = (cpr.outputPerM === 0 || cpr.outputPerM) ? String(cpr.outputPerM) : ''; const pc = $('cfgClaudePriceCurrency'); if (pc) pc.value = cpr.currency || 'CNY'; }
  populateProviderPresets();
  // 114a: 「语音识别」选择器随 config 重渲染(有可语音识别模型才出现;纯读 state.config,不碰 providers 草稿)。
  // 与 117j 管家旁路同款保护:这里抛错不该带走后面的草稿播种与 renderProviders()。
  try { renderAsrSettings(); }
  catch (error) { console.warn('[asr] renderAsrSettings failed', error); }
  try { renderAsrFixAssignRow(); }   // W6：模型分配 · 句尾改错那一行（同一层旁路保护）
  catch (error) { console.warn('[asr] renderAsrFixAssignRow failed', error); }
  try { renderToolboxSettings(); }   // ruyi-toolbox 扩展组件一栏(没登记任何组件时整块不渲染)
  catch (error) { console.warn('[toolbox] renderToolboxSettings failed', error); }
  // 117j classic-2（经典壳回归审查 P1）：这两条是【管家壳的】旁路，谁抛错都不该把它后面的
  // 草稿播种与 renderProviders() 一起带走 —— 那两样是经典壳设置页的正事。各自包一层，只 warn。
  try { syncStewardShellAvailability(); } // 117a: 壳模式第三项（管家）随 stewardEnabledV1 置灰/放开
  catch (error) { console.warn('[steward] syncStewardShellAvailability failed', error); }
  try { fillStewardSettings(); }          // 117e: 设置页「管家」页签的控件随 config 回填（面板数据懒加载）
  catch (error) { console.warn('[steward] fillStewardSettings failed', error); }
  // 117j B2：下面这段注释的第一句原本说「后台有个定时器在调 refreshStatus() → fillSettings」。
  // 全仓已经没有那个定时器了（refreshStatus 的调用点只剩 boot、按钮、命令面板与保存之后），
  // 但它引出的那道守卫仍然是活的、也仍然是必要的 —— 重入 fillSettings 的入口换成了 openModal 与
  // 「保存后重拉 config」。所以这里只改掉那句已经不成立的话，守卫与 2026-09-06 的事故记录原样保留。
  // A8: fillSettings() 会被重入（openModal 打开设置页、以及任一次保存后的 refreshStatus）。若设置弹窗
  // 正开着，用户可能正在编辑某个 provider 草稿 —— 这里重新播种会把他没保存的编辑悄悄丢掉。
  // user may be mid-edit on a provider draft — re-seeding it here would silently discard their edits.
  // 2026-09-06 事故根因（对抗审查 P0-1）：navigation-controls 的 openModal 先摘 hidden 再调 fillSettings，
  // 「弹窗隐藏才播种」这条守卫在用户点开设置那一刻恒为假 —— 草稿只有被后台定时刷新碰巧播种过才有值。
  // W6（缺陷①）：那道「已播种且弹窗开着就跳过」的守卫正是草稿过期的另一半 —— 跳过之后草稿就再也追不上别处的写口。
  // 现在已播种时一律【对齐】（syncProvidersDraft：没动过就整份换新、动过就三方合并，用户的编辑一个字不丢）；
  // 从未播种时照旧播种（此时不可能有用户未保存的编辑可丢）。
  if (state.providersDraftSeeded !== true) {
    seedProvidersDraft(c.providers);
    // 2026-09-06 事故：草稿从未由 config 播种（initial []）时被整份保存写成 providers: []，用户的五个
    // Provider 连同密钥被清空。此后 saveSettings 只在「草稿确实来自 config 或用户手动改过」时才上传
    // providers（见 providersDraftSeeded），否则省略该键让服务端保留现值。
    // 117k（2026-09-07 走查复现）：那道守卫只问「播种过没有」，没问「播种的是不是【真的 config】」。
    // 剩下的洞：在 config 还没到达时打开设置弹窗 —— fillSettings 被 state.config（此刻 {}）调一次，
    // c.providers 是 undefined，草稿播成 []【并被标成已播种】；config 随后到了，可这次「弹窗开着」
    // 分支跳过重播，草稿就一直空着。此时点保存 = 把用户的整份 Provider 连同密钥写成 []。
    // 实测（真机）：页面加载后 2ms 打开设置 → 5s 后 config 到齐、草稿仍是 [] → 一次保存清空。
    // 判据改成「这次拿到的确实是一份带 providers 数组的 config」：没到就别声称播过种，
    // saveSettings 会省略该键（服务端保留现值），下一次 fillSettings 也还会补播。
    state.providersDraftSeeded = Array.isArray(c.providers);
    renderProviders();
  } else if (Array.isArray(c.providers) && Array.isArray(state.providersDraft)) {
    // 2026-09-21：`toolbox-` 服务商归自动发现所有，用户在卡片上改不了它 —— 弹窗开着时也照 config 同步这几条
    // （补上刚接入的、撤掉已停用的），别的卡片上没存的编辑原样保留（编辑值住在草稿对象上）。服务端另有一道闸保证
    // 整份保存撤不掉它（13 applyConfigPatch）。W6：这一条并进了通用的对齐（rebaseProvidersDraft 的 serverOwned）。
    syncProvidersDraft(c.providers);
  }
  paintProvidersDirty();
  if (keepTyping && keepTyping.node.value !== keepTyping.value) keepTyping.node.value = keepTyping.value;
}
// 114a(45 号文 §2 ①/§7): 设置页「语音识别」选择器 —— 服务商页签内,provider+模型一对,选中即存
// (saveConfigPartial 部分补丁,与 compactProviderId 选择器同模具)。只列 models[].caps 含 'asr' 的模型;
// 一个候选都没有时【整块不渲染】(未配置=不可见:无 asr 模型的存量配置,设置页 DOM 逐字节零变化),
// 所以这里没有任何静态标记,节点全由本函数动态建/拆。判据(26 号文冻结边界):asrProviderId 与
// asrModel 皆非空才算「已配置」。
// 分隔符照 compactProviderId 选择器的 \u001f 模具,但按 32 号文 §16-bis 纪律用 fromCharCode 构造
// (源码零控制字符、零转义序列 —— 补丁传输层会把 \uXXXX 当转义解释落成裸字节,那次事故的修法)。
const ASR_VALUE_SEP = String.fromCharCode(31);
let asrSettingsBlock = null;
function asrCapableOptions() {
  const out = [];
  for (const p of (state.config && state.config.providers) || []) {
    if (!p || !p.id) continue;
    for (const m of providerModels(p)) {
      if (!m || typeof m !== 'object') continue;
      const caps = Array.isArray(m.caps) ? m.caps : [];
      if (!caps.includes('asr')) continue;
      const id = String(m.id || '').trim(); if (!id) continue;
      out.push({ providerId: p.id, providerLabel: p.label || p.id, modelId: id, modelLabel: String(m.label || id) });
    }
  }
  return out;
}
// 128f-⑭（用户 2026-09-19 拍板 A）：修前「无候选整块不渲染」，而界面上又没有任何地方能把一个模型标成「可语音识别」——
// 一台正常装好的机器上这一栏永远不出现，输入框的麦克风也就永远不出现（只能手改 config.json）。现在这一栏始终渲染：
// 有候选时照旧是选择器；无候选时说一句怎么办；两种情况下面都有一行「添加语音识别模型」（选服务商、填模型名、添加并启用）。
// 输入框里那枚待开启的灰麦克风被点时，组合根经 focusAsrSettings() 把人带到这里。
function asrProviderChoices() {
  // toolbox- 服务商归自动发现所有（模型清单由组件登记决定，设置页改不了），不进「添加语音识别模型」的候选。
  return ((state.config && state.config.providers) || []).filter(p => p && p.id && p.id !== 'claude-cli' && !String(p.id).startsWith('toolbox-'));
}
// 把 modelId 标成可语音识别：该服务商的模型清单里已有它就给它加上 asr 能力，没有就追加一条；同时把它选成语音识别模型。
// 2026-09-20（用户实报两件）：
//   ①「保存了语音模型后，再点保存会消失」—— 修前这里只经部分补丁写了 config，没碰设置弹窗里那份 providersDraft；
//      弹窗开着时 fillSettings 不重播草稿（A8 守卫，防丢用户没存的编辑），于是底部「保存」把【旧草稿】整份盖回去，
//      刚加的 caps:['asr'] 被抹掉，选择器回落「无候选」，而 asrProviderId／asrModel 还留着。现在同一处改动
//      【并进】草稿（不是重播 —— 用户在别的卡片上没存的编辑原样保留），两份从此一致。
//   ②「点了语音输入收不到字」—— 百炼／MiMo 这类服务商没有 /audio/transcriptions，缺省接口类型打过去就是 404；
//      而接口类型藏在服务商卡片的「协议与能力」折叠里，添加语音模型的人根本不知道有这回事。现在添加这一行
//      自带「接口类型」，按服务商地址预选，和模型一起写进去。
function withAsrModel(providers, providerId, modelId, protocol) {
  return (Array.isArray(providers) ? providers : []).map(p => {
    if (!p || p.id !== providerId) return p;
    const models = Array.isArray(p.models) ? p.models.slice() : [];
    const at = models.findIndex(m => (m && typeof m === 'object' ? String(m.id || '') : String(m || '')) === modelId);
    if (at < 0) models.push({ id: modelId, label: modelId, caps: ['asr'] });
    else if (models[at] && typeof models[at] === 'object') {
      const caps = Array.isArray(models[at].caps) ? models[at].caps : [];
      models[at] = { ...models[at], caps: caps.includes('asr') ? caps : [...caps, 'asr'] };
    } else models[at] = { id: modelId, label: modelId, caps: ['asr'] };
    const next = { ...p, models };
    // 与服务商卡片里那枚选择器同模具：缺省值不写字段（存量 config 零漂移）。protocol 不传＝不动它。
    if (protocol === 'chat-audio') next.asrProtocol = 'chat-audio';
    else if (protocol === 'transcriptions') delete next.asrProtocol;
    return next;
  });
}
// 接口类型的预选：这家已经选过对话式就照旧；没选过的按地址认 —— 百炼与 MiMo 实测只有对话式（Whisper 形 404）。
function asrProtocolGuess(p) {
  if (p && p.asrProtocol === 'chat-audio') return 'chat-audio';
  const base = String((p && (p.audioBaseUrl || p.baseUrl)) || '').toLowerCase();
  return /dashscope\.aliyuncs\.com|xiaomimimo\.com/.test(base) ? 'chat-audio' : 'transcriptions';
}
async function addAsrModel(providerId, modelId, protocol) {
  const providersNext = withAsrModel(state.config && state.config.providers, providerId, modelId, protocol);
  const saved = await saveConfigPartial({ providers: providersNext, asrProviderId: providerId, asrModel: modelId });
  if (saved && state.providersDraftSeeded === true && Array.isArray(state.providersDraft)) {
    state.providersDraft = withAsrModel(state.providersDraft, providerId, modelId, protocol);
    renderProviders();   // 卡片里的接口类型与模型清单跟着变（编辑值住在草稿对象上，重画不丢）
  }
  return saved;
}
function buildAsrAddRow() {
  const wrap = el('div', 'asr-add');
  wrap.appendChild(el('p', 'field-help', t('settings.asr.addTitle')));
  const providers = asrProviderChoices();
  if (!providers.length) { wrap.appendChild(el('p', 'field-help muted', t('settings.asr.noProvider'))); return wrap; }
  const providerSelect = el('select', 'asr-add-provider');
  providerSelect.setAttribute('aria-label', t('settings.asr.addProvider'));
  for (const p of providers) { const o = el('option'); o.value = p.id; o.textContent = p.label || p.id; providerSelect.appendChild(o); }
  const modelInput = el('select', 'asr-add-model');
  const fillAsrModels = () => bindModelSelect(modelInput, { provider: () => (state.config.providers || []).find(p => p.id === providerSelect.value), value: '', emptyLabel: () => t('settings.asr.addModel') });
  fillAsrModels();
  modelInput.setAttribute('aria-label', t('settings.asr.addModel'));
  // 接口类型：跟着所选服务商预选；用户亲手改过之后换服务商才重新预选。
  const protocolSelect = el('select', 'asr-add-protocol');
  protocolSelect.setAttribute('aria-label', t('settings.asr.addProtocol'));
  for (const [val, key] of [['transcriptions', 'provider.asrProtocol.transcriptions'], ['chat-audio', 'provider.asrProtocol.chatAudio']]) {
    const o = el('option'); o.value = val; o.textContent = t(key); protocolSelect.appendChild(o);
  }
  const syncProtocol = () => { protocolSelect.value = asrProtocolGuess(providers.find(p => p.id === providerSelect.value)); };
  providerSelect.onchange = () => { syncProtocol(); fillAsrModels(); };
  syncProtocol();
  const add = el('button', 'asr-add-btn', t('settings.asr.addButton'));
  add.type = 'button';
  add.onclick = async () => {
    const providerId = String(providerSelect.value || '');
    const modelId = String(modelInput.value || '').trim();
    if (!providerId || !modelId) { toast(t('settings.asr.addNeedFields'), 'err'); modelInput.focus(); return; }
    // 名字里带 realtime 的是【实时流式】型号（走 WebSocket），语音输入是「录完一段再转」，用它上游只会报错。
    // 用户 2026-09-20 手填的正是 qwen3-asr-flash-realtime —— 当场拦下并说清楚，好过存进去之后一句「未成功」。
    if (/realtime/i.test(modelId)) { toast(t('settings.asr.addRealtime'), 'err'); modelInput.focus(); return; }
    add.disabled = true;
    const saved = await addAsrModel(providerId, modelId, protocolSelect.value);
    add.disabled = false;
    if (!saved) return;   // saveConfigPartial 自己已经把原因说了
    toast(t('settings.asr.added', { model: modelId }), 'ok');
    renderAsrSettings();
  };
  const row = el('div', 'asr-add-row');
  row.append(providerSelect, modelInput, protocolSelect, add);
  wrap.appendChild(row);
  return wrap;
}
function focusAsrSettings() {
  renderAsrSettings();
  if (!asrSettingsBlock) return false;
  const adv = asrSettingsBlock.querySelector('.asr-advanced');   // 133c：从灰麦克风跳过来是要逐项配，先把高级区打开
  if (adv) adv.open = true;
  try { asrSettingsBlock.scrollIntoView({ block: 'center' }); } catch { /* 老宿主没有 scrollIntoView 选项 */ }
  const target = asrSettingsBlock.querySelector('.asr-select') || asrSettingsBlock.querySelector('.asr-add-model');
  if (target) { try { target.focus(); } catch { /* 节点不可聚焦 */ } }
  return true;
}
// 130（51 号文 §2.3）：实时识别（流式）候选 —— 只列 caps 含 asr-stream 的模型；今天只有 toolbox 的 asr-stream 组件会产生它。
function asrStreamCapableOptions() {
  const out = [];
  for (const p of (state.config && state.config.providers) || []) {
    if (!p || !p.id) continue;
    for (const m of providerModels(p)) {
      if (!m || typeof m !== 'object' || !(Array.isArray(m.caps) && m.caps.includes('asr-stream'))) continue;
      const id = String(m.id || '').trim(); if (!id) continue;
      out.push({ providerId: p.id, providerLabel: p.label || p.id, modelId: id, modelLabel: String(m.label || id) });
    }
  }
  return out;
}
// 「实时识别」那一栏：与下面「语音识别」同模具（选中即存部分补丁）；无候选时只说一句怎么装（没有添加口 —— 流式端点只能由组件登记）。
function buildAsrStreamBlock() {
  const block = el('div', 'field-block asr-stream-block');
  const label = el('label', '', t('settings.asrStream.title'));
  const options = asrStreamCapableOptions();
  if (!options.length) { block.append(label, el('p', 'field-help muted', t('settings.asrStream.none'))); return block; }
  const select = el('select', 'asr-stream-select');
  const opt = (text, value) => { const o = el('option'); o.textContent = text; o.value = value; return o; };
  const curP = String(state.config && state.config.asrStreamProviderId || ''), curM = String(state.config && state.config.asrStreamModel || '');
  const curValue = (curP && curM) ? curP + ASR_VALUE_SEP + curM : '';
  bindModelSelect(select, {
    models: () => asrStreamCapableOptions().map(o => ({ id: o.providerId + ASR_VALUE_SEP + o.modelId, label: o.providerLabel + ' / ' + o.modelLabel })),
    value: curValue, labelOnly: true, emptyLabel: () => t('settings.asrStream.disabled'),
  });
  const hint = el('p', 'field-help muted', select.value ? t('settings.asrStream.hintSet') : t('settings.asrStream.hintUnset'));
  select.onchange = async () => {
    const [asrStreamProviderId = '', asrStreamModel = ''] = select.value.split(ASR_VALUE_SEP);
    select.disabled = true;
    const saved = await saveConfigPartial({ asrStreamProviderId, asrStreamModel });
    select.disabled = false;
    if (saved) {
      hint.textContent = select.value ? t('settings.asrStream.hintSet') : t('settings.asrStream.hintUnset');
      toast(t(asrStreamProviderId ? 'settings.asrStream.toastSet' : 'settings.asrStream.toastReset'), 'ok');
    }
  };
  block.append(label, select, hint);
  return block;
}
// 131b（52 号文 §5；用户 2026-09-21 拍板 2「加进设置里可以配置，但要重新设计选项方式，也不要和现有的冲突」）：
// 「句尾改错」独立成第三栏。上面两栏各回答一个「用哪个模型」（实时出字／整段识别），它们的键一个不动；这一栏回答
// 「说完一句之后怎么改错」—— 方式四选一（自动／只重听／只让大模型改字／关）＋ 改字用哪个大模型（缺省跟随对话主端点）。
// 不新增模型标记、不给 toolbox- 服务商加能力；选中即存部分补丁，与前两栏同模具。提示行按当前配置算出「现在会怎么走」。
const ASR_FIX_MODES = ['auto', 'audio', 'llm', 'off'];
function asrFixLlmProvider(providerId) {
  const id = String(providerId || (state.config && state.config.activeProvider) || '');
  return asrProviderChoices().find(p => p.id === id) || null;   // 非 CLI、非 toolbox- 的才算「能改字」
}
function asrFixHintText(mode, providerId) {
  if (mode === 'off') return t('settings.asrFix.hint.off');
  const cfg = state.config || {};
  const audioOk = Boolean(String(cfg.asrProviderId || '').trim() && String(cfg.asrModel || '').trim());
  const audio = audioOk ? String(cfg.asrModel) : '';
  const p = asrFixLlmProvider(providerId);
  const llm = p ? ((p.label || p.id) + (String(cfg.asrFixModel || '').trim() ? ' / ' + String(cfg.asrFixModel).trim() : '')) : '';
  const useAudio = mode !== 'llm' && audioOk, useLlm = mode !== 'audio' && Boolean(p);
  if (useAudio && useLlm) return t('settings.asrFix.hint.both', { audio, llm });
  if (useAudio) return t('settings.asrFix.hint.audio', { audio });
  if (useLlm) return t('settings.asrFix.hint.llm', { llm });
  return t('settings.asrFix.hint.none');
}
// W6：这一栏拆成两半 —— 「怎么改」（方式四选一）留在语音区；「改字用哪个大模型」是一次模型分配，搬进「模型分配」
// 那张表的末行（renderAsrFixAssignRow，与其余几行同一个组件）。语音区这里留一句指路，点了直达那一行。
function buildAsrFixBlock() {
  const block = el('div', 'field-block asr-fix-block');
  block.appendChild(el('label', '', t('settings.asrFix.title')));
  const cfg = state.config || {};
  const opt = (text, value) => { const o = el('option'); o.textContent = text; o.value = value; return o; };
  const modeSel = el('select', 'asr-fix-mode');
  modeSel.setAttribute('aria-label', t('settings.asrFix.title'));
  for (const m of ASR_FIX_MODES) modeSel.appendChild(opt(t('settings.asrFix.mode.' + m), m));
  modeSel.value = ASR_FIX_MODES.includes(cfg.asrFixMode) ? cfg.asrFixMode : 'auto';
  const hint = el('p', 'field-help muted', asrFixHintText(modeSel.value, cfg.asrFixProviderId));
  const save = async patch => {
    modeSel.disabled = true;
    const saved = await saveConfigPartial(patch);
    modeSel.disabled = false;
    if (saved) { hint.textContent = asrFixHintText(modeSel.value, (state.config || {}).asrFixProviderId); toast(t('settings.asrFix.toast'), 'ok'); }
    return saved;
  };
  modeSel.onchange = () => { void save({ asrFixMode: modeSel.value }); };
  const where = el('button', 'btn btn-sm asr-fix-goto', t('settings.asrFix.gotoAssign'));
  where.type = 'button';
  where.onclick = () => { switchSettingsTab('models', true); const row = $('modelAssignList') && $('modelAssignList').querySelector('[data-assign="asrFix"]'); if (row) { try { row.scrollIntoView({ block: 'center' }); } catch { /* 老宿主 */ } } };
  const row1 = el('div', 'asr-add-row'); row1.append(modeSel, where);
  block.append(row1, hint);
  return block;
}
// 「模型分配」表末行：句尾改错用哪个大模型（asrFixProviderId／asrFixModel）。index.html 对语音零静态标记（asr-config-ui.static
// 钉着），所以这一行由本函数现建、只建一次，之后每次 fillSettings 只重填两枚下拉。候选口径不变：非命令行、非 toolbox- 的服务商。
function renderAsrFixAssignRow() {
  const list = $('modelAssignList');
  if (!list) return;
  let row = list.querySelector('[data-assign="asrFix"]');
  if (!row) {
    row = el('div', 'model-assign-row');
    row.dataset.assign = 'asrFix';
    const label = el('div', 'model-assign-label');
    const title = el('label', '', t('settings.models.row.asrFix'));
    const pick = el('div', 'model-assign-pick');
    const provSel0 = el('select', 'asr-fix-provider');
    provSel0.id = 'asrFixAssignProvider';   // 只给 <label for> 用；取节点一律经这一行的 querySelector（dom-contract 只认静态 id）
    title.htmlFor = provSel0.id;
    label.append(title, el('p', 'field-help muted', t('settings.models.row.asrFixHint')));
    pick.append(provSel0, el('select', 'asr-fix-model'));
    row.append(label, pick);
    list.appendChild(row);
  }
  const cfg = state.config || {};
  const provSel = row.querySelector('select.asr-fix-provider'), modelSel = row.querySelector('select.asr-fix-model');
  if (!provSel || !modelSel) return;
  row.querySelector('.model-assign-label label').textContent = t('settings.models.row.asrFix');
  row.querySelector('.model-assign-label .field-help').textContent = t('settings.models.row.asrFixHint');
  provSel.setAttribute('aria-label', t('settings.asrFix.providerLabel'));
  modelSel.setAttribute('aria-label', t('settings.asrFix.providerLabel'));
  const main = asrFixLlmProvider('');
  fillProviderSelect(provSel, {
    providers: asrProviderChoices(), value: cfg.asrFixProviderId,
    follow: t('settings.asrFix.followMain', { name: main ? (main.label || main.id) : t('settings.asrFix.noMain') }),
    savedLabel: value => t('settings.steward.providerSaved', { value }),
  });
  const fillModels = value => bindModelSelect(modelSel, {
    provider: () => asrFixLlmProvider(provSel.value),
    value, emptyLabel: () => t(provSel.value ? 'settings.models.providerDefault' : 'settings.models.followModel'),
  });
  fillModels(String(cfg.asrFixModel || ''));
  const save = async patch => {
    provSel.disabled = modelSel.disabled = true;
    const saved = await saveConfigPartial(patch);
    provSel.disabled = modelSel.disabled = false;
    if (saved) toast(t('settings.asrFix.toast'), 'ok');
    return saved;
  };
  provSel.onchange = () => { fillModels(''); void save({ asrFixProviderId: provSel.value, asrFixModel: '' }); };
  modelSel.onchange = () => { void save({ asrFixModel: modelSel.value }); };
}
// 133c（54 号文 §4；用户 2026-09-21「分几个轻度/重度的语音识别选项…这套设置选项确实有点复杂了」）：
// 语音输入先选【档位】，逐项指定收进折叠的「高级」区。档位【不是新配置键】—— 由现有三对键推算（选档位＝一次写这几对键），
// 所以老配置、管家改键、手工改 config.json 都不会与它打架；对不上任何一档就显示「自定义」。
//   关闭  = 实时识别与整段识别都不选
//   轻度  = 流式（zipformer，CPU）+ SenseVoice 重听（CPU）+ 大模型合成 —— 不占显存
//   标准  = 流式 + Qwen3-ASR 0.6B 重听（约 2 GB 显存）+ 大模型合成
//   重度  = 流式 + Qwen3-ASR 1.7B 重听（约 5 GB 显存，最准）+ 大模型合成
// 三档都只认 toolbox 组件登记的模型（云端 ASR 走「自定义」）；改字用的大模型不在档位里（缺省跟随主端点，高级区可改）。
const ASR_PRESETS = ['light', 'standard', 'heavy'];
const ASR_PRESET_ASR_MATCH = {
  light: [/sensevoice/i],
  standard: [/^qwen3-asr-0\.6b$/i, /^qwen3-asr-auto$/i],   // 老登记只有 auto（今天 auto 就是 0.6B）
  heavy: [/^qwen3-asr-1\.7b$/i],
};
function asrPresetTargets() {
  const isTb = o => String(o.providerId || '').startsWith('toolbox-');
  const stream = asrStreamCapableOptions().find(isTb) || null;
  const asr = asrCapableOptions().filter(isTb);
  const pick = res => { for (const re of res) { const hit = asr.find(o => re.test(o.modelId)); if (hit) return hit; } return null; };
  const out = {};
  // asr = 选这一档时写进去的那份(表里靠前的优先:标准档写显式 0.6B);asrAny = 判「现在是哪一档」时都算数的几份
  // (升级后自动选中的是 qwen3-asr-auto,今天 auto 就是 0.6B,不该显示成「自定义」—— 2026-09-21 实拍)。
  for (const p of ASR_PRESETS) out[p] = { stream, asr: pick(ASR_PRESET_ASR_MATCH[p]), asrAny: asr.filter(o => ASR_PRESET_ASR_MATCH[p].some(re => re.test(o.modelId))) };
  return out;
}
function asrPresetAvailable(target) { return Boolean(target && target.stream && target.asr); }
function asrPresetPatch(target) {
  return { asrStreamProviderId: target.stream.providerId, asrStreamModel: target.stream.modelId, asrProviderId: target.asr.providerId, asrModel: target.asr.modelId, asrFixMode: 'auto' };
}
function asrCurrentPreset(cfg, targets) {
  const c = cfg || {};
  const sp = String(c.asrStreamProviderId || ''), sm = String(c.asrStreamModel || ''), ap = String(c.asrProviderId || ''), am = String(c.asrModel || '');
  if (!(sp && sm) && !(ap && am)) return 'off';
  for (const p of ASR_PRESETS) {
    const tg = targets[p];
    if (!asrPresetAvailable(tg)) continue;
    const asrHit = (Array.isArray(tg.asrAny) && tg.asrAny.length ? tg.asrAny : [tg.asr]).some(o => o && ap === o.providerId && am === o.modelId);
    if (sp === tg.stream.providerId && sm === tg.stream.modelId && asrHit && String(c.asrFixMode || 'auto') === 'auto') return p;
  }
  return 'custom';
}
function asrPresetHintText(preset, targets) {
  const cfg = state.config || {};
  const p = asrFixLlmProvider('');
  const llmName = p ? ((p.label || p.id) + (String(cfg.asrFixModel || '').trim() ? ' / ' + String(cfg.asrFixModel).trim() : '')) : '';
  const llm = llmName ? t('settings.asrPreset.llmYes', { llm: llmName }) : t('settings.asrPreset.llmNo');
  if (preset === 'off') return t('settings.asrPreset.hint.off');
  if (preset === 'custom') return t('settings.asrPreset.hint.custom', { detail: asrFixHintText(String(cfg.asrFixMode || 'auto'), cfg.asrFixProviderId) });
  return t('settings.asrPreset.hint.' + preset, { llm });
}
function buildAsrPresetBlock(advanced) {
  const block = el('div', 'field-block asr-preset-block');
  block.appendChild(el('label', '', t('settings.asrPreset.title')));
  const targets = asrPresetTargets();
  const current = asrCurrentPreset(state.config, targets);
  const row = el('div', 'asr-preset-row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('settings.asrPreset.title'));
  const hint = el('p', 'field-help muted asr-preset-hint', asrPresetHintText(current, targets));
  const buttons = [];
  const paint = active => { for (const b of buttons) b.setAttribute('aria-pressed', b.dataset.preset === active ? 'true' : 'false'); hint.textContent = asrPresetHintText(active, targets); };
  const save = async (patch, active) => {
    for (const b of buttons) b.disabled = true;
    const saved = await saveConfigPartial(patch);
    for (const b of buttons) b.disabled = !asrPresetAvailable(targets[b.dataset.preset]) && ASR_PRESETS.includes(b.dataset.preset);
    if (saved) { paint(active); toast(t('settings.asrPreset.toast'), 'ok'); renderAsrSettings(); }
  };
  for (const p of ['off', ...ASR_PRESETS, 'custom']) {
    const b = el('button', 'asr-preset-btn', t('settings.asrPreset.' + p));
    b.type = 'button'; b.dataset.preset = p;
    b.setAttribute('aria-pressed', p === current ? 'true' : 'false');
    if (ASR_PRESETS.includes(p) && !asrPresetAvailable(targets[p])) { b.disabled = true; b.title = t('settings.asrPreset.need.' + p); }
    b.onclick = () => {
      if (p === 'custom') { advanced.open = true; paint('custom'); const first = advanced.querySelector('select'); if (first) { try { first.focus(); } catch { /* 不可聚焦 */ } } return; }
      if (p === 'off') { void save({ asrStreamProviderId: '', asrStreamModel: '', asrProviderId: '', asrModel: '' }, 'off'); return; }
      void save(asrPresetPatch(targets[p]), p);
    };
    buttons.push(b); row.appendChild(b);
  }
  block.append(row, hint);
  return block;
}
function renderAsrSettings() {
  const host = $('stab-providers');
  if (!host) return;
  const options = asrCapableOptions();
  if (!asrSettingsBlock) { asrSettingsBlock = el('div', 'asr-settings'); host.appendChild(asrSettingsBlock); }
  const wasOpen = Boolean(asrSettingsBlock.querySelector('.asr-advanced[open]'));
  asrSettingsBlock.textContent = '';
  const sep = el('hr', 'settings-sep');
  const streamBlock = buildAsrStreamBlock();   // 130：实时识别在前（先出字），整段识别／校正在后
  const fixBlock = buildAsrFixBlock();         // 131b：句尾改错最后（说完一句之后怎么改）
  // 133c：三栏收进折叠的「高级」区；档位对不上任何一档（自定义）时默认展开，否则记住用户刚才开没开
  const advanced = el('details', 'asr-advanced');
  advanced.appendChild(el('summary', '', t('settings.asrPreset.advanced')));
  const presetBlock = buildAsrPresetBlock(advanced);
  advanced.open = wasOpen || asrCurrentPreset(state.config, asrPresetTargets()) === 'custom';
  const block = el('div', 'field-block');
  const label = el('label', '', t('settings.asr.title'));
  const roleHint = el('p', 'field-help muted', t('settings.asr.roleHint'));
  if (!options.length) {
    block.append(label, roleHint, el('p', 'field-help muted', t('settings.asr.none')), buildAsrAddRow());
    advanced.append(streamBlock, block, fixBlock);
    asrSettingsBlock.append(sep, presetBlock, advanced);
    return;
  }
  const select = el('select', 'asr-select');
  const opt = (text, value) => { const o = el('option'); o.textContent = text; o.value = value; return o; };
  const curP = String(state.config && state.config.asrProviderId || ''), curM = String(state.config && state.config.asrModel || '');
  const curValue = (curP && curM) ? curP + ASR_VALUE_SEP + curM : '';
  bindModelSelect(select, {
    models: () => asrCapableOptions().map(o => ({ id: o.providerId + ASR_VALUE_SEP + o.modelId, label: o.providerLabel + ' / ' + o.modelLabel })),
    value: curValue, emptyLabel: () => t('settings.asr.disabled'),
  });
  const hint = el('p', 'field-help muted', select.value ? t('settings.asr.hintSet') : t('settings.asr.hintUnset'));
  select.onchange = async () => {
    const [asrProviderId = '', asrModel = ''] = select.value.split(ASR_VALUE_SEP);
    select.disabled = true;
    const saved = await saveConfigPartial({ asrProviderId, asrModel });
    select.disabled = false;
    if (saved) {
      hint.textContent = select.value ? t('settings.asr.hintSet') : t('settings.asr.hintUnset');
      toast(t(asrProviderId ? 'settings.asr.toastSet' : 'settings.asr.toastReset'), 'ok');
    }
  };
  block.append(label, roleHint, select, hint, buildAsrAddRow());
  advanced.append(streamBlock, block, fixBlock);
  asrSettingsBlock.append(sep, presetBlock, advanced);
}
// ruyi-toolbox 扩展组件(用户 2026-09-21:「toolbox 下的都自动识别接入,开箱即用」)。服务端 04f 在启动时已经把登记过的组件
// 拉起／接好了,这里只做两件事:① 设置页「MCP」页签底部画一栏「扩展组件」—— 看得见接了什么、各自什么状态,能逐个停用、
// 能整体关掉自动发现(「自动,但不是悄悄」);② 第一次见到某个组件时给一句看得见的提示。与语音识别那一栏同模具:
// index.html 零静态标记,节点全由本函数动态建;一个组件都没登记时整块不渲染(没装 toolbox 的人设置页逐字节不变)。
// 命令行不在这里出现 —— /api/status 的视图本来就不带,能改的只有「接不接」。
let toolboxSettingsBlock = null;
const TOOLBOX_STATE_KEYS = { running: 'settings.toolbox.state.running', starting: 'settings.toolbox.state.starting', failed: 'settings.toolbox.state.failed', exited: 'settings.toolbox.state.failed', stopped: 'settings.toolbox.state.stopped', idle: 'settings.toolbox.state.starting', disabled: 'settings.toolbox.state.disabled', registered: 'settings.toolbox.state.registered' };
async function saveToolboxPatch(patch) {
  const current = (state.config && state.config.toolbox) || {};
  const next = { autoDiscover: current.autoDiscover !== false, disabled: Array.isArray(current.disabled) ? current.disabled.slice() : [], seen: Array.isArray(current.seen) ? current.seen.slice() : [], ...patch };
  if (!await saveConfigPartial({ toolbox: next })) return false;
  // 服务端收到带 toolbox 的补丁后才开始对账(起／停进程),状态要过一会儿才变:隔一拍重取一次。
  setTimeout(() => { void refreshStatus().catch(() => {}); }, 2500);
  return true;
}
function renderToolboxSettings() {
  // W6：「MCP 运维」并进「集成与 MCP」之后，这一栏落在那一页的 #toolboxSettingsHost（迁移中心在它之后追加）。
  const host = $('toolboxSettingsHost') || $('stab-integrations');
  const view = (state.status && state.status.toolbox) || null;
  const components = (view && Array.isArray(view.components)) ? view.components : [];
  if (!host || !components.length) { if (toolboxSettingsBlock) { toolboxSettingsBlock.remove(); toolboxSettingsBlock = null; } return; }
  if (!toolboxSettingsBlock) { toolboxSettingsBlock = el('div', 'toolbox-settings'); host.appendChild(toolboxSettingsBlock); }
  toolboxSettingsBlock.textContent = '';
  const block = el('div', 'field-block');
  block.append(el('label', '', t('settings.toolbox.title')), el('p', 'field-help muted', t('settings.toolbox.hint')));
  const master = el('label', 'check toolbox-master');
  const masterBox = el('input'); masterBox.type = 'checkbox'; masterBox.checked = view.autoDiscover !== false;
  masterBox.onchange = async () => { masterBox.disabled = true; const okSaved = await saveToolboxPatch({ autoDiscover: masterBox.checked }); masterBox.disabled = false; if (!okSaved) masterBox.checked = !masterBox.checked; };
  master.append(masterBox, document.createTextNode(' ' + t('settings.toolbox.autoDiscover')));
  block.appendChild(master);
  const list = el('div', 'toolbox-list');
  for (const c of components) {
    const row = el('div', 'toolbox-row'); row.dataset.state = String(c.state || '');
    const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = c.enabled !== false; toggle.disabled = view.autoDiscover === false;
    toggle.setAttribute('aria-label', t('settings.toolbox.enable', { name: c.name || c.id }));
    toggle.onchange = async () => {
      const disabled = new Set(((state.config && state.config.toolbox && state.config.toolbox.disabled) || []));
      if (toggle.checked) disabled.delete(c.id); else disabled.add(c.id);
      toggle.disabled = true;
      const okSaved = await saveToolboxPatch({ disabled: [...disabled] });
      toggle.disabled = false;
      if (!okSaved) toggle.checked = !toggle.checked;
    };
    const provides = c.provides || [];
    const kind = provides.includes('mcp') ? t('settings.toolbox.kind.mcp')
      : (provides.includes('asr') ? t('settings.toolbox.kind.asr') : (provides.includes('asr-stream') ? t('settings.toolbox.kind.asrStream') : t('settings.toolbox.kind.service')));
    const name = el('span', 'toolbox-name', (c.name || c.id) + (c.version ? ' · ' + c.version : ''));
    const meta = el('span', 'toolbox-meta muted', kind + ' · ' + t(TOOLBOX_STATE_KEYS[c.state] || 'settings.toolbox.state.starting'));
    row.append(toggle, name, meta);
    if (c.error) row.appendChild(el('p', 'field-help toolbox-error', t('settings.toolbox.failedDetail', { reason: c.error }) + (c.stderrTail ? '\n' + c.stderrTail : '')));
    list.appendChild(row);
  }
  block.appendChild(list);
  toolboxSettingsBlock.append(el('hr', 'settings-sep'), block);
}
// 第一次见到某个已经接好的组件 → 说一句。记在 localStorage(每个浏览器说一次就够,不值得为它开一条服务端路由)。
function announceNewToolboxComponents() {
  const components = (state.status && state.status.toolbox && state.status.toolbox.components) || [];
  let told = [];
  try { told = JSON.parse(localStorage.getItem('wcw.toolbox.announced') || '[]'); } catch { told = []; }
  if (!Array.isArray(told)) told = [];
  const fresh = components.filter(c => c.enabled !== false && (c.state === 'running' || c.state === 'registered') && !told.includes(c.id));
  if (!fresh.length) return;
  for (const c of fresh) toast(t('settings.toolbox.discovered', { name: c.name || c.id }), 'ok');
  try { localStorage.setItem('wcw.toolbox.announced', JSON.stringify([...told, ...fresh.map(c => c.id)].slice(-50))); } catch { /* 隐私模式：下次再说一遍也无妨 */ }
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
/* ---------------- v2.7 workspace permissions ---------------- */
let _wsPermsWired = false;
function wireWorkspacePerms() {
  if (_wsPermsWired) return; _wsPermsWired = true;
  const addBtn = $('workspaceAddBtn');
  const addInput = $('workspaceAddInput');
  if (addBtn) addBtn.addEventListener('click', () => addWorkspace());
  if (addInput) addInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addWorkspace(); } });
  const outside = $('cfgAllowOutsideWorkspace');
  if (outside) outside.addEventListener('change', () => { if (state.config) state.config.allowOutsideWorkspace = outside.checked; });
}
function syncPrimaryInput() {
  const ws = Array.isArray(state.config.workspaces) ? state.config.workspaces : [];
  const wi = $('workspaceInput');
  if (wi && ws.length && wi !== document.activeElement) wi.value = ws[0].path || '';
}
function renderWorkspacePerms() {
  wireWorkspacePerms();
  const list = $('workspacePermList'); if (!list) return;
  const ws = Array.isArray(state.config.workspaces) ? state.config.workspaces : [];
  list.innerHTML = '';
  if (!ws.length) { list.append(el('p', 'muted', t('settings.workspacePerm.empty'))); }
  ws.forEach((w, i) => {
    const row = el('div', 'ws-perm-row');
    row.append(el('span', 'ws-perm-idx', String(i + 1)));
    const pathEl = el('span', 'ws-perm-path', String(w.path || ''));
    pathEl.title = String(w.path || '');
    row.append(pathEl);
    for (const k of ['read', 'write', 'execute']) {
      const lab = el('label', 'check ws-perm-check');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = w[k] !== false;
      cb.addEventListener('change', () => { const cur = state.config.workspaces[i]; if (cur) cur[k] = cb.checked; void saveWorkspaces(); });
      lab.append(cb, el('span', '', t('settings.workspacePerm.' + k)));
      row.append(lab);
    }
    const up = el('button', 'icon-btn ws-perm-btn', '↑'); up.type = 'button'; up.title = t('settings.workspacePerm.up'); up.disabled = i === 0;
    up.addEventListener('click', () => moveWorkspace(i, i - 1));
    const down = el('button', 'icon-btn ws-perm-btn', '↓'); down.type = 'button'; down.title = t('settings.workspacePerm.down'); down.disabled = i === ws.length - 1;
    down.addEventListener('click', () => moveWorkspace(i, i + 1));
    const rm = el('button', 'icon-btn ws-perm-btn ws-perm-rm', '×'); rm.type = 'button'; rm.title = t('settings.workspacePerm.remove');
    rm.addEventListener('click', () => { state.config.workspaces.splice(i, 1); syncPrimaryInput(); renderWorkspacePerms(); void saveWorkspaces(); });
    row.append(up, down, rm);
    list.append(row);
  });
  const outside = $('cfgAllowOutsideWorkspace'); if (outside) outside.checked = state.config.allowOutsideWorkspace === true;
}
// W6：工作区清单的每一个动作（勾选、挪位、删、加）改完就存。修前它们只改内存里的 state.config.workspaces、等页脚「保存」，
// 期间顶部工作区选择器若也改了清单，页脚一存就把它盖回去（同键两路写）。补丁构造原样搬自修前的页脚保存。
function workspacePatch() {
  // v2.7: sync the primary workspace input into the workspace list (the input edits the highest-priority path).
  const primaryPath = $('workspaceInput') ? $('workspaceInput').value.trim() : '';
  const ws = Array.isArray(state.config.workspaces) ? state.config.workspaces.map(w => ({ path: String(w.path || ''), read: w.read !== false, write: w.write !== false, execute: w.execute !== false })) : [];
  if (primaryPath) {
    const idx = ws.findIndex(w => w.path.toLowerCase() === primaryPath.toLowerCase());
    if (idx === 0) ws[0].path = primaryPath;
    else if (idx > 0) { const [x] = ws.splice(idx, 1); ws.unshift(x); }
    else ws.unshift({ path: primaryPath, read: true, write: true, execute: true });
  }
  state.config.workspaces = ws;
  return {
    defaultWorkspace: primaryPath,
    workspaces: ws.map(w => ({ path: w.path, read: w.read !== false, write: w.write !== false, execute: w.execute !== false })),
    allowOutsideWorkspace: $('cfgAllowOutsideWorkspace') ? $('cfgAllowOutsideWorkspace').checked : (state.config.allowOutsideWorkspace === true),
  };
}
async function saveWorkspaces() {
  const saved = await saveConfigPartial(workspacePatch());
  renderWorkspacePerms();
  try { renderWorkspacePicker(); } catch (error) { console.warn('[settings] renderWorkspacePicker failed', error); }
  return saved;
}
function moveWorkspace(from, to) {
  const ws = state.config.workspaces; if (!Array.isArray(ws) || to < 0 || to >= ws.length) return;
  const [x] = ws.splice(from, 1); ws.splice(to, 0, x);
  if (from === 0 || to === 0) syncPrimaryInput();
  renderWorkspacePerms();
  void saveWorkspaces();
}
async function addWorkspace() {
  const input = $('workspaceAddInput');
  let dir = input ? String(input.value).trim() : '';
  if (!dir) {
    try { const r = await api('/api/pick-folder', { method: 'POST', body: '{}' }); if (r && r.ok && r.path) dir = r.path; } catch { /* ignore */ }
  }
  if (!dir) { toast(t('settings.workspacePerm.pathRequired'), 'err'); return; }
  if (!Array.isArray(state.config.workspaces)) state.config.workspaces = [];
  if (!state.config.workspaces.some(w => String(w.path).toLowerCase() === dir.toLowerCase())) {
    state.config.workspaces.push({ path: dir, read: true, write: true, execute: true });
  }
  if (input) input.value = '';
  syncPrimaryInput();
  renderWorkspacePerms();
  void saveWorkspaces();
}
// W6：修前的页脚「保存」一次提交约 45 个键 —— 整份表单快照。任何别处（线程头的思考强度、齿轮菜单的界面切换、向导的语言、
// 工作区选择器）在弹窗开着期间改过的同一个键，都会被这份快照写回去；而页签之间切换（体检页会 refreshStatus）又会把
// 还没保存的输入冲掉。现在除服务商卡片外，每个控件（或必须一起写的一组）一条补丁构造器，改了（change）就存。
// 补丁构造器的内容原样搬自修前的页脚保存（钳位与缺省值一个没改）；after 是存成功之后要跟着刷的那一面。
const lineList = id => ($(id) ? $(id).value.split('\n').map(s => s.trim()).filter(Boolean) : []);
const clampedInt = (id, fallback, min, max) => {
  const node = $(id);
  const n = Math.round(Number(node ? node.value : NaN));
  return Number.isFinite(n) && String(node ? node.value : '').trim() !== '' ? Math.max(min, Math.min(max, n)) : fallback;
};
const refreshAfterSave = () => refreshStatus();
function claudeEndpointPatch() {
  // 地址、密钥、鉴权方式一起写：服务端的掩码闸按「密钥会去的地址变没变」判（107-S2），拆开写会误判。
  return {
    modelsApiBase: $('cfgModelsApiBase') ? $('cfgModelsApiBase').value.trim() : '',
    modelsApiKey: $('cfgModelsApiKey') ? $('cfgModelsApiKey').value : '',
    claudeAuthMode: $('cfgClaudeAuthMode') ? $('cfgClaudeAuthMode').value : (state.config.claudeAuthMode || 'auto'),
  };
}
const INSTANT_SETTINGS = Object.freeze([
  // ── 基础 ──
  { ids: ['cfgLocale'], patch: async () => ({ locale: await setLocale($('cfgLocale').value || 'auto') }), after: () => fillSettings() },
  { ids: ['cfgUiMode'], patch: () => ({ uiMode: $('cfgUiMode').value === 'simple' ? 'simple' : 'pro' }), after: patch => applyUiMode(patch.uiMode) },   // v0.9-S1 (C1)
  { ids: ['cfgOutputStyle'], patch: () => ({ outputStyle: $('cfgOutputStyle').value === 'concise' ? 'concise' : 'detailed' }) },
  { ids: ['workspaceInput', 'cfgAllowOutsideWorkspace'], patch: () => workspacePatch(), after: () => { renderWorkspacePerms(); renderWorkspacePicker(); } },
  { ids: ['cfgKillDisc'], patch: () => ({ killOnDisconnect: $('cfgKillDisc').checked }) },
  { ids: ['cfgKillPort'], patch: () => ({ killPortOnStart: $('cfgKillPort').checked }) },
  // ── 权限与安全（全局默认权限的写口在 steward-settings.js：切「全自动」要就地二次确认）──
  { ids: ['cfgPermissionTimeout'], patch: () => ({ permissionTimeoutMs: Math.max(0, Number($('cfgPermissionTimeout').value) || 0) }) },
  { ids: ['cfgQuestionTimeout'], patch: () => ({ questionTimeoutMs: Math.max(0, Number($('cfgQuestionTimeout').value) || 0) }) },
  { ids: ['cfgPermBridge'], patch: () => ({ permissionBridge: $('cfgPermBridge').checked }) },
  // ── 用量与限额（管家那几格的写口在 steward-settings.js）──
  // 月度成本预算：留空 → null（不设预算，用量看板不显进度）。后端接纳 {monthly,currency}。
  { ids: ['cfgUsageBudgetMonthly', 'cfgUsageBudgetCurrency'], patch: () => ({
    usageBudget: (() => {
      const m = $('cfgUsageBudgetMonthly'); const cur = $('cfgUsageBudgetCurrency');
      const v = m ? m.value.trim() : '';
      if (v === '') return null;
      const n = Number(v);
      return { monthly: Number.isFinite(n) ? Math.max(0, n) : 0, currency: cur ? cur.value : 'CNY' };
    })(),
  }) },
  // v1.6.3: 普通任务基础预算夹到 1..200；后端负责长任务与按进展续额。
  { ids: ['cfgOpenaiMaxToolIterations'], patch: () => ({ openaiMaxToolIterations: clampedInt('cfgOpenaiMaxToolIterations', 100, 1, 200) }) },
  { ids: ['cfgMaxTurns'], patch: () => ({ maxTurns: $('cfgMaxTurns').value.trim() }) },
  { ids: ['cfgSubagentMaxConcurrent'], patch: () => ({ subagentMaxConcurrent: clampedInt('cfgSubagentMaxConcurrent', 8, 1, 8) }) },
  { ids: ['cfgSubagentMaxPerTurn'], patch: () => ({ subagentMaxPerTurn: clampedInt('cfgSubagentMaxPerTurn', 32, 0, 32) }) },
  { ids: ['cfgAgentWorkflowMaxNodes'], patch: () => ({ agentWorkflowMaxNodes: clampedInt('cfgAgentWorkflowMaxNodes', 48, 1, 64) }) },
  { ids: ['cfgAgentNodeWrapUpMinutes'], patch: () => ({ agentNodeWrapUpMs: clampedInt('cfgAgentNodeWrapUpMinutes', 8, 0, 120) * 60000 }) },
  { ids: ['cfgTurnIdleMinutes'], patch: () => ({ turnIdleTimeoutMs: clampedInt('cfgTurnIdleMinutes', 10, 1, 60) * 60000 }) },
  // ── 模型分配（主模型、压缩、子代理、句尾改错各有自己的行内写口；这里只剩「新线程默认引擎」）──
  // 123-N2:新线程默认引擎。后端 normalizeConfig 再钳一次白名单(非法值回落 'last')。
  { ids: ['cfgNewThreadEngine'], patch: () => ({ newThreadEngine: $('cfgNewThreadEngine').value === 'global' ? 'global' : 'last' }), after: () => fillMainEngineSelects() },
  // ── Agent CLI（命令行引擎）──
  { ids: ['claudePathInput'], patch: () => ({ claudePath: $('claudePathInput').value.trim() }), after: refreshAfterSave },
  { ids: ['kimiPathInput'], patch: () => ({ kimiPath: $('kimiPathInput').value.trim() }), after: refreshAfterSave },
  { ids: ['cfgPartial'], patch: () => ({ includePartialMessages: $('cfgPartial').checked }) },
  { ids: ['cfgBeta'], patch: () => ({ betaInterleavedThinking: $('cfgBeta').checked }) },
  { ids: ['cfgResume'], patch: () => ({ autoResumeClaudeSessions: $('cfgResume').checked }) },
  { ids: ['cfgThinkingEffort'], patch: () => ({ claudeThinkingEffort: $('cfgThinkingEffort').value }) },
  { ids: ['cfgThinkBudget'], patch: () => ({ thinkingBudget: $('cfgThinkBudget').value.trim() }) },
  { ids: ['cfgExtraArgs'], patch: () => ({ extraClaudeArgs: lineList('cfgExtraArgs') }) },
  { ids: ['cfgEngineMode'], patch: () => ({ engineMode: $('cfgEngineMode').value }) },
  { ids: ['cfgModelsApiBase', 'cfgModelsApiKey', 'cfgClaudeAuthMode'], patch: () => claudeEndpointPatch(), after: () => refreshModels() },
  // Claude 第三方端点可选单价（次要）：两项皆空 → null。后端若支持 config.claudePricing 则据以估算成本。
  { ids: ['cfgClaudePriceIn', 'cfgClaudePriceOut', 'cfgClaudePriceCurrency'], patch: () => ({
    claudePricing: (() => {
      const pi = $('cfgClaudePriceIn'), po = $('cfgClaudePriceOut'), pc = $('cfgClaudePriceCurrency');
      const iv = pi ? pi.value.trim() : '', ov = po ? po.value.trim() : '';
      if (iv === '' && ov === '') return null;
      const out = { currency: pc ? pc.value : 'CNY' };
      if (iv !== '') { const n = Number(iv); if (Number.isFinite(n)) out.inputPerM = Math.max(0, n); }
      if (ov !== '') { const n = Number(ov); if (Number.isFinite(n)) out.outputPerM = Math.max(0, n); }
      return out;
    })(),
  }) },
  { ids: ['cfgDiscoverModels'], patch: () => ({ discoverModelsFromProxy: $('cfgDiscoverModels').checked }), after: () => refreshModels() },
  { ids: ['cfgExtraModels'], patch: () => ({ extraModels: lineList('cfgExtraModels') }), after: () => refreshModels() },
  // ── 联网搜索：apiKey 走 providers 同款掩码回存 —— 框内仍是 ••••<last4>（用户没动它）就原样回传，后端 unmaskSecrets 还原真 key。
  { ids: ['cfgSearchType', 'cfgSearchBaseUrl', 'cfgSearchApiKey'], patch: () => ({
    searchBackend: {
      type: $('cfgSearchType') ? $('cfgSearchType').value : ((state.config.searchBackend && state.config.searchBackend.type) || 'none'),
      baseUrl: $('cfgSearchBaseUrl') ? $('cfgSearchBaseUrl').value.trim() : '',
      apiKey: $('cfgSearchApiKey') ? $('cfgSearchApiKey').value : '',
    },
  }) },
  // ── 集成与 MCP。v0.7d: autodetect stays on so a blank command keeps auto-discovering. ──
  { ids: ['cfgDesktopMcpEnabled', 'cfgDesktopMcpCommand', 'cfgDesktopMcpArgs', 'cfgDesktopMcpCwd'], patch: () => ({
    desktopMcp: {
      enabled: $('cfgDesktopMcpEnabled') ? $('cfgDesktopMcpEnabled').checked : true,
      command: $('cfgDesktopMcpCommand') ? $('cfgDesktopMcpCommand').value.trim() : '',
      args: lineList('cfgDesktopMcpArgs'),
      cwd: $('cfgDesktopMcpCwd') ? $('cfgDesktopMcpCwd').value.trim() : '',
      autodetect: true,
    },
  }), after: refreshAfterSave },
  { ids: ['cfgBrowserMode', 'cfgBrowserExecutable', 'cfgBrowserCdpUrl'], patch: () => ({
    browserAutomation: {
      mode: $('cfgBrowserMode') ? $('cfgBrowserMode').value : 'system',
      executable: $('cfgBrowserExecutable') ? $('cfgBrowserExecutable').value.trim() : '',
      cdpUrl: $('cfgBrowserCdpUrl') ? $('cfgBrowserCdpUrl').value.trim() : 'http://127.0.0.1:9222',
    },
  }) },
  { ids: ['cfgBridgeExternal'], patch: () => ({ bridgeExternalToolsToProvider: $('cfgBridgeExternal').checked }) },
  { ids: ['cfgMcpMode'], patch: () => ({ mcpCommandMode: $('cfgMcpMode').value }) },
  // ── 高级 ──
  { ids: ['cfgToolLoadingMode'], patch: () => ({ toolLoadingMode: $('cfgToolLoadingMode').value === 'full' ? 'full' : 'auto' }) },
  // 105f: 摘要单发上限;后端 sanitize 再钳 [8192,131072],UI 只出三档。
  { ids: ['cfgSummarySingleShotMax'], patch: () => ({ summarySingleShotMaxTokensV1: clampedInt('cfgSummarySingleShotMax', 32768, 8192, 131072) }) },
]);
let instantSettingsBound = false;
function bindInstantSettings() {
  if (instantSettingsBound) return;
  instantSettingsBound = true;
  for (const entry of INSTANT_SETTINGS) {
    for (const id of entry.ids) {
      const node = $(id);
      if (node) node.addEventListener('change', () => { void saveInstantSetting(entry); });
    }
  }
}
async function saveInstantSetting(entry) {
  const patch = await entry.patch();
  if (!patch) return false;
  const saved = await saveConfigPartial(patch);
  if (saved && typeof entry.after === 'function') {
    try { await entry.after(patch); } catch (error) { console.warn('[settings] after-save failed', error); }
  }
  return saved;
}
// W6：只剩「保存服务商」（#saveConfigBtn，挪到了卡片正下方）。保存前先取一次最新配置、把草稿对齐上去 —— 别的写口（线程头
// 「设为新任务默认」、管家改配置、另一个标签页）改 providers 时不一定经过本页的 saveConfigPartial，不对齐就会把它们回滚。
// 对齐是三方合并：用户在卡片上改过的字段留用户的，没改过的跟最新值走。成功后草稿按落盘值重新播种、保存条回到干净。
async function saveSettings() {
  if (state.providersDraftSeeded === true && Array.isArray(state.providersDraft)) {
    try {
      const fresh = await api('/api/status');
      const latest = fresh && fresh.config && Array.isArray(fresh.config.providers) ? fresh.config.providers : null;
      if (latest) {
        for (const provider of latest) provider.models = providerModels(provider);
        syncProvidersDraft(latest);
      }
    } catch { /* 取不到最新值就按手上这份存：服务端仍有缩水备份与掩码闸兜底 */ }
  }
  const patch = {
    // 2026-09-06 事故后的守门：草稿没被 config 播种过（页面加载时设置弹窗开着、或 fillSettings 半途
    // 中断）就不上传 providers —— JSON.stringify 会省略 undefined，服务端 {...current, ...body} 保留现值。
    // 用户在服务商页手动增删（renderProviders 只在播种后才画卡片）都会经过播种，不受影响。
    providers: state.providersDraftSeeded === true ? (state.providersDraft || []) : undefined,
  };
  if (patch.providers === undefined) return false;
  const button = $('saveConfigBtn');
  if (button) button.disabled = true;
  const saved = await saveConfigPartial(patch);
  if (!saved) { paintProvidersDirty(); return false; }
  seedProvidersDraft(state.config.providers);
  renderProviders();
  paintProvidersDirty();
  toast(t('settings.providers.saved'), 'ok');
  await refreshStatus();
  return true;
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
  // W6：页脚整份保存退役之后，「应用预设」填进来的几格当场存（与手改这几格同一条即存路径）。地址换了而密钥框还是掩码时，
  // 服务端掩码闸会拒绝并说清楚要重填哪一格 —— 这正是它该做的，不绕开。
  void saveConfigPartial({ ...claudeEndpointPatch(), extraModels: lineList('cfgExtraModels') }).then(saved => { if (saved) void refreshModels(); });
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
  // 2026-09-06 设置弹窗子审查：草稿从未播种时直接 `|| []` 再 push，会把「原有 5 个」变成「只剩新加的 1 个」
  // 并在下一次保存时整份覆盖（缩水不是清空，旧的备份门也不触发）。先从 config 播种，再在其上追加。
  if (state.providersDraftSeeded !== true || !Array.isArray(state.providersDraft)) {
    state.providersDraft = JSON.parse(JSON.stringify((state.config && state.config.providers) || []));
  }
  state.providersDraftSeeded = true;   // 用户亲手添加 Provider：草稿从此是用户意图，保存时照常上传
  // 118a: 序列化下沉到模块级 providerDraftFromPreset()(与欢迎向导共用同一实现,零行为变化)。
  const draft = providerDraftFromPreset(preset, state.providersDraft.map(p => p.id));
  if (!draft) return;
  state.providersDraft.push(draft);
  renderProviders();
  markProvidersDirty();   // W6：加了一张卡 = 有没存的改动，保存条亮起
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
  const modChip = el('span', 'prov-modct', tCount('provider.modelCount', providerModels(p).length));
  const testBtn = el('button', 'file-label', t('provider.testConnection')); testBtn.type = 'button'; testBtn.onclick = () => testProvider(idx, testBtn);
  const delBtn = el('button', 'file-label prov-del', t('common.delete')); delBtn.type = 'button';
  // A6: deleting a provider also drops its API key — confirm so a misclick can't silently lose it.
  // 对抗轮(reverify A):删卡时清 providerCapOpen 记忆,避免 id 复用时新卡继承旧卡折叠状态。
  delBtn.onclick = () => { if (!confirm(t('provider.deleteConfirm', { name: p.label || p.id }))) return; state.providersDraft.splice(idx, 1); providerCapOpen.delete(p.id); renderProviders(); markProvidersDirty(); };
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
  // 107-A1(45 号文 §9.6.3 实测):asrProtocol —— 这家 provider 的【转写协议】。Whisper 形
  // (POST /audio/transcriptions,缺省)与 chat-audio 形(POST /chat/completions + input_audio data URI,
  // MiMo/百炼官方文档协议)。实测:四个 ASR 模型走 Whisper 形全 404,按文档协议直调 200 且字准确率 100%。
  // 与 apiStyle 同模具:缺省值【不写字段】(delete),存量 config 零漂移。
  const asrLbl = el('label', 'check prov-asr-protocol'); asrLbl.appendChild(document.createTextNode(' ' + t('provider.asrProtocol') + ' '));
  const ac = el('select'); ac.className = 'prov-asr-protocol-select';
  for (const [val, key] of [['transcriptions', 'provider.asrProtocol.transcriptions'], ['chat-audio', 'provider.asrProtocol.chatAudio']]) {
    const o = el('option'); o.value = val; o.textContent = t(key); ac.appendChild(o);
  }
  ac.value = p.asrProtocol === 'chat-audio' ? 'chat-audio' : 'transcriptions';
  ac.onchange = () => { if (ac.value === 'chat-audio') p.asrProtocol = 'chat-audio'; else delete p.asrProtocol; };
  asrLbl.appendChild(ac);
  const asrHint = el('p', 'field-help muted prov-asr-protocol-hint'); asrHint.textContent = t('provider.asrProtocol.hint');
  asrLbl.appendChild(asrHint);
  cap.append(reason, visionLbl, styleLbl, serverSearchLbl, asrLbl);
  syncServerSearchVisibility();

  const b2 = el('div', 'field-block'); b2.append(el('label', '', 'Base URL'));
  const bi = el('input'); bi.type = 'text'; bi.value = p.baseUrl || ''; bi.placeholder = 'https://api.deepseek.com'; bi.oninput = () => { p.baseUrl = bi.value.trim(); }; b2.append(bi);

  const grid = el('div', 'field-grid');
  const kb = el('div', 'field-block'); kb.append(el('label', '', t('provider.apiKey')));
  const keyWrap = el('div', 'prov-key-wrap');
  // 118e: 本机模型端点(Ollama / LM Studio / 回环自建)不需要 API Key。这里只改【提示】,不加任何拦截:
  // 服务端 sanitizeProvider 本来就接受空 apiKey,保存路径一行未动,所以 sk-... 的占位符是唯一会
  // 让新手以为「必须填」的东西。
  const keyOptional = providerKeyOptional(p);
  const ki = el('input'); ki.type = 'password'; ki.autocomplete = 'off'; ki.value = p.apiKey || '';
  ki.placeholder = keyOptional ? t('provider.apiKeyOptionalPlaceholder') : 'sk-...';
  ki.oninput = () => { p.apiKey = ki.value; };
  const eye = el('button', 'prov-key-eye', '👁'); eye.type = 'button'; eye.title = t('provider.toggleApiKeyVisibility');
  eye.onclick = () => { const show = ki.type === 'password'; ki.type = show ? 'text' : 'password'; eye.classList.toggle('on', show); };
  keyWrap.append(ki, eye); kb.append(keyWrap);
  if (keyOptional) kb.append(el('p', 'field-help muted prov-key-optional', t('provider.apiKeyOptionalHint')));
  const mb = el('div', 'field-block'); mb.append(el('label', '', t('provider.model')));
  const mi = el('select');
  bindModelSelect(mi, { provider: () => p, value: p.model || '', emptyLabel: () => t('settings.mainEngine.defaultModel'), onRefresh: () => {
    modChip.textContent = tCount('provider.modelCount', providerModels(p).length);
    if (document.activeElement !== modelListI) modelListI.value = providerModels(p).map(m => m.id).join('\n');
  } });
  mi.onchange = () => { p.model = mi.value; };
  mb.append(mi); grid.append(kb, mb);

  // A provider can be used even when its /models endpoint is unavailable or incomplete. Keep a manual list
  // of model IDs alongside the shared model selector. Custom IDs can be registered here.
  const modelListB = el('div', 'field-block'); modelListB.append(el('label', '', t('provider.manualModels')));
  const modelListI = el('textarea'); modelListI.rows = 3; modelListI.placeholder = t('provider.manualModelsPlaceholder');
  modelListI.value = providerModels(p).map(m => m.id).join('\n');
  modelListI.oninput = () => {
    const seen = new Set();
    const models = [];
    for (const line of modelListI.value.split('\n')) {
      const id = line.trim().slice(0, 120);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
    const removed = providerModels(p).map(m => m.id).filter(id => !seen.has(id));
    p.hiddenModels = [...new Set([...(p.hiddenModels || []), ...removed])];
    p.models = keepModelCaps(models, p.models);   // 2026-09-20：改这份名字清单不该顺手把「可语音识别」的标记抹掉
    p.models = p.models.filter(m => seen.has(String((m && m.id) || '')));   // 但用户亲手删掉的那一行就是删了（keepModelCaps 会把带标记的补回来，这条路不要）
    // 手动清单里重新打出来的那一行 = 用户又想要它了 → 从「已移除」名单里放出来。线程头那枚「×」写的
    // 就是 providers[].hiddenModels，而菜单里没有反方向的「恢复」按钮 —— 这条是唯一的回头路。
    if (Array.isArray(p.hiddenModels) && p.hiddenModels.length) {
      p.hiddenModels = p.hiddenModels.filter(v => !seen.has(String(v || '').trim()));
      if (!p.hiddenModels.length) delete p.hiddenModels;
    }
    if (!p.model && models.length) p.model = models[0].id;
    refreshModelSelects();
    mi.value = p.model || '';
  };
  modelListB.append(modelListI, el('p', 'field-help muted', t('provider.manualModelsHint')));

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
    const modelInput = el('select'); modelInput.dataset.modelPriceModel = 'true';
    bindModelSelect(modelInput, { provider: () => p, value: value.model || '', emptyLabel: () => t('provider.pricing.modelPlaceholder') });
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
  // 自定义请求头(后端 sanitizeProvider 已支持 extraHeaders: key<=80/value<=2048,
  // 06/07/08/09/10 五处发请求都 Object.assign 到 headers)。每行 "Name: value",与备用端点同款 textarea。
  const hb = el('div', 'field-block'); hb.append(el('label', '', t('provider.customHeaders')));
  const headersToText = obj => {
    if (!obj || typeof obj !== 'object') return '';
    return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n');
  };
  const hi = el('textarea'); hi.rows = 2; hi.placeholder = t('provider.customHeadersPlaceholder');
  hi.value = headersToText(p.extraHeaders);
  hi.oninput = () => {
    const out = {};
    for (const line of hi.value.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      const ci = s.indexOf(':');
      if (ci <= 0) continue;                 // 没有冒号或冒号在首位 -> 忽略畸形行
      const k = s.slice(0, ci).trim();
      const v = s.slice(ci + 1).trim();
      if (!k) continue;
      out[k.slice(0, 80)] = v.slice(0, 2048); // 与后端 sanitizeProvider 同口径,避免保存时被裁
    }
    if (Object.keys(out).length) p.extraHeaders = out; else delete p.extraHeaders;
  };
  hb.append(hi);
  adv.append(sb, tb, eb, hb);

  const status = el('div', 'prov-status muted'); status.id = `provStatus_${idx}`;
  card.append(head, cap, b2, grid, modelListB, cwB, priceB, adv, status);
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
// 118e: 测试连接失败态的渲染。两件事:
//  ① 原写法 `${r.error}` 直接插值 -- 服务端的 {ok:false,error:'<人话>'} 被 00-boot 的 normalizeApiErrorPayload
//     统一改写成 {code:'api.request_failed',message:'<人话>'} 之后,这里恒印 [object Object](与 118d 在
//     MCP 导入路径上修掉的是同一条信封坑)。先按 message/字符串两种形状取词。
//  ② 本机预设(Ollama / LM Studio)连不上时,「连不上端点(fetch failed)」对小白毫无意义:真实含义只有一个 --
//     本机没在跑那个服务。换成人话,并在旁边给一个【应用内】手册按钮(不给命令行、不给下载链接)。
function providerTestErrorText(payload) {
  const raw = payload && payload.error;
  if (typeof raw === 'string' && raw) return raw;
  if (raw && typeof raw === 'object' && raw.message) return String(raw.message);
  return t('provider.testFailure');
}
function paintProviderTestFailure(status, provider, payload) {
  status.classList.remove('good');
  status.classList.add('bad');
  const downKey = localEndpointDownKey(String((provider && provider.id) || '').replace(/-\d+$/, ''));
  const local = downKey && payload && payload.errorClass === 'network_down';
  const line = el('span', '', '✗ ' + (local ? t(downKey) : providerTestErrorText(payload)));
  if (!downKey) { status.replaceChildren(line); return; }
  const readBtn = el('button', 'btn-sm prov-local-manual', t('onboarding.wizard.provider.localDown.readManual'));
  readBtn.type = 'button';
  readBtn.onclick = () => { openSharedHelpDoc({ docId: ONBOARDING_MANUAL_DOC_ID, anchor: t(LOCAL_MODELS_ANCHOR_KEY) }); };
  status.replaceChildren(line, readBtn);
}
async function testProvider(idx, btn) {
  const p = state.providersDraft[idx]; if (!p) return;
  const status = $(`provStatus_${idx}`);
  const requested = { ...p };
  if (btn) { btn.disabled = true; btn.textContent = t('provider.testing'); }
  try {
    const r = await api('/api/provider/test', { method: 'POST', body: JSON.stringify({ provider: requested }) });
    if (p.baseUrl !== requested.baseUrl || p.apiKey !== requested.apiKey) return;
    if (r && r.ok) {
      if (Array.isArray(r.models) && r.models.length) {
        publishProviderModels(p, r.models, [...(state.config.providers || []), ...(state.providersDraft || [])]);
        onEngineConfigChanged();
      }
      if (status) { status.textContent = tCount('provider.testSuccess', r.models ? r.models.length : 0); status.classList.remove('bad'); status.classList.add('good'); }
      renderProviders();
    } else if (status) { paintProviderTestFailure(status, p, r); }
  } catch (e) { if (status) { status.textContent = `✗ ${apiErrText(e)}`; status.classList.add('bad'); } }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('provider.testConnection'); } }
}

// 118d: MCP 导入路径的错误取词。服务端写给用户看的人话(「该文件夹缺少有效的 ruyi-mcp.json 清单」)
// 经 00-boot 的 normalizeApiErrorPayload 会变成 {code:'api.request_failed', message:'<原句>'} :
// 直接插值印 [object Object],交给注入的 apiErrText 又会把这个兜底 code 翻成泛泛的「请求失败。」,
// 把原句丢掉。所以:兜底 code 优先用 message(那才是写给用户的那句),真 code 才交给 apiErrText 本地化。
function mcpErrText(error) {
  if (error && typeof error === 'object' && error.code === 'api.request_failed' && error.message) return String(error.message);
  if (typeof error === 'string' && error) return error;
  return apiErrText(error);
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
      // 118d: r.error 已被服务端的 normalizeApiErrorPayload 改写成结构化信封,直接插值会印 [object Object]。
      if (r && r.template) showMcpTemplateModal(r.error ? mcpErrText(r.error) : t('mcp.missingManifest'), r.template, pf.path);
      else toast(t('toast.importFail', { err: r && r.error ? mcpErrText(r.error) : t('common.unknownError') }), 'err');
    }
  } catch (e) {
    toast(t('toast.importFail', { err: apiErrText(e) }), 'err');
  } finally { if (btn) btn.disabled = false; }
}
// v1.0.2 (G5c) / 118g: 缺清单说明 modal。
//
// 118g 治理:原来这里只印一段 ruyi-mcp.json 模板 + 一个「复制」按钮 -- 用户拿到一段文本,还得自己去
// 那个文件夹里新建文件、粘进去、再回来重导一次。这是 §2 UX 红线里典型的「复制走、去别处粘」交接。
// 改成【一键应用到配置】:直接在这张卡里确认几项,走 /api/mcp/import-config/apply(与配置导入器同一条
// 写入路径)把连接器登记进配置;写入前原位说明「将新增 / 将覆盖哪个连接器」,成功 toast + 刷新列表,
// 失败给人话。「复制 JSON(排错用)」保留为次要动作 -- 复制内容供排错是正常功能,复制完让用户自己去
// 别处粘才是反模式。DOM 仍全部 textContent 构建,绝不 innerHTML 拼接。
function showMcpTemplateModal(reason, template, folder) {
  const tpl = (template && typeof template === 'object') ? template : {};
  const body = el('div', 'mcp-tpl-body');
  body.append(el('p', 'mcp-tpl-reason', reason));
  body.append(el('p', 'muted', t('mcp.createManifestHint')));

  const field = (labelKey, value, cls) => {
    const wrap = el('div', 'field-block mcp-tpl-field');
    wrap.append(el('label', '', t(labelKey)));
    const input = el('input', cls || '');
    input.type = 'text';
    input.value = String(value == null ? '' : value);
    wrap.append(input);
    body.append(wrap);
    return input;
  };
  const idInput = field('mcp.apply.id', tpl.id || '');
  const labelInput = field('mcp.apply.label', tpl.label || '');
  const commandInput = field('mcp.apply.command', tpl.command || '');
  const argsInput = field('mcp.apply.args', Array.isArray(tpl.args) ? tpl.args.join(' ') : '');
  const cwd = String(folder || tpl.cwd || '');
  const cwdRow = el('p', 'muted mcp-tpl-cwd', t('mcp.apply.cwd') + ' ' + cwd);
  body.append(cwdRow);

  // 写入前的变更摘要:这一次到底是新增还是覆盖,哪个连接器。跟着 id 输入实时更新。
  const summary = el('p', 'mcp-tpl-summary', '');
  const existingIds = () => (Array.isArray(state.config && state.config.externalMcpServers) ? state.config.externalMcpServers : [])
    .map(s => String((s && s.id) || ''));
  const syncSummary = () => {
    const id = idInput.value.trim();
    summary.textContent = !id ? t('mcp.apply.needFields')
      : existingIds().includes(id) ? t('mcp.apply.willOverwrite', { id })
        : t('mcp.apply.willAdd', { id });
  };
  idInput.oninput = syncSummary;
  syncSummary();
  body.append(summary);

  let tplText = '';
  try { tplText = JSON.stringify(template, null, 2); } catch { tplText = String(template); }
  const preWrap = el('div', 'mcp-tpl-pre-wrap');
  const pre = el('pre', 'mcp-tpl-pre');
  pre.textContent = tplText; // XSS: textContent, never innerHTML
  preWrap.append(pre);
  body.append(preWrap);

  const foot = el('div', 'confirm-foot');
  // 不复用 .mcp-tpl-copy: 那条既有规则是 position:absolute(原来贴在 <pre> 右上角),放进页脚会飘到弹层右上。
  const copyBtn = el('button', 'btn btn-sm', t('mcp.apply.copyJson'));
  copyBtn.type = 'button';
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(tplText); copyBtn.textContent = t('common.copied'); setTimeout(() => { copyBtn.textContent = t('mcp.apply.copyJson'); }, 1500); }
    catch { toast(t("toast.copyFail"), 'err'); }
  };
  const applyBtn = el('button', 'primary mcp-tpl-apply', t('mcp.apply.apply'));
  applyBtn.type = 'button';
  const ok = el('button', 'btn btn-sm', t('common.gotIt'));
  ok.type = 'button';
  foot.append(copyBtn, applyBtn, ok);

  const m = buildModal(t('mcp.missingManifestTitle'), body, foot);
  ok.onclick = () => m.close();
  applyBtn.onclick = async () => {
    const id = idInput.value.trim();
    const command = commandInput.value.trim();
    if (!id || !command) { summary.textContent = t('mcp.apply.needFields'); toast(t('mcp.apply.needFields'), 'err'); return; }
    const server = {
      id, label: labelInput.value.trim() || id, command,
      args: argsInput.value.trim() ? argsInput.value.trim().split(/\s+/) : [],
      env: {}, cwd,
    };
    applyBtn.disabled = true;
    try {
      const r = await api('/api/mcp/import-config/apply', { method: 'POST', body: JSON.stringify({ servers: [server] }) });
      if (r && r.ok) {
        toast(t('mcp.apply.done', { id }), 'ok');
        m.close();
        await refreshStatus(); // 重拉 config -> fillSettings 重新渲染集成 / MCP 列表
        try { await refreshMcpOps(false); } catch { /* 128f-⑫（审计 D）：「MCP 运维」那张表读的是自己那份缓存，不跟 config 走 */ }
      } else {
        // skipped[0].reason 才是「为什么没写进去」的那句(例如「外部 MCP 数量已达上限(10)」);
        // r.error 在这条路径上只是笼统的「没有可导入的条目」,优先级更低。
        const skipReason = r && Array.isArray(r.skipped) && r.skipped[0] && r.skipped[0].reason;
        const why = skipReason || (r && r.error ? mcpErrText(r.error) : t('common.unknownError'));
        toast(t('mcp.apply.failed', { reason: why }), 'err');
      }
    } catch (e) {
      toast(t('mcp.apply.failed', { reason: apiErrText(e) }), 'err');
    } finally { applyBtn.disabled = false; }
  };
}

/* ---------------- doctor ---------------- */
// 118b: 体检页说人话。每行 = 状态灯 + 名称 + 一句话现状(+「怎么办」真动作 + 折叠的「技术详情」)。
// 原始 id 与英文 detail 只活在折叠区里(方便把问题原样转给支持人员),正文里一个英文标识都不出现。
function renderDoctor() {
  const panel = $('doctorPanel'); if (!panel) return;
  panel.replaceChildren();
  const s = state.status || {};
  const items = (s.health || []).filter(h => h && !HEALTH_ALIAS_IDS.includes(h.id));
  const summary = healthSummaryText(items, t);
  if (summary) {
    const line = el('div', `health-summary-line tone-${summary.tone}`);
    line.append(el('span', 'health-summary-dot', '●'), el('span', 'health-summary-text', summary.text));
    panel.appendChild(line);
  }
  panel.appendChild(healthRow(true, t('common.version'), `v${s.version} · 启动=${s.launchMode} · overlay=${s.overlayId}`));
  for (const h of items) panel.appendChild(healthItemRow(h));
  renderHealthEntryBadge();
}
// 单个体检项。severity 决定灯色与状态药丸;next 有内容时才给「怎么办」按钮 -- 一个点了没反应的按钮
// 比没有按钮更伤信任。
function healthItemRow(item) {
  const info = describeHealthItem(item, t);
  const row = el('div', `health-row sev-${info.severity} ${info.severity === 'ok' ? 'ok' : 'bad'}`);
  row.append(el('span', 'h-dot', '●'));
  const body = el('div', 'h-body');
  const head = el('div', 'h-head');
  head.append(el('div', 'h-id', info.label), el('span', `h-pill sev-${info.severity}`, t(`health.status.${info.severity}`)));
  body.appendChild(head);
  body.appendChild(el('div', 'h-detail', info.hint));
  const action = HEALTH_ACTIONS[item.id];
  if (info.severity !== 'ok' && info.next) {
    const next = el('div', 'h-next');
    next.appendChild(el('span', 'h-next-text', info.next));
    if (action) {
      const btn = el('button', 'mini h-howto', t('health.action.howto'));
      btn.type = 'button';
      btn.onclick = () => runHealthAction(action);
      next.appendChild(btn);
    }
    body.appendChild(next);
  }
  const tech = document.createElement('details');
  tech.className = 'h-tech';
  const summary = document.createElement('summary');
  summary.className = 'h-tech-summary';
  summary.textContent = t('health.tech.toggle');
  tech.append(summary, el('div', 'h-tech-body', `${item.id} · ${item.detail || ''}`));
  body.appendChild(tech);
  row.appendChild(body);
  return row;
}
// 「怎么办」= 真动作,不是文案。两种落点:
//   settings 切设置页签(force=true:体检页的「怎么办」是明确的排障逃生门,简易模式的页签收敛不该把
//            用户弹回「基础」)。体检行只在设置弹层里出现,所以不需要再开一次弹层。
//   manual   打开应用内手册阅读器并滚到对应小节(经典壳登记的同一个实例)。锚点走文案键,中英各自
//            对应本语言的小节标题;标题对不上时阅读器就停在开头,仍然停留在如意内部。
function runHealthAction(action) {
  if (!action) return;
  if (action.kind === 'settings') { switchSettingsTab(action.tab, true); return; }
  if (action.kind === 'manual') {
    const anchor = action.anchorKey ? String(t(action.anchorKey) || '') : '';
    const opened = openSharedHelpDoc({ docId: action.docId, anchor: /^\[.*\]$/.test(anchor) ? '' : anchor });
    if (!opened) toast(t('help.doc.unknown'), 'err');
  }
}
// 118b: 侧栏「设置」按钮上的摘要红点 -- 用户还没进设置就能看见有几项要处理。没有待办时移除,
// 一个恒亮徽标会很快变成噪音。按钮里的文字节点自己带 data-i18n,徽标是它的兄弟节点,切语言不会被抹掉。
function renderHealthEntryBadge() {
  const host = $('openSettingsBtn'); if (!host) return;
  const items = ((state.status && state.status.health) || []).filter(h => h && !HEALTH_ALIAS_IDS.includes(h.id));
  const summary = healthSummaryText(items, t);
  let dot = host.querySelector('.health-entry-dot');
  if (!summary) { if (dot) dot.remove(); return; }
  if (!dot) { dot = el('span', 'health-entry-dot'); host.appendChild(dot); }
  dot.className = `health-entry-dot tone-${summary.tone}`;
  dot.textContent = String(summary.count);
  dot.title = summary.text;
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
    refreshModels,
    refreshStatus,
    renderProviders,
    renderStatusLine,
    saveConfigPartial,
    saveSettings,
    updateEngineDependentUI,
    updateSearchBackendVisibility,
    focusAsrSettings,   // 128f-⑭：输入框里那枚待开启的麦克风被点时，组合根把人带到语音识别那一栏
  });
}

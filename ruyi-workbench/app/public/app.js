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
import { $, el, escapeHtml, fileBasename, fmtBytes, fmtTime, fmtTokens, toast, setStatus, autoGrow } from './js/util.js';
import { wcwToken, authHeaders, api, apiErrorInfo, apiErrText as rawApiErrText, initToken } from './js/net.js';
import { icon, hydrateIcons } from './js/icons.js';
import { getLocale, initI18n, setLocale, t, tCount } from './js/i18n.js';
import { activeTurnUserIsPersisted, captureScrollAnchor, messageDomKey, messageRenderSignature, normalizeTurnSegments, restoreScrollAnchor, turnToolAnchorId } from './js/turn-narrative.js';
import { createChatScrollController, enableSmoothWheelScroll } from './js/chat-scroll.js';
import { createSettingsOperationsDomain } from './js/settings-operations.js';
import { createFileBrowserDomain } from './js/file-browser.js';
import { ARTIFACT_KIND_ICON, createArtifactChangesDomain } from './js/artifact-changes.js';
import { createOperationsObservabilityDomain } from './js/operations-observability.js';
import { createUsageDashboardDomain } from './js/usage-dashboard.js';
import { createAgentRolesDomain } from './js/agent-roles.js';
import { createSkillsMemoryDomain } from './js/skills-memory.js';
import { createProviderSettingsDomain } from './js/provider-settings.js';
import { createAgentWorkflowsDomain } from './js/agent-workflows.js';
import { createNavigationControlsDomain } from './js/navigation-controls.js';
import { createSessionExperienceDomain } from './js/session-experience.js';
import { createInteractionPromptsDomain } from './js/interaction-prompts.js';
import { createToolRuntimeDomain } from './js/tool-runtime.js';
import { createWorkspacePreferencesDomain } from './js/workspace-preferences.js';
import { createChatRenderPrimitives } from './js/chat-render-primitives.js';
import { renderMermaidBlocks } from './js/mermaid-runtime.js';
import { createChatStaticRenderer } from './js/chat-static-renderer.js';
import { createChatStreamRuntime } from './js/chat-stream-runtime.js';
import { createTurnActivity, describeTurnActivity } from './js/turn-activity.js';
import { createShellModeController } from './js/shell-mode.js'; // 121-K1
import { createAppFrame } from './js/app-frame.js'; // 121-K4
import { createBootFailure } from './js/boot-failure.js';
import { createEventStream } from './js/event-stream.js'; // 121-K2b
import { STEWARD_NEW_THREAD_EVENT } from './js/steward-board.js'; // 121-K4：左栏「＋ 新任务」派的那一条
import { createStewardShellDomain } from './js/steward-shell.js'; // 117a
import { bindNotifySettings } from './js/notify-policy.js'; // 121-K1
import { bindRailPocket } from './js/rail-pocket.js'; // 121-K7：左栏栏底的口袋（§2.3 末段）
import { createComposerVoice, syncComposerVoices } from './js/composer-voice.js'; // 127-⑦：输入框麦克风（语音识别配好才建节点，45 号文 §2-quinquies）
// 117a/121-K1: the shell-mode controller and the steward domain are each other's injected dependency
// (the controller owns the single applyShellMode; the steward owns admission + fail-closed recovery).
// One late-bound handle opens that cycle. Null handle = the steward domain never composed -> admission
// stays false and applyShellMode falls back to the workbench view.
let stewardShellGuard = null;
// 121-K5（34 号文 §2.5）：工作台线程头的重画口。线程头住管家域（它要左栏那批行与同一份 chips
// 工厂），而经典壳这一侧有三个调用点（开机 bootData、全局配置写完、引擎依赖 UI 刷新）—— 走迟绑定
// 闭包，与 markSharedThread 同一条解环手法：管家域在下面才建，调用时它早已就位；缺席时空操作。
function renderThreadHead() {
  return stewardShellGuard ? stewardShellGuard.threadHead.render() : '';
}
const chatScrollController = createChatScrollController({
  getMessages: () => $('messages'),
  getJumpLatest: () => $('jumpLatest'),
  isStreaming: () => Boolean(state.streaming),
});
const {
  maybeScrollToBottom, isStickyScroll,
  resetStickyScroll,
  scrollMessagesToBottom,
  syncStickToBottom,
  updateJumpLatest,
} = chatScrollController;
// 丝滑滚轮：rAF 插值替代原生每格 ~100px 阶跃；上滑显式解除粘性（含宽限窗），
// 不再被流式跟随拉回底部（“弹回去滑不动”）。
const messagesSmoothWheel = enableSmoothWheelScroll(() => $('messages'), chatScrollController);
const API_ERROR_I18N = {
  'auth.token_invalid': 'error.api.authToken',
  'api.route_not_found': 'error.api.routeNotFound',
  'api.request_failed': 'error.api.requestFailed',
  'api.internal_error': 'error.api.internalError',
  'api.method_not_allowed': 'error.api.methodNotAllowed',
  'api.host_rejected': 'error.api.hostRejected',
  'request.action_unknown': 'error.api.actionUnknown',
  'session.id_invalid': 'error.api.sessionInvalid',
  'session.id_required': 'error.api.sessionRequired',
  'session.not_found': 'error.api.sessionNotFound',
  'checkpoint.not_found': 'error.api.checkpointNotFound',
  'checkpoint.reference_invalid': 'error.api.checkpointReferenceInvalid',
  'file.path_required': 'error.api.pathRequired',
  'file.path_not_absolute': 'error.api.pathNotAbsolute',
  'request.field_required': 'error.api.fieldRequired',
  'agent_run.id_required': 'error.api.agentRunRequired',
  'question.not_pending': 'error.api.questionNotPending',
  'question.delivery_failed': 'error.api.questionDeliveryFailed',
  'steer.claude_requires_interactive': 'error.api.steerClaudeRequiresInteractive',
  // 128b:撤回与读改写冲突的三个稳定码(Brief §4.2 第 18 条:修前以原串 'rewind_superseded' 显示)。
  'session.rewind_superseded': 'error.api.rewindSuperseded',
  'session.rewound_during_write': 'error.api.rewoundDuringWrite',
  'session.history_changed_during_compact': 'error.api.historyChangedDuringCompact',
};
// 124 真机 bug（用户 2026-09-15）：**api.request_failed 是「没有稳定码」的兜底码，按它翻译等于把
// 服务端刚说清楚的原因抹掉。** 00-boot 的 normalizeApiErrorPayload 对任何不在 LEGACY_API_ERROR_CODES
// 表里的遗留字符串错误一律派这个码，真话全留在 message 里；这里若先查表，屏幕上就只剩一句
// 「请求失败。」。用户那次看到的正是它 —— 服务端说的是「当前 Kimi 回合正在收尾，请作为下一条
// 消息发送」，该怎么做都写在里面了，却被吞掉。
// 所以这个码【单独】走 message 优先。其余码都是真码（服务端明确选的），仍然按表翻译，
// 因为那才是能本地化的那一半。
// provider-settings.js 的 mcpErrText 早就为同一个坑就地打过一块（它的注释写的是同一个诊断）。
// 上游收口之后那一块已经是冗余的，但删它是另一处回归面，本刀不顺手动：登记在号文里。
function apiErrText(error) {
  const info = apiErrorInfo(error);
  if (info.code === 'api.request_failed' && info.message) return info.message;
  // 128f-①（同一个模具，用户首启走查「显示不出具体原因」）：api.internal_error 是服务端 sendError 的兜底码，
  // 真原因在 message 里（那一刻抛出来的 err.message）。只按码翻译，屏幕上就剩「服务发生内部错误。」——
  // 现在译文后面带上原话（过长截断；message 只是码本身时不带）。
  if (info.code === 'api.internal_error' && info.message && info.message !== info.code) {
    const detail = info.message.length > 300 ? info.message.slice(0, 300) + '…' : info.message;
    return t('error.api.internalErrorDetail', { detail });
  }
  const key = API_ERROR_I18N[info.code];
  return key ? t(key, info.params) : rawApiErrText(error);
}
const {
  bindSettingsOperations,
  refreshMcpOps,
  refreshOverlayStatus,
} = createSettingsOperationsDomain({
  apiErrText,
  importMcpFromFolder: button => importMcpFromFolder(button),
  openOnboarding: () => openOnboardingWizard(), // 118a
});

const {
  bindFileBrowser,
  loadFileTree,
  renderFilePreviewInto,
} = createFileBrowserDomain({
  apiErrText,
  currentWorkspace: () => currentWorkspace(),
  renderMarkdown: text => renderMarkdown(text),
  highlightIn: container => highlightIn(container),
  runTool: (name, body) => runTool(name, body),
});

const {
  bindArtifactChanges,
  loadChanges,
  refreshLocalizedArtifactChanges,
  renderArtifactsGallery,
} = createArtifactChangesDomain({
  apiErrText,
  renderFilePreviewInto: (box, fullPath) => renderFilePreviewInto(box, fullPath),
  runTool: (name, body) => runTool(name, body),
  rollbackTurn: (turnSeq, entrySeq, button, label) => rollbackTurn(turnSeq, entrySeq, button, label),
  buildModal: (title, body, foot, onCancel) => buildModal(title, body, foot, onCancel),
});

const {
  bindOperationsObservability,
  openAuditTab,
  openStorageTab,
  refreshLocalizedObservability,
} = createOperationsObservabilityDomain({ apiErrText });

const {
  bindUsageDashboard,
  loadUsage,
  openUsageDashboard,
  refreshLocalizedUsage,
} = createUsageDashboardDomain({
  apiErrText,
  openSession: sessionId => openSession(sessionId),
});

const {
  bindAgentRoles,
  loadAgentRoles,
  populateSubagentPreferenceSelects,
} = createAgentRolesDomain({
  apiErrText,
  currentWorkspace: () => currentWorkspace(),
});

const {
  bindSkillsMemory,
  openMemoryPanel,
  openMemoryToolbox,
  openSkillPanel,
  playbookDisplayDescription,
  playbookDisplayName,
  playbookDisplayUnavailableReason,
  playbookInputLabel,
  playbookStatusText,
  renderSkillList,
  saveAsMemory,
  suggestMemoryFromTurn,
  updateSkillBadge,
} = createSkillsMemoryDomain({
  apiErrText,
  currentWorkspace: () => currentWorkspace(),
  closeModal: id => closeModal(id),
  openModal: id => openModal(id),
  buildModal: (...args) => buildModal(...args),
  isProviderMode: () => isProviderMode(),
  openPlaybookModal: playbook => openPlaybookModal(playbook),
  renderMarkdown: text => renderMarkdown(text),
  saveConfigPartial: patch => saveConfigPartial(patch),
  iconTextBtn: (...args) => iconTextBtn(...args),
});

const {
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
} = createProviderSettingsDomain({
  apiErrText,
  onEngineConfigChanged: () => { renderThreadHead(); syncComposerVoices(); },   // 121-K5：全局配置变了 -> 线程头那组 chip 重画；127-⑦：两枚麦克风按 ASR 配置重判建／拆
  updateAgentTeamButton: () => updateAgentTeamButton(),
  applyTheme: theme => applyTheme(theme),
  applyUiMode: mode => applyUiMode(mode),
  renderWorkspacePicker: () => renderWorkspacePicker(),
  fetchCapabilities: force => fetchCapabilities(force),
  updateSkillBadge: () => updateSkillBadge(),
  buildEmptyState: () => buildEmptyState(),
  popover: (...args) => popover(...args),
  populateSubagentPreferenceSelects: (...args) => populateSubagentPreferenceSelects(...args),
  buildModal: (...args) => buildModal(...args),
  refreshSessions: () => refreshSessions(),
  openSession: id => openSession(id),
  switchTab: tab => switchTab(tab),
  switchSettingsTab: (name, force) => switchSettingsTab(name, force), // 118b: 体检行「怎么办」直达目标设置页签
  openToolPane: () => openToolPane(),
  runTool: (...args) => runTool(...args),
  updateContextMeter: () => updateContextMeter(),
  // 117a: every config refresh re-decides whether the steward shell may be entered (switch + skeleton).
  syncStewardShellAvailability: () => stewardShellGuard?.syncStewardShellAvailability(),
  fillStewardSettings: () => stewardShellGuard?.fillStewardSettings(), // 117e：设置页「管家」页签随 config 回填
});

const {
  buildStaticToolGroup,
  ctxTokensOf,
  ctxWindow,
  ctxWindowManual,
  ctxWindowSourceLabel,
  highlightIn,
  iconTextBtn,
  latestUsage,
  messageShell,
  metaFromMessage,
  msgActions,
  renderContextMeter,
  renderGitDiffInto,
  renderMarkdown,
  renderMarkdownInto,
  renderToolImageInto,
  renderStaleBadgeInto,
  saveAsPlaybook,
  safeStringify,
  setCtxWindowManual,
  syncContextWindowManual,
  settleLiveThinking,
  thinkingPanel,
  toolCard,
  toolArgSummary,
  toolGroupSummaryText,
  updateContextMeter,
  usageLine,
  wrapPreWithCopy,
} = createChatRenderPrimitives({
  $,
  api,
  apiErrText,
  autoGrow,
  buildModal: (...args) => buildModal(...args),
  currentEngineMeta: () => currentEngineMeta(),
  currentModelId: () => currentModelId(),
  el,
  engineVisual: meta => engineVisual(meta),
  escapeHtml,
  fmtTime,
  fmtTokens,
  hljs: globalThis.hljs,
  humanizeToolName: name => humanizeToolName(name),
  icon,
  isProviderMode: () => isProviderMode(),
  marked: globalThis.marked,
  // 109b: image-toobig 时「在侧栏预览」跳转,复用既有 renderFilePreviewInto/openToolPane/switchTab,零新增端点。
  openFilePreview: fullPath => { openToolPane(); switchTab('files'); return renderFilePreviewInto($('filePreview'), fullPath); },
  refreshPlaybooks: (...args) => refreshPlaybooks(...args),
  refreshSessions: (...args) => refreshSessions(...args),
  renderCurrentSession: (...args) => renderCurrentSession(...args),
  // 109a: mermaid 图表渲染(懒加载 vendor,缺文件时原样降级)。
  renderMermaidBlocks: (...args) => renderMermaidBlocks(...args),
  renderResumeBanner: (...args) => renderResumeBanner(...args),
  saveAsMemory: (...args) => saveAsMemory(...args),
  sendPrompt: (...args) => sendPrompt(...args),
  state,
  t,
  tCount,
  toast,
});

const {
  activeTurns,
  buildNarrativeSteerSegment,
  compactContext,
  mountActiveTurn,
  scheduleRender,
  sealLiveTextSegment,
  sendPrompt,
  setStreaming,
  syncStreamingUi,
  steerPendingList,
  steeredSeen,
  stopTurn,
  toggleAgentTeamTurn,
  updateAgentTeamButton,
  updateSendBtn,
} = createChatStreamRuntime({
  $,
  api,
  apiErrText,
  activeTurnUserIsPersisted,
  appendToolOutput: (...args) => appendToolOutput(...args),
  authHeaders,
  autoGrow,
  cliMissingCard: (...args) => cliMissingCard(...args),
  compactNarrativeProcessRuns: (...args) => compactNarrativeProcessRuns(...args),
  createTurnActivity, // 112c: 回合活动状态机(chat-stream-runtime 全篇零 import,按既有纪律由这里注入)
  describeTurnActivity,
  currentEngineMeta: () => currentEngineMeta(),
  currentWorkspace: () => currentWorkspace(),
  el,
  engineLabel: () => engineLabel(),
  errorCard: (...args) => errorCard(...args),
  fmtTokens,
  handleAgentWorkflowEvent: (...args) => handleAgentWorkflowEvent(...args),
  handlePermissionRequest: (...args) => handlePermissionRequest(...args),
  handlePlanEvent: (...args) => handlePlanEvent(...args),
  humanizeToolName: name => humanizeToolName(name),
  highlightIn,
  iconTextBtn,
  isProviderMode: () => isProviderMode(),
  isUntitledTitle: title => isUntitledTitle(title),
  latestUsage,
  loadAutonomyGrants: () => loadAutonomyGrants(),
  syncContextWindowManual,
  maybeScrollToBottom,
  messageShell,
  msgActions: (...args) => msgActions(...args),
  narrativeQuestionCard: (...args) => narrativeQuestionCard(...args),
  narrativeSemanticCard: (...args) => narrativeSemanticCard(...args),
  narrativeToolAnchor: (...args) => narrativeToolAnchor(...args),
  newSession: (...args) => newSession(...args),
  openModal: (...args) => openModal(...args),
  pushRawEvent: (...args) => pushRawEvent(...args),
  refreshSessions: (...args) => refreshSessions(...args),
  renderAttachments,
  renderAutonomyBar: (...args) => renderAutonomyBar(...args),
  renderContextMeter,
  renderCurrentSession: (...args) => renderCurrentSession(...args),
  renderGitDiffInto,
  renderMarkdown,
  renderMissionBar: (...args) => renderMissionBar(...args),
  refreshToolPane: () => refreshToolPane(),
  renderResumeBanner: (...args) => renderResumeBanner(...args),
  renderToolImageInto, // 109b: 工具产出图内联缩略图,tool_result 到达后补渲染。
  renderStaleBadgeInto, // 125-P2:缓存徽标,同一趟补渲染(判据只看结构化字段 fromCache/ts)。
  renderSessions: (...args) => renderSessions(...args),
  renderStaticMessage: (...args) => renderStaticMessage(...args),
  renderStepBar: (...args) => renderStepBar(...args),
  safeStringify,
  scrollMessagesToBottom,
  settleLiveThinking,
  showAskUserModal: (...args) => showAskUserModal(...args),
  state,
  suggestMemoryFromTurn: (...args) => suggestMemoryFromTurn(...args),
  switchSettingsTab: (...args) => switchSettingsTab(...args),
  t,
  thinkingPanel,
  toast,
  toolCard,
  toolArgSummary,
  toolGroupSummaryText,
  turnArtifactChips: (...args) => turnArtifactChips(...args),
  turnSummaryCard: (...args) => turnSummaryCard(...args),
  turnToolIndexCard: (...args) => turnToolIndexCard(...args),
  updateContextMeter,
  updateJumpLatest,
  usageLine,
  wbNativeClaudeFinalize: (...args) => wbNativeClaudeFinalize(...args),
  wbNativeClaudeOnSubagent: (...args) => wbNativeClaudeOnSubagent(...args),
  wrapPreWithCopy,
});

const {
  bindWorkbench,
  launchAgentWorkflowFromQuickSelect,
  loadAgentRuns,
  loadAgentWorkflows,
  openWorkflowEditor,
  restoreMainView,
  updateAgentRunsPolling,
  wbNativeClaudeFinalize,
  wbNativeClaudeOnSubagent,
} = createAgentWorkflowsDomain({
  apiErrText,
  currentWorkspace: () => currentWorkspace(),
  switchTab: tab => switchTab(tab),
  buildModal: (...args) => buildModal(...args),
  activeProviderObj: () => activeProviderObj(),
  activeTurns: {
    get: sessionId => activeTurns.get(sessionId),
    has: sessionId => activeTurns.has(sessionId),
  },
  newSession: () => newSession(),
  openToolPane: () => openToolPane(),
  scheduleRender: live => scheduleRender(live),
  renderCurrentSession: () => renderCurrentSession(),
  renderSessions: () => renderSessions(), scrollIsSticky: () => isStickyScroll(),
});

const {
  closeModal,
  closeToolDrawer,
  exitRightFullscreen,
  fetchCapabilities,
  initHelpEntries, // 118d: 侧栏「帮助」菜单 + 设置页「?」的接线
  initRightResize,
  normalizeTabsForUiMode,
  noteToolTabOpened,
  refreshToolPane,
  openCapPopover,
  openComposerMorePopover,
  openContextPopover,
  openModal,
  openPalette,
  openRenamePopover,
  openToolPane,
  popover,
  renderCapBadge,
  modelMenuExtras,   // 121-K5：chips 模型菜单尾部那三件全局事
  renderPalette,
  restoreRightWidth,
  restoreToolsCollapsed,
  switchSettingsTab,
  switchTab,
  syncMoreMenuLabels,
  toggleToolPane,
} = createNavigationControlsDomain({
  apiErrText,
  fillSettings: () => fillSettings(), // 118b: 补上 openModal('settingsModal') 里一直缺的注入(原为自由标识符,每次开设置都抛错)
  buildModal: (...args) => buildModal(...args), // 118d: 帮助菜单的应用内日志面板
  newSession: () => newSession(),
  runTool: (...args) => runTool(...args),
  stopTurn: () => stopTurn(),
  exportSession: format => exportSession(format),
  importSession: () => importSession(),
  addTemplateFromPrompt: () => addTemplateFromPrompt(),
  openMemoryPanel: () => openMemoryPanel(),
  openMemoryToolbox: () => openMemoryToolbox(),
  getTemplates: () => getTemplates(),
  insertTemplate: text => insertTemplate(text),
  openSession: id => openSession(id),
  currentEngineMeta: () => currentEngineMeta(),
  updateEngineDependentUI: () => updateEngineDependentUI(),
  latestUsage: session => latestUsage(session),
  ctxTokensOf: usage => ctxTokensOf(usage),
  ctxWindow: () => ctxWindow(),
  ctxWindowManual: model => ctxWindowManual(model),
  ctxWindowSourceLabel: () => ctxWindowSourceLabel(),
  setCtxWindowManual: (value, model) => setCtxWindowManual(value, model),
  currentModelId: () => currentModelId(),
  isProviderMode: () => isProviderMode(),
  engineLabel: () => engineLabel(),
  saveConfigPartial: patch => saveConfigPartial(patch),
  refreshModels: announce => refreshModels(announce),
  engineVisual: meta => engineVisual(meta),
  updateContextMeter: () => updateContextMeter(),
  toggleTheme: () => toggleTheme(),
  compactContext: () => compactContext(),
  refreshStatus: () => refreshStatus(),
  openSkillPanel: () => openSkillPanel(),
  patchSession: (id, patch) => patchSession(id, patch),
  toggleUiMode: () => toggleUiMode(),
  focusFirstInteractive: container => focusFirstInteractive(container),
  loadAgentRoles: () => loadAgentRoles(),
  refreshOverlayStatus: () => refreshOverlayStatus(),
  refreshMcpOps: probe => refreshMcpOps(probe),
  updateShellPolling: () => updateShellPolling(),
  loadFileTree: () => loadFileTree(),
  renderArtifactsGallery: () => renderArtifactsGallery(),
  loadChanges: () => loadChanges(),
  openAuditTab: force => openAuditTab(force),
  openUsageDashboard: () => openUsageDashboard(),
  openStorageTab: () => openStorageTab(),
  loadAgentWorkflows: () => loadAgentWorkflows(),
  loadUsage: force => loadUsage(force),
  loadAgentRuns: force => loadAgentRuns(force),
  renderRawEventSnapshot: () => renderRawEventSnapshot(),
  updateAgentRunsPolling: tab => updateAgentRunsPolling(tab),
});

const {
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
} = createInteractionPromptsDomain({
  apiErrText,
  engineLabel: () => engineLabel(),
  activeTurns: {
    get: sessionId => activeTurns.get(sessionId),
    has: sessionId => activeTurns.has(sessionId),
  },
  saveConfigPartial: patch => saveConfigPartial(patch),
});

const {
  appendToolOutput,
  handlePlanEvent,
  newShellSession,
  pushRawEvent,
  renderRawEventSnapshot,
  resolveClassicPlanIntervention,
  runTool,
  updateShellPolling,
} = createToolRuntimeDomain({
  apiErrText,
  decidePlan: (...args) => decidePlan(...args),
  setComposerHint: text => setComposerHint(text),
  engineLabel: () => engineLabel(),
  renderMarkdown: text => renderMarkdown(text),
  highlightIn: container => highlightIn(container),
  sealLiveTextSegment: (...args) => sealLiveTextSegment(...args),
  maybeScrollToBottom: () => maybeScrollToBottom(),
});

const {
  applyTheme,
  applyUiMode,
  currentWorkspace,
  pickWorkspace,
  pickWorkspaceNative,
  renderWorkspacePicker,
  setWorkspace,
  toggleTheme,
  toggleUiMode,
} = createWorkspacePreferencesDomain({
  apiErrText,
  saveConfigPartial: patch => saveConfigPartial(patch),
  iconTextBtn: (...args) => iconTextBtn(...args),
  syncMoreMenuLabels: () => syncMoreMenuLabels(),
  normalizeTabsForUiMode: mode => normalizeTabsForUiMode(mode),
  newSession: () => newSession(),
  patchSession: (id, patch) => patchSession(id, patch),
  loadFileTree: () => loadFileTree(),
  popover: (...args) => popover(...args),
});

const {
  compactNarrativeProcessRuns,
  narrativeQuestionCard,
  narrativeSemanticCard,
  narrativeToolAnchor,
  renderStaticMessage,
  turnToolIndexCard,
} = createChatStaticRenderer({
  attachmentImageUrl,
  buildNarrativeSteerSegment: text => buildNarrativeSteerSegment(text),
  buildStaticToolGroup,
  el,
  highlightIn,
  icon,
  messageShell,
  metaFromMessage,
  msgActions,
  normalizeTurnSegments,
  renderMarkdown,
  t,
  tCount,
  thinkingPanel,
  toolCard,
  turnArtifactChips: summary => turnArtifactChips(summary),
  turnSummaryCard: summary => turnSummaryCard(summary),
  turnToolAnchorId,
  usageLine,
  wrapPreWithCopy,
});

window.addEventListener('i18n:change', () => {
  const sendButton = $('sendBtn');
  // The first locale application runs before hydrateIcons(). Defer icon-bearing controls until then so
  // hydrateIcons remains the only initializer and does not prepend a duplicate SVG.
  if (sendButton?.dataset.iconized === '1') setStreaming(Boolean(state.streaming));
  updateAgentTeamButton();
  const prompt = $('promptInput');
  if (prompt) prompt.placeholder = t('chat.placeholder');
  renderSessions();
  renderWorkspacePicker();
  renderResumeBanner();
  applyUiMode(document.documentElement.getAttribute('data-ui-mode') || 'pro');
  renderProviders();
  renderThreadHead();   // 121-K5：线程头那一组 chip（权限／模型／引擎）与管家条
  renderCapBadge();
  if (state.status) renderStatusLine();
  updateSkillBadge();
  updateAgentTeamButton();
  void loadAutonomyGrants();
  refreshLocalizedUsage();
  refreshLocalizedObservability();
  if (document.querySelector('.tool-tabs button.active')?.dataset.tab === 'files') void loadFileTree();
  refreshLocalizedArtifactChanges();
  if (!$('skillModal')?.classList.contains('hidden')) renderSkillList();
  if (!$('paletteModal')?.classList.contains('hidden')) renderPalette();
  if (!state.streaming) {
    if (state.currentSession) {
      const messages = $('messages');
      const scrollTop = messages?.scrollTop || 0;
      const wasAtBottom = !messages || (messages.scrollHeight - messages.clientHeight - scrollTop <= 4);
      renderCurrentSession();
      if (messages && !wasAtBottom) messages.scrollTop = Math.min(scrollTop, Math.max(0, messages.scrollHeight - messages.clientHeight));
    }
    else if ($('messages')?.querySelector('.empty-state')) {
      $('messages').innerHTML = '';
      $('messages').appendChild(buildEmptyState());
    }
  }
});

// UI v3 (§2.15): icon+文字按钮统一重建器 —— 清空后 append [SVG 图标] + [文字]。文案会变的按钮
// (发送⇄停止 / 技能徽标)复用它:直接赋 textContent 会吞掉已插入的 SVG,故走 append。
/* ---------------- attachments ---------------- */
// Token auth is header-only, so images are fetched through JS and shown via objectURL — never as a
// raw <img src> that would need a query-string token. One objectURL per attachment, cached.
const attachmentUrlCache = new Map();
function attachmentImageUrl(att) {
  const id = String((att && att.id) || '');
  const name = String((att && att.name) || '');
  if (!id || !name) return Promise.resolve('');
  const key = `${id}/${name}`;
  let pending = attachmentUrlCache.get(key);
  if (!pending) {
    pending = fetch(`/api/upload/content?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`, { headers: authHeaders() })
      .then(res => { if (!res.ok) throw new Error(String(res.status)); return res.blob(); })
      .then(blob => URL.createObjectURL(blob));
    attachmentUrlCache.set(key, pending);
    pending.catch(() => attachmentUrlCache.delete(key));
  }
  return pending;
}
function renderAttachments() {
  const tray = $('attachmentTray');
  tray.innerHTML = '';
  state.attachments.forEach((f, i) => {
    const pill = el('span', 'attachment-pill');
    if (f.previewUrl) {
      const thumb = document.createElement('img');
      thumb.className = 'attach-pill-thumb';
      thumb.src = f.previewUrl;
      thumb.alt = f.name || '';
      pill.appendChild(thumb);
    }
    pill.append(el('span', '', `${f.name} · ${fmtBytes(f.size)}`));
    const x = el('button', 'attach-x'); x.appendChild(icon('close', 12)); x.setAttribute('aria-label', t('chat.attachRemoveAria')); x.title = t('common.remove');
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
    if (file.size > 90 * 1048576) { toast(t("toast.fileTooLarge", { p1: file.name }), 'err'); continue; }
    try {
      const data = await fileToBase64(file);
      const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: file.name, data }) });
      const record = res.file;
      if (record && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(String(record.name || ''))) record.previewUrl = URL.createObjectURL(file);
      state.attachments.push(record);
    } catch (e) { toast(t("toast.uploadFail", { p1: apiErrText(e) }), 'err'); }
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
  catch (e) { toast(t("toast.locateFolderFail", { p1: apiErrText(e) }), 'err'); return; }
  const matches = (r && Array.isArray(r.matches)) ? r.matches : [];
  if (!matches.length) {
    // v1.0.2 返修二:浏览器安全模型拿不到拖入文件夹的完整路径,指纹搜索对深层目录(如 Videos\…\子目录)
    // 天然无解 —— 失败时别只闪图标,直接把选择弹层(含粘贴路径输入)送到手边,兜底一步可达。
    toast(t("toast.dragPathLost", { p1: name }), 'err');
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
  defWrap.append(defChk, document.createTextNode(t('workspace.setDefault')));
  body.appendChild(defWrap);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const go = el('button', 'primary', t('workspace.switchBtn'));
  foot.append(cancel, go);
  const modal = buildModal(t('workspace.switchTitle'), body, foot);
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
    item.append(el('code', 'ws-match-path', m.path), el('span', 'ws-match-score', t('common.relevance') + Math.round(m.score * 100) + '%'));
    item.onclick = async () => { modal.close(); await setWorkspace(m.path); };
    list.appendChild(item);
  }
  body.appendChild(list);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  foot.append(cancel);
  const modal = buildModal(t('workspace.chooseTitle'), body, foot);
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

// 121-K2b（34 号文 §6.2）：事件流。组合根持【一条】连接，注入管家壳（左栏／焦点／对话流）与
// 工作台（2.0 的「它正在跑」卡）—— 两视角共用同一条，绝不各开一条（在场信号按连接计，多开一条
// 服务端就以为你同时坐在两个地方，§4.3 的打扰纪律会跟着错）。
// 在场信号的两个读口：视角读 data-shell-mode（全仓唯一的视角状态源），会话读 state.currentSession。
const eventStream = createEventStream({
  lensProvider: () => (document.documentElement.getAttribute('data-shell-mode') === 'steward' ? 'steward' : 'classic'),
  sessionIdProvider: () => String((state.currentSession && state.currentSession.id) || ''),
});

const {
  autonomyFormSync,
  bindRailSessionActions, // 121-K4：左栏行上三枚会话级动作（置顶/重命名/删除）的委托
  buildEmptyState,
  cliMissingCard,
  errorCard,
  isFirstRun,
  isUntitledTitle,
  loadAutonomyGrants,
  newSession,
  openBulkCleanupModal,
  openOnboardingWizard,
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
  scheduleSessionSearch,
  sessionSearchSnapshot, // 121-K4：左栏搜索读 113b 的结果快照
  setRailRenderer, // 121-K4：左栏由管家域那一份 renderRail 画（迟绑定）
  renderStepBar,
  revealOriginalMessage, // 124-P2：委托书「看原件」的落点（管家域只转交，实现在会话域）
  revokeAllAutonomyGrants,
  rollbackTurn,
  stopMission,
  submitGrant,
  toggleStepBar,
  turnArtifactChips,
  turnSummaryCard,
} = createSessionExperienceDomain({
  applyShellMode: mode => applyShellMode(mode), // 121-K7（§8.4）：向导完成页落在管家视角（迟绑定：控制器在下面才建）
  eventStream, // 121-K2b：2.0「它正在跑」卡吃 thread.live；换会话时由 openSession 报新的在场信号
  apiErrText,
  renderMarkdownInto: (...args) => renderMarkdownInto(...args), highlightIn: (...args) => highlightIn(...args), // 118a-fix: 手册阅读器复用同一条已消毒 markdown 管线
  openModal: id => openModal(id),
  switchSettingsTab: (name, force) => switchSettingsTab(name, force),
  activeTurns,
  openCapPopover: (...args) => openCapPopover(...args),
  openPermPopover: (...args) => openPermPopover(...args),
  sendPrompt: text => sendPrompt(text),
  syncStreamingUi: () => syncStreamingUi(),
  buildModal: (...args) => buildModal(...args),
  renderContextMeter: usage => renderContextMeter(usage),
  isProviderMode: () => isProviderMode(),
  activeProviderObj: () => activeProviderObj(),
  currentEngineMeta: () => currentEngineMeta(),
  engineVisual: meta => engineVisual(meta),
  engineLabel: () => engineLabel(),
  currentModelId: () => currentModelId(),
  openRenamePopover: (...args) => openRenamePopover(...args),
  steerPendingList,
  steeredSeen,
  resetStickyScroll: () => resetStickyScroll(),
  scrollMessagesToBottom: () => scrollMessagesToBottom(),
  mountActiveTurn: sessionId => mountActiveTurn(sessionId),
  renderWorkspacePicker: () => renderWorkspacePicker(),
  updateSkillBadge: () => updateSkillBadge(), updateEngineDependentUI: () => updateEngineDependentUI(),
  renderStaticMessage: (...args) => renderStaticMessage(...args),
  latestUsage: session => latestUsage(session),
  pickWorkspaceNative: () => pickWorkspaceNative(),
  playbookDisplayName,
  playbookDisplayDescription,
  playbookDisplayUnavailableReason,
  playbookInputLabel,
  playbookStatusText,
});

// 121-K1（34 号文 §8.2）：视角模式控制器。applyShellMode 是全仓写 data-shell-mode 的唯一常规入口，
// 它与管家壳互为注入依赖（控制器问「进得去吗」，管家壳答并在进不去时 fail-closed 回工作台视角）。
const shellModeController = createShellModeController({
  // 121-K4（§2.9）：切视角走 View Transitions，共享元素的名字在拍旧帧之前由外框那一层挂上。
  // 迟绑定闭包（appFrame 在下面才建）：与 stewardShellGuard 同一条解环手法。
  markSharedThread: () => (appFrame ? appFrame.markSharedThread() : () => {}),
  canEnterSteward: () => Boolean(stewardShellGuard && stewardShellGuard.canEnterSteward()),
  recoverStewardShell: options => (stewardShellGuard ? stewardShellGuard.recoverStewardShell(options) : ''),
  closeSettings: () => closeModal('settingsModal'),
  // 121-K5（§2.7）：「在工作台打开」的第二步（openSession）。第一步是 applyShellMode 自己。
  openSession,
});
const { applyShellMode, openInWorkbench, bindShellModeControl } = shellModeController;

// 117a：管家壳（第三种壳模式，默认关）。只组合模式与容器骨架；avatar/对话/递话/抽屉/看板归 117b–h。
const stewardShellDomain = createStewardShellDomain({
  api,
  state,
  t,
  eventStream, // 121-K2b：壳层／左栏／焦点栏的推送口（同一条连接，壳层再转给看板与抽屉）
  applyShellMode,
  closeSettings: () => closeModal('settingsModal'),
  now: () => new Date(),
  openSession, // 117d：左栏行点击＝把中栏换成那条线程
  openInWorkbench, // 121-K5：焦点栏／对话流交付卡／左栏行的「在工作台打开」（切视角＋openSession，一处实现）
  modelMenuExtras, // 121-K5（§3.1）：2.0 模型弹层独有的三件全局事，挂线程头那组 chip 的模型菜单尾部
  // 121 走查1-⑤（用户 2026-09-13 走查第 5 条）：线程头那组 chip 改完【这条线程】的引擎／模型／权限
  // 之后要刷的经典壳读面。退役前 2.0 的 setEngineModel 末尾跑的就是这三样（navigation-controls.js
  // 的 onEngineConfigChanged / updateEngineDependentUI / updateContextMeter），K5 换控件时漏掉了 ——
  // 于是空态那行「当前引擎：…」、#statusLine 的 title 与上下文电量都停在旧值上，看着就像「没生效」。
  // 线程头那组 chip 自己已经在 thread-head.js 的 onChanged 里重画过，这里【不】再调 renderThreadHead。
  onSessionMetaChanged: () => {
    updateEngineDependentUI();
    updateContextMeter();
    if (state.status) renderStatusLine();
  },
  revealOriginalMessage, // 124-P2：委托书「看原件」→ 滚到这条线程的第一条消息（管家递进来的那份原件）
  searchState: () => sessionSearchSnapshot(), // 121-K4：左栏搜索（Ctrl+K）读 113b 的结果快照
  saveConfigPartial, openSettingsTab: tab => { openModal('settingsModal'); switchSettingsTab(tab || 'steward', true); }, // 117e
  // 117s-C（走查⑦「输出要支持 markdown、制图」）：全仓唯一的 markdown＋XSS 净化路径（trusted innerHTML
  // 只住在 chat-render-primitives 的 renderMarkdownInto 里）每个消费者都在【这里】注入拿到；管家壳接上
  renderMarkdownInto, highlightIn,   // 同一根线（shell 转注入 conversation），不另起第二个 markdown 通道
  openOnboardingWizard,              // 122-L1b（36 号文 §2.13）：管家问候行下那枚「开始引导」＝工作台空态那一个入口
});
stewardShellGuard = stewardShellDomain;
const { bindStewardShell } = stewardShellDomain;
// 121-K4（§2.3）：左栏是两视角共用的那一份 DOM，画它的只有管家域里那一处 renderRail。
// 工作台这一侧（开／建／改名／删会话）调的仍是 renderSessions —— 那个名字现在只是这条转接口。
setRailRenderer(() => stewardShellDomain.board.syncRail());
// 121-K4：外框（顶栏的视角分段钮与齿轮菜单、左栏的密度与 Ctrl+K、≤1180 的右栏抽屉、
// §2.7 的滚动位置保持、§2.9 的共享元素命名）。它只调 applyShellMode，不写 data-shell-mode ——
// 唯一写者仍是 shell-mode.js。
// sharedThreadId：两个视角此刻指的是不是【同一条线程】—— 管家侧问焦点栏（board.focusThreadId），
// 工作台侧问组合根手里的当前会话。相同才给那两个标题起同一个 view-transition-name（§2.9 表第五行）。
// 「在工作台打开」那一拍：openSession 还没落，currentSession 不是焦点线程，但【将要打开的】就是
// 焦点线程 —— 这一半由控制器在切视角那一拍里提供（pendingOpenThreadId，拍旧帧前同步问、问完即清），
// 否则管家→工作台的主路径上标题共享元素永远挂不上名（用户 2026-09-14 走查）。
const appFrame = createAppFrame({
  applyShellMode,
  intendedMode: () => (shellModeController.intendedShellMode ? shellModeController.intendedShellMode() : ''),
  sharedThreadId: () => {
    const focus = stewardShellGuard ? String(stewardShellGuard.board.focusThreadId() || '') : '';
    if (!focus) return '';
    const current = String((state.currentSession && state.currentSession.id) || '');
    const pending = shellModeController.pendingOpenThreadId ? shellModeController.pendingOpenThreadId() : '';
    return focus === current || (pending && focus === pending) ? focus : '';
  },
});
const { bindAppFrame } = appFrame;

// ── 121-K4（34 号文 §2.3）：左栏那枚「＋」的两义 ──────────────────────────────────
// 同一枚按钮（#newSessionBtn），两视角两种含义：
//   管家视角「＋ 新任务」= 让如意【另起一件】—— 只把输入框的递送目标切成「→ 如意 · 另起一件」
//     并聚焦，**不建会话**；回车之后由管家开任务与首条线程（走 13k 的 steward_thread_new）。
//     它派的是 steward:new-thread（missionId 空串＝没有事项可挂，composer 的 markNewInMission
//     把它落到「另起一件」那一档），与抽屉／左栏行上的「＋ 线程」同一条通道，不新起第二条。
//   工作台视角「＋ 新线程」= 立即开一条线程（2.0 那条 createSession），**并且清空中栏现场**。
function startFromRail() {
  if (document.documentElement.getAttribute('data-shell-mode') === 'steward') {
    try { document.dispatchEvent(new CustomEvent(STEWARD_NEW_THREAD_EVENT, { detail: { missionId: '', fromSessionId: '' } })); }
    catch { /* 无 CustomEvent 的宿主 */ }
    return null;
  }
  clearThreadStage();
  return newSession();
}
// 「清空中栏现场」（用户 2026-09-10 晚追加，§2.3）：消息流、附件托盘、草稿、「它正在跑」卡、
// 右栏「项目与进度」的本轮变更全部归零，不把上一条线程的任何内容带进新线程；工作区沿用
// （那是唯一保留的上下文，newSession 自己读 state.config.defaultWorkspace）。
//   · 消息流与空态：newSession → renderCurrentSession 已经重画（新会话没有消息）；
//   · 「它正在跑」卡：liveTurnVisible() 的第一道门就是「手上这份活文本是不是当前会话的」，
//     换到新会话后它自然为假（session-experience 的那处判据，不在这里抄第二份）；
//   · 附件托盘／草稿／本轮变更这三样是【本页自己的状态】，没人替它们归零 —— 就是这里。
function clearThreadStage() {
  state.attachments.length = 0;
  renderAttachments();
  const input = $('promptInput');
  if (input) { input.value = ''; autoGrow(input); }
  try { localStorage.removeItem('wcw.draft'); } catch { /* 本机偏好不可用不影响本次清场 */ }
  const hint = $('composerHint');
  if (hint) { hint.innerHTML = ''; hint.style.display = 'none'; }
  void loadChanges();   // 右栏「本轮变更」：新会话一条都没有，它会落回空态提示
  return true;
}

function bindEvents() {
  bindShellModeControl(); // 121-K1：视角切换控件与首屏视角判定（data-shell-mode 的唯一常规写者）
  bindAppFrame(); // 121-K4：外框顶栏与左栏的框架动作（§2.2／§2.3／§7.3）
  bindStewardShell(); // 117a：管家壳骨架与「回到工作台视角」
  bindNotifySettings({ t }); // 121-K1：「提醒」设置块（本机偏好与系统通知授权；投递归 K6 的安静卡）
  bindRailPocket({ api, state, t, eventStream, openStewardPanel: section => stewardShellDomain.openStewardPanel(section), openUsage: () => { openToolPane(); switchTab('usage'); }, openDoctor: () => { openModal('settingsModal'); switchSettingsTab('doctor', true); }, isStewardMode: () => document.documentElement.getAttribute('data-shell-mode') === 'steward' }); // 121-K7：口袋四项（§2.3／§7.2；「体检 · 用量」两视角两条路）
  // sidebar
  $('newSessionBtn').onclick = () => { void startFromRail(); };
  bindRailSessionActions(); // 121-K4：左栏行上「置顶／重命名／删除」的委托（会话怎么改仍在 session-experience 一处）
  // 113b: 侧栏搜索改走去抖的内容搜索（q ≥ 2 字符）；它内部会再调 renderSessions，
  // 失败/关闭/还没回来时自动回退到旧的子串过滤。
  $('sessionSearch').oninput = scheduleSessionSearch;
  $('bulkCleanupBtn').onclick = () => openBulkCleanupModal();
  $('openSettingsBtn').onclick = () => openModal('settingsModal');
  $('helpBtn').onclick = () => openModal('helpModal');
  initHelpEntries(); // 118d: 齿轮菜单里的「帮助」(手册/管理员手册/重开引导/看日志/打开数据目录)与设置页「?」
  // 121-K4：手动折叠左栏这件事整条退役 —— 左栏进了外框、两视角共用，宽度由 §7.3 的容器查询决定
  // （≤980 折成 56px 图标栏）。两枚按钮、两个函数与那个本机偏好都已删（见 navigation-controls.js）。

  // topbar
  // 121-K5（34 号文 §3.1）：#modelChip／#permChip／隐藏的 #permSelect 三处接线随控件一起退役。
  // 线程的权限／模型／引擎只剩线程头那一组 chip（js/thread-head.js 用同一个 chips 工厂挂的，
  // 唯一写口 PATCH /api/sessions/:id）；新任务的两个默认值分别在外框顶栏的盾牌与模型菜单里改。
  // 122-L1b · U05 走查抓到的那一条（36 号文 §2.14）：跳转链接把焦点直送【当前视角】的输入框。
  // 两个视角各有自己的输入框，判据只读 data-shell-mode（属性是唯一状态源，本处不写它）。
  { const skip = $('skipToComposer'); if (skip) skip.onclick = () => {
    const steward = document.documentElement.getAttribute('data-shell-mode') === 'steward';
    const box = $(steward ? 'stewardComposerInput' : 'promptInput');
    if (box) { try { box.scrollIntoView({ block: 'nearest' }); } catch { /* 老宿主没有它 */ } box.focus(); }
  }; }
  { const cm = $('contextMeter'); if (cm) cm.onclick = openContextPopover; }
  // v0.8-S6 capability matrix。122-L1b：**不能直接把函数当 handler** —— onclick 会把 MouseEvent
  // 当第一个实参（openCapPopover 的 anchorOverride）递进去，popover 拿它调 getBoundingClientRect
  // 当场抛。原先 #capBadge 是 display:none 的状态载体、点不到，这条才一直没发作；现在它是齿轮
  // 菜单里真能点的第七项，必须包一层。
  { const cb = $('capBadge'); if (cb) cb.onclick = () => openCapPopover(); }
  // 122-L1b（36 号文 §2.12）：这两枚现在是齿轮菜单里【看得见】的两项，切完要把自己的文案对上
  // （applyTheme／applyUiMode 的 iconTextBtn 会清空按钮内容，syncMoreMenuLabels 负责补回来）。
  // 「更多」#moreMenuBtn 与 openMoreMenu 已整枚退役。
  $('themeToggle').onclick = () => { toggleTheme(); syncMoreMenuLabels(); };
  { const um = $('uiModeToggle'); if (um) um.onclick = () => { toggleUiMode(); syncMoreMenuLabels(); }; } // v0.9-S1 (C1)
  { const wp = $('workspacePicker'); if (wp) wp.onclick = pickWorkspace; } // v0.9-S3 (C3)
  $('toggleToolsBtn').onclick = toggleToolPane;
  // v0.8-S3 step-bar: click the head to expand/collapse the full task list.
  { const sbt = $('stepBarToggle'); if (sbt) sbt.onclick = () => toggleStepBar(); }
  { const msb = $('missionStopBtn'); if (msb) msb.onclick = stopMission; } // 第26波b
  // 第27波:授权书抽屉事件绑定。
  { const t = $('autonomyIssueToggle'); if (t) t.onclick = () => { const f = $('autonomyIssueForm'); if (f) { f.classList.toggle('hidden'); if (!f.classList.contains('hidden')) { autonomyFormSync(); $('autonomyBar').classList.remove('hidden'); } else loadAutonomyGrants(); } }; }
  { const ra = $('autonomyRevokeAll'); if (ra) ra.onclick = revokeAllAutonomyGrants; }
  { const tl = $('agTool'); if (tl) tl.onchange = autonomyFormSync; }
  { const pv = $('agPreview'); if (pv) pv.onclick = previewGrant; }
  { const cx = $('agCancel'); if (cx) cx.onclick = () => { $('autonomyIssueForm').classList.add('hidden'); loadAutonomyGrants(); }; }
  { const fm = $('autonomyIssueForm'); if (fm) fm.onsubmit = submitGrant; }
  // ↓ 回到最新: click snaps to bottom 并恢复跟随;the messages scroll listener toggles its visibility + 粘性状态。
  // 先打断在途的平滑滚轮动画，避免旧目标把跳转拉回半途。
  { const jl = $('jumpLatest'); if (jl) jl.onclick = () => { messagesSmoothWheel.stop(); scrollMessagesToBottom(); }; }
  { const mb = $('messages'); if (mb) mb.addEventListener('scroll', syncStickToBottom, { passive: true }); }
  // A5: clicking the dimmed backdrop closes the narrow-screen drawer.
  { const bd = $('drawerBackdrop'); if (bd) bd.onclick = closeToolDrawer; }

  // composer
  const ta = $('promptInput');
  ta.addEventListener('input', () => { autoGrow(ta); try { localStorage.setItem('wcw.draft', ta.value); } catch { /* ignore */ } updateSendBtn(); }); // 50-fix:输入变化即时切「插话/停止」
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendPrompt(); }
  });
  $('sendBtn').onclick = () => sendPrompt();
  createComposerVoice({ state, t, id: 'composerVoiceBtn', input: () => $('promptInput'), anchor: () => $('sendBtn') }); // 127-⑦：只回填不发送
  $('agentTeamBtn').onclick = toggleAgentTeamTurn;
  bindSkillsMemory(); // EC-D：技能按钮与搜索键盘交互由技能/记忆领域自持
  // v3 (§B2): 「AI 工作」面板顶部的用量/审计 mini 链接 —— 简易模式经此切到隐藏页签(switchTab 不拦这两个 tab)。
  { const u = $('usageMiniLink'); if (u) u.onclick = () => { switchTab('usage'); }; }
  { const a = $('auditMiniLink'); if (a) a.onclick = () => { switchTab('audit'); }; }
  { const cb = $('compactBtn'); if (cb) cb.onclick = compactContext; }
  // ≤560px composer fold: composerMoreBtn opens the popover with 添加文件/技能/压缩 (§4.3 tail).
  { const mb = $('composerMoreBtn'); if (mb) mb.onclick = openComposerMorePopover; }
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
  document.querySelectorAll('.tool-pane .tool-tabs button').forEach(b => { b.onclick = () => { noteToolTabOpened(b.dataset.tab); switchTab(b.dataset.tab); }; });
  { const closePane = $('closeToolPaneBtn'); if (closePane) closePane.onclick = closeToolDrawer; }
  bindWorkbench(); // 第60波:主视图 Tab 与窄屏右板 backdrop 由 Workbench 域自持
  bindFileBrowser(); // 第59波:文件树刷新按钮由领域模块自持
  bindArtifactChanges(); // 第59波:产物与变更中心按钮接线由领域模块自持
  // 29a 对抗轮 P2(#14): 手动刷新必须【强制全量】。旧写法 `ar.onclick = loadAgentRuns` 把 MouseEvent 当首参传入,
  // loadAgentRuns(force) 的 `force !== true` 判定 MouseEvent≠true → 走增量路径,退化成又一次普通 tick;用户面对缓存
  // 陈旧(如冷路径 apply_isolation 后)点"刷新"得到同一份 digest 对比结论,无法恢复。显式传 true = 设计承诺的手动 force。
  { const ar = $('agentRunsRefreshBtn'); if (ar) ar.onclick = () => loadAgentRuns(true); }
  bindUsageDashboard(); // 第61波：刷新与范围段控由用量领域自持
  { const we = $('workflowEditorBtn'); if (we) we.onclick = () => openWorkflowEditor(); }
  { const wr = $('workflowQuickRunBtn'); if (wr) wr.onclick = launchAgentWorkflowFromQuickSelect; }
  bindOperationsObservability(); // 第59波:审计、存储与性能面板按钮接线由领域模块自持
  $('refreshDoctorBtn').onclick = () => refreshStatus();
  $('debugClearBtn').onclick = () => { state.rawEvents = []; $('rawEvents').innerHTML = ''; };
  $('debugDownloadBtn').onclick = downloadRawEvents;

  // settings modal
  $('saveConfigBtn').onclick = saveSettings;
  { const ap = $('addProviderBtn'); if (ap) ap.onclick = addProviderFromPreset; }
  { const cp0 = $('applyClaudeEndpointPresetBtn'); if (cp0) cp0.onclick = applyClaudeEndpointPreset; }
  { const im = $('importMcpFolderBtn'); if (im) im.onclick = () => importMcpFromFolder(im); } // v1.0.2 (G5c)
  bindSettingsOperations(); // 第58波:更新中心 + MCP 运维的按钮接线由领域模块自持
  bindAgentRoles(); // 第61波：角色编辑与子代理偏好按钮由角色领域自持
  document.querySelectorAll('#settingsTabs button[data-stab]').forEach(b => { b.onclick = () => switchSettingsTab(b.dataset.stab); }); // 118d: 同排还有一个「?」按钮,只给真页签接线
  { const st = $('cfgSearchType'); if (st) st.onchange = updateSearchBackendVisibility; } // v1.0-S3 (B1)
  // 118g: 「打开数据目录」的接线搬进 initHelpEntries(),改走 /api/open-path 枚举通道(前端不再经手路径串)。
  // Route static-modal closes through closeModal(id) so focus returns to the trigger (§4.9). Dynamic
  // buildModal backdrops have no id / no [data-close-modal] and manage their own focus restore.
  document.querySelectorAll('[data-close-modal]').forEach(b => { b.onclick = () => { const bd = b.closest('.modal-backdrop'); if (bd && bd.id) closeModal(bd.id); else if (bd) bd.classList.add('hidden'); }; });
  document.querySelectorAll('.modal-backdrop').forEach(m => { m.addEventListener('mousedown', e => { if (e.target === m) { if (m.id) closeModal(m.id); else m.classList.add('hidden'); } }); installFocusTrap(m); }); // 第50波 a11y P0:静态模态也装焦点陷阱

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
// 128f-① 用户首启走查改造后整块搬进 js/boot-failure.js（头注在那边）；这里只剩接线。
const { bootFailureKind, tagBootStep, bootStep, bootStepSync, renderBootFailure } = createBootFailure({
  apiErrText: error => apiErrText(error),
  bootData: () => bootData(),
  // 首跑时配置没读到，界面语言只是按浏览器猜的；重试拉起来之后按用户设的来（只应用、不写回）。
  afterRecover: () => setLocale(state.config?.locale || 'auto'),
});

async function boot() {
  await initToken(); // 47c(S1):bootstrap 握手取 token 进 sessionStorage(HTML 不再明文下发);须在任何 api() 前
  await initI18n('auto');
  hydrateIcons(); // UI v3 (§2.15): 把 index.html 静态 chrome 按钮/徽标的 [data-icon] 填充为内联 SVG
  setStreaming(false);
  bindEvents();
  applyTheme((() => { try { return localStorage.getItem('wcw.theme') || 'dark'; } catch { return 'dark'; } })());
  applyUiMode((() => { try { return localStorage.getItem('wcw.uiMode') || 'simple'; } catch { return 'simple'; } })()); // v0.9-S1 (C1) / v1.0.2 (F5): 默认 simple 对齐 server
  restoreToolsCollapsed(); // 桌面外壳首启默认收起工具面板；用户偏好优先
  restoreRightWidth(); initRightResize(); // v3 (§2.7 P2): 恢复右栏三档宽 + 绑定拖拽手柄
  restoreMainView(); // v3 P3a: 恢复中栏主视图(对话/工作台)记忆
  try { const d = localStorage.getItem('wcw.draft'); if (d) { $('promptInput').value = d; autoGrow($('promptInput')); } } catch { /* ignore */ }
  try { await bootData(); }
  catch (err) {
    // 用户首启走查：连不上（传输层）才整段中止、交给 boot().catch 画卡；服务应答了、只是某一步没走通 —— 卡照画，
    // boot 照走完（语言、推送连接）。修前一抛就整段中止，推送连接根本没起，界面能用却不再自己更新。
    if (bootFailureKind(err) === 'unreachable') throw err;
    renderBootFailure(err);
  }
  // 语言这一步同理：抛了只画卡（带步骤名），不拦后面的推送连接。
  // 但【只有真读到了配置】才许把自动判出的语言写回去：修前 bootData 一抛就整段中止、走不到这里；现在会走到，
  // 而 /api/status 没到时 state.config 还是初值 {}，locale 读成 'auto' —— 写回去就把用户设的 en-US 覆盖掉
  // （「写回没读到的状态」那个模具，见 provider-settings 头注）。boot-failure-kind.browser B5b 钉。
  const configLoaded = Boolean(state.status && state.status.config);
  try {
    const configuredLocale = state.config?.locale || 'auto';
    const resolvedLocale = await setLocale(configuredLocale);
    if (configuredLocale === 'auto' && configLoaded) {
      await saveConfigPartial({ locale: resolvedLocale });
      fillSettings();
    }
  } catch (err) { renderBootFailure(tagBootStep(err, 'setLocale · POST /api/config')); }
  // 121-K2b（§6.2）：推送连接排在 boot 的【最后】—— 不是为了省事，而是因为连接参数就是在场信号
  // （§4.3），而它得等两件事落定才算真：① 哪个视角 —— config 到达前 bindShellModeControl 会先 fail-closed
  // 到工作台视角（见 34 号文 §13.1 记的那条时序），这一拍报上去就是假的；② 哪条会话 —— bootData
  // 才把上次那条打开。抢在前面起的话，收件箱的在场门（K3 §4.3）会拿到一两百毫秒的错信号，
  // 而且百害无一利地多建两条连接（每次在场变就重连，那是唯一的写口）。
  eventStream.start();
}
// v1.5 (§1.3): boot 的「连本地服务 + 拉数据」段拆出成独立函数,供故障卡「重试连接」在不重跑 bindEvents
// (会重复绑 addEventListener)的前提下重试。任何一步抛错都冒泡给调用方(boot().catch / 重试处理)渲染故障卡。
async function bootData() {
  // 每一步贴上步骤名（诊断里的「出错的那一步」）；不改次序、不改哪几步 await —— 没 await 的两发照旧不 await。
  await bootStep('refreshStatus · GET /api/status', () => refreshStatus());
  await bootStep('refreshSessions · GET /api/sessions', () => refreshSessions());
  loadAgentWorkflows();
  refreshPlaybooks(); // v0.9-S2: load playbook cards for the empty state (best-effort, non-blocking)
  let last = null; try { last = localStorage.getItem('wcw.lastSession'); } catch { /* ignore */ }
  const target = state.sessions.find(s => s.id === last) || state.sessions[0];
  if (target) await bootStep('openSession · GET /api/sessions/:id', () => openSession(target.id));
  // v1.0-S3 (A): no session to open (fresh install) → render the empty state now so the first-run 引导
  // variant appears deterministically (isFirstRun() reads the now-loaded sessions + config, not just the
  // best-effort playbook re-render).
  else bootStepSync('renderCurrentSession', () => renderCurrentSession());
  // v0.8-S2: PowerShell is the default-active tab, so start the shell-session poll now.
  bootStepSync('updateShellPolling', () => updateShellPolling());
}
// v1.5 (§1.3): 首次连接本地服务失败 —— 不再只把英文错误塞进状态行 + toast,而是在对话区渲染显式故障卡
// (大标题 +「无法连接本地服务」+ 三条可能原因 +「重试连接」+「查看日志/诊断」)。主画像第一次翻车最狠的点。
boot().catch(err => renderBootFailure(err));

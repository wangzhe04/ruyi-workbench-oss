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
import { captureScrollAnchor, messageDomKey, messageRenderSignature, normalizeTurnSegments, restoreScrollAnchor, turnToolAnchorId }
  from './js/turn-narrative.js';
import { createChatScrollController, enableSmoothWheelScroll } from './js/chat-scroll.js';
import { createSettingsOperationsDomain } from './js/settings-operations.js';
import { createFileBrowserDomain } from './js/file-browser.js';
import {
  ARTIFACT_KIND_ICON,
  createArtifactChangesDomain,
} from './js/artifact-changes.js';
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
import { createChatStaticRenderer } from './js/chat-static-renderer.js';
import { createChatStreamRuntime } from './js/chat-stream-runtime.js';
import { createPreviewShellDomain } from './js/preview-shell.js';
import { dispatchAcceptanceMilestones } from './js/preview-task-sheet.js';

// Chat streaming is composed before the Preview domain. Keep a narrow late-bound sink so the shared
// runtime can mirror read-only deltas without importing the second shell or creating a second stream.
let previewStreamSink = null;

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
};
function apiErrText(error) {
  const info = apiErrorInfo(error);
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
} = createProviderSettingsDomain({
  apiErrText,
  renderModelChip: () => renderModelChip(),
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
  openToolPane: () => openToolPane(),
  runTool: (...args) => runTool(...args),
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
  saveAsPlaybook,
  safeStringify,
  setCtxWindowManual,
  settleLiveThinking,
  thinkingPanel,
  toolCard,
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
  refreshPlaybooks: (...args) => refreshPlaybooks(...args),
  refreshSessions: (...args) => refreshSessions(...args),
  renderCurrentSession: (...args) => renderCurrentSession(...args),
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
  appendToolOutput: (...args) => appendToolOutput(...args),
  authHeaders,
  autoGrow,
  cliMissingCard: (...args) => cliMissingCard(...args),
  compactNarrativeProcessRuns: (...args) => compactNarrativeProcessRuns(...args),
  currentEngineMeta: () => currentEngineMeta(),
  currentWorkspace: () => currentWorkspace(),
  el,
  engineLabel: () => engineLabel(),
  errorCard: (...args) => errorCard(...args),
  emitSessionStream: event => previewStreamSink?.(event),
  fmtTokens,
  handleAgentWorkflowEvent: (...args) => handleAgentWorkflowEvent(...args),
  handlePermissionRequest: (...args) => handlePermissionRequest(...args),
  handlePlanEvent: (...args) => handlePlanEvent(...args),
  highlightIn,
  iconTextBtn,
  isProviderMode: () => isProviderMode(),
  isUntitledTitle: title => isUntitledTitle(title),
  latestUsage,
  loadAutonomyGrants: () => loadAutonomyGrants(),
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
  initRightResize,
  normalizeTabsForUiMode,
  noteToolTabOpened,
  openCapPopover,
  openComposerMorePopover,
  openContextPopover,
  openModal,
  openModelChipPopover,
  openMoreMenu,
  openPalette,
  openRenamePopover,
  openToolPane,
  popover,
  renderCapBadge,
  renderModelChip,
  renderPalette,
  restoreRightWidth,
  restoreSidebarCollapsed,
  restoreToolsCollapsed,
  setSidebarCollapsed,
  switchSettingsTab,
  switchTab,
  syncMoreMenuLabels,
  toggleToolPane,
} = createNavigationControlsDomain({
  apiErrText,
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
  renderModelChip();
  populatePermSelect();
  renderPermChip();
  renderCapBadge();
  if (state.status) renderStatusLine();
  updateSkillBadge();
  updateAgentTeamButton();
  void loadAutonomyGrants();
  refreshLocalizedUsage();
  refreshLocalizedObservability();
  if (document.querySelector('.tool-tabs button.active')?.dataset.tab === 'files') void loadFileTree();
  refreshLocalizedArtifactChanges();
  refreshPreviewShellLabels();
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
function renderAttachments() {
  const tray = $('attachmentTray');
  tray.innerHTML = '';
  state.attachments.forEach((f, i) => {
    const pill = el('span', 'attachment-pill');
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
      state.attachments.push(res.file);
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

const {
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
} = createSessionExperienceDomain({
  apiErrText,
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
  updateSkillBadge: () => updateSkillBadge(),
  renderStaticMessage: (...args) => renderStaticMessage(...args),
  latestUsage: session => latestUsage(session),
  pickWorkspaceNative: () => pickWorkspaceNative(),
  playbookDisplayName,
  playbookDisplayDescription,
  playbookDisplayUnavailableReason,
  playbookInputLabel,
});

// 第78波：Preview 交办台与速问共用一个前端 command 入口。它只编排既有的 Session、Mission、
// chat/stream 三条权威链；任务态仍由后端 /api/mission action:start 建立，Preview 不写第二套状态。
async function startPreviewDispatchCommand({ kind = 'mission', prompt = '', cwd = '', permissionMode = '', autoMode = 'until-done', attachments = [] } = {}) {
  const message = String(prompt || '').trim();
  if (!message) throw new Error(t('previewShell.dispatchRequired'));
  const session = await newSession({ cwd: cwd || currentWorkspace(), focus: false });
  let mission = null;
  if (kind === 'mission') {
    const response = await api('/api/mission', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: session.id,
        action: 'start',
        // Mission prompt injection requires at least one milestone. Keep the goal as the user's request and
        // seed separately worded acceptance criteria so the ledger describes what "done" means, not the task again.
        mission: {
          goal: message,
          autoMode,
          milestones: dispatchAcceptanceMilestones(message),
        },
      }),
    });
    mission = response && response.mission;
    if (!mission) throw new Error(t('previewShell.dispatchStartFailed'));
    if (state.currentSession?.id === session.id) {
      state.currentSession.kind = 'mission';
      state.currentSession.mission = mission;
      renderMissionBar(mission);
    }
    await refreshSessions();
  }
  // 附件随首回合下发；supervised 表示“建完先暂停”，只立 Mission、不暗中启动首回合。
  const completion = kind === 'mission' && autoMode === 'supervised' ? null : sendPrompt(message, { permissionMode, attachments });
  return { sessionId: session.id, mission, completion };
}

// 第82波班组图的“递话”仍走 Agent Run 唯一 steer_node 动作。显式携带任务单 sessionId，避免
// Preview 正在查看的 Mission 与经典壳当前会话不同时把消息投到错误工作圈；领域层只拿成功/失败结果。
async function steerPreviewAgentNode({ sessionId = '', runId = '', nodeId = '', text = '' } = {}) {
  try {
    const response = await api(`/api/agent-runs/${encodeURIComponent(runId)}`, {
      method: 'POST',
      body: JSON.stringify({ sessionId, action: 'steer_node', nodeId, text }),
    });
    if (!response || response.ok !== true) throw response || new Error(t('workflow.injectFailed'));
    return { ok: true, immediate: response.live === true, queued: Number(response.queued) || 0 };
  } catch (error) {
    return { ok: false, error: apiErrText(error) || t('workflow.injectFailed') };
  }
}

// 第84波:Continue/Retry 已由 Mission 控制核心完成再武装；用户的一次明确点击随后复用经典
// sendPrompt 启动真实 provider 回合，Preview 不复制第二套流状态机。
// 第97波对抗复审(F2/F3):await sendPrompt —— 回合真正启动前(同步前缀)抛错会 reject 进 catch →
// {ok:false} → 前端 controlError 可达(不再静默);且 controlBusy 保持到回合结束,流式期间按钮
// 持续禁用(不再有双击窗口)。
async function runPreviewMissionControlTurn({ sessionId = '', prompt = '' } = {}) {
  try {
    await openSession(sessionId);
    if (!state.currentSession || state.currentSession.id !== sessionId) throw new Error(t('previewShell.controlSessionFailed'));
    await sendPrompt(String(prompt || '').trim());
    return { ok: true };
  } catch (error) {
    return { ok: false, error: apiErrText(error) || t('previewShell.controlTurnFailed') };
  }
}

const {
  bindPreviewShell,
  handlePreviewStreamEvent,
  refreshPreviewShell,
  refreshPreviewShellLabels,
} = createPreviewShellDomain({
  api,
  state,
  t,
  currentWorkspace: () => currentWorkspace(),
  engineLabel: () => engineLabel(),
  openSettings: tab => {
    openModal('settingsModal');
    switchSettingsTab(tab || 'basic', true);
  },
  closeSettings: () => closeModal('settingsModal'),
  openWorkspaceControl: anchor => pickWorkspace(anchor),
  openSafetyControl: anchor => openPermPopover(anchor),
  openEngineControl: anchor => openModelChipPopover(anchor),
  dispatchCommand: request => startPreviewDispatchCommand(request),
  openSession: id => openSession(id),
  setClassicDraft: value => {
    const input = $('promptInput');
    if (!input) return;
    input.value = String(value || '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  },
  syncClassicIntervention: async decision => {
    resolveClassicPromptIntervention(decision);
    resolveClassicPlanIntervention(decision);
    await refreshSessions();
    if (decision && state.currentSession?.id === decision.sessionId && !state.streaming) await openSession(decision.sessionId);
  },
  steerAgentNode: request => steerPreviewAgentNode(request),
  runMissionControlTurn: request => runPreviewMissionControlTurn(request),
  saveMissionAsPlaybook: (sessionId, button) => saveAsPlaybook(button, sessionId),
  saveMissionAsMemory: (sessionId, button) => saveAsMemory(button, sessionId),
  apiErrText,
  pickWorkspace: () => pickWorkspaceNative(),
  playbookName: playbook => playbookDisplayName(playbook),
  playbookDescription: playbook => playbookDisplayDescription(playbook),
  playbookUnavailableReason: playbook => playbookDisplayUnavailableReason(playbook),
  renderMarkdownInto: (container, value) => renderMarkdownInto(container, value),
  highlightIn: container => highlightIn(container),
  renderStaticMessage: (...args) => renderStaticMessage(...args),
  getActiveTurnLines: sessionId => {
    const turn = activeTurns.get(sessionId);
    if (!turn) return [];
    return turn.eventLines.slice(Number(turn.eventHead) || 0);
  },
});
previewStreamSink = handlePreviewStreamEvent;

function bindEvents() {
  bindPreviewShell(); // 第76波：默认关闭的新任务台壳层与本机持久切换
  // sidebar
  $('newSessionBtn').onclick = () => newSession();
  $('sessionSearch').oninput = renderSessions;
  $('bulkCleanupBtn').onclick = () => openBulkCleanupModal();
  $('openSettingsBtn').onclick = () => openModal('settingsModal');
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
      const confirmationKey = e.target.value === 'bypass' ? 'permission.mode.bypass.confirm' : 'permission.mode.auto.confirm';
      if (!confirm(t(confirmationKey))) {
        e.target.value = state.config.permissionMode || 'bypass'; populatePermSelect(); return;
      }
    }
    saveConfigPartial({ permissionMode: e.target.value }); state.config.permissionMode = e.target.value; populatePermSelect(); if (e.target.value === 'bypass') toast(t('permission.mode.bypass.activated'), 'err'); else if (e.target.value === 'auto') toast(t('permission.mode.auto.activated'), 'ok');
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
  document.querySelectorAll('#settingsTabs button').forEach(b => { b.onclick = () => switchSettingsTab(b.dataset.stab); });
  { const st = $('cfgSearchType'); if (st) st.onchange = updateSearchBackendVisibility; } // v1.0-S3 (B1)
  { const od = $('openDataDirBtn'); if (od) od.onclick = () => { const dr = (state.status && state.status.dataRoot) || ''; if (dr) runTool('browser_open', { url: dr }); }; }
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
// 占满对话区的显式故障卡:大标题「无法连接本地服务」+ 三条可能原因(端口被占/服务未启动/被安全软件拦截)
// +「重试连接」(重跑 bootData,不重复 bindEvents)+「查看日志/诊断」(展开原始错误详情,供排查/反馈)。
// 全中文人话,主卡不暴露英文栈 —— 原始 message 收进折叠的诊断面板(专家才需要)。DOM 全 createElement/
// textContent(F 安全红线,err 内容不可信)。故障卡可键盘操作:重试是真 <button> 且自动聚焦,诊断按钮
// 带 aria-expanded/aria-controls。
function buildBootFailureCard(err) {
  const wrap = el('div', 'boot-failure');
  wrap.setAttribute('role', 'alert');
  wrap.appendChild(el('div', 'boot-failure-icon', '⚠'));
  wrap.appendChild(el('h2', 'boot-failure-title', t('bootFailure.title')));
  wrap.appendChild(el('p', 'boot-failure-lead', t('bootFailure.lead')));
  const ul = el('ul', 'boot-failure-reasons');
  [
    [t('connection.reason.portOccupied'), t('connection.reason.portOccupiedDesc')],
    [t('connection.reason.serverNotStarted'), t('connection.reason.serverNotStartedDesc')],
    [t('connection.reason.securityBlock'), t('connection.reason.securityBlockDesc')],
  ].forEach(([t, d]) => {
    const li = el('li', 'boot-failure-reason');
    li.appendChild(el('span', 'boot-failure-reason-t', t));
    li.appendChild(el('span', 'boot-failure-reason-d', d));
    ul.appendChild(li);
  });
  wrap.appendChild(ul);
  const actions = el('div', 'boot-failure-actions');
  const retry = el('button', 'primary boot-retry', t('bootFailure.retry'));
  retry.type = 'button';
  retry.setAttribute('aria-label', t('bootFailure.retryAria'));
  retry.onclick = async () => {
    retry.disabled = true; retry.textContent = t('bootFailure.reconnecting');
    setStatus(t('bootFailure.reconnectingStatus'));
    try { await bootData(); } // 成功后 bootData 会重绘 #messages(会话/空状态),故障卡自然被替换
    catch (e) { renderBootFailure(e); }
  };
  actions.appendChild(retry);
  // 诊断面板:默认折叠;原始错误文本(可能含英文栈)只在这里出现。用 el/textContent 构建,永不 innerHTML。
  const panel = el('div', 'boot-failure-diag');
  panel.id = 'bootDiagPanel'; panel.hidden = true;
  panel.appendChild(el('pre', 'boot-failure-diag-pre', apiErrText(err) || t('common.unknownError')));
  panel.appendChild(el('p', 'boot-failure-hint', t('bootFailure.diagHint')));
  const diag = el('button', 'ghost boot-diag', t('bootFailure.diagButton'));
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
  try { setStatus(t('connection.cannotConnect')); } catch { /* ignore */ }
  try { toast(t("toast.connectFail"), 'err'); } catch { /* ignore */ }
  const box = $('messages');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(buildBootFailureCard(err));
  const retry = box.querySelector('.boot-retry');
  if (retry) setTimeout(() => { try { retry.focus(); } catch { /* ignore */ } }, 0);
}

/* ---------------- boot ---------------- */
async function boot() {
  await initToken(); // 47c(S1):bootstrap 握手取 token 进 sessionStorage(HTML 不再明文下发);须在任何 api() 前
  await initI18n('auto');
  hydrateIcons(); // UI v3 (§2.15): 把 index.html 静态 chrome 按钮/徽标的 [data-icon] 填充为内联 SVG
  setStreaming(false);
  bindEvents();
  applyTheme((() => { try { return localStorage.getItem('wcw.theme') || 'dark'; } catch { return 'dark'; } })());
  applyUiMode((() => { try { return localStorage.getItem('wcw.uiMode') || 'simple'; } catch { return 'simple'; } })()); // v0.9-S1 (C1) / v1.0.2 (F5): 默认 simple 对齐 server
  restoreSidebarCollapsed(); // v1.0.2 (F2): 恢复上次的折叠侧栏状态
  restoreToolsCollapsed(); // 桌面外壳首启默认收起工具面板；用户偏好优先
  restoreRightWidth(); initRightResize(); // v3 (§2.7 P2): 恢复右栏三档宽 + 绑定拖拽手柄
  restoreMainView(); // v3 P3a: 恢复中栏主视图(对话/工作台)记忆
  try { const d = localStorage.getItem('wcw.draft'); if (d) { $('promptInput').value = d; autoGrow($('promptInput')); } } catch { /* ignore */ }
  await bootData();
  const configuredLocale = state.config?.locale || 'auto';
  const resolvedLocale = await setLocale(configuredLocale);
  if (configuredLocale === 'auto') {
    await saveConfigPartial({ locale: resolvedLocale });
    fillSettings();
  }
}
// v1.5 (§1.3): boot 的「连本地服务 + 拉数据」段拆出成独立函数,供故障卡「重试连接」在不重跑 bindEvents
// (会重复绑 addEventListener)的前提下重试。任何一步抛错都冒泡给调用方(boot().catch / 重试处理)渲染故障卡。
async function bootData() {
  await refreshStatus();
  // Wave 80: when Preview was explicitly selected, paint its authoritative projection before doing
  // hidden classic-shell work (large session-list DOM + opening the last chat). Classic state still
  // hydrates immediately afterwards, so the recovery action remains complete without taxing first paint.
  const previewFirst = document.documentElement.getAttribute('data-shell-mode') === 'preview';
  if (previewFirst) {
    await refreshPreviewShell();
    refreshPreviewShellLabels();
  }
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
  if (!previewFirst) {
    await refreshPreviewShell();
    refreshPreviewShellLabels();
  }
  // v0.8-S2: PowerShell is the default-active tab, so start the shell-session poll now.
  updateShellPolling();
}
// v1.5 (§1.3): 首次连接本地服务失败 —— 不再只把英文错误塞进状态行 + toast,而是在对话区渲染显式故障卡
// (大标题 +「无法连接本地服务」+ 三条可能原因 +「重试连接」+「查看日志/诊断」)。主画像第一次翻车最狠的点。
boot().catch(err => renderBootFailure(err));

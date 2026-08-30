#!/usr/bin/env node
'use strict';

// 第59波 EC-D 前端拆域契约：
//   artifact-changes.js 持有产物画廊 + 变更中心；
//   operations-observability.js 持有审计 + 存储 + 性能指标；
//   app.js 只保留组合、页签入口与跨域依赖注入。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  CSS_COMPAT_ROUTES,
  CSS_ROUTES,
  LEGACY_STYLES_SHA256,
  readFrontendCss,
  readLayerPayload,
} = require('./read-frontend-css.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, relative), 'utf8');
const app = read('app.js');
const fileBrowser = read('js/file-browser.js');
const artifactChanges = read('js/artifact-changes.js');
const observability = read('js/operations-observability.js');
const workbench = read('js/workbench.js');
const usageDashboard = read('js/usage-dashboard.js');
const agentRoles = read('js/agent-roles.js');
const agentWorkflows = read('js/agent-workflows.js');
const navigation = read('js/navigation-controls.js');
const skillsMemory = read('js/skills-memory.js');
const providerSettings = read('js/provider-settings.js');
const sessionExperience = read('js/session-experience.js');
const interactionPrompts = read('js/interaction-prompts.js');
const toolRuntime = read('js/tool-runtime.js');
const workspacePreferences = read('js/workspace-preferences.js');
const chatRenderPrimitives = read('js/chat-render-primitives.js');
const chatStaticRenderer = read('js/chat-static-renderer.js');
const chatStreamRuntime = read('js/chat-stream-runtime.js');
const indexHtml = read('index.html');
const styleManifest = read('styles.css');
const chatStyleManifest = read('css/views/chat.css');
const layeredCss = readFrontendCss();
const overlayBuilder = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else {
    failures++;
    console.log('FAIL ' + label);
  }
}

ok(app.includes("from './js/artifact-changes.js'")
  && app.includes('createArtifactChangesDomain({')
  && app.includes('bindArtifactChanges();'), 'D1 app.js 组合产物/变更域并统一绑定');
ok(app.includes("from './js/operations-observability.js'")
  && app.includes('createOperationsObservabilityDomain({ apiErrText })')
  && app.includes('bindOperationsObservability();'), 'D2 app.js 组合可观测域并统一绑定');

for (const name of [
  'collectSessionArtifacts',
  'renderArtifactsGallery',
  'renderArtifactsFromState',
  'loadChanges',
  'renderChanges',
  'openChangeDiff',
  'rollbackChangeEntry',
]) {
  ok(artifactChanges.includes(`function ${name}(`) || artifactChanges.includes(`async function ${name}(`),
    `D3 artifact-changes 持有 ${name}()`);
}
ok(artifactChanges.includes("api(`/api/sessions/${sessionId}`)")
  && artifactChanges.includes("api('/api/checkpoints?sessionId='")
  && artifactChanges.includes("api(`/api/checkpoints/diff?sessionId=")
  && artifactChanges.includes("api('/api/checkpoints/rollback'"), 'D4 产物/变更四条 API 契约齐');
ok(/artifactsRefreshBtn[\s\S]{0,160}renderArtifactsGallery/.test(artifactChanges)
  && /changesRefreshBtn[\s\S]{0,160}loadChanges/.test(artifactChanges), 'D5 产物/变更刷新按钮由领域模块自持');
ok(navigation.includes("if (tab === 'artifacts') renderArtifactsGallery();")
  && navigation.includes("if (tab === 'changes') loadChanges();"), 'D6 导航域只保留产物/变更页签入口');

for (const name of [
  'loadAudit',
  'renderAuditList',
  'loadStorage',
  'renderStorage',
  'saveStoragePolicy',
  'cleanStorage',
  'loadMetrics',
  'renderMetrics',
  'openAuditTab',
  'openStorageTab',
]) {
  ok(observability.includes(`function ${name}(`) || observability.includes(`async function ${name}(`),
    `D7 operations-observability 持有 ${name}()`);
}
ok(observability.includes("api('/api/audit?limit=200')")
  && observability.includes("api('/api/storage/summary')")
  && observability.includes("api('/api/storage/policy'")
  && observability.includes("api('/api/storage/clean'")
  && observability.includes("api('/api/metrics')"), 'D8 可观测域五条 API 契约齐');
ok(/auditRefreshBtn[\s\S]{0,180}auditState\.loaded = false/.test(observability)
  && /storageRefreshBtn[\s\S]{0,180}storageState\.loaded = false/.test(observability)
  && /metricsRefreshBtn[\s\S]{0,180}metricsState\.loaded = false/.test(observability), 'D9 三个刷新入口保持强制重拉语义');
ok(navigation.includes("if (tab === 'audit') openAuditTab();")
  && !navigation.includes("if (tab === 'storage') openStorageTab();"),
  'D10 导航域保留活动页入口，存储已迁入设置体检');

ok(!/function (collectSessionArtifacts|renderArtifactsGallery|loadChanges|renderChanges|loadAudit|renderAuditList|loadStorage|renderStorage|loadMetrics|renderMetrics)\(/.test(app),
  'D11 领域实现已从 app.js 清空');
ok(!/\b(auditState|storageState|metricsState|changesState)\b/.test(app),
  'D12 领域内部状态不再泄漏到组合根');
ok(!/\.innerHTML\s*=/.test(artifactChanges) && !/\.innerHTML\s*=/.test(observability),
  'D13 两个新领域模块零 innerHTML 赋值');
ok(app.includes('refreshLocalizedArtifactChanges();')
  && app.includes('refreshLocalizedObservability();'), 'D14 locale 变更通过窄接口重绘领域视图');
ok(overlayBuilder.includes("'app/public/js/artifact-changes.js'")
  && overlayBuilder.includes("'app/public/js/operations-observability.js'"), 'D15 两个领域模块均进入 overlay 载荷');
ok(app.includes("from './js/file-browser.js'")
  && app.includes('createFileBrowserDomain({')
  && app.includes('bindFileBrowser();'), 'D16 app.js 组合文件浏览域并统一绑定');
for (const name of [
  'fetchDirLevel',
  'fileTreeRow',
  'loadFileTree',
  'renderFilePreviewInto',
  'renderTextPreview',
  'renderCsvTable',
  'mentionFile',
]) {
  ok(fileBrowser.includes(`function ${name}(`) || fileBrowser.includes(`async function ${name}(`),
    `D17 file-browser 持有 ${name}()`);
}
ok(fileBrowser.includes("api('/api/tools/file_list'")
  && fileBrowser.includes("api('/api/file/preview' + query)"), 'D18 文件树与预览 API 契约齐');
ok(fileBrowser.includes("frame.setAttribute('sandbox', '')")
  && (fileBrowser.match(/\.innerHTML\s*=/g) || []).length === 1
  && fileBrowser.includes('markdown.innerHTML = renderMarkdown(text);'), 'D19 HTML 空 sandbox + Markdown 唯一受控 innerHTML');
ok(!/function (fetchDirLevel|fileTreeRow|loadFileTree|renderFilePreviewInto|renderTextPreview|renderCsvTable|mentionFile)\(/.test(app)
  && overlayBuilder.includes("'app/public/js/file-browser.js'"), 'D20 文件实现离开 app.js 且进入 overlay 载荷');

ok(agentWorkflows.includes("from './workbench.js'")
  && agentWorkflows.includes('createWorkbenchDomain({')
  && app.includes('bindWorkbench();'), 'D21 app.js 组合 Workbench 域并统一绑定');
for (const name of [
  'layoutWorkbenchDAG',
  'switchMainView',
  'renderWorkbench',
  'renderWorkbenchCanvas',
  'wbNativeClaudeHydratedRuns',
  'wbNativeClaudeOnSubagent',
  'wbNativeClaudeFinalize',
  'wbOnRuns',
]) {
  ok(workbench.includes(`function ${name}(`),
    `D22 workbench 持有 ${name}()`);
}
ok(!/\bwbState\b/.test(app)
  && !/function (layoutWorkbenchDAG|switchMainView|renderWorkbench|wbNativeClaudeHydratedRuns|wbNativeClaudeOnSubagent|wbNativeClaudeFinalize|wbOnRuns)\(/.test(app),
  'D23 Workbench 状态与实现已从 app.js 清空');
ok(agentWorkflows.includes('isWorkbenchCanvasView()')
  && agentWorkflows.includes('markWorkbenchConnectionLost()')
  && workbench.includes('function isWorkbenchCanvasView()')
  && workbench.includes('function markWorkbenchConnectionLost()'),
  'D24 工作流轮询层仅通过窄接口读取画布态与标记断连');
ok((workbench.match(/\.innerHTML\s*=/g) || []).length === 0,
  'D25 Workbench 域保持零 innerHTML 赋值');
ok(overlayBuilder.includes("'app/public/js/workbench.js'"),
  'D26 Workbench 域进入 overlay 载荷');

ok(app.includes("from './js/usage-dashboard.js'")
  && app.includes('createUsageDashboardDomain({')
  && app.includes('bindUsageDashboard();'), 'D27 app.js 组合用量看板域并统一绑定');
for (const name of [
  'loadUsage',
  'renderUsage',
  'setUsageRange',
  'usageAggHead',
  'usageBudgetBanner',
  'usageBarSvg',
  'usageTrendSvg',
]) {
  ok(usageDashboard.includes(`function ${name}(`) || usageDashboard.includes(`async function ${name}(`),
    `D28 usage-dashboard 持有 ${name}()`);
}
ok(!/\busageState\b/.test(app)
  && !/function (loadUsage|renderUsage|setUsageRange|usageAggHead|usageBudgetBanner|usageBarSvg|usageTrendSvg)\(/.test(app),
  'D29 用量状态与实现已从 app.js 清空');
ok(navigation.includes("if (tab === 'usage') openUsageDashboard();")
  && app.includes('refreshLocalizedUsage();'),
  'D30 用量页签与 locale 重绘只走领域窄接口');

ok(app.includes("from './js/agent-roles.js'")
  && app.includes('createAgentRolesDomain({')
  && app.includes('bindAgentRoles();'), 'D31 app.js 组合 Agent 角色域并统一绑定');
for (const name of [
  'captureAgentRoleDraft',
  'renderAgentRoleEditors',
  'resetAgentRoleDraft',
  'loadAgentRoles',
  'saveAgentRoles',
  'addAgentRole',
  'populateSubagentPreferenceSelects',
]) {
  ok(agentRoles.includes(`function ${name}(`) || agentRoles.includes(`async function ${name}(`),
    `D32 agent-roles 持有 ${name}()`);
}
ok(!/\b(agentRoleLibraryData|agentRoleDraft)\b/.test(app)
  && !/function (captureAgentRoleDraft|renderAgentRoleEditors|resetAgentRoleDraft|loadAgentRoles|saveAgentRoles|addAgentRole|populateSubagentPreferenceSelects)\(/.test(app),
  'D33 Agent 角色草稿状态与实现已从 app.js 清空');
ok(agentRoles.includes("api(`/api/agent-roles?cwd=")
  && agentRoles.includes("api('/api/agent-roles'")
  && navigation.includes("if (name === 'agents') loadAgentRoles();"),
  'D34 Agent 角色 GET/POST 与页签懒加载契约齐');
ok(!/\.innerHTML\s*=/.test(usageDashboard) && !/\.innerHTML\s*=/.test(agentRoles),
  'D35 用量与 Agent 角色领域保持零 innerHTML 赋值');
ok(overlayBuilder.includes("'app/public/js/usage-dashboard.js'")
  && overlayBuilder.includes("'app/public/js/agent-roles.js'"),
  'D36 两个第61波领域模块均进入 overlay 载荷');

const wave62Domains = [
  ['skills-memory.js', skillsMemory, ['openSkillPanel', 'openMemoryPanel', 'renderSkillList']],
  ['provider-settings.js', providerSettings, ['refreshStatus', 'renderProviders', 'saveSettings']],
  ['agent-workflows.js', agentWorkflows, ['openWorkflowEditor', 'loadAgentRuns', 'loadAgentWorkflows']],
  ['navigation-controls.js', navigation, ['switchTab', 'openModal', 'renderModelChip']],
  ['session-experience.js', sessionExperience, ['renderSessions', 'openSession', 'renderCurrentSession']],
  ['interaction-prompts.js', interactionPrompts, ['buildModal', 'handlePermissionRequest', 'showAskUserModal']],
  ['tool-runtime.js', toolRuntime, ['runTool', 'updateShellPolling', 'handlePlanEvent']],
  ['workspace-preferences.js', workspacePreferences, ['applyTheme', 'currentWorkspace', 'pickWorkspace']],
];
for (const [file, source, functions] of wave62Domains) {
  ok(app.includes(`from './js/${file}'`) && overlayBuilder.includes(`'app/public/js/${file}'`),
    `D37 ${file} 已组合并进入 overlay`);
  for (const name of functions) {
    ok(source.includes(`function ${name}(`) || source.includes(`async function ${name}(`),
      `D38 ${file} 持有 ${name}()`);
  }
}
ok(app.split(/\r?\n/).length < 3000, 'D39 app.js 组合根低于 3000 行');
ok(!/function (openSkillPanel|openMemoryPanel|refreshStatus|renderProviders|openWorkflowEditor|loadAgentRuns|switchTab|openModal|renderSessions|openSession|renderCurrentSession|buildModal|handlePermissionRequest|runTool|applyTheme|currentWorkspace)\(/.test(app),
  'D40 第62波领域实现已从 app.js 清空');

ok(app.includes("from './js/chat-render-primitives.js'")
  && app.includes('createChatRenderPrimitives({')
  && app.includes("from './js/chat-static-renderer.js'")
  && app.includes('createChatStaticRenderer({')
  && app.includes("from './js/chat-stream-runtime.js'")
  && app.includes('createChatStreamRuntime({'),
  'D41 app.js 组合聊天组件原语、静态渲染与实时流运行时');
for (const name of [
  'messageShell',
  'thinkingPanel',
  'toolCard',
  'renderContextMeter',
]) {
  ok(chatRenderPrimitives.includes(`function ${name}(`),
    `D42 chat-render-primitives 持有 ${name}()`);
}
ok(/const\s*\{\s*\$,\s*api,/.test(chatRenderPrimitives)
  && /createChatRenderPrimitives\(\{\s*\$,\s*api,/.test(app),
  'D42 chat-render-primitives 显式接收并注入 DOM 查询 helper');
for (const name of [
  'renderStaticMessage',
  'renderStaticTurnNarrative',
  'compactNarrativeProcessRuns',
  'turnToolIndexCard',
]) {
  ok(chatStaticRenderer.includes(`function ${name}(`),
    `D42 chat-static-renderer 持有 ${name}()`);
}
for (const name of [
  'sendPrompt',
  'handleStreamLine',
  'createLiveAssistantShell',
  'renderSteeredMessage',
  'handleSubagentEvent',
]) {
  ok(chatStreamRuntime.includes(`function ${name}(`) || chatStreamRuntime.includes(`async function ${name}(`),
    `D43 chat-stream-runtime 持有 ${name}()`);
}
ok(chatStreamRuntime.includes('const activeTurns = new Map()')
  && chatStreamRuntime.includes('const steerPendingList = []')
  && chatStreamRuntime.includes('const steeredSeen = []')
  && !/\bconst (activeTurns|steerPendingList|steeredSeen)\b/.test(app),
  'D44 实时回合与插话状态只由 chat-stream-runtime 持有');
ok(/return\s*\{[\s\S]*\bsyncStreamingUi,/.test(chatStreamRuntime)
  && /createSessionExperienceDomain\(\{[\s\S]*syncStreamingUi:\s*\(\)\s*=>\s*syncStreamingUi\(\)/.test(app),
  'D44 实时流 UI 同步入口已显式导出并注入会话领域');
ok(!/function (messageShell|thinkingPanel|toolCard|renderContextMeter|renderStaticMessage|renderStaticTurnNarrative|sendPrompt|handleStreamLine|createLiveAssistantShell|renderSteeredMessage|handleSubagentEvent)\(/.test(app)
  && app.split(/\r?\n/).length <= 1240,
  // v2.7.2 (自动刷新工具面板): 组合根新增 refreshToolPane/noteToolTabOpened 接线与 loadUsage/loadAgentRuns 注入,
  // 行数护栏放宽到 1210。聊天函数正则(防领域实现回灌)保持不变。
  // 109b905: 组合根新增附件缩略图/图片查看器/倒计时接线(净增约 30 行,达 1229),护栏随 E9 放宽到 1240;
  // 物理瘦身留给 103b/104 模块隔离批次。
  'D45 聊天实现离开 app.js 且组合根低于 1240 行');
ok(overlayBuilder.includes("'app/public/js/chat-render-primitives.js'")
  && overlayBuilder.includes("'app/public/js/chat-static-renderer.js'")
  && overlayBuilder.includes("'app/public/js/chat-stream-runtime.js'"),
  'D46 三层聊天子域均进入 overlay 载荷');
const indexCssRoutes = [...indexHtml.matchAll(/<link rel="stylesheet" href="\/(css\/[^"]+\.css)"/g)].map(match => match[1]);
const manifestCssRoutes = [...styleManifest.matchAll(/@import url\("\/(css\/[^"]+\.css)"\);/g)].map(match => match[1]);
ok(JSON.stringify(indexCssRoutes) === JSON.stringify(CSS_ROUTES),
  'D47 index.html 按既定级联顺序直接加载全部 CSS 层');
ok(JSON.stringify(manifestCssRoutes) === JSON.stringify(CSS_ROUTES),
  'D48 styles.css 兼容清单与直接加载顺序一致');
ok(CSS_ROUTES.every(route => overlayBuilder.includes(`'app/public/${route}'`))
  && CSS_COMPAT_ROUTES.every(route => overlayBuilder.includes(`'app/public/${route}'`))
  && CSS_ROUTES.every(route => fs.existsSync(path.join(PUBLIC, ...route.split('/')))),
  'D49 CSS 层磁盘文件与 overlay 载荷完整');
ok(layeredCss.includes(':root[data-theme="dark"]')
  && layeredCss.includes('/* ============================ messages')
  && layeredCss.includes('.tool-pane')
  && layeredCss.includes(':root[data-ui-mode="simple"]')
  && layeredCss.includes('.usage-agg')
  && layeredCss.includes('.wb-view'),
  'D50 tokens/themes/chat/tooling/modes/usage/workbench 关键层事实齐全');
ok(crypto.createHash('sha256').update(readLayerPayload()).digest('hex') === LEGACY_STYLES_SHA256,
  'D51 分层 CSS 重组后与原单体样式字节等价（仅新增层说明注释）');
// v2.7.2 防回归(对抗轮修复): 组合根 navigation 解构必须包含 refreshToolPane,且已注入 chat 流 ——
// 否则 L338 的箭头函数引用未声明标识符,result 事件触发即 ReferenceError: refreshToolPane is not defined。
ok(app.includes('  refreshToolPane,') && app.includes('refreshToolPane: () => refreshToolPane()'),
  'D53 组合根 navigation 解构含 refreshToolPane 并注入 chat 流(每轮结束自动刷新接线完整)');
const chatOwnedRoutes = CSS_ROUTES.filter(route => /(?:chat|composer)/.test(route));
const chatCompatRoutes = [...chatStyleManifest.matchAll(/@import url\("\/(css\/[^"]+\.css)"\);/g)].map(match => match[1]);
ok(JSON.stringify(chatCompatRoutes) === JSON.stringify(chatOwnedRoutes),
  'D52 chat.css 兼容入口按 shell/primitives/narrative/live/composer 所有权顺序导入');

console.log(`\nFRONTEND DOMAINS STATIC E2E: ${failures ? `FAIL (${failures})` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);

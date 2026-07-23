// dev-harness/dom-contract.e2e.js — 前端 DOM / 函数契约护栏(v1.3-FE1 前端模块化 Phase 1)。
//
// 零依赖、离线、node 直跑。纯静态:只读 index.html 与聚合前端源码(public/app.js +
// public/js/**/*.js,经 read-frontend-src.js),不起服务、不跑浏览器。
//
// 目的:app.js 正渐进拆成原生 ES Modules(Phase 1 抽 util/net/state,Phase 2+ 更多)。
// 拆分是纯搬家,但极易在搬运中(a)丢掉某个 DOM 引用对应的 id、或(b)把某个被 e2e/功能
// 依赖的函数/id/类名搬没了。本护栏把这些契约固化:
//   ① 反向 DOM 引用完整性:聚合源码里所有【字面量】$('x') / getElementById('x') 的 id,
//      必须都存在于 index.html —— 防拆分/改动引入悬空 DOM 引用(打错字、id 漂移)。
//   ② 关键 id 契约清单(手工枚举,含注释):e2e 与核心功能依赖的 id 必须在 index.html。
//   ③ 关键类名契约清单:e2e 与核心渲染依赖的 class 必须在聚合源码中构建。
//   ④ 关键函数契约清单:被 source-grep 类 e2e 断言、或核心链路依赖的函数,聚合源码里必须有定义。
//
// 判定行精确为 `DOM-CONTRACT E2E: ALL PASS`(失败打印明细并非零退出)。
'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontendSrc, frontendSrcFiles, PUB } = require('./read-frontend-src.js');

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = readFrontendSrc();

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ───────────────────────── index.html id 集合 ─────────────────────────
// 抽取 index.html 中全部 id="..." 的名字(含预绘脚本区之外的所有元素)。
const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)) htmlIds.add(m[1]);
ok(htmlIds.size >= 100, `index.html 抽出 id 数量合理(${htmlIds.size} ≥ 100)`);

// ───────────── ① 反向 DOM 引用完整性:源码里的 $('x')/getElementById('x') 都须存在 ─────────────
// 只检查【字面量】参数(单/双引号内是纯 id 字符集);变量参数($(varName))跳过 —— 无法静态解析。
// 例外允许清单:少数 id 由 JS 动态创建后再 $() 取(不在静态 index.html 里),在此登记豁免,附原因。
const DYNAMIC_ID_ALLOW = new Set([
  // 以下 id 由 JS 动态创建(非静态 index.html),再被 $()/getElementById() 取用 —— 合法模式,豁免反向检查:
  'compactIndicator',  // app.js:updateCompactIndicator 里 el('div','compact-indicator') 后 bar.id='compactIndicator'
  'mm-theme-label',    // app.js:openMoreMenu 里 item(...,'mm-theme-label',...) 动态建;syncMoreMenuLabels 用 getElementById 且 if(t) 守护
  'mm-uimode-label',   // app.js:openMoreMenu 里 item(...,'mm-uimode-label',...) 动态建;同上 if(u) 守护
  'wbSteerInput',      // app.js:renderSteerBar 里 el('input',...) 后 input.id='wbSteerInput' 动态建;keepSteer/focus 守护(既有遗漏,第27波回归补登)
]);
const referencedIds = new Set();
// $('id') / $("id")
for (const m of src.matchAll(/\$\(\s*(['"])([a-zA-Z0-9_-]+)\1\s*\)/g)) referencedIds.add(m[2]);
// getElementById('id') / getElementById("id")
for (const m of src.matchAll(/getElementById\(\s*(['"])([a-zA-Z0-9_-]+)\1\s*\)/g)) referencedIds.add(m[2]);

const missingRefs = [...referencedIds].filter(id => !htmlIds.has(id) && !DYNAMIC_ID_ALLOW.has(id));
ok(referencedIds.size >= 100, `聚合源码抽出【字面量】DOM 引用 id 数量合理(${referencedIds.size})`);
ok(missingRefs.length === 0,
  `① 所有字面量 $()/getElementById() 的 id 均存在于 index.html` +
  (missingRefs.length ? ` — 悬空引用: ${missingRefs.join(', ')}` : ''));

// ───────────── ② 关键 id 契约清单(手工枚举,含注释)─────────────
// 这些 id 被 e2e 文件、preview 自检、或核心功能直接依赖;拆分/改动后必须仍在 index.html。
// 分组注释说明其依赖来源,便于将来增删时判断影响面。
const CRITICAL_IDS = [
  // 输入/发送核心链路(sendPrompt / composer)。
  'promptInput', 'sendBtn', 'attachmentTray', 'fileInput', 'composerHint', 'composerMoreBtn',
  // 上下文电量表(ctx-meter 族;Phase 2 拟抽离,契约先固化)+ 立即压缩宿主。
  'contextMeter', 'compactBtn', 'compactBtnHost',
  // 侧栏 / 折叠(ia.e2e、perf.e2e、preview 自检依赖)。
  'sidebar', 'collapseSidebarBtn', 'showSidebarBtn', 'newSessionBtn', 'sessionList', 'sessionSearch',
  // 会话主区 / 消息渲染(perf 窗口化、renderCurrentSession)。
  'messages', 'emptyState', 'sessionTitle', 'sessionMeta', 'jumpLatest',
  // 顶栏 chip / 选择器(工作文件夹、模型、权限、能力徽章)。
  'workspacePicker', 'workspaceInput', 'modelChip', 'permChip', 'permSelect', 'permSelectHost', 'capBadge',
  // 主题 / 界面模式切换(theme.e2e、uimode-style.e2e)。
  'themeToggle', 'uiModeToggle', 'hljs-dark', 'hljs-light',
  // 设置弹层与页签(onboard.e2e:network 页签 + 搜索后端表单;ia.e2e:设置结构)。
  'settingsModal', 'settingsTabs', 'settingsBody', 'settingsStatus', 'saveConfigBtn', 'openSettingsBtn',
  'stab-basic', 'stab-providers', 'stab-claude', 'stab-integrations', 'stab-network', 'stab-doctor', 'stab-advanced',
  'cfgSearchType', 'cfgSearchBaseUrl', 'cfgSearchApiKey', 'cfgSearchApiKeyRow', 'cfgSearchBaseUrlRow',
  'cfgEngineMode', 'cfgUiMode', 'addProviderBtn', 'providersList', 'providerPresetSelect',
  'cfgSubagentMaxConcurrent', 'cfgSubagentMaxPerTurn', 'cfgSubagentPreferredProvider', 'cfgSubagentPreferredModel', 'doctorPanel', 'refreshDoctorBtn',
  // 右侧工具页签(switchTab;ia.e2e 依赖 tab 结构 + 简易模式隐开发者组)。
  'toolPane', 'tab-files', 'tab-changes', 'tab-powershell', 'tab-mcp', 'tab-artifacts',
  'tab-audit', 'tab-agent-runs', 'agentRunsList', 'agentRunsRefreshBtn', 'tab-debug', 'tab-desktop', 'toggleToolsBtn',
  // 成本/用量看板(usage-dashboard.e2e 依赖):用量页签面板 + 刷新 + 预算/Claude单价配置字段。
  'tab-usage', 'usagePanel', 'usageRefreshBtn', 'cfgUsageBudgetMonthly', 'cfgUsageBudgetCurrency', 'cfgClaudePriceIn', 'cfgClaudePriceOut',
  // 命令面板 / 技能库 / 帮助 / 更多菜单。
  'paletteModal', 'paletteInput', 'paletteList', 'skillModal', 'skillSearch', 'skillList', 'helpModal', 'helpBtn', 'moreMenuBtn',
  // 状态/通知(setStatus / toast)。
  'statusLine', 'toastTray',
  // 恢复横幅 / 计划步骤条(resumable / handlePlanEvent)。
  'resumeBanner', 'stepBar', 'stepBarList', 'stepBarSummary', 'stepBarToggle',
  // 调试面板(rawEvents / downloadRawEvents)。
  'rawEvents', 'debugAutoscroll', 'debugClearBtn', 'debugDownloadBtn',
  // token 注入点(net.js:wcwToken 读 meta[name=wcw-token] — 非 id,但 title 注入位在 head)。
];
const missingIds = CRITICAL_IDS.filter(id => !htmlIds.has(id));
ok(missingIds.length === 0,
  `② 关键 id 契约(${CRITICAL_IDS.length} 项)均存在于 index.html` +
  (missingIds.length ? ` — 缺失: ${missingIds.join(', ')}` : ''));

// ───────────── ③ 关键类名契约清单 ─────────────
// 这些 class 被 e2e 断言或核心渲染路径构建;拆分后聚合源码中仍须出现(构建或引用)。
// 断言方式:类名字面量在聚合源码中出现(通常来自 el(tag,'cls',..) 或 classList/className)。
const CRITICAL_CLASSES = [
  'plan-card',          // handlePlanEvent:计划卡(plan-mode 相关)
  'tool-group',         // 工具调用分组渲染
  'compact-indicator',  // 压缩指示
  'wp-pop',             // 工作文件夹选择小弹层(G6)
  'diff-view',          // git.e2e:renderDiffView 逐行 textContent 构建
  'onboard-drop',       // onboard.e2e:首跑引导拖放区
  'empty-logo',         // theme.e2e:空态如意标容器
  'batt-fill',          // ctx-meter:电量填充
  'ctx-text',           // ctx-meter:读数文本
  'ctx-chip',           // ctx-meter:上限预设 chip
  'msg-actions',        // 消息操作条(复制/编辑重发/重试/回溯)
  'modal-backdrop',     // 弹层遮罩(closeModal / Esc 关闭链路)
  'tool-tabs',          // 右侧/设置页签容器
  'toast',              // toast() 通知
  'usage-budget-banner',// 用量看板:预算软告警条(usageBudgetBanner 构建)
  'usage-bar-fill',     // 用量看板:手绘 SVG 水平条填充(usageBarSvg setAttribute class)
  'usage-trend-bar',    // 用量看板:日趋势 SVG 柱(usageTrendSvg 构建)
];
const missingClasses = CRITICAL_CLASSES.filter(c => !src.includes(`'${c}'`) && !src.includes(`"${c}"`) && !new RegExp(`\\b${c}\\b`).test(src));
ok(missingClasses.length === 0,
  `③ 关键类名契约(${CRITICAL_CLASSES.length} 项)均在聚合源码中构建/引用` +
  (missingClasses.length ? ` — 缺失: ${missingClasses.join(', ')}` : ''));

// ───────────── ④ 关键函数契约清单 ─────────────
// 被 source-grep 类 e2e 断言、或核心链路依赖的函数,聚合源码里必须有定义。
// 涵盖:onboard(首跑引导)、ia(弹层/菜单)、theme(如意标)、git(diff 渲染)、perf(窗口化),
// 以及 Phase 1 抽离/保留的关键工具函数与派生函数。断言 `function NAME(` 或 `NAME = ` 定义存在。
const CRITICAL_FUNCS = [
  // onboard.e2e 断言
  'buildFirstRunState', 'isFirstRun', 'engineReadiness',
  // ia.e2e 断言
  'openPermPopover', 'openMoreMenu',
  // theme.e2e 断言
  'buildRuyiLogo',
  // git.e2e 断言
  'renderDiffView',
  // perf.e2e 断言(窗口化)
  'renderCurrentSession', 'windowStartFor', 'buildLoadEarlierButton',
  // Per-session turn state: switching sessions must not inherit another session's busy UI.
  'syncStreamingUi',
  // 工作文件夹选择(onboard.e2e:pickWorkspace/pickWorkspaceNative 两名之一)
  // 单列在下方以「或」逻辑断言。
  // 计划事件(战略清单点名)
  'handlePlanEvent',
  'handleAgentWorkflowEvent',
  'handleSubagentEvent', 'isNativeClaudeBackgroundAck',
  'loadAgentRuns', 'renderAgentRuns', 'agentRunAction',
  'populateSubagentPreferenceSelects', 'createChangeDiffWindow',
  // 成本/用量看板(usage-dashboard.e2e 依赖):懒加载 + 渲染 + 手绘 SVG 条/趋势。
  'loadUsage', 'renderUsage', 'usageBar', 'usageBarSvg', 'usageTrendSvg', 'usageBudgetBanner', 'fmtMoney',
  // Phase 1 抽离的纯工具 / 网络函数(util.js / net.js)—— 拆后聚合源码里仍须有定义。
  'escapeHtml', 'fmtBytes', 'fmtTime', 'fmtTokens', 'autoGrow', 'toast', 'setStatus',
  'wcwToken', 'authHeaders', 'api', 'apiErrText',
  // ctx-meter 族(Phase 1 保留 app.js,Phase 2 拟抽;契约先固化)
  'ctxWindowGuess', 'ctxWindow', 'ctxTokensOf', 'renderContextMeter', 'updateContextMeter', 'openContextPopover',
  // 引导入口
  'boot', 'bindEvents',
];
const missingFuncs = CRITICAL_FUNCS.filter(fn => {
  // 允许 `function NAME(`、`async function NAME(`、`const NAME =`、`NAME = (` 等常见定义形态。
  const re = new RegExp(`(function\\s+${fn}\\s*\\(|(?:const|let|var)\\s+${fn}\\s*=|\\b${fn}\\s*=\\s*(?:async\\s*)?(?:function|\\())`);
  return !re.test(src);
});
ok(missingFuncs.length === 0,
  `④ 关键函数契约(${CRITICAL_FUNCS.length} 项)均在聚合源码中有定义` +
  (missingFuncs.length ? ` — 缺失: ${missingFuncs.join(', ')}` : ''));
// pickWorkspace 或 pickWorkspaceNative(G6 后拆名,任一达标)。
ok(/function\s+pickWorkspace(?:Native)?\s*\(|(?:const|let)\s+pickWorkspace(?:Native)?\s*=/.test(src),
  '④ 定义 pickWorkspace / pickWorkspaceNative(文件夹选择,任一即可)');

// ───────────── ⑤ window 兼容层:被外部(preview/调试)依赖的全局须显式挂回 ─────────────
// Phase 1 把 state 定义搬到 state.js;为兼容此前事实上全局可访问的 window.state(preview
// 控制台/调试依赖),必须在聚合源码中显式 `window.state = state`。此契约防未来拆分再把它丢掉。
ok(/window\.state\s*=\s*state\b/.test(src), '⑤ 聚合源码含 window.state = state(全局兼容层)');

// ───────────── ⑥ 参与聚合的前端源文件清单(报告用)─────────────
// Concurrent sessions keep independent abort/state handles. A single global liveAbort
// regresses session switching back to one foreground-only turn.
ok(/const\s+activeTurns\s*=\s*new\s+Map\s*\(/.test(src),
  'per-session activeTurns registry is defined');
ok(!/\blet\s+liveAbort\b/.test(src),
  'legacy global liveAbort state is absent');
ok(/function\s+mountActiveTurn\s*\(/.test(src) && /eventLines/.test(src),
  'background session progress is buffered and replayed when reopened');
ok(!/state\.currentSession\?\.id\s*===\s*turnSessionId\)\s*for\s*\(const line/.test(src),
  'background stream lines are not discarded while another session is visible');
ok(!/data-ui-mode[^\n]+simple[^\n]+pct\s*<\s*0\.6/.test(src),
  'simple mode keeps context occupancy and compact entry visible after usage exists');
ok(/<select id="cfgSubagentPreferredProvider">/.test(html) && /<select id="cfgSubagentPreferredModel">/.test(html)
  && !/<input id="cfgSubagentPreferred(?:Provider|Model)"/.test(html),
  'subagent preferred endpoint/model are controlled dropdowns, not free-text ids');
ok(/class="settings-tab" id="stab-doctor"/.test(html) && !/id="tab-doctor"/.test(html) && !/id="openDoctorBtn"/.test(html),
  'diagnostics lives inside Settings and is removed from the lower-left/tool-pane duplicates');
ok(/window\.open\('', '_blank'/.test(src) && /change-diff-standalone/.test(src),
  'change diff opens in a dedicated window/tab with an inline fallback');
ok(/isNativeClaudeBackgroundAck\(evt\)/.test(src) && /sa-background/.test(src) && /后台执行中/.test(src),
  'native Claude background launch acknowledgements are not mislabeled as completed');
const bgAckSource = src.match(/function\s+isNativeClaudeBackgroundAck\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
const bgAck = bgAckSource ? Function(`${bgAckSource[0]}; return isNativeClaudeBackgroundAck;`)() : null;
ok(bgAck && bgAck({ native: true, engine: 'claude', result: 'Async agent launched successfully.\\nagentId: abc\\noutput_file: C:\\\\tmp\\\\agent.txt' }) === true
  && bgAck({ native: true, engine: 'claude', result: '审查完成：没有阻断问题。' }) === false,
  'Claude background acknowledgement classifier distinguishes launch receipts from real conclusions');
ok(/steer-queue-item/.test(src) && /steer-queue[\s\S]*color-mix\(in srgb, var\(--accent\)/.test(fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8')),
  'Steer queue uses semantic theme-aware classes instead of hardcoded light colors');

const files = frontendSrcFiles().map(f => path.relative(PUB, f).replace(/\\/g, '/'));
console.log(`INFO 参与聚合的前端源文件(${files.length}): ${files.join(', ')}`);

if (fail === 0) console.log('\nDOM-CONTRACT E2E: ALL PASS');
else { console.log(`\nDOM-CONTRACT E2E: ${fail} FAIL`); process.exitCode = 1; }

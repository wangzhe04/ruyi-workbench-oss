'use strict';
// dev-harness/ui-v3-p3a.static.e2e.js — UI v3 P3a(「工作台」全宽视图·只读画布版)前端契约护栏。
// 零依赖、离线、node 直跑、无端口。纯静态:只读 styles.css / index.html / app.js(聚合)做字面量·正则断言。
// 设计基线 = docs/UI-DESIGN-P3-WORKBENCH.md(§5.2 分层伪码 / §5.3 view-switch 状态机 / §6 验收)
//   + docs/mockups/p3-workbench-r2.html(视觉 r2)+ docs/UI-DESIGN-R2-NOTES.md。真实渲染由指挥官 preview 核验。
// 判定行:`UI V3 P3A STATIC E2E: ALL PASS`。仿 ui-v3-p2.static / agent-workflow-monitor-ui 风格。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = readFrontendSrc(); // app.js + js/**

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const has = (s, ...subs) => subs.every(x => s.includes(x));
// 取一个 CSS 选择器起到其首个 '}' 的规则片段(这些规则体不含嵌套 {})。
const ruleOf = (sel) => { const i = css.indexOf(sel); if (i < 0) return ''; return css.slice(i, css.indexOf('}', i) + 1); };
// 取一个 JS 函数体切片(从 `function NAME(` 到下一个顶层 `\nfunction ` 或长度上限)。
function fnBody(name, cap = 3000) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) return '';
  const next = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, next > i ? Math.min(next, i + cap) : i + cap);
}

// ═══════════ 0. HTML 结构就位(中栏主 Tab + 工作台三区容器)═══════════
ok(/<main class="chat-pane" data-main-view="chat">/.test(html), '0 HTML 中栏 .chat-pane 带 data-main-view="chat"(状态机根)');
ok(has(html, 'wb-mainview-tabs', 'id="mainViewTabChat"', 'id="mainViewTabCanvas"'), '0 HTML 主视图 Tab(对话/工作台)就位');
ok(/data-main-view="chat"[^>]*>对话</.test(html) && /data-main-view="canvas"[^>]*>工作台/.test(html), '0 HTML 两 Tab 带 data-main-view=chat|canvas');
ok(has(html, 'class="wb-mv-dot"'), '0 HTML 工作台 Tab 亮点标 .wb-mv-dot 占位');
ok(has(html, 'id="workbenchView"', 'class="wb-view"'), '0 HTML 工作台视图容器 #workbenchView.wb-view');
ok(has(html, 'id="wbRunbar"', 'id="wbCanvasWrap"', 'id="wbUsage"'), '0 HTML 三区容器 run 栏 / 画布 / 用量条就位');

// ═══════════ A. 主 Tab 状态机(§5.3)═══════════
ok(/function switchMainView\(/.test(src), 'A JS switchMainView 状态机存在');
const smv = fnBody('switchMainView');
ok(has(smv, "setAttribute('data-main-view'"), 'A switchMainView 切 [data-main-view](一处切换全局响应)');
ok(has(smv, "localStorage.setItem('wcw.mainView'"), 'A switchMainView 记忆到 localStorage(wcw.mainView)');
ok(has(smv, 'renderWorkbench(', 'syncAgentRunsPolling('), 'A 进画布即时重绘 + 复用轮询骨架');
ok(/function restoreMainView\(/.test(src) && has(fnBody('restoreMainView'), "localStorage.getItem('wcw.mainView')"), 'A restoreMainView 恢复记忆(boot 接入)');
ok(/restoreMainView\(\)/.test(fnBody('boot', 1200)), 'A boot() 调用 restoreMainView');
ok(/function wbUpdateActivityDot\(/.test(src) && has(fnBody('wbUpdateActivityDot'), "'has-activity'", 'AGENT_RUN_ACTIVE.has'), 'A 有活动 run 时主 Tab 亮点标(.has-activity ← AGENT_RUN_ACTIVE)');
ok(/\.wb-mainview-tabs \.wb-mv-tab'\)\.forEach\(b => \{ b\.onclick = \(\) => switchMainView\(b\.dataset\.mainView\)/.test(src), 'A bindEvents wire 主 Tab → switchMainView');
// CSS:view-switch 隐藏/显示(零 DOM 重建)。
ok(/\.chat-pane\[data-main-view="canvas"\] > #messages/.test(css) && /\.chat-pane\[data-main-view="canvas"\] > \.composer/.test(css), 'A CSS canvas 态隐藏对话消息流 + composer');
ok(/\.chat-pane\[data-main-view="chat"\] > \.wb-view\s*\{\s*display:\s*none/.test(css), 'A CSS chat 态隐藏工作台视图');
ok(/\.wb-view\s*\{[^}]*display:\s*flex/.test(css), 'A CSS .wb-view flex 列布局占满中栏');
ok(/\.wb-mv-tab\.has-activity \.wb-mv-dot\s*\{[^}]*display:\s*inline-block/.test(css), 'A CSS 亮点标仅在 .has-activity 时可见');

// ═══════════ B. 分层布局算法(§5.2 纯函数:记忆化 DFS + 环保护 + id 位置记忆)═══════════
ok(/function layoutWorkbenchDAG\(nodes\)/.test(src), 'B layoutDAG 纯函数 layoutWorkbenchDAG(nodes) 存在');
const lay = fnBody('layoutWorkbenchDAG');
ok(/const WB_NODE_W = 220, WB_NODE_H = 88, WB_H_GAP = 48, WB_V_GAP = 64, WB_PAD = 32/.test(src), 'B 布局常量对齐 §5.2 伪码(220×88 / H48 / V64 / PAD32)');
ok(has(lay, 'if (layer.has(id)) return layer.get(id)'), 'B 记忆化:已算层号直接返回(O(V+E))');
ok(has(lay, 'if (visiting.has(id)) return 0'), 'B 环保护:成环节点回退层 0(防御编辑器已禁的环)');
ok(has(lay, 'byId.has(d) && d !== id'), 'B 只认存在的依赖(忽略悬空/自指)');
ok(has(lay, '1 + Math.max(...deps.map(d => computeLayer(d, visiting)))'), 'B 层号 = 1 + max(依赖层号),无依赖 = 0');
ok(has(lay, 'centerX - rowW / 2'), 'B 层内均布 + 居中对称(centerX - rowW/2)');
ok(has(lay, 'cx: x + WB_NODE_W / 2', 'layer: L'), 'B 输出 {x,y,cx,layer}(cx 供连线端点)');
// id 位置记忆(拓扑签名不变 → 复用坐标,防轮询重排抖动)。
ok(/function wbTopoSig\(/.test(src) && /function wbLayoutFor\(/.test(src), 'B 拓扑签名 wbTopoSig + 布局缓存 wbLayoutFor');
ok(has(fnBody('wbLayoutFor'), 'cached.sig === sig', 'posCache'), 'B id 位置记忆:拓扑未变复用 posCache(防抖动)');
// preview eval 单测可及(同 window.state 兼容层)。
ok(/window\.layoutWorkbenchDAG = layoutWorkbenchDAG/.test(src), 'B 布局函数挂 window(供 preview eval 单测直接调)');

// ═══════════ C. SVG 三次贝塞尔连线 + 端口 + r2 方向渐变(§2.3 / R2)═══════════
ok(/function wbBuildEdges\(/.test(src), 'C SVG 连线层构建器 wbBuildEdges 存在');
const edges = fnBody('wbBuildEdges');
ok(has(edges, 'createElementNS') || has(fnBody('wbSvg'), 'createElementNS'), 'C 走 createElementNS 造 SVG(命名空间正确)');
ok(has(src, 'const fx = from.cx, fy = from.y + WB_NODE_H, tx = to.cx, ty = to.y'), 'C 连线源底缘中点 → 靶顶缘中点');
ok(has(src, 'C${fx.toFixed(1)},${(fy + dy).toFixed(1)} ${tx.toFixed(1)},${(ty - dy).toFixed(1)}'), 'C 三次贝塞尔路径 d(C 控制点落中垂线)');
ok(has(edges, "gradientUnits: 'userSpaceOnUse'"), 'C r2 userSpaceOnUse 方向渐变(色沿依赖方向衰减)');
ok(has(edges, "'wb-port src'", "'wb-port dst'"), 'C 端口:源实点 + 靶空心环');
ok(has(edges, 'wbEdgeKind(nodeDisplayStatus(src))'), 'C 边着色按源节点显示状态(复用 nodeDisplayStatus)');
ok(/function wbEdgeKind\(/.test(src) && has(fnBody('wbEdgeKind'), "'run'", "'reject'", "'wait'", "'done'"), 'C 边分类 run/reject/wait/done/fail');
ok(/\.wb-edge\.wb-e-run\s*\{[^}]*animation:\s*wb-flow/.test(css), 'C 源运行中边:流动虚线(wb-flow 动画)');
ok(/\.wb-port\.dst\s*\{[^}]*fill:\s*var\(--canvas-bg\)/.test(css), 'C 靶端口空心环(fill:--canvas-bg)');

// ═══════════ D. 节点卡 220×88(渗透语言 + 复用同源纯函数)═══════════
ok(/function wbBuildNode\(/.test(src), 'D 节点卡构建器 wbBuildNode 存在');
const node = fnBody('wbBuildNode');
ok(has(node, 'nodeDisplayStatus(node)', 'agentStatusIcon(disp)', 'agentEngineBadge(node.engine)'), 'D 复用同源纯函数(状态派生/徽标/引擎)');
ok(has(node, 'node.model', 'wb-node-act', 'wb-act-dot', 'wb-verdict'), 'D 卡区:模型名 + 活动行(运行 shimmer)+ 门 verdict/迭代条');
ok(/\.wb-node\s*\{[^}]*width:\s*220px;[^}]*height:\s*88px/.test(css), 'D CSS 节点卡固定 220×88');
ok(/\.wb-node\s*\{[^}]*linear-gradient\(115deg, color-mix\(in srgb, var\(--wb-sc[^}]*13%/.test(css), 'D 渗透:状态色 13% 渐变洗(与 P2 监控卡同族)');
ok(/\.wb-node\.wb-st-running\s*\{[^}]*box-shadow:\s*var\(--glow-accent\)[^}]*animation:\s*wb-breathe/.test(css), 'D 运行态 --glow-accent 光渗 + 脉动(wb-breathe)');
ok(/\.wb-node\.selected\s*\{[^}]*box-shadow:\s*0 0 0 1\.5px var\(--accent\)/.test(css), 'D 选中态 accent 描边 + glow');
// 状态类隔离:用 wb-st-* 前缀,不复用裸 .st-*(避免 .st-running 的 pulse 误染整卡)。
ok(!/\bel\('div', `wb-node st-/.test(src) && has(node, 'wb-node wb-st-'), 'D 状态类隔离前缀 wb-st-*(不复用裸 .st-*)');
// 节点点击 → 跳右栏监控卡高亮(P3a 最简版)。
ok(/function wbFocusRunNode\(/.test(src), 'D 节点点击处置器 wbFocusRunNode 存在');
const focus = fnBody('wbFocusRunNode');
// P3b 起:点节点填右板段1(renderWorkbenchSide),取代 P3a 的 switchTab 跳右栏(见 ui-v3-p3b.static.e2e.js 断言）。
ok(has(focus, 'wbState.selectedNodeId = nodeId', 'renderWorkbenchSide(', "'selected'"), 'D 点节点 → 标选中 + 填右板段1(P3b 取代 switchTab)');
ok(/\.agent-node\.wb-flash\s*\{[^}]*animation:\s*wb-flash/.test(css) && /@keyframes wb-flash/.test(css), 'D CSS .wb-flash 高亮动画(保留)');

// ═══════════ E. Run 选择器 chips(§1 ①)═══════════
ok(/function renderWorkbenchRunbar\(/.test(src), 'E run chips 渲染器 renderWorkbenchRunbar 存在');
const runbar = fnBody('renderWorkbenchRunbar');
ok(has(runbar, 'AGENT_RUN_ACTIVE.has(run.status)', 'wb-chip wb-st-'), 'E chip 状态映射(活动优先 → wb-st-running)');
ok(has(runbar, "p.status === 'proposed'", "'wb-rc-pool num'"), 'E 待批准池徽标(taskPool proposed 计数)');
ok(has(runbar, "run.status === 'succeeded'", "'wb-rc-gold'"), 'E 已完成 chip 鎏金 ✦(授权清单唯一处之一)');
ok(has(runbar, 'wbState.selectedRunId = run.id', 'renderWorkbench('), 'E 点 chip 切换选中 run 重绘画布');
ok(/\.wb-chip\.wb-st-running \.wb-rc-dot\s*\{[^}]*animation:\s*wb-blink/.test(css), 'E live chip 状态点脉动(wb-blink)');

// ═══════════ F. 底部用量迷你条(§1 ④,r2 仪表化)═══════════
ok(/function renderWorkbenchUsage\(/.test(src) && /function wbRunMetrics\(/.test(src), 'F 用量条渲染器 + 指标聚合 wbRunMetrics');
const usage = fnBody('renderWorkbenchUsage');
ok(has(usage, 'runElapsedMs') || has(fnBody('wbRunMetrics'), 'runElapsedMs'), 'F 时长复用 runElapsedMs');
ok(has(usage, 'fmtTokens(', 'fmtDuration('), 'F 大数字复用 fmtTokens/fmtDuration');
ok(has(usage, "'wb-um'", "'num'"), 'F 大数字仪表列(.wb-um + .num tabular-nums)');
ok(has(usage, "switchTab('usage')"), 'F 点击跳右栏用量看板');
ok(/\.wb-um b\s*\{[^}]*font-size:\s*var\(--fs-xl\)/.test(css), 'F CSS 大数字 --fs-xl(仪表风)');

// ═══════════ G. 空态(§3.3)═══════════
ok(/function renderWorkbenchEmpty\(/.test(src), 'G 空态渲染器 renderWorkbenchEmpty 存在');
const empty = fnBody('renderWorkbenchEmpty');
ok(has(empty, '本会话还没有 Agent 工作流', '去对话交办任务', '从模板运行'), 'G 空态引导卡(标题 + 两个引导按钮)');
ok(has(empty, "'wb-empty-cloud'") && /\.wb-empty-cloud\s*\{[^}]*var\(--ruyi-cloud\)/.test(css), 'G 云纹水印(--ruyi-cloud mask)');
ok(/function renderWorkbench\(runs, force\)/.test(src) && has(fnBody('renderWorkbench'), 'renderWorkbenchEmpty()'), 'G 无 run 分派到空态(renderWorkbench;对抗轮P2:新增签名跳过的 force 参数)');

// ═══════════ H. 轮询复用 + XSS 纪律 + 零硬编码色/零裸 px 字号 ═══════════
// 复用现有 agent-runs 2s 轮询,不新增请求(loadAgentRuns 内联喂画布)。
ok(/setInterval\(loadAgentRuns, 2000\)/.test(src), 'H 复用现有 2s 轮询(setInterval loadAgentRuns 2000,协议未改)');
// 第29波(§29a):喂画布点从 loadAgentRuns 内联挪进 deliverAgentRuns(全量/增量两条路共用的投递尾段)——
// 契约语义不变:画布仍复用同一份轮询数据、零新增请求;loadAgentRuns 两条路径都必须经 deliverAgentRuns 投递。
ok(/wbOnRuns\(runs\)/.test(fnBody('deliverAgentRuns', 1200)), 'H 投递尾段 deliverAgentRuns 喂画布 wbOnRuns(不新增请求)');
ok((fnBody('loadAgentRuns', 8000).match(/await deliverAgentRuns\(sid, runs\)/g) || []).length >= 2, 'H loadAgentRuns 全量/增量两路都经 deliverAgentRuns 投递');
ok(/function agentRunsPollWanted\(/.test(src) && has(fnBody('agentRunsPollWanted'), "wbState.view === 'canvas'"), 'H 轮询期望态并入画布视图(监控页签 ∪ 画布)');
ok(has(fnBody('wbOnRuns'), 'wbState.lastRuns', "wbState.view === 'canvas'", 'renderWorkbench('), 'H wbOnRuns 缓存 runs + 画布态重绘 + 刷新亮点标');
// XSS:各构建器不用 innerHTML(el()/textContent + createElementNS)。
for (const [fn, body] of [['wbBuildNode', node], ['wbBuildEdges', edges], ['renderWorkbenchRunbar', runbar], ['renderWorkbenchUsage', usage], ['renderWorkbenchEmpty', empty]])
  ok(body && !body.includes('.innerHTML'), 'H ' + fn + ' 无 innerHTML(el()/textContent,XSS 安全)');
// 纪律:P3a 追加的 .wb-* 规则零硬编码色 + 零裸 px 字号;全局裸 px 字号仍仅 2 处基线锚点。
const wbCss = css.slice(css.indexOf("UI v3 P3a"));
ok(wbCss.length > 500, 'H 定位到 P3a CSS 追加块');
ok(!/#[0-9a-fA-F]{3,6}\b/.test(wbCss), 'H P3a CSS 块零硬编码十六进制色(全 token/color-mix)');
ok(!/font-size:\s*[0-9.]+px/.test(wbCss), 'H P3a CSS 块零裸 px 字号(全 var(--fs-*))');
ok((css.match(/font-size:\s*[0-9.]+px/g) || []).length === 2, 'H styles.css 全局裸 px 字号仍仅 2 处基线锚点');

if (fail === 0) console.log('\nUI V3 P3A STATIC E2E: ALL PASS');
else { console.log(`\nUI V3 P3A STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }

'use strict';
// dev-harness/ui-v3-p3b.static.e2e.js — UI v3 P3b(「工作台」交互完整版)前端契约护栏。
// 零依赖、离线、node 直跑、无端口。纯静态:只读聚合前端源码(app.js + js/**)+ styles.css + index.html 做
// 字面量/正则断言。设计基线 = docs/UI-DESIGN-P3-WORKBENCH.md(§5.4 画布交互 / §6 验收 #5/#6/#7/#8/#10)
//   + docs/mockups/p3-workbench-r2.html(右三段板视觉)。真实渲染由指挥官 preview 核验。
// P3b 补齐:右侧三段折叠板(选中节点详情 / 任务池审批 / 邮箱消息流)+ 节点插话(资格判定,与后端 409 一致)
//   + 缩放(0.75/1/1.25 挡)/适应视图/泳道层标 + 响应式抽屉(<1180)。判定行:`UI V3 P3B STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = readFrontendSrc(); // app.js + js/**
const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'i18n', 'locales', 'zh-CN.json'), 'utf8'));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const has = (s, ...subs) => subs.every(x => s.includes(x));
// 取一个 JS 函数体切片(从 `function NAME(` 到下一个顶层 `\nfunction ` 或长度上限)。
function fnBody(name, cap = 4000) {
  const i = src.indexOf(`function ${name}(`); if (i < 0) return '';
  const next = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, next > i ? Math.min(next, i + cap) : i + cap);
}

// ═══════════ 0. HTML 结构:主区网格(画布 | 右板)+ 抽屉 backdrop ═══════════
ok(has(html, 'class="wb-main"'), '0 HTML .wb-main 主区网格容器(画布 | 右板)就位');
ok(has(html, 'id="wbSide"', 'class="wb-side"'), '0 HTML 右侧上下文板 #wbSide.wb-side 就位');
ok(has(html, 'id="wbSideBackdrop"', 'wb-side-backdrop'), '0 HTML 窄屏抽屉 backdrop #wbSideBackdrop 就位');
ok(/#wbCanvasWrap[\s\S]{0,120}id="wbSide"/.test(html) || /class="wb-main"[\s\S]{0,200}id="wbSide"/.test(html), '0 HTML 画布与右板同处 .wb-main 内');

// ═══════════ A. 三段折叠板(§1③;记忆折叠态,轮询重绘不丢)═══════════
ok(/function renderWorkbenchSide\(/.test(src), 'A 右板渲染器 renderWorkbenchSide 存在');
const side = fnBody('renderWorkbenchSide');
ok(has(side, "wbSection('detail'", "wbSection('pool'", "wbSection('mail'"), 'A 渲染三段:选中详情 / 任务池审批 / 邮箱消息流');
ok(has(side, "id === 'wbSteerInput'", 'inp.focus()'), 'A 插话输入焦点/文本跨 2s 轮询重绘保留(防打字被冲掉)');
ok(/function wbSection\(/.test(src) && has(fnBody('wbSection'), 'wbState.panelOpen[key]', "'open'"), 'A 段外壳 wbSection 折叠态记忆 wbState.panelOpen');
ok(has(src, 'panelOpen: { detail: true, pool: true, mail: true }'), 'A wbState.panelOpen 三段初始展开');
ok(/renderWorkbenchSide\(/.test(fnBody('renderWorkbench')), 'A renderWorkbench 分派到 renderWorkbenchSide');
// CSS 手风琴。
ok(/\.wb-sec\s*\{/.test(css) && /\.wb-sec\.open \.wb-sec-body\s*\{[^}]*display:\s*block/.test(css), 'A CSS .wb-sec.open 展开段体');
ok(/\.wb-sec\.open \.wb-sec-caret\s*\{[^}]*transform:\s*rotate\(90deg\)/.test(css), 'A CSS 展开态 caret 旋转 90°');
ok(/\.wb-sec-count\.warn\s*\{[^}]*var\(--warn-bg\)/.test(css), 'A CSS 待批准计数徽标 warn 态');

// ═══════════ B. 段1 选中节点详情(§6#5;复用同源纯函数 + 模型名 + 门环 + 时间线 + 重试)═══════════
ok(/function wbNodeDetailBody\(/.test(src), 'B 节点详情渲染器 wbNodeDetailBody 存在');
const det = fnBody('wbNodeDetailBody', 6000);
ok(has(det, 'nodeDisplayStatus(node)', 'agentRunStatusLabel(disp)', 'agentEngineBadge(node.engine)'), 'B 复用同源纯函数(状态派生/标签/引擎)');
ok(has(det, 'node.model', 'wb-det-model'), 'B 显示模型名(node.model,§6#5)');
ok(has(det, 'wb-det-timeline', 'progressLog'), 'B 进度活动全量时间线(progressLog)');
ok(has(det, 'node.gateVerdict', 'wb-det-ring', "setProperty('--deg'"), 'B 门 verdict + 置信度环(conic --deg,数值算得非硬编码)');
ok(has(det, "agentRunAction(run.id, 'retry_node'", 'cascade: false', 'cascade: true'), 'B 重试入口:仅此节点 / 及下游(复用 retry_node action)');
ok(has(det, '!run.live'), 'B 重试入口仅非 live run(与右栏 agent-runs 一致)');
ok(has(det, 'wb-det-error', 'node.error'), 'B 结果/错误全文展示');
ok(/\.wb-det-ring\s*\{[^}]*conic-gradient/.test(css), 'B CSS 置信度环 conic-gradient(角度 --deg + 环色 --ring-col)');
ok(/\.wb-tl-item\.live::before\s*\{[^}]*var\(--accent\)/.test(css), 'B CSS 时间线末条 live 点(accent)');

// ═══════════ C. 节点插话 + 资格判定(§6#6;与后端 steer_node 409 文案逐字一致)═══════════
ok(/function wbSteerEligibility\(/.test(src), 'C 插话资格判定 wbSteerEligibility 存在(镜像后端 nodeDeliveryEligibility)');
const elig = fnBody('wbSteerEligibility');
ok(has(elig, "!run.live") && has(elig, "'not_live'"), 'C 非 live run 不出插话框');
// 47a:Claude 引擎节点不再整段禁用 -- 改延迟插话(deferred,节点结束后注入下游)。锁 eligibility 对 claude 返回 deferred。
ok(has(elig, "=== 'claude'") && has(elig, "reason: 'deferred'"), 'C claude 引擎节点走延迟插话(deferred,非禁用)');
ok(has(elig, "['vote', 'dedupe'].includes(node.gate.mode)", "t('workflow.steerBox.noDeterministic')"), 'C 确定性门禁用 + 409 文案一致');
ok(has(elig, "['running', 'queued', 'waiting_resource'].includes(node.status)", "t('workflow.steerBox.noTerminal')"), 'C 终态禁用 + 409 文案一致');
ok(/function wbSteerBox\(/.test(src), 'C 插话框 wbSteerBox 存在');
const steerBox = fnBody('wbSteerBox');
ok(has(steerBox, 'steerAgentNode(run.id, node.id, node.status, t2, node.engine)'), 'C 内联提交复用 steer_node action(传 presetText + engine 不弹 prompt)');
ok(has(steerBox, 'input.disabled = true', 'send.disabled = true', 'wb-steer-why'), 'C 不符合资格显禁用输入 + 原因');
// steerAgentNode 已支持 presetText + engine 双路径(47a:Claude 节点延迟语义靠 engine 区分;prompt 兜底不破坏右栏 3 参调用)。
ok(/async function steerAgentNode\(runId, nodeId, nodeStatus, presetText, engine\)/.test(src), 'C steerAgentNode 增 presetText+engine 形参(内联/prompt 双路径)');
ok(has(fnBody('steerAgentNode'), 'presetText != null ? presetText'), 'C presetText 提供走内联,不提供保留 prompt()');
ok(/\.wb-steer-input:disabled\s*\{/.test(css), 'C CSS 禁用态插话输入样式');

// ═══════════ D. 段2 任务池审批(§6#7)═══════════
ok(/function wbPoolBody\(/.test(src), 'D 任务池渲染器 wbPoolBody 存在');
const pool = fnBody('wbPoolBody');
ok(has(pool, "item.status === 'proposed'", 'wb-pool-card'), 'D proposed 项渲染审批卡');
ok(has(pool, "t('workflow.pool.who')", "t('workflow.pool.what')", "t('workflow.pool.cost'"), 'D 三行人话卡(谁提议/做什么/预计消耗)');
ok(has(pool, 'poolDecide(run.id, item.id, true)', 'poolDecide(run.id, item.id, false)'), 'D 同意添加/不用了 → poolDecide(复用 pool_approve/reject)');
ok(has(pool, "run.status === 'waiting_pool'", 'POOL_GRACE_HINT_MS', 'wb-pool-grace'), 'D waiting_pool 宽限窗倒计时条');
ok(/\.wb-pool-card::before\s*\{[^}]*var\(--warn\)/.test(css), 'D CSS 审批卡左琥珀发丝缘');

// ═══════════ E. 段3 邮箱消息流(§6#8)═══════════
ok(/function wbMailBody\(/.test(src), 'E 邮箱渲染器 wbMailBody 存在');
const mail = fnBody('wbMailBody');
ok(has(mail, 'm.sender', 'm.target', 'wb-mail-arw'), 'E 每条 sender → target 路由');
ok(has(mail, 'm.text', 'wb-mail-text'), 'E 消息摘要文本');
ok(has(mail, 'm.dropped', "t('workflow.mail.dropped')", 'm.deliveredAt'), 'E dropped 项标「未送达」+ 已送达时间');
ok(has(mail, 'wb-mail-item') && !mail.includes('.innerHTML'), 'E 只读展示(el()/textContent,无 innerHTML)');
ok(/\.wb-mail-item\.dropped\s*\{[^}]*opacity/.test(css), 'E CSS 未送达项灰化');

// ═══════════ F. 画布缩放(§5.4:0.75/1/1.25 挡,整容器 transform:scale)═══════════
ok(/const WB_ZOOM_GEARS = \[0\.75, 1, 1\.25\]/.test(src), 'F 缩放挡位 WB_ZOOM_GEARS = [0.75,1,1.25]');
ok(/function wbSetZoom\(/.test(src) && /function wbBuildZoomCapsule\(/.test(src), 'F 缩放设置 wbSetZoom + 胶囊 wbBuildZoomCapsule');
const cap = fnBody('wbBuildZoomCapsule');
ok(has(cap, "'wb-cvtools'", 'wb-cv-btn', 'wbSetZoom(', 'wbFitView()'), 'F 胶囊:− / 读数 / ＋ / 适应视图');
ok(has(cap, "Math.round(z * 100)"), 'F 缩放读数百分比');
ok(has(fnBody('renderWorkbenchCanvas', 3000), "el('div', 'wb-canvas-inner')", 'inner.style.transform = `scale('), 'F 节点+SVG 同 .wb-canvas-inner 容器整体 scale(坐标系不变)');
ok(/\.wb-canvas-inner\s*\{[^}]*transform-origin:\s*0 0/.test(css), 'F CSS .wb-canvas-inner transform-origin 左上');
ok(/\.wb-cvtools\s*\{[^}]*position:\s*absolute/.test(css) && /\.wb-cvtools\s*\{[^}]*bottom:\s*16px/.test(css), 'F CSS 缩放胶囊右下定位');

// ═══════════ G. 适应视图(§5.4:包围盒 → 挑挡 + scrollTo 居中)═══════════
ok(/function wbFitView\(/.test(src), 'G 适应视图 wbFitView 存在');
const fit = fnBody('wbFitView');
ok(has(fit, 'wrap.clientWidth', 'maxRight', 'p.x + WB_NODE_W'), 'G 按画布包围盒 + 视口宽算适应挡');
ok(has(fit, 'if (g <= ratio) gear = g'), 'G 挑能容下宽度的最大挡(都容不下回落最小挡)');
ok(has(fit, 'wrap.scrollLeft = Math.max(0, (W * gear - wrap.clientWidth) / 2)'), 'G 重绘后水平居中滚动(纵向 DAG 顶对齐)');

// ═══════════ H. 泳道层标注(§5.4;落行上缘空隙,避开节点)═══════════
ok(/function wbBuildLayerTags\(/.test(src), 'H 泳道层标 wbBuildLayerTags 存在');
const lanes = fnBody('wbBuildLayerTags');
ok(has(lanes, 'wb-layer-tag', "t('workflow.canvas.layerTag', { L: L })") &&
  zh['workflow.canvas.layerTag'] === '第 {{L}} 层', 'H 每层「第 N 层」淡标签(代码与中文 locale 双向锁)');
ok(has(lanes, 'y - 22') || has(lanes, 'Math.max(2, y - 22)'), 'H 标签落层行上缘空隙带(避开节点重叠)');
ok(/\.wb-layer-tag\s*\{[^}]*var\(--panel-veil\)/.test(css), 'H CSS 层标 veil 底 + 发丝缘');

// ═══════════ I. 响应式右板抽屉(§6#10)═══════════
ok(/function wbOpenSide\(/.test(src) && has(fnBody('wbOpenSide'), "'wb-side-open'"), 'I 抽屉开合 wbOpenSide 切 .wb-side-open');
ok(/function wbIsNarrow\(/.test(src) && has(fnBody('wbIsNarrow'), 'max-width: 1180px'), 'I 窄屏判定 wbIsNarrow(matchMedia 1180)');
ok(has(fnBody('wbFocusRunNode'), 'if (wbIsNarrow()) wbOpenSide(true)'), 'I 窄屏点节点自动滑出抽屉');
ok(/wbBd\.onclick = \(\) => wbOpenSide\(false\)/.test(src) || has(src, 'wbSideBackdrop', 'wbOpenSide(false)'), 'I backdrop 点击关抽屉(bindEvents wire)');
ok(/@media \(max-width: 1180px\)[\s\S]*?\.wb-side\s*\{[\s\S]*?transform:\s*translateX\(100%\)/.test(css), 'I CSS <1180 右板变右滑抽屉(translateX 100%)');
ok(/\.wb-side-open \.wb-side\s*\{[^}]*transform:\s*none/.test(css), 'I CSS .wb-side-open 抽屉滑入');
ok(/@media \(max-width: 1180px\)[\s\S]*?\.wb-side-open \.wb-side-backdrop\s*\{[^}]*display:\s*block/.test(css), 'I CSS 抽屉打开时 backdrop 可见');
ok(/@media \(max-width: 760px\)[\s\S]*?\.wb-side\s*\{[^}]*width:\s*min\(100%/.test(css), 'I CSS ≤760 右板近全宽浮层');

// ═══════════ J. XSS 纪律 + 零硬编码色 + 零裸 px 字号(P3b 追加)═══════════
for (const [fn, body] of [['wbNodeDetailBody', det], ['wbPoolBody', pool], ['wbMailBody', mail], ['wbSection', fnBody('wbSection')], ['wbSteerBox', steerBox]])
  ok(body && !body.includes('.innerHTML'), 'J ' + fn + ' 无 innerHTML(el()/textContent,XSS 安全)');
// P3b CSS 块(标记「UI v3 P3b」到下一大块)零硬编码 hex 色 + 零裸 px 字号;全文件裸 px 字号仍仅 2 处基线锚点。
const p3bStart = css.indexOf('UI v3 P3b');
ok(p3bStart > 0, 'J 定位到 P3b CSS 追加块');
const p3bCss = css.slice(p3bStart, css.indexOf('.agent-node.wb-flash'));
ok(!/#[0-9a-fA-F]{3,6}\b/.test(p3bCss), 'J P3b CSS 块零硬编码十六进制色(全 token/color-mix)');
ok(!/font-size:\s*[0-9.]+px/.test(css.slice(p3bStart)), 'J P3b 起 CSS 零裸 px 字号(全 var(--fs-*))');
ok((css.match(/font-size:\s*[0-9.]+px/g) || []).length === 2, 'J styles.css 全局裸 px 字号仍仅 2 处基线锚点');
// 悬停依赖链高亮(§2.3)复用 P3a 的 .wb-edge.lit/.dim。
ok(/function wbHighlightChain\(/.test(src) && has(fnBody('wbHighlightChain'), "'lit'", "'dim'", 'data-from'), 'J 悬停依赖链高亮 wbHighlightChain(复用 lit/dim)');

if (fail === 0) console.log('\nUI V3 P3B STATIC E2E: ALL PASS');
else { console.log(`\nUI V3 P3B STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }

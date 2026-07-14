'use strict';
// dev-harness/ui-v3-p2.static.e2e.js — UI v3 P2(右栏三档宽 + 监控卡降噪 + 技能库/记忆卡片化 + 用量瓦片自适应)
// 前端契约护栏。零依赖、离线、node 直跑、无端口。纯静态:只读 styles.css / index.html / app.js(聚合)做字面量·
// 正则断言。视觉基线 = docs/mockups/p2-refinements-r2.html + docs/UI-DESIGN-R2-NOTES.md。真实渲染由指挥官用
// preview 核验。判定行:`UI V3 P2 STATIC E2E: ALL PASS`。仿 ui-v3-p1.static / agent-workflow-monitor-ui 风格。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = readFrontendSrc(); // app.js + js/**

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
// 取一个选择器起到其首个 '}' 的规则片段(本仓库这些规则体不含嵌套 {},简单扫描足够)。
const ruleOf = (sel) => { const i = css.indexOf(sel); if (i < 0) return ''; return css.slice(i, css.indexOf('}', i) + 1); };
// 解析一个 [data-theme] 块内的设计令牌键集(排除 --eng-*),供对称性断言。仿 p1 §5。
function tokenKeys(selector) {
  const idx = css.indexOf(selector); if (idx < 0) return null;
  const open = css.indexOf('{', idx); const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const keys = new Set(); const re = /(--[a-z0-9-]+)\s*:/gi; let m;
  while ((m = re.exec(body))) { const k = m[1].toLowerCase(); if (!k.startsWith('--eng-')) keys.add(k); }
  return keys;
}

// ═══════════ 0. r2 新 token ×4(两主题分别定值 + 键集对称)—— R2-NOTES §2 ═══════════
const NEW4 = ['--canvas-bg', '--panel-veil', '--glow-accent', '--gold-line'];
const dk = tokenKeys(':root[data-theme="dark"]');
const lk = tokenKeys(':root[data-theme="light"]');
ok(dk && lk, '0 解析到 dark/light 主题令牌块');
for (const t of NEW4) ok(dk.has(t) && lk.has(t), '0 新 token ' + t + ' 两主题均定义');
if (dk && lk) {
  const onlyDark = [...dk].filter(k => !lk.has(k));
  const onlyLight = [...lk].filter(k => !dk.has(k));
  ok(onlyDark.length === 0 && onlyLight.length === 0,
    '0 两主题令牌键集对称(dark 独有 ' + JSON.stringify(onlyDark) + ' / light 独有 ' + JSON.stringify(onlyLight) + ')');
}
// 墨夜/月白按 R2-NOTES 分别定值(canvas-bg 深浅台阶)。
ok(/--canvas-bg:\s*#0c1119/.test(css) && /--canvas-bg:\s*#edf1f8/.test(css), '0 --canvas-bg 墨夜 #0c1119 / 月白 #edf1f8');

// ═══════════ A. 右栏三档宽(§2.7)═══════════
// CSS:第三轨走 --right-w,默认 340;右缘拖拽手柄;全屏覆盖档。
ok(/grid-template-columns:\s*288px minmax\(420px, 1fr\) var\(--right-w\)/.test(css), 'A CSS 主栅格第三轨 = var(--right-w)');
ok(/\.app-shell\s*\{[^}]*--right-w:\s*340px/.test(css), 'A CSS --right-w 默认 340px');
const handleRule = ruleOf('.right-resize-handle {');
ok(/right:\s*var\(--right-w\)/.test(handleRule) && /cursor:\s*col-resize/.test(handleRule), 'A CSS 拖拽手柄贴 tool-pane 左缘(right:var(--right-w))+ col-resize');
ok(/\.app-shell\.tools-fullscreen \.tool-pane\s*\{[^}]*position:\s*fixed/.test(css), 'A CSS 全屏档 tool-pane 转 fixed 覆盖中栏');
ok(/\.app-shell\.right-resizing\s*\{[^}]*transition:\s*none/.test(css), 'A CSS 拖拽瞬间去过渡(手柄跟手)');
ok(/@media \(max-width:\s*1180px\)[\s\S]*?\.right-resize-handle\s*\{\s*display:\s*none/.test(css), 'A CSS ≤1180 抽屉档隐藏拖拽手柄');
// HTML:手柄元素就位。
ok(/id="rightResizeHandle"/.test(html) && /class="right-resize-handle"/.test(html), 'A HTML #rightResizeHandle 元素就位');
// JS:三档 + 拖拽 + 双击循环 + localStorage 记忆 + Esc 退出全屏 + 软提示。
ok(/const RIGHT_TIERS\s*=\s*\['340', '480', 'full'\]/.test(src), 'A JS RIGHT_TIERS = [340,480,full]');
ok(/function applyRightWidth\(/.test(src) && /function restoreRightWidth\(/.test(src) && /function cycleRightWidth\(/.test(src), 'A JS applyRightWidth/restoreRightWidth/cycleRightWidth 齐备');
ok(/function initRightResize\(/.test(src) && /addEventListener\('pointerdown'/.test(src) && /setPointerCapture/.test(src), 'A JS 拖拽手柄 pointerdown + setPointerCapture');
ok(/addEventListener\('dblclick',\s*\(\)\s*=>\s*cycleRightWidth\(\)\)/.test(src), 'A JS 双击手柄循环切档');
ok(/setProperty\('--right-w'/.test(src), 'A JS 拖动实时改 --right-w');
ok(/localStorage\.setItem\('wcw\.rightWidth'/.test(src) && /localStorage\.getItem\('wcw\.rightWidth'\)/.test(src), 'A JS 档位记忆 localStorage(wcw.rightWidth)');
ok(/function exitRightFullscreen\(/.test(src) && /exitRightFullscreen\(\)/.test(src), 'A JS Esc 退出全屏(exitRightFullscreen 接入 Esc 链)');
ok(/function maybeSuggestWideRight\(/.test(src) && /maybeSuggestWideRight\(tab\)/.test(src), 'A JS 监控/用量页签一次性软提示切 480(maybeSuggestWideRight)');
ok(/restoreRightWidth\(\);\s*initRightResize\(\)/.test(src), 'A JS boot 恢复档位 + 绑定手柄');

// ═══════════ B. 监控卡降噪(§2.9,r2 降噪版)═══════════
// 节点卡去外框(原 1px 全边框已删)。
const nodeRule = ruleOf('.agent-node {');
ok(/border:\s*0/.test(nodeRule) && !/border:\s*1px solid var\(--line\)/.test(nodeRule), 'B .agent-node 无外框规则(border:0,原 1px 全边框已删)');
ok(!/\.agent-node\s*\{[^}]*border:\s*1px solid var\(--line\)/.test(css), 'B 全文件无 .agent-node{border:1px solid --line} 残留');
// 树脊线 + 圆角肘线(纯 CSS border)。
ok(/\.agent-run-graph::before\s*\{[^}]*background:\s*linear-gradient/.test(css), 'B 树脊线 .agent-run-graph::before(渐隐纵脊)');
ok(/\.agent-node::before\s*\{[^}]*border-bottom-left-radius/.test(css), 'B 圆角肘线 .agent-node::before(border-bottom-left-radius)');
// 状态渗透:2px 圆头发丝缘(--node-edge)+ 13% 渐变洗,替代 3px 色块左边框。
ok(/\.agent-node::after\s*\{[^}]*background:\s*var\(--node-edge/.test(css), 'B 2px 圆头发丝缘 .agent-node::after(--node-edge)');
ok(/\.agent-node\.an-running[^}]*--node-edge:\s*var\(--accent\)[^}]*linear-gradient/.test(css), 'B 运行态渗透洗(13% 渐变)+ 发丝缘');
ok(/\.agent-node\.an-running[^}]*box-shadow:\s*var\(--glow-accent\)/.test(css), 'B 运行态 --glow-accent 光渗');
ok(!/\.agent-node\.an-[a-z_]+\s*\{[^}]*border-left:\s*3px/.test(css), 'B 各状态 3px 实色左边框已全部改渗透缘(无 border-left:3px 残留)');
// 状态徽标 pill → 色点。
const badgeRule = ruleOf('.wf-status-badge {');
ok(/border-radius:\s*50%/.test(badgeRule) && /background:\s*currentColor/.test(badgeRule) && /width:\s*9px/.test(badgeRule), 'B 状态徽标缩为 9px 色点(currentColor 继承 .st-<status>)');
// 池卡渗透洗 + 左发丝缘。
ok(/\.pool-section\s*\{[^}]*linear-gradient\(100deg, color-mix\(in srgb, var\(--warn\) 11%/.test(css), 'B 池卡琥珀渗透洗(11% 渐变)');
ok(/\.pool-section::before\s*\{[^}]*background:\s*var\(--warn\)/.test(css), 'B 池卡左 2px 圆头发丝缘');
// 宽限窗细进度条 + 审批按钮 tap-min(P1 已挂,保留)。
ok(/\.pool-grace-bar\s*\{/.test(css) && /\.pool-grace-bar i\s*\{[^}]*linear-gradient/.test(css), 'B 宽限窗发丝进度条 .pool-grace-bar');
ok(/\.pool-actions button[^{]*\{[^}]*min-height:\s*var\(--tap-min\)/.test(css) || /var\(--tap-min\)/.test(ruleOf('.session-item, .tool-tabs button')), 'B 审批按钮 min-height:var(--tap-min)(保留 P1)');
// 当前活动行提升到聚合头(收起可见)。
ok(/\.ar-agg-live\s*\{/.test(css) && /\.ar-agg-live-dot\s*\{[^}]*animation:\s*pulse/.test(css), 'B 聚合头当前活动行 .ar-agg-live(+ 呼吸点)');
// JS:活动行 + 宽限窗条 + 计量常量。
ok(/const POOL_GRACE_HINT_MS\s*=\s*60000/.test(src), 'B JS 宽限窗窗宽提示常量(60s 对齐服务端默认)');
ok(/'ar-agg-live-text num'/.test(src) && /运行中节点 progressLog 末条|runningNode.*progressLog/.test(src), 'B JS 当前活动行取运行节点 progressLog 末条(提升到聚合头)');
ok(/'pool-grace'/.test(src) && /'pool-grace-bar'/.test(src) && /POOL_GRACE_HINT_MS/.test(src), 'B JS 宽限窗渲染细进度条');
// 契约:保留监控关键类名(与 agent-workflow-monitor-ui 断言一致,只改样式不搬类)。
for (const cls of ['.wf-status-badge', '.agent-run-card', '.agent-node', '.pool-section', '.st-running'])
  ok(css.includes(cls), 'B 保留监控类名 ' + cls);

// ═══════════ C. 技能库 / 记忆卡片化(§2.12)═══════════
// 两列卡片网格。
ok(/\.sk-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(css), 'C 技能两列卡片网格 .sk-grid(1fr 1fr)');
// 分段控件锚点导航。
ok(/\.sk-seg\s*\{/.test(css) && /\.sk-seg a\.active\s*\{/.test(css), 'C 分段控件锚点导航 .sk-seg(active 态)');
// 启用态青花描边 + 渗透洗 + 实心图标块。
ok(/\.sk-card\.on\s*\{[^}]*border-color:\s*color-mix\(in srgb, var\(--accent\)[^}]*linear-gradient/.test(css), 'C 启用态卡片青花描边 + 顶部渗透洗');
ok(/\.sk-card\.on \.sk-ico\s*\{[^}]*background:\s*var\(--accent\)/.test(css), 'C 启用态实心青花图标块');
// 中文名主显 + mono id 小字。
const skIdRule = ruleOf('.sk-id {');
ok(/font-family:\s*var\(--mono\)/.test(skIdRule) && /font-size:\s*var\(--fs-xs\)/.test(skIdRule), 'C mono id 降为小字(.sk-id)');
ok(/\.sk-name\s*\{[^}]*font-weight:\s*700/.test(css), 'C 中文名主显 .sk-name(粗体主标)');
// JS:导航 + 分组题 + 卡片构建 + 名称主显字段。
ok(/function buildSkAnchorNav\(/.test(src) && /function buildSkGroupTitle\(/.test(src), 'C JS 锚点导航 + 分组题构建器');
ok(/function skillCardIco\(/.test(src), 'C JS 卡片图标块构建器 skillCardIco');
ok(/el\('div', `skill-item sk-card/.test(src), 'C JS 卡片带 .skill-item(保键盘导航)+ .sk-card(视觉)');
ok(/el\('span', 'sk-name', s\.name \|\| s\.id\)/.test(src), 'C JS 中文名主显(sk-name = name)');
ok(/el\('div', 'sk-id', s\.id\)/.test(src) || /el\('code', 'sk-id'/.test(src), 'C JS mono id 小字(sk-id)');
// 记忆面板同构。
ok(/el\('div', `skill-item sk-card\$\{on \? ' on' : ''\}`\)/.test(src) && /buildMemoryRow/.test(src), 'C JS 记忆面板同构(buildMemoryRow 卡片化)');
ok(/buildSkAnchorNav\(memGroups/.test(src), 'C JS 记忆面板复用锚点导航(memGroups)');
// XSS 安全:卡片构建器不用 innerHTML(el/textContent)。
const bsrStart = src.indexOf('function buildSkillRow(');
const bsrBody = bsrStart >= 0 ? src.slice(bsrStart, bsrStart + 1400) : '';
ok(bsrBody && !bsrBody.includes('.innerHTML'), 'C buildSkillRow 无 innerHTML(el()/textContent,XSS 安全)');

// ═══════════ D. 用量瓦片自适应(§2.8)═══════════
ok(/\.usage-agg-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/.test(css), 'D 统计瓦片默认两列(340px)');
ok(/\.app-shell\.rp-wide \.usage-agg-stats\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/.test(css), 'D 480/全屏档三列(.app-shell.rp-wide)');
ok(/classList\.toggle\('rp-wide'/.test(src) && /classList\.add\('tools-fullscreen', 'rp-wide'\)/.test(src), 'D JS applyRightWidth 联动 rp-wide(瓦片列数随档切换)');
ok(/pb\.title\s*=\s*t\('usage\.planIncluded\.title'\)/.test(src), 'D 「计划内计费」徽标使用本地化人话 title tooltip');

// ═══════════ E. 纪律:延续 P1(无裸 px 字号回潮 / 新组件规则零硬编码色)═══════════
const pxFs = (css.match(/font-size:\s*[0-9.]+px/g) || []);
ok(pxFs.length === 2, 'E styles.css 裸 px 字号仍仅 2 处基线锚点(延续 P1;实际 ' + pxFs.length + ')');
for (const sel of ['.right-resize-handle {', '.sk-card {', '.sk-seg {', '.agent-run-graph {', '.wf-status-badge {', '.pool-grace {', '.ar-agg-live {'])
  ok(!/#[0-9a-fA-F]{3,6}\b/.test(ruleOf(sel)), 'E 新组件规则零硬编码色:' + sel.replace(' {', ''));

if (fail === 0) console.log('\nUI V3 P2 STATIC E2E: ALL PASS');
else { console.log(`\nUI V3 P2 STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }

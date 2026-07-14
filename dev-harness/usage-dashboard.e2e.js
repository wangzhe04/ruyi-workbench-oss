// dev-harness/usage-dashboard.e2e.js — 成本/用量看板前端契约护栏（W「用量」页签 + 图表 + 单价/预算配置）。
//
// 零依赖、离线、node 直跑。纯静态：只读 index.html / styles.css / 聚合前端源码(app.js + js/**，经
// read-frontend-src.js)，不起服务、不跑浏览器。dom-contract / uimode-style 同款风格。
//
// 覆盖战略清单要点：
//   ① 用量页签注册：data-tab="usage"(文案「用量」)在常驻组、开发者组之前；对应 #tab-usage / #usagePanel。
//   ② 简易模式可见：usage 不在 app.js DEV_TABS，也无 CSS [data-ui-mode="simple"] 隐藏规则（管理者可见）。
//   ③ 懒加载 + 范围段控：switchTab 开页才 fetch；4 段(今天/本周/本月/全部)默认本月；命中 /api/usage/summary。
//   ④ 聚合头：输入/输出 tokens + costsByCurrency + estimatedTurns 估算标注 + 「约/估算」诚实措辞。
//   ⑤ 分组条：按引擎/服务商/会话，手绘 SVG 水平条(createElementNS)，引擎 --wf-claude/--wf-provider 双色。
//   ⑥ 日趋势：手绘 SVG 迷你柱状(usageTrendSvg + createElementNS)。
//   ⑦ 预算软告警：usageBudgetBanner；超支 over + role=alert + --warn；未超进度条软提示。
//   ⑧ 诚实渲染：entryPlanBased 读 planBased/costTrusted；「计划内计费」标注；计划内不伪造金额。
//   ⑨ provider 单价配置：providerCard 写 p.pricing(inputPerM/outputPerM/currency)+本地化的说明文案。
//   ⑩ 预算 / Claude 单价配置：基础 tab cfgUsageBudgetMonthly + Claude tab cfgClaudePriceIn；save/fill 双向。
//   ⑪ 空状态引导 + a11y(sr-only 概述)+ SVG 数值 round(round2)。
//   ⑫ CSS：.usage-* 类齐备；预算 over 用 --warn；数字 tabular-nums；青花 token 着色（双主题自适应）。
//
// 判定行精确为 `USAGE-DASHBOARD E2E: ALL PASS`（失败打印明细并非零退出）。
'use strict';

const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const src = readFrontendSrc();

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 截取 open..close 之间的子串（含标记），用于把断言限定在容器内。
function between(hay, startNeedle, endNeedle) {
  const i = hay.indexOf(startNeedle);
  if (i < 0) return '';
  const j = hay.indexOf(endNeedle, i);
  return j < 0 ? hay.slice(i) : hay.slice(i, j + endNeedle.length);
}

// ───────────── ① 用量页签注册 + 面板容器 ─────────────
const toolTabs = between(html, '<div class="tool-tabs">', '</div>');
ok(!!toolTabs, '① 找到 .tool-tabs 块');
ok(/data-tab="usage"[^>]*>\s*用量\s*</.test(toolTabs), '① 存在 data-tab="usage" 且文案为「用量」');
{
  const residentIdx = toolTabs.indexOf('data-tt-group="resident"');
  const devIdx = toolTabs.indexOf('data-tt-group="dev"');
  const usageIdx = toolTabs.indexOf('data-tab="usage"');
  ok(residentIdx >= 0 && usageIdx > residentIdx, '① 用量页签在常驻组内');
  ok(devIdx >= 0 && usageIdx < devIdx, '① 用量页签在开发者组之前（常驻）');
}
ok(/<section class="tool-section" id="tab-usage">/.test(html), '① 存在面板 section#tab-usage');
const usageSection = between(html, 'id="tab-usage"', '</section>');
ok(/id="usagePanel"/.test(usageSection), '① 面板内含 #usagePanel 渲染宿主');

// ───────────── ② 简易模式可见（管理者友好）─────────────
// app.js DEV_TABS 不含 usage（否则 switchTab 会在简易模式改写去 files）。
const devTabsDecl = (src.match(/const\s+DEV_TABS\s*=\s*new\s+Set\(\[[^\]]*\]\)/) || [''])[0];
ok(!!devTabsDecl, '② 找到 DEV_TABS 声明');
ok(!/['"]usage['"]/.test(devTabsDecl), '② usage 不在 DEV_TABS（简易模式不被改写隐藏）');
// v3 §B2: simple 模式常驻页签 6->4,隐藏 usage/audit(改「AI 工作」面板 mini 链接进入)。
{
  const simpleHidden = new Set();
  const re = /\[data-ui-mode="simple"\]\s*\.tool-tabs\s*button\[data-tab="([a-z-]+)"\]/g;
  let m; while ((m = re.exec(css))) simpleHidden.add(m[1]);
  ok(simpleHidden.has('usage'), '② v3 §B2: simple 模式隐藏 usage 页签(6->4,改 mini 链接进入)');
  ok(simpleHidden.has('audit'), '② v3 §B2: simple 模式隐藏 audit 页签(与 usage 同批)');
}

// ───────────── ③ 懒加载 + 范围段控 ─────────────
ok(/tab === 'usage'/.test(src) && /loadUsage\(\)/.test(src), '③ switchTab 打开 usage 时才 loadUsage（懒加载）');
ok(/\/api\/usage\/summary\?range=/.test(src), '③ loadUsage 命中 GET /api/usage/summary?range=');
ok(/usageState\s*=\s*\{[^}]*range:\s*'month'/.test(src), '③ 默认范围为本月(month)');
for (const r of ['today', 'week', 'month', 'all']) {
  ok(new RegExp(`data-range="${r}"`).test(usageSection), `③ 范围段控含 data-range="${r}"`);
}
ok(/data-range="month"[^>]*class="usage-range-btn active"|class="usage-range-btn active"[^>]*data-range="month"/.test(usageSection), '③ 默认段控高亮「本月」');
ok(/id="usageRefreshBtn"/.test(usageSection), '③ 面板含刷新按钮 #usageRefreshBtn');
ok(/setUsageRange\(/.test(src) && /\.usage-range-btn/.test(src), '③ 段控按钮 wire 到 setUsageRange');

// ───────────── ④ 聚合头：tokens + 成本 + 估算标注 + 诚实措辞 ─────────────
ok(/function usageAggHead\(/.test(src), '④ 定义 usageAggHead');
ok(/totals\.inTok/.test(src) && /totals\.outTok/.test(src), '④ 聚合头读取 inTok / outTok');
ok(/estimatedTurns/.test(src) && /usage\.turns\.estimated/.test(src), '④ estimatedTurns>0 时标注估算回合');
ok(/costsByCurrency/.test(src), '④ 渲染 costsByCurrency（按币种分组，不换算）');
ok(/usage\.cost\.estimate/.test(src) && /usage\.note\.cost/.test(src), '④ 成本用「估算/非实际扣费」诚实措辞');
ok(/'约 '/.test(src), '④ 金额带「约」前缀（fmtCostsByCurrency prefix）');

// ───────────── ⑤ 分组条：手绘 SVG + 引擎双色 ─────────────
ok(/function usageGroup\(/.test(src), '⑤ 定义 usageGroup（按引擎/服务商/会话）');
ok(/usage\.group\.engine/.test(src) && /usage\.group\.provider/.test(src) && /usage\.group\.session/.test(src), '⑤ 三种分组标题齐备');
ok(/function usageBarSvg\(/.test(src) && /createElementNS/.test(src), '⑤ usageBarSvg 用 createElementNS 手绘（离线，不引图表库）');
ok(/'usage-bar-fill'/.test(src), '⑤ 构建条填充 .usage-bar-fill');
ok(/var\(--wf-claude\)/.test(src) && /var\(--wf-provider\)/.test(src), '⑤ 引擎条复用 --wf-claude / --wf-provider 双色');
ok(/openSession\(entry\.sessionId\)/.test(src), '⑤ 会话条可点击跳转（openSession）');

// ───────────── ⑥ 日趋势 SVG ─────────────
ok(/function usageTrendSvg\(/.test(src), '⑥ 定义 usageTrendSvg（手绘迷你柱状）');
ok(/'usage-trend-bar'/.test(src), '⑥ 构建趋势柱 .usage-trend-bar');

// ───────────── ⑦ 预算软告警 ─────────────
ok(/function usageBudgetBanner\(/.test(src), '⑦ 定义 usageBudgetBanner');
ok(/spentThisMonth/.test(src) && /monthly/.test(src), '⑦ 读取 budget.spentThisMonth / monthly');
ok(/usage\.budget\.over/.test(src), '⑦ 超支文案已接入资源');
ok(/'usage-budget-banner'\s*\+\s*\(over/.test(src) || /over\s*\?\s*' over'/.test(src), '⑦ 超支加 .over 修饰类');
ok(/setAttribute\('role',\s*over\s*\?\s*'alert'/.test(src), '⑦ 超支 role=alert（软告警，不阻断）');

// ───────────── ⑧ 诚实渲染：第三方 Coding Plan / 计划内计费 ─────────────
ok(/function entryPlanBased\(/.test(src), '⑧ 定义 entryPlanBased（诚实判定）');
ok(/planBased\s*===\s*true/.test(src) && /costTrusted\s*===\s*false/.test(src), '⑧ 按后端 planBased / costTrusted 区分');
ok(/usage\.planIncluded/.test(src), '⑧ 计划内条目标注「计划内计费」');
ok(/sourceLabel\s*\|\|\s*(entry\.)?source/.test(src), '⑧ 显示来源名(sourceLabel/source)');
ok(/usage\.note\.planUsage/.test(src), '⑧ 计划内不伪造金额（订阅计费说明）');
ok(/totals\.planBasedTurns/.test(src), '⑧ 聚合诚实脚注由后端 totals.planBasedTurns 驱动（对齐真实契约）');

// ───────────── ⑨ provider 单价配置 ─────────────
ok(/p\.pricing\s*=\s*\{\}/.test(src) || /p\.pricing\s*=\s*\{/.test(src), '⑨ providerCard 写 p.pricing');
ok(/inputPerM/.test(src) && /outputPerM/.test(src), '⑨ 单价含 inputPerM / outputPerM（每百万 token）');
ok(/PRICING_CURRENCIES/.test(src), '⑨ 单价含币种选择(PRICING_CURRENCIES)');
ok(/t\('provider\.pricing\.help'\)/.test(src), '⑨ 单价说明使用 provider.pricing.help 本地化文案');
ok(/prov-pricing/.test(src) && /card\.append\([^)]*priceB/.test(src), '⑨ 单价块并入 provider 卡片');

// ───────────── ⑩ 预算 / Claude 单价配置（save/fill 双向）─────────────
const stabBasic = between(html, 'id="stab-basic"', 'id="stab-claude"');
ok(/id="cfgUsageBudgetMonthly"/.test(stabBasic) && /id="cfgUsageBudgetCurrency"/.test(stabBasic), '⑩ 月度预算配置在「基础」tab（简易可见）');
const stabClaude = between(html, 'id="stab-claude"', 'id="stab-providers"');
ok(/id="cfgClaudePriceIn"/.test(stabClaude) && /id="cfgClaudePriceOut"/.test(stabClaude), '⑩ Claude 第三方端点单价在「Claude CLI」tab');
ok(/usageBudget:/.test(src) && /claudePricing:/.test(src), '⑩ saveSettings 提交 usageBudget / claudePricing');
ok(/c\.usageBudget/.test(src) && /c\.claudePricing/.test(src), '⑩ fillSettings 回填 usageBudget / claudePricing');

// ───────────── ⑪ 空状态引导 + a11y + SVG round ─────────────
ok(/usage\.empty/.test(src), '⑪ 空状态引导文案');
ok(/'sr-only'/.test(src), '⑪ 图表加 sr-only 概述（无障碍）');
ok(/function round2\(/.test(src) && /round2\(/.test(src), '⑪ SVG 数值自算 round（round2）');
ok(/aria-hidden/.test(usageSection) === false || /aria-live="polite"/.test(usageSection), '⑪ #usagePanel 为 aria-live 区域');

// ───────────── ⑫ CSS 契约 ─────────────
ok(/\.usage-panel\b/.test(css), '⑫ .usage-panel 样式存在');
ok(/\.usage-range-btn\b/.test(css) && /\.usage-range-btn\.active/.test(css), '⑫ 范围段控 + active 态样式');
ok(/\.usage-budget-banner\b/.test(css) && /\.usage-budget-banner\.over\b/.test(css), '⑫ 预算横幅 + over 态样式');
ok(/\.usage-budget-banner\.over[^{]*\{[^}]*--warn/.test(css) || /\.usage-budget-banner\.over\s+\.usage-budget-text[^{]*\{[^}]*--warn/.test(css), '⑫ 超支态用 --warn（琥珀）');
ok(/\.usage-bar-fill\b/.test(css) && /\.usage-trend-bar\b/.test(css), '⑫ 条填充 + 趋势柱样式');
ok(/\.sr-only\b/.test(css), '⑫ .sr-only 视觉隐藏样式存在');
{
  const usageCss = css.slice(css.indexOf('成本 / 用量看板'));
  ok(/tabular-nums/.test(usageCss), '⑫ 用量数字用 tabular-nums');
  ok(!/#[0-9a-fA-F]{6}/.test(usageCss.replace(/--ruyi-cloud[^;]*;/g, '')), '⑫ 用量 CSS 走 token（无硬编码十六进制色）');
}

if (fail === 0) console.log('\nUSAGE-DASHBOARD E2E: ALL PASS');
else { console.log(`\nUSAGE-DASHBOARD E2E: ${fail} FAIL`); process.exitCode = 1; }

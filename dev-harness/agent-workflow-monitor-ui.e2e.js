'use strict';
// dev-harness/agent-workflow-monitor-ui.e2e.js — Agent 工作流「运行监控」重设计的前端契约护栏（v1.5）。
//
// 零依赖、离线、node 直跑、无端口。纯静态:只读聚合前端源码(read-frontend-src.js:app.js + js/**/*.js)
// 与 styles.css,不起服务不跑浏览器。dom-contract 风格的字面量断言:把 §2 编排实时监控重设计里
// 「关键 class / 结构 / 文案 / 一键处置 wire / 语义 token 着色 / 防御式 rejected / XSS 安全」这些
// 落点固化为契约,防后续拆分/改动把它们搬没或回退。真实渲染由指挥官用 preview 工具截图核验。
//
// 判定行:`AGENT WORKFLOW MONITOR UI E2E: ALL PASS`(失败打印明细并非零退出)。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const src = readFrontendSrc();
const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const has = (s, ...subs) => subs.every(x => s.includes(x));

// renderAgentRuns 函数体切片(供 XSS / 结构断言精确定位,避免全文件误命中)。
const rStart = src.indexOf('function renderAgentRuns(runs)');
const rEnd = src.indexOf('async function loadAgentRuns', rStart);
ok(rStart >= 0 && rEnd > rStart, 'renderAgentRuns 函数存在且边界可定位');
const renderBody = rStart >= 0 ? src.slice(rStart, rEnd > rStart ? rEnd : undefined) : '';

// ───────────── ① 聚合头（§2.7）：状态 chip + 节点 done/total + 时长 +（若有）成本 ─────────────
ok(has(renderBody, "'ar-agg'", 'ar-agg-chip st-', "'ar-agg-nodes'"),
  '① 聚合头容器 + 状态 chip(.ar-agg-chip.st-<status>)+ 节点计数');
ok(has(renderBody, "'ar-agg-time'") && has(src, 'function runElapsedMs', 'function fmtDuration'),
  '① 已运行时长 chip + runElapsedMs/fmtDuration 计时工具');
ok(has(renderBody, "'ar-agg-cost'") && has(src, 'function runCostLabel'),
  '① 累计 token/成本 chip(runCostLabel;字段缺失时返回空不显示——defensive)');

// ───────────── ② 节点卡状态徽标（§2.3）+ 全状态色标 ─────────────
ok(has(renderBody, 'wf-status-badge st-') && has(src, 'function agentStatusIcon', 'const AGENT_STATUS_ICON'),
  '② 状态徽标 .wf-status-badge.st-<status> + 图标映射');
// 各状态色标必须在 CSS 中以语义 token 上色(queued/running/succeeded/failed/rejected/skipped/waiting/cancelled/degraded)。
for (const s of ['st-running', 'st-succeeded', 'st-failed', 'st-rejected', 'st-skipped', 'st-waiting_resource', 'st-degraded'])
  ok(css.includes(s), `② CSS 定义状态色标 .${s}`);
ok(has(css, '.st-running', 'animation: pulse'), '② running 徽标脉冲动画(受全局 reduced-motion 收敛)');

// ───────────── ③ 引擎徽标（§3.2）：Claude 青花蓝 / Provider 釉里红赭 双色 ─────────────
ok(has(src, 'function agentEngineBadge') && has(renderBody, 'agentEngineBadge('),
  '③ 引擎徽标构建器 agentEngineBadge 被节点卡调用');
ok(has(src, "'wf-engine-badge eng-claude'", "'wf-engine-badge eng-provider'"),
  '③ 双引擎徽标类 eng-claude / eng-provider');
ok(has(css, '--wf-claude: var(--accent)', '--wf-provider: var(--eng-claude)'),
  '③ 引擎徽标 token 别名(Claude=--accent 青花蓝 / Provider=--eng-claude 釉里红,主题感知)');
ok(has(css, '.wf-engine-badge.eng-claude', 'var(--wf-claude)') && has(css, '.wf-engine-badge.eng-provider', 'var(--wf-provider)'),
  '③ 引擎徽标以 token 着色(不硬编码)');

// ───────────── ④ 状态语义分离（§2.4）：failed / rejected / skipped 三分 + defensive ─────────────
ok(has(src, 'function nodeDisplayStatus'), '④ nodeDisplayStatus 展示态状态派生存在');
const ndStart = src.indexOf('function nodeDisplayStatus');
const ndBody = ndStart >= 0 ? src.slice(ndStart, ndStart + 600) : '';
ok(has(ndBody, "=== 'rejected'") && has(ndBody, 'gateVerdict') && has(ndBody, 'verdict') && has(ndBody, "=== 'fail'"),
  '④ defensive:后端直发 rejected 用之;仍发 failed+gateVerdict/verdict==="fail" 时派生为 rejected');
ok(css.includes('.agent-run-card.ar-rejected') && css.includes('.agent-node.an-rejected'),
  '④ rejected 在 run/node 两级都有琥珀色标(≠failed 的红)');
ok(has(css, '.agent-node.an-rejected', 'var(--warn)') && has(css, '.agent-node.an-failed', 'var(--danger)'),
  '④ 三态分色:rejected=--warn(琥珀)、failed=--danger(红)、skipped=--muted(灰,已有 an-skipped)');
ok(css.includes('.agent-node.an-skipped'), '④ skipped 灰色标存在');

// ───────────── ⑤ 停滞/失败横幅（§2.5）：idleAborted 或等待资源+blocker ─────────────
ok(has(renderBody, "'wf-stall-banner'", 'idleAborted', 'waitingBlocked'),
  '⑤ 停滞横幅由 run.idleAborted 或有 blocker 的等待资源节点触发');
ok(has(renderBody, '疑似停滞'), '⑤ 横幅文案「疑似停滞」');
ok(has(renderBody, "'查看'", "agentRunAction(run.id, 'stop')"),
  '⑤ 横幅 [查看] + [停止](停止 wire 到 stop 动作)');
ok(has(css, '.wf-stall-banner', 'var(--warn)'), '⑤ 横幅以 --warn 琥珀着色');

// ───────────── ⑥ 迭代/预算 mini 进度 + 计时 + 质量门 + 资源锁（§2.3）─────────────
ok(has(renderBody, "'wf-node-budget'", "'wf-budget-fill'") && has(renderBody, 'loopIteration', 'maxIters'),
  '⑥ 迭代/预算 mini 进度(loop 显 loopIteration,否则 iters/maxIters)');
ok(has(renderBody, "'wf-node-timer'", 'startedAt'), '⑥ 节点计时 now-startedAt');
ok(has(renderBody, "'wf-node-gate'", 'wf-gate-verdict gv-', 'wf-gate-conf') && has(renderBody, 'confidence'),
  '⑥ 质量门 verdict + 置信度环');
ok(has(renderBody, "waitingSet.has(resource)", 'blocking'), '⑥ 资源锁 chip 高亮 blocker(.blocking)');
ok(has(css, '.agent-resource-chip.blocking', 'var(--warn)'), '⑥ blocker chip 以 --warn 高亮');

// ───────────── ⑦ 失败一键处置（§5.3）：wire 到已有端点动作 ─────────────
ok(has(renderBody, "agentRunAction(run.id, 'pause')", "agentRunAction(run.id, 'resume')", "agentRunAction(run.id, 'stop')"),
  '⑦ 运行中 run:暂停/继续/停止 wire 到 pause/resume/stop');
ok(has(renderBody, "'retry_node'", '仅重试此节点', '重试此节点及下游'),
  '⑦ 失败/结束节点:重试此节点/及下游 wire 到 retry_node');
ok(has(renderBody, "'查看错误'") && has(renderBody, "disp === 'failed' || disp === 'rejected'"),
  '⑦ 失败/判否节点另给「查看错误」');

// ───────────── ⑧ 无障碍 + XSS 安全 ─────────────
ok(has(renderBody, "setAttribute('aria-label'"), '⑧ 处置按钮带 aria-label(无障碍)');
ok(!renderBody.includes('.innerHTML'), '⑧ renderAgentRuns 不使用 innerHTML(结果/错误经 el()/textContent,XSS 安全)');

// ───────────── ⑨ 兼容:不破坏轮询协议 / 复用展开态保存 ─────────────
ok(has(src, 'function renderAgentRuns', 'async function loadAgentRuns', 'function agentRunAction'),
  '⑨ 核心函数仍在(renderAgentRuns/loadAgentRuns/agentRunAction)');
ok(has(renderBody, "'.agent-run-card'", "'.agent-node'") && has(renderBody, 'dataset.runId', 'dataset.nodeId'),
  '⑨ 保留 .agent-run-card/.agent-node 基类 + data-run-id/data-node-id(展开态保存不回归)');
ok(has(src, 'setInterval(loadAgentRuns, 2000)'), '⑨ 2s 轮询协议未改');

if (fail === 0) console.log('\nAGENT WORKFLOW MONITOR UI E2E: ALL PASS');
else { console.log(`\nAGENT WORKFLOW MONITOR UI E2E: ${fail} FAIL`); process.exitCode = 1; }

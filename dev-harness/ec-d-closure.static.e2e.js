#!/usr/bin/env node
'use strict';

// EC-D exit-condition ledger. Detailed behavior stays in the focused e2e files; this fast gate prevents
// the closure evidence itself from drifting or silently losing one of the promised journeys.
const fs = require('fs');
const path = require('path');
const { CHAT_CSS_ROUTES, CSS_ROUTES } = require('./read-frontend-css.js');
const { readFrontendSrc } = require('./read-frontend-src.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const read = file => fs.readFileSync(file, 'utf8');
const frontend = readFrontendSrc();
const html = read(path.join(PUBLIC, 'index.html'));
const manifest = JSON.parse(read(path.join(SRC, 'manifest.json')));
const httpRouter = read(path.join(SRC, '13-http-router.js'));
const coreDomainRoutes = read(path.join(SRC, '13d-core-domain-routes.js'));
const performanceGate = read(path.join(__dirname, 'ec-d-performance.e2e.js'));
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};

const requiredHarness = [
  'turn-narrative.static.e2e.js',
  'steering-claude.e2e.js',
  'dom-contract.e2e.js',
  'dom-screenshot.e2e.js',
  'theme.e2e.js',
  'uimode-style.e2e.js',
  'ec-d-performance.e2e.js',
];
ok(requiredHarness.every(file => fs.existsSync(path.join(__dirname, file))),
  'E1 回合同构、DOM、视觉、模式与性能验收件齐全');

ok(/const STARTUP_BUDGET_MS = 1500\b/.test(performanceGate)
  && /const VIEW_SWITCH_P95_BUDGET_MS = 200\b/.test(performanceGate)
  && /Network\.setCacheDisabled/.test(performanceGate)
  && /getBoundingClientRect\(\)/.test(performanceGate)
  && /requestAnimationFrame/.test(performanceGate),
'E2 真实浏览器性能门锁定冷启动 1.5s 与视图 P95 200ms，并覆盖 layout/paint');

ok(/role="log"/.test(html)
  && /aria-live="polite"/.test(html)
  && /aria-relevant="additions text"/.test(html)
  && /aria-busy/.test(frontend),
'E3 消息日志具备读屏增量语义与静态重进 busy 抑制');

ok(/data-message-key/.test(frontend)
  && /messageRenderSignature/.test(frontend)
  && /captureScrollAnchor/.test(frontend)
  && /restoreScrollAnchor/.test(frontend)
  && /activeRow.*isConnected/.test(frontend),
'E4 消息重绘使用 keyed reconciliation，并保留滚动锚点与活动回合');

ok(/function createTurnSegmentBuilder\(/.test(read(path.join(SRC, '02-session-store.js')))
  && /const batchId = String\(evt\.batchId/.test(read(path.join(SRC, '02-session-store.js')))
  && /createTurnSegmentBuilder\(\)/.test(read(path.join(SRC, '05-claude-engine.js')))
  && /activeProviderBatchId/.test(read(path.join(SRC, '09-workflow.js'))),
'E5 双引擎统一有序 segments，并保留并行工具 batchId');

ok(/turn-record/.test(frontend)
  && /turnSummary/.test(frontend)
  && /renderArtifacts/.test(frontend)
  && /rollback/.test(frontend),
'E6 回合末工具记录、变更/回滚与产物入口保持可达');

ok(CHAT_CSS_ROUTES.length === 5
  && CHAT_CSS_ROUTES.every(route => CSS_ROUTES.includes(route))
  && CHAT_CSS_ROUTES.some(route => route.includes('chat-primitives'))
  && CHAT_CSS_ROUTES.some(route => route.includes('chat-narrative'))
  && CHAT_CSS_ROUTES.some(route => route.includes('chat-live'))
  && CHAT_CSS_ROUTES.some(route => route.includes('chat-composer')),
'E7 聊天 CSS 按 shell/primitives/narrative/live/composer 物理所有权分层');

const backendFiles = new Set(manifest.modules.map(module => module.file));
ok(['02-session-store.js', '04-permission-runtime.js', '08-agent-runs.js', '13b-api-domain-routes.js', '13d-core-domain-routes.js']
  .every(file => backendFiles.has(file))
  && ['handleSessionApiRoutes', 'handleInterventionApiRoutes', 'handleAgentRunApiRoutes']
    .every(name => coreDomainRoutes.includes(`function ${name}(`) && httpRouter.includes(`await ${name}(`))
  && !/pathname === '\/api\/(sessions|permission\/request|agent-runs)'/.test(httpRouter),
'E8 session、permission、agent-runs 实现与 API 编排均完成后端物理拆域');

ok(read(path.join(PUBLIC, 'app.js')).trimEnd().split(/\r?\n/).length <= 1200
  && ['session-experience.js', 'interaction-prompts.js', 'agent-workflows.js']
    .every(file => fs.existsSync(path.join(PUBLIC, 'js', file))),
'E9 前端组合根不超过 1200 行，会话/干预/Agent 工作流边界独立');

console.log(`\nEC-D CLOSURE STATIC E2E: ${failures ? `FAIL (${failures})` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);

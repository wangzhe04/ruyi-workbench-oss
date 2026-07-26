'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const store = read('ruyi-workbench/app/src/02-session-store.js');
const claude = read('ruyi-workbench/app/src/05-claude-engine.js');
const provider = read('ruyi-workbench/app/src/09-workflow.js');
const app = read('ruyi-workbench/app/public/app.js');
const index = read('ruyi-workbench/app/public/index.html');
const narrativeModule = read('ruyi-workbench/app/public/js/turn-narrative.js');
const css = read('ruyi-workbench/app/public/styles.css');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));

let failed = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { console.error('FAIL ' + label); failed += 1; }
}

const start = store.indexOf('function createTurnSegmentBuilder()');
const end = store.indexOf('\n// v0.8-S3/S4a:', start);
ok(start >= 0 && end > start, 'N1 TurnSegmentBuilder 在 session store');
const context = {};
vm.runInNewContext(store.slice(start, end) + '\nthis.createTurnSegmentBuilder = createTurnSegmentBuilder;', context);
const builder = context.createTurnSegmentBuilder();
const batch = builder.createBatchId('openai');
builder.consume({ type: 'assistant_delta', text: '先说明。' });
builder.consume({ type: 'tool_use', id: 'a', name: 'file_read', batchId: batch });
builder.consume({ type: 'tool_result', id: 'a', content: 'A' });
builder.consume({ type: 'tool_use', id: 'b', name: 'git_status', batchId: batch });
builder.consume({ type: 'tool_result', id: 'b', content: 'B' });
builder.consume({ type: 'assistant_delta', text: '再总结。' });
const segments = builder.snapshot();
ok(segments.map(segment => segment.type).join(',') === 'text,tool,tool,text', 'N2 文本→工具→工具→文本顺序持久化');
ok(segments[1].batchId === segments[2].batchId && segments[1].status === 'done' && segments[2].status === 'done', 'N3 同响应工具共享 batchId 且结果回填');

const planBuilder = context.createTurnSegmentBuilder();
planBuilder.consume({ type: 'assistant_delta', text: 'PLAN: do it' });
planBuilder.consume({ type: 'plan', planId: 'p1', markdown: 'PLAN: do it' });
ok(planBuilder.snapshot().map(segment => segment.type).join(',') === 'plan', 'N4 plan 语义段替换重复文本');
planBuilder.consume({ type: 'plan_decision', planId: 'p1', decision: 'approve', note: '先跑测试' });
ok(planBuilder.snapshot()[0].status === 'approved' && planBuilder.snapshot()[0].note === '先跑测试', 'N4b plan 决定状态持久化');

const stateBuilder = context.createTurnSegmentBuilder();
stateBuilder.consume({ type: 'permission_request', requestId: 'perm1', toolName: 'file_write', tier: 'edit', revertible: true });
stateBuilder.consume({ type: 'permission_decision', requestId: 'perm1', behavior: 'allow' });
stateBuilder.consume({ type: 'ask_user', questionId: 'q1', questions: [{ question: '继续吗？' }] });
stateBuilder.consume({ type: 'question_answer', questionId: 'q1', ok: true, summary: '继续' });
stateBuilder.consume({ type: 'agent_workflow', id: 'wf1', state: 'start', nodeCount: 3 });
stateBuilder.consume({ type: 'agent_workflow', id: 'wf1', state: 'end', status: 'completed', succeeded: 3, failed: 0 });
stateBuilder.consume({ type: 'mission', mission: { id: 'm1', goal: '交付', milestones: [{ status: 'done' }, { status: 'pending' }] } });
stateBuilder.consume({ type: 'mission', state: 'complete', mission: { id: 'm1', goal: '交付', milestones: [{ status: 'done' }, { status: 'done' }] } });
const stateSegments = stateBuilder.snapshot();
ok(stateSegments.map(segment => segment.type).join(',') === 'permission,question,workflow,mission', 'N4c 权限/提问/工作流/Mission 进入同一语义序列');
ok(stateSegments[0].status === 'allowed' && stateSegments[1].status === 'answered'
  && stateSegments[2].status === 'done' && stateSegments[3].status === 'done', 'N4d 低频过程事件最终状态可静态复原');

ok(/segments:\s*turnSegments\.snapshot\(\)/.test(claude), 'N5 Claude CLI 持久化 segments');
ok(/segments:\s*turnSegments\.snapshot\(\)/.test(provider), 'N6 OpenAI 兼容引擎持久化 segments');
ok(/activeProviderBatchId\s*=\s*call\.toolCalls/.test(provider), 'N7 OpenAI 同响应批次标识');
ok(/function renderStaticTurnNarrative\(/.test(app) && /validTurnSegments\(msg\)/.test(app), 'N8 静态重进走同一有序叙事渲染器');
ok(/registerNarrativeTool\(live, evt, card\)/.test(app) && /sealLiveTextSegment\(live\)/.test(app), 'N9 流式工具边界封存当前文本段');
ok(/function turnToolIndexCard\(/.test(app) && /narrativeToolAnchor/.test(app), 'N10 回合尾部工具索引可定位过程');
ok(/target\.focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(app) && /narrative-located/.test(app), 'N10b 尾部定位具备键盘焦点与可见反馈');
ok(/role="log"[^>]*aria-live="polite"/.test(index) && /role === 'assistant' \? 'article'/.test(app), 'N10c 消息区 role=log 且助手回合使用 article');
ok(/messageDomKey/.test(app) && /captureScrollAnchor/.test(app) && /restoreScrollAnchor/.test(app)
  && /export function messageRenderSignature/.test(narrativeModule), 'N10d keyed 消息更新与滚动锚点已拆入叙事模块');
ok(/consecutive\.length > 3/.test(app) && /narrative-completed-run/.test(app), 'N10e 超长静态/流式工具序列保持常数级可见行');
ok(/\.message\s*\{\s*width:\s*min\(1320px,\s*94%\)/.test(css), 'N11 全屏聊天宽度提升至 min(1320px,94%)');
for (const key of ['chat.turnRecord', 'chat.jumpToTool', 'chat.planSegment', 'chat.questionSegment',
  'chat.conversationAria', 'chat.assistantTurnAria', 'narrative.permission', 'narrative.workflow',
  'narrative.mission', 'narrative.status.answered']) {
  ok(Boolean(zh[key] && en[key]), 'N12 双语键 ' + key);
}
ok(fs.existsSync(path.join(ROOT, 'dev-harness/dom-screenshot.e2e.js'))
  && fs.existsSync(path.join(ROOT, 'dev-harness/visual-baselines/workbench-shell-v2.json')), 'N13 双主题像素回归门 v2 与基线已落地');

if (failed) {
  console.error(`\nTURN NARRATIVE STATIC E2E: ${failed} FAILED`);
  process.exit(1);
}
console.log('\nTURN NARRATIVE STATIC E2E: ALL PASS');

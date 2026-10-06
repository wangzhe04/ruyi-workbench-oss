'use strict';

// Regression contract for live-thinking segmentation. The provider emits context_estimate between deltas;
// it updates only the meter and must never manufacture a second thinking panel.
// 架构还债批 3·D:修前用 indexOf('const THINKING_NARRATIVE_BOUNDARY_TYPES') 到
// indexOf('\n\nexport function createChatStreamRuntime') 切一段源码进 vm 跑 —— 中间插一个 helper、
// 调一下两者顺序或空行,切片就断。现在 import 前端模块本身(chat-stream-runtime.js 零 import,Node 直接可载),
// 断言的是浏览器里跑的同一个函数。
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const file = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'chat-stream-runtime.js');

(async () => {
const { isThinkingNarrativeBoundary: boundary } = await import(pathToFileURL(file).href);
assert(typeof boundary === 'function', 'thinking-boundary helper is exported by chat-stream-runtime.js');

function countThinkingPanels(events) {
  let active = false;
  let panels = 0;
  for (const evt of events) {
    if (active && boundary(evt)) active = false;
    if (evt.type === 'thinking_delta' && !active) { active = true; panels += 1; }
  }
  return panels;
}

assert.equal(countThinkingPanels([
  { type: 'thinking_delta', text: 'a' },
  { type: 'context_estimate', contextTokens: 1 },
  { type: 'thinking_delta', text: 'b' },
  { type: 'usage', totalTokens: 2 },
  { type: 'thinking_delta', text: 'c' },
]), 1, 'telemetry between deltas keeps one thinking panel');

assert.equal(countThinkingPanels([
  { type: 'thinking_delta', text: 'a' },
  { type: 'tool_use', id: 'read', name: 'file_read' },
  { type: 'thinking_delta', text: 'b' },
]), 2, 'tool use remains a real chronological boundary');

assert.equal(countThinkingPanels([
  { type: 'thinking_delta', text: 'a' },
  { type: 'assistant_delta', text: 'answer' },
  { type: 'thinking_delta', text: 'b' },
]), 2, 'assistant text remains a real chronological boundary');

assert.equal(boundary({ type: 'subagent', state: 'start' }), true, 'subagent start starts a new narrative phase');
assert.equal(boundary({ type: 'subagent', state: 'end' }), false, 'subagent status updates do not split later thinking');
assert.equal(boundary({ type: 'agent_workflow', state: 'running' }), true, 'workflow start/running starts a new narrative phase');
assert.equal(boundary({ type: 'unknown_future_telemetry' }), false, 'unknown telemetry is safe by default');

// 子代理事件不切碎父回合的思考块(用户:「召出子 agent 后,思维链被切得很碎」)。
// 父回合在后台代理跑着的时候照样在写思考,子代理自己的 tool_use / compact(带 subagentId)只进它自己的卡片,
// 后台 run 里晚到的节点 / 工作流起头也只是挂一张卡,都不是父回合叙事里的新一步。
assert.equal(boundary({ type: 'tool_use', id: 'sub-read', name: 'file_read', subagentId: 'sub_1' }), false, 'a sub-agent tool_use never closes the parent thinking panel');
assert.equal(boundary({ type: 'compact', mode: 'forced_400', phase: 'completed', subagentId: 'sub_1' }), false, 'a sub-agent compaction never closes the parent thinking panel');
assert.equal(boundary({ type: 'compact', mode: 'auto', phase: 'completed' }), true, 'the parent own compaction stays a boundary');
assert.equal(boundary({ type: 'subagent', state: 'start', background: true }), false, 'a late-starting background node does not split the parent thinking');
assert.equal(boundary({ type: 'agent_workflow', state: 'start', background: true }), false, 'a background workflow start does not split the parent thinking');
assert.equal(boundary({ type: 'agent_workflow', state: 'running', background: true }), false, 'a background workflow running update does not split the parent thinking');
assert.equal(boundary({ type: 'subagent', state: 'start', background: false }), true, 'a foreground sub-agent card is still a real chronological boundary');

assert.equal(countThinkingPanels([
  { type: 'thinking_delta', text: 'a' },
  { type: 'subagent_progress', subagentId: 'sub_1', note: 'streaming' },
  { type: 'tool_use', id: 's1', name: 'file_read', subagentId: 'sub_1', background: true },
  { type: 'thinking_delta', text: 'b' },
  { type: 'tool_result', id: 's1', subagentId: 'sub_1', background: true },
  { type: 'subagent', id: 'sub_2', state: 'start', background: true },
  { type: 'thinking_delta', text: 'c' },
  { type: 'compact', subagentId: 'sub_1', phase: 'completed' },
  { type: 'thinking_delta', text: 'd' },
]), 1, 'background sub-agent events interleaved with parent reasoning keep ONE thinking panel');

assert.equal(countThinkingPanels([
  { type: 'thinking_delta', text: 'a' },
  { type: 'tool_use', id: 's1', name: 'file_read', subagentId: 'sub_1' },
  { type: 'thinking_delta', text: 'b' },
  { type: 'tool_use', id: 'parent-read', name: 'file_read' },
  { type: 'thinking_delta', text: 'c' },
]), 2, 'the parent own tool_use still splits, whatever the sub-agents do in between');

console.log('THINKING BOUNDARY STATIC E2E: ALL PASS');
})().catch(err => { console.error(err && err.stack || err); console.log('THINKING BOUNDARY STATIC E2E: FAIL (1)'); process.exit(1); });

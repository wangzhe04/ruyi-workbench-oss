'use strict';

// Regression contract for live-thinking segmentation. The provider emits context_estimate between deltas;
// it updates only the meter and must never manufacture a second thinking panel.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'chat-stream-runtime.js');
const source = fs.readFileSync(file, 'utf8');
const start = source.indexOf('const THINKING_NARRATIVE_BOUNDARY_TYPES');
const end = source.indexOf('\n\nexport function createChatStreamRuntime', start);
assert(start >= 0 && end > start, 'thinking-boundary helper is present and extractable');
const sandbox = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.boundary = isThinkingNarrativeBoundary;', sandbox);
const boundary = sandbox.boundary;

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

console.log('THINKING BOUNDARY STATIC E2E: ALL PASS');

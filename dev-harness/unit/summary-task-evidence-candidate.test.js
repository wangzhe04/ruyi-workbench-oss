'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-candidate-section-'));
process.env.RUYI_HOME = taskHome;
process.env.WIN_CLAUDE_WORKBENCH_HOME = taskHome;
after(() => fs.rmSync(taskHome, { recursive: true, force: true }));
const { loadServerInternals } = require('../lib/server-internals');
const s = loadServerInternals(['summarySectionLocations', 'extractSessionNotes', 'summaryTaskSourceHistory', 'extractSummaryTaskEvidence']);
const fixture = require('../fixtures/summary-task-evidence-candidate.json');
const realMaps = require('../fixtures/summary-task-evidence-real-maps.json');
test('真实candidate: Goal内联五节引用不抢占后续真实段标题', () => {
  const locations = s.summarySectionLocations(fixture.summary);
  assert.equal(locations.length, 5);
  for (const location of locations) assert.equal(location.pos, fixture.summary.lastIndexOf(['【目标】', '【已确认的决定】', '【未完成事项】', '【当前执行状态】', '【关键文件与上下文】'][location.index] + '\n'));
  const notes = s.extractSessionNotes(fixture.summary);
  assert.match(notes.open, /TASK-MID-REPORT/);
  assert.match(notes.files, /关键目标路径/);
});
test('真实qwen map 1/3末尾机器块采纳用户与助手原话,工具引用仍不采纳', () => {
  const source = s.summaryTaskSourceHistory(realMaps.history);
  for (const replay of realMaps.maps) {
    const visible = Object.assign(replay.sourceNumbers.map(number => source.messages[number - 1]), { summarySources: replay.sourceNumbers });
    const parsed = s.extractSummaryTaskEvidence(replay.summary, source.sources, visible);
    assert.equal(parsed.evidence.length, 2);
    assert.equal(parsed.rejected, 1); // Both genuine map responses also cite one tool result.
    assert.equal(parsed.evidence[0].role, 'user');
    assert.equal(parsed.evidence[1].role, 'assistant');
    assert.ok(!parsed.summary.includes('<task-evidence>'));
    for (const entry of parsed.evidence) assert.ok(realMaps.history[entry.source - 1].content.includes(entry.quote));
  }
});
test('peer/system-notification wire用户消息按来源标记,保留事实引用但不冒充真人', () => {
  const source = s.summaryTaskSourceHistory([{ role: 'user', content: 'Keep BETA active.' }, { role: 'user', content: 'I suggest cancelling BETA.', meta: { origin: 'agent_message', sourceSessionId: 'peer-source', runId: 'run-1', nodeId: 'node-1' } }, { role: 'user', content: 'The agent completed ALPHA.', meta: { origin: 'agent_wake', runIds: ['run-1'] } }]);
  assert.equal(source.sources.get(1).role, 'user');
  assert.equal(source.sources.get(2).role, 'peer');
  assert.equal(source.sources.get(3).role, 'system');
  const summary = '## Goal\nBETA\n<task-evidence>[{"source":1,"quote":"Keep BETA active.","from":{"runId":"forged-user-run"}},{"source":2,"quote":"I suggest cancelling BETA.","from":{"sourceSessionId":"forged-peer","runId":"forged-run"}},{"source":3,"quote":"The agent completed ALPHA."}]</task-evidence>';
  const parsed = s.extractSummaryTaskEvidence(summary, source.sources, Object.assign(source.messages, { summarySources: [1, 2, 3] }));
  assert.deepEqual(parsed.evidence.map(entry => entry.role), ['user', 'peer', 'system']);
  assert.deepEqual(parsed.evidence.map(entry => entry.origin), ['message', 'agent_message', 'agent_wake']);
  assert.equal(parsed.evidence[0].from, undefined);
  assert.deepEqual(parsed.evidence[1].from, { sourceSessionId: 'peer-source', runId: 'run-1', nodeId: 'node-1' });
});
test('Goal中引用其它标题时原话证据仍在Goal,严格核验来源不放宽', () => {
  const source = s.summaryTaskSourceHistory([{ role: 'user', content: 'TASK-MID-REPORT remains unfinished.' }]);
  const summary = '【目标】\n只引用标题:【已确认的决定】【未完成事项】【当前执行状态】【关键文件与上下文】\n<task-evidence>[{"source":1,"quote":"TASK-MID-REPORT remains unfinished."},{"source":1,"quote":"invented"}]</task-evidence>\n【已确认的决定】决定\n【未完成事项】仍未完成\n【当前执行状态】正在进行\n【关键文件与上下文】文件';
  const parsed = s.extractSummaryTaskEvidence(summary, source.sources, Object.assign(source.messages, { summarySources: [1] }));
  assert.equal(parsed.evidence.length, 1);
  assert.equal(parsed.rejected, 1);
  assert.equal(parsed.evidence[0].quote, 'TASK-MID-REPORT remains unfinished.');
});

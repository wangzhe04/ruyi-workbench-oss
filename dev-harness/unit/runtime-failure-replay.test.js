'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replayFailureEvents } = require('../runtime-failure-replay');

test('F1 replay joins by session/tool call and emits aggregates only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-f1-replay-'));
  try {
    fs.mkdirSync(path.join(root, 'logs'));
    fs.mkdirSync(path.join(root, 'sessions'));
    const event = { kind: 'runtime_failure_classified', sessionId: 'sess_a', toolCallId: 'call_a', toolName: 'script_run', tier: 'exec', disposition: 'executed', failureClass: 'unknown' };
    fs.writeFileSync(path.join(root, 'logs', 'workbench-2026-08-17.ndjson'), JSON.stringify(event) + '\n');
    const secretError = 'Traceback at C:\\private\\project\\secret.py';
    fs.writeFileSync(path.join(root, 'sessions', 'sess_a.provider.ndjson'), JSON.stringify({ role: 'tool', tool_call_id: 'call_a', content: JSON.stringify({ ok: false, code: 1, stderr: secretError }) }) + '\n');
    const report = replayFailureEvents(root, () => ({ classifierVersion: 'deterministic-v2', failureClass: 'execution_failed', allowedRepair: 'inspect_error_then_modify', tier: 'exec' }));
    assert.equal(report.totalEvents, 1);
    assert.equal(report.matchedEvents, 1);
    assert.deepEqual(report.afterByClass, [{ name: 'execution_failed', count: 1 }]);
    assert.equal(report.safety.pass, true);
    assert.equal(JSON.stringify(report).includes(secretError), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

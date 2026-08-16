'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeFailureEvents } = require('../runtime-failure-report');

function row(failureClass, recoverableHint, extra) {
  return { kind: 'runtime_failure_classified', failureClass, recoverableHint, deterministic: true, toolName: 'file_read', tier: 'read', ...(extra || {}) };
}

test('20-F1 report holds the gate below 30 samples', () => {
  const report = summarizeFailureEvents(Array.from({ length: 29 }, () => row('transient_read', true)));
  assert.equal(report.gate.pass, false);
  assert.equal(report.gate.recommendation, 'collect_more');
});

test('20-F1 report passes only with enough deterministic recoverable failures', () => {
  const events = [
    ...Array.from({ length: 6 }, () => row('invalid_arguments', true)),
    ...Array.from({ length: 24 }, () => row('permission_denied', false)),
  ];
  const report = summarizeFailureEvents(events);
  assert.equal(report.sampleSize, 30);
  assert.equal(report.recoverableRate, 0.2);
  assert.equal(report.gate.pass, true);
  assert.equal(report.gate.recommendation, 'implement_bounded_recovery');
});

test('20-F1 report excludes unrelated log records and surfaces unsafe side effects', () => {
  const report = summarizeFailureEvents([
    { kind: 'turn_end' },
    row('side_effect_unknown', false, { toolName: 'powershell_run', tier: 'exec' }),
  ]);
  assert.equal(report.sampleSize, 1);
  assert.equal(report.sideEffectUnknownCount, 1);
  assert.equal(report.byTool[0].name, 'powershell_run');
});

test('20-F1 report gates only the newest classifier cohort', () => {
  const events = [
    ...Array.from({ length: 31 }, () => row('unknown', false)),
    ...Array.from({ length: 4 }, () => row('execution_failed', true, { classifierVersion: 'deterministic-v2', toolName: 'script_run', tier: 'exec' })),
  ];
  const report = summarizeFailureEvents(events);
  assert.equal(report.schema, 2);
  assert.equal(report.totalSampleSize, 35);
  assert.equal(report.classifierVersion, 'deterministic-v2');
  assert.equal(report.sampleSize, 4);
  assert.equal(report.excludedOlderSampleSize, 31);
  assert.equal(report.gate.recommendation, 'collect_more');
  assert.deepEqual(report.byClass, [{ name: 'execution_failed', count: 4 }]);
});

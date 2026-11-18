'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { businessAssertions, guardLifecycles } = require('./business-policy.cjs');

const group = 'external-bots-group-decisions.e2e.js';
const human = 'external-bots-human-decisions.e2e.js';
const names = ['permission/allow', 'permission/deny', 'question/answer', 'plan/approve',
  'plan/reject', 'pool/approve', 'pool/reject', 'replan/approve', 'replan/reject'];
const closed = { status: 'known-held-actors-closed' };
const completed = names.map(name => { const [type, action] = name.split('/'); return { type, action }; });
const stdout = names.map(name => 'PASS ' + name + ': actual HTTP/callback/original consumer/terminal once')
  .concat('EXTERNAL BOTS C2 ACTUAL HTTP E2E: ALL PASS').join('\n');
const report = {
  status: 'passed-selected-journeys-and-known-cleanup', browser: false, cleanup: closed, diagnosticErrors: [],
  selectedJourneys: { status: 'completed', requested: 9, completed },
  cases: completed.map(row => ({ ...row, business: 'completed', cleanup: closed })),
};

test('human business-only requires the nine ordered outcomes and fixture closures', () => {
  assert.equal(businessAssertions(human, stdout, report), true);
  assert.equal(businessAssertions(human, stdout.split('\n').slice(1).join('\n'), report), false);
  assert.equal(businessAssertions(human, stdout + '\nFAIL unresolved case', report), false);
  assert.equal(businessAssertions(human, stdout, { ...report, cases: report.cases.slice(0, 8) }), false);
  const bad = structuredClone(report);
  bad.cases[8].cleanup.status = 'unknown';
  assert.equal(businessAssertions(human, stdout, bad), false);
});

test('group needs all four assertions and the final success marker', () => {
  const full = ['PASS qq: signed group owner reaches the worker and fails closed before message dispatch',
    'PASS feishu: signed group owner reaches the worker and fails closed before message dispatch',
    'PASS the same original live permission is offerable to its direct owner and remains unapplied',
    'PASS original fixture child and loopback listeners closed', 'EXTERNAL BOTS GROUP DECISIONS E2E: ALL PASS'];
  assert.equal(businessAssertions(group, full.join('\n')), true);
  assert.equal(businessAssertions(group, full.filter((_, i) => i !== 3).join('\n')), false);
  assert.equal(businessAssertions(group, full.slice(0, -1).join('\n')), false);
});

function lifecycles(count) {
  const server = [], flush = [];
  for (let i = 0; i < count; i++) {
    const pid = 10 + i, base = 100 + i * 100;
    const recorded = (kind, at) => ({ schema: 1, kind, at, pid, parentPid: 2 });
    server.push(recorded('guard-issued-server', base), { ...recorded('guard-server-close', base + 30),
      processError: false, exit: { code: null, signal: 'SIGTERM', at: base + 20 }, close: { code: null, signal: 'SIGTERM' } });
    const helper = (kind, at) => ({ schema: 1, kind, at, pid: pid + 30, parentPid: pid, signal: null, code: 0 });
    flush.push({ ...helper('spawn', base + 5), inputAccepted: true }, helper('exit', base + 10), helper('close', base + 10));
  }
  return { server, flush };
}

test('fixture guard cannot substitute a partial run, bad exit or unowned flush', () => {
  const { server, flush } = lifecycles(9);
  assert.equal(guardLifecycles(human, server, flush, 2), true);
  assert.equal(guardLifecycles(human, server.slice(0, -2), flush, 2), false);
  assert.equal(guardLifecycles(human, server, flush.slice(0, -3), 2), false);
  const noExit = structuredClone(server);
  delete noExit[1].exit;
  assert.equal(guardLifecycles(human, noExit, flush, 2), false);
  const failedExit = structuredClone(server);
  failedExit[1].exit.code = failedExit[1].close.code = 1;
  failedExit[1].exit.signal = failedExit[1].close.signal = null;
  assert.equal(guardLifecycles(human, failedExit, flush, 2), false);
  const denied = structuredClone(flush);
  denied[0].inputAccepted = false;
  assert.equal(guardLifecycles(human, server, denied, 2), false);
  const bad = structuredClone(flush);
  bad[1].code = bad[2].code = 1;
  assert.equal(guardLifecycles(human, server, bad, 2), false);
  const wrongOwner = structuredClone(flush);
  for (const row of wrongOwner.slice(0, 3)) row.parentPid = 9;
  assert.equal(guardLifecycles(human, server, wrongOwner, 2), false);
});

'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runs = fs.readFileSync(path.join(root, 'ruyi-workbench', 'app', 'src', '08-agent-runs.js'), 'utf8');
const workflow = fs.readFileSync(path.join(root, 'ruyi-workbench', 'app', 'src', '09-workflow.js'), 'utf8');
const provider = fs.readFileSync(path.join(root, 'ruyi-workbench', 'app', 'src', '06-provider-engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'ruyi-workbench', 'app', 'public', 'js', 'interaction-prompts.js'), 'utf8');

function ok(value, message) {
  if (!value) throw new Error(message);
  console.log('PASS', message);
}

ok(runs.includes("'deterministic_gap'"), 'M2 gaps are indexed as deterministic evidence');
ok(runs.includes("check: 'coverage_unhandled'"), 'coverage unhandled items use a typed check');
ok(runs.includes("check: 'propagate_unpropagated'"), 'propagate unpropagated items use a typed check');
ok(runs.includes("valueDigest: `sha256:${valueDigest}`"), 'raw gap values are replaced by digests');
ok(runs.includes("['tool_result', 'deterministic_gap']"), 'evidence catalog accepts deterministic gap events');
ok(!runs.includes('rawValue:'), 'evidence graph does not persist raw deterministic gap values');

ok(runs.includes('Math.min(1000, Math.max(1, Number(maxIters'), 'sub-agent request budget accepts up to 1000');
ok(runs.includes('budget = Math.min(adaptiveBudgetLimit, budget + TOOL_ITERATION_BUDGETS.extension)'), 'sub-agent grows budget in bounded increments');
ok(provider.includes('standardHard: 300, hard: 1000'), 'ordinary and complex hard caps remain distinct');
ok(provider.includes('hardLimit: elevated ? TOOL_ITERATION_BUDGETS.hard : TOOL_ITERATION_BUDGETS.standardHard'), '1000 cap requires elevated task complexity');
ok(workflow.includes('Math.min(1000, Math.max(1, Number(raw.maxIters'), 'workflow normalization preserves requested adaptive ceiling');

ok(ui.includes("syncAgentRunsPolling().then"), 'spawn workflow event refreshes persisted runs');
ok(ui.includes("wbSelectRun(String(evt.runId))"), 'spawn workflow event focuses child DAG after refresh');
console.log('C2 + SPAWN/BUDGET STATIC E2E: ALL PASS');

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const HOME = path.join(os.tmpdir(), `ruyi-agent-workflows-${process.pid}`);
const PROJECT = path.join(HOME, 'project');
process.env.RUYI_HOME = HOME;
const server = require('../ruyi-workbench/app/server.js');
let failures = 0;
const ok = (value, label) => { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

(async () => {
  fs.mkdirSync(PROJECT, { recursive: true });
  try {
    const initial = await server.getAgentWorkflows(PROJECT);
    ok(initial.some(x => x.id === 'debate-and-judge') && initial.some(x => x.id === 'implement-review-fix-test'), 'built-in debate and implementation templates are available');
    const builtInJudge = initial.find(x => x.id === 'debate-and-judge').nodes.find(x => x.id === 'judge');
    ok(builtInJudge.maxIters === undefined, 'built-in workflow nodes inherit role budgets instead of pinning the old maxIters=6 default');
    const personal = await server.saveAgentWorkflow('personal', PROJECT, { id: 'shared-flow', title: 'Personal flow', nodes: [{ id: 'one', task: 'personal', position: { x: 12, y: 34 } }] });
    ok(personal && personal.source === 'personal' && personal.nodes[0].position.x === 12, 'personal workflow and graph position are persisted');
    const migrated = await server.saveAgentWorkflow('personal', PROJECT, { id: 'legacy-budget-flow', title: 'Legacy budget flow', nodes: [{ id: 'review', task: 'legacy default', role: 'reviewer', maxIters: 6 }] });
    ok(migrated.nodes[0].maxIters === undefined, 'legacy saved maxIters=6 is treated as an inherited default');
    const capped = await server.saveAgentWorkflow('personal', PROJECT, { id: 'capped-budget-flow', title: 'Capped budget flow', nodes: [{ id: 'worker', task: 'explicit large budget', role: 'worker', maxIters: 250 }] });
    ok(capped.nodes[0].maxIters === 100, 'explicit workflow maxIters is capped at 100');
    await server.deleteAgentWorkflow('personal', PROJECT, 'legacy-budget-flow');
    await server.deleteAgentWorkflow('personal', PROJECT, 'capped-budget-flow');
    const project = await server.saveAgentWorkflow('project', PROJECT, { id: 'shared-flow', title: 'Project flow', nodes: [{ id: 'one', task: 'project' }, { id: 'two', task: 'conditional', dependsOn: ['one'], condition: { node: 'one', path: 'verdict', operator: 'equals', value: 'pass' }, loop: { maxIterations: 4, noProgressLimit: 2 } }] });
    const merged = await server.getAgentWorkflows(PROJECT); const shared = merged.find(x => x.id === 'shared-flow');
    ok(project && shared.source === 'project' && shared.title === 'Project flow', 'project workflow overrides a personal workflow with the same id');
    ok(shared.nodes[1].condition.operator === 'equals' && shared.nodes[1].loop.maxIterations === 4, 'conditions and loop policy survive normalization and storage');
    ok(server.evaluateWorkflowCondition(shared.nodes[1].condition, [{ id: 'one', structuredResult: { verdict: 'pass' } }], shared.nodes[1]), 'stored condition evaluates against structured predecessor output');
    await server.deleteAgentWorkflow('project', PROJECT, 'shared-flow');
    const fallback = (await server.getAgentWorkflows(PROJECT)).find(x => x.id === 'shared-flow');
    ok(fallback && fallback.source === 'personal', 'deleting project override reveals the personal workflow');
    await server.deleteAgentWorkflow('personal', PROJECT, 'shared-flow');
    ok(!(await server.getAgentWorkflows(PROJECT)).some(x => x.id === 'shared-flow'), 'personal workflow can be deleted without affecting built-ins');
  } finally { fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nAGENT WORKFLOW TEMPLATES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

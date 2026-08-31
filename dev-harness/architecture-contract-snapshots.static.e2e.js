#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
function ok(value, label) { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } }
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const check = cp.spawnSync(process.execPath, [path.join(__dirname, 'architecture-contract-snapshots.js')], { cwd: ROOT, encoding: 'utf8' });
ok(check.status === 0, 'contract snapshot generator is current');
const manifest = JSON.parse(read('ruyi-workbench/app/src/manifest.json'));
const files = manifest.modules.map(item => item.file);
for (const file of ['04-visual-pipeline.js', '04-desktop-shell.js', '06d-memory-domain.js', '06e-mission-domain.js', '06f-autonomy-grants.js', '06g-resource-leases.js']) {
  ok(files.includes(file), `${file} is a physical build module`);
}
const permission = read('ruyi-workbench/app/src/04-permission-runtime.js');
const context = read('ruyi-workbench/app/src/10-context-governance.js');
const autonomy = read('ruyi-workbench/app/src/07-autonomy.js');
ok(!permission.includes('function buildUserContentParts(') && !permission.includes('function pruneOldImages('), 'permission runtime no longer owns visual pipeline');
ok(!context.includes('function runProcess(') && !context.includes('function pickFolder(') && !context.includes('function runMissionDriver('), 'context owner no longer contains desktop shell or mission driver');
ok(!autonomy.includes('function saveMemory(') && !autonomy.includes('function consumeGrant(') && !autonomy.includes('function acquireResourceLease('), 'autonomy core no longer owns memory, grants, or leases');
ok(context.includes('const CompactionPlan = (() => {'), 'context cluster owns shared CompactionPlan');
ok(read('ruyi-workbench/app/src/08-agent-runs.js').includes("trigger: 'forced_400'"), 'subagent forced-400 uses CompactionPlan');
ok(read('ruyi-workbench/app/src/09-workflow.js').includes("trigger: 'forced_400'"), 'main forced-400 uses CompactionPlan');
ok(context.includes("require(path.join(__dirname, 'src', 'context-governance-rules.json'))"), 'versioned context rules are runtime-authoritative');
process.exitCode = failures ? 1 : 0;

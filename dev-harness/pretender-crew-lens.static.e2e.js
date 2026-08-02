#!/usr/bin/env node
'use strict';

// Wave 82 static contract: the Preview crew lens is a direct Mission/Run projection, renders dependency
// stages + pool proposals, and delegates steering/approval to the already-authoritative action paths.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const backend = read('ruyi-workbench/app/src/13d-core-domain-routes.js');
const shell = read('ruyi-workbench/app/public/js/preview-shell.js');
const app = read('ruyi-workbench/app/public/app.js');
const css = read('ruyi-workbench/app/public/css/views/preview-shell.css');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};

const graphProjection = (backend.match(/function missionRunGraph\([\s\S]*?\n}\n\n\/\/ run 摘要投影/) || [])[0] || '';
ok(graphProjection.includes('nodeDeliveryEligibility(src') && graphProjection.includes("steerReason: String(eligibility.reason")
  && graphProjection.includes(".filter(item => item && item.status === 'proposed')"),
  'A1 Mission detail derives node steering eligibility and proposed pool ghosts from the live authoritative Run');
for (const field of ['roleLabel', 'task', 'dependsOn', 'engine', 'progress', 'fromPool', 'proposedBy']) {
  ok(graphProjection.includes(field + ':'), `A2 compact crew node projection carries ${field}`);
}
ok(!/result\s*:|roleSnapshot\s*:|toolEvidence\s*:|progressLog\s*:/.test(graphProjection),
  'A3 compact graph projection does not copy large result/role/tool/progress history payloads');
ok(backend.includes('missionRunDigest(run, true, index < 6)') && backend.includes('runs.map((run, index)'),
  'A4 only the six newest Run digests carry graph detail; mission list/index remain scalar');

ok(shell.includes('function crewDepths(nodes)') && shell.includes('dependsOn') && shell.includes('dataset.crewDepth'),
  'B1 crew stages are computed from projected dependency facts with a cycle guard');
ok(shell.includes('function foremanBrief(run, nodes)') && shell.includes("t('previewShell.crewForemanBrief'")
  && !/fetch\(|\/api\/agent-runs\/[^'`]+\/events/.test(shell),
  'B2 the foreman sentence is a deterministic local fold and the lens opens no second Run event feed');
ok(shell.includes("proposal: true, depth: baseDepth + 1") && shell.includes("dataset.interventionId")
  && shell.includes('setNeedsDrawer(true, { interventionId: pending.id })'),
  'B3 a proposed pool item is a dotted next-stage node that opens the existing global decision drawer');
ok(shell.includes('steerAgentNode({ sessionId: selectedSessionId()')
  && app.includes("action: 'steer_node'") && app.includes('sessionId, action: \'steer_node\'')
  && app.includes('steerAgentNode: request => steerPreviewAgentNode(request)'),
  'B4 Pass a note uses the selected Mission session and delegates to the existing steer_node action');
ok(shell.includes('/interventions/${encodeURIComponent(id)}/decision')
  && shell.includes('async function performRunControl(run, action)')
  && shell.includes('/api/agent-runs/${encodeURIComponent(run.id)}')
  && shell.includes("scopeChip('run')"),
  'B5 crew steering stays injected; Wave 84 Run controls use the existing scoped Run command');
ok(shell.includes('crewDrafts.set(key, value)') && shell.includes("crewDeliveryState.set(key, { type: 'error'")
  && shell.includes("if (!(result && result.ok))"),
  'B6 a failed note preserves the draft and restores focus instead of claiming delivery');

for (const selector of ['.preview-crew-lens', '.preview-crew-stage', '.preview-crew-member', '.preview-crew-handoff']) {
  ok(css.includes(selector), `C1 ${selector} has owned Preview styling`);
}
ok(css.includes('.preview-crew-member.is-proposal') && css.includes('border-style: dashed')
  && css.includes('border-radius: 24px 10px 24px 24px'),
  'C2 crew members avoid square cards and proposed work is visibly dashed/gold-tokened');
ok(/@media \(max-width: 620px\)[\s\S]*\.preview-crew-stage \{[^}]*grid-auto-flow: row/.test(css)
  && /\.preview-crew-stage \{[^}]*min-width: 0/.test(css.slice(css.indexOf('@media (max-width: 620px)'))),
  'C3 the 390px crew graph becomes a bounded vertical work-stage flow');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'C4 Wave 82 styling uses existing semantic/theme tokens only');

const crewZh = Object.keys(zh).filter(key => key.startsWith('previewShell.crew')).sort();
const crewEn = Object.keys(en).filter(key => key.startsWith('previewShell.crew')).sort();
ok(crewZh.length >= 30 && JSON.stringify(crewZh) === JSON.stringify(crewEn),
  `D1 crew lens catalog is symmetric in Chinese and English (${crewZh.length})`);
ok(/工头/.test(zh['previewShell.crewForemanBrief']) && /Foreman/.test(en['previewShell.crewForemanBrief'])
  && /不能|不经过/.test(Object.values(zh).filter(value => typeof value === 'string' && value.includes('递话')).join(' ')),
  'D2 both catalogs include the foreman voice and honest steering limits');

console.log(`\nPRETENDER CREW LENS STATIC E2E: ${failures ? `FAIL (${failures})` : 'ALL PASS'}`);
process.exitCode = failures ? 1 : 0;

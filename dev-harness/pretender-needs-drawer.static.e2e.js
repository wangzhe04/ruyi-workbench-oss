#!/usr/bin/env node
'use strict';

// Wave 81 structural gate: the Preview inbox remains a client of the unified intervention command,
// approvals are fail-closed, and cross-shell retirement has one explicit bridge.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
const shell = read('ruyi-workbench/app/public/js/preview-shell.js');
const app = read('ruyi-workbench/app/public/app.js');
const prompts = read('ruyi-workbench/app/public/js/interaction-prompts.js');
const tools = read('ruyi-workbench/app/public/js/tool-runtime.js');
const domain = read('ruyi-workbench/app/src/13d-core-domain-routes.js');
const autonomy = read('ruyi-workbench/app/src/07-autonomy.js');
const html = read('ruyi-workbench/app/public/index.html');
const css = read('ruyi-workbench/app/public/css/views/preview-shell.css');
const browser = read('dev-harness/pretender-needs-drawer.e2e.js');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

ok(html.includes('id="previewNeedsDrawer"') && html.includes('aria-haspopup="dialog"')
  && shell.includes("api('/api/interventions?limit=100')") && shell.includes('pendingInterventions'),
  'A1 the top desk fact opens one global, paged Needs-you drawer');
ok(domain.includes('interventionVersion: Math.max(0, Number(iv.interventionVersion) || 0)')
  && domain.includes("input: iv.type === 'permission'") && domain.includes('deliverable:')
  && autonomy.includes("registerIntervention(sessionId, 'permission'") && autonomy.includes("input: input && typeof input === 'object'"),
  'A2 inbox projection carries CAS version, concrete permission scope, and live deliverability');
ok(shell.includes('/api/missions/${encodeURIComponent(item.missionId)}/interventions/${encodeURIComponent(id)}/decision')
  && !shell.includes("'/api/permission/decision'") && !shell.includes("'/api/chat/answer'") && !shell.includes("'/api/plan/decision'"),
  'A3 Preview writes only through the Wave 75b unified command route');

ok(shell.includes("{ action: 'allow' }, { confirm: true }")
  && shell.includes("{ action: 'approve'" ) && shell.includes("{ confirm: true }")
  && shell.includes("confirm.setAttribute('role', 'alertdialog')")
  && shell.includes('system never approves by default') === false,
  'B1 allow/approve actions stage an inline second confirmation without a default approval path');
ok(!/\.checked\s*=\s*true/.test(shell)
  && shell.includes("field.querySelectorAll('[data-option-id]:checked')")
  && browser.includes("questionCard.checked === 0"),
  'B2 typed question controls never preselect an option and the browser gate proves it');
ok(shell.includes('retry.dataset.retrySameKey = draft.request.idempotencyKey')
  && shell.includes('submitInterventionDecision(item, draft.request)')
  && shell.includes('idempotencyKey: request.idempotencyKey'),
  'B3 network retry reuses the exact request and idempotency key');

ok(prompts.includes('function resolveClassicPromptIntervention')
  && prompts.includes('backdrop.__close = () => finish(false)')
  && tools.includes('function resolveClassicPlanIntervention')
  && app.includes('syncClassicIntervention: async decision =>')
  && app.includes('resolveClassicPromptIntervention(decision)')
  && app.includes('resolveClassicPlanIntervention(decision)'),
  'C1 a successful Preview decision retires classic question, permission, and plan surfaces without firing cancel');
ok(shell.includes('function renderStopCard') && shell.includes("result.status !== 'stopped'")
  && shell.includes('stopRetryDraft') && shell.includes('stopChangeDraft')
  && shell.includes("updateMissionUi(card.missionId, { archived: true })"),
  'C2 stopped Missions expose retry/change/archive hand-offs without inventing a resume state machine');
ok(css.includes('.preview-needs-drawer') && css.includes('.preview-decision-confirm')
  && css.includes('.preview-stop-card') && css.includes('width: calc(100vw - 52px)')
  && browser.includes('Emulation.setDeviceMetricsOverride') && browser.includes('width: 390'),
  'C3 drawer, confirmation, and stop card have a real 390px responsive walkthrough');

ok(Object.keys(zh).filter(key => key.startsWith('previewShell.')).sort().join('\n')
  === Object.keys(en).filter(key => key.startsWith('previewShell.')).sort().join('\n'),
  'D1 Wave 81 Preview catalog remains symmetric in Chinese and English');
ok(['previewShell.needsDrawerTitle', 'previewShell.confirmApprovalTitle', 'previewShell.stopCardTitle', 'previewShell.retrySameDecision']
  .every(key => zh[key] && en[key]),
  'D2 both locales cover the decision drawer, confirmation, stop card, and stable retry');

console.log(`\nPRETENDER NEEDS DRAWER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;

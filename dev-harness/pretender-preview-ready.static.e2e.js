#!/usr/bin/env node
'use strict';

// Wave 80 public-preview static gate: recoverable dual shells, C1 budgets, manuals, and frozen naming.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, ...relative.split('/')), 'utf8');
const shell = read('ruyi-workbench/app/public/js/preview-shell.js');
const app = read('ruyi-workbench/app/public/app.js');
const css = read('ruyi-workbench/app/public/css/views/preview-shell.css');
const perf = read('dev-harness/pretender-preview-performance.e2e.js');
const browser = read('dev-harness/pretender-shell.e2e.js');
const taskSheet = read('dev-harness/pretender-task-sheet.e2e.js');
const indexSource = read('ruyi-workbench/app/src/13e-pretender-index.js');
const routerSource = read('ruyi-workbench/app/src/13-http-router.js');
const cnGuide = read('ruyi-workbench/docs/manuals/USER-GUIDE_CN.md');
const enGuide = read('ruyi-workbench/docs/manuals/USER-GUIDE_EN.md');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

ok(shell.includes("localStorage.setItem(SHELL_MODE_STORAGE_KEY, 'classic')")
  && shell.includes("document.documentElement.setAttribute('data-shell-mode', 'classic')")
  && /if \(!missionState[\s\S]{0,260}recoverClassicShell\(\)/.test(shell),
  'A1 missing Preview dependency fails closed to a persisted classic layout');
ok(shell.includes("classic.id = 'previewErrorClassicBtn'")
  && shell.includes("retry.id = 'previewErrorRetryBtn'")
  && browser.includes("Network.setBlockedURLs")
  && browser.includes("previewErrorClassicBtn"),
  'A2 projection failure exposes retry + classic recovery and is covered in a real browser');
ok(shell.includes('let renderedDockSignature')
  && shell.includes('signature !== renderedDockSignature')
  && shell.includes('PREVIEW_DOCK_INITIAL_RENDER = 40')
  && shell.includes('requestAnimationFrame(() => appendChunk(end))')
  && shell.includes("list.querySelectorAll('.preview-seal')"),
  'A3 unchanged task dock keeps DOM; cold 200-card paint is incrementally chunked');
ok(/const previewFirst[\s\S]{0,420}if \(previewFirst\) \{[\s\S]{0,220}await refreshPreviewShell\(\);[\s\S]{0,220}await refreshSessions\(\);/.test(app)
  && app.includes('if (!previewFirst) {'),
  'A4 Preview paints before hidden classic hydration while classic keeps its original boot path');
ok(/@media \(max-width: 620px\)[\s\S]*\.preview-seal \{ width: 48px/.test(css)
  && /\.preview-dock-action \{ width: 46px/.test(css),
  'A5 narrow task dock keeps seals and recovery controls inside the 52px rail');

ok(perf.includes('SESSION_COUNT = 300') && perf.includes('VISIBLE_CARD_COUNT = 200'),
  'B1 Preview C1 browser gate uses the 75c 300-Mission dataset and 200 visible cards');
ok(indexSource.includes('async function warmPretenderProjectionIndex()')
  && indexSource.includes("if (!files.some(file => /^sess_")
  && /markInterruptedInterventions\(\);[\s\S]{0,420}void warmPretenderProjectionIndex\(\)\.catch/.test(routerSource)
  && !routerSource.includes('await pretenderWarm;'),
  'B2 existing Mission projections warm without delaying listen; empty imports stay discoverable');
ok(perf.includes('STARTUP_BUDGET_MS = 1500')
  && perf.includes('VIEW_SWITCH_P95_BUDGET_MS = 200')
  && perf.includes('STARTUP_RUNS = 3')
  && perf.includes('SWITCH_SAMPLES = 30'),
  'B3 Preview C1 budgets freeze first-interactive <1.5s and view-switch P95 <200ms');
ok(perf.includes('1440, height: 1000') && perf.includes('768, height: 1024') && perf.includes('390, height: 844'),
  'B4 public-preview walkthrough covers desktop, tablet, and narrow layouts');
ok(taskSheet.includes('event-loop max gap stays <750ms') && taskSheet.includes('__wave77Gaps')
  && shell.includes('function appendPreviewLiveText'),
  'B5 incremental long-output rendering remains under the existing real-stream hard gate');

for (const [label, guide, phrases] of [
  ['CN', cnGuide, ['任务台布局', '不是数据迁移', '返回经典布局', '已读位置']],
  ['EN', enGuide, ['Task desk layout', 'not a data migration', 'Return to classic layout', 'read position']],
]) {
  ok(phrases.every(phrase => guide.includes(phrase)), `C ${label} user guide explains switching, recovery, and local UI-state`);
}

const forbidden = text => /Pretender/i.test(text) || /(?:^|[^\d.])3\.0(?:[^\d.]|$)/m.test(text);
const releaseSurfaces = [
  read('README.md'),
  read('CHANGELOG.md'),
  read('ruyi-workbench/README.md'),
  cnGuide,
  enGuide,
  read('ruyi-workbench/app/public/index.html'),
  JSON.stringify(Object.values(zh)),
  JSON.stringify(Object.values(en)),
];
ok(releaseSurfaces.every(text => !forbidden(text)),
  'D1 UI, manuals, README, and changelog do not expose the internal codename or reserved major version');
ok(Object.keys(zh).filter(key => key.startsWith('previewShell.')).sort().join('\n')
  === Object.keys(en).filter(key => key.startsWith('previewShell.')).sort().join('\n'),
  'D2 Preview recovery catalog remains symmetric in Chinese and English');

console.log(`\nPRETENDER PREVIEW READY STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;

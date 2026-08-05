#!/usr/bin/env node
'use strict';

// 第79波静态契约：变更流水、独立本机已读状态、确定性回来摘要与任务档案。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(file, 'utf8');
const store = read(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '02-session-store.js'));
const routes = read(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '13d-core-domain-routes.js'));
const missionRoutes = read(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '13-http-router.js'));
const shell = read(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'preview-shell.js'));
const css = read(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'css', 'views', 'preview-shell.css'));
const html = read(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'index.html'));
const zh = JSON.parse(read(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json')));
const en = JSON.parse(read(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'locales', 'en-US.json')));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const types = ['mission_started', 'progress', 'failure', 'budget', 'intervention_pending',
  'intervention_resolved', 'result', 'rewind', 'run_deleted'];
ok(store.includes('`${sessionId}.changes.ndjson`') && store.includes("schemaVersion: 1"), 'A1 每 Mission 独立 append-only change journal');
for (const type of types) ok(store.includes(`'${type}'`) || missionRoutes.includes(`'${type}'`) || routes.includes(`'${type}'`), `A2 变更类型 ${type} 有生产路径`);
ok(store.includes('repairMissionChangeTornTail') && store.includes('foldMissionChangeJournalText'), 'A3 撕裂尾修复与确定性 fold 同源');
ok(store.includes('actual !== expected') && store.includes('lastRevision < current'), 'A4 内部缺号与尾部缺号均显式检测');
ok(routes.includes("pathname) {") && routes.includes("/changes$/.test(pathname)")
  && routes.includes('records.filter(record => Number(record.seq) > after'), 'A5 changes API 严格返回 (after,currentRevision]');
ok(routes.includes('degraded,') && routes.includes('gap: gap || null') && routes.includes('corruptLines'), 'A6 API 携带 degraded/gap/integrity 证据');

ok(shell.includes("PREVIEW_UI_STATE_STORAGE_KEY = 'wcw.previewUiState.v1'") && shell.includes('lastSeenRevision'), 'B1 lastSeen 位于独立本机 UI-state store');
ok(!/session\.(?:lastSeenRevision|pinnedArchive)|mission\.(?:lastSeenRevision|archived)/.test(shell), 'B2 Preview 不把已读/归档写回 Session 或 Mission');
const renderAt = shell.indexOf('renderTaskSheet(card);', shell.indexOf('async function refreshSelectedMission'));
const frameAt = shell.indexOf('requestAnimationFrame(() => resolve())', renderAt);
const seenAt = shell.indexOf('lastSeenRevision:', frameAt);
ok(renderAt >= 0 && frameAt > renderAt && seenAt > frameAt, 'B3 先渲染任务单，再过一帧推进 lastSeen');
ok(shell.includes('if (!changeResponse?.degraded && rendered && rendered.isConnected)'), 'B4 fetch/gap/不完整 DOM 均不会推进已读');
ok(shell.includes('JSON.stringify(record.cursor || {})') && shell.includes('item.dataset.changeSeq'), 'B5 每条摘要保留原始 source cursor 与 seq');
ok(!/fetch\([^)]*(?:summar|model)/i.test(shell), 'B6 回来摘要零模型调用');

ok(html.includes('id="previewArchiveBtn"') && shell.includes("activeView = 'archive'"), 'C1 任务坞有档案入口与独立主视图');
for (const token of ['previewArchiveSearch', "['all', 'done', 'stopped', 'pinned', 'archived']", "['workspace', 'state']", 'updateMissionUi']) {
  ok(shell.includes(token), `C2 档案操作 ${token} 已接线`);
}
ok(shell.includes('renderDock(); renderHome();') && shell.includes('ui.pinned ? 1 : 0')
  && !shell.includes("dockActions.setAttribute('aria-hidden', 'true')")
  && !shell.includes("quick.setAttribute('aria-hidden', 'true')"),
  'C2b 快捷归档/置顶同步任务坞缓存，且不会把可聚焦按钮藏出无障碍树');
ok(shell.includes("['done', 'stopped'].includes") && shell.includes('preview-archive-group'), 'C3 档案只消费终态任务并稳定分组');
ok(css.includes('.preview-return-summary') && css.includes('.preview-archive-ledger') && css.includes('@media (max-width: 620px)'), 'C4 摘要/档案/手机响应式样式齐备');
ok(zh['previewShell.returnTitle'] && en['previewShell.returnTitle'] && zh['previewShell.archiveTitle'] && en['previewShell.archiveTitle'], 'C5 中英文摘要与档案文案齐备');

console.log(`\nPRETENDER RETURN/ARCHIVE STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;

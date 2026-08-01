#!/usr/bin/env node
'use strict';

// 第83波系统门：纯叙事折算 + 本地通知生命周期 + 前端接线契约。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const Narrative = require(path.join(PUBLIC, 'js', 'preview-narrative.js'));
const Notices = require(path.join(PUBLIC, 'js', 'preview-notifications.js'));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const records = Narrative.CHANGE_TYPES.map((type, index) => ({
  seq: index + 1,
  type,
  occurredAt: `2026-08-01T0${index}:00:00.000Z`,
  cursor: { source: type, turnSeq: index + 1 },
  detail: { ordinal: index + 1 },
}));
const folded = Narrative.appendNarrativeEntries([], records);
ok(folded.entries.length === 9 && folded.added.length === 9 && folded.lastSeq === 9,
  'A1 all nine journal types fold into ordered narrative entries');
ok(folded.entries.every((entry, index) => entry.seq === index + 1 && entry.type === records[index].type
  && entry.cursor.source === records[index].type && entry.sentenceKey),
  'A2 every sentence retains type, sequence, source cursor, facts, and a deterministic sentence key');
const firstIdentity = folded.entries[0];
const increment = Narrative.appendNarrativeEntries(folded.entries, [records[4], {
  seq: 10, type: 'progress', cursor: { engine: 'openai', turnSeq: 7 }, detail: { filesChanged: 2 },
}]);
ok(increment.entries.length === 10 && increment.added.length === 1 && increment.entries[0] === firstIdentity,
  'A3 incremental append transforms only unseen records and reuses existing entry identity');
ok(increment.entries[9].sentenceKey === 'progress_turn' && Object.isFrozen(increment.entries[9])
  && Object.isFrozen(increment.entries[9].cursor) && Object.isFrozen(increment.entries[9].detail),
  'A4 semantic entries are immutable and progress variants are derived without model text');

const defaults = Notices.normalizeNotificationSettings(null);
ok(defaults.enabled === false && defaults.quietStart === '22:00' && defaults.quietEnd === '08:00',
  'B1 notification feature flag is off by default with an explicit overnight quiet window');
const at = (hour, minute) => new Date(2026, 7, 1, hour, minute, 0, 0);
ok(!Notices.isQuietTime(at(21, 59), defaults) && Notices.isQuietTime(at(22, 0), defaults)
  && Notices.isQuietTime(at(7, 59), defaults) && !Notices.isQuietTime(at(8, 0), defaults),
  'B2 quiet hours are start-inclusive/end-exclusive across midnight');
ok(!Notices.isQuietTime(at(9, 0), { quietStart: '09:00', quietEnd: '09:00' })
  && Notices.isQuietTime(at(12, 0), { quietStart: '09:00', quietEnd: '17:00' })
  && !Notices.isQuietTime(at(17, 0), { quietStart: '09:00', quietEnd: '17:00' }),
  'B3 equal clocks disable quiet hours and same-day boundaries remain deterministic');

let noticeState = {};
let transition = Notices.reconcileNeedsNotifications(noticeState, ['historical'], { enabled: true, permission: 'granted', quiet: false });
noticeState = transition.state;
ok(transition.notify.length === 0 && noticeState.primed && noticeState.known.includes('historical'),
  'C1 first successful read primes historical pending work without a restart notification burst');
transition = Notices.reconcileNeedsNotifications(noticeState, ['historical', 'fresh'], { enabled: true, permission: 'granted', quiet: false });
noticeState = transition.state;
ok(JSON.stringify(transition.notify) === JSON.stringify(['fresh']) && noticeState.active.includes('fresh'),
  'C2 a newly appearing Intervention emits exactly one notification');
transition = Notices.reconcileNeedsNotifications(noticeState, ['historical', 'fresh'], { enabled: true, permission: 'granted', quiet: false });
noticeState = transition.state;
ok(transition.notify.length === 0, 'C3 polling the same Intervention never emits a duplicate');
transition = Notices.reconcileNeedsNotifications(noticeState, ['historical'], { enabled: true, permission: 'granted', quiet: false });
noticeState = transition.state;
ok(transition.close.includes('fresh') && !noticeState.active.includes('fresh'),
  'C4 a terminal/disappeared Intervention withdraws its active system notification');
transition = Notices.reconcileNeedsNotifications(noticeState, ['historical', 'quiet-new'], { enabled: true, permission: 'granted', quiet: true });
noticeState = transition.state;
ok(transition.notify.length === 0 && noticeState.known.includes('quiet-new'),
  'C5 quiet-hour work is marked seen and is not queued for a delayed notification blast');
transition = Notices.reconcileNeedsNotifications(noticeState, ['historical', 'quiet-new'], { enabled: true, permission: 'granted', quiet: false });
ok(transition.notify.length === 0, 'C6 leaving quiet hours does not replay muted historical work');
const denied = Notices.reconcileNeedsNotifications(transition.state, ['historical', 'quiet-new', 'denied-new'], { enabled: true, permission: 'denied', quiet: false });
ok(denied.notify.length === 0 && denied.state.known.includes('denied-new'),
  'C7 denied browser permission never falls through to a notification attempt');
const restarted = Notices.reconcileNeedsNotifications({}, ['historical', 'quiet-new', 'denied-new'], { enabled: true, permission: 'granted', quiet: false });
ok(restarted.notify.length === 0, 'C8 an application restart rebuilds its baseline without replaying old decisions');

const shell = fs.readFileSync(path.join(PUBLIC, 'js', 'preview-shell.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'css', 'views', 'preview-shell.css'), 'utf8');
ok(/import '\.\/preview-narrative\.js'/.test(shell) && /appendNarrativeEntries\(feed\.entries, response\.changes\)/.test(shell)
  && /changes\?after=\$\{feed\.cursor\}/.test(shell) && /list\.appendChild\(fragment\)/.test(shell)
  && /feed\.entries\.length - 160/.test(shell) && /row\.remove\(\)/.test(shell),
  'D1 task detail fetches by cursor, appends unseen rows, and keeps the normal DOM window bounded');
ok(/text\('details', `preview-narrative-entry/.test(shell) && /preview-narrative-facts/.test(shell)
  && /JSON\.stringify\(entry\.cursor/.test(shell) && /JSON\.stringify\(entry\.detail/.test(shell),
  'D2 every narrative sentence expands to its original cursor and fact detail');
ok(/if \(selectedLens === 'raw'\) renderRawMessages\(\)/.test(shell)
  && /if \(selectedLens === 'raw'\) appendPreviewLiveText/.test(shell)
  && /if \(selectedLens === 'raw'\) ensurePreviewLiveRow/.test(shell),
  'D3 raw message DOM is lazy outside the expert lens instead of scaling with hidden history');
ok(/new notificationApi/.test(shell) && /tag: `ruyi-intervention-\$\{id\}`/.test(shell)
  && /requestPermission\(\)/.test(shell) && /permission !== 'granted'/.test(shell)
  && /closeNeedsNotification/.test(shell),
  'D4 browser/Windows adapter requests permission explicitly, tags by Intervention, and closes terminal notices');
ok(/cfgPreviewNotifications/.test(html) && /cfgPreviewQuietStart/.test(html) && /cfgPreviewQuietEnd/.test(html)
  && /type="time"/.test(html), 'D5 settings expose an off-by-default toggle and explicit quiet-hour controls');
ok(/\.preview-lens-switch/.test(css) && /\.preview-narrative-rail/.test(css)
  && /@media \(max-width: 620px\)[\s\S]*\.preview-narrative-summary/.test(css)
  && !/#(?:[0-9a-fA-F]{3}){1,2}\b/.test(css),
  'D6 duty-log visual language and 390px reflow use theme tokens without hard-coded color drift');

const publicZh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const publicEn = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'en-US.json'), 'utf8'));
const docsZh = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'), 'utf8'));
const docsEn = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'), 'utf8'));
const keys = Object.keys(publicZh).filter(key => key.startsWith('previewShell.narrative') || key.startsWith('previewShell.notification') || key.startsWith('previewShell.lens'));
ok(keys.length >= 50 && keys.every(key => publicEn[key] && docsZh[key] === publicZh[key] && docsEn[key] === publicEn[key]),
  'E1 narrative, notification, and lens copy is complete and mirrored in both locale catalogs');

console.log(`\nPRETENDER NARRATIVE/NOTIFICATIONS E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;

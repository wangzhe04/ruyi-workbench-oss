'use strict';
// The unfinished-turn banner must offer a real dismiss path and remember only the exact interrupted turn,
// so a later interruption in the same session is not accidentally hidden forever.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ui = read('ruyi-workbench/app/public/js/session-experience.js');
const css = read('ruyi-workbench/app/public/css/components/chat-composer.css');
const store = read('ruyi-workbench/app/src/02-session-store.js');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));
let fail = 0;
function ok(value, label) { if (value) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } }
ok(ui.includes("el('button', 'resume-banner-dismiss', '×')") && ui.includes("t('chat.resume.dismiss')"), 'unfinished banner renders an accessible dismiss control');
ok(ui.includes('wcw.resumeDismissed.${sessionId}') && ui.includes('localStorage.setItem(dismissKey, fingerprint)'), 'dismiss choice is remembered per session');
ok(ui.includes('Number(info.turnSeq)') && ui.includes('Number(info.historyLength)') && ui.includes('String(info.kind'), 'dismiss key fingerprints the exact interrupted turn');
ok(/turnSeq:[^\n]+historyLength/.test(store) && store.includes('...meta'), 'dangling-turn API exposes the fingerprint fields');
ok(css.includes('.resume-banner-dismiss') && css.includes(':focus-visible'), 'dismiss control has hover/focus styling');
ok(zh['chat.resume.dismiss'] === '关闭' && en['chat.resume.dismiss'] === 'Dismiss', 'dismiss label is localized');
console.log('\nRESUME BANNER DISMISS STATIC: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;

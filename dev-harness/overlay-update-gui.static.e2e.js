'use strict';
/*
 * 静态锁(第53波 EC-B 53d):更新中心 GUI 三件套 wiring -- index.html(页签+面板+按钮) /
 * settings-operations.js(overlay 函数族 + 按钮绑定) / app.js(组合根 + switchSettingsTab hook) /
 * locale(中英 i18n 键对等) /
 * 后端 pick-file 路由 + pickFile 函数。防 GUI 接线漂移(漏按钮/漏键/漏路由 -> 白屏或哑按钮)。
 *
 * Run: node dev-harness/overlay-update-gui.static.e2e.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
const operations = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'settings-operations.js'), 'utf8');
const navigation = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'navigation-controls.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'en-US.json'), 'utf8'));
const server = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');
const ctx = fs.readFileSync(path.join(WB, 'app', 'src', '10-context-governance.js'), 'utf8');
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

// ── index.html:页签 + 面板 + 按钮 ──
ok(html.includes('data-stab="update"'), 'G1 更新中心页签按钮在(index.html)');
ok(html.includes('id="stab-update"'), 'G2 stab-update 面板在');
const btns = ['ovPickBtn', 'ovPrecheckBtn', 'ovApplyBtn', 'ovRollbackBtn', 'ovRefreshBtn', 'ovForceChk'];
for (const b of btns) ok(html.includes(`id="${b}"`), `G3 ${b} 按钮在`);
const fields = ['ovCurrent', 'ovZipPath', 'ovPreviewBox', 'ovNew', 'ovOverw', 'ovUnch', 'ovDel', 'ovCompat', 'ovErrors', 'ovResultBox', 'ovResult', 'ovAudit', 'ovRollbackHint', 'ovPrecheckHint'];
let fieldsOk = true;
for (const f of fields) if (!html.includes(`id="${f}"`)) fieldsOk = false;
ok(fieldsOk, 'G4 预览/状态/结果/审计字段全在(14 个)');

// ── settings operations module + app.js composition root ──
const fns = ['refreshOverlayStatus', 'overlayPickZip', 'overlayPrecheck', 'overlayApply', 'overlayRollback'];
for (const f of fns) ok(operations.includes(`function ${f}(`) || operations.includes(`async function ${f}(`), `G5 ${f}() 在 settings-operations 模块`);
ok(appjs.includes("from './js/settings-operations.js'") && appjs.includes('createSettingsOperationsDomain')
  && appjs.includes('bindSettingsOperations();'), 'G5b app.js 仅保留模块组合与一次绑定');
ok(navigation.includes("if (name === 'update') refreshOverlayStatus();"), 'G6 switchSettingsTab update hook 在');
ok(/ovPickBtn.{0,100}onclick = overlayPickZip/.test(operations), 'G7 ovPickBtn 绑 overlayPickZip');
ok(/ovApplyBtn.{0,100}onclick = overlayApply/.test(operations), 'G8 ovApplyBtn 绑 overlayApply');
ok(/ovRollbackBtn.{0,100}onclick = overlayRollback/.test(operations), 'G9 ovRollbackBtn 绑 overlayRollback');
ok(operations.includes("'/api/overlay/precheck'") && operations.includes("'/api/overlay/apply'") && operations.includes("'/api/overlay/rollback'") && operations.includes("'/api/overlay/status'"), 'G10 operations 模块调四条 overlay API');
ok(operations.includes("'/api/pick-file'"), 'G11 operations 模块调 /api/pick-file(选 zip)');
ok(!/\.innerHTML\s*=/.test(operations) && operations.includes('function renderOverlayResult(')
  && operations.includes('audit.replaceChildren(fragment)'), 'G11b 运维模块零 innerHTML，更新审计/结果走安全 DOM');

// ── locale:中英对等 + 关键键 ──
const keys = ['settings.update', 'settings.update.current', 'settings.update.precheck', 'settings.update.apply', 'settings.update.rollback', 'settings.update.preview', 'settings.update.audit', 'settings.update.restartNeeded', 'settings.update.idempotent', 'settings.update.compatInfo'];
let keysOk = true;
for (const k of keys) { if (!zh[k] || !en[k]) { keysOk = false; console.error(`  missing key: ${k} zh=${!!zh[k]} en=${!!en[k]}`); } }
ok(keysOk, 'G12 中英 locale 含 10 个关键 settings.update.* 键且对等');
// 占位符契约:compatInfo 用 {{p1}}/{{p2}},backupsCount 用 {{p1}}
ok(zh['settings.update.compatInfo'].includes('{{p1}}') && zh['settings.update.compatInfo'].includes('{{p2}}'), 'G13 zh compatInfo 占位符 {{p1}}/{{p2}}');
ok(en['settings.update.compatInfo'].includes('{{p1}}') && en['settings.update.compatInfo'].includes('{{p2}}'), 'G14 en compatInfo 占位符 {{p1}}/{{p2}}');

// ── 后端:pick-file 路由 + pickFile 函数 + ROUTE_AUTH ──
ok(server.includes("'/api/pick-file'") && server.includes('async function pickFile('), 'G15 /api/pick-file 路由 + pickFile 函数入 bundle');
ok(ctx.includes('async function pickFile(') && ctx.includes('OpenFileDialog'), 'G16 pickFile 用 OpenFileDialog(选单文件)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

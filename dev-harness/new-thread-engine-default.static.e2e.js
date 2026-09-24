#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 静态锁(第 123 波 N2):「新线程默认引擎」这一项在设置面上【真的存在】,而且四份 locale 齐。
//
// 为什么单独一件而不是并进 ia.e2e:ia 那件要起服务(主序),这几条判据全是读文件,进 `--fast`
// 秒级就能兜住「HTML 加了控件却忘了回填/保存」与「加了 data-i18n 键却漏了某一份 locale」
// 这两类最常犯的漏。同名的运行时件 new-thread-engine-default.e2e.js 管行为那一半。
//
// 钉的是【哪件事必须成立】,不是【文本长什么样】(纪律 5):
//   ① #cfgNewThreadEngine 这枚 select 在设置面里,且恰好两个 option(last / global);
//   ② 前端两侧都接上了:回填(fillSettings 读 c.newThreadEngine)与保存(patch 里带这个键);
//   ③ 说明行走 textContent(零 innerHTML);
//   ④ 四份 locale(public / docs × zh-CN / en-US)逐份带齐五个键,且 lastIs 带 {{p1}} 占位符。
//
// 反向验证(实测,见提交说明):① 把 index.html 里那枚 select 的 id 改一个字母 → ①③ 红;
// ② 从 public/locales/en-US.json 删掉 settings.newThreadEngine.lastIs → ④ 红。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc } = require('./read-frontend-src.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const DOCS = path.join(ROOT, 'docs', 'i18n', 'locales');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const appjs = readFrontendSrc();

// ── ① 控件本体 ────────────────────────────────────────────────────────────────────────
const selectStart = html.indexOf('<select id="cfgNewThreadEngine">');
ok(selectStart >= 0, '① #cfgNewThreadEngine 这枚 select 存在');
const selectEnd = selectStart >= 0 ? html.indexOf('</select>', selectStart) : -1;
const selectBlock = selectStart >= 0 && selectEnd >= 0 ? html.slice(selectStart, selectEnd) : '';
const optionValues = [...selectBlock.matchAll(/<option value="([a-z]+)"/g)].map(m => m[1]);
ok(JSON.stringify(optionValues) === JSON.stringify(['last', 'global']),
  `① 恰好两个 option:last / global(got ${JSON.stringify(optionValues)})`);
ok(/<label for="cfgNewThreadEngine" data-i18n="settings\.newThreadEngine">/.test(html),
  '① 标签挂着 data-i18n="settings.newThreadEngine"');
ok(selectBlock.includes('data-i18n="settings.newThreadEngine.last"')
  && selectBlock.includes('data-i18n="settings.newThreadEngine.global"'),
  '① 两个 option 各自挂着自己的 i18n 键');
// 位置(W6 设置重组翻面重钉,用户 2026-09-24「把重复/类似的设置统一」):修前它与 #cfgAgentCliType 同住 Agent CLI 页,
// 而全局主端点在基础页 —— 「选引擎」一件事分三处。现在三处合一处:「用哪个命令行引擎」并进了主模型那枚下拉
// (#cfgMainProvider 里两个命令行引擎各是一项,#cfgAgentCliType 退役),「新线程默认引擎」紧跟在它下面,同住
// 「模型分配」页(#stab-models)。判据取「两枚 id 都在这一段里、且退役那枚全页不在」,不钉行号。
const modelsTabStart = html.indexOf('<div class="settings-tab" id="stab-models">');
const modelsTabEnd = html.indexOf('<div class="settings-tab"', modelsTabStart + 1);
const modelsTab = modelsTabStart >= 0 ? html.slice(modelsTabStart, modelsTabEnd > 0 ? modelsTabEnd : html.length) : '';
ok(modelsTab.includes('id="cfgMainProvider"') && modelsTab.includes('id="cfgNewThreadEngine"')
  && modelsTab.indexOf('id="cfgNewThreadEngine"') > modelsTab.indexOf('id="cfgMainProvider"')
  && !html.includes('id="cfgAgentCliType"'),
  '① 它紧跟主模型那一行、同住「模型分配」页(#stab-models);Agent CLI 驱动那枚选择器已并进主模型下拉');
ok(html.includes('id="newThreadEngineHint"'), '① 说明行的落点 #newThreadEngineHint 存在');

// ── ② 前端两侧都接上了 ────────────────────────────────────────────────────────────────
ok(/\$\('cfgNewThreadEngine'\)[\s\S]{0,200}c\.newThreadEngine/.test(appjs),
  '② 回填:fillSettings 把 config.newThreadEngine 写回这枚 select');
ok(/newThreadEngine:\s*\$\('cfgNewThreadEngine'\)/.test(appjs),
  '② 保存:设置表单的 patch 里带 newThreadEngine 这个键');
// W6:页脚整份保存退役,它改成「改了就存」—— 那条补丁构造器登记在即存表里、挂在这枚 select 的 id 上。
ok(/\{ ids: \['cfgNewThreadEngine'\], patch: \(\) => \(\{ newThreadEngine: \$\('cfgNewThreadEngine'\)/.test(appjs),
  '② 即存:INSTANT_SETTINGS 里有 cfgNewThreadEngine 那一条(选中即存,不再等页脚「保存」)');
// W6:命令行引擎合进主模型下拉之后,选它要一次写 activeProvider:'' ＋ agentCliType(不再有第二个写口)。
ok(/else \{ patch\.model = model; patch\.agentCliType = pick\.cli; \}/.test(appjs)
  && /lead: Object\.keys\(AGENT_CLI_LABELS\)\.map\(type => \(\{ value: cliEngineValue\(type\)/.test(appjs),
  '② 主模型下拉把两个命令行引擎各列成一项,选中即一次写 activeProvider＋agentCliType＋model');
ok(/\$\('newThreadEngineHint'\)[\s\S]{0,120}\.textContent\s*=/.test(appjs),
  '③ 说明行走 textContent(零 innerHTML)');
ok(/lastUsedEngineRoute/.test(appjs), '③ 说明行读的是 config.lastUsedEngineRoute');

// ── ④ 四份 locale ────────────────────────────────────────────────────────────────────
const KEYS = [
  'settings.newThreadEngine',
  'settings.newThreadEngine.last',
  'settings.newThreadEngine.global',
  'settings.newThreadEngine.lastNone',
  'settings.newThreadEngine.lastIs',
];
const catalogs = [
  ['public zh-CN', path.join(PUBLIC, 'locales', 'zh-CN.json')],
  ['public en-US', path.join(PUBLIC, 'locales', 'en-US.json')],
  ['docs zh-CN', path.join(DOCS, 'zh-CN.json')],
  ['docs en-US', path.join(DOCS, 'en-US.json')],
];
for (const [label, file] of catalogs) {
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = KEYS.filter(key => typeof catalog[key] !== 'string' || !catalog[key].trim());
  ok(missing.length === 0, `④ ${label} 带齐五个键(缺:${JSON.stringify(missing)})`);
  ok(String(catalog['settings.newThreadEngine.lastIs'] || '').includes('{{p1}}'),
    `④ ${label} 的 lastIs 带 {{p1}} 占位符(说明行要把「上次用的是谁」填进去)`);
}

console.log(`\nNEW THREAD ENGINE DEFAULT STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;

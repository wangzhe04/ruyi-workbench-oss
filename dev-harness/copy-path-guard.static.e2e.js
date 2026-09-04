#!/usr/bin/env node
'use strict';
// 静态锁(第118波 118d/118g):前端不得再出现「给路径 / 给命令,让用户自己去别处打开」的出口。
//
// 事实源是 §2 的 UX 红线(用户 2026-09-03 拍板):用户不该为完成一件事离开如意。手册在应用内读、
// 文件夹由如意替你打开、日志在应用内看、连接器一键写进配置。本件把这条红线钉在三个面上:
//
//   ① 文案面:app/public/** 的【用户可见文案】(四个 locale 的值 + index.html 的文本/属性 + JS 里的中文串)
//      不得出现「复制路径 / 请打开 / 自行打开 / 手动打开 / copy the path / open it yourself」这类
//      把动作推给用户的说法。注释里可以出现(说明为什么不这么做),所以扫描跳过注释行。
//   ② 行为面:剪贴板写入点必须在白名单里,且每条都写明「复制的是内容,不是路径」的理由;
//      「打开数据目录」不得再把客户端持有的路径串交给 runTool('browser_open'),必须走 /api/open-path 枚举。
//   ③ 接线面:常驻帮助入口(侧栏「帮助」+ 设置页「?」)存在且四项聚合齐备;上下文帮助的锚点文案
//      与两份手册的 `##` 小节标题【逐字相符】(手册改标题而这里没跟着改,门就红)。
//   ④ 118g:MCP 模板卡从「复制走、去别处粘」改成「一键应用到配置」,写入前有变更摘要,
//      「复制 JSON(排错用)」保留为次要动作。
//
// 白名单例外逐条写明理由,见下方 ALLOWED_* 常量。
// 判定行:`COPY PATH GUARD STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const PUBLIC = path.join(WB, 'app', 'public');
const MANUALS = path.join(WB, 'docs', 'manuals');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const indexHtml = read(PUBLIC, 'index.html');
const appSrc = read(PUBLIC, 'app.js');
const navSrc = read(PUBLIC, 'js', 'navigation-controls.js');
const menuSrc = read(PUBLIC, 'js', 'help-menu.js');
const viewerSrc = read(PUBLIC, 'js', 'help-viewer.js');
const wizardSrc = read(PUBLIC, 'js', 'onboarding-wizard.js');
const sessionSrc = read(PUBLIC, 'js', 'session-experience.js');
const providerSrc = read(PUBLIC, 'js', 'provider-settings.js');
const overlayBuilder = read(WB, 'tools', 'build-overlay.js');
const onboardingCss = read(PUBLIC, 'css', 'components', 'onboarding.css');
const locales = {
  'zh-CN': readJson(path.join(PUBLIC, 'locales', 'zh-CN.json')),
  'en-US': readJson(path.join(PUBLIC, 'locales', 'en-US.json')),
};
const docsLocales = {
  'zh-CN': readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json')),
  'en-US': readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json')),
};

/* ═══════════════ ① 文案面:反模式说法一律不许进用户可见文案 ═══════════════ */

// 「把动作推给用户」的说法。注意只收【指示型】表达:「复制路径」「请打开」「自行打开」「手动打开」等。
// 「粘贴 xxx」不在此列 : 那是用户把东西【交给】如意的输入侧,方向相反(见 ALLOWED_INPUT_SIDE 说明)。
const ANTIPATTERN = [
  /复制路径/,
  /复制上面的路径/,
  /请(自行)?打开(?!始)/,
  /自行打开/,
  /自己打开/,
  /手动打开/,
  /自己去(找|开|打开)/,
  /到.{0,8}目录下(找|打开)/,
  /copy (the )?path/i,
  /open it yourself/i,
  /manually open/i,
  /paste (it|this) into/i,
  /go (and )?(find|open) (the|this) (file|folder)/i,
];

// 白名单例外 : 每条写明理由。命中反模式正则但判定为【允许】的用户可见文案键。
const ALLOWED_COPY_KEYS = Object.freeze({
  // 「复制失败，请手动选择文本复制」:这是【复制内容】失败时的兜底提示,与路径无关,
  // 而且用户本来就在复制内容(代码/消息/日志),不是被打发去别处开文件。
  'toast.copyFail': '复制内容失败的兜底提示,与路径无关',
});

// 输入侧说法(用户把路径【交给】如意)。这些不是「出口」,方向相反,一律允许并在此登记。
const ALLOWED_INPUT_SIDE = Object.freeze({
  'workspace.pastePath': '工作文件夹选择器的兜底输入框;主力动作是旁边的「浏览文件夹…」原生选择器',
  'workspace.favorites.empty': '同上,空态提示指向同一个选择器',
  'skills.playbook.filePlaceholder': 'Playbook 输入框的 placeholder,用户把路径交给如意',
  'skills.playbook.folderPlaceholder': '同上',
  'toast.dragPathLost': '拖放拿不到深层路径时的输入侧兜底,旁边就是原生选择器',
  'onboarding.wizard.provider.apiKeyPlaceholder': '密钥输入框,与路径无关',
  'onboarding.wizard.validate.keyMasked': '密钥校验提示,与路径无关',
  'onboarding.wizard.validate.keyTooLong': '同上',
  'onboarding.wizard.validate.keyWhitespace': '同上',
  'onboarding.wizard.validate.keyPrefixWarning': '同上',
  'onboarding.wizard.validate.keyTooShort': '同上',
  'onboarding.wizard.engine.hint': '同上',
});

// 「如意替用户打开」的真动作文案。§2 明确允许:是应用替你做,不是让你自己去做。
const ALLOWED_REAL_ACTIONS = Object.freeze({
  'file.reveal': 'POST /api/file/reveal:如意替用户在资源管理器里定位文件',
  'previewShell.finishArtifactExpand': '收活台产物区,同一条 reveal 真动作',
  'palette.openDataDirectory': '命令面板项,走 /api/open-path 枚举通道由服务端打开',
  'settings.advanced.openDataDirectory': '高级页按钮,同上',
  'help.menu.openDataDir': '帮助菜单项,同上',
  'help.menu.openLogsDir': '帮助菜单项,同上',
});

const localeHits = [];
for (const [lang, catalog] of Object.entries(locales)) {
  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== 'string') continue;
    if (ALLOWED_COPY_KEYS[key] || ALLOWED_INPUT_SIDE[key] || ALLOWED_REAL_ACTIONS[key]) continue;
    if (ANTIPATTERN.some(re => re.test(value))) localeHits.push(`${lang} ${key} = ${value}`);
  }
}
ok(localeHits.length === 0, '① 四个 locale 的用户可见文案零「自己去打开」出口' + (localeHits.length ? ' -- ' + localeHits.join(' | ') : ''));

// index.html 的可见文本与属性(跳过注释行:注释里说明「为什么不这么做」是允许的)。
const htmlHits = indexHtml.split(/\r?\n/)
  .filter(line => !line.trim().startsWith('<!--'))
  .filter(line => ANTIPATTERN.some(re => re.test(line)));
ok(htmlHits.length === 0, '① index.html 零「自己去打开」出口' + (htmlHits.length ? ' -- ' + htmlHits.join(' | ') : ''));

// public/js/**/*.js 与 app.js 的【代码行】(跳过 // 与 /* */ 行注释)。
function codeLines(src) {
  return src.split(/\r?\n/).filter(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  });
}
const jsDir = path.join(PUBLIC, 'js');
const jsFiles = ['app.js', ...fs.readdirSync(jsDir).filter(n => n.endsWith('.js')).map(n => path.join('js', n))];
const jsHits = [];
for (const rel of jsFiles) {
  for (const line of codeLines(read(PUBLIC, rel))) {
    if (ANTIPATTERN.some(re => re.test(line))) jsHits.push(`${rel}: ${line.trim().slice(0, 110)}`);
  }
}
ok(jsHits.length === 0, `① public/**/*.js 的代码行零「自己去打开」出口(扫了 ${jsFiles.length} 个文件)` + (jsHits.length ? ' -- ' + jsHits.join(' | ') : ''));

/* ═══════════════ ② 行为面:剪贴板白名单 + 打开目录必须走枚举 ═══════════════ */

// 剪贴板写入白名单 : 每条写明「复制的是内容,不是路径」。
const ALLOWED_CLIPBOARD = Object.freeze({
  'chat-render-primitives.js': '复制代码块 / 复制整条消息:复制的是回答内容',
  'mermaid-runtime.js': '复制图源:复制的是图的源码',
  'provider-settings.js': '118g 后是「复制 JSON(排错用)」次要动作:复制的是模板内容,主动作已改为一键应用',
  'help-menu.js': '118d 日志面板「复制全部」:复制的是日志正文,供用户发问题报告',
});
const clipboardFiles = fs.readdirSync(jsDir)
  .filter(n => n.endsWith('.js'))
  .filter(n => /(navigator\s*&&\s*globalThis\.navigator\.clipboard|navigator\??\.clipboard|clipboard\.writeText)/.test(read(jsDir, n)));
const clipboardUnexpected = clipboardFiles.filter(n => !ALLOWED_CLIPBOARD[n]);
ok(clipboardUnexpected.length === 0,
  `② 剪贴板写入只在白名单四处(${clipboardFiles.join(', ')})` + (clipboardUnexpected.length ? ' -- 未登记: ' + clipboardUnexpected.join(', ') : ''));
ok(!/clipboard/i.test(wizardSrc) && !/clipboard/i.test(viewerSrc),
  '② 向导与手册阅读器仍然零剪贴板(118a-fix 的红线不回潮)');

// 「打开数据目录」不得再把客户端持有的路径串交给 runTool。
ok(!/runTool\('browser_open', \{ url: dr \}\)/.test(appSrc) && !/runTool\('browser_open', \{ url: dr \}\)/.test(navSrc),
  "② 「打开数据目录」不再走 runTool('browser_open', {url: dataRoot})");
ok(navSrc.includes("helpMenu.openWorkbenchFolder('data')") && menuSrc.includes("api('/api/open-path'"),
  '② 改走 /api/open-path 枚举通道(前端不再经手绝对路径)');
ok(menuSrc.includes("export const HELP_OPEN_TARGETS = Object.freeze(['data', 'logs', 'workspace', 'manuals'])")
  && /if \(!HELP_OPEN_TARGETS\.includes\(name\)\) return '';/.test(menuSrc),
  '② 前端也只发四个枚举 key,枚举外连请求都不发');
ok(!/openPathRequestBody\([^)]*path/.test(menuSrc) && !/body: JSON\.stringify\(\{[^}]*path:/.test(menuSrc),
  '② 请求体里没有任何 path 字段(服务端也不接受)');

/* ═══════════════ ③ 接线面:常驻帮助入口 + 四项聚合 ═══════════════ */

ok(/id="helpMenuBtn"[^>]*aria-haspopup="menu"/.test(indexHtml) && indexHtml.includes('data-i18n="help.menu.title"'),
  '③ 侧栏有常驻「帮助」入口 #helpMenuBtn(aria-haspopup=menu)');
const tabsBlock = indexHtml.slice(indexHtml.indexOf('id="settingsTabs"'), indexHtml.indexOf('id="stab-basic"'));
ok(/id="settingsHelpBtn"/.test(tabsBlock) && !/id="settingsHelpBtn"[^>]*data-stab/.test(tabsBlock),
  '③ 设置页签排尾有「?」#settingsHelpBtn,且不带 data-stab(不参与页签切换)');
ok(appSrc.includes("querySelectorAll('#settingsTabs button[data-stab]')")
  && navSrc.includes("querySelectorAll('#settingsTabs button[data-stab]')"),
  '③ 页签接线与 active 切换都只认 [data-stab],不会把「?」当成页签');
ok(navSrc.includes("from './help-menu.js'") && navSrc.includes("from './help-viewer.js'") && navSrc.includes("from './onboarding-wizard.js'")
  && navSrc.includes('createHelpMenuDomain({') && navSrc.includes('openSharedHelpDoc(options)') && navSrc.includes('openSharedOnboarding()'),
  '③ 帮助菜单复用手册阅读器与向导的共用实例(不另造第二个)');
ok(wizardSrc.includes('export function registerOnboardingWizard(') && wizardSrc.includes('export function openSharedOnboarding(')
  && sessionSrc.includes('registerOnboardingWizard(createOnboardingWizardDomain({'),
  '③ 向导共用实例登记处与 help-viewer 的 registerHelpViewer 同一口径');
ok(navSrc.includes('function initHelpEntries()') && navSrc.includes("$('helpMenuBtn')") && navSrc.includes("$('settingsHelpBtn')")
  && navSrc.includes("$('openDataDirBtn')") && appSrc.includes('initHelpEntries();'),
  '③ 三个入口在 initHelpEntries() 里一次接线,组合根只加一行');

// 四项聚合:使用手册 / 管理员手册 / 重新打开引导 / 看日志 + 打开数据目录。
const MENU_ITEM_IDS = ['user-guide', 'admin-guide', 'reopen-wizard', 'view-logs', 'open-data-dir'];
ok(MENU_ITEM_IDS.every(id => menuSrc.includes(`id: '${id}'`)),
  `③ 帮助菜单聚合五个真动作条目(${MENU_ITEM_IDS.join(' / ')})`);
ok(menuSrc.includes("openHelpDoc({ docId: 'user-guide' })") && menuSrc.includes("openHelpDoc({ docId: 'admin-guide' })"),
  '③ 管理员手册终于有了 UI 入口(118a-fix 打通通道但没有按钮)');
ok(menuSrc.includes("api(logTailRequestPath(select.value))") && menuSrc.includes("openWorkbenchFolder('logs')")
  && menuSrc.includes("t('help.logs.copyAll')"),
  '③ 日志面板三件套:应用内看内容 + 复制全部(内容) + 打开日志目录(真动作)');
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(menuSrc), '③ help-menu.js 零 innerHTML');
ok(!/^import\s/m.test(menuSrc), '③ help-menu.js 零 import(壳无关工厂,环境依赖全注入)');
ok(overlayBuilder.includes("'app/public/js/help-menu.js'"), '③ overlay 离线载荷登记 help-menu.js');
ok(onboardingCss.includes('.help-menu-item') && onboardingCss.includes('.settings-tab-help') && onboardingCss.includes('.help-logs-pre')
  && onboardingCss.includes('@media (max-width: 520px)'),
  '③ 118d 样式落在已注册的 onboarding.css 层内(含窄屏收敛),不新开样式表');

/* ═══════════════ ③b 上下文帮助锚点 vs 手册 ## 标题逐字比对 ═══════════════ */

const stabIds = [...tabsBlock.matchAll(/data-stab="([a-z-]+)"/g)].map(m => m[1]);
const anchorTable = menuSrc.slice(menuSrc.indexOf('SETTINGS_TAB_HELP_ANCHORS = Object.freeze({'), menuSrc.indexOf('});', menuSrc.indexOf('SETTINGS_TAB_HELP_ANCHORS')));
const mappedTabs = [...anchorTable.matchAll(/^\s{2}([a-z-]+):\s*'([\w.]+)',$/gm)].map(m => [m[1], m[2]]);
const mappedNames = mappedTabs.map(([name]) => name);
ok(stabIds.length > 0 && stabIds.every(id => mappedNames.includes(id)),
  `③b 设置页每个页签都有锚点映射(${stabIds.length} 个页签: ${stabIds.join(', ')})`);

const headings = lang => read(MANUALS, lang === 'zh-CN' ? 'USER-GUIDE_CN.md' : 'USER-GUIDE_EN.md')
  .split(/\r?\n/).filter(l => /^##\s+\S/.test(l)).map(l => l.replace(/^##\s+/, '').trim());
const anchorKeys = [...new Set(mappedTabs.map(([, key]) => key))];
const anchorProblems = [];
for (const key of anchorKeys) {
  for (const lang of ['zh-CN', 'en-US']) {
    const value = locales[lang][key];
    if (typeof value !== 'string') { anchorProblems.push(`${lang} 缺键 ${key}`); continue; }
    if (docsLocales[lang][key] !== value) { anchorProblems.push(`${lang} ${key} 与 docs/i18n 不一致`); continue; }
    if (!headings(lang).includes(value)) anchorProblems.push(`${lang} ${key}="${value}" 不是手册的 ## 标题`);
  }
}
ok(anchorProblems.length === 0,
  `③b 锚点文案(${anchorKeys.join(', ')})与两份手册的 ## 标题逐字相符` + (anchorProblems.length ? ' -- ' + anchorProblems.join(' | ') : ''));
ok(menuSrc.includes("openHelpDoc({ docId: 'user-guide', anchor: t(helpAnchorKeyForTab(tab)) })"),
  '③b 「?」打开的是手册对应小节(anchor 取自映射表的文案键,不是硬编码标题)');

/* ═══════════════ ④ 118g:MCP 模板卡改成一键应用 ═══════════════ */

const tplStart = providerSrc.indexOf('function showMcpTemplateModal(');
const tplBlock = tplStart >= 0 ? providerSrc.slice(tplStart, providerSrc.indexOf('\n}\n', tplStart)) : '';
ok(!!tplBlock && tplBlock.includes("t('mcp.apply.apply')") && tplBlock.includes("api('/api/mcp/import-config/apply'"),
  '④ MCP 模板卡的主动作是「一键应用到配置」,走 import-config/apply 写入路径');
ok(tplBlock.includes("t('mcp.apply.willAdd'") && tplBlock.includes("t('mcp.apply.willOverwrite'") && tplBlock.includes('syncSummary()'),
  '④ 写入前原位展示变更摘要(新增 / 覆盖了哪个连接器),跟着 id 实时更新');
ok(tplBlock.includes("toast(t('mcp.apply.done'") && tplBlock.includes('await refreshStatus()') && tplBlock.includes("t('mcp.apply.failed'"),
  '④ 成功 toast + 刷新列表,失败给人话');
ok(tplBlock.includes("t('mcp.apply.copyJson')") && !tplBlock.includes("t('common.copy')"),
  '④ 「复制」降级为次要动作并改名「复制 JSON(排错用)」');
ok(!/setTimeout\(\(\) => \{ copyBtn\.textContent = '复制'; \}/.test(providerSrc),
  '④ 复制按钮不再回填硬编码中文「复制」(旧写法绕过了 i18n)');
// 真机走查发现的两处:错误信封与失败原因。normalizeApiErrorPayload 把服务端人话包成结构化信封,
// 直接插值印 [object Object];而 apply 失败时真正有用的是 skipped[0].reason(例如「已达上限(10)」)。
ok(providerSrc.includes('function mcpErrText(error)') && providerSrc.includes("error.code === 'api.request_failed' && error.message")
  && !/showMcpTemplateModal\(r\.error \|\| /.test(providerSrc),
  '④ MCP 导入错误走 mcpErrText 取人话(不再 [object Object],也不被兜底 code 翻成泛泛的「请求失败」)');
ok(tplBlock.includes('const skipReason = r && Array.isArray(r.skipped)') && tplBlock.includes('skipReason ||'),
  '④ 应用失败优先显示 skipped[0].reason(那句才说明为什么没写进去)');
ok(menuSrc.includes("classList.add('help-logs-modal')") && onboardingCss.includes('.modal.help-logs-modal'),
  '④ 日志面板是实底面板(浮层玻璃档会把背后的文字透上来,密排等宽日志读不下去)');
for (const lang of ['zh-CN', 'en-US']) {
  const hint = locales[lang]['mcp.createManifestHint'] || '';
  ok(!/创建一个|再重新导入|Create a ruyi-mcp\.json/.test(hint) && hint.length > 0,
    `④ ${lang} 的 mcp.createManifestHint 不再教用户去建文件: ${hint.slice(0, 40)}…`);
}
const applyKeys = ['mcp.apply.apply', 'mcp.apply.copyJson', 'mcp.apply.willAdd', 'mcp.apply.willOverwrite',
  'mcp.apply.needFields', 'mcp.apply.done', 'mcp.apply.failed', 'mcp.apply.id', 'mcp.apply.label',
  'mcp.apply.command', 'mcp.apply.args', 'mcp.apply.cwd'];
const applyMissing = applyKeys.filter(k => ['zh-CN', 'en-US'].some(l => !locales[l][k] || docsLocales[l][k] !== locales[l][k]));
ok(applyMissing.length === 0, `④ ${applyKeys.length} 条 mcp.apply.* 键在四个 locale 齐备且逐字一致` + (applyMissing.length ? ' -- 缺: ' + applyMissing.join(', ') : ''));

const helpKeys = ['help.menu.title', 'help.menu.userGuide', 'help.menu.adminGuide', 'help.menu.viewLogs',
  'help.menu.openDataDir', 'help.menu.openLogsDir', 'help.logs.title', 'help.logs.hint', 'help.logs.copyAll',
  'help.logs.lines', 'help.logs.loading', 'help.logs.empty', 'help.logs.none', 'help.logs.loadFailed', 'help.logs.readFailed',
  'help.logs.fileLabel', 'help.open.ok', 'help.open.failed', 'help.open.unknownTarget', 'help.tabHelp'];
const helpMissing = helpKeys.filter(k => ['zh-CN', 'en-US'].some(l => !locales[l][k] || docsLocales[l][k] !== locales[l][k]));
ok(helpMissing.length === 0, `④ ${helpKeys.length} 条 help.menu/logs/open/tabHelp 键在四个 locale 齐备且逐字一致` + (helpMissing.length ? ' -- 缺: ' + helpMissing.join(', ') : ''));

console.log('\nCOPY PATH GUARD STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);

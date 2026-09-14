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
// 117q-B3a(P1-7，30 号文 §4.7)登记：「压缩」整片文案漏 t() 的教训——这四个文件此前不在本守卫
// 任何一张扫描名单里，见下方 ⑤ 节。
const chatStreamSrc = read(PUBLIC, 'js', 'chat-stream-runtime.js');
const workbenchSrc = read(PUBLIC, 'js', 'workbench.js');
const agentRolesSrc = read(PUBLIC, 'js', 'agent-roles.js');
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
  // 121-K1：交办台收活台那一条（previewShell.finishArtifactExpand）随它退役，键已删除，白名单一并清。
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

/* ═══════════════ ⑤ 117q-B3a(30 号文 §4.7)：压缩文案漏 t() 的硬编码中文回归锁 ═══════════════ */
// 教训：「压缩」整片文案一半走了 t()、另一半是硬编码中文字面量，英文界面下用户先看到英文字符串，
// 一有进度事件又被中文覆盖。①的 ANTIPATTERN 扫描只认「自己去打开」这一类【说法】，不认「压根没走
// i18n」这一类【缺陷】——这四个文件此前不在任何判「硬编码中文」的名单里。本节新增（纯新增，不改
// 既有 ①～④ 任何判据）：剥注释后逐行找中文字符——本仓所有标识符都是 ASCII，t('key') 的 key 也是
// ASCII 点号路径，翻译文案只活在四份 locale.json 里，所以「代码行里出现中文字符」本身就等价于
// 「这段文案没走 catalog」，不需要更复杂的 AST 判断。
//
// 纳入后确实扫出本刀 P1-7 范围外的既有硬编码中文（下方按行号登记，逐条写了不改的理由）——不在本
// 刀顺手全改，会让「apiRaw 重放 + 压缩文案 i18n」这两件事失焦；清单已经列进 117q-B3a 的验收报告，
// 由另一刀专门清。
const stripCjkScanComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const CJK_CODE_RE = /[一-龥]/;
function cjkCodeLineNumbers(source) {
  return stripCjkScanComments(source).split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter(entry => CJK_CODE_RE.test(entry.text));
}
// 白名单：117q-B3a 走查时扫出的既有硬编码中文，逐条登记理由。键是文件名，值是「行号 -> 理由」。
// 「行号」按剥注释后的原始行号数（不删行，只清空注释内容，行号与源文件一一对应）。
const ALLOWED_CJK_CODE = Object.freeze({
  'chat-stream-runtime.js': {
    // 124 走查（`589cdb1`，用户 2026-09-14）：本文件在 :325 之前与 :1051 一带共插入 10 行 ——
    // 下面十条登记行号整体 +10（逐行 byte 比对过：与位移前的 325/1051/1365/1399/1409/1436/1440/
    // 1465/1498/1499 逐字相同，是位移不是新增，同 117s-G 那次 +41 与 navigation-controls 那次 +63 的先例）。
    335: '进程状态 tooltip：117q-B3a 登记，待另刀（P1-7 范围外）',
    1061: '工具面板里的调试回显（模型=/权限=），不是常规用户文案：117q-B3a 登记，待另刀',
    1375: '「已按你的补充意见继续」提示：117q-B3a 登记，待另刀',
    1409: '正则字面量（匹配 SSE 文本用的「后台/异步/代理/任务/已启动/运行中」词表），不是渲染给用户的文案，不受本锁约束',
    1419: '子代理卡状态行「生成中 · N 字」：117q-B3a 登记，待另刀',
    1446: '子代理卡依赖标签「依赖 ...」：117q-B3a 登记，待另刀',
    1450: '子代理卡状态「执行中…」：117q-B3a 登记，待另刀',
    1475: '子代理卡重试状态「重试中 n/m」：117q-B3a 登记，待另刀',
    1508: '子代理卡「后台执行中」状态：117q-B3a 登记，待另刀',
    1509: '子代理卡「✓ 完成 · N 字结论」状态：117q-B3a 登记，待另刀',
  },
  'workbench.js': {
    531: '工作流节点 aria-label「节点 N · 状态(点击定位到监控卡)」：117q-B3a 登记，待另刀',
    561: '工作流节点判定标签「判定 X」：117q-B3a 登记，待另刀',
    562: '工作流节点置信度标签：117q-B3a 登记，待另刀',
    567: '工作流节点依赖标签「← 依赖 ...」：117q-B3a 登记，待另刀',
  },
  'agent-roles.js': {},
  'navigation-controls.js': {
    // 32 号文 §4（M1-a）：模型弹层本体搬进 model-menu.js（两壳共用），本文件整体 -51 行 —— 两条登记
    // 行号随之下移。逐条核对过内容没变（仍是 ctx-pop 的「已用 N / 上限 M」那行与用量文本刷新点），
    // 是位移不是新增（同 117s-G 那次 +41 的先例）。
    // 32 号文 §4（M1-b）：浮层原语 popover/closePopover 搬进 js/popover.js，本文件再 -43 行 ——
    // 两条登记行号再次纯位移（同一条先例：内容逐条比对过，仍是那两处 ctx-pop 用量文本）。
    // 32 号文 §4（M1-b 续）：setEngineModel 加 opts.scope、openModelChipPopover 加 opts 透传，本文件 +10
    // 行 —— 两条登记行号再 +10（逐行 byte 比对过：415/531 与位移前的 405/521 逐字相同，纯位移）。
    // 121-K5（34 号文 §3.1）：renderModelChip（23 行）与 openModelChipPopover（84 行）随顶栏那枚
    // #modelChip 一起退役，换进来的是 modelMenuExtras（68 行）—— 本文件净 -35 行，两条登记行号
    // 随之 415→380、531→496（逐行 byte 比对过：内容仍是那两处 ctx-pop 的「已用 N / 上限 M」文本，
    // 是位移不是新增，同 M1-a／M1-b 两次的先例）。
    // 124 走查（用户 2026-09-14 两条小修）：本文件在 300 行前后插入 deleteProviderModel／
    // providerModelIdSet（+45）、modelMenuExtras 的 route 分岔与「刷新不关菜单」（+15）、两段说明
    // （+3），合计 +63 行 —— 两条登记行号随之整体 +63（逐行 byte 比对过：内容仍是那两处 ctx-pop
    // 的「已用 N / 上限 M」文本，是位移不是新增，同 M1-a／M1-b 与 117s-G 的先例）。
    // 顺带修正一处陈旧：HEAD 上这两个键（380/496）就已比真实命中（389/505）小 9 行，本波按当前
    // 源码逐条重钉为 452/568（判据本身一个字没改）。
    452: '上下文用量弹层「已用/上限」行：117q-B3a 登记，待另刀（P1-7 范围外，压缩模型选择器本身已修）',
    568: '同上，另一处用量文本刷新点：117q-B3a 登记，待另刀',
  },
});
const CJK_SCAN_TARGETS = [
  ['chat-stream-runtime.js', chatStreamSrc],
  ['workbench.js', workbenchSrc],
  ['agent-roles.js', agentRolesSrc],
  ['navigation-controls.js', navSrc],
];
for (const [name, source] of CJK_SCAN_TARGETS) {
  const allowed = ALLOWED_CJK_CODE[name] || {};
  const hits = cjkCodeLineNumbers(source);
  const unexpected = hits.filter(hit => !(hit.line in allowed));
  ok(unexpected.length === 0,
    `⑤ ${name} 的硬编码中文只剩白名单登记的既有项，零新增` +
    (unexpected.length ? ' -- 新增未登记: ' + unexpected.map(h => `${h.line}: ${h.text.slice(0, 80)}`).join(' | ') : ''));
}
// 白名单本身不许悄悄膨胀成藏污纳垢的地方：登记的每一行必须真的还命中中文，且必须是刚才那三个
// 「本刀已修」的文件之外的行——否则白名单会在没人注意的情况下越攒越旧，失去「登记，待另刀」的意义。
const staleAllowlist = [];
for (const [name, source] of CJK_SCAN_TARGETS) {
  const allowed = ALLOWED_CJK_CODE[name] || {};
  const hitLines = new Set(cjkCodeLineNumbers(source).map(h => h.line));
  for (const lineNo of Object.keys(allowed)) {
    if (!hitLines.has(Number(lineNo))) staleAllowlist.push(`${name}:${lineNo}`);
  }
}
ok(staleAllowlist.length === 0,
  '⑤ 白名单零陈旧登记（每一条都对应当前源码里真实存在的中文命中，不是摆设）' +
  (staleAllowlist.length ? ' -- 已不命中，该从白名单删掉: ' + staleAllowlist.join(', ') : ''));
// 本刀实际修掉的四处不许再出现在白名单里——防止「白名单反手把自己刚修的 bug 又豁免回来」这种
// 悄悄回潮。
const p17FixedLines = {
  'chat-stream-runtime.js': [1302, 1306, 1307, 1311, 1325],   // 117s-G 在 :529/:537 前后插了 41 行,登记行整体 +41;124 走查(`589cdb1`)再 +10 —— 两次都逐行 byte 比对过
  'workbench.js': [462, 465],
  'agent-roles.js': [45],
  'navigation-controls.js': [513, 515, 516, 539, 541, 543, 545, 546, 554],   // 124 走查：本波在它们之前插入 63 行 —— 九条各 +63（逐行 byte 比对过，内容未变；上一档 M1-b 续的 +10 已含在旧数里）
};
const reintroduced = [];
for (const [name] of CJK_SCAN_TARGETS) {
  const allowed = ALLOWED_CJK_CODE[name] || {};
  for (const lineNo of p17FixedLines[name] || []) {
    if (lineNo in allowed) reintroduced.push(`${name}:${lineNo}`);
  }
}
ok(reintroduced.length === 0,
  '⑤ P1-7 本刀已修的行号零一个出现在白名单里（不许用白名单把刚修的 bug 豁免回来）' +
  (reintroduced.length ? ' -- 违规: ' + reintroduced.join(', ') : ''));

console.log('\nCOPY PATH GUARD STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);

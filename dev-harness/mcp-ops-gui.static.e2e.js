'use strict';
/*
 * 静态锁(第55波 EC-C 55c):MCP 运维页签 GUI 接线 -- index.html(页签+面板+容器) /
 * settings-operations.js(refreshMcpOps 函数族 + 按钮绑定 + 四条 55a/55b API 调用) /
 * app.js(组合根 + switchSettingsTab hook) /
 * styles.css(健康灯/徽章/清单样式 + 简易模式隐藏) / locale(settings.mcp.* 43 键中英对等,
 * 运行时与 docs/i18n 事实源双份)。防 GUI 接线漂移(漏按钮/漏键/漏 hook -> 白屏或哑按钮)。
 *
 * Run: node dev-harness/mcp-ops-gui.static.e2e.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const html = fs.readFileSync(path.join(WB, 'app', 'public', 'index.html'), 'utf8');
const appjs = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
const operations = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'settings-operations.js'), 'utf8');
const navigation = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'navigation-controls.js'), 'utf8');
const css = require('./read-frontend-css.js').readFrontendCss();
const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'en-US.json'), 'utf8'));
const zhDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'), 'utf8'));
const enDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'), 'utf8'));
const server = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

// ── index.html:页签 + 面板 + 容器/按钮 ──
// W6 设置重组翻面重钉（用户 2026-09-24「设置里的内容有点乱，把重复／类似的统一」）：「MCP 运维」不再是单独一页，
// 连接器清单整段并进「集成与 MCP」（#stab-integrations，与桌面控制、浏览器、扩展组件同页），两枚「从文件夹导入」
// 只留 #mcpImportBtn。钉的事实从「有一枚 mcp 页签」换成「连接器清单住在集成页里、旧页签与旧面板都不在了、
// 第二枚导入按钮也不在了」—— 强度不降：多了两条反向判据。
const integrationsStart = html.indexOf('<div class="settings-tab" id="stab-integrations">');
const integrationsEnd = html.indexOf('<div class="settings-tab"', integrationsStart + 1);
const integrationsPanel = integrationsStart >= 0 ? html.slice(integrationsStart, integrationsEnd > 0 ? integrationsEnd : html.length) : '';
ok(html.includes('data-stab="integrations"') && !html.includes('data-stab="mcp"'), 'M1 连接器运维住「集成与 MCP」页签（旧的独立 mcp 页签已并掉）');
ok(Boolean(integrationsPanel) && !html.includes('id="stab-mcp"'), 'M2 stab-integrations 面板在、stab-mcp 面板已不在');
for (const id of ['mcpRefreshBtn', 'mcpImportBtn', 'mcpConnList', 'mcpListHint', 'mcpCompatBox']) {
  ok(integrationsPanel.includes(`id="${id}"`), `M3 ${id} 在集成页里`);
}
ok(!html.includes('id="importMcpFolderBtn"') && (html.match(/id="mcpImportBtn"/g) || []).length === 1
  && !html.includes('data-i18n="settings.externalMcpServer.import"'),
  'M3b 「从文件夹导入 MCP」全页只剩一枚（#mcpImportBtn；修前集成页另有一枚 #importMcpFolderBtn 调同一个函数）');
ok(integrationsPanel.includes('data-i18n="settings.mcp.title"') && integrationsPanel.includes('data-i18n="settings.mcp.hint"'), 'M4 标题/提示走 data-i18n');

// ── settings operations module + app.js composition root ──
for (const f of ['refreshMcpOps', 'renderMcpCompat', 'renderMcpConnList', 'mcpConnItemEl', 'mcpRetest', 'mcpToggle', 'mcpRemove', 'mcpHealthText', 'mcpHealthLampClass']) {
  ok(operations.includes(`function ${f}(`), `M5 ${f}() 在 settings-operations 模块`);
}
ok(appjs.includes("from './js/settings-operations.js'") && appjs.includes('createSettingsOperationsDomain')
  && appjs.includes('bindSettingsOperations();'), 'M5b app.js 仅保留模块组合与一次绑定');
ok(navigation.includes("if (name === 'integrations') refreshMcpOps(false);") && /SETTINGS_TAB_ALIASES = Object\.freeze\(\{ mcp: 'integrations' \}\)/.test(navigation),
  'M6 switchSettingsTab 在打开「集成与 MCP」时取清单(不 probe)；旧名 mcp 改投集成页');
ok(/mcpRefreshBtn.{0,140}onclick = \(\) => refreshMcpOps\(true\)/.test(operations), 'M7 全部重测绑 refreshMcpOps(true)');
ok(/mcpImportBtn[\s\S]{0,240}importMcpFromFolder/.test(operations), 'M8 导入按钮复用 importMcpFromFolder');
ok(operations.includes("'/api/mcp/connectors'") && operations.includes("'/api/mcp/connectors/health'") && operations.includes("'/api/mcp/connectors/toggle'"), 'M9 operations 模块调 list/health/toggle 三条 API');
ok(/api\('\/api\/mcp\/connectors', \{[\s\S]{0,100}method: 'POST',[\s\S]{0,100}headers: \{ 'x-http-method': 'DELETE' \}/.test(operations), 'M10 移除走 POST + x-http-method:DELETE');
// 简易模式:mcp 不在 JS 白名单,CSS 隐藏页签按钮(开发者向功能不进人人可用界面)。
ok(!/SETTINGS_SIMPLE_TABS = new Set\(\[[^\]]*'mcp'/.test(appjs), 'M11 简易模式白名单不含 mcp(JS 兜底)');
ok(css.includes(':root[data-ui-mode="simple"] #settingsTabs button[data-stab="integrations"]'), 'M12 简易模式 CSS 隐藏「集成与 MCP」页签（连接器运维随它一起收起）');
// 渲染纪律:连接器字段走 textContent(el 辅助),新块不用 innerHTML 拼接(配置串注入面)。
const block = operations.slice(operations.indexOf('MCP 运维页签'));
ok(block.length > 500 && !/\.innerHTML\s*=/.test(block), 'M13 55c 块零 innerHTML 赋值(textContent 渲染)');

// ── styles.css:健康灯 / 徽章 / 清单 ──
for (const cls of ['.mcp-conn-list', '.mcp-conn-item', '.mcp-lamp-ok', '.mcp-lamp-degraded', '.mcp-lamp-failed', '.mcp-lamp-disabled', '.mcp-badge-desktop', '.mcp-badge-config', '.mcp-badge-dropin', '.mcp-compat-item']) {
  ok(css.includes(cls), `M14 ${cls} 样式在`);
}

// ── locale:43 键四份对等(运行时 zh/en + docs 事实源 zh/en)──
const KEYS = [
  'settings.mcp.tab', 'settings.mcp.title', 'settings.mcp.hint', 'settings.mcp.refreshAll', 'settings.mcp.import',
  'settings.mcp.loading', 'settings.mcp.probing', 'settings.mcp.count', 'settings.mcp.empty',
  'settings.mcp.source.desktop', 'settings.mcp.source.config', 'settings.mcp.source.dropIn',
  'settings.mcp.status.enabled', 'settings.mcp.status.disabled',
  'settings.mcp.health.ok', 'settings.mcp.health.degraded', 'settings.mcp.health.failed', 'settings.mcp.health.disabled', 'settings.mcp.health.unknown',
  'settings.mcp.toolCount',
  'settings.mcp.cat.auth', 'settings.mcp.cat.startup', 'settings.mcp.cat.network', 'settings.mcp.cat.timeout',
  'settings.mcp.cat.security', 'settings.mcp.cat.toolRegistration', 'settings.mcp.cat.protocol', 'settings.mcp.cat.unknown',
  'settings.mcp.action.retest', 'settings.mcp.action.enable', 'settings.mcp.action.disable', 'settings.mcp.action.remove',
  'settings.mcp.retestDisabledHint', 'settings.mcp.retestOk', 'settings.mcp.enabledOk', 'settings.mcp.disabledOk',
  'settings.mcp.removedOk', 'settings.mcp.removeConfirm', 'settings.mcp.guardDesktop', 'settings.mcp.guardDropIn',
  'settings.mcp.compat', 'settings.mcp.capabilities', 'settings.mcp.limitations',
];
ok(KEYS.length === 43, 'M15 键清单 43 个(自锁)');
let keysOk = true;
for (const k of KEYS) {
  for (const [name, cat] of [['zh', zh], ['en', en], ['zhDoc', zhDoc], ['enDoc', enDoc]]) {
    if (!cat[k]) { keysOk = false; console.error(`  missing ${k} in ${name}`); }
  }
}
ok(keysOk, 'M16 43 键在四份 catalog 全在(运行时==事实源)');
// 占位符契约:{{p1}}/{{p2}} 中英对称。
for (const k of ['settings.mcp.count', 'settings.mcp.toolCount', 'settings.mcp.enabledOk', 'settings.mcp.disabledOk', 'settings.mcp.removedOk', 'settings.mcp.removeConfirm']) {
  ok(zh[k].includes('{{p1}}') && en[k].includes('{{p1}}'), `M17 ${k} 占位符 {{p1}} 中英对称`);
}
ok(zh['settings.mcp.retestOk'].includes('{{p1}}') && zh['settings.mcp.retestOk'].includes('{{p2}}') && en['settings.mcp.retestOk'].includes('{{p1}}') && en['settings.mcp.retestOk'].includes('{{p2}}'), 'M18 retestOk 占位符 {{p1}}/{{p2}} 中英对称');
// 8 类错误归类键与后端 classifyMcpError 类别一一对应(55a 契约)。
for (const c of ['auth', 'startup', 'network', 'timeout', 'security', 'tool_registration', 'protocol', 'unknown']) {
  ok(server.includes(`category: '${c}'`), `M19 后端类别 ${c} 在(server.js)`);
}
ok(server.includes("'/api/mcp/connectors/toggle'") && server.includes("'/api/mcp/connectors/health'"), 'M20 server.js 含 55a/55b 路由(GUI 调用目标)');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);

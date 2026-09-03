#!/usr/bin/env node
'use strict';

// Offline regression for the user-browser default and conversational MCP administration surface.
const path = require('path');
const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

let failures = 0;
function ok(value, label) {
  if (value) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label); }
}

const normalized = srv.normalizeConfig({ browserAutomation: { mode: 'invalid', executable: 42 } }).config;
ok(normalized.browserAutomation.mode === 'system', 'invalid browser mode falls back to system/user browser');

const configured = srv.normalizeConfig({
  desktopMcp: { enabled: true, command: 'python', args: ['-m', 'ai_computer_control'], autodetect: false },
  browserAutomation: { mode: 'cdp', executable: '', cdpUrl: 'http://127.0.0.1:9333' },
}).config;
const acc = srv.resolveExternalMcpServers(configured).find(entry => entry.id === 'ai-computer-control');
ok(acc && acc.env.ACC_BROWSER_MODE === 'cdp', 'desktop MCP receives the configured browser mode');
ok(acc && acc.env.ACC_BROWSER_CDP_URL === 'http://127.0.0.1:9333', 'desktop MCP receives the configured CDP endpoint');

const inventory = srv.safeMcpInventory(configured);
const safeAcc = inventory.find(entry => entry.id === 'ai-computer-control');
ok(safeAcc && Array.isArray(safeAcc.envKeys) && !Object.prototype.hasOwnProperty.call(safeAcc, 'env'),
  'mcp_list inventory exposes env names but never secret values');

const tools = srv.buildOpenAiTools(configured, { desktopMcp: { present: true }, provider: {} });
const names = new Set(tools.map(tool => tool.function && tool.function.name));
ok(names.has('mcp_list') && names.has('mcp_configure'), 'provider tool surface includes MCP inspect/configure tools');
const browserTool = tools.find(tool => tool.function && tool.function.name === 'browser_open');
ok(browserTool && /Never navigate or close the current Ruyi Workbench tab/.test(browserTool.function.description),
  'native browser tool contract preserves the current Workbench tab');
const chromeOpen = srv.buildBrowserOpenSpawn('https://example.invalid', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const firefoxOpen = srv.buildBrowserOpenSpawn('https://example.invalid', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe');
const folderOpen = srv.buildBrowserOpenSpawn('C:\\data', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
ok(chromeOpen.mode === 'new-tab' && chromeOpen.args[0] === '--new-tab' && chromeOpen.preservesWorkbench,
  'Chromium browser handoff explicitly opens a new tab');
ok(firefoxOpen.mode === 'new-tab' && firefoxOpen.args[0] === '-new-tab',
  'Firefox browser handoff uses its new-tab argument');
ok(folderOpen.command === 'explorer.exe' && folderOpen.preservesWorkbench,
  'local folders retain the safe Explorer handoff rather than opening in a browser');
ok(srv.classifyToolPacks('请把浏览器目标改成我的默认浏览器').includes('integrations'),
  'browser/tool customization requests preload the integrations tool pack');

const systemHint = srv.buildBrowserAutomationHint({ browserAutomation: { mode: 'system' } });
ok(/Chrome for Testing/.test(systemHint) && /accessibilityLimited/.test(systemHint),
  'system prompt forbids bundled test Chrome and explains the Direct3D UIA fallback');
// 108b: 文案迁入 06b registry 并双语化; 本断言锁的是英文包原文,故显式选 en-US(断言语义/文字未改)。
const customizationHint = srv.buildToolCustomizationHint({ locale: 'en-US' });
ok(/explicitly asks/.test(customizationHint) && /mcp_list/.test(customizationHint) && /permission/.test(customizationHint),
  'AI receives an explicit-request, inspect-first, permission-gated MCP modification policy');
// 108b 新增(只加):默认(中文包)也必须给出同一套安全句 + 设置边界,避免中文用户拿到英文段或缺边界。
const customizationHintZh = srv.buildToolCustomizationHint();
ok(/mcp_list/.test(customizationHintZh) && /exec/.test(customizationHintZh) && /设置面板/.test(customizationHintZh),
  '108b default (zh) MCP policy keeps inspect-first + exec-tier gating and names the settings panel boundary');

console.log('\nBROWSER/MCP STATIC: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;

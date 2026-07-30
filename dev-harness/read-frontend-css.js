'use strict';

const fs = require('fs');
const path = require('path');

const PUBLIC = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
const CHAT_CSS_ROUTES = Object.freeze([
  'css/views/chat-shell.css',
  'css/components/chat-primitives.css',
  'css/views/chat-narrative.css',
  'css/states/chat-live.css',
  'css/components/chat-composer.css',
]);
const CSS_PAYLOAD_GROUPS = Object.freeze([
  'css/tokens.css',
  'css/themes/color-schemes.css',
  'css/base.css',
  'css/layout.css',
  CHAT_CSS_ROUTES,
  'css/components/tool-pane.css',
  'css/themes/ui-modes.css',
  'css/views/workspace.css',
  'css/views/usage.css',
  'css/views/workbench.css',
]);
const CSS_ROUTES = Object.freeze(CSS_PAYLOAD_GROUPS.flatMap(group => Array.isArray(group) ? group : [group]));
const CSS_COMPAT_ROUTES = Object.freeze(['css/views/chat.css']);
// 第66波修复:845bb8c 把 chat.css 拆成 5 个聊天层文件并改了载荷拼接,却漏更新本锁 → D51 自 HEAD 起恒红。
// 逐行 diff 旧单体载荷(f667405d…) vs 新分层载荷:仅丢 2 行空行(拆文件后组内以 '' 拼接,原段间空行随边界消失),
// 0 条规则漂移,符合 D51「无 CSS 漂移」本意。Escapade 2.4 的结构化问题卡有意扩展 tool-pane 层后重钉载荷 SHA。
const LEGACY_STYLES_SHA256 = '32dce415fb1519289d0daf04bd10999e010039940af4b6330cf36317d403d946';

function cssSourceFiles() {
  return CSS_ROUTES.map(route => path.join(PUBLIC, ...route.split('/')));
}

function readFrontendCss() {
  return cssSourceFiles()
    .map((file, index) => {
      const source = fs.readFileSync(file, 'utf8');
      return `/* ==== dev-harness CSS layer ${index + 1}: ${CSS_ROUTES[index]} ==== */\n${source}`;
    })
    .join('\n');
}

function readLayerPayload() {
  const payloadFor = route => {
    const file = path.join(PUBLIC, ...route.split('/'));
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    return source.slice(source.indexOf('\n') + 1);
  };
  return CSS_PAYLOAD_GROUPS
    .map(group => (Array.isArray(group) ? group : [group]).map(payloadFor).join(''))
    .join('\n');
}

module.exports = {
  CHAT_CSS_ROUTES,
  CSS_COMPAT_ROUTES,
  CSS_ROUTES,
  LEGACY_STYLES_SHA256,
  PUBLIC,
  cssSourceFiles,
  readFrontendCss,
  readLayerPayload,
};

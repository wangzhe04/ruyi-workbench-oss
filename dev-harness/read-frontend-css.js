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
  // 118a: onboarding wizard layer (own component sheet, appended last so it can lean on every token above).
  'css/components/onboarding.css',
  // 117a: steward shell layer (third shell mode; own sheet, appended last for the same reason).
  'css/views/steward-shell.css',
  // 117b: steward avatar layer (the seven-state 2D avatar; its own sheet since the rule count exceeds
  // what fits comfortably in steward-shell.css). Appended last for the same reason.
  'css/views/steward-avatar.css',
  // 117c: steward conversation + composer layer (bubbles, the one-row action buttons, the ※ popover,
  // the "···" placeholder, the hand-off target chip and its listbox). Appended last for the same reason.
  'css/views/steward-conversation.css',
  // 117d: steward thread-drawer layer (the right-hand 390px drawer, the quick-switch chips shared with
  // 117g/117h, the block stack from the item row down to the direct composer). Appended last for the
  // same reason: it leans on every token above and owns no classic selector.
  'css/views/steward-drawer.css',
  // 117e: steward settings layer (the settings modal's 管家 tab — six groups, memory panel, action-log
  // table — plus the shell header's shield and always-on stop button). Appended last for the same reason.
  'css/views/steward-settings.css',
  // 123-S1: settings modal redesign layer (left grouped nav + right content panel, wider dialog,
  // save-hint footer, ≤640px horizontal-nav collapse). Override-only: it owns the new
  // .settings-main/.settings-nav-label selectors and higher-specificity #settingsTabs overrides;
  // no existing layer's rules were touched. Appended right after the layer it visually extends.
  'css/views/settings.css',
  // 117g/117h: steward board layer (the one-line status, the drop-down board with its per-mission groups,
  // the docked "current one" rail, and the 2.0-window return band that lives in the classic pane).
  // Appended last for the same reason.
  'css/views/steward-board.css',
  // 121-K6a: quiet-card layer (the "one quiet card at a time" toast §4.3 relies on for the workbench
  // lens — its own sheet since it's the one place besides floating popovers allowed to use --glass-*
  // per §7.1's closing line). Appended last for the same reason.
  'css/views/quiet-card.css',
  // 135: prompt-dock layer (the bottom-right 'waiting for you' queue of thread questions and permission
  // requests, plus the queue status line inside those two modals). Appended last for the same reason.
  'css/views/prompt-dock.css',
  // 135c: background-tray layer (the per-thread 'background tasks' chip on the composer's top edge and the
  // rail '⟳N' mark for other threads). Appended last for the same reason.
  'css/views/background-tray.css',
  // W2: migration-center layer (the #migrationCenter block appended to the settings Integrations tab at runtime
  // and the one-time first-run card host #migrationCardHost shared by both lenses; the card itself reuses the
  // .quiet-card classes). Appended last for the same reason.
  'css/views/migration.css',
]);
const CSS_ROUTES = Object.freeze(CSS_PAYLOAD_GROUPS.flatMap(group => Array.isArray(group) ? group : [group]));
const CSS_COMPAT_ROUTES = Object.freeze(['css/views/chat.css']);
// ── CSS 载荷锁 LEGACY_STYLES_SHA256 ────────────────────────────────────────────────────────────────
// 钉的是 sha256(readLayerPayload()):CSS_PAYLOAD_GROUPS 各层去首行后按组拼接的整份载荷。消费方是
// frontend-domains.static D51 与 live-full-text.static F3 —— 任何一层 CSS 改动都会让它们双红,这是有意的:
// 改样式必须是【有意】的,并在这里留一条说明。
//
// 重钉流程(每次都照做):
//   1. 算法自证(先自证再替换):拦截 fs.readFileSync,让本文件自己的 readLayerPayload() 读改动前的
//      `git show HEAD:<css>`(或把新增的层从 CSS_ROUTES 里临时去掉)重算,结果必须与下面的旧值逐字相同;
//   2. 按工作区重算,把新值写进 LEGACY_STYLES_SHA256;
//   3. 反向验证:随手改坏一条规则,确认 D51 与 F3 当场红,再还原;
//   4. 在下面追加一条:「<波次> 重钉/续钉(前值 <旧值前 8 位>…):改了哪几层、为什么;算法自证:…」,
//      并把最老的一条挪进 read-frontend-css.PIN-HISTORY.md 末尾(这里只留最近三条)。
//   同一波里只让一处改 CSS 的改动自己重钉;几刀都动 CSS 时由主会话在都落地之后统一重钉一次。
// 更早的全部记录(第66波起,七百多行)见同目录 read-frontend-css.PIN-HISTORY.md。最近三条:
// 走查 U13 续钉(前值 22f8eb52…＝体验走查 #5 续钉):零新增、零删除层,改一层 ——
//   `css/components/tool-pane.css`:提示条 `.toast-tray` 点击穿透(pointer-events:none),管家视角下改到中栏输入框上方居中
//   (修前「引导完成」那条压着右栏底部的「停止」)。
// 算法自证:同上(HEAD 重算 = 22f8eb52…,与被替换的旧值逐字相同),按工作区重算得下面这个值。
// 走查 U17 续钉(前值 3afc1cb2…＝走查 U13 续钉):零新增、零删除层,改一层 ——
//   `css/layout.css`:980px 图标栏每行只留居中那一颗色点 —— 收起行头 8px 小点(`.steward-tcard-dot`)与行尾「⋯」。
// 算法自证:同上(HEAD 重算 = 3afc1cb2…,与被替换的旧值逐字相同),按工作区重算得下面这个值。
// N11 续钉(前值 62741739…＝走查 U17 续钉):零新增、零删除层,改一层 ——
//   `css/states/chat-live.css`:工具结果富渲染(`.tc-result-rich` / `.tc-res-meta` / `.tc-res-block` / `.tc-res-text` /
//   `.tc-res-more`):多行 stdout/stderr 画成真文本块、超 40 行折叠、截图缩略图复用既有 `.tool-image`。颜色全走既有 token,零新增动效。
// 算法自证:把 chat-live.css 换回 HEAD 重算 = 62741739…,与被替换的旧值逐字相同(先自证再替换);按工作区重算得下面这个值。
const LEGACY_STYLES_SHA256 = '8ace18e5b0371f34e63ea0426bf42268a1febff407c395caba2572fa3770b6ec';

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

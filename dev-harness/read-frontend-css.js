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
// 2026-10 mermaid 图表配色续钉(前值 5e1ed875…＝2026-10 chip 菜单往上翻续钉):零新增、零删除层,改两层 ——
//   `css/views/chat-narrative.css`:mermaid 灯箱 —— 幕布从 `--glass-bg-3`(浅色下 46% 白毛玻璃)换成两套主题都压暗的
//   `--viewer-scrim`;`.mermaid-lightbox-stage` 加实底卡片(`--panel-2` 底、`--line-2` 描边、圆角、投影;内边距由 JS 写)。
//   用户实报浅色下点开放大后光标糊在发白的背景与透明底图里、看不见。
//   `css/themes/color-schemes.css`:两套主题各加一个 `--viewer-scrim`(暗 rgba(8,12,20,.78) / 亮 rgba(20,28,44,.62))。
//   其余规则零改动;图本身的配色在 js/mermaid-runtime.js 的色板里(mermaid 只认十六进制,不走 CSS 变量)。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show 366ffa5:<两层>` 重算 = 5e1ed875…,与被替换的旧值逐字相同
// (先自证再替换);按工作区重算得下面这个值。
// 2026-10 mermaid 五路走查续钉(前值 331a296d…＝2026-10 mermaid 图表配色续钉):零新增、零删除层,改一层 ——
//   `css/views/chat-narrative.css`:`.mermaid-view svg` / `.mermaid-lightbox-stage svg` 收窄成子选择器 `> svg`
//   (修前 height:auto 也落在架构图 / 流程图图标那层嵌套 <svg> 上,计算高度撑成整图高、图标整排错位);
//   新增 `.mermaid-hint-detail`(回落提示下面那行解析器原话:等宽字、长行可断)。其余规则零改动。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show HEAD:<chat-narrative.css>` 重算 = 331a296d…,与被替换的旧值
// 逐字相同(先自证再替换);按工作区重算得下面这个值。
// 61 号文 C3 记忆批量卡续钉(前值 18e23fa1…＝2026-10 mermaid 五路走查续钉):零新增、零删除层,改一层 ——
//   `css/states/chat-live.css`:记忆候选卡下面加批量卡的几条(`.memory-proposal-items` / `-item` / `-item-head` / `-pick` /
//   `-body` / `-body-text`):每条一行、行间细分隔线,勾选框与名称同一行,正文收在 <details> 里(限高可滚)。
//   颜色全走既有 token / color-mix,零新增动效;单条卡的规则零改动。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show HEAD:<chat-live.css>` 重算 = 18e23fa1…,与被替换的旧值
// 逐字相同(先自证再替换);按工作区重算得下面这个值。
const LEGACY_STYLES_SHA256 = 'ecad3e8fd7b70f515a92fe26cfb8cb2aec20c5c6615cb2c2d5f160db0e0f8836';

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

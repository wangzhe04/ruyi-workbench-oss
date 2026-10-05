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
// 61 号文 C3 记忆批量卡续钉(前值 18e23fa1…＝2026-10 mermaid 五路走查续钉):零新增、零删除层,改一层 ——
//   `css/states/chat-live.css`:记忆候选卡下面加批量卡的几条(`.memory-proposal-items` / `-item` / `-item-head` / `-pick` /
//   `-body` / `-body-text`):每条一行、行间细分隔线,勾选框与名称同一行,正文收在 <details> 里(限高可滚)。
//   颜色全走既有 token / color-mix,零新增动效;单条卡的规则零改动。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show HEAD:<chat-live.css>` 重算 = 18e23fa1…,与被替换的旧值
// 逐字相同(先自证再替换);按工作区重算得下面这个值。
// 2026-10 3.0 收口走查第一波续钉(前值 ecad3e8f…＝61 号文 C3 记忆批量卡续钉):零新增、零删除层,真浏览器走查的布局修复改八层 ——
//   `css/views/steward-shell.css`:≤1180 容器查询里补一条与基础规则同选择器的「右栏不占列」(修前特异度输掉,1024 宽中栏 364px＋392px 死列);
//   `css/views/chat-shell.css`:线程头管家条可收(flex 0 4 auto)、线程名基准 10em(英文下线程名被挤成 0);
//   `css/components/chat-primitives.css` / `css/components/onboarding.css`:拖放区按钮 white-space:normal、向导说明 overflow-wrap:anywhere、
//   向导当前步与手册语言钮文字改 --link;`css/views/settings.css`:设置导航当前项文字改 --link(暗色 accent 3.0:1);
//   `css/views/steward-settings.css`:星期勾选 / 筛选标签里的 input/select 不吃 width:100%;`css/views/workspace.css`:审计时间线类型名可收;
//   `css/views/chat-narrative.css`:markdown 表格单元格 min-width 4.5em;`css/base.css`:复选框 / 单选框 :focus-visible 实线焦点环;
//   `css/layout.css`:齿轮菜单里的能力矩阵去掉胶囊边框底色。其余规则零改动。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show 9bbe566:<css>` 重算 = ecad3e8f…,与被替换的旧值逐字相同
// (先自证再替换);按工作区重算得下面这个值。
// 2026-10 3.0 收口走查第一波 · 杂项续钉(前值 c9f20392…＝收口走查第一波续钉):零新增、零删除层,改两层 ——
//   `css/views/workspace.css`:文件树文件行的 @ 钮不再吃 button 的 min-height / .tool-section 的 margin(文件行 42px → 22px,与目录行齐),
//   新增 `.ftree-main`(文件行可聚焦主体)与 @ 钮 :focus-visible / 行 :focus-within 时可见;
//   `css/views/settings.css`:竖排设置导航允许长英文标签折行、导航列不出横向滚动条,≤640px 横排仍 nowrap。其余规则零改动。
// 算法自证:拦截 fs.readFileSync 让 readLayerPayload() 读 `git show 9f22cb4:<css>` 重算 = c9f20392…,与被替换的旧值逐字相同
// (先自证再替换);按工作区重算得下面这个值。
const LEGACY_STYLES_SHA256 = '8c959d30b5bb83183e832ca30fb3fc35e68d043a1e87bdde4c6b15044109d136';

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

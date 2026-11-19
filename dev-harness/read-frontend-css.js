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
// 151 阶段 1 批 1D 续钉(前值 567eb433…):chat-composer.css 追加维护期输入框说明条两条规则(U3)、chat-live.css 追加记忆尾标六条规则(U4)、
// settings.css 追加「需要重启如意」一条规则(U3)、tool-pane.css 的 .toast 一条规则改为 max-width:min(340px,100vw-36px) 并加 overflow-wrap/max-height(U3 toast 溢出)。
// 算法自证:四层内存读取替回 HEAD 字节时精确复现 567eb433e320bb76d43488dd401ce3de4d983130b6a4b8e6c3332f951f09bb2f;反向检查:内存里改坏 .memory-check-badge 一条规则得到不同摘要。
// 若同阶段其他批也改 CSS,由主会话合并后统一重钉。
// 151 阶段 1 批 1E 续钉(前值 716d1eee…):仅 steward-conversation.css 追加一条规则 `.steward-composer > .maintenance-composer-notice`
// (管家胶囊里的维护期说明条整行独占、圆角收进胶囊;复审建议 4),其余各层逐字未动。算法自证:只把 steward-conversation.css 的内存读取
// 替回 HEAD 字节时精确复现 716d1eeeab9d05cf3382b100cabe1a8ac192510baf403f822a67a8eba280bf3f;反向检查:内存里把该规则 flex 改成 1 1 99% 得到不同摘要。
// 151 阶段 3B 续钉(前值 683c4dc9…):仅 settings.css 追加三条规则(.work-data-confirm 启用加密二次确认、其 ul 与 .work-data-blockers 列表缩进、确认段内按钮行间距;150 W14)。
// 算法自证:只把 settings.css 的内存读取替回 HEAD 字节时精确复现 683c4dc9bed7f2b60ccc9f63a0e231e7cd0c0c68e62210c778f7bb3c56a30e88;反向检查:内存里把 .work-data-confirm 的 display:grid 改成 flex 得到不同摘要。
// 若同阶段其他批也改 CSS,由主会话合并后统一重钉。
// 151 阶段 4 批 4C 续钉(前值 9dea71e9…):三层只追加规则、未改既有规则 —— steward-shell.css 首屏定形闸 [data-boot] 一组(150 U8:头部/对话流/右栏定形前 visibility:hidden、1.5 s 延时动画兜底、减少动效时不设闸、定形期间栅格不过渡)；
// settings.css 的 .setcat-status 四条(150 U10 语义开关行的模型状态句)；tool-pane.css 的 .memory-search-note 一条(150 U7 搜索范围说明)。
// 算法自证:只把这三层的内存读取替回 HEAD 字节时精确复现 9dea71e9220cc7e2a39d093371e78d8cd82b85493ba772349750c05055521a10;反向检查:内存里改坏一条规则即得不同摘要(D51/F3 当场红)。
// 若同阶段其他批也改 CSS,由主会话合并后统一重钉。
const LEGACY_STYLES_SHA256 = '37ea6107742af0d613e3f6ece9891c89030c75aef079d7878acf70a5e6ccb0d4';

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

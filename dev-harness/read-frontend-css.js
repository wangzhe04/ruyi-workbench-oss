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
// 2026-10 班组体验走查续钉（前值 76316e75…）：workbench.css 新增概览、角色优先、容器响应式详情及窄屏用量布局；tool-pane.css 保持分类可见、统一标题与按钮间距、显示关闭入口；workbench.css 补历史选择与抽屉网格定位；workspace.css 将审计摘要独立成行。
// 算法自证：readLayerPayload 读取 git show HEAD 各层得 76316e7541ef3085246d01c76fb3201359dee9aec3e0a2de5315cdcf895f2193，与旧锁一致。
// 反向验证：仅在读文件时注入错误的 .wb-node opacity，D51 与 F3 均变红；磁盘样式未修改。
// 2026-10 AI 工作精简续钉（前值 29a7e758…）：workspace.css 新增模板与运行详情折叠入口样式，当前进度可换行，运行列表使用工具箱的单一滚动区域。
// 算法自证：readLayerPayload 读本轮改动前的 CSS 快照重算 = 29a7e758ddf3d119394c7f9f740c3d3dd9701e42ddb6e0aa7b3a667b952125da，与旧锁逐字相同。
// 反向验证：内存注入错误样式后 D51/F3 均失败；实际 CSS 文件未改坏。
// 2026-10 62号运行故障与读取质量续钉（前值 e8b78800…）：仅workbench.css增加两视图共享紧凑故障/读取质量横幅，复用主题token和折行，不改布局骨架。
// 算法自证：readLayerPayload读取git show HEAD各层得e8b7880080aa4fe5ee0b7d97bfe60457039ef070649e76fba83055af3b56a67c，与旧锁一致。
// 反向验证：内存注入错误CSS后D51与F3失败，磁盘样式未修改。
// 65: shared Steward read/fault notices use existing theme tokens and compact wrapping.
// Prior HEAD layer payload self-check: 3f3d1fb3cb89fc04e07f91d2aade10958bc4d8935dcd6d93ce647c4101ac35bc; in-memory corrupt-layer probes must fail D51/F3.
// 66: compact external bot connection/inbox styles use existing typography and theme tokens.
// Prior HEAD payload self-check: ef77e97b6ccffed3f9d89d2c09bbc67b32d49db39397649114f0898ccfb9a97d; corrupt-layer probes must fail D51/F3.
const LEGACY_STYLES_SHA256 = 'e82f59d0cbf970fa8b94263409d8cf83bdfeea29bb9682ec19e6c00b17b69daa';

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

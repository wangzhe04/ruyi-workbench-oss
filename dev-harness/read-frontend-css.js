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
  'css/views/preview-shell.css',
]);
const CSS_ROUTES = Object.freeze(CSS_PAYLOAD_GROUPS.flatMap(group => Array.isArray(group) ? group : [group]));
const CSS_COMPAT_ROUTES = Object.freeze(['css/views/chat.css']);
// 第66波修复:845bb8c 把 chat.css 拆成 5 个聊天层文件并改了载荷拼接,却漏更新本锁 → D51 自 HEAD 起恒红。
// 逐行 diff 旧单体载荷(f667405d…) vs 新分层载荷:仅丢 2 行空行(拆文件后组内以 '' 拼接,原段间空行随边界消失),
// 0 条规则漂移,符合 D51「无 CSS 漂移」本意。第76波新增独立 preview-shell 层；第77波在同层
// 加全宽任务单/原始镜头/只读收活台布局后重钉载荷 SHA，经典样式路由与规则未改。
// Wave 78 extends the same owned layer with the dispatch home, confirmation card, familiar-work shelf,
// responsive containment, and the verified celadon/glacier dual-theme redesign. Wave 79 adds the deterministic
// return log and grouped archive ledger in that same isolated Preview layer. Wave 80 adds only recovery-action
// spacing and narrow-rail containment to the owned Preview layer. Wave 81 adds the global Needs-you drawer,
// in-place approval confirmation, typed-question, stopped-result, and 390px containment styles. Wave 82 adds
// the bounded crew-stage map, asymmetric member badges, inline note composer, and vertical narrow-screen flow.
// Wave 83 adds the three-lens switch, append-only duty-log timeline, expandable evidence rows, responsive
// teleprinter flow, and the shell-neutral local-notification settings block.
// Wave 84 adds the scoped Mission/Run telegraphs, inline confirmations, and bounded checkpoint flight-recorder
// tape in the same isolated Preview layer; classic chat/style layers remain unchanged.
// Wave 85 adds the closeout dossier, aligned option-first question rows and context note, a dock create seal,
// the classic-to-desk switch, and responsive provider model-pricing rows in their owning layers.
// Wave 86 unifies the Preview palette to brand qinghua-blue + gold (retiring the celadon/orange accents),
// adds the live activity-brief bar with blue/gold pulse, and lists result artifact filenames in the same
// isolated Preview layer; classic chat/style layers remain unchanged.
// Wave 87 polishes dispatch-home/task-sheet UX in the same owned Preview layer only: auto-growing dispatch
// box (no more 166px empty block), compact pill metrics, mini progress bars on continue cards, denser
// shelves, clearer dock-seal focus and lens tabs, reduced-motion containment. No structure class removed.
// Wave 88 lands the verified findings of a 5-way deepseek-v4-flash read-only UX audit (IA / interaction /
// a11y / visual-state / lifecycle): fixes confirmation-rail cross-task bleed, extends reduced-motion to all
// infinite pulses + loading spinner, colors the done seal green and per-state progress bars, makes the
// activity brief a clickable needs entry, hides the control deck on terminal tasks, adds a loading spinner,
// Esc-closes confirmations, and completes finish/stop card unfinished details. Same owned Preview layer.
// Waves 95-98 add Preview-only quick actions, follow-up and attachment controls, task-sheet polish, and
// live narrative motion. Re-pin the intentional payload while keeping every classic style layer unchanged.
// Wave 99 separates dock navigation from hover actions, folds the artifact explorer, and gives the task
// continuation footer its own responsive visual hierarchy. Classic layers remain unchanged.
// v1.8.2 adds the provider "协议与能力" collapsed group (.prov-cap) styles next to its sibling .prov-adv
// in the classic chat-shell layer (provider settings UI lives there). Re-pin the intentional payload.
// Perf 波（聊天卡顿/滚动修复）：chat-primitives.css 的 .messages 移除 scroll-behavior:smooth
// （流式跟随时程序化滚动的 smooth 动画会派发跨帧 scroll 事件风暴、误杀"跟随最新"粘性），
// chat-live.css 的 .think-body 增加 contain: layout style（超长思维链重排不再冒泡整条消息树）。
// 两条均为有意样式变更，重钉载荷锁。classic 层规则无漂移。
// 未完成任务横幅新增可关闭按钮；规则留在 chat-composer 所有权层，并保持 token 化字号/颜色。
// P2 波（归档页/原始镜头性能）：preview-shell.css 的 .preview-archive-card 加 content-visibility:auto
// （无界归档列表跳过离屏卡片渲染，contain-intrinsic-size:auto 记忆实际尺寸减少滚动漂移）+ .preview-seal-ring
// 加 contain: layout style paint（隔离 conic-gradient 重绘到 46x46 自身边界）。两条均为 Preview 层有意样式
// 变更，重钉载荷锁。classic 层规则无漂移。
// 滚动抖动修复波：.messages 加 overflow-anchor:none（滚动完全由 chat-scroll 粘性控制器接管，关掉浏览器
// 原生 scroll anchoring 与程序化跟随互相拉扯导致的流式上下抖动）+ scrollbar-gutter:stable（滚动条出现/
// 消失不再改内容宽度）；.think-body 与 .preview-raw-messages 同加 overflow-anchor:none（内层/原始镜头跟随
// 同理独占滚动写入）。三条均为有意样式变更，重钉载荷锁。
// 工作区信息架构刷新：tool-pane.css 将 6 个用户入口收束为稳定三列，补充面板标题、自然语言提示、
// 设置体检折叠区和移动端关闭按钮样式；均为工具面板所有权层的有意变更，重钉载荷锁。
// 第100波任务单三段式重构只改 Preview 所有权层，并把浅色任务台收敛为暖月白纸面；经典层未改。
// 2026-08-10 af028e7 只在 Preview 所有权层稳定历史报告与 dock 操作；补钉当时遗漏的载荷锁。
// 2026-08-11 变更中心增加本机 Diff 的整轮操作组布局；仅 workspace 所有权层变化。
// R4-S3 增加低打扰记忆候选卡；规则只进入 chat-live 所有权层，未改变既有选择器语义。
// 2026-08-12 工具箱新增核心记忆管理模块；全部规则限定在 tool-pane 所有权层并保持 token 化与窄屏约束。
// 第101波 (workspace permissions): tool-pane.css 新增工作区权限管理列表样式(.workspace-perm-*)，
// 均为 tool-pane 所有权层的有意变更，重钉载荷锁。classic/Preview 其它层未改。
const LEGACY_STYLES_SHA256 = '1e241c3152bec40a5957b66dd5bb20d4fc90baf2e010b709df65040fc9ae9000';

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

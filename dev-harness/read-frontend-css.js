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
// v2.7.2 (常用工作区优先级): workspace.css 新增 .wp-fav-* popover 列表与 .ws-fav-* 文件面板 chips 样式，
// 均为 workspace 所有权层的有意变更，重钉载荷锁。
// v2.6 通用压缩模型选择器在 chat-shell 所有权层增加标签/下拉框三条规则；仅为上下文弹层布局，
// 不改变其它经典或 Preview 层选择器，重钉有意载荷。
// 109b905 (session experience/attachment UI): chat-primitives adds .msg-attachment-* strip/thumb rules,
// chat-composer adds .attachment-pill thumb + .ask-countdown countdown rules. Same owned layers, re-pin payload lock.
// 109a: chat-narrative.css 追加 mermaid 图表块样式(.mermaid-block/.mermaid-view/.mermaid-tools/.mermaid-hint)。
// 全部为该所有权层的新增规则,未改动任何既有选择器;token 化配色,亮暗双主题共用。重钉有意载荷。
// 109b: chat-live.css 追加工具结果图内联缩略图样式(.tool-image/.tool-image img/.tool-image.expanded/
// .tool-image-toggle/.tool-image-openbtn)。全部为该所有权层的新增规则,未改动任何既有选择器;
// token 化配色,亮暗双主题共用。重钉有意载荷。
// 118a: new owned layer css/components/onboarding.css (welcome wizard dialog, step rail, choice cards,
// live status line, 390px + reduced-motion containment). Additive only: no existing layer's rules were
// touched, the link/@import/overlay order gained exactly one trailing entry. Re-pin the intentional payload.
// 118a-fix: the in-app manual reader's .help-viewer-* rules were appended to the SAME already-registered
// layer (css/components/onboarding.css) rather than opening a new sheet, and two now-dead rules for the
// retired path/copy affordance (.onboard-wiz-manual-path) were removed. Additive plus that deletion: no
// other layer's rules were touched and the link/@import/overlay order is unchanged. Re-pin the payload.
// 118b: 人话体检的样式全部落进【已注册的所有权层】,不新开样式层 -- 体检行(.h-head/.h-pill/.h-next/
// .h-tech/.health-summary-line)进 tool-pane.css(体检面板本来就归它),首跑卡的 .health-summary-chip
// 进 chat-primitives.css(空态/首跑卡所有权层),侧栏「设置」按钮上的 .health-entry-dot 进 layout.css
// (.sidebar-foot 所有权层)。三处均为纯新增规则,未改动任何既有选择器;link/@import/overlay 顺序不变。
// 重钉有意载荷。
// 118d/118g: 常驻帮助菜单(.help-menu*)、设置页签排尾的「?」(.settings-tab-help)与应用内日志面板
// (.help-logs-*)的规则同样追加到【已注册的】css/components/onboarding.css 层(118 波自己的层),
// 不新开样式表。纯新增规则,未改动任何既有选择器;link/@import/overlay 顺序不变。重钉有意载荷。
// 118e/118c: 又一批规则追加进【已注册的】css/components/onboarding.css 层(本波自己的层),不新开样式表 ——
// 向导状态行从纯文本变成可带一个应用内动作按钮(.onboard-wiz-status-action)、设置页 Provider 卡的
// 「免 Key」小字与同款按钮(.prov-key-optional / .prov-local-manual)、以及 118c 的启动提示条
// (.start-notice*,含 520px 收敛)。纯新增规则,未改动任何既有选择器;link/@import/overlay 顺序不变。
// 重钉有意载荷。
// 118f: 向导面板 .modal.onboard-wizard 由玻璃档改实底(background: var(--panel) + backdrop-filter: none),
// 与本层已有的 .modal.help-viewer / .modal.help-logs-modal 同一判断 —— 玻璃档只有 8.6% 不透明度,背后
// 首跑卡的大号标题会整段透上来(118a 与 118f 两次真机走查都看到,计算样式实测确认非动画残留)。
// 只改本层这一条规则,不动全站浮层口径;link/@import/overlay 顺序不变。重钉有意载荷。
// 112b/112c: 三个【已注册的所有权层】各加了一小段纯新增规则,不新开样式表 —— composer 层拿到统一活动
// 状态条(.turn-activity*),chat-live 层给工具卡片状态与子代理状态行补上此前缺失的 warn 档(只有 ok/err
// 两色时,时间预算软警告只能借用错误红,语义不对),preview-shell 层给任务单指标条的「上下文」电量按水位改色。
// 三处均未改动任何既有选择器;link/@import/overlay 顺序不变。重钉有意载荷。
// 113b: layout.css 的 .sidebar 所有权层追加一条纯新增规则 —— 侧栏搜索命中的正文摘录行
// (.session-item .s-snippet)。未改动任何既有选择器;link/@import/overlay 顺序不变。重钉有意载荷。
// 117a: new owned layer css/views/steward-shell.css (the third shell mode's mode/container skeleton:
// three-shell mutual exclusion by :root[data-shell-mode], header/feed/composer/status slots, 390px and
// reduced-motion containment). Additive only: no existing layer's rules were touched, and the
// link/@import/overlay order gained exactly one trailing entry. Re-pin the intentional payload.
// 117b: the header's avatar placeholder (.steward-avatar-slot) is retired from steward-shell.css (its
// two rules removed) and replaced by a real avatar; the seven-state 2D avatar itself (ring/body/eyes,
// per-state animation, reduced-motion containment) lands in a new owned layer css/views/steward-avatar.css
// appended last for the same reason as every other owned layer. Net: one deletion + one new layer.
// Re-pin the intentional payload.
// 117c: one more new owned layer, css/views/steward-conversation.css (the steward conversation feed's
// bubbles / one-row action buttons / ※ popover / "···" placeholder, plus the composer's hand-off target
// chip and candidate listbox). Additive only: no existing layer's rules were touched, and the
// link/@import/overlay order gained exactly one trailing entry. Re-pin the intentional payload.
// 117d: one more new owned layer, css/views/steward-drawer.css (the thread drawer's container and the
// eleven-block stack, plus the quick-switch chips shared by 117d/117g/117h). Additive only: no existing
// layer's rules were touched, and the link/@import/overlay order gained exactly one trailing entry.
// Re-pin the intentional payload.
// 117e: one more new owned layer, css/views/steward-settings.css (the settings modal's steward tab: the
// six groups, the memory panel, the action-log table; plus the shell header's shield and always-on stop
// button). Additive only: no existing layer's rules were touched, and the link/@import/overlay order
// gained exactly one trailing entry. Re-pin the intentional payload.
// Waves 117g/117h append the steward board layer (one-line status, the drop-down board, the docked
// "current one" rail and the 2.0-window return band). Additive only: no existing layer's rules were
// touched, and the link/@import/overlay order gained exactly one trailing entry. Re-pin the payload.
// 117i（管家壳视觉对齐 115 波定稿原型 docs/mockups/steward-shell.html）重钉：改动全部落在管家壳
// 自己的五个所有权层（steward-shell / steward-avatar / steward-conversation / steward-drawer /
// steward-settings / steward-board），外加 tokens 层的两套主题各补三枚语义「极淡底」
// （--gold-soft / --ok-soft / --danger-soft，theme.e2e 的键集对称锁照旧）。
// 无新样式层、link/@import/overlay 顺序不变，经典与 Preview 层规则零漂移。重钉有意载荷。
// 117 走查修正（用户 2026-09-06）重钉：steward-avatar.css / steward-settings.css 头注释里的
// 「--dur-*/--ease-out」把注释提前关掉、吞掉了各自后面的第一条规则（头像被撑到 300 多像素），改写注释；
// steward-conversation.css 末尾追加按钮与候选项的一行截断。既有层规则零改动。
// 117j（前端走查修复，用户 2026-09-06 第二轮走查 W2-2/W2-3）重钉，两处都落在管家壳自己的所有权层：
//   · steward-conversation.css：① 补 .steward-target-picker[hidden]{display:none} —— 上面那条 display:flex
//     是作者样式，压过了 UA 表的 [hidden]，JS 写的 picker.hidden 只改了 DOM 没改屏幕（W2-2「候选列表
//     关不掉、进壳就自己弹出来」的根因）；本仓已有四处同款守卫（.steward-drawer / .steward-chip-menu /
//     .steward-shield-menu / .steward-now），这里补上漏掉的第五处。② W2-3 的 36px 头像槽
//     （.steward-avslot，绝对定位，历史消息靠 :empty::before 画静态点）。
//   · steward-shell.css：W2-3 头部那枚 6px 状态点（.steward-presence-dot，七态颜色与 avatar 层同令牌）。
// 无新样式层、link/@import/overlay 顺序不变，经典与 Preview 层规则零漂移。重钉有意载荷。
// 117k(用户走查:「每次切进管家壳都冒出那张有设置的小纸」)重钉,一处,仍落在管家壳自己的所有权层:
//   · steward-conversation.css:补 .steward-menu[hidden]{display:none} —— 与上面 W2-2 同一条根因的
//     第六处。头像菜单建出来就 menu.hidden = true,可 .steward-menu 那条 display:flex 是作者样式,
//     压过 UA 表的 [hidden] —— 于是它一直画在屏幕上盖住问候语,Esc 与点菜单项都关不掉(只改了 DOM)。
// 无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
//   · 再加一处定位锚（.steward-menu 的 top/left 与 .steward-header 的 position:relative）:
//     这张菜单原先没有 top/left，用的是「静态位置」，实测落在 y=-20px 首项被窗口上沿切掉。
// 117l-B1（用户第四轮走查①③④⑥）重钉，全部落在管家壳自己的三个所有权层，经典与 Preview 层零漂移。
// steward-conversation.css（走查④⑥）：
//   · .steward-why-h —— ※ 浮层里「依据／已办」两个小标题（走查④：※ 没有标明标题）；
//   · .steward-msg-user.is-queued 与 .steward-queued —— 连发时排队那一行的淡化档与右下角小标
//     （走查⑥：管家在流时用户的第二句此前被静默丢弃，现在立刻上屏并标「排队中」）；
//   · .steward-composer-note —— 队列满时输入区下面那一行小字（绝对定位，不进胶囊那一行 flex）。
// steward-drawer.css（走查①③）：
//   · .steward-drawer-ask 一族 ——「它在问你」卡（浅金底，与主动作同色系）＋ 必配的
//     .steward-drawer-ask[hidden]{display:none} 守卫（作者 display:flex 会压过 UA 表的 [hidden]，
//     这是本仓第七处同款根因）；
//   · .steward-drawer-more / -summary ——「更多」折叠区（走查③「线程页内容太多太杂」）。
//     注意它【故意】不给 <details> 写 display:flex —— 那会让收起来的内容照样画出来；
//   · .steward-drawer-btn.is-primary —— 问答卡那枚「回答」的金色档。
// steward-board.css（走查①）：
//   · .steward-board-pill.is-asks-you —— 行上「它在问你」的可点 pill。
// 无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
// 117l-B2 第①批（用户第五轮走查 1／3／4）重钉，三个所有权层，经典与 Preview 层零漂移。
// steward-avatar.css（走查 1「线程返回信息给管家时，最好给 avatar 一个小动效」）：
//   · .steward-avatar 加 position:relative（光环 ::after 的定位上下文，对布局零影响）；
//   · 一次性类 .is-nudged —— ::after 一道 600ms 扩散光环 ＋ .sa-body 一次 1→1.06→1 的起伏，
//     两个 @keyframes（sa-nudge-halo / sa-nudge-bob）；reduced-motion 分支里只关起伏、留光环
//     （摘类靠 animationend，两个都关掉的话事件永远不来，类会永远挂着）。七态枚举一个字没动。
// steward-conversation.css（走查 3「为啥点 Avatar，显示面板是在最上面」＋ 走查 4「边边那个点」）：
//   · .steward-menu 从 absolute+top:100%（117k 的顶栏锚点）改成 fixed，锚点由 JS 按头像 rect
//     逐次写行内样式；[hidden] 守卫原样保留；
//   · .steward-avslot:empty::before 那条「历史行画 8px 灰点」整条删除（走查 4 说的就是它）；
//   · 新增组呈现：.steward-feed 的 gap --sp-4 → --sp-1，.steward-msg 补 margin-top --sp-3
//     （两者相加＝原来的 16px，组与组之间一个像素没变），.steward-msg-ruyi:not(.is-group-start)
//     归零；组的左侧 2px 淡竖线（::before，含头像所在最新组的 :has() 排除）；
//   · .is-stale 行的 act 幽灵档（只改样式，不 disabled、不 pointer-events:none）。
// steward-shell.css：只改了 .steward-header{position:relative} 那一条的注释（说明它不再是菜单的锚）。
// 无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
// 117l-B2 第②批（用户第五轮走查 2「这个限制界面（看板）优化美观一下」）重钉，只动 steward-board.css
// 这一个所有权层，经典与 Preview 层零漂移：
//   · .steward-board-top 从一排裸文字变成一条玻璃底 toolbar（--glass-bg-3 + 圆角边框），
//     新增 .steward-board-maxwrap（带标签的并发数胶囊，48px 输入框、focus-within 高亮）与
//     .steward-board-tools（两个动作键推到右侧）；
//   · .steward-board-pill 加 is-live／is-quiet 两档（在跑一颗 --accent 色点、排队安静），
//     并补 :empty{display:none}（首帧还没数字时不留一枚空胶囊）；
//   · .steward-board-btn:disabled（「全部暂停」没东西可暂停时的灰档）；
//   · .steward-board-mission 从「细分隔线上的一行小字」改成一张玻璃卡，卡头 meta 用「·」相连；
//   · .steward-board-thread 缩进 --sp-4、行间 1px 分隔线、hover 微亮；线程名 min-width:5em 且
//     .steward-board-thread-head 可换行（390px 下不换行会把名字挤成 0 宽，实测截图里名字消失）；
//   · .steward-board-pill.is-asks-you 从金色实底改成金色描边 + --gold-soft 极淡金底；
//   · .steward-board-empty 从一行灰字改成「一句话 ＋ ＋线程」的虚线框空态；
//   · 390px 与 reduced-motion 两个既有分支各补了本波新增的那几条。
// **一条 backdrop-filter 都没加**：toolbar 与事项卡只用玻璃底色，同屏模糊预算（§3.2-E，
// ui-v4-glass G2 的使用点白名单）一个字没动。无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
// 117m-A5（用户第六轮走查①「点开线程的看全文，还是啥也看不到」）重钉，只动 css/states/chat-live.css
// 这一个【已注册的】所有权层（在途回合本来就归它），文件末尾追加 12 条纯新增规则：
//   · .message.live-turn .avatar.live-turn-avatar / .message.live-turn .msg-main —— 在途回合那张
//     临时气泡的虚线边界与弱底色（它长得就该和落盘消息不一样，用户一眼看出「这还没定稿」）；
//   · .live-turn-title / .live-turn-iter(+:empty) —— 标题行与「第 N 轮工具」；
//   · .live-turn-body(+.is-empty) —— 正文（pre-wrap、420px 封顶自滚，长回合不把页面撑爆）；
//   · .live-turn-tool —— 「正在用：<工具名>」一行；
//   · .live-turn-actions / .live-turn-stop(+:hover:not(:disabled) / :disabled) —— 「停止」。
// 全 token 化配色、零动画（故不需要 reduced-motion 分支）、无新样式层、link/@import/overlay 顺序不变，
// 其余每一层规则零漂移。重钉有意载荷。
// 117m-A2（用户第六轮走查⑤⑥「需要我允许的也没在线程中」）重钉，只动两个【已注册的】所有权层，
// 全部是纯新增规则，其余每一层零漂移：
//   · css/views/steward-drawer.css —— 「它在问你」卡片吃下 permission/plan/pool 之后多出来的四组：
//     .steward-drawer-ask-meta(+[hidden])、.steward-drawer-ask-meta-line
//     (+[data-revertible="0"] 用 --warn 说「这一步无法自动撤销」)、.steward-drawer-ask-answer
//     (+[hidden]，permission 那三类把自由输入整块收起)；
//   · css/views/steward-board.css —— 状态行旁边那枚「去处理」：.steward-status-needsyou
//     (+[hidden] 守卫 / :hover / :focus-visible)，金色描边族，与行上的「它在问你」pill 同色系。
// 两处都是 token 化配色、**零 transition**（故 reduced-motion 的关闭清单一个字没加）、无新样式层、
// link/@import/overlay 顺序不变。重钉有意载荷。
// 117n-M1③（用户「看板圆点看不出已完成」走查）重钉，只动 css/views/steward-board.css 这一个
// 【已注册的】所有权层，纯新增规则，其余每一层零漂移：
//   · .steward-board-dot[data-tone="settled"] —— 看板圆点第四档「已完成」，复用抽屉 done 那一档
//     同一个语义 token（--ok），不新造颜色；只在 paintDot 显式传 settleDone:true 时才会出现。
// 无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
// 117o-A7（用户第七轮「为啥这个查看全文，不能像 2.0 那样显示呢」）重钉，只动
// css/states/chat-live.css 这一个【已注册的】所有权层，纯新增两条规则，其余每一层零漂移：
//   · .live-turn-narrative —— 在途回合正文的宿主（内容由 renderStaticMessage 生成，与落盘助手消息
//     同一个渲染器），只给一个 max-height:520px + overflow:auto 的滚动上限，不带任何排版意见；
//   · .live-turn-truncated —— 「更早的内容已省略」那一行，--muted + --fs-xs，零新颜色。
// 无新样式层、零 transition（reduced-motion 关闭清单一个字没加）、link/@import/overlay 顺序不变。
// 117r-D3／D4 重钉（**一次钉两刀**：这两刀同波各改一个【已注册的】所有权层，而本常量是全部 CSS 层的
// 联合载荷哈希 —— 两边各自重钉必然撞车，所以两刀都不碰它，由主会话在双双落地之后统一钉一次）：
//   · css/states/chat-live.css（117r-D4，用户第八轮走查④「为啥在运行时会显示这段对话是在一个框里」）：
//     - `.message.live-turn .msg-main` 整条【删除】（虚线边框＋弱底色＋内边距）—— A5 当初加它的理由是
//       「长得就该和落盘消息不一样」，而 117o-A7 把正文换成 renderStaticMessage()（画落盘助手消息的
//       同一个渲染器）之后，这圈框成了唯一的差别，读起来不是「草稿」而是「窗中窗」；
//     - `.live-turn-narrative` 整条【删除】（原 max-height:520px + overflow:auto）—— 那条内滚动条正是
//       用户看到的子窗口；宿主自此一条规则都不剩，名副其实地不带任何排版意见；
//     - `.live-turn-body` 去掉 max-height:420px + overflow:auto（同上，A5 那条回落路径的正文）；
//     - `.live-turn-title` 从「粗体 --fs-md / --ink-2」降成状态行（--muted + --fs-xs，取值对齐
//       chat-primitives.css 的 .msg-head .when）。零新颜色、零新 token。
//   · css/views/steward-shell.css（117r-D3，用户第八轮走查②「不要和输入框放同一行，会把输入框内容挤没」）：
//     - `.steward-composer` 从单行 flex 改成 flex-direction:column + align-items:stretch（chip 一行、
//       输入行一行）；
//     - 新增 `.steward-composer-row`（第二行：input/plus/send）。**刻意不声明 position** ——
//       #stewardTargetPicker 的定位基准仍是 .steward-composer 自己。
//   · css/views/steward-conversation.css（117r-D3）：
//     - `.steward-target` 加 align-self:flex-start（column 布局下不被拉成整行宽的大按钮）与 max-width:100%；
//     - 新增 `.steward-target-label`（min-width:0 / overflow:hidden / text-overflow:ellipsis）——
//       标题截短（steward-composer.js 走 stewardShortTitle）之外的第二道兜底；
//     - `.steward-target-clear` 加 flex:0 0 auto（× 不许被省略号吃掉，它是「关掉这次匹配」的唯一出口）；
//     - 删掉 620px 断点里的 `.steward-target { max-width: 45vw }` —— 那是「chip 与输入框同行」时代的
//       硬编码，现在整行都归 chip，留着就是一个脱节的断点。
// 三层都是既有所有权层，无新样式层、无新硬编码色（全 token / color-mix）、零新增 transition
// （reduced-motion 关闭清单一个字没加）、link/@import/overlay 顺序不变。重钉有意载荷。
// 117s-C（用户第九轮走查⑦「输出要支持 markdown、制图」／27 号文 §11.13 D5）重钉，只动
// css/views/steward-conversation.css 这一个【已注册的】所有权层，纯新增规则，其余每一层零漂移
// （本波只有这一刀碰 CSS，不存在 117r-D3/D4 那种「两刀各钉一次必撞车」的情形，故由本刀自己钉）：
//   · `.steward-say.md` —— 管家的话改由【注入的】共享渲染器（chat-render-primitives 的
//     renderMarkdownInto ＋ highlightIn）上屏之后，节点带 `md` 类：标题／段落／列表／引用／代码块／
//     表格／mermaid 的排版【整套复用】 chat-narrative.css 的 .md 与 .mermaid-* 两族（同源取值，
//     零新配色、零新 token）。本层只补它们没有、或在气泡里必须收口的三件：
//       - white-space:normal ＋ min-width:0（纯文本时代的 pre-wrap 会把块间换行画成真空行；
//         min-width:0 是「宽内容能在 flex 子项里收窄」的前提）；
//       - h4（.md 只写到 h3，h4 会掉到浏览器缺省的粗体＋大外边距），取值照 h1-h3 那一族；
//       - table / pre / .mermaid-block / .mermaid-view / img 的 max-width:100%
//         —— 它们各自本来就带 overflow-x:auto，这一刀只保证横滚发生在【气泡内部】，
//         不会把 .steward-msg 撑开、进而顶宽整页。
//   · `.steward-source` —— 收件箱触发的那条回复顶上那枚「来自线程『X』」小头（点它＝
//     steward:focus-thread）。安静档：--muted 文字 ＋ --line-2 细描边 ＋ 无实底，hover/focus 走
//     --accent 与 --ring，全 token 化、**零 transition**（故 reduced-motion 的关闭清单一个字没加）。
// 无新样式层、无新硬编码色、link/@import/overlay 顺序不变。重钉有意载荷。
// 117s-H2（用户第三轮回话「线程的交付管家能不能看全」／27 号文 §11.13.3 H2）重钉，同样只动
// css/views/steward-conversation.css 这一个【已注册的】所有权层，纯新增规则（追加在文件末尾，
// 既有规则一行未改），其余每一层零漂移（本波碰 CSS 的仍然只有管家对话这一条线，故由本刀自己钉）：
//   · `.steward-deliverable` —— 收件箱触发的那条回复里嵌的「线程自己交付的原文」。它**不是一个
//     盒子**（§8.1「少一个盒子」）：只有一条 2px 的 --line-2 左描边把原文与管家的按语分开，
//     引用的观感而不是卡片的；min-width:0 是「宽内容只在气泡里横滚」的前提。
//   · `.steward-deliverable-head` / `-body` —— 卡头是 --muted + --fs-xs 的状态行（与 .steward-source
//     同一档）；正文默认 pre-wrap（没有渲染器时回落 textContent，原文的换行要保住）。
//   · `.steward-deliverable-body.is-clamped { max-height: 12.8em }` —— 约 8 行的折叠（§11.13.3 H2），
//     展开＝去掉这个类，零动效。
//   · `.steward-deliverable-body.md` 一族 —— 交付原文与管家的话走同一个渲染器，所以排版同样整套
//     复用 chat-narrative.css 的 .md（同源取值）；这里只重复 117s-C 给 .steward-say.md 补的那三件
//     （pre-wrap 退场、h4、宽内容 max-width:100%），换一个宿主选择器 —— 刻意不与 .steward-say.md
//     并成一条规则，因为那几行被 117s-C 的静态锁 O9 逐字钉着。
//   · `.steward-deliverable-acts` 与两枚安静档文字键（「展开」「看全文」）—— --muted 文字、无实底、
//     hover 走 --accent、focus 走 --ring。
// 全 token（零 `#` 硬编码色）、**零 transition／零 animation**（故 reduced-motion 的关闭清单一个字
// 没加）、无新样式层、link/@import/overlay 顺序不变。重钉有意载荷。
// 117t F2「频道条」＋ F5a「图标集」统一重钉（前值 99b9ad4b…）。按 117t 的先例（`b922f33`）：同一波
// 有两片改了 CSS，两片各自钉必撞车，所以由【后落地的那一片】一次钉完两份有意载荷：
//   · F5a（`bd52e5a`，已入库）改了 steward-settings / steward-drawer / steward-board 三层
//     —— 它按分工没有碰本文件，于是锁在它那一个 commit 上是红的；
//   · F2（本刀）改的是 steward-conversation.css：频道条 chip、过滤那条 display:none、卡头只长在
//     段首那条，外加把 --thread-color 那条声明多挂一个选择器（chip 的色点要读同一个颜色，且整层
//     仍然只有一处 hsl()）。
// 算法自证：只按 HEAD 全量重算 = 0760861e…（＝ F5a 落地后、本刀未落地时消费者实际会算出来的值），
// 「HEAD ＋ 本刀这一层」= 下面这个值，两者只差 steward-conversation.css 一层。
// 反向验证：往本层追加一条无关规则 → live-full-text F3 与 frontend-domains D51 当场双双转红；
// 还原后该文件 sha256 与追加前逐字节相同、两个消费者都回绿。
// F5b「撤回三态」重钉（前值 275e775e…）。本波只有这一刀碰 CSS，且只碰
// css/views/steward-conversation.css 这一个【已注册的】所有权层，纯新增三条规则（追加在文件末尾，
// 既有规则一行未改）：
//   · `.steward-undo-face` —— 撤回按钮里那圈随秒消退的环（conic-gradient ＋ 中心挖空的 mask）。
//     它是本刀的全部要害：JS 每秒只写 `--steward-undo-left` 这一个 0–1 的比例，文字一个字都不重写，
//     按钮宽度因此不再跳。**零 transition／零 animation**（故 reduced-motion 的关闭清单一个字没加），
//     颜色只有 currentColor 与 --glass-border-strong 两个既有取值（零硬编码色）。
//   · `.steward-act-switch .ic` / `.steward-receipt .ic` —— 到期那枚「⇄」与落定那枚「✓」的排布
//     （base.css 的 .ic 已经给了 inline-block/vertical-align，这里只补 flex 收缩与一个字距）。
// 算法自证（本条锁上一任被working-tree 值污染过一次，故写死流程）：只按 HEAD 全量重算
// = 275e775e…（＝本刀未落地时消费者实际会算出来的值，与被替换的旧值逐字相同，证明算法与消费者
// 同源）；「HEAD ＋ 本刀这一层」= 下面这个值，两者只差 steward-conversation.css 一层。
// 反向验证：往本层追加一条无关规则 → live-full-text F3 与 frontend-domains D51 当场双双转红；
// 还原后该文件 sha256 与追加前逐字节相同、两个消费者都回绿。
// 117u「一枚线程卡，三种密度」统一重钉（前值 c7bd24b3…）。本波两刀各改一层 CSS，按 117t（`b922f33`）
// 与 117r（`72873e4`）的先例，两刀都不许自己钉（各自钉必撞车），由【主会话】在两刀都落地后一次钉完：
//   · G1（`0170b71`）改 steward-conversation.css ＋ steward-drawer.css —— 把线程卡的骨架
//     （3px 色条 ＋ 卡头：色点/名/五态药丸/最后动静/主动作）提成与「面」无关的 .steward-tcard-*，
//     色号映射从「对话流那一族选择器」改钉在 [data-thread-hue="N"] 属性本身（因此 chip 那份重复的
//     三条映射被删掉），并给抽屉加 D2 的卡内 callout 与 D3 的动作分级；
//   · G2（`eb5d3cf`）改 steward-board.css —— 看板卡接同一组 .steward-tcard-*，加分组缩进
//     （.is-grouped，宽屏与 390px 两档各限定一次）与卡尾一行 .steward-board-tail。
// 算法自证（本条锁上一任被 working-tree 值污染过一次，故流程写死、每次照做）：只按【两刀落地之前
// 那个 ref】（`f3dd960`）全量重算 = c7bd24b3…，与被替换的旧值【逐字相同】—— 这证明重算脚本与两个
// 消费者（live-full-text F3、frontend-domains D51）同源；再按 HEAD（`eb5d3cf`，含两刀）算得下面这个值。
// 中间态留档：只含 G1 那一刀时 = d566049a…（若将来要二分定位是哪一刀改动了载荷，从这个值查起）。
// 反向验证：往 steward-board.css 追加一条无关规则 → F3 与 D51 当场双双转红；还原后该层 sha256 与
// 追加前逐字节相同、两个消费者都回绿。
// 117u-G3／G3b 续钉（前值 2431350b…）：同一波第三、四刀又动了 steward-drawer.css 一层 ——
//   · G3（`c4d3169`）加 `.steward-drawer-chips[hidden] { display: none; }`（display:flex 是作者样式，
//     会盖掉 UA 的 [hidden] 规则，本层已有三处踩过同一个坑）；
//   · G3b（`9462e5d`，主会话裁决）加 `.steward-drawer-chips.is-default .steward-chip-value{display:none}`
//     —— 详情栏只收 chip 的【值】那半，键与按钮留着（那一行是「给这条线程单独定一档」的入口，
//     不是元信息；看板那一面仍然整条不印）。
// 算法自证照旧：按【上一次钉的那个 commit】(`c3a8fc3`) 全量重算 = 2431350b…，与被替换的旧值逐字
// 相同；再按 HEAD 算得下面这个值。反向验证：往 steward-drawer.css 追加一条无关规则 → F3 与 D51
// 双双转红；还原后该层与 HEAD 逐字节相同、两个消费者回绿。
// 117v-V4 续钉（前值 6c0c0b04…）：V4（`112757b`）改 steward-conversation.css 一层 —— 四档间距
// （新增卡内块间与卡间两条，组内/组间两档一个像素没动）＋频道条重做（chip 进可换行的滚动容器、
// 加高度上限 --steward-channels-max-h、删掉 scrollbar-width:none 与 ::-webkit-scrollbar{height:0}，
// 「全部线程」提成 bar 的直接子节点故恒可达）。算法自证照旧：按上一次钉的那个 commit(`e78d8af`)
// 全量重算 = 6c0c0b04…，与被替换的旧值逐字相同；再按 HEAD 算得下面这个值 —— 它与 V4 在自己那一侧
// 独立算出的值【逐字相同】，两条路互相印证。反向验证：往该层追加一条无关规则 → F3 与 D51 双双转红。
// 117x-M2 续钉（前值 801d85e5…）：M2（`12b0df1`）改 steward-drawer.css 一层 —— 模型选择器重做：搜索框、
// 「常用」段、按 provider 分组、非文本端点折叠区（[hidden] 守卫照抄本层既有三处的同款）、副行、「默认」徽标；
// 全部走 token、零硬编码色（G4 绿）。P1（拆 13h）与本刀同波并行但一个 CSS 字节没动。
// 算法自证（本条锁上一任被 working-tree 值污染过一次，故流程写死）：这次改为【不重写算法】——
// 拦截 fs.readFileSync 让消费者自己的 readLayerPayload() 直接读 git blob，同一份代码换数据源；
// 按上一次钉的那个 commit（`8e54128`）算 = 801d85e5…，与被替换的旧值逐字相同；按 HEAD 算得下面这个值，
// 它与 M2 在自己那一侧独立算出的值【逐字相同】，两条路互证。（主会话第一次手写复现用错了函数——
// 复现的是 readFrontendCss 而消费者哈希的是 readLayerPayload，自证当场不过，故改为拦截法。）
// 反向验证：往 steward-drawer.css 追加一条无关规则 → F3 与 D51 双双转红；还原后该层与 HEAD 逐字节相同、回绿。
// 117y-S3 续钉（前值 07e82fa0…）：主会话清掉 steward-conversation.css 里两条死规则（.steward-say.is-clamped、
// .steward-say-acts —— S3 让 finishSay 不再折叠后 JS 侧零消费方，static Q6a 钉着）并把 F4 头注 ④ 改成事实。
// 交付卡的折叠与其样式一字不动。算法自证照旧（拦截 fs.readFileSync 让 readLayerPayload 读 git blob）：
// 按上一次钉的那个 commit（`12b0df1`）算 = 07e82fa0…，与被替换的旧值逐字相同；按 HEAD 算得下面这个值。
// 反向验证：往该层追加一条无关规则 → F3 与 D51 双双转红；还原后该层与 HEAD 逐字节相同、回绿。
// 121-K1 续钉（前值 37efa1e5…）：K1（34 号文 §8.1）交办台退役 —— `css/views/preview-shell.css`
// 整层（1985 行）从路由表与载荷分组里删除，另加三处随之而来的真改动：
//   ① `css/components/onboarding.css` 删孤儿规则 `.preview-first-run-guide-btn`（它的按钮没了）；
//   ② `css/views/steward-shell.css` 删 `body > .preview-shell` 那条隐藏规则与头注里的「三壳」措辞；
//   ③ `css/tokens.css` 删重新零引用的 `--sp-7`（50a 清障过一次，第90波因 preview-shell.css 才复活）；
//   ④ `css/components/tool-pane.css` 收进「提醒」设置块那 10 条规则（原住 preview-shell.css 的
//      `.preview-notification-*`，随设置块改名 `.notify-*`；它属于设置弹窗，不属于任何视角层）。
// 算法自证（沿用本锁上一任定下的拦截法）：拦 fs.readFileSync 让消费者自己的 readLayerPayload()
// 去读 git blob，同一份代码换数据源 —— 按 HEAD（`1519fd3`）的锁代码 + HEAD 的 blob 算 =
// 37efa1e5…，与被替换的旧值【逐字相同】；再按工作树的锁代码 + 工作树文件算得下面这个值。
// 反向验证：往 tool-pane.css 追加一条无关规则 → F3 与 D51 双双转红；还原后逐字节相同、回绿。
// 121-K4-1 续钉（前值 859860b3…）：K4-1 外框与顶栏（34 号文 §2.2／§7.1／§7.3）改三层 ——
//   ① `css/layout.css`：新增应用外框（.app-frame 顶栏 46px ＋ .app-body 两轨 ＋ .app-views 单格）、
//      §2.2 顶栏（品牌、视角分段钮与它的 220ms 滑块、全局状态胶囊、齿轮就地菜单）、§2.3 左栏头与
//      口袋槽位、§7.3 三档容器查询（≥1600 右栏 440／≤1180 右栏成抽屉／≤980 左栏 56px 图标栏）；
//      .app-shell 从三轨收成两轨、--right-w 的定义点挪到 .app-frame（两视角共用一个宽度）、
//      侧栏折叠与 .brand/.sidebar-foot 那几条随手动折叠退役而删除；
//   ② `css/views/steward-shell.css`：场景层＋玻璃舞台卡＋1280/800 钉宽退役，改成「中栏 ｜ 右栏」
//      两列（列宽与 .app-shell 逐字相同）＋ 中栏读宽 880px ＋ 右栏空时 :has() 收轨；
//   ③ `css/views/steward-board.css`：浮层「现在这几件」（fixed 玻璃 ＋ 标题条）退役，改成栅格里
//      常驻的 .steward-side 一列，并就地覆盖抽屉那条「开着就补白 390px」的居中时代让位；
//   ④ `css/components/tool-pane.css`：≤1180／≤760 两档里改栅格与折叠侧栏的那 9 条规则删除 ——
//      栅格现在由外框那一层统一给（右栏收抽屉两个视角同一套开合），左栏没有「手动折叠」这回事了。
// 算法自证（沿用 117x-M2 定下的拦截法）：拦 fs.readFileSync 让消费者自己的 readLayerPayload() 去读
// git blob，同一份代码换数据源 —— 按 HEAD（`c8b3c3b`）算 = 859860b3…，与被替换的旧值【逐字相同】；
// 再按工作树算得下面这个值。反向验证：往 layout.css 追加一条无关规则 → F3 与 D51 双双转红。
// 121-K4-2 续钉（前值 bc6876b6…）：K4-2 左栏任务索引（§2.3）改四层 ——
//   ① `css/views/steward-board.css`：看板浮层（.steward-board）与它的 toolbar／事项卡／正文容器
//      整族删除，换成左栏那一族（.rail-list／.rail-board-head／.rail-group／.rail-gh／.rail-tasks／
//      .rail-task-count／.rail-chev／.rail-threads 的 0fr→1fr 展开／.rail-origin／.steward-board-sub），
//      行的基元（.steward-board-thread 与它的卡头／药丸／chip／卡尾／动作）声明一个字没改，
//      只多了「选中行一层点色底」与「左栏里动作组 display:none 直到悬停」两条；
//   ② `css/layout.css`：.session-list／.session-item 那一族（含 .s-title/.s-sub/.s-actions/.s-snippet）
//      随会话列表退役；≤980 图标栏的隐藏清单改指左栏真实的类名，色点用 --thread-color；
//      --rail-w／--right-w 的断点覆盖从 .app-frame 挪到 .app-body（容器查询改不了容器自己）；
//   ③ `css/base.css`：触达高度清单里的 .session-item → .steward-board-thread（同一件事换宿主）；
//   ④ `css/components/tool-pane.css`：触屏常显清单里的 .session-item .s-actions → .steward-board-actions。
// 算法自证（沿用拦截法）：按上一次钉的那个 commit（`69a505b`）算 = bc6876b6…，与被替换的旧值
// 【逐字相同】；再按工作树算得下面这个值。反向验证：往 layout.css 追加一条无关规则 → F3 与 D51 双红。
//
// 121-K4-3 续钉（前值 66e8d9a7…）：K4-3 视角切换动效与频道条退役（§2.9／§2.4）改两层 ——
//   ① `css/layout.css`：新增 §2.9 那一整块 View Transitions（关掉 root 默认交叉淡入、顶栏与左栏
//      各自独立快照且不动、中栏两个方向的平移淡入淡出、右栏只淡不移、共享元素 thread-title／
//      thread-bar 的 260ms 变形、六条 vt-* keyframes），并在既有的 prefers-reduced-motion 块里
//      补上 ::view-transition-group/old/new(*) 的 animation:none（第二道保险；第一道是
//      js/shell-mode.js 的 runShellTransition 直接不起过渡）；
//   ②b `css/layout.css` 的 ≤980 图标栏那一档多一条 `.task-rail .steward-board-pill.has-icon
//      { display: none }`：带字形的药丸自己那条 inline-flex 住在后加载的 steward-board.css 里、
//      与原来那条同分（0,2,0），于是 56px 栏里还看得见「需要你」「已停工」两截字
//      （one-workbench-frame.browser 的 D5c 实测）；这一条 0,3,0 压过它。
//   ② `css/views/steward-conversation.css`：频道条那一族（.steward-channels／-scroll／-label／
//      .steward-channel 含 -dot／-name／-state／.is-on／.steward-channels-board ＋ 那条
//      .steward-msg.is-channel-out 过滤规则 ＋ 390px 那一档三条 ＋ :root 上只服务它的
//      --steward-channels-max-h）整族删除；留下的是「卡头只长在段首那一行」那条规则。
// 算法自证（同一条拦截法）：按上一次钉的那个 commit（`87a0d2f`）算 = 66e8d9a7…，与被替换的旧值
// 【逐字相同】；再按工作树算得下面这个值。反向验证：把 vt-fade-in 那条 keyframes 改一个数字
// → F3 与 D51 双红。
//
// 121-K5 续钉（前值 4182a40f…）：K5 工作台线程头（§2.5／§3）改两层 ——
//   ① `css/views/chat-shell.css`：新增 .topbar.thread-head 那一族（两行结构 ＋ 3px 色条 ＋
//      「任务 › 线程」面包屑 ＋ 五态药丸／来源图形的 [hidden] 收口 ＋ 管家条 .th-steward 一族
//      ＋ 连接态 .th-conn 的那颗点），另加两条模型菜单尾部的行样式（「设为新任务默认」上面那道
//      分隔线、刷新／管理服务商两枚动作的次级墨色）。**两行是结构不是换行**：§13.7 登记①那条
//      「1200 宽线程头折行」由此关闭；
//   ② `css/layout.css`：`.app-topbar #statusLine` 那条视觉隐藏规则整条退役 —— 连接态搬进线程头
//      第二行右端那个真看得见的位置（§13.7 登记⑦），藏起来这件事本身不再需要。
//   ③ 第一轮 1200 实测出的两处收尾（同一刀内）：面包屑改一行读完（.th-crumb）、chip 行只收不切。
//   注：随 #modelChip／#permChip 退役而失去消费者的 `.model-chip`／`.perm-chip`／`.perm-select-host`／
//   `.perm-pop` 一族【本刀不删】（登记给 K8：CSS 与文案刷新那一刀独占样式层的清理，一次重钉）。
// 算法自证（同一条拦截法）：按 HEAD（`46684b7`）算 = 4182a40f…，与被替换的旧值【逐字相同】；
// 再按工作树算得下面这个值。反向验证：往 chat-shell.css 的 .th-conn 改一个像素 → F3 与 D51 双红。
// 121-K6a 续钉（前值 aba7e98f…）：K6a 新增独立层 `css/views/quiet-card.css`（安静卡，§4.3／§2.6）——
// 附加在 CSS_PAYLOAD_GROUPS 末尾（steward-board.css 之后），理由与其余「自己的样式表」层相同：
// 它是继浮层弹层之后【第二个】允许用 --glass-* 的面（§7.1 末句），且不拥有任何经典选择器。
// 本刀没有改动任何既有 CSS 层一个字节——16 个既有文件在工作树与 HEAD（`306fcdd`）逐字节相同，
// 只新增一层。算法自证（同一条拦截法）：按 HEAD 的旧分组表（无 quiet-card.css）+ HEAD 的 git blob
// 算 = aba7e98f…，与被替换的旧值【逐字相同】；再按工作树的新分组表（多一层）+ 工作树文件算得
// 下面这个值。反向验证：往 quiet-card.css 追加一条无关规则 → F3 与 D51 双红；把新层从
// CSS_PAYLOAD_GROUPS 里去掉 → 离线包已经在引用它、锁却读不到 → 两处失配当场红。
// 121-K6b 续钉（前值 f08cbe54…）：本刀按 34 号文 §2.6／§2.4 改了三个既有层，**零新增层**——
//   ① `css/views/steward-drawer.css`：抽屉改成常驻【焦点卡】。元信息一行（nowrap 一行读完、
//      来源图形那一枚）、卡头的「任务 › 线程」面包屑（`::after` 画 ›，分隔符不进 textContent）、
//      在跑那一段的当前动作行（`--mono` 等宽，因为那三个数每半秒跳一次）、区块的 [hidden] 守卫；
//      卡头的标题补一行省略号（面包屑挤进来之后长名字会把药丸顶出去）。
//   ② `css/views/steward-conversation.css`：卡头那枚「打开」改图标钮（inline-grid 居中、次级墨），
//      加 `.steward-thread-crumb` 面包屑一族（与 ① 同一条口径，两面各自的层各写各的皮）。
//   ③ `css/views/steward-board.css`：一条规则 —— docked 挂法下把「关掉」那一栏收掉
//      （常驻焦点栏不存在「关」，§13.7 ③）。
// 算法自证（同一条拦截法）：按 HEAD（`84fee4b`）的 git blob ＋ 同一张分组表算 = f08cbe54…，
// 与被替换的旧值【逐字相同】；再按工作树算得下面这个值。
// 反向验证：往 steward-drawer.css 的 .steward-drawer-acting 改一个像素 → F3 与 D51 双红。
// 121-K8 续钉（前值 690afbfd…）：本刀按 34 号文 §2.10 改了【八个既有层】，**零新增、零删除层**
// （分组表一个字节没动，仍是 18 组 22 层）：
//   ① `css/tokens.css`：字阶 rem → 整像素五档 12/13/14/15/17（--fs-xl/--fs-2xl 降为 --fs-lg 别名），
//      新增 :root[data-ui-mode="simple"] 的 +1px 覆盖块与三枚行高 token（§2.10.2）。
//   ② `css/base.css`：按钮/单行输入框圆角 → 胶囊、.icon-btn → 圆钮，多行 textarea 例外走卡片圆角。
//   ③ `css/layout.css`：品牌槽 24 见方 → 26×16，新增 .brand-cloud/.brand-pearl 两条上色（云头品牌标）。
//   ④ `css/components/chat-composer.css`：.composer-box 两层方盒 → 一行胶囊（高 50、圆角 26），
//      工具键改圆钮/小胶囊，.composer-hint 移出胶囊后改块级 + :empty 收高。
//   ⑤ `css/views/steward-shell.css`：.steward-composer column → row wrap 的同款胶囊，
//      focus-within 描边与光晕对齐 ④。
//   ⑥ `css/views/steward-conversation.css`／`steward-drawer.css`／`steward-board.css`／`workbench.css`：
//      组头去 uppercase/letter-spacing 改 12px 加粗次级墨色、发送圆钮 32→36、来源图形去鎏金/青花。
//   ⑦ `css/views/chat-shell.css`：`.model-chip`／`.perm-*` 两族与模型菜单容器 `.mc-*` 一族整段删除
//      （§13.8 K8 ①／§13.11 K8 ①，提交前逐族 git grep 证零生产者），`.mc-del` 拆掉够不着的祖先。
//   ⑧ `css/components/tool-pane.css`：≤760 降级块里随 ⑦ 失去宿主的两条规则删除。
// 算法自证（同一条拦截法）：按上一波收口提交 `5c129cd` 的 git blob ＋ 同一张分组表算
// = 690afbfd05b05e478cdf6c9431a732bce338c27e4e7e881ef26b27aa810a6126，与被替换的旧值【逐字相同】；
// 再按本刀 CSS 全部落盘之后的 HEAD（`5a6c584`）算得下面这个值（两次都从 git blob 算，不从工作区算 ——
// 32 号文 §4 纪律 4）。反向验证：往 tokens.css 把 --fs-base 改回 1rem → F3 与 D51 双红。
// 121-K7 续钉（前值 b9852892…）：本刀按 34 号文 §2.3 末段／§7.3／§13.13 K8 登记② 改了【四个既有层】，
// **零新增、零删除层**（分组表一个字节没动，仍是 18 组 22 层）：
//   ① `css/layout.css`：口袋那一族（.rail-pocket-item／-label／-n／-new：一行 = 字形 ＋ 短词 ＋
//      计数／「新」；计数与组头那几枚同一档灰底小胶囊，「新」走鎏金），外加 ≤980 那一档里
//      把三个文字节点收起、按钮改单列居中（§7.3「口袋成图标」）。
//   ② `css/components/tool-pane.css`：右栏七枚页签 三列 → **四列**（§2.6「七页签不动」是前提，
//      所以改的是列数不是枚数：ceil(7/4) = 两行），精简档 两列 → 三列（那一档收起「用量」「记录」
//      两枚，剩五枚 ceil(5/3) = 两行），按钮的内边距与间隙各收 1px 给四列腾宽。
//   ③ `css/views/steward-board.css`：焦点栏最底下的「接下来」一族（.steward-upnext*，§2.6 末条）。
//   ④ `css/views/steward-settings.css`：设置·管家页新增「定时任务」只读表那一族（.steward-schedule*）。
// 算法自证（同一条拦截法）：按 K8 收口后的 HEAD `9f0222d`（本刀开工时是 `984623c`，两处 CSS 逐字节
// 相同，两个 ref 算出来的旧值一样）的 git blob ＋ 同一张
// 分组表算 = b9852892aae00ab8ffd348ccc928447960ab9cfeb4872f69077e75501cdde9b7，与被替换的旧值
// 【逐字相同】；再按本刀 CSS 全部落盘之后的 blob 算得下面这个值（两次都从 git blob 算，不从工作区
// 算 —— 32 号文 §4 纪律 4）。反向验证：把 tool-tabs 的列数改回 3 → F3 与 D51 双红。
// 121 走查修复第一轮续钉（前值 cc9fc48a…）：本轮按用户 2026-09-13 走查的五条改了【四个既有层】，
// **零新增、零删除层**（分组表一个字节没动，仍是 18 组 22 层）：
//   ① `css/layout.css`：.app-topbar 加 position:relative + z-index:42（走查①：顶栏里那两块就地
//      浮层被右栏盖住 —— 它们的 z-index 被关在顶栏那个 view-transition-name 造出来的层叠上下文里）；
//      外加 #newSessionBtn[data-lens="steward"] 那一族（走查③：管家那一枚「＋」改鎏金描边次级钮）。
//   ② `css/views/steward-board.css`：走查② —— 两条 hover 规则加 .app-frame.rail-board 前缀
//      （悬停动作栏只属看板密度）、普通密度 .is-actions-open 的竖排浮层、行尾「⋯」一族、
//      「浮层开着的那一行 z-index:3」与 .rail-threads-inner 的 :has() 松裁，@media (hover:none) 分档。
//   ③ `css/views/steward-drawer.css`：走查④ —— .steward-chip-menu 的 z-index 2 → 30。
//   ④ `css/views/chat-shell.css`：走查④ —— .topbar.thread-head 加 z-index:12（.topbar 带
//      backdrop-filter，本来就是个 z-index:auto 的层叠上下文，菜单那一层出不了这个头）。
// 算法自证（同一条拦截法）：按本轮开工时的 HEAD `2c8f953` 的 git blob ＋ 同一张分组表算
// = cc9fc48a0fe37aa618d0c3824575f62e568cba8d91b8353c7cef291d38e2b615，与被替换的旧值【逐字相同】；
// 再按五个 fix 提交全部落盘之后的 HEAD 的 blob 算得下面这个值（两次都从 git blob 算，不从工作区算
// —— 32 号文 §4 纪律 4）。反向验证：把 .app-topbar 的 z-index 拔掉 → F3 与 D51 双红。
// 122 波 §2.9（36 号文）待续钉（前值即下面这个 7738fe50…，本刀不重钉 —— 32 号文 §4「不重钉」纪律：
// 主会话 cherry-pick 后按 HEAD 统一重钉）：本刀改了【八个既有层】，**零新增、零删除层**
// （分组表一个字节没动，仍是 18 组 22 层）：
//   ① `css/tokens.css`：删 --fs-xl／--fs-2xl 两个 --fs-lg 别名声明（连同两段引用它们的注释）。
//   ② `css/components/chat-primitives.css`／`css/components/onboarding.css`／
//      `css/components/tool-pane.css`／`css/views/workbench.css`：七处消费点从 --fs-xl／--fs-2xl
//      改直接引用 --fs-lg（字面量不变,仍是 17px,纯改名）。
//   ③ `css/components/onboarding.css`／`tool-pane.css`／`chat-primitives.css`／`workbench.css`／
//      `workspace.css`／`layout.css`／`states/chat-live.css`／`themes/ui-modes.css`：非独占层的
//      letter-spacing／text-transform:uppercase 22 处里删 19 处（3 处留：tool-pane 两处 ≥17px 标题
//      负字距、workbench 一处等宽代码负字距,理由见 css-typography-debt.static.e2e.js);连带删掉
//      `states/chat-live.css` 里因此变成死代码的 `.ts-undo-all` 覆盖规则(它原本只用来撤销
//      `.turn-summary-head` 的 uppercase,父规则的 uppercase 已经删了)。
// 算法自证留给主会话按本刀落盘之后的 HEAD 重算(本刀不动 LEGACY_STYLES_SHA256 本身)。
// 122 波主会话重钉（L3 四提交 cherry-pick 为 956b025→c785a3e 后，按干净 HEAD 的载荷重算；与 L3 报告里
// 「仅供核对」的 f082de2e… 逐字相同；L1a／L2 均未碰 CSS）。前值 7738fe50…。
// 122-L1b 重钉（前值即上面那个 f082de2e…）：**零新增、零删除层**（分组表一个字节没动，仍是 18 组 22 层），
// 只改了两个既有层：
//   ① `css/views/steward-drawer.css`（§2.11）：`.steward-chip-option` 加 `white-space: normal`
//      —— 它是个 <button>，继承 base.css 那条全局 `button { white-space: nowrap }`，四档权限的提示
//      横着捅出菜单（实测 scrollWidth 351 对 clientWidth 253）。
//   ② `css/layout.css`（§2.12＋§2.14）：删 `.app-gear-menu > #capBadge/#themeToggle/#uiModeToggle
//      { display:none }`（齿轮菜单收成一层七项，那三枚不再是隐藏载体）、补 `.app-gear-menu > #capBadge`
//      两条排版微调，并新增 `.skip-link`／`.skip-link:focus`（U05 走查抓到的跳转链接）。
// 算法自证：改动全部落盘（提交 e7763a2／a91187f／f65d43d）之后，在【干净工作区】上按 HEAD 的 blob 逐层
// 重算 —— 把 fs.readFileSync 换成 `git show HEAD:<path>` 再跑本文件自己的 readLayerPayload()，
// 得到的值与直接读工作区【逐字相同】（22 层全部走 HEAD），所以下面这个值是 HEAD 的值，不是工作区的值
// （32 号文 §4 纪律 4）。反向验证：删掉 `.steward-chip-option` 那行 white-space → 本值与实算不符，
// frontend-domains D51 与 live-full-text F3 双红。
// 123-M2 重钉（前值即上面那个 e586a9b3…）：**零新增、零删除层**（分组表一个字节没动，仍是 18 组
// 22 层），只改了一个既有层 —— `css/views/steward-settings.css`（37 号文 §3.6）：设置页的定时任务
// 块从只读改成可建可改，每行从「一行」变成「标题行 ＋ 动作行 ＋ 展开的最近几次」三层，于是
// `.steward-schedule-row` 从 flex 一行改成竖排的卡片，原来那一行的排布逐字挪进新的
// `.steward-schedule-head`；连带新增上次结果徽标（颜色只是冗余，文字本身就写着结果）、行内动作条、
// 最近几次那一列与新建表单的栅格。
// 算法自证：改动落盘（提交 a1add96）之后，在【干净工作区】上按 HEAD 的 blob 逐层重算 —— 把
// fs.readFileSync 换成 `git show HEAD:<path>` 再跑本文件自己的 readLayerPayload() 的同一份拼接，
// 得到的值与直接读工作区【逐字相同】（22 层全部走 HEAD），所以下面这个值是 HEAD 的值，不是工作区
// 的值（32 号文 §4 纪律 4）。反向验证：删掉 `.steward-schedule-badge[data-outcome="unknown"]` 那条
// 规则 → 本值与实算不符，frontend-domains D51 与 live-full-text F3 双红。
// 2026-09-14 重钉（前值即上面那个 065948bd…；用户走查「管家切工作台时线程名过渡缺失／重影」）：
// **零新增、零删除层**（分组表一个字节没动，仍是 18 组 22 层），只改了一个既有层 ——
// `css/layout.css` 的 §2.9 共享元素时序：
//   ① `::view-transition-group(thread-title)`／`(thread-bar)` 补上 260ms ease-out —— 修前 group
//      吃 UA 默认 0.25s ease，与 old/new 的 260ms ease-out 不同步（位置飞到了、透明还在走）；
//   ② old/new 从等权交叉叠化改成错开淡变（旧快照前 40% 出净、新快照 45% 才进场）—— 两张
//      字号／宽度不同的文字位图等权叠化就是重影；新增 vt-shared-out／vt-shared-in 两条 keyframes。
// 反向验证：把 vt-shared-in 那条 keyframes 改一个数字 → 本值与实算不符，frontend-domains D51
// 与 live-full-text F3 双红。
// 123-S1 重钉（前值即上面那个 38f82119…）：本刀做了两件事 ——
//   ① **新增一层** `css/views/settings.css`（设置弹窗重设计：左侧竖排分组导航 ＋ 右侧内容面板、
//      弹窗 720→920、页脚生效提示、≤640px 导航折叠为横向滚动条），登记在 steward-settings.css
//      之后（分组表 18 组 22 层 → 18 组 23 层），index.html 直链 / styles.css @import /
//      build-overlay.js 离线清单四处同步；覆盖式写法，八个既有层一个字节没动。
//   ② 改两个既有层：`css/themes/ui-modes.css` 在既有简易模式隐藏规则旁加一条「隐藏集成组标签」
//      （该组两枚页签在简易模式下全被藏掉，组头不能留空壳）；`css/views/steward-conversation.css`
//      四处打磨（用户气泡加细描边与内边距、.steward-say 行高 1.65→1.7 ＋ .md 段落 .8em、
//      .steward-deliverable 从左描边引用升级为 --panel 面板、.steward-act 高度下限改跟 --tap-min）。
// 算法自证：改动全部落盘后在【工作区】按本文件自己的 readLayerPayload() 重算（分组表已含新层）；
// 反向验证：把 #settingsTabs.settings-tabs 的 flex-basis 改一个像素 → 本值与实算不符，
// frontend-domains D51 与 live-full-text F3 双红。
// 123-S2 续钉（前值即上面那个 a5c2acb5…）：**零新增、零删除层**（分组表一个字节没动，仍是
// 18 组 23 层），只改了两个既有层 ——
//   ① `css/views/settings.css`：五枚分组标签升级为可折叠二级菜单（.settings-nav-group 容器、
//      组头按钮化 ＋ chevron 旋转 ＋ 子钮缩进与淡入、窄屏强制全组展开、reduced-motion 关动效），
//      新增段内锚点 chip 条（.settings-jumplist）与 stab-basic 折叠分组（details.settings-fold）两族；
//   ② `css/themes/ui-modes.css`：简易模式「集成」组隐藏规则从瞄 label 改瞄新的组容器
//      （.settings-nav-group[data-group="integrations"]），语义一个字没变。
// 123-S3 续钉（前值即上面那个 2cbb9335…）：**零新增、零删除层**（仍是 18 组 23 层），只改了
// 两个既有层 ——
//   ① `css/layout.css`：顶栏品牌标五条规则（.brand-mark/.brand-mark svg/.brand-cloud/
//      .brand-pearl/.app-brand-name）随 index.html 顶栏品牌区撤下而退役（2026-09-14 用户走查：
//      窗口标题栏已印全名，顶栏再印属重复）；
//   ② `css/components/chat-primitives.css`：空状态品牌标注释里对 .brand-mark 的过时引用改写，
//      规则本身一个字没动。
// 算法自证：改动全部落盘后在【工作区】按本文件自己的 readLayerPayload() 重算；
// 反向验证：frontend-domains D51 与 live-full-text F3 复跑转绿。
// 123-S4 续钉（前值即上面那个 2f033d2d…）：零新增、零删除层，只改 `css/views/settings.css`
// 一行 —— .settings-nav-label 补 justify-content:flex-start，卸掉从 .tool-tabs button 漏进来的
// justify-content:center（2026-09-14 用户走查：组头居中、与子钮左缘不齐，展开后很丑）。
// 124-P1 续钉（前值即上面那个 fdaa4646…）：零新增、零删除层，只往【已注册的】所有权层
// `css/views/steward-drawer.css` 加两条规则 —— 验收项旁边那枚来源徽标（机器检查／人工复核／
// 自报完成，40 号文 §2 ①）：
//   · `.steward-drawer-list li .steward-acc-src` —— inline-block（done 那一档的 line-through 会贯穿
//     行内子节点，牌子上的字读不成）＋ --sp-2 起始外边距 ＋ --fs-xs ＋ --muted；
//   · `.steward-drawer-list li[data-provenance="machine"] .steward-acc-src` —— 只有「机器检查」那一档
//     借 --ok（与看板圆点第四档同一个语义 token），不新造颜色。
// 无新样式层、零 transition（reduced-motion 关闭清单一个字没加）、link/@import/overlay 顺序不变。
// 算法自证：改 CSS 【之前】在工作区按本文件自己的 readLayerPayload() 重算 = fdaa4646…，与被替换的
// 旧值逐字相同（先自证再替换，不是替换完再解释）；改完再算得下面这个值。
// 反向验证：往 steward-drawer.css 追加一条无关规则 → F3 与 D51 双双转红；还原后逐字节相同、回绿。
// 124-P2（委托书带 .thread-brief ＋「看原件」落地那一下闪烁 #messages .message.is-revealed，
// 两处都在 css/views/chat-shell.css）。同款自证：改 CSS 【之前】把 chat-shell.css 从 HEAD 检出、
// 按本文件自己的 readLayerPayload() 重算 = c9f61a47…，与被替换的旧值逐字相同（先自证再替换）；
// 换回本刀的 CSS 再算得这个值。**本刀里它动了三次**，如实记下来免得下一个人以为哪一步算错了：
//   ① 第一版类名叫 .thread-brief → dedef49c…；
//   ② 为躲开 116-5b 线程自动摘要那一族的同名（session.threadBrief / settings.steward.threadBrief /
//      thread-brief.static.e2e.js）整族改名 commission，CSS 跟着改 → 0e57c341…；
//   ③ 班组视角要把委托书带跟着对话三件套一起收，主视图状态机那一处（workbench.css）加一个
//      选择器 → 1c6bdbfa…；
//   ④ 124 走查 B（用户三选一选了 B）：委托书线程的第一条消息折成一行 → 下面这个终值。
//   ⑤ 125-P2:工具卡摘要行上的缓存徽标(.tc-stale,chat-live.css)—— 没有 data-stale 时整枚
//      display:none,其余工具卡逐像素不变 → 下面这个终值。
//   ⑥ 126-M02:管家记忆面的「已过期」标(.steward-memory-expired,views/steward-settings.css)——
//      新增一条中性色 pill 规则,只在服务端算出 expired:true 时才渲染出这个元素,其余条目逐像素不变 -> 下面这个终值。
// 127-⑦ B-114c-① 续钉（前值 07031c43…）：零新增、零删除层（分组表一个字节没动），只改两个既有层 ——
//   ① `css/components/chat-composer.css`：输入框麦克风 .composer-voice 一族（两个视角共用；空闲／录音
//      危险色＋呼吸／转写中主色／失败危险色；reduced-motion 关动效），外加 ≤560px 下
//      `.composer-box:has(> .composer-actions > .composer-voice)` 折成两行（390px 实测：胶囊里多这一枚
//      输入框只剩 16px、录音态 0px）。节点只在语音识别配好时才由 JS 建，所以未配置时这些规则一条都命中不到；
//   ② `css/views/steward-conversation.css`：`.steward-plus` 头注「附件／语音归后续波」改成事实（只改注释）。
// 算法自证（沿用 117x-M2 的拦截法）：拦 fs.readFileSync 让本文件自己的 readLayerPayload() 去读 HEAD
// （`ef3bd57`）的 git blob = 07031c43…，与被替换的旧值逐字相同；再按工作区算得下面这个值。
// 反向验证：改 CSS 之后、重钉之前 frontend-domains D51 与 live-full-text F3 双红（实测）。
// 128d 续钉（前值 f762f373…）：零新增、零删除层，只在 `css/components/tool-pane.css` 加一条
//   `.tool-tabs button.active:focus-visible { box-shadow: var(--elev-1), var(--ring); }` —— 「当前页签」自带的投影
//   比 base.css 那条 :where(button…):focus-visible 焦点环优先级高，键盘焦点落在它上面时与没焦点一模一样
//   （keyboard-walkthrough K1 在深色主题查出）。只在键盘焦点落在当前页签上时命中，其余逐像素不变。
// 算法自证：把 tool-pane.css 从 HEAD 检出、按本文件自己的 readLayerPayload() 重算 = f762f373…，与被替换的旧值逐字相同
// （先自证再替换）；换回本刀的 CSS 再算得下面这个值。反向：改 CSS 之后、重钉之前 D51 与 F3 双红（实测，本刀快通道）。
// 128f-① 续钉（前值 8f57fe64…）：零新增、零删除层，只在 `css/components/chat-primitives.css` 故障卡那一族后面加三条 ——
//   `.boot-failure-host`（启动故障卡挂到外框之上的 fixed 浮层：修前画在 #messages，出厂默认的管家视角里整个看不见；
//   z-index 58 压过弹窗 50／浮层 55、让 toast 60 照样在上）、`.boot-dismiss, .boot-diag-copy`（两枚新按钮的触控尺寸）、
//   `.boot-diag-copy`（上边距）。只有启动时某一步失败、JS 建出这些节点时才命中，其余逐像素不变。
// 算法自证：把 chat-primitives.css 从 HEAD 检出、按本文件自己的 readLayerPayload() 重算 = 8f57fe64…，与被替换的旧值
// 逐字相同（先自证再替换）；换回本刀的 CSS 再算得下面这个值。反向：改 CSS 之后、重钉之前 D51 与 F3 双红（实测）。
// 128f-⑫ 续钉（前值 0b8c083a…）：零新增、零删除层，只在 `css/views/steward-board.css` 的 .is-sel 后面加一条
//   `.steward-board-thread.is-removing { opacity: .45; pointer-events: none; }` —— 删除请求在飞时那一行变灰、不接点击
//   （用户 2026-09-19「删除线程没有及时的界面反馈」）。只在删除请求在飞的那一瞬命中，其余逐像素不变。
// 算法自证：把 steward-board.css 从 HEAD 检出、按本文件自己的 readLayerPayload() 重算 = 0b8c083a…，与被替换的旧值逐字相同
// （先自证再替换）；换回本刀的 CSS 再算得下面这个值。反向：改 CSS 之后、重钉之前 D51 与 F3 双红（本刀快通道实测）。
// 128f-⑭ 续钉（前值 fa963691…）：零新增、零删除层，只在 `css/components/chat-composer.css` 麦克风那一族后面加两条 ——
//   `.composer-voice[data-state="setup"] { opacity: .55; }` 与它的悬停／键盘焦点恢复常色（语音识别没配时那一枚「待开启」的灰钮；
//   用户 2026-09-19 拍板 A），外加那一族头注的一句事实更正。只在语音识别没配时命中，配好之后逐像素不变。
// 算法自证：把 chat-composer.css 从 HEAD 检出重算 = fa963691…，与被替换的旧值逐字相同；换回本刀的 CSS 再算得下面这个值。
// 2026-09-20 续钉（前值 1c7827a7…）：零新增、零删除层，只在 `css/views/chat-shell.css` 服务商卡片「协议」那一族后面加两组 ——
//   ①「语音转文字接口」一行（.prov-asr-protocol 及其选择器／说明）：修前这一行没有任何样式，落在 .check 的不换行 flex 里，
//     长说明把标签挤成一字一行的竖排（用户截图）；现在与「协议」一行同模具，说明独占下一行并正常折行。
//   ② 设置页「添加语音识别模型」一行（.asr-add-row）：多了一枚「接口类型」选择器，四个控件一行排、窄了自动折行。
//   ③「协议」与「服务端搜索」两条说明补 white-space: normal：修前继承了所在行的 nowrap，长说明把卡片撑出横向滚动条。
// 算法自证：把 chat-shell.css 从 HEAD 检出重算 = 1c7827a7…，与被替换的旧值逐字相同；换回本刀的 CSS 再算得下面这个值。
// 2026-09-21 续钉（前值 a8d33ab6…）：零新增、零删除层，只在 `css/views/chat-shell.css` 的 .asr-add-row 后面加一族 .toolbox-*
//   —— 设置页「扩展组件（ruyi-toolbox）」一栏（每个组件一行：开关｜名字｜类型与状态，失败原因独占下一行）。
//   一个组件都没登记时这一栏整块不渲染，所以没装 toolbox 的人逐像素不变。
// 算法自证：把 chat-shell.css 从 HEAD 检出重算 = a8d33ab6…，与被替换的旧值逐字相同；换回本刀的 CSS 再算得下面这个值。
// 132a(53 号文 §1):委托书带分段列表与气泡里折叠块的样式 —— 有意新增,重钉。
// 134 重钉（前值 b82c6821…）：零新增、零删除层，只在 `css/components/chat-composer.css` 首部加一族 .steer-delivery-mode
//   —— 插话送法选择器（排队/立即打断）的下拉样式，主题令牌全走 var()。
// 算法自证：把 chat-composer.css 从 HEAD 检出重算 = b82c6821…，与被替换的旧值逐字相同；换回本刀的 CSS 再算得下面这个值。
// 133f 重钉（前值 c0d67eec…）：零新增、零删除层，只在 `css/components/chat-composer.css` 的 .composer-voice 一族里加两段 ——
//   加载中态（[data-state="warming"]：主色 + 转圈 + 计时，转圈复用 compact-spin 关键帧）与它的减弱动效分支。主题令牌全走 var()/color-mix。
// 算法自证：在内存里把这两段抠掉（不碰磁盘）再算 = c0d67eec…，与上一行已钉的旧值逐字相同；换回本刀的 CSS 再算得下面这个值。
// 2026-09-22 重钉（前值 1fe033a3…）：两处有意改动 —— ① chat-narrative.css 新增 .mermaid-lightbox 一族
//   （mermaid 大图全屏灯箱：滚轮缩放/拖拽平移/适应窗口，.mermaid-view 加 cursor:zoom-in）；
//   ② 委托书横幅退役：chat-shell.css 删 .thread-commission 全族与 ruyi-reveal-flash/is-revealed（保留
//   .brief-fence 折叠块样式），workbench.css 主视图状态机摘掉 #threadCommission 选择器。主题令牌全走 var()/color-mix。
// 算法自证：把 chat-narrative/chat-shell/workbench 三份 CSS 从 HEAD 检出重算 = 1fe033a3…，与被替换的旧值逐字相同；
//   换回本刀的 CSS 再算得下面这个值。
// 135 续钉（前值 cd3a9d41…）：只在载荷末尾新增一层 css/views/prompt-dock.css（「等你处理」队列小窗）。
// 算法自证：从本刀的载荷末尾抠掉这一层（换行 + 其去首行正文）重算 = cd3a9d41…，与被替换的旧值逐字相同；
// 整份再算得下面这个值。
// 135c 续钉(前值 ac796a20…):只在载荷末尾新增一层 css/views/background-tray.css(线程内后台任务条)。
// 算法自证同上:抠掉这一层重算 = 前值,逐字相同。
// 2026-09-24 重钉(前值 abe014de…):零新增、零删除层,只改 `css/views/prompt-dock.css` —— 删掉
//   `:root[data-shell-mode="steward"] .prompt-dock { display: none; }` 那一条并改头注(用户要求「等你处理」小窗
//   管家视角里也看得到)。
// 算法自证:把 prompt-dock.css 换回 HEAD 重算 = abe014de…,与被替换的旧值逐字相同;换回本刀的 CSS 再算得下面这个值。
// 2026-09-24 W4 续钉（前值即上面那个 2a787f60…；用户：「右边的线程永远收不起来……打开线程点击了会像没有反应一样」）：
// **零新增、零删除层**（分组表一个字节没动），只改了两个既有层 ——
//   ① `css/views/steward-shell.css`：右栏收起态的列宽（`:has(> .steward-side[data-collapsed="1"])` →
//      `--steward-strip-w` 44px，只在 `@container frame (min-width: 1181px)` 那一档 —— 与 layout.css §7.3
//      的 ≤1180 抽屉带是同一条线的两面）；头部下沿多留一档（--sp-2 → --sp-3）、名字与状态行补 2px 行距。
//   ② `css/views/steward-board.css`：右栏栏头开关（.steward-side-bar／.steward-side-toggle）、收起态的窄条
//      （.steward-side-strip 一族：[hidden] 守卫、两枚 run／you 计数徽标、「有新动静」的鎏金点）、
//      `[data-collapsed="1"]` 收起态（同一档容器查询里）、docked 抽屉 padding-top 收一档；
//      117g 返回带那一族（.steward-return-*）随 121-K5 退役后零消费方，整族删除，位置由工作台线程头上的
//      「回到管家」（.thread-head .th-steward .th-back-steward，鎏金描边小胶囊）接手；reduced-motion 关闭清单
//      换成这两枚新钮。
// 算法自证（同一条拦截法）：拦 fs.readFileSync 让本文件自己的 readLayerPayload() 去读 HEAD（`f8aecfcf`）的
// git blob，同一份代码换数据源 —— 算得 2a787f60…，与被替换的旧值【逐字相同】；再按工作树算得下面这个值。
// 反向验证：把 .steward-side-strip 的 [hidden] 守卫删掉 → frontend-domains D51 与 live-full-text F3 双红。
const LEGACY_STYLES_SHA256 = '92571d5b6960172156e88c990b0e55a648b1fc6291bc7c53502cd312b5854723';

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

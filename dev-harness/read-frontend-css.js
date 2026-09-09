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
  // 117g/117h: steward board layer (the one-line status, the drop-down board with its per-mission groups,
  // the docked "current one" rail, and the 2.0-window return band that lives in the classic pane).
  // Appended last for the same reason.
  'css/views/steward-board.css',
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
const LEGACY_STYLES_SHA256 = '8fe8f54dc08b4c6998ae292f935b730f748c572e4f004324ef8436694364fad6';

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

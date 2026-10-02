# 60 · 智能自动的管家包办体验 ＋ 全自动档回界面

> 状态：**已实现（2026-10-02）**。
>
> 用户原话（2026-10-02）：「现在把 bypass 给去掉了，只有智能自动，我觉得还是要把 bypass 这个档给加回来；然后再看看智能自动这个档的体验，
> 是否还要再优化一下，比如管家的应答速度，决策范围，以及其它方面等，是否要优化更符合管家包办的用户体验」。
> 过程中补：「如果用户在看提问、权限，管家被立刻唤醒也不要插手」「管家回复的渲染似乎有点小问题」（截图：`20%~25%` 被画成删除线）。
> 看完盘点后对五条待裁的拍板：① Claude Code / Kimi 引擎下管家管不到权限 —— **不用改**；② 用户自己开的线程 —— **可以适当放宽**；
> ③ 管家常常只说「留给你」不表态 —— **加强**；④ 拼接 / 编码命令拦不住 —— **看你判断**；⑤ 文档里过时的等待时长 —— **更新文档**。

## §0 一句话

**全自动（bypass）回到五档里，带自己的一套确认；智能自动把「停下来问的那几条」真正交给管家：待决一产生就叫醒它、它必须表态、
用户自己开的线程也归它管 —— 但用户正看着的那一条它不碰。**

## §1 盘点（改动前）

| 项 | 事实 | 出处 |
|---|---|---|
| bypass 在后端 | 一直完整支持：`PERMISSION_MODES`、`PATCH /api/sessions` 与配置写口的 `confirm:true` 门、`nativeToolGate` 恒 allow、CLI 起 `bypassPermissions` / Kimi `yolo` | 01e、07、13d、06k、05、05b |
| bypass 在界面 | 121-K5 拆掉经典壳 `#permSelect` 后，管家壳四档表 `STEWARD_PERMISSION_MODES` 不含它；已经是 bypass 的线程 chip 显示成「跟随全局」 | steward-chips.js |
| 智能自动的判据 | 没有模型分类器：read / edit 放行，exec 只在命中五类豁免字面量时问（`stewardToolPermanentlyExempt`） | 07 `nativeToolGate`、06i |
| 代批链路延迟 | 轮询 15 s ＋ 去抖 5 s ＋ 模型；实测均值 31.5 s、最大 42.7 s | 46 号文 §5、管理员手册 |
| 代批范围 | 十道闸；闸 3 只放「管家看管或定时任务开的」线程，用户自己开的线程一律等用户按 | 06i `stewardExemptDelegationVerdict` |
| 不表态 | 真模型常常不调 `steward_decide`、只说一句留给你 | 45 号文 §9.6.5 (b) |
| 间接构造 | `& ('shut' + 'down') /s` 在智能自动下不停下来问（只拦代批，不拦停问） | 06i 107-S1 ② 头注 |
| 等待时长 | 注释与手册还写着 120 s / 600 s；实际 `permissionTimeoutMs` 自 2026-09-24 起缺省 0（不限时），定时任务 30 分钟 | 01、04、13k |

## §2 全自动（bypass）回到界面

- 五档表 `STEWARD_PERMISSION_MODES = default / acceptEdits / plan / auto / bypass`；二次确认档 `STEWARD_PERMISSION_CONFIRM_MODES = auto / bypass`
  （与 01e `PERMISSION_MODES_REQUIRING_CONFIRM` 同口径）。线程 chip、盾牌菜单、设置页默认档三处都读这一份。
- 确认文案按档取：`confirm-panel.js` 的 `permissionConfirmSpec(mode)`。智能自动仍是 §8.6 那五条；全自动另有四条
  （`stewardShell.permission.bypassConfirm1..4`）—— 智能自动那条「底线项永远等你按」对全自动是假话，不能共用。
- 样式：盾牌 `[data-permission="bypass"]` 用警示色、盾内感叹号字形；两处菜单里这一项的档名同色。
- 新手向导仍是四档（不在第一次见面就摆出全自动）；定时任务仍永远不用 bypass（06j / 13s 不变）。

## §3 应答速度

- **事件唤醒**：13i 订阅 `thread.needs_you`，待决一产生就补两拍收件箱轮询（0.4 s / 2.5 s；事件在待决落盘之前派，第二拍兜慢盘）。
  只是补拍：收件箱写面仍只有 `stewardTickOnce`，去重 / 合并 / 在场门一道不少。
- **去抖分档**：队列里有线程正卡着的权限 / 提问待决时，管家回合去抖 5 s → 1 s（`STEWARD_BLOCKING_DEBOUNCE_MS`）；速查答案仍是 0、其余通知仍是 5 s。
- 实测（假端点，轮询拉到 120 s）：待决产生 → 进收件箱约 0.45 s。之后只剩管家模型自己的一次往返。

## §4 用户正看着的，管家不插手

- 在场信号多一个可缺参数 `?viewing=<线程,…>`（13r 清洗：safeSessionId、去重、≤8）。前端 `presence-viewing.js` 只在
  **页面可见、窗口有焦点、近 60 s 有键鼠操作**时才报；候选三处：开着的权限 / 提问弹窗、展开的待办小窗、管家视角里开着且有待决的焦点栏。
  弹窗会在没人碰时自己弹出来，人不在跟前时那不算「在看」，所以要第二个条件。
- 服务端两道门同一个单点 `stewardSeatedByUser`（13k）：任一连接的 viewing 含这条线程 = 用户在跟前。代批 / 代答 / 递话 / 续跑都拒（`seated_by_user`）。
- 收件箱在场门（13i ⑤）：被看着的线程的待决**扣住不丢**（`viewHeld`），每拍按当时的在场重判；用户收起或走开就进箱，已结算的悄悄扔掉。
  不能像「坐在线程上」那样丢：游标已经越过这条待决，丢了管家就永远不知道它还挂着。

## §5 决策范围（拍板 ②：适当放宽）

- 闸 3 `not_watched` 只认显式「别盯了」（`stewardWatch:false`）。用户自己开、按智能自动在跑的线程也可以代批 —— 其余九道闸一道不松
  （档位必须是智能自动、底线项、扫全 300 字、间接构造、绝对删除目标、读过网页后不外发 / 推送、理由、每小时 6 次），
  而且用户坐着 / 看着时由 §4 先挡住。
- 「这条线程的权限请求归管家处理」收成一个判据 `stewardMediatesPermissions`（13k）：看管的、定时任务开的，以及按智能自动在跑的；
  显式「别盯了」的、用户正坐着 / 看着的不算。回合收尾的「留给你」通知与 §6 的追问读它。
- **等多久不跟着放宽**：配了权限时限时「管家盯着的线程至少等 600 s」那一格（`stewardMediatedPermissionWaitMs`）仍只认看管的线程 ——
  用户给自己开的线程配了时限，那是他的意思，不因为按智能自动在跑就被悄悄拉长到 10 分钟（`session-permission-mode.e2e` ⑩ 钉着）。

## §6 必须表态（拍板 ③：加强）

- 提示词：收件箱尾句（06b `inboxTrailer`，中英）与 `steward_decide` 工具描述写明「智能自动线程停下来问的权限请求是交给你的：每条都表态」；
  豁免摘录块（13p）可代批的那一支从「你可以判断」改成「这一条等你表态」。
- 机制：13l 记下管家调过 `steward_decide` 的待决（被工具挡回也算表过态）。收件箱回合收尾时，经手线程上还挂着、管家既没调过也没做成按钮的
  权限请求，**不立刻报「留给你」**，带 `nudge:true` 排回队头；下一回合那一行多一句点名的「追问：」。每条最多追问一次，追问之后仍不表态才报「留给你」。

## §7 拼接 / 编码命令（拍板 ④：我的判断）

- 智能自动的停问判据加一张**强信号**表 `STEWARD_AUTO_ASK_INDIRECT_PATTERNS`（06i `stewardAutoAskIndirect`）：`iex` / `Invoke-Expression`、
  `FromBase64String`、`powershell -EncodedCommand`、调用运算符或 `Start-Process` 作用在拼出来的名字上、`[char]` 配 `-join`、`cmd /c` 里的 `^` 打断。
- **弱信号不接**（裸字符串拼接、单独的 `[char]` / `-join`）：正常脚本里太常见，接进来会让智能自动隔三岔五停下来问无害的拼接。
  它们仍然只拦代批（107-S1 ② 的那张表不变）。
- 停下来之后 `steward_decide` 的放行类一律回 `propose_required`（`blockedBy:indirect_command`），拒绝类照常。
- 已知没覆盖：先把拼好的串存进变量、隔几行再 `& $x`。要治得有一个 shell 求值器；由执行闸与审计兜底。

## §8 顺手修：波浪线删除线

marked 的 GFM 删除线把**单个** `~` 也当成一对（vendor 规则 `/^(~~?)…\1/`），中文写区间的 `20%~25%` 一句里出现两次，中间整段被划掉。
`chat-render-primitives.js` 的 `createMarkdownParser` 建一个自己的 `Marked` 实例，只认成对的 `~~双波浪~~`，落单的 `~` 原样当字；不改全局 marked。

## §9 没改的（拍板 ①）

- Claude Code 的 `auto` 用它自己的分类器（`--permission-mode auto`，不挂 `--permission-prompt-tool`）；Kimi 的 `auto` 走它原生的 auto，
  宿主那道豁免检查对 auto / bypass 直接放行。这两条引擎下管家看不到权限请求。按用户拍板维持现状。

## §10 测试

| 件 | 钉什么 |
|---|---|
| `steward-viewing-gate.e2e.js`（新） | W 待决产生 → 进收件箱（轮询 120 s 下约 0.45 s）；V 看着时不进箱、`steward_decide` 回 `seated_by_user`、走开后扣住的那条进箱、别的线程照常 |
| `steward-drawer.e2e.js` / `steward-settings.e2e.js` | 五档菜单；全自动出它自己的四条确认、确认后落盘 bypass、chip 与盾牌回填 |
| `permission-plain.browser.e2e.js` | 真浏览器：权限弹窗摆在面前时事件流带 `viewing=`，收进小窗后不再带 |
| `steward-exempt-delegation.e2e.js` | D80 显式「别盯了」→ not_watched；D85/D86 拼出来的命令停下来问、管家放行被拒；D97b 用户自己开的线程过闸 3（额度满时停在 hourly_cap） |
| `steward-deferred-permission.e2e.js` | P2f 报「留给你」之前先追问一次、只追问一次 |
| `unit/auto-indirect-gate.test.js`（新） | 强信号在智能自动下问；正常脚本（裸拼接、`& (Join-Path …)`、`node -e` 里的拼接）不误伤；其余档位口径不变 |
| `unit/presence-viewing.test.js`（新） | 规范化、人在不在跟前三条件、追踪器通知；prompt-queue 的 viewingSessionIds |
| `unit/markdown-tilde.test.js`（新） | 截图原句不再出删除线；`~~双波浪~~` 照旧；gfm / breaks 不变 |
| `unit/steward-exempt.test.js` | 闸 3 重钉：十道闸的顺序走查与用户线程放行 |

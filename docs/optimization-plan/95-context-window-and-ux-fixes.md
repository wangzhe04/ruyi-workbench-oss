# 95 · 子代理上下文窗口、回溯提示与管家默认模型

更新：2026-10-22。状态：**窗口与回溯两项已修并验证；管家默认模型一项待用户证据**。起点提交 `a901ffe8`，分支 `codex/3.1-completion-plan`。本批不属于 3.1 发布范围，是用户反馈的三处体验/配置问题。

## 1. 子代理上下文窗口（已修）

**症状**：子代理压缩频率明显高于主对话。

**根因两层**：

1. 名称表里 `deepseek` 是 128K（`context-governance-rules.json` 的 `modelWindows`，`deepseek-v4` 单列为 1M，但 `deepseek-flash` 落到通用 `deepseek` 行）。主对话之所以是 1M，是因为设置里有一条 `contextWindowOverrides["openai","deepseek","deepseek-flash"] = 1000000`。
2. `agentNodeContextWindow` 的 openai 分支只走 `providerContextWindow(provider, model)`，**完全不读**这条 per-model 覆盖；节点只能拿名称表的 131072。于是子代理在 ~105K 就压缩，而主对话要到 ~800K——正好是"子代理压缩频繁"。

**修法**：

- `10-context-governance.js` 的 `agentNodeContextWindow`：openai 节点先查 `configuredConversationWindow(config, 'openai', provider.id, model)`，命中就用它；覆盖键与**学习上限键**（`<providerId>/<model>`）用同一个「有效模型」（节点自己的 model，空则用 provider 的 model），所以 context-400 学到的上限对子代理同样只降不升。没配覆盖才回落到「provider 手填 → 探测 → 名称表 → 1M 兜底」。
- `context-governance-rules.json` 增加 `deepseek-flash = 1000000`（放在通用 `deepseek` 之前）；前端 `ctxWindowGuess` 的同序兜底同步加一行。通用 `deepseek`（v3/chat/reasoner）仍是 131072，没有一刀切。

**验证**：新增 `dev-harness/unit/agent-context-window.test.js` 3 项——表里 `deepseek-flash`/`deepseek-v4-flash` = 1M、`deepseek-chat` = 128K；openai 节点在有无 per-model 覆盖时分别得到 1M / 128K；越界的手填值（4000）被忽略、claude 节点的 agent 覆盖不受影响。

**说明**：名称表是"最后兜底"；provider 级手填值仍优先于探测与名称表，但更具体的 per-model 覆盖会取代它。高估的窗口一律被 `learnedWindowCap`（context-400 学习，只降不升）压回去——这一条对没有自报 model 的节点同样成立（见 §5 的 P1）。

## 2. 插话后撤回：前端显示失败但实际上已撤回（已修）

**根因**：`chat-render-primitives.js` 的撤回弹窗把「发请求」和「回读会话 + 刷新左栏/右栏」放在同一个 `try/catch` 里。撤回请求成功后，`GET /api/sessions/:id`、`refreshSessions()`、`renderCurrentSession()` 任何一步抛错，都会落到同一个 catch，弹出「回溯失败」——而服务端的截断早已落盘。服务端 `rewindSession` 成功分支只返回 `{ok:true, removedTurns, lastUserText, filesReverted:[], filesFailed:[]}`，没有"先改后报错"的形态。

**修法**：

- 只给那一发 `/api/session/rewind` 请求单独 `try/catch`：它失败 = 什么都没退，照旧弹「回溯失败」。
- 成功之后交给新的 `refreshAfterRewind(sid)`：内部自己 try/catch，刷新失败只 `console.warn`，屏幕上仍然是「已回溯 N 个回合」的真实结果。
- 静态锁：`action-feedback.static.e2e.js` 的 D2 改为锁新结构，并新增 R1/R2——刷新函数里不许出现 `toast(`、撤回弹窗里不许再直接调 `refreshSessions(`。

**验证**：`node dev-harness/action-feedback.static.e2e.js` 全过（含 D2/R1/R2）。

## 3. 管家默认模型是 Opus-5.5（待证据，未改代码）

**调查结论**：

- 仓库里**没有**把 `claude-opus-5-5` 当作管家默认值：`defaultConfig` 的 `stewardProviderId`/`stewardModel` 都是空串；`workbench.defaults.json`（各 dist 包里那几个）只有引擎/权限/工作区字段，不含 providers 或 steward 配置；全仓 `opus-5-5` 只出现在 dev-harness 的假 Anthropic provider 与协议测试里。
- 空串的语义是「跟随主端点 / 用这家服务商的默认模型」（`06i-steward-core.js` 的 fallback 链：自己配的端点 → 全局主端点 → 第一个能对话的端点）。所以如果某台机器上第一个可用端点是 Anthropic 系的代理、其默认模型是 `claude-opus-5-5`，管家就会**继承**它——看起来就像"包体默认是 Opus-5.5"。
- 管家配置分级里 `stewardModel` 是 `free`（管家可改自己用哪个模型），这也放大了这种继承带来的混乱。

**需要用户/反馈者提供的证据（按其一即可）**：

1. 出问题机器上的 `%USERPROFILE%\.ruyi-workbench\config.json`（脱敏后）：`providers[].id/model/apiStyle`、`activeProvider`、`stewardProviderId`、`stewardModel`；
2. 那份安装包的 `config\workbench.defaults.json` 或安装目录里任何预置 `config.json`；
3. 管家失败时的界面报错原文（模型不存在 / 无权限 / 402 之类）。

**候选修法（拿到证据后二选一或并用）**：

- **A. 设置页显式化**：`stewardModel` 为空时，管家设置里直接显示"实际生效：`<providerId>/<model>`"，而不是留一个空输入框；向导的"跟随主端点"卡片同样把解析结果显示出来。改的是显示，不动语义。
- **B. 出厂默认不继承高价模型**：若确认包体预置了某个具体模型，改成空串（跟随主端点）或让向导把用户选的那个模型写进 `stewardModel`；再考虑在 3.1 的 M6 发布门里加一条"管家能实际跑通一回合"的冒烟。

在上述证据到位前不猜着改：把 `stewardModel` 强行改成某个模型，会把"跟随主端点"这个已有选择变成不可逆的显式值，也会让换了主端点的用户莫名跑在旧模型上。

## 4. 验证与边界

- 新增 `/ 改动`：`agent-context-window.test.js`（3 项）、`agent-context-window-cap.test.js`（2 项）、`action-feedback.static.e2e.js`（D2 改 + R1/R2）、`context-governance-rules.json`、`chat-render-primitives.js`、`10-context-governance.js`。
- 回归：完整单测、`fast` 静态、`syntax-gate`、`build --check`、依赖图与 facts 计数按常规跑（见提交说明）。
- **没有改**：压缩触发阈值本身（`autoCompactThreshold` 与各层预算一个字未动）；管家默认模型的解析链；任何 provider 配置。

## 5. 独立审查记录（2026-10-22）

审查方式：独立子代理（worker、exec 档、71 次工具调用、DeepSeek `deepseek-flash`），工作树冻结后审查，并用临时 `RUYI_HOME` + 种子 `windowCaps` 直调导出函数做运行时探针。结论：**需修复**。

| 编号 | 严重度 | 问题 | 处理 |
|---|---|---|---|
| P1 | **必修** | `agentNodeContextWindow` 查覆盖键用了「节点 model‖provider.model」，但传给 `providerContextWindow` 的是节点原始 model；节点不自报 model 时学习键变成 `ds/`，命中不到 `ds/deepseek-flash` 的窗口上限 → 主对话被压到 200K、子代理节点却按 1M 跑 | 改为同一个「有效模型」同时用于两处；新增专门的 cap 回归用例（见 P2），并修正 §1 的表述 |
| P2 | 建议 | 新单测没覆盖"学习上限压过手填值"，恰好是 P1 漏网的地方 | 新增 `dev-harness/unit/agent-context-window-cap.test.js`（2 项）：种子 `ds/deepseek-chat` cap=200000 后，带 model 与不带 model 的节点都得到 200000；换 model 的节点不被该 cap 误伤 |
| P3 | 文档 | "手填值仍然优先"与实现不完全一致（per-model 覆盖会取代 provider 级手填） | 按实现改口径 |
| P4 | 提交卫生 | 两个新文件仍 untracked，而 facts 计数已把它们算进去 | 提交时一起 `git add`，提交前再跑一次 facts 门 |
| P5 | 低 | 服务端回 `ok:false` 时弹窗已关、按钮停在"回溯中…"，不能原地重试 | 把 `ok:false` 判定提到 `modal.close()` 之前，并把按钮复位——两条失败路径都可原地重试 |

审查者复核通过、未改动的点：覆盖键在设置写入、后端 `contextWindowOverrideKey`、运行时探针三处同形；名称表四处顺序正确（`deepseek-v4`/`deepseek-flash` 都在通用 `deepseek` 之前，`deepseek-v4-flash` 仍命中 v4）；`Math.min(resolved, cap)` 只降不升；`refreshAfterRewind` 内无 `toast`、成功提示用的是刷新之前的 `r`；文档没把管家默认模型写成已修；`autoCompactThreshold` 等压缩阈值零改动；零新依赖。

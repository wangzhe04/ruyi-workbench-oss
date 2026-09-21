# 53 · 第 132 波 —— 委托书界面重做；管家能改的设置从 40 个放到 100 多个

> 状态：**用户 2026-09-21 提出两条，本文出方案并同日实施**。出方案与执行：Fable（主会话）。
>
> 用户原话：「1. 这个界面的用户体验很糟糕；而且用户点了看原件后收不回去，重新设计一下；
> 2. 当前如意管家能自己改动的选项似乎还是比较局限，我希望能尽量改如意更多的选项」。
> 实拍：委托书带展开后是一整屏 `<pre>` 文本；「看原件」把第一条消息展开成带 `<steward-brief added-by="steward">`
> 围栏的原始 XML，且再也折不回去；管家对「线程提问的等待时长」答「改不了」。

## §1 委托书界面（132a）

### 1.1 病灶

1. 带展开后把管家补充当一坨 `<pre>` 印，14 em 滚动框，「目标：／验收项：／约束：」全靠冒号分行，读不出结构。
2. 「看原件」的落点是第一条用户消息，它被展开成**围栏 XML 原文**（`<steward-brief added-by="steward">…`）——
   那是给线程看的传输格式，不是给人看的。
3. 展开是**单向**的：124 走查时定为「用户明确要求看它，再折回去是跟他对着干」，用户现在说了：收不回去才是对着干。
4. 折叠态把第一条消息整个藏成一行虚线，用户看到的「我说了什么」被抹掉了。

### 1.2 新形状

- **带**：折叠行不变（▸ 委托书 · 摘录 · 多久前 · 按钮），多一枚「验收 N 项」小计数。展开后是**结构化字段**：
  目标（原话）、验收项、相关文件与上下文、偏好、约束 —— 各自是列表，空的不画；正文整体限高 40vh 自滚。
  结构从哪来：**服务端落盘**。`steward_thread_new` 那一刻管家给的就是分好字段的 brief（goal / acceptance / context /
  preferences / constraints），06i `buildStewardBrief` 现在把裁剪后的字段一并回出（`fields`），13k 存进 `session.brief.fields`。
  前端零二次解析（124-P2 的纪律不变）；没有 `fields` 的老线程回落到 `<pre>` 原样。
- **第一条消息**：正常画成用户气泡，正文只有**用户原话**；管家补充收进气泡里一个 `<details>`
  「管家补充的交办要点（N 项）」，展开才见逐字的补充文本（就是原件里围栏内的那一段）。围栏标签不再上屏。
  数据一个字不动（`session.messages[0].content` 仍是整段原件，回退／检查点／复制读的还是它）。
- **「看原件」变成开关**：点一下 → 滚到第一条、把那个 `<details>` 打开、闪一下，按钮变「收起原件」；再点 → 合上、
  按钮变回来。开合状态按线程记在内存（换走再换回来照旧），刷新回默认合上。
- 不再整行折叠第一条消息（`is-original-folded` 那一族撤掉）。

### 1.3 判据

thread-commission.browser：B4 改钉「展开后验收项逐条在结构化列表里」（老线程另有 `<pre>` 回落）；B5/B9 改钉
「第一条气泡正文 === 用户原话、围栏字符串不上屏、details 默认合上」「看原件 → 开 + 闪 + 按钮变『收起原件』」
「再点 → 合上」「换线程记忆」「数据不变」。thread-commission.static 的 ⑧⑨ 组随之改锚。

## §2 管家能改的设置（132b）

### 2.1 现状与问题

三档白名单（06i `STEWARD_CONFIG_TIER_*`）：free 16、confirm 24、**forbidden 123**。forbidden 里绝大多数是运行参数
（等待时长、摘要与压缩旋钮、并发上限、模型清单、调度器……），当初一律 fail-closed 是「新增键默认最保守」的纪律，
不是逐个判过。用户要的是：**除了真不能碰的，都让管家改得动**。

### 2.2 重新分档的判据（只这三条）

| 档 | 判据 | 用户要做的 |
|---|---|---|
| free | 改错了一眼看得见、一键改回；不花钱、不改权限、不扩大能动世界的范围 | 无（管家直接改，决策日志可回退） |
| confirm | 会花钱、换执行主体、改「谁能不问就做什么」的边界，或影响用户多久看得见一件事 | 按一下管家递来的按钮 |
| forbidden | 密钥；数据根与围栏；命令／桌面／工具放行；提示词注入面；自我扩权开关；簿记与用户行为记录 | 只能自己去设置页 |

### 2.3 新分档（默认表 163 键）

**free（31）**：原 16 ＋ 五个等待时长（`permissionTimeoutMs`、`questionTimeoutMs`、`turnIdleTimeoutMs`、
`autonomyPauseOnTimeout`、`autonomyPauseTtlMs` —— 变短只会更早拒、变长只是多等，不放行任何东西）＋
`dismissedMcpIds`（只是「别再推荐这个」）＋ `monitorIncremental`、`includePartialMessages`（显示粒度）＋
`storagePolicy`（日志保留天数）＋ `killOnDisconnect`、`killPortOnStart`（启停整洁度）＋ `toolCatalogCacheTtlMs`、
`enableToolRequiresProbe`、`sessionSearchIndexV1`、`runtimeFailureTelemetryV1`（纯本地开销）。

**confirm（93）**：原 24 ＋ 引擎与上下文旋钮（全部 `runtime*V1`、`summary*`、`budgetGuard*`、`toolTimeBudget*`、
`autoCompactThreshold`、`contextWindowOverrides`、`thinkingBudget`、`claudeThinkingEffort`、`betaInterleavedThinking`、
`maxTurns`、`openaiMaxToolIterations`）＋ 并发与班组（`subagentMax*`、`agentWorkflowMaxNodes`、`agentNodeWrapUpMs`、
`agentTaskPool*`、`agentAutoModelTiering`、`shellSessionMax`、`boundedRead*`）＋ 模型清单（`knownModels`、`extraModels`、
`discoverModelsFromProxy`）＋ 记忆容量（`coreMemory*`、`memory*`、`runtimeMemoryVectorRecallV1`）＋ 调度与安静卡
（`schedulerEnabledV1`、`schedulerAskWaitMinutes`、`quietCardSnoozeMinutes`）＋ 管家注意力（`threadIndexRecent`、
`stewardThreadModels`、`newThreadEngine`）＋ 工具装载（`toolLoadingMode`、`metaToolHintsV1`、`actionArgumentModelViewV1`、
`toolEconomicsShadowV1`、`runtimeExecResultCacheV1`、`execResultCacheMaxEntriesV1`）＋ 钱与账（`usageBudget`、`claudePricing`）＋
`autoResumeClaudeSessions`。

> 其中 `stewardThreadModels`／`newThreadEngine`／`threadIndexRecent`／`schedulerAskWaitMinutes`／`quietCardSnoozeMinutes`
> 是 117l／121／123 波**明确**留在 forbidden 的（「不能让模型自己换执行主体／调注意力面／决定用户多久看见」）。
> 本波按用户新拍板改成 confirm：管家仍不能自己动，但可以**递按钮**，用户按一下才生效。

**forbidden（39）**：密钥与认证（`providers`、`modelsApiKey`、`searchBackend`、`claudeAuthMode`；正则兜底不变）；
数据根与围栏（`defaultWorkspace`、`workspaces`、`recentWorkspaces`、`additionalDirectories`、`allowOutsideWorkspace`、
`stewardWorkspaceRoot`）；命令行与提示词（`claudePath`、`kimiPath`、`extraClaudeArgs`、`appendSystemPrompt`、`agentRoleOverrides`、
`residentSkills`）；放行面（`allowCommandTools`、`allowDesktopTools`、`desktopMcp`、`toolAllowRules`、`bridgedToolTiers`、
`mcpCommandMode`、`permissionBridge`、`autonomyAutoResume`、`bridgeExternalToolsToProvider`、`toolbox`、`autoImportClaudeCodeMcp`、
`capabilityProbeUrl`）；自我扩权（`stewardExemptDelegationV1`）；簿记与行为记录（`configSchema`、`version`、
`configExplicitKeysV1`、`onboarding`、`lastUsedEngineRoute`、`*Migrated`）；`stewardContextBudgetTokens`（键名撞密钥正则，
不开例外，理由见 06i）。

### 2.4 让管家知道每个键是什么

光放开没用：模型得知道 `turnIdleTimeoutMs` 是「回合多久没动静算卡住」。06i 新增 `STEWARD_CONFIG_HELP`（每个 free／confirm
键一句人话，中英各一份，含单位与范围），`steward_config_get` 随值回 `help`；工具描述改成「大多数运行参数都能改，先 get 看
help 与 tier」。提示词里那句「不能由你改的：模型端点／模型／权限模式／输出风格／界面语言」删掉（早就过时）。

### 2.5 判据

unit/steward-config-tier 的显式期望表整份重写（仍要求默认表每键有判）；steward-config-tools.e2e 的 forbidden 样例
（密钥／数据根／放行／注入）照旧红；新增 help 覆盖锁：free ∪ confirm 的每个键都有中英 help，一条不漏。

## §3 切片

| 片 | 内容 | 判据 |
|---|---|---|
| 132a | 委托书带结构化 ＋ 第一条消息「原话 + 折叠补充」＋「看原件」开关 | thread-commission.browser／static 重钉 |
| 132b | 三档表重分 ＋ help 目录 ＋ config_get 回 help ＋ 工具描述与提示词 | unit 期望表；steward-config-tools；help 覆盖锁 |

# 优化方案历史归档

> 更新：2026-10-21。本目录共保留 69 篇历史方案：早期 14 篇，加本轮迁入的 55 篇设计、实施与验收记录。归档不表示全部范围都已完成，也不撤销仍适用的行为契约；历史状态与结果按各自日期解释。

当前 3.1 补完范围、隐私能力边界与发布门以 [86 号路线](../../optimization-plan/86-3.1-completion-and-privacy-roadmap.md) 为准，产品状态见 [全局路线图](../../OPTIMIZATION-ROADMAP.md)，现行规范与候选研究见 [方案索引](../../optimization-plan/README.md)。旧分支、旧排期和“下一轮”不作为今日执行指令。

## 3.1 已有实现与候选验收（17 篇）

| 编号 | 记录 | 阅读边界 |
|---|---|---|
| 63 | [管家 3.x 首批：启动所有权与轻量读取契约](63-steward-startup-read-contracts.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 64 | [管家 3.x 第二批：运行快照可信度与停止回执](64-steward-health-stop-receipts.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 65 | [管家 3.x 第三批：执行身份与全局故障提示](65-steward-execution-identity-global-health.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 69 | [3.1 同名任务候选的身份与消歧](69-steward-candidate-identity.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 70 | [3.1 递话失败与迟到响应的保护](70-steward-handoff-failure-retry.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 71 | [附件续办与搜索范围说明](71-steward-attachments-search-scope.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 72 | [DeepSeek Search / Fetch 接入](72-deepseek-search-fetch.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 73 | [交付和修订](73-steward-delivery-revision.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 74 | [事项待决清单与逐项处理](74-steward-task-decisions.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 75 | [设置回执与作用域](75-steward-settings-scope-receipts.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 76 | [单事项多步骤交办](76-steward-single-mission-steps.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 77 | [认可做法复用](77-steward-approved-playbook-reuse.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 78 | [递话发送中刷新恢复](78-steward-handoff-reload-recovery.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 79 | [3.1 源码收口：路由与记忆采用决策](79-steward-31-source-closure.md) | 原始实施、验证与未覆盖边界按正文日期解释。 |
| 80 | [3.1 发布前验收：升级、全新数据目录与实际离线包](80-steward-31-release-acceptance.md) | 早期候选验收；不覆盖后来的新源码和 86 号新增范围。 |
| 82 | [3.1 隐私补充实施记录](82-privacy-31-implementation.md) | 早期候选验收；不覆盖后来的新源码和 86 号新增范围。 |
| 85 | [3.1 隐私识别与设置体验修复验收](85-privacy-rule-and-settings-regression-31.md) | PR #58 已合入；ux15 最终结果与历史失败分开保留，尚未发布。 |

## 2.x—3.0 设计与实施（38 篇）

| 编号 | 文档 | 交付与后续边界 |
|---|---|---|
| 23 | [103–107 架构与上下文序列](23-architecture-repayment-sequence.md) | 103–106 的交付与受限实验见正文；107 后续记录在 [46 号](46-wave-107-release-approval.md)。未过门的实验保持原边界。 |
| 24 | [108–110 提示词、制图与结构](24-waves-108-110-implementation.md) | 各切片交付记录保留；原执行顺序与发布版本属于当时计划，不是当前待办。 |
| 25 | [111–113 压缩、可见性与检索](25-waves-111-113-compaction-visibility-memory.md) | 112/113 有出门记录；111 后续并入 [44 号](44-wave-126-memory-scope-and-compaction-v2.md)。不要按页内最初“候选立项”重做。 |
| 26 | [114 语音识别设计](26-wave-114-asr.md) | 早期设计已由 [45 号](45-wave-127-service-catalog-and-voice.md)、[48 号](48-wave-128-debt-repayment.md)、[51–54 号语音迭代](54-wave-133-voice-presets-and-context-fix.md) 承接；本地组件与真机边界分别保留。 |
| 27 | [115–117 管家设计与迭代](27-waves-115-117-steward.md) | 主体及多轮修复有交付记录；旧壳形态、权限档和默认值后来多次调整，当前体验以现行手册与实现为准。 |
| 28 | [118 新手配置与引导](28-wave-118-onboarding.md) | 交付记录见本文 §7 与 [27 号](27-waves-115-117-steward.md) §11.24；原候选排期已不适用。 |
| 29 | [调度器最初设计](29-wave-119-scheduler.md) | 基础实现由 [37 号](37-wave-123-scheduler-and-commitments.md) 承接；原四类载荷不代表都已实现，现有 reminder/prompt 与后续扩展分开。 |
| 30 | [117q 重复实现审计](30-dedup-audit-wave-117.md) | 保留审计、修复及未修问题；不能把清单中的所有建议当作已交付，也不能当作当前统一待办。 |
| 31 | [管家放权七轴](31-steward-empowerment.md) | 多数能力已由 [49 号](49-wave-129-steward-empowerment-completion.md) 等承接；代批边界后经 [60 号](60-smart-auto-and-bypass.md) 调整，原七轴不是一份新的功能清单。 |
| 32 | [旧交接单与下一批切片](32-handoff-next-cuts.md) | 本文“下一个 agent 的入口”与分支、命令、待合并状态均属历史现场；当前实施从 62 号进入，旧纪律和事故证据保留。 |
| 33 | [2.0/3.0 重复实现审计](33-dedup-audit-2-vs-3.md) | 基线为 c4a620f；裁决与后续收编见 32/34 号，旧位置和问题需重新复现后才能立项。 |
| 34 | [121 一台两视](34-wave-121-one-workbench-two-views.md) | 正文 §13/§14 记录刀序出门；两视角与交办台退役是已有能力，后续界面变化见 [57 号](57-wave-137-parallel-seven.md)。 |
| 35 | [121 之后的旧排期](35-post-121-waves.md) | 122–128 的裁决与历史去向表保留；当前 3.x 排期由 62 号接管，不按旧波次重新执行。 |
| 36 | [122 清障与走查](36-wave-122-clearing-and-walkthrough.md) | 已交付切片与当时回归记录见正文；历史环境红、抖动和未覆盖项不改写成通过。 |
| 37 | [123 定时任务与承诺](37-wave-123-scheduler-and-commitments.md) | 基础调度和管家/UI 接线已记录交付；载荷仅 reminder/prompt，原 playbook/workflow 与自启计划不因此视为完成。 |
| 38 | [输出契约兜底与回放按钮](38-steward-contract-guard.md) | 本次修复已交付；why 键完整性不等于语义真实性，动作回执后续见 [40 号](40-wave-124-dispatch-and-delivery.md)。 |
| 39 | [桌面 MCP 异步预热](39-boot-probe-async-warm.md) | 异步预热修复与测量已记录；历史机器上的耗时是当时证据，不是当前普遍性能承诺。 |
| 40 | [124 交办与交付贯通](40-wave-124-dispatch-and-delivery.md) | P0–P3 有出门记录，但 J06 当时明确未过门；委托书横幅后已退役，不能照早期 P2 设计恢复。 |
| 42 | [125 真实性与失败恢复](42-wave-125-truthfulness-and-recovery.md) | 已交付修复及实测结论保留；J07 过门、J02/J09 部分过门，不能合并写成全面通过。 |
| 43 | [114/111/107 排期融合](43-merge-114-111-107-into-product-line.md) | 历史排期决定；后续执行见 44–46 号，当前不再从此页安排下一波。 |
| 44 | [126 记忆作用域与压缩 v2](44-wave-126-memory-scope-and-compaction-v2.md) | A/B 道交付与开关证据见正文；页内开工定位和原默认值均为历史基线。 |
| 45 | [127 服务目录与语音回填](45-wave-127-service-catalog-and-voice.md) | 收波与真模型验证记录保留；代批策略和等待时长后来经 [60 号](60-smart-auto-and-bypass.md) 调整。 |
| 46 | [2.8.0 发布候选批准材料](46-wave-107-release-approval.md) | 记录的是 2.8.0 候选、修复与打包演练；不能用旧候选读数替代当前版本发布门。 |
| 47 | [2.8.0 Release Brief](47-release-brief-2.8.0.md) | 仅冻结当时 2.8.0 范围；未完成项、人工验证与批准点保留，不自动继承为当前发布结论。 |
| 48 | [128 偿债波](48-wave-128-debt-repayment.md) | 正文已有多批交付和边界记录，页内“开工”是历史状态；残留问题不因本次归类而宣称解决。 |
| 49 | [129 管家放权补完](49-wave-129-steward-empowerment-completion.md) | 已记录只读工具、污染闸、工作区调整、通知、依据式代答与 playbook 交办；定时 playbook 等未做边界仍需单独核实。 |
| 50 | [3.0 发布门证据账](50-3-0-gate-evidence.md) | 历史发布证据快照；部分项后由 51–61 号继续推进，未覆盖的人工门仍按原文记录，不当作当前完整发布证明。 |
| 51 | [130 流式语音输入](51-wave-130-streaming-voice.md) | 130a–c 已有交付，130d 在本文仍为真机待验证；后续改进见 52/54/59 号，不能把全部体验写成已验证。 |
| 52 | [131 语音准确率](52-wave-131-voice-accuracy.md) | 评测与实现已记录，真机走查边界保留；auto 默认选较大模型的旧决定已被 [54 号](54-wave-133-voice-presets-and-context-fix.md) 的优先小模型替代。 |
| 53 | [132 委托书显示与设置分级](53-wave-132-commission-ui-and-steward-settings.md) | 132a 的委托书横幅已按 2026-09-22 用户决定退役；当前仅保留首条消息的 brief-fence 折叠块，见 [现行浏览器契约](../../../dev-harness/thread-commission.browser.e2e.js#L5)。132b 设置分级是已有能力，原键数量为历史快照。 |
| 54 | [133 语音预设、上下文与预热](54-wave-133-voice-presets-and-context-fix.md) | 已记录实现与实测；冷启动、长度档首次编译及未做的预热选项仍按 §9.5 保留。 |
| 55 | [3.0 preview.1 候选与打包](55-release-3.0-preview.md) | 这是候选/打包记录；[57 号 §7](57-wave-137-parallel-seven.md) 后续核实 preview.1 只有标签、未建 Release，实际发布改用 preview.2。 |
| 56 | [预览版后修复与迁移交接](56-post-preview-fixes-and-migration-handoff.md) | 本文不完整回归和迁移待办是当时停点；后续交付、集成验证与剩余边界见 [57 号](57-wave-137-parallel-seven.md)，不再作为换机器入口。 |
| 57 | [137 七路集成与 preview.2](57-wave-137-parallel-seven.md) | 七路交付、发布以及发布后两刀分开记录；未随包发布和未经真机验证的范围不混算。 |
| 58 | [服务商协议层与 Anthropic](58-provider-wire-protocols.md) | 本文登记批 1/2 交付；批 3 与真端点联调须按当前实现另核，不把三批统称全部完成。 |
| 59 | [语音词库与修改学习](59-voice-lexicon.md) | 两步已有实现记录；§7 未验证项与风险保留，不能从合成语料推导全部用户收益。 |
| 60 | [智能自动与 bypass 体验](60-smart-auto-and-bypass.md) | 已实现的事件唤醒、查看中不插手、追问一次和五档界面是当前优化的基座；Claude/Kimi 权限边界按 §9 保留。 |
| 61 | [harness 自评核实与收敛](61-harness-self-audit-followup.md) | A/B/C 批已有实现记录，C5 按用户决定不做；§3 的遗留缺口继续作为证据，不等于已全部解决。 |


## 更早设计（14 篇）

01–03、08–11、13–19 于 2026-08-14 归档；12 号研究路线仍保留在现行方案目录。08 号旧交办台已经退役，见 [34 号](34-wave-121-one-workbench-two-views.md)。

| 归档文档 | 对应交付 | 状态 |
|---|---|---|
| [01-ui-modernization.md](01-ui-modernization.md) | 第50波 UI 视觉焕新（毛玻璃 v4 定稿） | 已落地 |
| [02-steer.md](02-steer.md) | 第47波 Steer Phase A/B + 桥 cancel 契约 | 已交付 |
| [03-tools-mcp.md](03-tools-mcp.md) | 第49波生态工具 + MCP 导入/远程 transport | 已交付 |
| [08-task-sheet-ux-audit.md](08-task-sheet-ux-audit.md) | 第99/100波交办台任务单三段式重构 | 已交付 |
| [09-m3-coverage-gate.md](09-m3-coverage-gate.md) | M3 verify 输入覆盖率（`9696483`） | 已交付 |
| [10-m4-ablation.md](10-m4-ablation.md) | M4 单轴消融纪律（`bcd8fa7`） | 已交付 |
| [11-m1-context-tiering.md](11-m1-context-tiering.md) | M1 上下文分级注入（`0b3100d`） | 已交付 |
| [13-r1-evidence-graph.md](13-r1-evidence-graph.md) | R1 Evidence Graph（`935ad73`） | 已交付 |
| [14-m2-deterministic-nodes.md](14-m2-deterministic-nodes.md) | M2 确定性节点（`caf7e57`） | 已交付 |
| [15-r4-memory-graph.md](15-r4-memory-graph.md) | R4 Local Memory Graph（S1/S2/S3） | 已交付 |
| [16-r5-replan-ledger.md](16-r5-replan-ledger.md) | R5 Replan Patch Ledger | 已交付 |
| [17-m5-methodology-tools.md](17-m5-methodology-tools.md) | M5 codebase_symbol_search | 已交付 |
| [18-m5-debug-recorder.md](18-m5-debug-recorder.md) | M5 debug_hypothesis | 已交付 |
| [19-m5-data-profile.md](19-m5-data-profile.md) | M5 data_profile | 已交付 |

## 历史测量附件

105／106／107 系列 JSON 仍存放于 [现行方案目录](../../optimization-plan/)。相关 live harness 以这些路径作为默认输出，故本轮保留原路径，并修正归档方案中的链接。这些文件是原测试条件下的证据，不是当前验收结果。

# 优化方案索引

> 更新：2026-10-18。当前产品迭代聚焦 3.x 管家体验与功能扩展，4.0 暂缓。旧编号表示历史方案身份，不代表当前执行顺序。

## 当前实施入口

- [62 · 管家 3.x 分轮迭代](62-steward-3x-iterations.md)：当前范围、优先级、固定验收旅程与发布门。
- [63 · 首批启动所有权与轻量读取契约](63-steward-startup-read-contracts.md)：3.0.1 基线上的实施设计及独立验收记录。
- [64 · 运行快照可信度与停止回执](64-steward-health-stop-receipts.md)：第二批故障显示、读取失败与停止结果的设计及验收。
- [65 · 执行身份与管家全局故障提示](65-steward-execution-identity-global-health.md)：第三批停止及撤回身份、全局故障投影、服务重启重取与验收记录。
- [66 · 外部机器人接入如意与管家](66-external-bots-and-steward-channels.md)：本人远程控制与原会话回复的 A 批源码、隔离验收已完成；真平台联调、投递管理、平台允许的进度通知和远程待决待后续实施，尚未发布。
- [67 · 管家代办机器人配置](67-steward-assisted-bot-setup.md)：对话准备配置、专用秘密录入、一次性配对自动识别本人聊天，以及本机确认启用；源码与隔离验收完成，真实平台联调待后续，尚未发布。
- [68 · 飞书应用身份自动发现](68-external-bot-identity-discovery.md)：本机发起的一次固定官方接口探测，用 App ID 与应用密钥取得租户 key 与机器人 open_id 并准备禁用连接；源码与隔离验收完成，真平台响应尚未核对，尚未发布。
- [69 · 同名任务候选的身份与消歧](69-steward-candidate-identity.md)：3.1 第三轮 P1 第一片；递话候选按 `sessionId` 保留身份，同名两条都能选并带区分后缀。源码与离线／真浏览器验收完成，尚未发布。
- [70 · 递话失败与迟到响应的保护](70-steward-handoff-failure-retry.md)：3.1 第三轮 P1 第二片；一次递话一个 attemptId（服务端只执行一次），失败只说「未确认」并可核对回执后再重发。源码与真浏览器验收完成，尚未发布。
- [71 · 附件续办与搜索范围说明](71-steward-attachments-search-scope.md)：手选空闲任务带材料续办，失败保留原话、附件与目标，搜索明确有界索引；未发布。
- [72 · DeepSeek Search / Fetch 接入](72-deepseek-search-fetch.md)：普通任务和管家共用官方独立 JSON API、密钥设置、Markdown 分页与缓存；未发布。
- [73 · 交付和修订](73-steward-delivery-revision.md)：原轮文件、检查来源、就近打开与原任务修订，文件变化及新要求使旧检查失效；隔离、浏览器及本机 DeepSeek 旅程验证，未发布。
- [74 · 事项待决清单与逐项处理](74-steward-task-decisions.md)：按事项保留待决身份，逐项 CAS 与独立回执，保留回答草稿并核对刷新后的原记录；未发布。
- [75 · 设置回执与作用域](75-steward-settings-scope-receipts.md)：按实际写盘结果显示范围与时机，受现值检查保护的撤销，以及任务模型和新任务默认隔离；未发布。
- [全局路线图](../OPTIMIZATION-ROADMAP.md)：产品状态与当前方向导航。
- [文档总索引](../README.md)：开发、使用、发布和历史材料入口。

已有能力先复用，确认缺口再实施。下列文档的历史授权、模型分工、分支名和旧排期不自动成为下一轮指令；“已实现”“验证通过”“默认启用”“已发布”分别判断。

## 候选研究与早期方向（10 份）

保留研究价值和未完成边界。本文归类不授权启用实验开关，也不把候选自动纳入 3.x 或 4.0。

| 编号 | 文档 | 阅读边界 |
|---|---|---|
| 04 | [提示词规范化](04-prompts-workflow.md) | 护栏已有交付记录；外置等剩余方向仍是候选，不能照原波次直接开工。 |
| 05 | [安全、稳定性与工程化方向](05-other-directions.md) | 保留早期问题清单；部分结构工作已由后续波次实施，逐项复核后再选题。 |
| 06 | [HB360 成本与收敛](06-hb360-cost-convergence.md) | 历史基准与部分实现依据；旧费用、模型、样本与收益结论仅适用于原测试条件。 |
| 07 | [MicroAgent 方法论](07-microagent-lessons.md) | 已有方法论工具和独立批次交付；未完成候选仍需单独验证，不重新认领已交付能力。 |
| 12 | [Agent 架构研究](12-agent-architecture-research-roadmap.md) | R4/R5 有收口记录，R2/R3 暂缓；其余研究不自动进入当前版本承诺。 |
| 20 | [运行时优化性价比](20-runtime-optimization-cost-benefit.md) | shadow、主动启用和 telemetry 必须分开；保留 C1 阻断与 F1 仅观测的证据边界。 |
| 21-E2 | [有界只读批次调度器](21-E2-bounded-read-scheduler.md) | E2a/E2c 有实现与重放记录，E2b 待实施；本文不授权改变主动开关默认值。 |
| 21 | [工具调用经济性](21-tool-call-economics-convergence.md) | 保留计量修复、已有实现与受限实验；E2b/E4 延后及历史数据不足不等于已通过。 |
| 22 | [Agent SoC 微架构](22-agent-soc-microarchitecture.md) | 早期方向池；后续实施和启用裁决已写入 [23 号](23-architecture-repayment-sequence.md)，本页最初的“未实施”不是当前状态。 |
| 41 | [个人工作台综合研究与旅程](41-personal-workbench-iteration-plan.md) | 2026-09-12 的代码核查快照与候选库；16 条 J 旅程可复用，附录 C15 等“尚未实现”结论须结合后续交付重新核查。 |

## 历史设计与实施记录（38 份）

以下文件保持原路径，供源码、测试与后续方案溯源。该分类同时容纳已交付、部分验证和有遗留项的记录，不表示每篇方案全部完成。先读页首口径，再查文末交付和未做清单。

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
| 53 | [132 委托书显示与设置分级](53-wave-132-commission-ui-and-steward-settings.md) | 132a 的委托书横幅已按 2026-09-22 用户决定退役；当前仅保留首条消息的 brief-fence 折叠块，见 [现行浏览器契约](../../dev-harness/thread-commission.browser.e2e.js#L5)。132b 设置分级是已有能力，原键数量为历史快照。 |
| 54 | [133 语音预设、上下文与预热](54-wave-133-voice-presets-and-context-fix.md) | 已记录实现与实测；冷启动、长度档首次编译及未做的预热选项仍按 §9.5 保留。 |
| 55 | [3.0 preview.1 候选与打包](55-release-3.0-preview.md) | 这是候选/打包记录；[57 号 §7](57-wave-137-parallel-seven.md) 后续核实 preview.1 只有标签、未建 Release，实际发布改用 preview.2。 |
| 56 | [预览版后修复与迁移交接](56-post-preview-fixes-and-migration-handoff.md) | 本文不完整回归和迁移待办是当时停点；后续交付、集成验证与剩余边界见 [57 号](57-wave-137-parallel-seven.md)，不再作为换机器入口。 |
| 57 | [137 七路集成与 preview.2](57-wave-137-parallel-seven.md) | 七路交付、发布以及发布后两刀分开记录；未随包发布和未经真机验证的范围不混算。 |
| 58 | [服务商协议层与 Anthropic](58-provider-wire-protocols.md) | 本文登记批 1/2 交付；批 3 与真端点联调须按当前实现另核，不把三批统称全部完成。 |
| 59 | [语音词库与修改学习](59-voice-lexicon.md) | 两步已有实现记录；§7 未验证项与风险保留，不能从合成语料推导全部用户收益。 |
| 60 | [智能自动与 bypass 体验](60-smart-auto-and-bypass.md) | 已实现的事件唤醒、查看中不插手、追问一次和五档界面是当前优化的基座；Claude/Kimi 权限边界按 §9 保留。 |
| 61 | [harness 自评核实与收敛](61-harness-self-audit-followup.md) | A/B/C 批已有实现记录，C5 按用户决定不做；§3 的遗留缺口继续作为证据，不等于已全部解决。 |

## 更早的归档与测量附件

- [已迁移的早期方案索引](../archive/optimization-plan/README.md)：01–03、08–11、13–19，共 14 份；12 号研究路线仍保留在本目录。
- 本目录的 `105*`、`106*`、`107*` JSON 是对应历史实验的测量附件，与引用它们的方案一起保留；不是当前跑分、默认配置或新版验收结果。

## 查阅规则

1. 找当前要做什么：读 62 号；找为什么这样做：沿该方案进入历史记录。
2. 判断能力是否已有：核对当前源码、消费者和行为测试；旧方案开头的“未做”可能已被后续交付覆盖。
3. 保留不利证据：部分通过、未覆盖、flaky、缺样本和未发布范围不得合并写成完成。
4. 本目录中的 `#L数字` 源码链接沿用原核查行号，文件可打开，行号可能随代码变化漂移；重新实施时按函数名与历史 commit 核对。
5. 不批量移动这些文档：源码和测试已有路径引用。新状态写在页首，历史正文保留；新规划只在当前入口排期。

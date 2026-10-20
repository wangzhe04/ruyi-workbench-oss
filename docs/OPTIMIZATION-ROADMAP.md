# 如意发布与迭代路线

更新：2026-10-20。当前研发主线是 **3.x 管家体验和功能扩展**；详细范围、优先级、依赖和验收见 [62 号方案](optimization-plan/62-steward-3x-iterations.md)。外部机器人接入新增为 [66 号专项](optimization-plan/66-external-bots-and-steward-channels.md)，首批包含本人账号远程控制真实管家与原会话回复，后续扩展主动进度和远程待决。4.0 暂不确定方向或排期。

## 发布状态

源码收口后的完整回归、升级及实际包验收见 [80 号记录](optimization-plan/80-steward-31-release-acceptance.md)；本地验收候选以字节 hash 标识，正式版本发布仍单独记录。

| 状态 | 依据 | 如何理解 |
|---|---|---|
| 已发布基线 | [3.0.1 发布说明](release-notes/v3.0.1.md)，2026-10-16 | 表示该发布物的范围，不代表之后的源码变化已经打包 |
| 已合入未发布 | [CHANGELOG 的 Unreleased](../CHANGELOG.md#未发布--unreleased) 和 Git 提交 | 当前源码使用 3.0.1 版本；下一版本号在范围冻结时确定 |
| 当前方案 | [3.x 管家迭代](optimization-plan/62-steward-3x-iterations.md) | 3.1 源码与采用决策收口见 79；具体实现和验证边界见 63–79，不是已发布清单 |
| 远期概念 | [Traveler 原始概念](TRAVELER-CONCEPT.md) | 历史探索，未纳入当前排期，也不再预设为 4.0 主线 |

## 当前优先级

2026-10-20 候选包实际反馈触发的识别与设置体验修复见 [85 号记录](optimization-plan/85-privacy-rule-and-settings-regression-31.md)：补强强标签及格式变体，设置页明确区分草稿与已生效状态，并由规则、工具协议和真实浏览器三组独立验证。该轮源码及包证据与 82 号旧候选分开记录。

2026-10-19—20 新增 3.1 发布前功能补充：[凭据加密与本地双向隐私转译](optimization-plan/81-privacy-vault-and-tokenization-31.md)。独立 worktree 已接通凭据存储、恢复事务与入口、生产模型与登记工具的双向转译、自定义正则 worker；默认关闭及按档位启停以 [84 号补充](optimization-plan/84-privacy-tool-transport-and-profiles-31.md) 为准。稳定候选完成真实 DeepSeek 20 场景、实际 Slim／Full 与升级 666 检查点，最终 Windows 回归及历史失败证据见 [82 号记录](optimization-plan/82-privacy-31-implementation.md)。源码未发布，80 号旧包证据不覆盖此功能。

3.1 的第二至四轮及可靠性前置已经完成源码工作包，发送中刷新恢复见 [78](optimization-plan/78-steward-handoff-reload-recovery.md)，路由与记忆收口见 [79](optimization-plan/79-steward-31-source-closure.md)。记忆 P2 经本机固定对照没有稳定收益，关闭新增提示，不继续建设 B/C；主动工具的会话范围与失效漏洞已修复。源码回归与发布包验收分别记录，当前版本仍为 3.0.1，尚未发布新版本。

[管家代办配置](optimization-plan/67-steward-assisted-bot-setup.md)、[飞书身份自动发现](optimization-plan/68-external-bot-identity-discovery.md) 已完成源码与隔离验收；3.1 的第三轮 P1 已完成两片：[同名任务候选的身份与消歧](optimization-plan/69-steward-candidate-identity.md) 与 [递话失败与迟到响应的保护](optimization-plan/70-steward-handoff-failure-retry.md)。本批完成 [附件续办与搜索边界说明](optimization-plan/71-steward-attachments-search-scope.md)，并新增 [DeepSeek Search / Fetch 后端](optimization-plan/72-deepseek-search-fetch.md)。第四轮[交付和修订](optimization-plan/73-steward-delivery-revision.md)已完成源码、行为／浏览器验证和本机 DeepSeek 生成→修订实测；第五轮[事项待决清单与逐项处理](optimization-plan/74-steward-task-decisions.md)已完成实现与验证；第五轮[设置回执与作用域](optimization-plan/75-steward-settings-scope-receipts.md)已完成实现和验证，清单、逐项处理与设置三片闭合；批量操作保留为有明确需求后的候选，第六轮逐项确定小片；全文分片索引、可取消深入查找与 66 号真实平台部署联调保留专项边界；第三轮 P2 记忆的采用决策已在 79 号收口。源码尚未发布。

| 顺序 | 目标 | 建议版本归属 |
|---|---|---|
| 第一轮 | 数据目录单写者、故障与状态新鲜度、真实动作回执 | 3.0.x 修复线 |
| 第二轮 | 统一轻量答疑与派单边界，减少多余分流和追问 | 3.1；明确的契约修正可先发补丁 |
| 第三轮 | 同名任务消歧、附件续办、失败重试、搜索范围说明；P2 验证主动查记忆及用户插话后补查 | 3.1；记忆切片按采用门纳入，不阻塞 P1 |
| 第四轮 | 管家原文、文件、验收与继续修改贯通 | 3.1 收口 |
| 第五轮 | 按事项处理待决，说明设置的作用域与生效时机 | 3.2 |
| 第六轮 | 有界多步骤交办、认可做法复用、定时模板；受限执行事件触发的记忆补召回 | 后续 3.x 候选，逐项验证后决定 |

第六轮首片[单事项多步骤交办](optimization-plan/76-steward-single-mission-steps.md)已实现：一个新事项内的一条协调线程执行 2–8 个有序步骤，复用 DAG、权限待决、预算和租约；隔离行为、真实页面及三类本机 DeepSeek 产物验证通过。重启后的未知结果等待人工核对；其余第六轮候选未因此自动纳入交付，源码尚未发布。

第六轮第二片[认可做法复用](optimization-plan/77-steward-approved-playbook-reuse.md)接入原 Playbook 起草、编辑、保存和普通执行：明确选择认可成果、关键纠正、输入与验收项；规则可恢复、取消及另存副本，新材料结果须逐项核对。起草仍依赖 provider；定时模板与记忆事件触发仍是各自候选，源码尚未发布。

先完成可靠性和高频旅程，再扩大服务类型。既有线程、事项、班组、权限、通知、记忆和调度机制继续复用。跨设备交接、完整编辑器、全局架构重写均不作为当前前置。

执行中记忆 P2 已完成现状/A 对照与采用决策，主动检索覆盖了本批材料、日志及用户插话样本，新增提示没有稳定净收益，按门关闭扩展。以后只有新的可重复遗漏证据，才重新评估 B 或第六轮默认关闭的 C；不扫描思考或普通输出触发，不重建记忆系统。范围与成本、误召回采用门见 [62 号方案](optimization-plan/62-steward-3x-iterations.md#执行中按需补查记忆)，本批证据见 [79](optimization-plan/79-steward-31-source-closure.md)。

## 发布规则

对外版本和内部迭代分开管理。补丁版本优先修缺陷；次版本承接通过验收的用户功能。版本号、源码合入、标签和可下载发布物是不同状态，文档分别记录。

每次冻结范围时列明用户变化、默认值变化、数据兼容性、已知限制和回退方法。相关行为测试必须随实现更新；源码变更经过构建新鲜度和生成清册校验。候选版本运行 Windows 回归，分别记录首次失败、重跑通过的 flaky、跳过项和未覆盖的人工验证。

发布包还需验证全新安装、升级副本、离线启动和核心管家旅程；实际 Slim/Full 包内容、版本和校验和应相符。历史通过记录不替代当前冻结树与当前安装包的验证。更改默认主动策略或语义分流时，按 62 号方案补固定场景评估；纯展示修复不因此等待无关长期实验。

发布说明记录事实，方案记录范围，执行日志记录证据。未经执行的规划、未闭合的验收和未确认的外部测试不记为已通过。

## 历史与研究入口

- [优化方案目录](optimization-plan/README.md)：当前方案、候选研究和历史记录分区。
- [3.0 发布前路线与历史决策](archive/OPTIMIZATION-ROADMAP-HISTORY-3.0.md)：原路线图完整保留；包括早期大版本命名、默认壳层取舍、发布准入和未完成验证。
- [第 46 至 86 波历史](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md)与[第 1 至 45 波历史](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。
- [发布说明目录](release-notes/)与[文档总入口](README.md)。

历史文档中的“当前”“下一波”“待做”只描述各自日期的状态。新实现需先核对今天的代码和测试；用户后来修正的方向以当前方案为准，不恢复已退役界面或重新立项已经实现的能力。

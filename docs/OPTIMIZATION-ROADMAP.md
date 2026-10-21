# 如意发布与迭代路线

更新：2026-10-21。**3.1 暂不发布，先补完原未完成范围与隐私保护，再冻结并重新验收。** 当前范围、依赖、实施顺序、隐私能力边界和发布门统一见 [86 号路线](optimization-plan/86-3.1-completion-and-privacy-roadmap.md)。4.0 暂不确定方向或排期。

## 发布与源码状态

| 状态 | 依据 | 边界 |
|---|---|---|
| 已发布基线 | [3.0.1 发布说明](release-notes/v3.0.1.md)，2026-10-16 | 仅表示该发布物的范围 |
| 已合入、未发布 | PR #58 合入源码 `f5223548`；[CHANGELOG Unreleased](../CHANGELOG.md#未发布--unreleased) | 应用版本仍为 3.0.1；最终 ux15 已验收，不能视为已发布 3.1 |
| 当前 3.1 范围 | [86 号补完与隐私路线](optimization-plan/86-3.1-completion-and-privacy-roadmap.md) | 新范围全部完成并通过冻结源码与实际包验收后再发布 |
| 设计与验证来源 | [现行方案索引](optimization-plan/README.md) · [历史方案索引](archive/optimization-plan/README.md) | 旧版号归属、“后续候选”和旧验收不自动覆盖新范围 |

PR #58 最终 ux15 应用 SHA-256 为 `c38df1ad924ac57905ce31e14dd6ee3529049ded5730e995875b201df936b982`，证据为本机 `D:/rp31-1020u15/validation/merged-verified.json`：CI 四项通过，单测 2468 pass／26 skip，本地 E2E 532 pass／0 fail／4 flaky，远端 532 pass／0 fail／2 flaky，真实 DeepSeek 28／28，实际候选包验收通过。结果与失败历史见 [85 号归档](archive/optimization-plan/85-privacy-rule-and-settings-regression-31.md)；这些读数是既有候选的证据，不是本次文档整理重新执行，也不覆盖 86 号新增范围。

## 3.1 发布前范围

| 工作包 | 当前方向 |
|---|---|
| QQ／飞书接入 | 真平台联调；投递管理、进度与远程待决。按平台支持能力与合法消息窗口验收，复用本人授权、事项与回执 |
| 全链路隐私 | 明确文字、媒体、外部 CLI 与独立 MCP 的支持边界，再补齐实现；媒体须本地处理，选定 CLI 版本的完整支持需托管隔离与出口约束，具体门见 86 |
| 工作数据加密 | 扩展既有凭据库，明确工作数据、附件、索引、恢复及迁移的范围和可验证边界 |
| 找回与续办 | 全文分片索引与跨既有线程接力；复用已有线程、搜索、权限和回执 |
| 定时模板 | 认可做法与定时任务贯通，复用已有 Playbook、调度和执行能力 |

[62 号](optimization-plan/62-steward-3x-iterations.md) 保留分轮设计与旅程；[66–68 号](optimization-plan/66-external-bots-and-steward-channels.md) 保留平台接入契约；[81](optimization-plan/81-privacy-vault-and-tokenization-31.md)、[83](optimization-plan/83-privacy-rule-catalog.md)、[84](optimization-plan/84-privacy-tool-transport-and-profiles-31.md) 保留隐私设计和规则。与新范围冲突时以 86 为准，不从旧文“下一波”恢复排期。

已有线程、事项、班组、权限、通知、记忆、工具传输和调度机制继续复用。记忆 P2 原对照未显示稳定收益的采用决定仍保留；不因扩大 3.1 范围自动启用 B/C、恢复退役界面或安排全局架构重写。

## 发布规则

版本号、源码合入、标签和可下载发布物分别记录。86 号范围完成后，冻结候选并列明用户变化、默认值、数据兼容、已知限制和回退方法；构建新鲜度、生成清册与相关行为测试须对应实际源码。

候选执行 Windows 回归，保留首次失败、重跑通过的 flaky、跳过与人工未覆盖项；不能以重跑抹去原证据。实际 Slim／Full 包需验证新安装、升级副本、离线启动、核心管家旅程、隐私及工作数据恢复，并核对版本和校验和。旧候选、旧包与源码测试均不能代替新冻结树和新安装包验收。

## 历史与研究入口

- [优化方案目录](optimization-plan/README.md)：现行设计、研究候选和历史证据分区。
- [历史方案归档](archive/optimization-plan/README.md)：69 篇旧设计、实施与验收记录。
- [3.0 旧路线](archive/OPTIMIZATION-ROADMAP-HISTORY-3.0.md)、[第 46–86 波](archive/OPTIMIZATION-ROADMAP-HISTORY-46-86.md)、[早期 1.x–2.x](archive/OPTIMIZATION-ROADMAP-HISTORY-V1-2.md)。
- [Traveler 原始概念](archive/TRAVELER-CONCEPT.md)：历史探索，未纳入当前排期。
- [发布说明目录](release-notes/) · [文档导航](README.md) · [归档总索引](archive/README.md)。

历史文档中的状态与读数按各自日期解释。新实现先核对当前源码与测试，不能把旧的“未合并”误当今日状态，也不能把既有候选通过当成新增范围已完成。

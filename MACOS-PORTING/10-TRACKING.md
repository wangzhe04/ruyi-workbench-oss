# 执行与交接看板

更新时间：2026-11-03。**P0 已完成基线、设计契约与技术探针；P1-01 启动与所有权恢复已实现，P1 进行中；P2–P6 待开始**。P0 的开放项与产品兼容完成严格区分，见 [结果](evidence/P0/README.md)和 [v1 决策](11-P0-DECISIONS.md)。

## 1. 阶段状态

| 阶段 | 前置 | 状态 | 负责人 | 实际人日 | 验收记录 |
|---|---|---|---|---|---|
| P0 | 无 | done（设计/基线） | Codex；独立复核 p0_review | 未核算 | [结果](evidence/P0/README.md) / [复核](evidence/P0/review.json) |
| P1 | P0 | in_progress（P1-01 / P1-02 / P1-03 / P1-04） | Codex | 未核算 | [启动](evidence/P1/README.md) / [所有权恢复](evidence/P1/ownership/README.md) / [独立复核](evidence/P1/ownership/review.json) / [执行监督](evidence/P1/supervisor/README.md) / [入口接入](evidence/P1/process-integration/README.md) / [Mac shell](evidence/P1/shell/README.md) / [文件策略](evidence/P1/files/README.md) / [helper 运行时门](evidence/P1/helper-gate/README.md) / [单 helper 故障恢复](evidence/P1/helper-loss/README.md) / [能力状态](evidence/P1/capabilities/README.md) / [发现与界面](evidence/P1/discovery-ui/README.md) / [工作树执行](evidence/P1/worktree-runtime/README.md) / [模型探针](evidence/P1/cli-model-probe/README.md) / [清理句柄](evidence/P1/process-handles/README.md) / [文档读取](evidence/P1/document-reader/README.md) / [媒体执行](evidence/P1/media-runtime/README.md) / [rg搜索](evidence/P1/rg-runtime/README.md) / [异步执行探针](evidence/P1/executable-probes/README.md) / [Python探针](evidence/P1/python-probes/README.md) / [同步探针基础](evidence/P1/synchronous-probe-audit/README.md) / [同步探针接入](evidence/P1/synchronous-probes/README.md) / [overlay平台边界](evidence/P1/overlay-boundary/README.md) / [宿主打开](evidence/P1/opener-completion/README.md) / [搜索取消](evidence/P1/search-cancellation/README.md) / [路径匹配取消](evidence/P1/path-cancellation/README.md) / [写队列取消](evidence/P1/write-queue-cancellation/README.md) / [原子写取消与恢复](evidence/P1/atomic-write-cancellation/README.md) / [文件变更恢复](evidence/P1/file-mutation-recovery/README.md) / [临时清理结果](evidence/P1/temporary-cleanup/README.md) / [受控启动布局](evidence/P1/controlled-layout/README.md) / [主回合Stop](evidence/P1/provider-stop/README.md) / [冻结Mac回归](evidence/P1/frozen-mac-regression/README.md) / [验收缺口审计](evidence/P1/acceptance-audit.md) |
| P2 | P1 | planned | 未分配 | 未记录 | 无 |
| P3 | P1；M1 交付需 P2 | planned | 未分配 | 未记录 | 无 |
| P4 | P2、P3 | planned | 未分配 | 未记录 | 无 |
| P5 | P4 | planned | 未分配 | 未记录 | 无 |
| P6 | P5；探针可提前 | planned | 未分配 | 未记录 | 无 |

29 个工作包的详细状态维护在 [TASKS.json](TASKS.json)。状态值使用 `planned / in_progress / blocked / in_review / done`。`done` 必须有验收、独立复核和处理结果；`blocked` 写具体依赖与可继续的独立任务，不能只写“平台问题”。未开始不记为“0 人日完成”。

## 2. 开工顺序

1. 读取 [入口](README.md)、[架构](00-ARCHITECTURE.md)、对应阶段文档和仓库贡献规范。
2. 核对工作树与 SHA、已有修改及依赖；领取工作包，填写负责人，必要时从 `codex/` 前缀分支开展实现。
3. 先确认验收输入和失败场景，再进行最小范围实现；新增函数先检查现有工具是否可复用。
4. 完成构建/契约更新及相关测试，保存可复核证据；出现范围变化先更新剩余估算。
5. 按项目要求完成独立 agent 代码复核、修复和针对性复测，更新状态后交接。

本看板用于实施记录，不授权发送外部消息、发布软件或修改用户真实应用数据。签名账户或真服务账户不可用时，先完成候选产物与本地验证，登记依赖；已经在后续任务中获得的授权无需反复询问。

## 3. 每个工作包的交付记录模板

```text
工作包：P?-?? / 标题
负责人：
基线 SHA / 交付 SHA：
状态：
实际投入人日 / 剩余估算：
实现范围与文件：
接口或配置变化：
测试环境与命令：
通过 / 失败 / skip / 未执行：
日志或产物位置：
独立复核者、范围、发现：
发现处理及复测：
回退操作与数据影响：
下一阶段依赖 / 未验证限制：
```

日志按阶段放入 `MACOS-PORTING/evidence/P?/`，只保存可公开的脱敏记录；体积大的录像/二进制放合适的制品存储并在此链接。P0 已保存实际执行记录；未执行项单列，不创建空证据代替验证。

## 4. 需要冻结的决定

| 决定 | P0 结论/待验部分 | 实施或复验节点 |
|---|---|---|
| 首发架构与系统范围 | arm64；macOS 14 仍为未验证目标，Intel 单列 | P3/P6 最低系统复验 |
| 宿主技术 | AppKit + WKWebView；Swift 需先匹配 SDK | P4-01 |
| Shell | `/bin/bash --noprofile --norc`，无完整 TTY 仿真 | P1-03 |
| 数据根 | 保持 `~/.ruyi-workbench` / `RUYI_HOME` | P0 |
| 凭据保护器与 helper 身份 | Keychain + 受限 IPC；同发行身份升级稳定 | P0/P2，P4 复验 |
| 桌面测试应用 | 自建窗口、TextEdit、Finder、Chromium | P0/P5 |
| 离线包承诺的组件 | 按实际工具依赖冻结，不为 Full 名称虚挂能力 | P3/P6 |
| 首发升级方式 | 整包替换、数据备份/回退；增量更新另估 | P0/P6 |

设计契约已冻结，正式身份、最低系统与权限开放项按 [v1 决策](11-P0-DECISIONS.md) 逐项关闭。2026-11-02 已接入 Mac 内核锁、有证据的 stale socket 恢复、已观察子树清理与一次性执行监督，未知 socket 归属保持拒绝。接入范围和限制见对应证据。下一步 P1 继续统一其余进程启动入口，随后推进文件边界与 shell 工作包。

## 5. 文档维护规则

任务估算先改 TASKS.json，再同步对应阶段表、入口和工作量文档。改依赖时同步本看板。阶段验收以最新源码和真实测试为准；兼容性审计保留为历史基线，不修改其中的旧测试结果来匹配新实现。

每次重估记录日期、变更范围、证据、旧/新区间及累计实际投入；如缩减范围，用发行能力清单明确表达，不能只降低估算却保留全部功能承诺。

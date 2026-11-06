# 执行与交接看板

更新时间：2026-11-07。**P0 已完成基线、设计契约与技术探针；P1 运行时与系统边界实现阶段已完成；P2及四包已按用户指定排除暂缓项的范围验收完成，暂缓验收独立保留；P3进行中（四包Mac本地单独验收完成，Windows同候选待补验）；P4–P6 待开始**。P0 的开放项与产品兼容完成严格区分，见 [结果](evidence/P0/README.md)和 [v1 决策](11-P0-DECISIONS.md)。

## 1. 阶段状态

| 阶段 | 前置 | 状态 | 负责人 | 实际人日 | 验收记录 |
|---|---|---|---|---|---|
| P0 | 无 | done（设计/基线） | Codex；独立复核 p0_review | 未核算 | [结果](evidence/P0/README.md) / [复核](evidence/P0/review.json) |
| P1 | P0 | done（附限制与P4交接） | Codex | 未核算 | [最终收尾](evidence/P1/closeout/README.md) / [启动](evidence/P1/README.md) / [所有权恢复](evidence/P1/ownership/README.md) / [独立复核](evidence/P1/ownership/review.json) / [执行监督](evidence/P1/supervisor/README.md) / [入口接入](evidence/P1/process-integration/README.md) / [Mac shell](evidence/P1/shell/README.md) / [文件策略](evidence/P1/files/README.md) / [helper 运行时门](evidence/P1/helper-gate/README.md) / [单 helper 故障恢复](evidence/P1/helper-loss/README.md) / [能力状态](evidence/P1/capabilities/README.md) / [发现与界面](evidence/P1/discovery-ui/README.md) / [工作树执行](evidence/P1/worktree-runtime/README.md) / [模型探针](evidence/P1/cli-model-probe/README.md) / [清理句柄](evidence/P1/process-handles/README.md) / [文档读取](evidence/P1/document-reader/README.md) / [媒体执行](evidence/P1/media-runtime/README.md) / [rg搜索](evidence/P1/rg-runtime/README.md) / [异步执行探针](evidence/P1/executable-probes/README.md) / [Python探针](evidence/P1/python-probes/README.md) / [同步探针基础](evidence/P1/synchronous-probe-audit/README.md) / [同步探针接入](evidence/P1/synchronous-probes/README.md) / [overlay平台边界](evidence/P1/overlay-boundary/README.md) / [宿主打开](evidence/P1/opener-completion/README.md) / [搜索取消](evidence/P1/search-cancellation/README.md) / [路径匹配取消](evidence/P1/path-cancellation/README.md) / [写队列取消](evidence/P1/write-queue-cancellation/README.md) / [原子写取消与恢复](evidence/P1/atomic-write-cancellation/README.md) / [文件变更恢复](evidence/P1/file-mutation-recovery/README.md) / [临时清理结果](evidence/P1/temporary-cleanup/README.md) / [受控启动布局](evidence/P1/controlled-layout/README.md) / [主回合Stop](evidence/P1/provider-stop/README.md) / [冻结Mac回归](evidence/P1/frozen-mac-regression/README.md) / [验收缺口审计](evidence/P1/acceptance-audit.md) |
| P2 | P1 | done（用户约定范围；暂缓项未验收） | Codex | 未核算 | [P2 总览](evidence/P2/README.md) |
| P3 | P1；M1 交付需 P2 | in_progress（四包本地验收完成，Windows待补） | Codex | 未核算 | [P3逐包验收](evidence/P3/README.md) |
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

2026-11-03 P1 本地实现候选为 `a8374a243679a673e2e3363f4c9bb4037ff291a9`（`codex/p1-macos-runtime`）。29件相关Mac专项、完整单元与80组静态通过；媒体语法超时曾单次失败，复跑未重现且根因未确认。Finder可见验收与Windows同版本回归待完成，P1保持in_progress。

2026-11-03 用户要求取消本次P1的Windows回归门槛并收尾。P1及四个工作包登记done，实现交付为 `a8374a243679a673e2e3363f4c9bb4037ff291a9`。Finder可见实机交接P4-02/V10；媒体未重现异常保留观察。此前进行中记录为历史快照，当前以最终收尾记录为准。

2026-11-06 P2 开始。P2-01 第一批实现 `8393cfc0` 补齐 Mac CLI 发现、工具策略和中英文平台说明，完成独立评审、2491 条单元通过/18 跳过、80 组静态和 9 组相关 e2e 通过。仅新增 1 件 CLI 发现 e2e，其余复用原测试。正式 Claude/Kimi 未安装，真实账户回合及 Windows 同版本实机仍待验，P2-01 保持 in_progress；下一批推进 P2-02。详见 [交付证据](evidence/P2/cli/README.md)。

2026-11-06 P2-02 本批实现 `6e41e060` 接入受限 Keychain helper、版本信封、凭据/机器人保存与恢复。完整单元2489通过/18跳过、80静态和3组相关e2e通过，独立评审问题已处理。仅新增1件Keychain专项并复用原飞书HTTP链路，未操作真实登录钥匙串。正式授权、签名升级ACL及Windows实机仍待验；P2保持进行中，下一批推进P2-03。详见 [Keychain交付](evidence/P2/keychain/README.md)。

2026-11-06 P2-03 本批实现 `dfa1b9d4` 完成核心业务20组e2e与调度恢复修复，25条调度专项、完整单元2489通过/18跳过及80静态通过；独立评审发现均已处理，无新增测试文件。真实CLI、Windows及P4睡眠唤醒边界保持明确；下一批P2-04。详见 [核心业务证据](evidence/P2/core/README.md)。

2026-11-06 P2-04 本批实现 `79d9dfbd` 贯通Mac Keychain配置整链覆盖并修复领取任务期间stop后的派发窗口；88条bot单元、6组e2e、完整单元2490通过/18跳过及80静态通过，独立评审无剩余代码发现，无新增测试文件。四批本地实施证据齐备；真实CLI/正式Keychain权限与签名/机器人服务/Windows同版本实机未验收，P2保持in_progress。详见 [机器人证据](evidence/P2/bots/README.md)与[P2待验收总览](evidence/P2/README.md)。

2026-11-06 P2-01 真实CLI增量 `8ebb6638`：临时隔离安装官方Kimi0.37.2并复用免凭据本地模型探针，实际发现并修复POSIX全局npm入口遗漏、目录别名导致重复Write审批。真实探针由73通过/11失败修至84通过/0失败/0skip，完整单元2490通过/18skip与80静态通过，独立复核无剩余代码发现。仅8行生产源码、扩展原测试，无新增测试文件。真实账号和实际停止/恢复仍待验。见 [真实Kimi证据](evidence/P2/cli-live/README.md)。

2026-11-06 P2-01 真实生命周期增量 `921e6a89` 复用原探针，完成同一Kimi原生session三回合的Read、活回合停止、aborted落盘/连接释放、再次恢复并新Read。定向19通过，全部八场景96通过/0失败/0skip，独立复核通过。无生产代码变更，不重复无关完整单元；复用前批工程门禁并验证生产树无差异、当前语法/构建新鲜度。真实账号/Claude/Windows等仍待验。见 [生命周期证据](evidence/P2/kimi-lifecycle/README.md)。

2026-11-06 P2-01 真实Claude增量 `0fb63eec` 扩展原live探针的显式本地模式，官方2.1.318经绝对MachO路径与PATH隔离入口均6项通过/0失败/0skip，各5环回请求；真实Bash权限桥、原生--resume、按执行身份stop/aborted落盘、再次续接均有证据。独立评审修复探针隔离/PATH/Windows skip三项问题。无生产代码变化，fixture-home新增启动点清册226专项通过；未重复无关完整单元。测试用Kimi/Claude临时安装已清理。剩余真实账号/正式Keychain/机器人服务/Windows保持未验收。见 [Claude证据](evidence/P2/claude-live/README.md)。

2026-11-06 P2外部验收审计：两家真实CLI本地协议/工具/权限/停止与原生恢复、Keychain隔离域、核心业务和机器人离线链路均已归档，无未处理代码发现；独立复核确认没有必要的新增本地实现或测试。当前只读检查未发现Windows执行入口，签名有效身份数0，尚无指定账号、专用登录Keychain交互账户或Windows同候选结果。相同外部条件已连续多轮未就绪，P2登记blocked，不标complete。正式签名/升级ACL明确交P4/P6；恢复输入、Windows候选命令及Keychain真实ACL步骤见 [交接清单](evidence/P2/acceptance/HANDOFF.md)与[独立审计](evidence/P2/acceptance/review.json)。未新增代码或测试。

2026-11-06 用户答复真实环境“暂不可用，先完成本地实现与离线验证”。据此本次本地交付收尾，P2的localDelivery=done、externalAcceptance=deferred_by_user，phase保留in_progress。再次核对7批实现指纹和68个最新文件，均匹配当前工作树；独立复核确认无剩余本地实现或必要测试。未重复跑无关套件。真实账号、登录Keychain交互、机器人真实服务和Windows同候选验收暂缓且未记通过；签名ACL等后续事项保留。详见 [本地收尾审计](evidence/P2/local-closeout.json)。

2026-11-06 用户要求“除了暂缓部分，整体验收P2”。已按此范围验收并登记P2/四包done。最终候选 `287d2d21` 完整单元2490通过/18跳过，80静态与31组相关e2e通过；最终过程中修复路由覆盖生成清册遗漏、机器人重启夹具旧令牌竞态，均独立复核及相关复测。仅三类既有暂缓项排除，P3/P4/P6原交接保持，未把未执行项记通过。详见 [最终验收](evidence/P2/final-acceptance/README.md)。

2026-11-06 P3-01单独本地验收：实现 `f135bda1` 条件化Windows依赖、Mac共享工具注册和路径护栏；真实43工具/14项MCP、8项Python（真实APFSX）、断网wheel安装通过。独立复核修复大小写缺失保护根、Windows Full正则、pathconf失败及Unicode等价路径问题，无剩余代码发现。完整单元2490通过/18跳过，首轮静态78/80，两个失败组修复复测通过；构建新鲜度与语法通过。Windows同候选实机/CI仍未执行且未豁免，P3整体in_progress。下一包P3-02；详见[P3-01证据](evidence/P3/acc-shared/README.md)。

2026-11-07 P3-02完成单独本地验收，实现 `bd2eb093`：Mac中文Office/图表/PDF字体与短PDF默认读取修复；真实MCP24项、独立产物24项、116 Office/98读取/43图表检查、新环境断网重放、六页独立渲染及视觉对账通过。独立复核发现均处理。完整单元2490通过/18跳过，首轮静态78/80，两个清册组修复复测通过，保留原失败。Windows同候选与最低系统仍未验收，P3整体in_progress，下一包P3-03。见[P3-02证据](evidence/P3/office/README.md)。

2026-11-07 P3-03完成单独本地验收，实现 `35ce93b9`：真实MCP/新环境离线重放各25项、8项生命周期和98读取回归通过；独立复核两个取消清理缺陷关闭。单元2490通过/18既有跳过，静态首轮78/80，两个工程门修正定向通过。Windows同候选回归未执行且未豁免，最低系统/正式发行仍未验证。下一包P3-04，见[P3-03证据](evidence/P3/browser/README.md)。

2026-11-07 P3-04完成单独本地验收，实现 `2f45aba4`：71项资源独立审计，模板38/中英UI18/Playbooks94及相关权限、能力专项通过；独立复核3项发现关闭。完整单元2491通过/18既有跳过，静态79/80，修正旧枚举锁后该组定向通过。四包Mac本地验收完成，P3整体保持in_progress；未执行Windows同候选回归、最低系统和正式发行，不登记M1。见[P3-04证据](evidence/P3/templates/README.md)。

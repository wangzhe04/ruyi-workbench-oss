# 执行与交接看板

更新时间：2026-11-08。**P0 已完成基线、设计契约与技术探针；P1 运行时与系统边界实现阶段已完成；P2及四包已按用户指定排除暂缓项的范围验收完成，暂缓验收独立保留；P3已按用户指定Mac当前主机范围完成最终验收，Windows本轮排除；P4已按用户批准的当前Mac范围完成四包开发与独立验收，Windows后续待验、正式身份暂缓、macOS14实际运行交接O2/P6；P5/P6 待开始**。P0 的开放项与产品兼容完成严格区分，见 [结果](evidence/P0/README.md)和 [v1 决策](11-P0-DECISIONS.md)。

## 1. 阶段状态

| 阶段 | 前置 | 状态 | 负责人 | 实际人日 | 验收记录 |
|---|---|---|---|---|---|
| P0 | 无 | done（设计/基线） | Codex；独立复核 p0_review | 未核算 | [结果](evidence/P0/README.md) / [复核](evidence/P0/review.json) |
| P1 | P0 | done（附限制与P4交接） | Codex | 未核算 | [最终收尾](evidence/P1/closeout/README.md) / [启动](evidence/P1/README.md) / [所有权恢复](evidence/P1/ownership/README.md) / [独立复核](evidence/P1/ownership/review.json) / [执行监督](evidence/P1/supervisor/README.md) / [入口接入](evidence/P1/process-integration/README.md) / [Mac shell](evidence/P1/shell/README.md) / [文件策略](evidence/P1/files/README.md) / [helper 运行时门](evidence/P1/helper-gate/README.md) / [单 helper 故障恢复](evidence/P1/helper-loss/README.md) / [能力状态](evidence/P1/capabilities/README.md) / [发现与界面](evidence/P1/discovery-ui/README.md) / [工作树执行](evidence/P1/worktree-runtime/README.md) / [模型探针](evidence/P1/cli-model-probe/README.md) / [清理句柄](evidence/P1/process-handles/README.md) / [文档读取](evidence/P1/document-reader/README.md) / [媒体执行](evidence/P1/media-runtime/README.md) / [rg搜索](evidence/P1/rg-runtime/README.md) / [异步执行探针](evidence/P1/executable-probes/README.md) / [Python探针](evidence/P1/python-probes/README.md) / [同步探针基础](evidence/P1/synchronous-probe-audit/README.md) / [同步探针接入](evidence/P1/synchronous-probes/README.md) / [overlay平台边界](evidence/P1/overlay-boundary/README.md) / [宿主打开](evidence/P1/opener-completion/README.md) / [搜索取消](evidence/P1/search-cancellation/README.md) / [路径匹配取消](evidence/P1/path-cancellation/README.md) / [写队列取消](evidence/P1/write-queue-cancellation/README.md) / [原子写取消与恢复](evidence/P1/atomic-write-cancellation/README.md) / [文件变更恢复](evidence/P1/file-mutation-recovery/README.md) / [临时清理结果](evidence/P1/temporary-cleanup/README.md) / [受控启动布局](evidence/P1/controlled-layout/README.md) / [主回合Stop](evidence/P1/provider-stop/README.md) / [冻结Mac回归](evidence/P1/frozen-mac-regression/README.md) / [验收缺口审计](evidence/P1/acceptance-audit.md) |
| P2 | P1 | done（用户约定范围；暂缓项未验收） | Codex | 未核算 | [P2 总览](evidence/P2/README.md) |
| P3 | P1；M1 交付需 P2 | done（用户指定Mac范围） | Codex | 未核算 | [最终Mac验收](evidence/P3/final-mac-acceptance/README.md) |
| P4 | P2、P3 | done（用户批准的当前Mac范围，后续待验项独立保留） | Codex；独立复核 p4_host_review | 未核算 | [P4-01 宿主](evidence/P4/host/README.md) / [P4-02 系统桥](evidence/P4/bridge/README.md) / [P4-03 媒体](evidence/P4/media/README.md) / [P4-04 生命周期](evidence/P4/lifecycle/README.md) |
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

2026-11-07阶段补验：已获用户授权发布fork内P3分支并创建[草稿PR #1](https://github.com/Sonata17inD/ruyi-workbench-mac/pull/1)。e844首轮CI的Linux static与Windows release dry-run通过；Windows ACC、凭据IPC及平台基线失败，待日志归因修复，仍未验收Windows。macos-14 job因不支持该runner配置而取消。补验实现 `d95cce74` 的64 wheels/98 arm64静态部署声明最高14.0，独立复核23样例通过；仅Chromium真实浏览器26项通过，原可选ffmpeg要求15.0的失败证据保留。macOS14实际运行、完整发行闭包仍未验证，P3保持in_progress。见[交接](evidence/P3/acceptance/HANDOFF.md)。

2026-11-07最终验收按用户“只需要Mac端”的范围完成。P3登记done，候选 `aa2d7846` 追加组合验收探针，生产代码指纹与执行候选一致。59项命令最终通过，完整单元2491通过/18跳过、80静态通过，有窗口与无窗口真实工具链各27项通过，新Office六页视觉检查通过。Windows首轮失败保留，macOS14实际运行及签名发行交接O2/P6。详见[最终Mac验收](evidence/P3/final-mac-acceptance/README.md)。

2026-11-07 P4本地开发推进至P4-04，交付保存在基线 `d97db57b` 之上的未提交工作树。组合候选独立生命周期23项、媒体36项、桥接35项通过，ASR后端41项通过。完整单元2491通过/18既有跳过、80静态及1134语法通过。宿主30通过/LaunchServices启动1失败，失败后自有App与服务已退出；当前轮TCC未再次捕获明确文稿提示，原因继续定位。旧Chrome三组语音仍失败或有未执行范围，隔离world原生getUserMedia同样挂起。Mac仍锁屏，真实通知恢复、物理短录音、系统睡眠/登录项、剩余可见交互待验；路径别名收藏去重已登记后续。正式身份复验按用户决定暂缓，P4保持in_progress。详见[系统桥](evidence/P4/bridge/README.md)、[媒体](evidence/P4/media/README.md)与[生命周期](evidence/P4/lifecycle/README.md)。

2026-11-07 P4-02目录别名增量完成本地开发与独立48项验收。复用受保护解析接口、有界目录身份查找与服务端收藏权限，补存量去重、POSIX特殊字符、线程切换与迟到写入隔离。完整单元2491通过/18跳过，静态80/80，语法1134通过。旧workspace-resolve基线37/1已归因于通用测试的Windows大小写假设，Windows执行原断言、POSIX执行精确有序数组，修正后主代理和独立复跑各38项通过。Mac再次确认仍锁屏，其余P4可见与物理权限验收待继续。见[目录别名证据](evidence/P4/bridge/workspace-alias/README.md)。

2026-11-08 P4-02目录别名最终增量主验收与独立验收各50项通过，补齐BigInt目录身份和已有会话真实PATCH/GET保留路径尾空格。独立代码复核未处理发现0，BigInt阶段旧解析件主验收与独立复跑各38项通过，该件未在后续会话存储修改后重跑。最终冻结候选完整单元2491通过/18跳过、静态80/80、语法1134文件及构建新鲜度通过。此前检查期间修改源码造成的79/80新鲜度失败与48项历史候选一并保留。Mac仍锁屏，其余可见交互及真实权限验收等待解锁，P4保持in_progress。见[最终目录别名证据](evidence/P4/bridge/workspace-alias/README.md)。

2026-11-08 P4解锁增量。用户授权文稿访问后，TCC记录通过、LaunchServices探针就绪并正常退出，独立host31/31通过。通知开关从拒绝恢复为开启，桥返回granted，系统usernoted日志确认投递和呈现横幅。随后检查IDE Diff时Mac再次锁屏，菜单栏、外链、真实双栏Diff及短录音仍待验。新增仅由正常composer按钮开始采集、带自动停止时限的物理录音探针，尚未执行采集。P4保持in_progress，原失败保留。见[系统验收增量](evidence/P4/bridge/unlocked-recovery/README.md)。

2026-11-08 P4当前增量已完成真实菜单设置、正常API到Code双栏Diff、Safari外链、登录注册后注销与一次短时Software Sleep/DarkWake恢复。醒后SSE重新连接并自动显示新事件。当前独立宿主31、媒体36、生命周期23、桥接47通过，完整单元2491通过/18跳过、静态80、语法1134通过。CFT148完整既有语音98/流式39/预热58通过，Chrome156挂起保留。旧物理WAV1.01秒成功但原生时限判定失败，新LaunchServices物理麦克风候选授权等待中。P4保持in_progress，正式身份暂缓，Windows/macOS14未验收。[当前候选](evidence/P4/current-candidate/README.md) [系统实机](evidence/P4/lifecycle/physical-system/README.md) [编辑器](evidence/P4/bridge/editor-diff/README.md)

2026-11-08 后续原生验收测量修正候选独立媒体36/生命周期23/桥接47通过，宿主30/1，因新ad-hoc签名与旧文稿访问code requirement不匹配重新提示，失败进程已退出。物理首次LS仅5字节WebM，严格失败保留。新候选要求有效PCM与三秒内公开原生停止完成，KVO显示持续时间单列，待解锁后复验。[后续候选](evidence/P4/media/physical/reporting-delay/README.md)

2026-11-08 全P4逐项审计补出V10真实文件/目录拖放证据缺口，纳入本地剩余验收。TASKS顶层已区分此前host31成功候选和最新host30/1候选，后者等待文稿授权后独立复跑。当前物理probe仍活跃等待系统麦克风提示，未采集；临时保活已验证。已有真实WebKit来源拒绝恢复，尚未宣称OS级麦克风拒绝恢复。

2026-11-08 最新LS短录音严格验收通过，WAV647.5ms、tracks1110ms、原生停止1417.118ms，无deadline，最终none/零发送/进程回收经独立核验。当前宿主授权恢复后独立31/0，旧30/1保留；旧workspace-resolve在最新session-store增量后主代理及独立复跑各38/0。P4-03本地done，真实V10拖放等待用户辅助后继续，阶段正式身份/Windows/macOS14边界保持。[最新物理和宿主证据](evidence/P4/media/physical/reporting-delay/README.md)

2026-11-08 自动推进在连续三轮核对后登记受阻，等待一次用户辅助的真实文件/目录拖放。探针96211、隔离App/Node与临时保活仍运行，刷新后drop事件、请求和发送计数均为0。当前Mac代码与自动化回归已独立复核，P4阶段保持in_progress。[阻塞核对及恢复动作](evidence/P4/bridge/native-drop/blocked-audit.json)

2026-11-08 用户辅助真实拖放已完成并独立复核。6个可信文件/目录事件、3个本地上传、3次指纹解析及2次路径提交均成功，当前会话cwd/近期目录落盘、发送0，App/Node/探针退出。此前交互阻塞已解除。四包当前Mac本地开发与独立验收完成，正式身份暂缓及Windows/macOS14未验边界独立保留。[本地收尾](evidence/P4/local-closeout.json)

2026-11-08 P4实现已本地提交 `0e9d5edb7b68e4cac8540654a5c8021bf59bd0eb`，分支 `codex/p4-macos-desktop`。43项实现文件逐字节绑定该提交，文档收尾后完整单元2491通过/18跳过及80组静态再次通过；既有失败与候选来源保留。阶段Windows同候选验收范围等待用户决定，正式身份和macOS14边界继续按原交接记录。


2026-11-08 用户确认“本轮按 Mac 范围收尾，Windows 保留后续待验”。P4 及四包登记 done，实现提交 `0e9d5edb7b68e4cac8540654a5c8021bf59bd0eb`，证据提交 `f5c5d4c5`。Windows 同候选回归排除本轮并保留后续待验，正式签名身份按用户决定暂缓，macOS14 实际运行继续交接 O2/P6。此前进行中记录保留历史归属。源码及撰写文档空白检查通过，原始系统/界面 `.txt` 证据的尾空白与末尾空行告警保留，完整范围未登记空白检查通过。[最终范围复核](evidence/P4/final-scope-review.json) [收尾清单](evidence/P4/local-closeout.json)


2026-11-08 用户追加“停止防休眠，完整验收P4 Mac端”。本任务 caffeinate6773 与对应断言已停止。16 组主轮专项最终 630 项通过，完整单元 2491/18skip/0fail、静态 80、语法 1134 与构建新鲜度通过。四个既有验收文件补齐取消前后状态、Mac 浏览器隔离和重放启动等待，原失败及 d97 同环境基线保留。真实物理交互复用同冻结 App 的已有独立证据，Windows/正式身份/macOS14 继续待验。[完整Mac验收](evidence/P4/full-mac-acceptance/README.md) [独立复核](evidence/P4/full-mac-acceptance/review.json)

独立复验随后发现首发 SSE 可能携带启动暂态 classic。真实 View Transition 延迟负对照稳定复现后，组合根改为复用视角控制器的最新意图，保留默认动画与原断言，最终候选重新冻结执行原生、浏览器及工程验收。旧失败及负对照来源保留。[首发修正](evidence/P4/full-mac-acceptance/README.md)

最终修正候选独立串行复跑八组、255项全部通过，均自然退出0，53项源码指纹无漂移且观察到的自有进程已退出。本任务防休眠保持停止，当前Mac功能验收完成，既有待验边界保留。[最终独立验收](evidence/P4/full-mac-acceptance/review.json)

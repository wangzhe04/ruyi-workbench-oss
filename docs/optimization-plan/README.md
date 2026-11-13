# 优化方案索引

> **2026-11-13 缓存修复与费用实测：** [141·Anthropic缓存与Agent Loop对比](141-anthropic-prompt-cache-20261113.md)补齐Claude流式缓存、稳定前缀及兼容回退；独审两项P2已关闭，完整unit5302过／0失败／33跳过，100 static单独全过，原fast RED保留。本机Sonnet真实三轮／六发A/B网关报告费用下降64.79%，补测DeepSeek官方Chat／Responses暖缓存97.60%／97.69%，计量与账本均精确一致；旧异常格式未追认。仅覆盖本批范围；3.1总体验收状态仍以140／92 §12.75为准，版本3.0.1，未发布。

> **2026-11-12 收口与交接：** [140·M4-M6命令行交接](140-m4-m6-command-line-handoff-20261112.md)／[92 §12.75](92-3.1-implementation-handoff.md#1275--2026-11-12-m4-m6-命令行收口与交接)。当前6bf＋installer f16：原unit5331／5298过／0失败／33跳过；限定631项E2E真实RED，612PASS／19FAIL，其中13flaky含在PASS中。数量锁一项随后单独修复／复验，其余18待查；release3仍RED，Full安装partial34检查仅有限范围。新M5八次166、四console34独立保留；新GUI／4项用户桌面排除未执行，完整635默认门未跑，不认领最终树全套复验或公开发布。按用户要求记录交接并commit/push，不继续长诊断；3.0.1，3.1未发布。

> **2026-11-11 历史分片：** [92 §12.74 · M5 冷合同与离线包实际验收](92-3.1-implementation-handoff.md#1274--2026-11-11-m5-冷合同与离线包实际验收)：CF54 的 M5 八次／166 条及两包四次／34 条资格、旧 package／release 首红与 B145 接续起点；不转移为后来的 D879 或 6bf 新代候选资格。

> **2026-11-11 历史分片：** [92 §12.73 · M5 密封浏览器组合与 M4 阶段观测](92-3.1-implementation-handoff.md#1273--2026-11-11-m5-密封浏览器组合与-m4-阶段观测)：CF54 源码的真实密封 queue/journal、冷重启与媒体阶段观测共11次接受执行、98条PASS；完整fast含全量unit 5,217通过/0失败/33跳过与100 static，通过后startup夹具窄修另作定向补验。三次夹具/oracle首红及旧M4两项UNKNOWN保留，公开分发和真平台/安装包门仍待，版本3.0.1，3.1未发布。

> **2026-11-11 前片：** [92 §12.72 · M4 本机开发与冻结源码验证](92-3.1-implementation-handoff.md#1272--2026-11-11-m4-本机开发与冻结源码验证)：最终 B493 图片、三协议加密浏览器、原生图片、Office 和 HTTP 生命周期已验；全量 unit 5,200 通过/0 失败/33 跳过，最新静态分步 100/100，原单次 fast RED 及两次原因未定的超时/期限首红保留。公开分发对应源码、构建与法律材料仍待，版本 3.0.1，3.1 未发布。

> **2026-11-11 前片：** 以 [92 §12.71](92-3.1-implementation-handoff.md#1271--2026-11-11-m4-本地图片读取与-ocr-区间预算) 为上一批 M4 接续入口；11/10 的 M3、Full-local 与 M5 本机进度分别见 §12.66–70。下方 11/05 的分片保留历史身份，不代表当前仍停在 M3。版本仍为 3.0.1，3.1 未发布。

> **2026-11-05 当前片：** [139 · 非空 capsule 快照用例：夹具已现成](139-m3-capsule-fixture-recipe-20261105.md)：`migration-backup-owner-fixture.capsule()` 已能产出真实 capsule 且 owner 具备 01ab 需要的五个方法；记录“搬进快照 base 需先确认 capsule 路径相对/绝对”这一前置，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [138 · 全量 unit 检查点（绿）与一处真实回归修复](138-m3-unit-checkpoint-20261105.md)：全量 194 suites/5057 tests/5031 pass/0 fail；修正 adapter flip 后遗留的 codec 普查断言。

> **2026-11-05 前片：** [137 · 非空 special：现状与确切断口](137-m3-nonempty-special-status-20261105.md)：47 项 owner/快照单测实跑通过；确认缺口是「带 owner 的非空 capsule 普通快照」无测试，`01ab:213` 路径已存在；下一片补该往返，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [136 · 维护网关的 host 依赖](136-m3-maintenance-gateway-host-20261105.md)：父进程协议应是实例化 `WorkDataMaintenanceWorker` 网关，需 base/pid/listener/spawn/claim/exitParent 一整套桌面宿主依赖；测试进程不可复刻，夹具已删；① 剩余为桌面/UI 触发点，建议转 ②③；版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [135 · 冷维护命令的 go/claim 协议](135-m3-maintenance-claim-gopher-20261105.md)：真实 enable 夹具输入校验已过，但缺父进程「写 armed claim → 发 IPC go → 主动退出」三步，worker 报 `worker_failed`；夹具已删，记录精确协议，无产品改动，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [134 · 私有 successor 握手的拒绝面](134-m3-successor-handshake-20261105.md)：真实进程验证空 stdin/错 nonce/陈旧 authority/多余 activation 在读盘前被拒，且不落密钥与活动代；6 项 PASS；合法握手与 UI 路径留后，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [133 · 启用流程：私有维护进程协议](133-m3-maintenance-protocol-20261105.md)：核实冷/暖维护命令、暖进程 stdin 输入与 `serve-ready` IPC 键集、失败拒绝条件，给出下一片夹具规格；无产品改动，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [132 · M3 剩余块地图](132-m3-remaining-map-20261105.md)：把剩余五块（启用流程接线、非空 special、精确 owner delta、retention sealed-fault、索引收尾/工具图）钉成事实+进入点+完成判据；无产品改动，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [131 · 完整索引组合：三个 fulltext 面转 wired](131-m3-fulltext-wired-20261105.md)：新增运行时证据（启用态索引写 `workData:3` 且无明文）后把 state/manifest/shard 转 wired；清册 80 面/47 required/46 wired，唯一 required-pending 只剩工具图片；版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [130 · `uploads-attachment` adapter 转 wired](130-m3-adapter-wired-20261105.md)：依据 128 的启用代 HTTP 验收把原始附件面改为 wired，工具图仍 pending；清册仍 80 面/47 required，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [129 · 工具图片接入 toolImage face](129-m3-tool-image-face-20261105.md)：启用态工具图经 `sealToolImage` 密封、下载 hook 两面查找、删会话按 catalog 退掉 sealed 行；5/5 hook 单测 + 32/32 工具相关；真实工具图 HTTP 未覆盖，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [128 · 启用代 HTTP 往返通过](128-m3-http-roundtrip-pass-20261105.md)：冷 enable 后起真实服务，在加密代上上传/整读/206 区间/416 越界与「uploads 无明文」7 项全 PASS（75s）；附件证据链补齐，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [127 · 启用代 HTTP 往返：第一次夹具尝试与阻塞点](127-m3-http-roundtrip-blocker-20261105.md)

> **2026-11-05 前片：** [126 · 下载路由密封读取](126-m3-sealed-download-route-20261105.md)启用态下载经 hook 读 sealed（200/206/416，`singleByteRange` 共用），OFF 不变；定位并修掉「具名函数表达式被当成 provides」导致的假边（141/938 保持）；4/4 单测 + OFF e2e 全过，启用代 HTTP 正向仍待夹具，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [125 · 下载路由密封读取：一次被依赖门拦下的尝试](125-m3-download-sealed-attempt-20261105.md)

> **2026-11-05 前片：** [124 · 启用态上传走密封写入](124-m3-sealed-upload-route-20261105.md)上传路由在启用态经 `WorkDataAttachmentUploadHooks` 调 `01ak` 封存，失败 503 不回退明文；OFF 不变；SCC 仍 31、141 模块/938 边全过；正向用例待加密代 HTTP 夹具，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [123 · 附件批次后的全量检查点](123-m3-attachment-checkpoint-20261105.md)：五件静态门全过；全量 unit 在本机负载下出现三只不同的时序 flaky（单跑均过），最近一次无失败读数 5046/5020/0；无产品改动，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [122 · ON→OFF 接进迁移主机](122-m3-cold-restore-wiring-20261105.md)`13ak` 的 disable 解封到候选代；**真实 NTFS 冷操作 e2e 通过**（enable 封存两面无明文、export 通过、disable 解封两面、二次 export 通过，262s）；150/150 单测；运行时路由仍未接，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [121 · 附件 ON→OFF 候选解封原语](121-m3-attachment-unseal-into-20261105.md)`01al` 新增 `unsealInto({target})`：把 sealed 行解到另一个根、不 retire、不动源根；9/9 单测；仍待接 01ad/13ak，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [120 · 生产冷操作接入 uploads owner](120-m3-cold-uploads-owner-20261105.md)`13ak` 在 enable 时接真实 `01al` 封存候选附件，disable 遇 sealed 目录直接拒绝；140/140 单测；ON→OFF 解封与真 NTFS e2e 待，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [119 · 全量快照识别 sealed 附件](119-m3-snapshot-sealed-attachments-20261105.md)`01ab` 把 `uploads/` 下 catalog/manifest/part 识别为不透明认证字节，加密代导出/恢复不再拒绝；快照单测 20/20；13ak 与生产接线仍待，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [118 · 迁移主机接入 uploads owner（草稿）](118-m3-uploads-host-seam-20261105.md)`01ad` 新增可选 `uploadsOwnerFactory`：候选侧 raw uploads 交给 owner 封存并重登 target census，默认关闭；假 owner 集成测试 32/32；仍未接真实 owner/13ak/01ab，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [117 · 迁移侧 uploads owner 草稿](117-m3-uploads-owner-20261105.md)新增 `01al`：枚举 `uploads/` 两个面、逐文件封存、整组校验后删原件；4/4 单测；未挂迁移主机，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [116 · 迁移侧附件特殊所有者设计](116-m3-uploads-special-owner-design-20261105.md)：`uploads/` 以目录级特殊所有者参与迁移，含接口泛化（命名空间注册）、失败语义与验收门；仅设计，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [115 · 附件门面支持工具图片 face](115-m3-attachment-faces-20261105.md)`01ak` 的 face 变为参数（attachment/toolImage），两面各自 catalog 与 purpose、互不相通；运行时 6/6 单测；仍无接线，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [114 · 附件失败清理入口](114-m3-attachment-discard-20261105.md)给 `01ak` 加 `discard(id)`：只清理 pending/uncertain 残留、拒绝删封存副本、带路径包含校验；运行时 5/5 单测；无路由接线，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [113 · 附件下载 Range 支持](113-upload-range-20261105.md)下载路由支持单区间 Range（206/416、`accept-ranges`、尾部/夹紧/越界语义），真实 HTTP e2e 10 项全过；仍未接密封读写，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [112 · M3 附件运行时门面](112-m3-attachment-runtime-20261105.md)新增 `01ak`：统一 id→opaque/revision 派生，组合 catalog/写入器/读取器（seal/read/verify/has）；关闭开关即拒绝，3/3 单测；无 HTTP 接线，adapter 仍 pending，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [111 · M3 附件 catalog 持久化](111-m3-attachment-catalog-persistence-20261105.md)新增 `01aj`：两个面各自 sealed catalog 文件与串行链，关闭时拒绝打开；跨实例重开仍可读（3/3 单测）；无路由接线，adapter 仍 pending，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [110 · M3 附件封存写入器草稿](110-m3-attachment-store-20261105.md)新增 `01ai`：catalog 行 → 01af 分块/manifest（wx）→ 封存；失败标 uncertain 不留半成品，3/3 单测；无 HTTP/迁移接线，adapter 仍 pending，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [109 · M3 附件三件套真实组合验证](109-m3-attachment-composition-20261105.md)把分块写入器、catalog authority 与密封读取器放进同一临时目录组合跑通整读/范围读/篡改/撤权/census（3/3 通过）；仍未接线产品调用方，adapter 仍 pending，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [108 · M3 附件 catalog authority 草稿](108-m3-attachment-catalog-20261105.md)新增 `01ah` 隔离模块：pending/sealed/uncertain 状态机 + `capture/describe/assert`，5 项单测通过；无调用方接线，adapter 仍 pending，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [107 · M3 附件存储设计](107-m3-attachment-storage-design-20261105.md)给出附件加密的盘上布局、catalog/authority、读取与迁移映射及验收门；仅设计，无产品代码，版本3.0.1，3.1未完成、未发布。

> **2026-11-05 前片：** [106 · M3 附件二进制面登记](106-m3-attachment-surfaces-20261105.md)把 `uploads-attachment` 与 `uploads-tool-image` 登记进持久面清册与加密冻结表（78→80 面、45→47 required，adapter 仍 pending）；不加密、不接线，版本3.0.1，3.1未完成、未发布。

> **2026-11-04 前片：** [105 · migrationFactory 只读源解码](105-m3-migration-preserved-source-20261104.md)把保留源读取接进冷迁移/恢复：候选与 intent 写入后重新捕获并以原始见证校验、一次性 grant、fused 物理解码；修 publish 前置失败释放 sourceCapture。全量 unit 5014/4988/0、真实 NTFS 新 e2e 与 cold-operations（261.4s，490s 授权口径）全过；F2/F3 待办，版本3.0.1，3.1未完成、未发布。

> **2026-11-04 前片：** [104 · M3 附件分块与密封读取原语](104-m3-attachment-primitives-20261104.md)新增两个隔离草稿模块与79项单测，修正 binding 哈希字段序；无 IO/catalog/消费者接线、无真实NTFS与e2e，版本3.0.1，3.1未完成、未发布。

> **2026-11-03 前片：** [103 · 恢复演练保留读取与安全清理](103-m3-native-rehearsal-preserved-20261103.md)完成原生演练双轮、240秒冷长双轮及生产维护/恢复回归；最终unit/static通过，原首红保留。M3后续持续推进，版本3.0.1，未发布。

> **2026-11-03 前片：** [102 · 冷维护快照保留读取接线](102-m3-cold-preserved-snapshot-20261103.md)完成最终原生双轮、新授权240秒冷长双轮及生产维护/恢复回归；原首红不改判。完整M3与3.1仍未完成，版本3.0.1，未发布。

> **2026-11-03 前片：** [101 · 生产快照保留读取接线](101-m3-preserved-snapshot-20261103.md)已完成真实NTFS双轮、完整unit/static与受影响恢复回归；其余非空迁移接线继续。100/99保历史身份，版本3.0.1，3.1未完成、未发布。

> **2026-11-02 后续验收：** 当前入口为[98](98-3.1-current-handoff-20261030.md)与[100 · Windows原生恢复和加密GUI](100-native-gui-current-acceptance-20261102.md)。完整长用例按用户批准240秒新合同双轮、最终GUI双轮已验；99与旧RED为历史原件，版本3.0.1，3.1未完成、未发布。

> **2026-11-02 日结：** 先读 [98 · 当前执行入口](98-3.1-current-handoff-20261030.md) 与 [99 · 日结和恢复交接](99-3.1-closeout-20261102.md)。GUI02仅单次有限实际通过；M4 R8仅源码资格，Native首红与待审focused候选保留。本次仅文档及安全证据归档，3.1未完成、未发布。

> 更新：2026-10-26。3.1 暂不发布：先完成 [86 号补完与隐私路线](86-3.1-completion-and-privacy-roadmap.md) 的当前发布范围，再冻结候选并重新验收。独立命名空间与严格托管 CLI 支持暂缓研究，本地 ASR 暂不实施；其余范围继续。4.0 暂不确定方向或排期。旧编号是文档身份，不是执行顺序。已按用户要求恢复多代理推进；跨机基线保留在 [97](97-3.1-cross-machine-handoff-20261025.md)，当前进展见 [92 §12.24](92-3.1-implementation-handoff.md#1224-2026-10-26跨机恢复后的取消回复与图片合同)。

## 当前实施入口

- [92 §12.75 · D879 本机候选与最终验收进度](92-3.1-implementation-handoff.md#1275--2026-11-12-d879-本机候选与最终验收进度)：本批当前候选、原执行来源、待验最终门；§12.74 是 CF54 历史批，86 仍是唯一发布范围规范。

- [98 · 当前执行入口](98-3.1-current-handoff-20261030.md) / [99 · 2026-11-02 日结与恢复](99-3.1-closeout-20261102.md)：保留当时 Main、候选/首红身份、有限 CAS 与恢复交接；本批最新执行状态以上方 92 §12.75 为准，97 是历史基线。

- [86 · 3.1 补完与隐私路线](86-3.1-completion-and-privacy-roadmap.md)：唯一当前范围规范；逐批执行交接见92。QQ／飞书真平台联调、投递管理、进度与远程待决，全链路隐私的明确边界与实现、工作数据加密、全文分片索引、跨既有线程接力和定时模板全部纳入 3.1 发布前范围。
- [92 · 3.1 后续实施交接](92-3.1-implementation-handoff.md)：6.1 Sol接手入口；当前基线、批次队列、代码位置、设计约束、验收门及可直接使用的继续指令。
- [95 · 子代理上下文窗口、回溯提示与管家默认模型](95-context-window-and-ux-fixes.md)：子代理继承 per-model 窗口覆盖、deepseek-flash=1M 入表；撤回失败提示与实际结果对齐；管家默认模型的待证据结论。
- [94 · M3-2 加密存储适配](94-m3-2-encrypted-storage-adapter.md)：保存共享存储/密钥lease/分块协议适配细节；41/41族完成情况见92 §12.12。默认关，无用户数据迁移或启用UI；当前恢复阻断与跨机续进见92 §12.24。
- [93 · M3-1 工作数据加密冻结](93-m3-1-encrypted-storage-freeze.md)：持久面逐族分类（冻结时 69 面 41/28，M3-2a 登记密钥信封后 70 面 41/29）、11 个冻结密钥用途、v2 envelope 与 AAD 绑定、迁移状态机与唯一权威合同；M3-1b 合成明文性能基线已测并冻结相对门。
- [87 · 代码规模与合理精简审计](87-code-size-and-simplification-audit.md)：当前基线的代码统计与共用机制候选；只读审计不代表改造已实施，安排由 86 统一维护。
- [88 · M1 外发边界与本地处理原型](88-privacy-m1-prototypes.md)：外发清册、Windows CLI 隔离与媒体原型的设计、实验证据及未解决条件。
- [89 · 音频修复与 CLI 隔离续验](89-audio-and-cli-isolation-followup.md)：发送边界与配置发布竞态修复、LPAC/网关后续实验，以及本地 ASR 改为可选组件的评估。
- [90 · Claude 与严格文件边界验证](90-claude-and-filesystem-feasibility.md)：原生 Claude 初始化与网关候选、LPAC 文件视图反例、额外受限令牌，以及进程回收测试的调查与观测修正。
- [91 · 独立命名空间与成本裁决](91-independent-namespace-cost-decision.md)：依赖实测、VM 工程与用户部署成本、独立命名空间/严格托管 CLI 暂缓决定及 Claude 有限 HTTP 基线；有限实验不代表完整支持，原失败与恢复研究合同保留。
- [全局路线图](../OPTIMIZATION-ROADMAP.md)：已发布基线、已合入状态和发布规则。
- [文档总索引](../README.md)：使用、开发、发布和历史证据导航。

PR #58 已合入 `f5223548`；现有隐私候选 ux15 完成源码及实际包验收，应用版本仍为 3.0.1，未发布。该结果只覆盖已验收字节，不覆盖 86 号新增工作。原始证据及独立复核见 [85 号归档](../archive/optimization-plan/85-privacy-rule-and-settings-regression-31.md)。

## 继续维护的设计与规范

| 文档 | 当前用途与边界 |
|---|---|
| [62 · 管家分轮设计](62-steward-3x-iterations.md) | 保留用户旅程、验收约束和采用决策来源；旧版号归属与“后续候选”不再决定 3.1 范围，按 86 执行。 |
| [66 · 外部机器人](66-external-bots-and-steward-channels.md) | 已有 A 批为基座；QQ／飞书真平台、投递、进度与远程待决由 86 补完。 |
| [67 · 代办机器人配置](67-steward-assisted-bot-setup.md) | 本机配置、秘密录入、配对和本人授权契约继续维护；真实平台仍需验收。 |
| [68 · 飞书身份发现](68-external-bot-identity-discovery.md) | 固定官方 API 探测和禁用连接准备契约；真实响应核对纳入 3.1。 |
| [81 · 隐私原设计](81-privacy-vault-and-tokenization-31.md) | 凭据库、恢复与双向转译设计来源；代码已随 PR #58 合入，新增范围以 86 为准。 |
| [83 · 隐私规则规范](83-privacy-rule-catalog.md) | 规则分类、识别依据、维护及反例边界；不将识别器描述成任意语义／编码的绝对保护。 |
| [84 · 工具转译、披露授权与档位](84-privacy-tool-transport-and-profiles-31.md) | 默认关闭、配置原子性、接收方/用途/字段授权及已有覆盖边界；媒体、CLI 和独立 MCP 的新设计与支持门见 86。 |

“已实现”“验证通过”“已合入”“默认启用”和“已发布”分别判断。历史授权、模型分工和分支名不自动成为下一轮指令；旧事实不因移动文档改写。

## 候选研究与早期方向（10 份）

保留研究与证据价值，不自动纳入 3.1 或 4.0。与 86 明确纳入的范围发生冲突时，以 86 为准。

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
| 22 | [Agent SoC 微架构](22-agent-soc-microarchitecture.md) | 早期方向池；后续实施和启用裁决已写入 [23 号](../archive/optimization-plan/23-architecture-repayment-sequence.md)，本页最初的“未实施”不是当前状态。 |
| 41 | [个人工作台综合研究与旅程](41-personal-workbench-iteration-plan.md) | 2026-09-12 的代码核查快照与候选库；16 条 J 旅程可复用，附录 C15 等“尚未实现”结论须结合后续交付重新核查。 |

## 已归档的设计与验收

[历史方案索引](../archive/optimization-plan/README.md)收录 69 篇方案，包括本轮迁入的 23–61（41 研究除外）、63–65、69–80、82、85。原有交付记录、未通过、flaky、跳过及未覆盖边界均保留；[80](../archive/optimization-plan/80-steward-31-release-acceptance.md)、[82](../archive/optimization-plan/82-privacy-31-implementation.md) 的旧包验收不替代 [85](../archive/optimization-plan/85-privacy-rule-and-settings-regression-31.md) 最终字节，更不替代 86 新范围的发布门。

本目录 `105*`、`106*`、`107*` JSON 是历史测量附件，相关 live harness 仍以此为默认输出路径，因此保留原地；不是本轮新测试或当前配置承诺。

## 查阅规则

1. 找当前要做什么先读 86；找来源沿现行规范进入归档记录。
2. 判断能力是否已有，核对当前源码、消费者与行为测试；旧方案开头的“未做”可能已被后续实现覆盖。
3. 历史源码行号可能漂移；重新实施时按符号名和原始 commit 核对。
4. 移动文档先查文档、源码、测试和脚本引用，再修正文内相对链接。固定消费的生成或运行时路径保留稳定。

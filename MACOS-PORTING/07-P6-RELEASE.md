# P6：离线打包与发行

状态：进行中（2026-11-12，本轮自动修复／新包评估已收尾；P6-04真实App本人授权正向验收仍未通过） · 前置：P5 按已验 Mac 范围交付 · 基础工作量：**8–14 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

## 目标

把已验证的功能变成可安装、可升级、可回退且可解释限制的 Mac 正式发行物。打包探针应从 P0/P3 起提前开展。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/package.json`](../ruyi-workbench/package.json)
- [`ruyi-workbench/tools/package-offline.ps1`](../ruyi-workbench/tools/package-offline.ps1)
- [`ruyi-workbench/tools/Manage-Overlay.ps1`](../ruyi-workbench/tools/Manage-Overlay.ps1)
- [`ruyi-workbench/app/src/13c-overlay-routes.js`](../ruyi-workbench/app/src/13c-overlay-routes.js)
- [`ruyi-workbench/app/src/13u-migration-center.js`](../ruyi-workbench/app/src/13u-migration-center.js)
- [`ruyi-workbench/resources/offline-manifest.json`](../ruyi-workbench/resources/offline-manifest.json)
- [`mcp/ai-computer-control/installer`](../mcp/ai-computer-control/installer)
- [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md)
- [`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P6-01 | arm64 离线依赖与包布局 | 2–4 | 打包 Node/Python/rg/必要 wheels 与浏览器；区分各发行变体承诺能力、许可、hash 校验和版本锁；不打入官方 Agent CLI。 |
| P6-02 | 签名、公证与安装 | 2–3 | 递归处理 App/helper/原生依赖签名、hardened runtime 与必要 entitlement；公证与票据附加；干净标准用户安装/首次运行验证。 |
| P6-03 | 更新、回退与数据迁移 | 2–3 | 首发支持整包替换升级和保留旧包的回退；Mac Trash 语义、路径映射、旧配置与凭据恢复文档；旧 Windows overlay 明确不可用。 |
| P6-04 | 最终回归与交付文档 | 2–4 | 全量适用回归和受控真机验收；更新中英文用户/管理/离线部署说明及兼容清单；记录候选 SHA、版本、hash、测试和独立复核。 |

## P6-02 本轮范围（2026-11-12）

用户没有 Apple 开发者账号，明确同意先做本地／内部试用版；另确认“暂没有，先做隔离安装验收”。本轮实现 ad-hoc 签名补全、Full/Slim DMG、安装引导及当前账号隔离安装。Developer ID、公证/票据和真实干净标准用户暂缓，不计原完整签名发行门通过。实际下载来源 Gatekeeper、系统权限与钥匙串交互按真实执行单列，不以说明或静态检查代替验收。

该约定范围已完成：[交付与验收](evidence/P6/internal-trial/README.md)、[独立最终复核](evidence/P6/internal-trial/review-final.json)。包装源码 `3279b83d`，应用源码保持 `f059b7eb`；Full/Slim 各经主执行及独立安装12项通过，安装后离线链路各19/7项通过，原生签名清点209/6项。原输入未改动，测试后无自有App/服务进程与镜像挂载残留。实际下载来源 Gatekeeper 首次允许仍未执行，命令行 assessment 仅保留诊断；不改变系统安全策略。

## P6-03/04 前轮 Mac 评估（历史，2026-11-12）

应用源码 `b662fff2`、打包器 `1953e3f3` 的最终 Full/Slim DMG 已经主执行及独立复核两轮验证：安装各13项、嵌套离线链路19/7项、安装后原生Trash各12项、整包升级与完整快照回退各14项通过。每包492份应用源码绑定，原生对象210/7项；原冻结输入保留且不变。完整结论、实际产物、散列、全部日志见 [最终评估](evidence/P6/final/README.md) 与 [结构化验收](evidence/P6/final/validation.json)。

P6-03 完成的是同3.0.1不同构建的手动整App替换、保留旧App与完整离线数据快照恢复；schema12向14正向归一化通过，不承诺任意未来schema直接降级。原生Trash移动完整旧App并保护当前App／数据／home和别名引用，失败不永久删除。路径映射、Windows DPAPI与Mac Keychain凭据恢复、旧overlay不可用等边界已写入 [中文指南](../ruyi-workbench/docs/MACOS-RELEASE_CN.md)／[English](../ruyi-workbench/docs/MACOS-RELEASE_EN.md)，未验证真实跨平台业务迁移或正式身份权限稳定性。

P6-04 双语文档、冻结产物验收和完整回归评估已完成；工程单元2651通过／18既有跳过，静态80、语法1193文件通过。但完整E2E实际覆盖594件仅558退出成功、36失败，27件含内部SKIP，另14件live排除；[36件失败](evidence/P6/final/REGRESSION.md)未获豁免，工作包及父阶段继续进行中。两件旧开发App截图／输入专项等待报告超时根因未确证，不能以新DMG基础启动成功替代。正式签名／公证、真实下载来源、干净标准用户／另一台Mac、macOS14、正式身份Keychain/TCC、Windows同候选及原P5未验门仍开放。

## Mac修复与无人值守收尾（2026-11-12）

P6本轮Mac修复与可无人值守验收已收尾，应用／包装来源 `74d57c88`、验收夹具 `b2283782`。Full/Slim主执行与独立各安装13、离线19/7、Trash12通过；Full15为APFS独立副本升级／回退，普通第二copy的ENOSPC保留，Slim14为普通复制升级／回退。完整轮588/6，定点修复合并592退出成功/2真实App授权待验（非最终594件整轮重跑），32件原内部SKIP、14live排除。P6-04及P6继续in_progress；正式发行与原环境门未验收。[本轮收尾与新交付物](evidence/P6/mac-closeout/README.md)／[逐件对账](evidence/P6/mac-closeout/regression-composite.json)。

已修原生停止准入竞态与滚轮停止闸；53份实现／夹具经独立复核和17项E2E、2项unit一次通过，额外升级资源夹具单独复核提交。完整单元2653通过／18既有skip、语法1196、构建新鲜度及80静态合并结果通过。新包每包492来源，实际签出CRLF过滤后字节与提交74d57绑定，原生210/7。

两个新源码App的LaunchServices／服务链路已就绪，但录屏、AX和event为denied，需要本人触控ID／登录密码认证；未改权限、未输入凭据。Full普通第二份App复制在当前空间实际ENOSPC，旧App和数据完整性复验通过；Full补验以独立inode APFS副本从真实新DMG按校验和同步，仍执行完整签名／散列、原14断言和新身份检查，不能称普通Full copy升级通过。Slim普通14项通过。

## 原完整阶段验收（仍开放）

P6-01 的可复现构建、包布局、Full/Slim 能力及当前验证边界见 [Mac 离线候选包说明](../ruyi-workbench/desktop-macos/OFFLINE-PACKAGING.md)。开发签名候选不等于 P6-02 正式签名、公证与干净安装完成。

- [ ] V13/V14 及其他适用验收无阻断缺陷；没有未说明的 skip 或伪装可用的 Windows 功能。
- [ ] 断网安装时无需临时下载；本地/内网模型可工作，真云 API 的网络需求仍准确说明。
- [ ] 签名/公证与分发来源首次启动真实验证；更新失败可保留旧版本和用户数据。
- [ ] 正式版交付物、能力清单、已知限制、升级/回退说明对应同一版本。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [x] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

升级先备份业务数据并验证 schema 回退策略；不能单靠换旧 App 处理不可逆数据迁移。公证/凭据未就绪时保留候选包与证据，不标记正式发行完成。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

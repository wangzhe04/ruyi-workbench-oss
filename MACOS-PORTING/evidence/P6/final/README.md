# P6 当前 Mac 内部试用版：剩余实现与最终评估

2026-11-12：P6-03 的整包替换、完整快照回退、原生废纸篓与迁移说明已完成当前 Mac 范围验证。P6-04 的双语文档、冻结产物双轮验收和完整回归评估已完成；**完整回归尚未通过，P6-04 与父阶段 P6 保持进行中**。结构化结论见 [validation.json](validation.json)。

沿用用户已选择的本地／内部 ad-hoc 试用和当前账号隔离安装范围。主机 macOS27.0.1 arm64，Node24.15.0，UID501 属于管理员组；未创建账号、提权或更改系统安全策略，未使用真实业务数据进行迁移。

## 最终交付物

应用源码冻结于 `b662fff21f912d8b217613f8cd57509b7340e0c3`；打包器冻结于 `1953e3f34afbaf9b0054791e0a41d8374d638f46`。每包492份应用源码指纹对应前者，4份包装材料指纹对应后者。两个 DMG 均为产品3.0.1的本地／内部试用构建，未经 Apple 公证。

| 变体 | DMG | 字节数 | SHA256 | 原生对象 |
|---|---|---:|---|---:|
| Full | [最终 Full](../../../../ruyi-workbench/dist/Ruyi-macos-arm64-full-p6-final/Ruyi-macos-arm64-full-internal-trial.dmg) | 584386662 | `64820ce9a312da50172d3eaab1f113d08014927dcda92de1397a617b0f51ba3f` | 210 |
| Slim | [最终 Slim](../../../../ruyi-workbench/dist/Ruyi-macos-arm64-slim-p6-final/Ruyi-macos-arm64-slim-internal-trial.dmg) | 51628631 | `85470381ebeace5fb01c65bbf0452fdca73f80b8b752247c902e658a8ad9b9a0` | 7 |

发布元数据和校验文件保存在 [Full](artifacts/full/distribution.json)／[Slim](artifacts/slim/distribution.json)。最终只读校验见 [integrity-final.json](integrity-final.json)；原 P6-01 输入、P6-02 DMG 保留且未变动。操作说明见 [中文发行与恢复指南](../../../../ruyi-workbench/docs/MACOS-RELEASE_CN.md)／[English](../../../../ruyi-workbench/docs/MACOS-RELEASE_EN.md)。

## 同一冻结产物的两轮验收

主执行与独立复核各对同一批最终字节执行以下四个 E2E；每轮均退出0、无失败或跳过。离线与废纸篓检查嵌套于安装验收中，各列为检查范围，不能相加冒充互不重叠的用例总数。

| 变体 | 安装 | 嵌套离线链路 | 安装后原生 Trash | 整包升级与快照回退 | 主执行日志 | 独立日志 |
|---|---:|---:|---:|---:|---|---|
| Full | 13 | 19 | 12 | 14 | [安装](install-full-main.txt)／[升级](upgrade-full-main.txt) | [安装](install-full-independent.txt)／[升级](upgrade-full-independent.txt) |
| Slim | 13 | 7 | 12 | 14 | [安装](install-slim-main.txt)／[升级](upgrade-slim-main.txt) | [安装](install-slim-independent.txt)／[升级](upgrade-slim-independent.txt) |

安装实际挂载只读 DMG、逐个验证原生对象／资源容器、复制到含中文空格和 emoji 的隔离 Applications、拒绝覆盖，推出镜像后分别通过原生入口与 LaunchServices 初始化页面。实际随包后端及 helper 完成废纸篓操作并恢复测试旧 App；App-only 卸载保留独立数据。离线链路实际拒绝公网出站和开发路径访问。

升级以原 P6-02 DMG 为旧版本，真实验证不同构建的整 App 替换，保留旧 App、不完整暂存／坏分发拒绝，以及 schema12 向14正向归一化。回退将选定完整离线快照恢复到新数据根，保留升级后数据，再启动保留的旧 App。本轮均为同版本3.0.1不同构建，**未验证任意未来 schema 的直接向后兼容**，也未实现原子或自动更新器。

独立报告：[review-final.json](review-final.json)，47份实施材料及2份增量绑定一致，未处理代码阻断发现为0。源与产物前后校验见 [来源报告](candidate-provenance-after.json)、[49文件绑定](source-binding-after.json)。最终清理见 [cleanup-final.json](cleanup-final.json)：48个已观察 App／服务 PID 均不在，自有镜像挂载0。历史 `/tmp` 路径是当时观察值；原报告已按字节归档，路径映射见 [independent-archive-map.json](independent-archive-map.json)。

## 工程与完整回归

| 检查 | 结果 | 证据 |
|---|---|---|
| 语法 | 1193文件，0失败 | [日志](syntax-final.txt) |
| 构建新鲜度 | 通过 | [日志](build-check-final.txt) |
| 完整单元 | 2651通过、18既有跳过、0失败 | [日志](unit-final.txt) |
| 静态 | 80/80退出成功 | [逐件汇总](regression-coverage.json) |
| 打包器增量单元 | 5通过 | [日志](unit-dmg-clone.txt) |
| 当前完整 E2E | 实际覆盖594/594；558退出成功、36失败；39件重试，其中3件重试后成功 | [逐件结果](regression-coverage.json)／[独立逐行核对](regression-coverage-review.json) |
| 跳过 | 27件含内部SKIP；另14件live排除 | [原因和分类](regression-applicability-final.json) |

**完整 E2E 未通过，36件失败未被接受或豁免。** [REGRESSION.md](REGRESSION.md)链接全部失败日志：30件Windows夹具／平台契约、1件旧源码清册契约、1件开发rg缺失兼Windows夹具、2件其他夹具契约、2件旧开发App截图／输入专项等待报告超时。后两件根因未确证，不能推断为权限拒绝；最终 DMG 的基础启动成功也不能代替原 P5 功能资格。

对照基线 `20346fba` 的独立 checkout：592件选择、537退出成功（含3件重试后成功）、55失败，另14件live排除；基线未逐件完整采集内部SKIP。见 [原始基线](baseline-full.txt)、[逐件结果](baseline-last-run.txt)、[适用性审阅](review-probes/baseline-applicability.json)。当前36件失败文件名均出现在原55件中，仅能说明文件集合未新增，**不证明每个失败断言根因相同**。

基线checkout未带主工作区已有且被git忽略的ACC `.venv`，依赖环境存在差异，不能把两轮通过数之差归因于本轮修复。临时基线checkout在保留日志并确认无匹配进程后移除，原基线源码仍在git，见 [清理记录](baseline-checkout-cleanup.json)。

本轮同时修复基线确认的真实Mac缺陷：MCP配置资源URI丢失POSIX根斜线；标准file URL往返、中文／空格／#／%、掩码和范围拒绝通过真实stdio两遍各12项验证，见 [第一遍](resource-uri-final-first.txt)／[第二遍](resource-uri-final-second.txt)。串行中断与已完成只读岛分别13项、真实shell/MCP中断和已观察进程组清理23项、启动夹具36项通过。远端取消通知仅INFO，本地packet/requestId/reason及先通知再kill由 [单元](unit-cancellation.txt)证明，生产取消未增加取证等待。

## 失败历史与空间处理

第一次工程门因缺少本地化镜像文档失败，修复后完整单元通过；保留 [原门日志](engineering-current.txt)和 [失败单元](unit-before-locale-sync.txt)。串行测试最初错误地使用中性 `list_tools` 作为屏障，改用真实 `file_write` 后通过，原失败 [保留](steer-serial-first.txt)。构建曾发现重复 `fileURLToPath` 导入，最终复用既有全局并通过新鲜度门。

Full DMG 首次在最终输出复制时ENOSPC，未完成输出已按所有权清理，不算交付，见 [原日志](build-dmg-full.txt)。打包器增量在EXCL复制上请求APFS clone、不支持时正常复制；成功离线夹具仅回收自己的App副本，保留报告和manifest，失败夹具保留。

完整回归原轮在分配fixture HOME时ENOSPC，导致一个车道未完成；原摘要431成功／27失败不完整。[原日志](regression-final.txt)与所有已记attempt保留，精确缺失50件已单独补跑，见 [计划](recovery-plan.json)／[补跑日志](regression-recovery.txt)。合并594件经独立逐行对账零差异，不能把原轮选择数当作完成数。

仅回收经验证属于任务的重复派生物，见 [开发镜像](reclaimed-development-artifact.json)、[重复缓存](reclaimed-replay-cache.json)、[旧成功App副本](reclaimed-successful-fixtures.json)。原冻结输入／最终DMG／报告保留，未删除其他业务或失败证据。

撰写的Markdown／JSON与跟踪变更无空白告警；原始终端证据的11个txt文件保留13条空白告警，不改写原输出，不宣称整个证据目录的空白检查通过，见 [检查记录](closeout-whitespace-check.json)。

## 未通过的完整发行门与后续

- 36件回归失败仍须修复或在明确平台与资格证据下处理；两件旧App超时须先查报告／LaunchServices启动链路，未确证根因。
- Developer ID、正式hardened runtime资格、Apple公证与stapling、实际浏览器下载／quarantine来源Gatekeeper首次允许。
- 真实干净标准用户或无开发工具的另一台Mac、macOS14实际运行、正式身份Keychain/TCC升级恢复稳定性。
- 同候选Windows CI、Windows至Mac实际业务数据／凭据迁移，以及原P5未验证的环境与故障恢复门。

这些门不计通过。当前产物可供已知信任来源的本地／内部试用；本报告不宣布完整P6或正式公开发行通过。

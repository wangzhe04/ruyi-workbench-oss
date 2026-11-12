# P6-02 本地／内部试用版

2026-11-12，用户明确同意无 Apple 开发者账号的本地／内部试用版，并答复“暂没有，先做隔离安装验收”。当前 UID501 属于管理员组，本轮不创建或切换账号，不计真实标准用户或另一台无开发工具主机通过。

基线 `e3c7564b`；分支 `codex/p6-02-internal-trial`。App 业务源码与 P6-01 冻结输入仍来自 `f059b7eb`，P6-02 包装源码提交与材料指纹单独记录。程序、安装指南及边界见 [内部试用说明](../../../../ruyi-workbench/desktop-macos/INTERNAL-TRIAL.md)。

## 实现与已完成开发验证

- 在输入包副本中补齐18个 unsigned Python 原生对象，以及10个 Chromium 缺失资源封印容器，按内部到外部封印；保持原本有效的代码签名，最后封印 Ruyi.app。对照实际 Mach-O 文件集合，缺项/重复/外路径均拒绝；不以外层 deep verify 替代 Resources 原生逐项检查。
- 重新生成 App 文件/hash/模式/链接清单及侧录来源；记录输入 manifest/App tree、补签前后 hash、包装工具提交和指纹。P6-01 原产物不修改。
- 生成只读 DMG，包含 App、精确 `/Applications` 快捷方式、中英文安装说明与来源清单；构建后真实挂载再核对，发布 DMG及SHA256。
- 新安装只使用新目标目录、拒绝现有目录或 dangling symlink，不承诺原子替换。安装失败只清理本轮预留的相同目录身份；真实镜像解析失败也按预留挂载身份清理。
- [开发 Full DMG](development-dmg.json)的[实际安装](install-full-first.txt)12项通过，包含推出 DMG 后原生和 LaunchServices 启动、数据保留，以及安装后实际离线业务旅程。该开发源当时未提交，不代替最终冻结包验收。

## 独立复核与失败历史

[代码复核](code-review.json)记录R1–R6及修复。独立[签名清点](review-probes/signatures-before.json)发现原P6-01外层校验没有证明Resources中的18个unsigned/10个资源封印缺失容器有效，本轮实际补齐。第一次构建据此失败，原日志保留。

真实小DMG负控制发现过输出预留清理遗漏及挂载后plist解析错误漏卸载；[修复前](review-probes/cleanup-before.json)、[修复后](review-probes/cleanup-after.json)和当时源码副本分别保留。缺项、重复、外路径及祖先symlink输出重叠的[负控制](review-probes/native-inventory.json)在签名调用前拒绝，输入字节保持不变。

Gatekeeper命令行返回值仅记录诊断，不把超时或工具失败当作拒绝通过。当前真实下载来源首次允许仍须按实际交互另行登记。没有移除quarantine或关闭全局安全策略的操作。

## 工程与最终交付

[工程门](engineering-current.txt)：完整单元2645通过、18既有跳过；静态80/80，14个live门明确未执行。语法、构建新鲜度及5项新单元已通过。

最终包装源码冻结为 `3279b83d880a84be1e4fa86ae4e1aed80ef740bc`，App 业务源码仍为 `f059b7ebe30843386b7ab648f7ffad41b37db6de`。Full、Slim 在拒绝公网出站的沙箱中顺序构建，构建日志分别为 [Full](build-full-final.txt) / [Slim](build-slim-final.txt)。最终来源、hash和安装复验结果见 [验收汇总](validation.json)、[独立最终报告](review-final.json)及[来源绑定](review-probes/final-provenance-after.json)。两个包各484份应用源码与4份打包材料指纹均独立匹配对应提交，P6-01 输入未改动。

| 产物 | 字节数 | SHA256 |
|---|---:|---|
| Full DMG | 584255996 | `46529feb8230abc7c5ccbec47eaf8f4f8dfaf678407d3acb93be4565a413387a` |
| Slim DMG | 51621693 | `b40be048e49aa4dc4758d45ceb63edcc45a81b0f23f9f4cf75fda5806c09a9f9` |

交付物位于仓库 `ruyi-workbench/dist/Ruyi-macos-arm64-{full,slim}-internal-trial/`，各目录含 DMG、`.sha256`、`distribution.json` 与 `trial-manifest.json`。Full 包含离线 Python、Office/图表与 Chromium；Slim 的依赖缺失状态按既有能力边界展示。安装前可按包内说明核对校验值，普通用户也可选择个人 `~/Applications` 目录。

最终 DMG 由主执行与独立复核各完成一遍串行安装（每包共两遍），各包每遍12项安装检查通过；嵌套离线业务 Full 19项、Slim 7项通过，均无失败或跳过。原生清点 Full209项、Slim6项逐项校验。日志为 [主执行Full](install-full-final.txt) / [Slim](install-slim-final.txt) 与 [独立Full](independent-full.txt) / [Slim](independent-slim.txt)，各次原生/LaunchServices报告、离线业务日志、Gatekeeper诊断单独保存在 `runs/`。推出镜像后两种入口均能初始化完整工作台；卸载测试仅删除隔离安装的App，数据标记保留。P6-02按本地／内部试用约定范围完成，P6阶段及原正式发行门继续开放。

## 保留边界

Developer ID、公证/票据、hardened runtime正式资格、真实干净标准用户及无开发工具的另一台Mac、macOS14实际运行、Windows同候选、正式身份Keychain/TCC及升级权限稳定性、P6-03升级回退和P5原未验范围不计通过。本轮原生/LaunchServices成功仅证明当前账号隔离路径的安装运行，不扩大成上述门槛。

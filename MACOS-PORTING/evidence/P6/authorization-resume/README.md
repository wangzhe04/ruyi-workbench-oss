# P6 当前 Mac 内部试用收尾

2026-11-13，当前 macOS 27.0.1 arm64 的本地／内部试用验收已收尾。固定安装的 Full App 在用户亲自完成系统授权后，主执行和独立复核均通过真实录屏、基本输入；Full 普通复制升级与完整快照回退也已补验通过。`currentMacTrialStatus=done`，P6 和 P6-04 原正式发行范围仍为 `in_progress`。

应用与包装来源 `74d57c88681d32a3f31d115acecafbb5c55d77be`，两项验收夹具来源 `f3237570d904c9a74ba7dc58f4764e8e5d559dde`。本轮没有重新构建或签名 App，没有修改安装包。结构化结论见 [validation.json](validation.json)，文档与证据的最终独立复核见 [closeout-document-review.json](closeout-document-review.json)。

## 验收结果

| 范围 | 主执行 | 独立复核 | 证据 |
|---|---:|---:|---|
| 固定 Full App 真实录屏 | 7 项通过 | 7 项通过 | [主日志](main-after-screen-auth/capture.txt)、[独立报告](independent/review.json) |
| 固定 Full App 基本输入 | 14 项通过 | 14 项通过 | [主日志](main-after-replaced-auth/input.txt)、[独立日志](independent/input.txt) |
| Full 普通复制升级及快照回退 | 14 项通过 | 14 项通过 | [主记录](normal-full-upgrade/index.json)、[独立报告](normal-full-upgrade-independent/review.json) |
| Full／Slim 安装 | 各 13 项通过 | 各 13 项通过 | [既有实包复核](../mac-closeout/independent-packages/review.json) |
| Full／Slim 离线业务 | 19／7 项通过 | 19／7 项通过 | 同上 |
| Full／Slim 原生 Trash | 各 12 项通过 | 各 12 项通过 | 同上 |
| Slim 普通复制升级及回退 | 14 项通过 | 14 项通过 | 同上 |

录屏取得真实 PNG；基本输入沿 App → 包内 Node／服务 → 包内 Python／ACC → 包内原生 helper，在自有接收窗口验证中文、点击和滚轮。按键／修饰键释放、所观察的 PID／出生身份退出均通过。独立两项各执行一次，无失败、跳过、自动重试或观察到的进程身份残留。492 份应用来源、54 份验收来源、完整 App 和 helper 的前后绑定均一致。

Full 普通升级显式使用 `RUYI_UPGRADE_CLONE_STAGING=0`，验证旧版安装、整包替换、新版启动、完整快照恢复和旧版再次启动。范围是同版本 3.0.1 的构建间替换及 schema12 向14归一化；未来任意 schema 降级仍未承诺。此前 ENOSPC 保护和 Full APFS 副本15项结果保留，不再作为普通复制升级的唯一依据。

## 回归结论

历史完整轮594件为588退出成功／6失败，其中32件含内部SKIP，另14件live排除。此前定点修复合并到592件成功，本轮两项固定Full授权资格补齐后，[逐件合并记录](regression-composite.json)为 **594件最新进程结果成功，0件剩余进程失败**。每条保留证据来源；这不是最终候选594件重新整轮执行，也不代表所有分支和功能均无跳过。

生产验收沿用此前完整单元2653通过／18既有跳过、语法1196、构建新鲜度与静态80项合并结果。随后只修改两个验收夹具，均经[代码复核](fixture-code-review.json)、[增量复核](fixture-name-delta-review.json)及主执行／独立实际复跑。原录屏拒权、输入拒权、观察器失败及早期升级空间失败的原始日志保持不变。

## 当前交付物

| 变体 | DMG 字节 | SHA256 |
|---|---:|---|
| [Full](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi-macos-arm64-full-p6-closeout/Ruyi-macos-arm64-full-internal-trial.dmg) | 584388233 | `479a91fd76d9bf743b85b0be4fdfe7c9d8399490a960b2fdae97bb0b64eb8a51` |
| [Slim](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi-macos-arm64-slim-p6-closeout/Ruyi-macos-arm64-slim-internal-trial.dmg) | 51629071 | `341207021a6c6114dab886ee189b5aa98484911d966193eea0f850fd03cf5918` |

已授权的 Full App 固定在 `/Users/jiming/Applications/Ruyi-P6-Acceptance/Ruyi.app`，目录散列 `501730b8991898c00839ddf988f8355835383d11f2e9f298df8e268bfe18d61b`。实际包内 helper SHA256 为 `3131822a76d80674dc3183a3a98e969140f0957aecd1ed76a1d57d61798a0b69`。保持这份 App 的路径及签名字节稳定。

按用户指令已删除2007项旧包、原始构建目录和过期测试临时目录，释放约13.45GiB。[清理记录](../../maintenance/2026-11-13-space-cleanup/summary.json)及[保留文件核验](../../maintenance/2026-11-13-space-cleanup/retained-verification.json)确认最新两包、已授权App、源码与未提交工作保留。旧升级输入仅保留历史日志、散列与凭据，不能再从已删除路径直接重跑。

## 授权与使用

macOS 27 的录屏权限位于“隐私与安全 → 录屏与系统录音”的上方录屏列表；下方“仅系统录音”不授予截图权限。辅助功能入口在此系统显示为“设备控制和数据访问”。选择上述固定路径，由本人完成认证；仅看到同名 Ruyi 开关不足以证明对应当前 App。本次认证由用户亲自完成，代理未代输凭据或代授权限。更换或重新签名 ad-hoc App 后，需要重新核对权限身份。

On macOS 27, add this exact installed Full App to the upper screen recording list under Privacy & Security. The system-audio-only list does not grant screen capture. Accessibility appears as Device Control and Data Access on this host. Complete authentication personally and keep the authorized App unchanged. A different ad-hoc build may require a new grant.

`listenAuthorization=granted` 仅为诊断；本轮没有据此验收 Input Monitoring、监听事件或手动录制。正向 App 录屏／输入只验证固定 Full，未扩展为 Slim App 身份权限验收。

## 后续正式发行门

Developer ID、正式 hardened runtime、公证／票据、真实下载来源 Gatekeeper 首次允许、干净标准用户／另一台无开发工具 Mac、macOS14实际运行、正式身份 Keychain／TCC 升级稳定性、Windows同候选回归、真实跨平台迁移及原P5未验环境／故障矩阵继续待验。当前本地试用收尾没有豁免这些条件。

此前无人值守防锁屏已释放，休眠请求作为历史记录保留；用户返回后的本轮没有新增防休眠设置或再次请求休眠。所有变更仅本地提交，没有推送或发布。

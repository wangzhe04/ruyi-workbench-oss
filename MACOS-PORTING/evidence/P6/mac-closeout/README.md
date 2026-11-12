# P6 Mac 修复与无人值守收尾

本轮可自动完成的修复、定点复验和内部试用包评估已收尾；**P6 仍为 `in_progress`，两项真实 Ruyi App 正向授权验收未通过**。没有本人认证或豁免答复，不把未授权输入／录屏算成成功。正式发行与原环境门继续保留。

应用与包装来源 `74d57c88`，额外验收夹具 `b2283782`；分支 `codex/p6-mac-closeout`，仅本地提交。54份最终验证来源见 [冻结清单](source-freeze-package.json)，结构化结论见 [validation.json](validation.json)。

## 修复与验证

- 修复原生输入在停止准入竞态中误报 `input_failed`；键盘、鼠标、滚轮停止后拒绝新事件，已发生副作用与释放失败仍如实保留。确定性无事件检查、真实 SIGTERM 粘贴／拖拽及独立应用输入通过。
- 修复 Mac 命令、路径／别名、CLI、权限交互、安全代批与隐私恢复夹具。Windows 分支保留，只对真正专属子块明确 SKIP。8处清理调用改为真实 ChildProcess，拒绝未确认的清理结果。
- LaunchServices 返回 `/tmp` 而请求是 `/private/tmp` 的成功链路，以真实目录身份校验；所有进程／窗口断言保留。
- 原生 OCR 冷调用实测约38秒，两完整测试曾累计166.525／202.021秒；总件时限改300秒，单次产品期限与断言未变。后续官方定点为14.415／50.669秒，底层延迟原因未确证。

官方完整轮594件：588退出成功、6失败、1件重试通过；32件含内部SKIP，另14项live未运行。修复后的官方3件、文档／8项清理复验合并为592退出成功、2项App授权未通过。**这是明确来源的合并复验，不是最终候选594件重新整轮全绿**。[逐件对账](regression-composite.json)／[原始完整轮](regression-coverage.json)。

完整单元2653通过／18既有跳过，语法1196文件、构建新鲜度通过；静态79/80的facts统计失败修正并独立复验，形成80/80合并结果。独立17项E2E＋2项引用安全单元一次通过，无重试、无观察到的进程身份残留。[独立记录](independent-closeout/review.json)。

## 新交付物

| 变体 | DMG字节 | SHA256 | 主执行＋独立验收 |
|---|---:|---|---|
| [Full](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi-macos-arm64-full-p6-closeout/Ruyi-macos-arm64-full-internal-trial.dmg) | 584388233 | `479a91fd76d9bf743b85b0be4fdfe7c9d8399490a960b2fdae97bb0b64eb8a51` | 安装13／离线19／Trash12／升级回退15（APFS独立副本） |
| [Slim](/Users/jiming/Documents/ruyi-workbench-mac/ruyi-workbench/dist/Ruyi-macos-arm64-slim-p6-closeout/Ruyi-macos-arm64-slim-internal-trial.dmg) | 51629071 | `341207021a6c6114dab886ee189b5aa98484911d966193eea0f850fd03cf5918` | 安装13／离线7／Trash12／升级回退14（普通复制） |

每包492份来源与74d57实际签出字节对应，Full／Slim原生签名对象210／7，均为ad-hoc内部试用、未公证。[产物绑定](artifact-binding.json)／[独立新包验收](independent-packages/review.json)。原b662／1953发行镜像保留。

Full普通复制第二份App在当前磁盘上真实失败（ENOSPC），不计正常复制升级通过；失败后旧App完整散列与原镜像相同，数据与完整备份相同。Full补验显式用自有旧App的APFS独立inode副本，再从真实新DMG按校验和同步、验证签名与完整目录散列；全部原14断言保留，新增1条身份检查。Slim仍走普通复制。两者均实际启动新App、恢复完整快照并启动保留旧App。同产品3.0.1构建间回退、schema12向14归一化，不承诺未来任意schema降级。[空间失败保护](full-upgrade-enospc-protection.json)／[夹具复核](upgrade-staging-code-review.json)。

Full首轮包装曾报签名子系统internal error；日志保留，后续同代码重试成功，未将原因确认为磁盘。仅回收自有再生依赖副本与旧开发draft重复运行时，旧draft源码／原native／manifest已归档；P6-01原ZIP和散列边车完整保留，只回收逐字验证后的重复展开目录。[清理记录](archived-input-deduplication.json)。

## 尚未验收

真实新源码App已通过LaunchServices到服务／ACC链路，诊断完整；录屏、辅助功能及事件授权为denied。系统设置旧Ruyi显示on，刷新需要Touch ID／登录密码；认证已取消，未输入凭据、未改变授权。需要本人完成当前目标App认证后再做正向复验；源码入口与最终安装App身份须分别核对，不能用Node入口替代App资格。[授权证据](permission-qualification.json)。

Developer ID、公证／票据、实际下载来源Gatekeeper、干净标准用户／另一台Mac、macOS14、正式身份Keychain／TCC、Windows同候选及原P5未验门均继续保留，不因本轮无人值守收尾视为通过。

## 电源与收尾

本轮caffeinate有PID／出生身份记录；恢复历史屏保idleTime300、仅释放本轮断言并按用户指令请求休眠。实际执行状态以 [电源记录](power-release.json) 和 [休眠请求](sleep-request.json) 为准；queued／accepted不等于已观测整机进入睡眠。原P5完整门仍未通过，最新P6释放指令单独覆盖此前保持唤醒条件。

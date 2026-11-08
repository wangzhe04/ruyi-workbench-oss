# Mac 桌面开发宿主

P4 使用 Swift、AppKit 与 WKWebView。当前开发 App 由本机 Apple SDK 构建，使用 ad-hoc 开发签名，读取构建时记录的工作台源码目录。P6 负责离线运行时闭包、Developer ID、公证和正式安装升级。

## 构建与启动

从仓库根目录执行，开发检查使用 Node.js 24。

```sh
node ruyi-workbench/app/build.js --check
node ruyi-workbench/tools/build-macos-desktop.js
open ruyi-workbench/dist/Ruyi.app
```

也可直接运行同一个宿主，Finder 与终端入口共用依赖发现和服务管理。

```sh
ruyi-workbench/dist/Ruyi.app/Contents/MacOS/RuyiDesktop
```

Node 按非空 `RUYI_NODE_PATH`、`runtime/node/bin/node`、`~/.local/bin/node`、`/opt/homebrew/bin/node`、`/usr/local/bin/node` 的顺序选择。显式指定的路径失效会显示错误页。宿主使用固定运行时 PATH，跳过登录 profile。数据根、旧环境变量和旧目录迁移沿用现有直接 `serve` 入口。

默认关闭窗口继续保留服务。App 菜单中的“关闭窗口后继续后台运行”可修改该行为，偏好按数据根保存。关闭该选项后，关窗沿用退出菜单和 Cmd-Q 的服务收尾。重新打开 App 或再次启动会显示原窗口。宿主异常退出后，私有 stdin 租约结束会触发服务的既有 SIGTERM 清理路径。窗口位置与 WebKit profile 按数据根隔离。

“登录时启动”读取实际 SMAppService 状态，仅在点击该菜单时注册或注销。需要批准时打开系统登录项设置，回到 App 后刷新状态。

关窗、隐藏、最小化和睡眠会通知页面取消采集，迟到的麦克风授权结果也会释放轨道。唤醒时复验原服务 PID、runtime 与健康身份，保持当前文档和草稿，事件流携带原游标重新连接。当前主机已完成一次短时Software Sleep/DarkWake恢复、醒后SSE验证，以及临时登录项注册后注销。详见[实机证据](../../MACOS-PORTING/evidence/P4/lifecycle/physical-system/README.md)。

开发 App 从构建目录读取源码。源码位于文稿目录时，Finder 入口需要该 App 的文稿访问权限。失败页提供系统设置恢复路径。新ad-hoc构建可能重新触发文稿或麦克风授权，本地验收应复用同一冻结开发包；正式签名身份的权限稳定性归P4-04/P6复验。

## 工具链

默认使用 `xcrun` 选中的 Swift 编译器和 SDK，可通过 `RUYI_MACOS_SDK_PATH` 指定 SDK。构建目标为 arm64/macOS14，本轮实际运行环境为 macOS27.0.1 arm64，最低系统实际运行继续交接 O2/P6。

部分 Command Line Tools 升级遗留 `module.modulemap` 与 `bridging.modulemap` 的等价 `SwiftBridging` 声明。构建器仅在去除行注释后内容相同时，用进程级 VFS 映射隐藏冗余声明。SDK、编译器路径和映射使用情况写入 App 的 `Contents/Resources/build.json`。

## 验收

```sh
RUYI_DESKTOP_TEST_APP="$PWD/ruyi-workbench/dist/Ruyi.app" node dev-harness/macos-desktop-host.e2e.js
RUYI_DESKTOP_TEST_APP="$PWD/ruyi-workbench/dist/Ruyi.app" node dev-harness/macos-desktop-bridge.e2e.js
RUYI_DESKTOP_TEST_APP="$PWD/ruyi-workbench/dist/Ruyi.app" node dev-harness/macos-desktop-media.e2e.js
RUYI_DESKTOP_TEST_APP="$PWD/ruyi-workbench/dist/Ruyi.app" node dev-harness/macos-desktop-lifecycle.e2e.js
```

上述四件复用已构建的冻结App，各自启动真实AppKit/WKWebView及隔离fixture-home。覆盖完整工作台初始化、Loopback 健康与服务身份、单实例可见激活、窗口恢复、关窗与退出、宿主强制终止后的服务退出、持久 profile 隔离、旧数据兼容、LaunchServices 启动及构建失败恢复。

验收参数 `--acceptance-report`、`--acceptance-script`、`--acceptance-screenshot`、`--acceptance-close-window` 和 `--acceptance-auto-quit` 供本机夹具调用。页面检查在指定报告时启用，报告省略服务鉴权 token。任意脚本来自启动进程显式提供的本地文件，网页没有该执行入口。

`--acceptance-system-events` 仅在同时指定报告时，将 SIGUSR1/SIGUSR2 交给正常睡眠/唤醒回调，报告明确标记模拟。生命周期件另外实际暂停、恢复其拥有的后端进程，并检查错过调度策略。`--acceptance-toggle-background` 调用正常关窗设置处理器，`--acceptance-hide` 和 `--acceptance-minimize` 操作夹具窗口。这些参数用于隔离目录中的开发验收。

系统交互桥、通知、麦克风与完整 MCP/CLI 子树生命周期分别归 P4-02 至 P4-04。当前合成音源和隔离进程树已验证，真实系统权限和物理采集边界见对应证据。后续修改继续运行完整工作台宿主回归及独立复核。

`--acceptance-microphone-deadline`需同时指定报告才启用物理验收专用观察与独立两秒停止保护。物理探针仅允许一次成功采集，核验音轨释放、原生停止完成及有效PCM不超过三秒，并记录最终采集指示状态。音频仅留隔离目录，转写使用本机环回假端点。当前主机物理麦克风和用户辅助原生拖放均已通过独立复核。[物理验收](../../MACOS-PORTING/evidence/P4/media/physical/reporting-delay/README.md) [原生拖放](../../MACOS-PORTING/evidence/P4/bridge/native-drop/README.md)

# P4-01 宿主与服务管理

2026-11-07 完成当前 macOS27.0.1 arm64 开发环境下的 P4-01 本地开发与独立验收。基线为 `d97db57b`，交付保存在工作树，源码 SHA256 见 [指纹](source-fingerprint.json)。P4 整阶段继续进行。

## 实现

- Swift、AppKit 与 WKWebView 独立 App，恢复窗口位置，关窗保持后台，重新启动显示原窗口。
- 按数据根的内核文件锁、可见激活通知和持久 WebKit profile，覆盖目录别名及旧数据链接。
- 受控 Node 依赖发现、真实服务启动、运行时 PID 与 overlay 健康身份核对、失败页与重试。
- 私有 stdin 租约和正常退出收尾。宿主 SIGKILL 后服务按既有 SIGTERM 路径退出。
- 本机 SDK 的进程级 Swift 模块映射修复、开发签名校验、编译前后源码指纹和旧包失败恢复。

原生源码位于 [desktop-macos](../../../../ruyi-workbench/desktop-macos/README.md)，构建入口为 [build-macos-desktop.js](../../../../ruyi-workbench/tools/build-macos-desktop.js)。默认输出为 `ruyi-workbench/dist/Ruyi.app`。

## 验收结果

| 检查 | 结果 | 记录 |
|---|---|---|
| 默认构建及中文路径 App 的真实宿主 e2e | 27 通过，0 失败，退出 0 | [正常入口](native-normal-entry.txt) |
| 独立 agent 真实宿主 e2e | 27 通过，0 失败，退出 0 | [独立运行](native-independent.txt) |
| 原生锁错误页实际点击重试 | 恢复完整工作台，退出 0，服务已退出 | [交互记录](retry-interaction.json) |
| 完整单元 | 2491 通过，18 既有跳过，0 失败 | [工程门](fast-final.txt) |
| 完整静态 | 80/80，通过 | [工程门](fast-final.txt) |
| JavaScript 语法 | 1130 文件，0 失败 | [语法](syntax-final.txt) |
| 后端构建新鲜度、diff 空白检查 | 通过 | [结构化结果](validation.json) |
| 开发 App 签名、五项内嵌源码指纹 | 通过，最低部署声明 14.0 | [构建元数据](build-metadata.json) |

真实宿主检查覆盖完整工作台模块与鉴权配置、HTML srcdoc、窗口恢复与关闭后的后台服务、再次启动后的可见窗口、正常退出、强制退出后的服务退出、生产 profile 的同根持久化与异根隔离、旧目录迁移、旧 symlink 与相对路径，以及 LaunchServices 在受限 PATH 下的依赖发现。构建故障注入覆盖新包替换失败且旧包恢复也失败时的保留路径。

主 agent 与独立复核者分别查看了真实 WKWebView 渲染。导航、欢迎页和输入框显示正常，原端口已被其他服务占用时的 8766 回退提示与真实监听一致。[截图](workbench.png)

独立复核为 `/root/p4_host_review`，剩余代码发现为 0。旧数据兼容、profile 串用、窗口恢复、srcdoc、构建回退及锁失败重试等发现均已修复并复验。[独立复核](review.json)

首轮原生测试的路径身份和退出等待失败、第二轮窗口位置夹具受系统可见区域约束的失败，以及首轮三个工程清册失败均保留。相应修复及最终复跑见 [完整结果](validation.json)、[原生首次](native-first.txt)、[原生第二次](native-second.txt)和[工程首次](fast-first.txt)。

## 本轮边界与交接

- App 使用 `org.ruyi.workbench.development` 和 ad-hoc 开发身份，资源读取构建时的源码目录。正式 bundle ID、Team ID、Developer ID 下的 Keychain/TCC 与升级访问，按用户明确决定保留待办。
- macOS14 是已编译的最低部署目标，实际运行继续交接 O2/P6。本轮实际主机为 macOS27.0.1 arm64。
- P4-02 接入系统桥、文件选择器、Finder 可见验收、编辑器、安全外链、通知和快捷键。
- P4-03 验证实际麦克风采集、拒绝恢复、编码与语音链路。
- P4-04 验证 MCP/CLI 完整子树、睡眠唤醒、调度恢复、登录启动和生命周期。本包的进程结论限于宿主与所启动的 Node 服务。
- P4 原计划中的相关 Windows 回归仍列为阶段待验项。工程门保留 18 项单元跳过和 7 项 live 排除。

## 复现

从仓库根目录执行，真实宿主测试需要可用的 Mac 图形会话和 Apple 开发工具链。

```sh
node ruyi-workbench/tools/build-macos-desktop.js
node dev-harness/macos-desktop-host.e2e.js
node dev-harness/run-all.js --fast
node ruyi-workbench/app/build.js --check
```

构建产物使用本机开发运行时。业务数据根沿用现有规则，测试使用独立 fixture-home。源码包、进程级工具链映射和编译缓存由构建器管理，构建双重失败时保留旧包并打印其恢复路径。

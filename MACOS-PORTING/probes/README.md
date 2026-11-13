# P0 探针使用说明

这些程序仅用于验证，不由产品加载。应在仓库根目录执行；输出目录中可能含本地临时路径和假件数据，不含设计上需要读取的真实凭据。

## Node 基线

```bash
node MACOS-PORTING/probes/run-baseline.cjs --profile ci --output /tmp/ruyi-p0-ci-results
node MACOS-PORTING/probes/run-baseline.cjs --profile audit --section unit --output /tmp/ruyi-p0-unit-results
node MACOS-PORTING/probes/run-baseline.cjs --profile audit --section static --output /tmp/ruyi-p0-static-results
node MACOS-PORTING/probes/run-baseline.cjs --profile audit --section smoke --output /tmp/ruyi-p0-smoke-results
```

`ci` 为已知可运行的窄子集，不等于完整兼容。`audit` 包含全部 unit、全部 static 和 11 件功能 e2e；其余 e2e 标记 notSelected。全失败继续收集但最终非零退出，不做失败白名单。各件串行，unit 内限制四路。每件使用仓库 fixture-home/guard、独立短 tmp，POSIX 整组回收；Windows 用仓库 killOwnTree。成功后清理自有临时目录，失败保留路径以便取证。

原始全 unit 结果由 `node --require ./dev-harness/lib/self-isolate-home.js --test --test-concurrency=4 --test-reporter=tap 'dev-harness/unit/*.test.js'` 获得，沿用原系统 tmp，因此暴露 `/var` 别名问题。新 runner 的 canonical 短 tmp 可能避免该项夹具失败，不能据此声称产品已修复。

## 原生 API

```bash
ruyi_probe_dir=$(mktemp -d /tmp/ruyi-p0-native.XXXXXX)
xcrun clang -fobjc-arc -fno-modules -mmacosx-version-min=14.0 \
  -framework Foundation -framework AppKit -framework WebKit -framework Security \
  -framework ApplicationServices -framework AVFoundation -framework Vision \
  MACOS-PORTING/probes/native-probe.m -o "$ruyi_probe_dir/native-probe"
"$ruyi_probe_dir/native-probe" capabilities
"$ruyi_probe_dir/native-probe" keychain
"$ruyi_probe_dir/native-probe" ocr
node MACOS-PORTING/probes/webview-probe.cjs "$ruyi_probe_dir/native-probe"
```

必须确认编译成功后执行下一行。capabilities 仅读权限状态；keychain 创建独立临时文件钥匙串并禁用交互，结束删除；ocr 仅绘制自己的内存位图；WebView 访问自己的随机本机端口，用非持久存储，不申请麦克风、不接触用户文件。临时钥匙串 API 的弃用警告保留；不能把这个隔离测试的建钥匙串方式复制进生产。

Swift 工具链单独诊断：

```bash
xcrun swiftc -swift-version 5 -target arm64-apple-macosx14.0 \
  MACOS-PORTING/probes/swift-toolchain.swift -o /tmp/ruyi-p0-swift-toolchain
```

本机该命令失败于 Foundation/SDK 不匹配，日志已保存。不要为通过探针编辑系统 SDK 头文件或关闭系统保护。

临时 App 对照实验：创建自己的临时 `.app/Contents/MacOS`，将编译探针复制为 `RuyiP0Probe`，Info.plist 设置 `CFBundleExecutable=RuyiP0Probe`、`CFBundleIdentifier=org.ruyi.workbench.p0-probe`、`CFBundlePackageType=APPL`、`LSMinimumSystemVersion=14.0`、`NSMicrophoneUsageDescription`。用 `codesign --sign - --timestamp=none <自己的临时App>` 做 ad-hoc 签名，然后把其 Contents/MacOS 下可执行文件传给 `webview-probe.cjs`。这一对照只检测 JS 接口是否存在，不启动录音；正式签名仍须单独验收。包应使用独立临时目录，不覆盖已有 App。

## Python 依赖

```bash
python3.12 MACOS-PORTING/probes/python-deps-probe.py --self-test
python3.12 MACOS-PORTING/probes/python-deps-probe.py
```

正式探针会联网下载依赖并在临时 venv 安装，用于开发期验证，不是产品运行期网络依赖。输出写入 `evidence/P0/python/`，再次运行前应另存旧记录。临时 venv 保留，路径记录在 report；可在确认不再需要后删除该专属临时目录。新脚本隔离家目录/缓存，并在超时/异常时回收专属进程组；不 import pynput/pyautogui，不下载/运行 Chromium，不控制真实桌面。

解析出的 wheel 在当前 macOS 可用不代表支持最低 macOS 14；部分纯 Python 包由 sdist 构建成功，因此“当前能安装”也不等于“离线 wheel 闭包已经交付”。P3/P6 必须另做版本锁、最低系统、许可证与离线安装验证。

## P3 静态最低部署版本

`audit-macos-minimum.py --wheelhouse <准备的wheel目录> --browser-root <准备的浏览器cache> --out <JSON>` 只读取arm64 Mach-O的macOS部署声明，不执行二进制。完整Chromium必需路径固定到本次1248/156.0.8078.4版本；浏览器升级须同步路径并重新审计。发现解析错误或高于14.0的声明时退出1。它不证明macOS14实际运行、系统符号兼容、完整发行闭包或签名。复现与独立负控见 [P3补验](../evidence/P3/acceptance/minimum/README.md)。

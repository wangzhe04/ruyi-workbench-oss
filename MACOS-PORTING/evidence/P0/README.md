# P0 实施结果与证据

执行日期：2026-10-30。产品基线：`f5223548b74b62b2eefe548c39b33ab5fadd91e3`。本地：macOS 27.0.1 / arm64，Node 24.15.0，Python 3.12.10，Command Line Tools + SDK 15.2。新增探针/CI/文档尚未提交；产品源码和原测试断言保持不变。

## 结论

P0 已形成可用于 P1 的双平台证据基线、平台契约、技术探针和明确待办。**推荐继续 AppKit + WKWebView、Node 24、Python 3.12、Keychain、Vision 路线**。当前阻塞完整产品兼容的重点是进程回收、Mac 路径/测试夹具、Windows 依赖拆分、Swift 工具链匹配与正式权限/签名验证。

这不是“Mac 全功能已通过”的结论。最低系统版本、真实 CLI 账户、麦克风采集、截图/输入/AX 应用操作、正式 Keychain 身份、公证和完整离线包仍是后续阶段验收项。

## 1. 基线结果

| 项目 | 结果 | 证据 |
|---|---|---|
| 全部 278 个 unit 文件 | 2,493 tests：2,470 pass、3 fail、20 skip | [unit-full.txt](unit-full.txt) |
| 3 个失败文件串行复测 | 18 tests：15 pass、3 fail，失败复现 | [unit-failure-recheck.txt](unit-failure-recheck.txt) |
| 全部 80 个 static e2e | 80 pass、0 fail | [static/report.json](static/report.json) |
| 11 个功能 e2e 抽测 | 9 pass、2 fail | [smoke/report.json](smoke/report.json) |
| 新 CI 配置的本机等价子集 | 8 个任务全部通过；含语法/构建、82 tests 中 81 pass/1 skip、1 static、4 e2e | [ci-local/report.json](ci-local/report.json) |
| 同产品 SHA 的上游 CI 历史 | Windows e2e、ACC smoke、release-dryrun 和 Linux static 成功 | [upstream-ci.json](upstream-ci.json) |

上游运行：[e2e run 39452236165](https://github.com/wangzhe04/ruyi-workbench-oss/actions/runs/39452236165)。这是公开的历史结果，没有在本次重新跑 Windows。新增 `.github/workflows/macos-p0.yml` 配置了 macos-14 / windows-latest 同源子集，**未推送、未远程触发、未声称本次 Windows 新工作流已经通过**。runner 标签不等于 CPU 架构，以结果里的 `arch` 为准。

通过的 9 个功能 e2e：provider-custom-headers、git、scheduler-api、mcp-bridge、anthropic-fake、kimi-agent-cli、agent-role-openai、workbench-memory、provider-compact。CLI/Provider/MCP 主要使用假件，不代表真实登录服务验证。

本次执行 539 个 e2e 中的 **91 个唯一文件**（80 static + 11 功能），其余 **448 个未执行**。逐文件状态在 [baseline-catalog.json](baseline-catalog.json)，未执行不写成 skip 或 pass。没有以新白名单抹掉原测试失败。

## 2. 失败归因及后续工作包

| 失败 | 分类与证据 | 处理归属 |
|---|---|---|
| `unit/git-tool-shape.test.js` G8 | **产品缺陷**：超时后 hook 的 `sleep 60` 孙进程仍存活；串行复现，与无 `/proc` 的 Mac 分支一致 | P1-04：可靠停止及进程身份 |
| `unit/script-run-cleanup.test.js` S1 | **夹具路径假设**：`__filename` 返回 `/private/var/...`，断言拿 `/var/...` 做字符串前缀；两者 realpath 相同 | P1-02：路径身份与测试修正 |
| `unit/steward-inbox-tick-cost.test.js` | **夹具 stdout 刷新问题**：大量 JSON `stdout.write` 后立即 `process.exit`，管道输出截断，父进程 JSON.parse 失败；独立诊断中立即退出仅收到 65,536 字节，等待写回调收到完整 200,019 字节 | P1 测试基线修正；不要改管家业务绕过 |
| `file-guard.e2e.js` | **Windows 夹具**：第 92 行创建 `C:\Windows/Temp/...` 得到 ENOENT | P1-02：Mac 正反例与平台化夹具 |
| `checkpoint.e2e.js` | **Windows 夹具**：用目标 `b*.txt` 强制 rename 失败；Mac 允许该文件名，实际移动成功，后面的失败回滚断言自然不成立 | P1-02：用跨平台可控失败注入，不删除原回滚断言 |

路径与 stdout 的独立诊断在 [fixture-diagnostics.json](fixture-diagnostics.json)。诊断没有改原测试结果，失败仍保留，正式修复与完整回归属于 P1。

另记录产品行为：Mac Unix socket 在异常终止后可能残留，后续启动 fail closed；旧固定夹具目录曾因此出现重复实例拒绝。P1 需要设计有身份校验的恢复，不得自动删除未知所有者 socket。

### 第一次新 runner 试跑的修正

[smoke-harness-attempt-1/report.json](smoke-harness-attempt-1/report.json) 为**无效的产品基线尝试**：新 runner 错误地注入高优先级 `RUYI_HOME`，覆盖部分只设置旧变量的夹具；固定 tmp 数据路径还遇到旧 socket 残留。已修正 runner 为“家目录隔离，但数据根由各测试自己定义；每件使用独立短临时目录”，随后得到上述 9/2 结果。保留首次日志用于审查，不把这些失败混入产品缺陷数。

## 3. 技术探针结果

| 探针 | 实际结果 | 证明边界 |
|---|---|---|
| Swift 最小 Foundation 编译 | 失败：SDK 与 compiler build 不匹配、SwiftBridging 重复模块诊断 | 本机工具链环境问题；未安装/替换系统 Xcode/CLT，P4 前修复 |
| Objective-C AppKit/WebKit 同 API 编译 | target macOS 14 编译成功 | 证明本机 SDK 的 Objective-C API 可用，不是 macOS 14 运行验收 |
| WKWebView 本地 fixture | 未认证拒绝、bootstrap、认证 fetch、SSE、上传、marked 与 mermaid 通过 | 是合成回环 fixture，不是完整工作台 UI/HostBridge 安全验收 |
| 麦克风 API | 裸 CLI `getUserMedia=false`；临时 ad-hoc App 声明用途后为 true；两者 AudioContext/webm-opus/mp4 探测为 true | **没有请求授权/录音**；完整语音流程须 P4 验收；较旧 WebKit 仍需格式协商 |
| 临时钥匙串 | 创建/添加/读取/更新/删除/清理通过，读回字节一致 | 独立 disposable file keychain，不读用户 login keychain；不证明生产 ACL/签名升级访问 |
| 权限状态 | 当前探针 AX trusted=true、screen preflight=false、mic status=notDetermined | 只读状态，不截屏/输入/弹权限；不把宿主已有信任外推为正式 App 信任 |
| Vision OCR | 自绘中英位图识别 `INVOICE 42` 与 `中文测试`，返回 bounding box | 没有截取真实屏幕；点击/多屏坐标仍待 P5 |
| 原始 ACC 安装 dry-run | 因 `pywin32>=306` 无匹配分发失败 | 确认包依赖阻塞 |
| 假设拆分后的 Python 依赖 | 排除四项 Windows 依赖后安装成功；14 个非桌面模块导入、四种文档往返通过 | 未修改 ACC 包，也未启动其完整工具注册；未验证 Chromium 运行时、桌面输入、宏与版式 |

对应记录：[环境](environment.json)、[Swift 最小编译](swift-toolchain.txt)、[初始 Swift 失败](native-build.txt)、[Objective-C 编译](objc-build.txt)、[裸进程 WebView](webview.json)、[App 包 WebView](webview-bundle.json)、[临时 ad-hoc 身份](probe-bundle-signing.json)、[Keychain](keychain.json)、[权限](native-capabilities.json)、[OCR](ocr.json)、[Python](python/report.json)、[模块/文档](python/portable-smoke.txt)。

App WebView 虽测试通过，stderr 中的 `sandbox_extension_issue_file_to_process` 仍保留，交 P4-04 用正式包布局/签名定位。当前 ad-hoc 探针不是 Developer ID，也没有公证。

Python 原始安装试跑使用临时 venv，**仍使用了用户 pip/matplotlib 缓存**，没有安装全局包。独立复核后脚本已增加临时 HOME/XDG/MPL/PIP 目录，并为 pip/wheel 构建使用专属进程组。此次针对性复验了真实子孙超时回收与子进程环境隔离，见 [python-probe-selftest.json](python-probe-selftest.json)；没有为制造“新版本全量安装日志”而重复下载全部依赖。原安装证据和修复后的隔离证据是不同范围，不能混写。

## 4. 交付与后续入口

- 平台接口、数据/凭据/进程/宿主决策：[11-P0-DECISIONS.md](../../11-P0-DECISIONS.md)。
- 探针源码、复跑命令与限制：[probes/README.md](../../probes/README.md)。
- 独立复核与问题处理：[review.json](review.json)。
- 交付一致性检查：[delivery-checks.json](delivery-checks.json)；最终探针与 workflow 源码哈希：[source-hashes.json](source-hashes.json)。文档本地链接、JSON/任务估算、探针语法、workflow YAML 和产品构建新鲜度检查通过。
- 下一步实施 P1，先解决进程清理和路径边界，再启用更多 Mac 执行能力；不得以本次大部分测试通过跳过安全修复。

P0 不计“实际完成了 4–6 人日”；这是此前人工预算，当前仅记录 AI 实施与机器执行证据，实际人日未核算。P1–P6 的具体范围未扩张；估算检查点见 [工作量评估](../../09-EFFORT-ESTIMATE.md)。

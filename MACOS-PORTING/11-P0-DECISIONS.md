# P0 决策与平台接口契约 v1

日期：2026-10-30。性质：后续实施的设计基线，**不是已接入产品的接口**。源码仍为 `f5223548`；实测证据与缺口见 [P0 结果](evidence/P0/README.md)。本阶段未修改 `app/src`、`server.js` 或原有测试断言。

## 1. 冻结的边界

| 决定 | v1 结论 | 依据及限制 |
|---|---|---|
| 业务架构 | 一套 Node/Web 业务 + 平台适配器；Windows 保持 | 80 组静态通过，核心 Mac 链路可跑；不复制后端 |
| 首发架构 | 原生 arm64 优先 | 本机 arm64 实测；Intel 仍为增量范围 |
| 最低系统目标 | 目标 macOS 14，尚不能宣传已兼容最低版本 | 本机实测为 27.0.1；编译 target=14 不等于在 14 运行过；P6 必须补真机/对应 runner |
| 开发运行时 | Node 24，Python 3.12 | 本机 24.15.0 / 3.12.10，实验依赖能安装并执行文档往返 |
| 宿主 | AppKit + WKWebView；生产优先 Swift，允许窄范围 Objective-C helper | WebKit 传输/渲染探针通过；本机 Swift SDK 不匹配，需修复工具链后再开 Swift 正式实现；不因此改选整个前端技术栈 |
| 默认 shell | `/bin/bash --noprofile --norc`；一次性脚本加 `-c`，常驻模式由 P1 定义帧协议 | 使用系统 Bash 的兼容语法，不依赖新版本特性；清除 `BASH_ENV`/`ENV` 等启动注入入口；不隐式读取登录 profile，不承诺完整 TTY |
| 数据根 | 保持 `~/.ruyi-workbench` / `RUYI_HOME` | 避免与平台改造同时进行业务数据搬迁 |
| 凭据 | 平台保护器 + Keychain；秘密经受限 IPC，失败不回落明文 | 临时文件钥匙串 CRUD 已验证；登录钥匙串、Data Protection/ACL、签名升级访问仍待 P2/P4 |
| OCR | 优先 Vision；保留算法后端替换接口 | 合成中英文图片识别成功，无需接入 Windows OCR |
| Python/ACC | 拆共享依赖与 Windows extras，按能力注册 | 原包安装因 pywin32 失败；排除 pywin32/uiautomation/comtypes/winsdk 的实验依赖集合通过；尚未改正式 pyproject |
| 发布 | 首发整包替换升级、备份与回退 | 不复用 Windows PowerShell overlay，不在 P0 建更新服务 |

Python 解析出的版本在 [resolved-freeze.txt](evidence/P0/python/resolved-freeze.txt)。这是 **27.0.1/arm64 上的实验快照**，不是面向 macOS 14 的正式锁文件；其中某些 wheel 的最低系统版本可能更高。P3 必须按最低系统目标重新锁定/构建与验证，P6 验证完整离线闭包。

## 2. 能力状态契约

建议接口 `PlatformCapabilities.snapshot()` 返回只读快照，`probe(id)` 做有超时的显式刷新。启动请求不等待全部外部工具冷探测。字段形状：

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "arch": "arm64",
  "capabilities": {
    "desktop.capture": {
      "supported": true,
      "installed": true,
      "authorization": "denied",
      "ready": false,
      "reasonCode": "platform.permission_denied"
    }
  }
}
```

此 JSON 是契约示例，不是本机权限原样快照。`authorization` 枚举为 `not_required / unknown / not_determined / granted / denied / restricted`。`supported` 指当前实现和 OS 支持，`installed` 指依赖完整，`ready` 必须同时满足实现、依赖、授权和运行探针；未知状态不得当作可用。失败可附脱敏 `detail`、`checkedAt` 和 `retryable`，不得包含密钥或原始 helper stderr。

首期能力 ID：`shell.exec`、`shell.session`、`cli.claude`、`cli.kimi`、`files.search`、`files.documents`、`browser.automation`、`secrets.protect`、`host.notification`、`host.microphone`、`desktop.capture`、`desktop.input`、`desktop.accessibility`、`desktop.ocr`。

所有工具暴露、Playbook requires、提示词、前端入口与体检从同一快照派生。行为上不能单凭 `process.platform === 'darwin'` 或文件存在就宣布已支持。缓存失效至少响应权限撤销、设置/依赖路径变化、helper 退出与 App 重启。

## 3. 执行与停止契约

`ProcessRuntime.start({executable, argv, cwd, env, stdinMode, deadlineMs, owner})` 返回不透明 `handle`；不把裸 PID 当授权。`owner` 关联会话/运行/工具调用。`stop(handle, reason)` 返回 `terminated / already_exited / incomplete`、退出状态与未确认清理的子进程数；不完整清理不能显示“已全部停止”。

- 对所有 CLI/MCP/shell/toolbox 启动登记；Mac 使用自有进程组、父子关系与启动身份。必要时由 libproc 原生 helper 提供 pid/ppid/start time，P1 先验证覆盖边界。
- 超时与用户停止走同一回收接口；先快照再终止，复核身份，不对陌生 PID、进程名匹配或全系统进程做泛化清理。
- 进程组能覆盖普通子孙，无法自动证明对脱离会话/重设进程组的任意程序有效。P1 必须测试逃逸情形，并准确报告能力限制。
- 单次执行的 stdout/stderr 有界，保留退出码、超时和中断标记；常驻 shell 的协议帧不得被普通命令输出伪造。
- 新建 API 沿用现有结果与审批封装；不得绕过 exec tier、会话工作目录检查、审计、时间预算及不可逆操作表。

实测 `git-tool-shape` 的孙进程停止断言失败，作为 P1-04 的必修产品缺陷。隔离探针证明独立进程组能终止普通子孙，但**没有修复产品当前 killPosixChildTree**。

## 4. 路径与实例所有权契约

`PathPolicy.resolveForOperation(rawPath, context)` 同时保留用户显示路径、规范化绝对路径、realpath 与存在性/文件身份。按文件系统身份判断包含关系；不存在的目标解析最近存在父目录再追加，不简单字符串转小写。

系统写保护第一版默认拒绝 `/System`、`/bin`、`/sbin`、`/etc`（含 `/private/etc`）、核心 `/usr` 子树及关键 `/private/var` 系统数据；`/usr/local`、`/opt/homebrew`、`/Library`、`/Applications` 等不一概视为普通工作区，按操作/显式授权细化。工作台敏感数据双向拒绝沿用；不得借 bypass 模式跳过底线。精确规则和例外由 P1-02 以正反例锁定，P0 不把设计列表直接接进产品。

`/var` 与 `/private/var` 指向同一对象的场景已导致测试纯字符串断言失败；Mac 默认大小写不敏感与大小写敏感卷都要覆盖。新路径策略不能误伤合法中文、空格或 POSIX 文件名 `*`。

实例所有权继续使用 OS 持有的 IPC 锁。当前 Unix socket 在 SIGKILL 后可能留下路径；P1 补专属目录、身份与存活检查、短路径上限以及明确恢复流程，**不能为通过测试自动 unlink 未知所有者 socket**。新 baseline runner 使用每件独立短临时目录避免旧测试残留互相污染，但没有改变产品行为。

## 5. 凭据与宿主桥契约

`SecretProtector.protect/unprotect` 输入是有大小上限的字节和绑定元数据，返回带 `provider/schemaVersion` 的记录或结构化错误。建议把封装密钥交给 Keychain，Node 使用现有加密记录/绑定机制；具体密码学记录兼容性在 P2-02 冻结并测试。当前临时文件钥匙串探针使用废弃 API 建立隔离测试域，**生产不采用该建钥匙串流程，也不据此宣称登录钥匙串 ACL 已通过**。

错误代码至少覆盖：`platform.unsupported`、`platform.dependency_missing`、`platform.permission_required`、`platform.permission_denied`、`platform.unavailable`、`platform.timeout`、`platform.process_cleanup_incomplete`。对外仍使用仓库既有 `apiFailure`/工具错误格式，新增代码需进入对应语言包。

`HostBridge` 仅允许主 frame、精确 scheme/host/port 的可信本地来源，验证消息类型及参数、限制长度；导航与新窗口另行限制。不提供任意命令执行接口。通知、选择器、文件打开、麦克风状态都通过明确消息 schema，不让远程页面继承桥权限。

本机裸 CLI WebView `getUserMedia=false`；包含 `NSMicrophoneUsageDescription` 的临时 ad-hoc App 中为 true。两次均没有请求麦克风，也没有录音，因此 P4-03 仍需验证授权/拒绝、数据编码、转写与资源回收。

## 6. 验收样例与交付身份

| 样例 | 本阶段已做 | 后续验收 |
|---|---|---|
| 文本/路径 | 临时中文文档、canonical path 诊断 | P1 中文/空格/emoji、链接、敏感卷与越界写 |
| 模型/工具 | 假 Provider、假 MCP、假 CLI 的既有 e2e | P2 各真实 CLI 的登录/恢复/停止；用户提供端点凭据 |
| 文档 | 临时 DOCX/XLSX/PPTX/PDF 读写往返 | P3 样式/中文字体渲染、真实 ACC 工具交付与撤销 |
| 浏览器 | 本地 fixture 鉴权/SSE/上传，随库 marked/mermaid | P3 Chromium profile/表单/退出；P4 真实完整工作台 WebKit UI |
| 图像/OCR | 仅内存合成 `INVOICE 42`、`中文测试` 位图 | P5 截图坐标、双屏、应用窗口与 AX/OCR 动作闭环 |
| 桌面应用 | 未控制任何用户应用 | P5 自建窗口、TextEdit、Finder、Chromium 的指定场景 |

探针 App 标识仅为 `org.ruyi.workbench.p0-probe`，临时 ad-hoc 签名，不是最终产品 bundle ID/Developer ID。生产 bundle ID、Team ID 和 helper signing requirement 由发行维护者在 P4-04 确定；没有签名身份时不臆造。资源提供责任：P1 实施者负责自动化夹具，P3 实施者负责字体/依赖样例，P4/P6 发行维护者负责匹配 SDK、正式签名与最低系统测试设备，真实外部账户由使用方提供。

## 7. 未验证项与最晚关口

| ID | 未验证/已知缺口 | 负责角色与工作包 | 影响 |
|---|---|---|---|
| O1 | Swift Foundation 都无法编译，SDK 与 compiler build 不匹配 | 原生实施者，P4-01 前 | 不能开始正式 Swift 宿主构建；无需阻塞 P1 的 Node 工作 |
| O2 | 最低 macOS 14 上的 arm64 运行、wheel 兼容 | 依赖/发行维护者，P3-01 与 P6-01/04 | 当前不能宣称支持 macOS 14；CI 的 macos-14 标签也不自动证明架构 |
| O3 | Developer ID、公证、Keychain ACL 和升级身份 | 原生/发行维护者，P2-02、P4-04、P6-02 | 临时钥匙串与 ad-hoc 包不能代替正式身份验收 |
| O4 | 屏幕捕获未授权；AX 只测了 trusted 状态 | 自动化实施者，P5-01/03 | 没有截图、点击或应用元素树执行证据 |
| O5 | 麦克风实际采集/拒绝恢复；bundle WebKit stderr 的 sandbox_extension 诊断 | 宿主实施者，P4-03/04 | 不能宣称语音可用；诊断虽未使 fixture 失败仍需定位 |
| O6 | 当前 CLI/MCP/shell 的可靠停止和 stale socket 恢复 | 运行时实施者，P1-04/01 | Mac 开放执行能力前必须解决 |
| O7 | 四个测试夹具平台问题、未执行的 448 个 e2e | 测试/对应领域实施者，P1–P6 | 不能认定全量 e2e 通过；见基线目录清单 |
| O8 | 新双平台 CI workflow 尚未远程触发 | 仓库维护者，下一次 PR/受授权 push | 本机 CI 子集已过；历史上游记录仅覆盖原产品 SHA |

P0 完成的含义是方案、风险与证据基线已可用于实施 P1，不是把以上开放项当作已解决。其验收范围与分派期限不得在后续交接中省略。

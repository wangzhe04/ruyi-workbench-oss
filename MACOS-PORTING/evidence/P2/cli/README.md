# P2-01：CLI 与平台能力贯通

2026-11-06 开始，基线 `f4fc6852`，分支 `codex/p2-macos-agent-core`。第一批实现交付为 `8393cfc0`，验证及独立评审通过。P2 与 P2-01 保持进行中，正式 CLI 和 Windows 实机验收待完成。实际人日未核算。

## 第一批范围

- Claude/Kimi 自动发现区分 Mac 与 Windows 安装位置。Finder 的最小 PATH 之外可发现 `~/.local/bin` 原生安装；保留显式启动器优先级及 Windows 原候选顺序。
- 复用统一原生工具策略，移除 Mac 上只有 Windows PowerShell 实现的 `powershell_run`、`desktop_screenshot`、`keyboard_send_keys`。Provider、MCP、按需目录和状态清单保持一致；旧名称调用明确返回不可用。
- Mac 的 `shell_run`、`shell_start`、`script_run` 参数表移除无实现的 PowerShell 语言；旧参数由现有 schema 校验拒绝。Windows/Linux 原枚举保持。
- Claude/Kimi 的中英文环境说明补 POSIX 路径、默认 bash 和常驻非 TTY 语义。桌面开关不再声称平台能力已实现或授权。Provider 编排资源示例使用 Mac 路径。
- 复用 P1 已实现的进程监督、停止、CLI 权限桥和 MCP 同步。未重新实现一套 CLI 回合逻辑。

## 验证方法

环境：macOS 27.0.1 arm64，Node 24.15.0。服务与 CLI 夹具遵守 `self-isolate-home` 隔离真实家目录及配置。

基线运行现有 CLI 登记表、适配器和恢复门单测：23 通过，0 失败，见 `baseline-unit.txt`。本批只新增一件 `macos-agent-cli-discovery.e2e.js`，用本地可执行夹具验证真实发现/启动；其余覆盖扩展现有用例或直接复跑既有回合测试。

现有 Claude 恢复用例的工作目录断言遇到 `/var` 和 `/private/var` 别名，改用双方 `realpath` 比较同一目录；继续要求新工作区生效且没有旧 `--resume`，未放宽恢复语义。

最终运行结果见 [validation.json](validation.json)，交付文件 SHA-256 见 [source-fingerprint.json](source-fingerprint.json)，文件内容已与实现提交逐项比对。

| 检查 | 最终结果 | 证据 |
|---|---|---|
| 语法与构建新鲜度 | 1121 文件语法通过；产物新鲜度通过 | syntax.txt / build-check.txt |
| 完整单元 | 2491 通过、18 跳过、0 失败 | unit.txt |
| 静态门禁 | 80 组通过、0 失败 | static.txt |
| 相关 e2e | 9 组全部退出 0 | validation.json 中各组日志 |

9 组专项为 Mac CLI 发现、能力、MCP 能力、Shell、Kimi CLI、Claude 恢复、Claude 权限桥、工具按需加载及 ACC 能力开关。`run-all.js --fast` 本身包含完整单元门禁，最终执行未在它之前重复单跑完整单元。日志中的本地夹具通过不等于真实外部 CLI 服务验收。

开发过程的失败记录保留为 `unit-first.txt`、`platform-unit-development.txt`、`discovery-development.txt`，不是最终状态。旧单测的 Windows 专用预期改用 Windows 平台视图；Mac 的缓存恢复、参数拒绝等断言按新语义分流。后台轮询、中断和 UTF-8 分块解码仍通过真实 Mac bash 执行原假件。只增加 1 件 e2e，没有新增单元测试文件。

## 独立复核

复核者为 `/root/p2_cli_audit`，记录见 [review.json](review.json)。修复目录前策略遗漏、原生/桥接检查不一致及无实现语言的 schema 广告；两个既有会话策略函数原样移至 07，避免把 12 纳入大环。最终依赖环恢复为 31 个模块、67 条前向边；复核无待修代码问题。未引入新的通用 fallback 或生产封装。

## 尚未验收

- 本机 PATH 和常见用户安装目录均没有 Claude/Kimi 启动器；真实服务的工具回合、停止/恢复仍未验收，不记为通过。
- Windows 同 SHA 实机回归未执行；P1 的 Windows 门槛例外仅适用于 P1。
- Keychain、业务端到端和机器人属于 P2-02 至 P2-04，尚未开始。正式签名身份的钥匙串升级访问还需 P4/P6 复验。

## 下一批与回退

下一批从 P2-02 的共享 `LocalSecretCrypto` 入口接入 Mac Keychain，复用凭据库和恢复链路；真实 CLI 联调就绪后补 P2-01 的待验项。

本批未迁移配置或凭据格式，也未修改真实 CLI 用户配置。回退实现提交即可恢复原候选与工具暴露策略；回退会恢复已知的 Mac 不可用工具广告问题。

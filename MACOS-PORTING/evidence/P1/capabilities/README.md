# P1 运行时能力状态接入

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交。P1 保持进行中。

## 实现范围

- `ProcessRuntime` 的同步执行 gate 与异步状态探针共用文件身份检查、协议校验和缓存。异步同身份请求共享一次探针，完成后重新核对文件身份；探测期间替换 helper 会返回 dependency_changed，避免发布旧 ready。异步查询不阻塞事件循环，同步执行入口继续保留原启动契约。
- `capabilitySnapshot()` 提供 platform、arch，以及 `process.supervisor`、`shell.exec`、`shell.session`。shell 状态同时检查系统 bash 可执行性，并标明非 TTY。其它平台保留原有执行与能力判断。
- `getCapabilities()` 的网络／桌面／binary 缓存继续使用原 TTL。每次返回额外取得当前运行时快照，包括缓存命中与共享冷探针路径，helper 删除、替换和权限变化不依赖 60 秒缓存到期。
- 原生 provider 的工具过滤与不可用提示共用 `TOOL_REQUIRES`。Mac 新执行工具和 git 工具要求监督器 ready，未知状态按不可用处理。`shell_poll`、`shell_kill` 等已有会话查询和收尾入口保留。
- 自状态工具公开运行时快照，后台 shell 的 available 同时考虑监督器与引擎状态。`computeHealth` 生成监督器检查和同一 runtime 快照，`/api/status` 复用其结果；`/api/capabilities` 通过原能力接口返回实时叠加的状态。
- 界面体检和 CLI doctor 对监督器不可用都判为 error，使用两语言文案。docs/i18n 镜像同步。

## 验证

新 `macos-capabilities.e2e.js` 最终两轮各 16 项通过。独立复核先运行 15 项版本，并补审新增 CLI 严重度断言。覆盖真实 helper、缓存撤销、缺失能力拒绝工具发现、保留停止／查询、系统提示词、自状态后台声明、体检、双语 formatter、CLI doctor、异步响应、并发复用、探测中替换与恢复。

独立 runtime 62、shell 32、git 28、cleanup 32 项通过。最终完整单测 2509 项，2491 通过、0 失败、18 跳过；静态检查 80/80，语法检查 1102 文件、0 失败。汇总与源码哈希见 `summary.json`。首次回归的失败日志保留；四个纯 schema／工具加载夹具明确提供 ready runtime，原有断言保持，locale 镜像已同步。状态 API 改为复用 health 结果后，纯凭据恢复测试继续保持原隔离边界。

## 待办

本批覆盖原生 provider 工具发现、提示词、能力／状态 API 和体检。CLI/MCP 的完整工具发现、能力弹层展示与其它平台能力 ID 仍需继续统一。浏览器实际渲染尚未人工验收，本批 UI 证据为真实 formatter 与语言目录测试。

剩余执行／裸 PID 路径、文件路径与生命周期覆盖、干净安装、Windows／macOS 14 同 SHA 和 Finder 验收继续待办。进程逃逸仍为 `observed-only`，单 helper 故障恢复边界沿用上一批记录。

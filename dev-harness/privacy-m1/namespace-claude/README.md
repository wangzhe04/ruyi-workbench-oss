# Claude 官方 HTTP 入口：有限文本基线

2026-10-21，仅开发实验，产品未接线。普通 Windows 宿主，不是独立文件命名空间、安全隔离或 M1 全链路通过。无 OS 网络强制控制，因此不能从此结果断言没有公网外发。ASR 未做。

冻结本机 Claude 2.1.202 的 11 文件程序树，复制到自有临时目录后运行；未安装、升级或分发程序。只读安装程序元数据，不读取用户 CLI 配置/凭据。子进程从白名单环境启动：Windows 必需路径、自有 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP、独立 CLAUDE_CONFIG_DIR、合成 API key、本地 ANTHROPIC_BASE_URL，以及关闭非必要流量/遥测/错误报告/更新的选项。工作目录为空，bare、空 setting sources、空 tools、strict 空 MCP、无会话持久化。未继承代理、OAuth、云厂商凭据或 preload。此处“配置隔离”是应用配置与环境隔离，不代表文件不可访问；系统级 managed policy 也不由本实验证明隔绝。

官方依据（只查公开文档，未读取/复制实现）：[CLI flags](https://code.claude.com/docs/en/cli-reference)、[环境变量](https://code.claude.com/docs/en/env-vars)、[模型网关](https://code.claude.com/docs/en/llm-gateway)。当前在线文档可能晚于冻结版本，故以实际运行单列兼容证据。bare 跳过自动发现；关闭非必要流量仍属于应用配置，不是 OS 网络防护。

实际结果：首次精确只允许 `/v1/messages`，Claude 发 `HEAD /` 和 `POST /v1/messages?beta=true`；均拒绝，exit 1、模型请求 0、助手/result 未完成。保留 `host-baseline.strict-path.evidence.json`，这份发现阶段证据没有源码 manifest，不追认其为当前源码回放。

随后入口只额外接受精确的 `/v1/messages?beta=true`，将它映射到旧 broker 固定 `/v1/messages`；HEAD 仍拒绝，不接受任意 query、重复参数、扩展路径、任意接收方或通用代理。旧 broker 和历史证据未修改。完成三次相同语义宿主基线（先增加源码 manifest，再在收紧输出/证据/退出判据后最终重放），均 exit 0、一次模型请求、真实 assistant 与 success result 含宿主专有随机 `hostonlynonce`。nonce 仅在宿主 fake provider/观察器，未传入 CLI argv/env；CLI 只收到脱敏后的合成 prompt。接收正文哈希与 broker 相等，合成原秘密未到接收端；临时目录已删除。最终重放保存在 `host-baseline.evidence.json`，较早成功运行仅控制台输出，不伪称入库。未知外发未枚举，工具/编辑/压缩/重启未测试。

入口复用 `../cli/gateway-broker.js` 中实际 PrivacyCore、固定接收方/用途/模型、文本扫描与有界响应合同，响应使用现有 fake Anthropic 适配帧。它当前依赖 `upstream` 为宿主调用方可信配置，不能把配置交给 guest。不透传任意 headers/认证。这个普通宿主监听器只绑定 loopback；后续 VM 不能把它直接改成对 LAN 开放。

重放（Windows、Node 24、冻结安装已存在）：

```powershell
node --test dev-harness/privacy-m1/namespace-claude/http-gateway.test.js
node dev-harness/privacy-m1/namespace-claude/host-baseline.js --evidence <自有输出文件>
```

有限文本 demo 已完成。后续无 NIC Hyper-V guest 需要 guest loopback HTTP → 固定 HV socket 代理 → 宿主固定 broker，另有可信身份、帧长度/并发/截止期、断连取消、进程 Job、审计与部署依赖，不能把 loopback TCP 的通过直接转成 HV socket 的通过。完整 tool loop 还需要工具结果重新投影、输出回流授权与反混淆、路径/重启/compact、多模态协议和恶意 guest 负例。新 VM、镜像许可/离线来源、资源和维护成本较高；本轮明确暂缓，不安装、不启用 Windows 功能，也不扩大系统网络策略。

证据限制：finalKillReceipt 的 root-exited 仅说明根进程已退出，temporaryDirectoryAbsent 仅说明临时目录已删除，没有独立验证所有后代均消失。合成 prompt 已在宿主预先投影，本次 broker 请求 matches=0，不能称为模型正文再次命中脱敏。

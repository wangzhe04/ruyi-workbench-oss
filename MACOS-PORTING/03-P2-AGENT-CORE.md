# P2：Agent、凭据与核心业务

状态：本地实施已收尾（2026-11-06，P2-01 至 P2-04 本地实现、离线验证及独立评审完成；真实环境验收按用户安排暂缓，P2 整体验收仍进行中） · 前置：P1 已收尾 · 基础工作量：**8–12 人日**。估算包含本阶段实现、相关测试、修复、文档与独立复核响应；共用风险容量只在总估算另加一次。

本地实施及待验收总览见 [P2 证据](evidence/P2/README.md)，恢复输入与操作步骤见 [外部验收交接](evidence/P2/acceptance/HANDOFF.md)。

用户安排（2026-11-06）：“暂不可用，先完成本地实现与离线验证”。本次按该范围收尾，见 [本地收尾审计](evidence/P2/local-closeout.json)；暂缓项保留未验收，不记为通过。

## 目标

让模型、CLI、管家和后台业务使用正确的平台能力，并提供 Mac 凭据保护。

## 入口条件

前置阶段已验收或明确仅开展不依赖其结果的探针；读取架构约定和当前基线。开始时核对源码变化，复用现有函数和测试，不根据旧行号盲改。

## 涉及文件与调用链

- [`ruyi-workbench/app/src/01f-agent-cli-types.js`](../ruyi-workbench/app/src/01f-agent-cli-types.js)
- [`ruyi-workbench/app/src/01j-local-crypto.js`](../ruyi-workbench/app/src/01j-local-crypto.js)
- [`ruyi-workbench/app/src/01k-credential-vault.js`](../ruyi-workbench/app/src/01k-credential-vault.js)
- [`ruyi-workbench/app/src/01l-credential-recovery.js`](../ruyi-workbench/app/src/01l-credential-recovery.js)
- [`ruyi-workbench/app/src/05-claude-engine.js`](../ruyi-workbench/app/src/05-claude-engine.js)
- [`ruyi-workbench/app/src/05b-kimi-bridge.js`](../ruyi-workbench/app/src/05b-kimi-bridge.js)
- [`ruyi-workbench/app/src/06b-prompt-registry.js`](../ruyi-workbench/app/src/06b-prompt-registry.js)
- [`ruyi-workbench/app/src/06i-steward-core.js`](../ruyi-workbench/app/src/06i-steward-core.js)
- [`ruyi-workbench/app/src/08-agent-runs.js`](../ruyi-workbench/app/src/08-agent-runs.js)
- [`ruyi-workbench/app/src/09-workflow.js`](../ruyi-workbench/app/src/09-workflow.js)
- [`ruyi-workbench/app/src/13s-scheduler.js`](../ruyi-workbench/app/src/13s-scheduler.js)
- [`ruyi-workbench/app/src/13y-external-bot-credentials.js`](../ruyi-workbench/app/src/13y-external-bot-credentials.js)
- [`ruyi-workbench/app/src/13ab-privacy-api.js`](../ruyi-workbench/app/src/13ab-privacy-api.js)

## 工作包与推荐顺序

同阶段工作包按下表顺序推进；已冻结接口下可分工，但共享源文件的改动需串行集成。

| ID | 工作包 | 人日 | 具体交付 |
|---|---|---:|---|
| P2-01 | CLI 与平台能力贯通 | 2–3 | 适配 Claude/Kimi 发现、启动、恢复、权限与停止；同步 MCP 清单与模型提示，移除 Mac 上的 Windows 路径要求和无实现工具。 |
| P2-02 | Keychain 保护器与恢复 | 3–4 | 实现并测试结构化 helper/Keychain 接口；替换 DPAPI 能力判断、保存/启用门、恢复路径；覆盖拒绝、锁定、数据损坏和身份变化。 |
| P2-03 | 核心业务端到端回归 | 2–3 | 验证 Provider、会话/检查点、管家、多 Agent/工作流、记忆、用量与应用内调度；定义错过任务和重启去重，修复本阶段适配造成的问题。 |
| P2-04 | 机器人与后台连接适配 | 1–2 | 贯通外部机器人本地凭据、环境变量引用、配置/重连及退出回收；网络协议用假端点验证，真实服务另记录联调状态。 |

## 阶段验收

- [ ] V05/V06/V07 通过；每种可用引擎完成一个真实工具回合与一次停止/恢复。
- [x] 新保存的受保护凭据使用 Mac 保护器；拒绝访问不返回成功、不静默写明文。验证范围为真实隔离钥匙串与拒绝 IPC，正式登录钥匙串授权仍待 V07。
- [x] 状态、交付物与检查点一致；模型不再收到错误 Windows 工具能力说明。见本地核心业务与能力证据。
- [x] 真实服务/CLI 未具备账户时明确列未验收项，相应能力不得宣称完整验证。

- [ ] 相关 Windows 回归、构建新鲜度与代码契约通过；独立复核发现均有处理记录。

- [x] TASKS.json 与执行看板已登记真实状态、提交 SHA、日志、已知限制。

## 回退与失败处理

加密格式加版本/提供者标识；不得用 Windows DPAPI 数据覆盖 Mac Keychain 记录。回滚前备份数据，旧版本不支持的新加密记录应明确拒绝读取而非清空。

## 交接要求

提交修改文件清单、平台接口/配置差异、已执行命令与结果、未验证环境、下一阶段需要消费的接口。对估算外新增需求单列工作包，不从其他阶段验收项中扣除。通用模板见 [执行与交接看板](10-TRACKING.md)，测试编号见 [验收矩阵](08-VALIDATION.md)。

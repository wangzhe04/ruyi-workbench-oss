# P2 本地实施总览

2026-11-06。P2 四个工作包均有本地实现、相关验证和独立复核；阶段保持 in_progress，真实环境验收尚未闭合。实际人日未核算，原 8–12 人日为计划估算。

| 工作包 | 本批交付及证据 | 未完成验收 |
|---|---|---|
| P2-01 CLI 与平台能力 | [CLI](cli/README.md)：Mac 发现、统一能力清单、schema 和平台提示；[真实 Kimi 增量](cli-live/README.md)验证本地模型下的真实 ACP/原生工具；[停止与恢复](kimi-lifecycle/README.md)验证同一原生会话 | Claude 真实工具回合及停止/恢复；Kimi 真实账号服务；Windows 同 SHA 实机 |
| P2-02 Keychain | [Keychain](keychain/README.md)：保护器、保存/恢复、typed 错误、隔离真实钥匙串 | 登录钥匙串首次授权/真实拒绝恢复；正式签名升级 ACL；Windows 实机 |
| P2-03 核心业务 | [核心业务](core/README.md)：Provider、会话、检查点、管家、多 Agent/工作流、记忆、用量；调度持久化恢复修复 | Windows 同 SHA；真实 CLI 依赖 P2-01；实际睡眠唤醒交 P4 |
| P2-04 机器人 | [机器人](bots/README.md)：本地 Keychain 配置整链、停止派发修复、callback/回复/重启恢复 | QQ/飞书真实服务联调；Windows 同 SHA；签名权限沿 P2-02 |

## 阶段验收核对

- V05：三类 Provider 假端点及工具回合、CLI 夹具与权限/恢复覆盖已通过；临时隔离安装真实 Kimi 0.37.2 与本地确定性模型的 96 项断言通过，包含 active prompt 停止与原生会话恢复；用户账号服务和 Claude 仍未验收。
- V06：核心业务最终 20 组 e2e 和调度专项通过；文件/检查点/交付/用量状态核对、错过任务和重启不重发见 core。不能将时钟夹具等同真实睡眠唤醒。
- V07：Mac 新保存的受保护凭据使用 Keychain，隔离域真实锁定/解锁/缺失/损坏及恢复已验证；真实系统拒绝/授权与签名升级尚未验收。没有静默明文降级。
- Windows 源码行为与模拟断言保留，不等同同 SHA Windows 实机回归。
- 每批 review.json 记录独立范围、发现和处理；validation.json 保存命令和输出；source-fingerprint.json 将交付文件绑定到实现提交。

当前系统没有常驻机器人 WebSocket，P2-04 的重连证据是 callback 重试、短请求取消和冷进程恢复。unknown 表示需要核对，不能显示为成功或自动重放。

最终 Mac 桌面壳生命周期与正式签名权限在 P4 复验；最低系统、离线包、签名公证在 P6 验收。真实环境就绪前，P2 和各工作包保持进行中，禁止把本地离线测试写成完整产品验收。

# P2-04：机器人与后台连接

2026-11-06，基线 `0af25d60`，分支 `codex/p2-macos-agent-core`。实现提交 `79d9dfbd`。本批完成本地实现与离线协议验证，真实 QQ/飞书服务及 Windows 实机仍待验，P2-04 保持进行中。

## 实现

当前产品使用 HTTP webhook 接收和短时 HTTPS 回复，没有常驻 WebSocket。连接适配复用原平台协议、凭据、配置、配对和 worker，不新增连接服务或自动重试框架。

- P2-02 的共享保护器已经贯通机器人本地凭据和环境变量引用。本批让原 external-bot-setup e2e 在 Mac 实际使用隔离 Keychain，验证管家准备、禁用配置、本地保存、签名配对、CAS 激活、控制与冷重启的完整链路。Windows 原 DPAPI 分支与 Linux 环境变量分支保留。
- worker 在领取任务并等待持久化时收到 stop，原代码返回后仍可能开始新发送。现在在原 try/finally 内检查停止，阻止派发，并复用 finally 清理新登记 actor/controller。已持久化的 running/sending 在新进程恢复为 unknown，不自动重发。
- 原 control e2e 补发送取 token 期间真实退出/重启，验证命令不重跑、reply 不重发，结果保持 unknown。现有 inbox 单元补一个 run/send 两变体的领取边界验证，没有新测试文件或生产测试钩子。

## 验证与恢复政策

环境为 macOS 27.0.1 arm64 / Node 24.15.0。服务使用隔离 HOME/AppData/RUYI_HOME；Keychain helper 编译固定到一次性钥匙串，结束后删除，不读写登录钥匙串。官方协议传输使用假端点，不使用真实机器人账号或向外发送消息。

88 条机器人相关单元和 6 组 e2e 通过：external-bot-setup、external-bots、external-bots-control、external-bot-discovery、external-channel-delivery、external-bot-gateway。语法、构建新鲜度、完整单元 2490 通过/18 跳过及 80 静态均通过。命令与最终门禁见 [validation.json](validation.json)，独立复核见 [review.json](review.json)。P2-02 的 [Keychain证据](../keychain/README.md)继续适用，不重复增加同类覆盖。

- 平台 callback 重试与新进程重启均保留消息去重，不能重复运行底层命令。
- 已登记但中断的执行/回复恢复为 unknown，需要核对。未确认的发送不自动重试，不能显示为已发送成功。
- queued/pending 在重启后按原权限检查继续；撤权会取消仍在 token 阶段的请求，已进入消息 POST 的不确定性仍保持 unknown。
- 证据支持实际冷进程重启。生产 start 位于启动、stop 位于退出；同进程 stop/start 重入不在当前承诺，P4 引入相关生命周期时再验证。

stop-red.txt 保留旧源码上的回归失败；最终 stop.txt 和 bot-unit.txt 通过。

## 待验收

真实 QQ/飞书服务、Windows 同 SHA 实机未具备；正式登录 Keychain 授权及签名升级见 P2-02/P4/P6。离线假端点与临时钥匙串结果不能替代真实账号或签名身份验收。回退本批无需数据迁移，但会恢复已确认的停止派发窗口。实际人日未核算。

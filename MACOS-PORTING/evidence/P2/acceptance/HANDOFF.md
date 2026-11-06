# P2 外部验收交接

2026-11-06。已核对本地实现、相关验证和独立复核，当前没有未处理代码发现。代码验收候选为 `0fb63eec299a223d8d0418e9c0076fb5ca85a1e7`；之后仅有证据文档更新。各批文件指纹绑定各自实现提交，详见 [P2 总览](../README.md)。环境只读核对见 [readiness.json](readiness.json)。

用户后续安排（2026-11-06）：“暂不可用，先完成本地实现与离线验证”。本地交付已收尾；下列步骤作为未来外部验收交接保留，当前不要求提供环境或重复本地测试，暂缓项未记为通过。

## 恢复输入

| 验收 | 最少需要提供 | 当前证据不能替代 |
|---|---|---|
| Claude/Kimi 真实账号服务 | 指定测试账户/服务、允许使用的版本和测试范围，在本机设置凭据即可 | 两家官方真实 CLI + 本地确定性模型的工具、权限、停止/恢复已经通过；无需重做本地协议验证 |
| 登录 Keychain | 一个明确指定的专用 Mac 标准用户账户，可由人操作该账户的 Keychain Access | 真实一次性钥匙串与假拒绝 IPC 不证明登录钥匙串的实际 ACL 交互 |
| QQ/飞书 | 指定测试机器人、仅测试用途的 owner/chat、callback 可达地址 | 现有假端点已验证协议、去重、重启、撤权与发送不确定性；不能冒充真实服务成功 |
| Windows | 包含上述候选提交的独立 Windows 检出，或该提交的 CI 运行地址/结果 | 当前 Mac 的 Windows 平台视图与 DPAPI 模拟断言不能替代实机 |

不需要把密钥、密码或 token 发到聊天。若服务账户暂时不可用，继续保留未验收说明；未经明确决定，不把验收门槛自动取消。

## 真实 CLI 账号回合

在指定的专用系统测试账户中登录官方 CLI；记录 CLI/OS/Node 版本。使用独立 `RUYI_HOME` 和空测试工作区启动如意，禁用外部 MCP 自动导入及无关后台任务。这里保留专用测试账户的 HOME，使登录凭据可用；不要把个人账户的完整 CLI 配置复制进夹具。

每家引擎做一件可核对文件内容的小任务，审批实际工具；核对工具结果、产物和检查点。对活回合使用如意停止按钮，确认 aborted 与执行释放，再续接读取此前产物，核对原生会话身份与工具上下文。保存脱敏的回执/文件摘要，不以模型最终文本代替执行证据。

`--local-model`明确使用假端点，不能用作真实账号验收。旧 live 脚本会自隔离 HOME，也不应假定它自动继承专用账户登录。真实账号回合通过指定测试账户的如意界面/已确认凭据路由执行。

## 登录 Keychain 允许/拒绝/恢复

只在指定的专用 Mac 测试账户中进行，因为保护器的系统级命名空间不随 RUYI_HOME 改变。条目 service 为 `org.ruyi.workbench.local-secrets`、account 为 `wrapping-key-v1`，显示名 `Ruyi local credential wrapping key`。

1. 使用当前 helper，在独立应用数据根保存合成凭据，冷启动后读取；核对密文持久化与实际保护器。
2. helper 设置了 `SecKeychainSetUserInteractionAllowed(false)`，不会弹出“允许/拒绝”窗口。用 Keychain Access 对本次测试条目的访问控制撤销 helper 授权，再冷启动/清除会话缓存后读取；应出现实际 permission_required/permission_denied 等错误，不能假成功、写明文或清空旧库。不要在此测试中锁定、删除或改动个人钥匙串/既有业务密钥。
3. 在系统界面恢复该测试 helper 的授权，再冷启动验证可读取原密文；保存错误码、恢复结果、helper 路径/哈希等脱敏证据。若系统版本的访问控制界面不同，记录实际 UI/OS 行为，不虚构一次不存在的授权弹窗。
4. 正式 Developer ID、升级 helper 的 ACL 和 App 宿主身份在 P4/P6 复验；当前只读查询为 0 个有效签名身份。这是后续身份交接项，不要求本批新增签名框架。

## 机器人真实服务

在本地配置入口保存测试凭据；以指定 owner/chat 完成配对/激活。发送一条测试指令，核对实际任务、一次回复和来源身份；平台重投同消息不应重复执行。再验证禁用连接、退出及重启的状态收尾。系统目前使用 webhook 与短 HTTPS 回复，没有常驻 WebSocket；已进入发送却未确认的记录保持 unknown，需要人工核对，不盲目重发。

## Windows 同候选验证

在包含候选提交的独立 Windows 检出中选择上述 SHA，使用 Node 24。以下命令串行运行，逐项保留 stdout/stderr 与退出码；失败须归因和处理，不将 Mac 结果改名为 Windows 结果。此处是交接指引，未在本机执行。

```powershell
git rev-parse HEAD
node --version
node dev-harness/syntax-gate.js
node ruyi-workbench/app/build.js --check
node dev-harness/external-bot-credentials.e2e.js
node dev-harness/run-all.js --fast
node dev-harness/kimi-agent-cli.e2e.js
node dev-harness/claude-resume-recovery.e2e.js
node dev-harness/claude-permission-bridge-mode.e2e.js
node dev-harness/scheduler.e2e.js
node dev-harness/scheduler-crash.e2e.js
node dev-harness/external-bot-setup.e2e.js
node dev-harness/external-bots-control.e2e.js
```

`run-all --fast`已包含完整单元，不在前面重复跑完整单元。现仓库 workflow 有 Windows job，但没有本候选的运行结果；不能把过去/其它 SHA 的绿灯算作本次通过。当前本地提交没有在本交接中推送远端；取得测试机/CI交付方式后再传递已复核候选。

## 关闭条件与记录

验收者提供候选 SHA、环境版本、命令/操作、退出码与通过/失败/skip、脱敏日志和独立复核处理结果。满足相关门槛后更新 TASKS/看板；正式签名和实际睡眠唤醒按已有计划交 P4/P6。P2 不在真实环境证据缺失时标记 complete，不通过重复本地测试扩大既有结论。

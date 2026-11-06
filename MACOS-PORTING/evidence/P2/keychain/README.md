# P2-02：Keychain 保护器与恢复

2026-11-06 开始，基线 `d4e99e22`，分支 `codex/p2-macos-agent-core`，本批实现提交 `6e41e060`。接入 Mac 保护器、凭据保存/恢复及机器人本地凭据；正式登录钥匙串、签名身份与 Windows 实机验收仍待完成，P2-02 保持进行中。实际人日未核算。

## 实现范围

- 保留 `LocalSecretCrypto.run(op, value, entropy)`。Windows DPAPI 函数体不变；Mac 使用用户级 Keychain 封装密钥及 Node 内建 AES-256-GCM，密文字节含 magic、版本、提供者和密钥指纹，并把这些元数据及原绑定信息纳入 AAD。
- Vault 与机器人库的外层 schema 1 不变。Mac 拒绝原始 DPAPI 密文；Windows 在调用 DPAPI 前拒绝 Mac magic。读取失败不清空旧库，也不回落明文。现有 scrypt 口令恢复包导入时使用目标系统保护器重新封装。
- 新原生 helper 只读取/创建固定 service/account 下的 32 字节密钥；解密时只读，缺失或损坏均不自动替换。一次受限 stdin/stdout 请求，无子进程、秘密参数、环境变量或临时秘密文件。Node 限制 4 个并发、输出大小及 15 秒生命周期。
- 隐私设置、管家设置和机器人保存/发现统一使用平台能力门。锁定、权限、缺失、损坏和密钥材料变化的原因经过 Vault、机器人及 API 保留；界面与启动说明按实际可恢复路径提示。
- 普通机器人列表串行读取本地凭据，避免 5–16 个连接在一次列表请求中耗尽 helper 容量。临时权限问题先恢复系统访问；全局 Keychain 密钥损坏不能靠重新填写或更换 `RUYI_HOME` 修复。

`supported()` 表示平台具备实现，不证明 helper 已安装、钥匙串已解锁或授权已经通过。缺 helper 或系统拒绝会在实际操作中明确失败。沿用现有会话主密钥缓存语义；锁定场景在清缓存/冷实例下验证。

## 开发构建与验证

从仓库根目录使用 Node 24：

```sh
node ruyi-workbench/tools/build-macos-keychain-helper.js
node ruyi-workbench/app/build.js
node dev-harness/macos-keychain.e2e.js
```

开发构建需要匹配的 macOS SDK；输出为 `ruyi-workbench/runtime/macos/ruyi-keychain-helper`。P6 离线发行应随包提供构建好的 helper，运行时不编译或联网下载。编译目标设为 macOS 14，不等于最低系统实机验收已通过。

专项通过编译宏把测试 helper 固定到一次性文件钥匙串，生产协议不接受选择钥匙串路径。夹具创建后恢复原搜索列表，退出时删除临时钥匙串；未对登录钥匙串读写凭据。原生锁定/解锁、缺失和损坏均在该真实隔离域验证。

最终结果见 [validation.json](validation.json)，交付文件指纹见 [source-fingerprint.json](source-fingerprint.json)。文件内容已与实现提交逐项核对。

| 检查 | 结果 | 证据 |
|---|---|---|
| 语法 / 构建 | 1124 文件语法通过；产物新鲜 | syntax.txt / build-check.txt |
| 完整单元 | 2489 通过、18 跳过、0 失败 | unit.txt |
| 静态 | 80 组通过、0 失败 | static.txt |
| 专项 | Keychain、原飞书发现 HTTP、原机器人设置 HTTP 三组通过 | macos-keychain.txt / external-bot-discovery.txt / external-bot-setup.txt |

`native-first.txt` 保留最初锁定错误分类及测试删除夹具失败；已修正系统错误到锁定/权限的分类，并使用夹具专用条目删除接口。`unit-first.txt` 保留镜像及 VM 依赖未同步导致的首轮失败；最终结果以上表为准。持久状态清册已从生成源同步，包含 Keychain 专用生命周期。最后只收窄了注释/清册措辞，并重验构建与清册新鲜度。

恢复预览不写应用配置/Vault，不保存导入凭据；目标系统首次使用时可能初始化随机系统封装密钥，并非没有任何系统副作用。

只新增 1 件 `macos-keychain.e2e.js`，共享隔离夹具供原有飞书 HTTP e2e 复用；现有 Windows DPAPI 单测断言保留，没有增加单元测试文件。

## 独立复核与限制

独立复核者 `/root/p2_cli_audit`，记录见 [review.json](review.json)。发现并处理：新错误未进入机器人完整替换流程、全局密钥损坏不应提供无效的完整替换、普通连接列表超出 4 进程容量。最终复核无待修代码问题；依赖环仍为 31 个模块。

以下仍未验收，不能用隔离域或假端点结果替代：

- 正式登录钥匙串中的首次访问授权、真实系统拒绝后的授权恢复。
- Developer ID、正式 helper 签名与升级 ACL 稳定性（P4/P6 复验）。专项的 `replace-key` 证明密钥材料/指纹变化，未证明签名身份迁移。
- 权限拒绝/需要授权的错误透传由假 helper 验证，没有触发真实系统授权弹窗。
- Windows 同 SHA 实机、macOS 14 最低系统和干净离线安装。
- 真实机器人服务联调及 P2-03 核心业务整体回归。

## 回退

回退前保留应用数据和系统钥匙串。旧版本不支持新 Mac 信封，不能把记录当成空库或覆盖；恢复到本批版本，或在原平台/身份导出口令恢复包，再在保护器正常的目标环境导入。系统钥匙串中的全局密钥损坏需先恢复钥匙串，或者在独立系统账户/机器使用恢复包。未迁移 Windows 原始密文。

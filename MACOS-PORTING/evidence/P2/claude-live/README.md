# P2-01 增量：真实 Claude 本地协议、权限与恢复

2026-11-06，基线 `47dca698`。实现提交 `0fb63eec`。官方 npm `@anthropic-ai/claude-code@2.1.318` 临时安装到独立目录，使用其官方 Darwin-arm64 原生程序。安装关闭生命周期脚本，因此 npm 顶层启动器仍为占位文件；本批通过显式原生路径及任务目录中的 PATH symlink 调用真正 Mach-O，而非把占位文件的 ENOEXEC 误记为产品缺陷。版本/完整性与原生指纹见 [installation.json](installation.json)。全部验证后已删除任务临时安装、缓存和自建冲突配置。没有更改用户安装或增加项目运行时依赖，也不提交第三方源码/二进制。

## 探针与修正

只扩展原 `claude-binary-live.e2e.js`，增加显式 `--local-model`，保留原账号 live 路径，不新增测试文件或生产代码。

- 复用现有 fake-anthropic-provider，环回 Anthropic Messages 端点、dummy key 与确定性 Bash 指令；CLI、原生工具、MCP 权限桥、工作台路由和会话恢复均为真实实现。
- require server 和默认 CLI 发现前移除继承的数据根、认证/云路由/代理/预加载覆盖；实际调用使用隔离 HOME/AppData/XDG/CLAUDE_CONFIG_DIR/RUYI_HOME。禁用第三方 MCP 导入与无关后台服务，保留本工作台权限桥。
- Mac 发现可能返回 PATH 裸名，不能用 existsSync('claude') 判断已安装与否；本地模式由真实 version/协议结果判定。原 Windows live 对未解析 cmd 的直接 SKIP 保留。
- 新增一个隔离服务启动点，fixture-home 清册从225同步至226，未放宽隔离断言。

## 实测链路

绝对 Mach-O 路径与仅 PATH 两种入口都 ALL PASS，各6项通过、0失败、0skip、5次环回请求。PATH复验同时注入任务自建的冲突 config 根和 Bedrock/Vertex/Foundry 环境开关；原冲突配置未变，探针仍只运行本地确定性端点。

1. 真 CLI `--version` 与 stream-json init/result 握手成功。
2. 真实 Bash 经过生产 MCP permission-prompt-tool 桥审批，tool_result 返回真实进程 PID；不把最终文本当作工具执行。
3. 同一原生会话续接后，模型请求保留相互关联的结构化 Bash tool_use/tool_result 和真实 PID，meta.args 包含 --resume；读取活态 execution 后按身份调用 stop。
4. 回合 aborted，执行释放、模型连接关闭、assistant source=aborted 落盘。
5. 停止后再次 --resume，同一个 native ID 与原生工具上下文保留，正常完成新回合，无 resume_recovery。

语法、构建新鲜度和对应隔离静态检查通过，独立复核记录见 [review.json](review.json)。完整命令/退出码见 [validation.json](validation.json)。生产树未变化，完整单元和其余静态门禁复用 `8ebb6638` 的2490通过/18skip与80静态证据；本批只复跑变更直接相关的检查，未重复完整单元。

## 限制

验证的是实际 CLI、权限桥、active prompt停止及原生恢复，模型服务为本地假端点，未使用真实账号。停止时没有运行长Bash子进程，不能外推其子孙回收。Windows同SHA实机、正式登录Keychain授权/拒绝与签名、QQ/飞书真实服务仍待验，P2保持进行中。

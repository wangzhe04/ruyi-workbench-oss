# P2-01 增量：真实 Kimi ACP 与 Mac 路径

2026-11-06，基线 `aa9d57c0`。实现提交 `8ebb6638`。此前只检查 PATH/常见目录未发现正式 CLI，本批把 README 指定的官方 npm `@moonshot-ai/kimi-code@0.37.2` 临时安装到任务隔离目录，复用现有 `kimi-acp-live-probe.js`。安装使用独立 npm prefix/cache/HOME、关闭生命周期脚本，没有新增仓库运行时依赖，也不提交第三方源码。包版本、完整性和 main 指纹见 [installation.json](installation.json)。

## 实际失败与修复

原实现真实探针 73 通过、11 失败，日志见 kimi-protocol-red.txt；没有将失败或模型最终文字算作成功。

- 标准 POSIX 全局 npm 的 bin/kimi 指向 prefix/lib/node_modules 包入口，原 resolver 只认识 Windows/local 布局，导致既有 ACP 兼容 loader 未挂载，真实 Glob/Grep 被上游 interactive Bash 限制拒绝。新增该标准布局，并要求启动器和包入口的 realpath 一致，不能让相邻残留包替换原生/uv 启动器。
- Mac 的 /var 与 /private/var，以及普通目录链接，可令原生 Write 批准的词法路径与 host fs 守卫的真实路径不一致，出现第二次审批。使用既有 realpathForContainment 在展示/保存批准前统一路径；同步 consume 的 tier、toolCallId、settled、once/session 和歧义条件原样保留，实际写入仍走最终文件守卫。
- probe 的 mkdtemp 根和清理临时根同时规范化，避免其词法 containment 把系统别名误判为逃逸；没有放宽 containment。

仅修改 8 行生产源码，扩展原 Kimi e2e 的 POSIX global symlink、相邻 native 启动器和不存在文件的别名批准消费；没有新增测试文件。

## 最终验证

真实 Kimi 0.37.2 的握手、读、写、进入计划、已有计划、计划内搜索、acceptEdits 七场景全部通过：84 pass / 0 fail / 0 skip，本地确定性模型收到 25 个请求。工具结果与实际文件/审批往返均被断言；不是把模型答复当文件成功。

模型为环回假端点，CLI、ACP、原生 Glob/Grep/Read/Write/Bash、计划与提问均为真实安装实现；全程隔离家目录和 Kimi 配置，不使用用户凭据或真实服务。原 Kimi e2e、Mac 发现、registry/adapters 专项、语法及构建新鲜度通过；完整单元 2490 通过/18 跳过，80 静态通过。最终相关回归及工程门禁见 [validation.json](validation.json)，独立评审见 [review.json](review.json)。

本批不证明真实账号服务、实际停止/恢复、Claude CLI、正式 Keychain 授权或 Windows 实机验收。临时安装不加入离线发行包，P2-01 与 P2 继续进行中。

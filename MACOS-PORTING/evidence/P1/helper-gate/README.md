# P1 原生进程 helper 运行时能力门

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树未提交。P1-01/03/04 保持进行中。

## 行为

- 原生 helper 新增 `--capabilities`，读取自身 libproc 身份后报告协议版本、监督、私有 FD、身份清理与 `observed-only` 覆盖范围。执行入口增加版本号，旧版二进制无法将新入口误当成普通监督请求。原有原生入口保留，供既有清理与监督夹具使用。
- `ProcessRuntime.helperCapability()` 返回冻结快照，区分 supported、installed、authorization、ready、reasonCode。可执行文件存在、权限允许、探针成功、协议与所需能力匹配后才能 ready。
- 探针最长 1 秒、输出最多 4096 字节。正向结果缓存最长 1 秒，每次使用先核对路径、设备、inode、大小、修改时间、变更时间和权限。文件替换、移除、撤销执行权限立即失效，spawn 错误、协议错误和不完整退出也清除缓存。探针在同步启动 API 中执行，失败时可能阻塞该次调用至超时上限。
- Mac 受管执行缺少或不兼容 helper 时在目标启动前拒绝。新执行禁止降级成无监督子进程。已经运行的旧 raw ChildProcess 仍可通过既有停止路径执行直接子进程兜底，结果继续标记不完整。
- 一次性 bash 与 shell 会话预检共用该快照。DesktopShell 将 gate 错误转换为失败结果，保留数值退出码 `-1`，增加 errorCode 与 capability。已存在的 `shell:true`／自定义 shell 调用先转成显式 shell 参数，再交由 supervisor 执行，沿用 Node 的命令拼接语义。

## 验证与复核

- 原生源码通过 clang `-Wall -Wextra -Werror` 编译，`--capabilities` 实际探针成功。
- 完整单测 2509 项，2491 通过、0 失败、18 跳过。80 项静态检查通过。语法检查 1101 文件、0 失败。
- runtime E2E 增加缺失、版本不匹配、缺少能力、非法报告、替换恢复、执行权限撤销与恢复、删除、探针超时、结构化错误与 shell option 监督。保留原身份、取消、孤儿、FD 隔离和退出语义断言。
- 独立复核检查正常入口的返回契约，并重跑 runtime、shell、git 和清理。具体数量、日志和源码哈希见 `summary.json`，发现与修复见 `review.json`。
- 首轮 git 假 helper 缺少新探针协议，首轮 cleanup 夹具仍期待缺 helper 时启动新进程。失败日志保留。git 假件已补协议，输出管道失败断言增加具体原因校验；cleanup 改为验证已经运行的 raw child 应急停止。原“不完整清理不得报告全树终止”的正常入口断言迁至 runtime 故障夹具。

## 剩余范围

当前快照服务于受管执行与 shell 预检。统一工具发现、提示词、体检和界面能力目录仍须接入。helper 运行期间遭强制终止的后代处置与能力撤销组合仍需专门验收，当前不完整结果不能证明后代全部停止。剩余直接执行和裸 PID 路径、干净安装、macOS 14、Windows 同 SHA 和实际 Finder 验证继续待办。

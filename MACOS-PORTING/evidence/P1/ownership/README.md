# P1-01 启动所有权与崩溃恢复

执行日期为 2026-11-02。本批接续 2026-10-31 的启动/Finder 实现，基线提交为 `0a430880`，交付 SHA 待提交。测试环境为 macOS 27.0.1 / arm64、Node 24.15.0。

## 实现

Mac 启动先取得 `/private/tmp/ruyi-serve-v1-<uid>/<root-hash>.lock` 的内核文件锁。目录权限要求为 0700，锁文件要求为当前用户拥有、单硬链接、组和其他用户无访问权限的普通文件。打开文件使用 `O_NOFOLLOW | O_NONBLOCK`，随后校验路径和描述符身份。

系统 `/usr/bin/lockf -s -t 0 3` 对继承的文件描述符加 BSD flock。辅助命令退出后，Node 保持同一个打开文件描述符，因此锁持续到显式释放或进程实际退出，包括 SIGKILL。锁文件保持同一 inode，存在性本身不代表锁被持有。实测两个描述符竞争分别返回 0 和 75，关闭持有者后再次获取返回 0。

锁目录及 `/tmp` 别名已纳入文件工具双向拒绝范围，APFS Data 卷路径别名也受保护，工作区宽写与 bypass 模式遵守该边界。rg 搜索同时排除这组目录。

Mac 路径通过 `/bin/pwd -P` 取得物理目录拼写，并核验 bigint device/inode 身份，统一 APFS Data 卷别名。旧异步 realpath 算法的 socket 名也继续保留，以协调同输入路径的旧版本。

首次创建数据根时，同用户启动 gate 覆盖递归 mkdir 的完整阶段。所有 Mac 启动均先进入该 gate，有界排队上限为 2 秒。已有数据目录在取得正式锁后释放 gate，缺失目录在启动完成并复核最终身份后释放。超时明确拒绝并提示稍后重试。

固定路径使同一数据根在不同 TMPDIR 下仍然互斥，也避开超长 TMPDIR 的 Unix socket 路径限制。Windows 命名管道和 Linux 抽象 socket 沿用原分支。

为协调旧版服务，Mac 在旧 socket 路径不超过 103 字节时同时保留旧端点。新版本按数据根和端点分别记录 canonical root、PID、端点、device、inode 和 birth time，切换 TMPDIR 时保留各端点的恢复依据。持有内核锁的后继实例，仅在以下条件全部满足时清理残留端点并重新绑定。

1. 元数据是当前用户的受限普通文件，实际读取大小不超过 4 KiB，schema 和数据根匹配。
2. 目标是当前用户的 socket，路径及文件身份与记录相同。
3. 记录 PID 已明确不存在，连接探测返回 ECONNREFUSED。
4. 删除前再次核对文件身份。

复用 PID 仍然存活、连接成功、探测超时、权限错误、记录缺失或损坏、文件身份不匹配时均保留现场并拒绝启动。锁文件和 socket 恢复记录已登记到 durable-state inventory 的专用启动协议豁免项，读取应用配置前即可完成互斥。

## 验证

| 项目 | 结果与证据 |
|---|---|
| 所有权单测 | 14/14，含锁文件符号链接/硬链接、未知 socket、损坏记录、存活 socket、跨 TMPDIR 和文件工具禁区，见 [review-unit.txt](review-unit.txt) |
| 真实服务所有权 e2e | 20 条断言连续两次通过，见 [第一次](review-e2e-final-1.txt)和 [第二次](review-e2e-final-2.txt) |
| Mac 启动/Finder 回归 | 24 条断言通过，见 [start-regression.txt](review-start-regression.txt) |
| 静态 e2e 全集 | 80/80，见 [报告](review-static/report.json) |
| 语法、构建新鲜度、依赖契约 | 通过，见 [gates.txt](review-gates.txt) |
| 全量单测 | 2,503 tests 中 2,480 pass、3 fail、20 skip，失败项与 P0 一致，见 [review-unit-full.txt](review-unit-full.txt) |

真实服务测试覆盖崩溃后重启、待决事项恢复、并发启动只有一个持有者、MCP 合法共用数据根、退出回调仍在写数据时拒绝接管、超长 TMPDIR，以及旧版或复用 PID 存活时保守拒绝。所有测试均隔离用户家目录、AppData 和数据根。

## 独立复核

用户授权后，独立 agent `/root/ownership_review` 完成只读代码检查及自建夹具复测，4 项发现均已关闭。包括 FIFO 同步打开阻塞、读取期间增长绕过大小上限、Data 卷别名绕过锁目录保护，以及既有数据根身份归一与首次目录创建竞争。详情和审查产物哈希见 [review.json](review.json)，FIFO/增长旧产物反向验证见 [review-counterfactual.txt](review-counterfactual.txt)。

复核者撤回了关于旧异步 realpath 对既存目录大小写不能归一的推断，保留了实际复现的 Data 卷别名和缺失尾部问题。最终独立验证为 14 项单测通过、构建新鲜度通过、lockf 描述符及三组漏洞探针通过。

一轮 e2e 曾与故意持有启动 gate 的旧测试夹具并行，触发 2 秒排队超时。已将非缺失根单测预建目录，真正创建竞争由专门测试覆盖，最终 e2e 按项目规范串行执行。

## 人工恢复与剩余关口

旧版本遗留的 socket 可能缺少新恢复记录。新版本在绑定 socket 后、保存恢复记录前被强制终止，也可能留下缺少完整证据的端点。这些情况会返回 `DATA_ROOT_OWNER_UNKNOWN`，错误中列出具体路径。

人工处理时，先确认报错路径对应预期数据根，再核对该数据根的 `runtime.json`、恢复记录及系统进程/打开文件信息。在相关版本全部停止、维护期间暂停并发启动后，清理已经核验归属的残留 socket，再重新启动。如归属仍不明确，继续保留现场。持久 `.lock` 文件应保留，删除它可能使两个进程锁住不同 inode。

`lockf` 的文件描述符模式已在本机验证，macOS 14 的实际系统版本仍待验证。系统工具缺失或失败会拒绝启动。固定命名空间按用户 UID 隔离，跨用户共享同一数据目录的并发使用仍在首发单用户范围之外。

本批启动所有权独立复核已完成。Windows 真机、macOS 14、大小写敏感卷，以及启动/Finder 首批的独立复核继续待办，P1-01 保持 `in_progress`。P1-04 的进程树治理为下一项重点。P0 已记录的孙进程回收、路径夹具及 stdout 截断失败继续保留到对应修复。

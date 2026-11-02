# P1-02 Mac 文件与系统路径策略

2026-11-02，macOS 27.0.1 arm64、Node 24.15.0。基线 `0a430880`，工作树尚未提交。P1-02 保持进行中。

## 实现与决定

- 系统写保护覆盖 `/System`、`/bin`、`/sbin`、`/dev`、`/usr` 的系统部分、`/etc` 及其物理别名。`/var` 的系统内容受保护，临时目录下的普通文件继续按工作区权限判断。结构根目录自身受保护。
- `/Applications`、`/Library`、`/usr/local`、`/opt/homebrew` 被定义为受管位置，文件工具即使处于 bypass 档也返回 `managed-location-denied`。维护这类目录需要经过执行工具的显式授权。
- APFS Data 路径仅在最近已有对象身份吻合后映射为逻辑路径。工作区包含判断通过真实设备、inode 与 birthtime 身份处理别名。缺失尾部只有在真实目录查找证明卷不区分 ASCII 大小写后才折叠大小写。大小写替代路径若为符号链接，不构成该证明。
- 工作区权限根、候选目录和配置清洗保留 POSIX 路径大小写，Windows 继续使用原大小写合并行为。真实 case-sensitive APFS 夹具验证两个不同目录的权限和配置独立保存。
- Mac 的 `withFileToolWriteLock` 写族工具共用一条写链，防止大小写、Data 或硬链接别名在原子替换期间丢失并发修改。不同文件的这些写操作也会串行。其它直接写入和外部进程仍在该锁的覆盖范围之外。
- `file_move` 的目标父目录创建进入已有检查点回滚区，mkdir 失败会清除本次幻影记录。检查点夹具使用精确目标、仅一次的 rename 故障注入，并验证重试与只读目录失败后的源文件和日志。
- 无法解析且错误并非 ENOENT/ENOTDIR 的路径按失败关闭处理。

## 验证

- 新文件策略 E2E 实现者与独立 reviewer 各运行一轮，每轮 32 项通过。覆盖 Unicode、空格、emoji、字面星号、真实 APFS 大小写卷、系统路径与符号链接、只读目录、配置去重及并发别名编辑。
- 独立 reviewer 串行运行文件边界 56 项、检查点 45 项，全部通过。系统路径用例仅调用 guard，未写入系统目录。测试用磁盘映像已卸载并清理。
- 四个单测夹具补充平台依赖，Windows 黄金断言继续在模块局部 win32 facade 上逐项核对，原断言保留。Mac 配置行为由真实卷 E2E 覆盖。相关专项 9 项通过，独立补审通过。
- 语法检查 1101 文件、0 失败。完整单测 2509 项，2491 通过、0 失败、18 跳过；静态检查 80/80。日志见 `unit-final.txt` 与 `fast-final.txt`，汇总及源码哈希见 `summary.json`。
- `unit-first.txt`、`fast-first.txt` 保留首次夹具失败记录。大小写别名编辑的修前复现见 `concurrent-edit-before.txt`，修复后的两轮见 `e2e-1.txt` 与 `reviewer-macos-file-policy.txt`。

## 剩余验收

Windows 真机与 macOS 14 同 SHA 验证尚未执行。POSIX 路径全链路、剩余原子写回退与完整 P1 交叉验收继续待办。P1 还需统一 helper 能力与版本失效门、剩余执行入口审计、干净安装及实际 Finder 验证。进程逃逸治理仍为 `observed-only`。

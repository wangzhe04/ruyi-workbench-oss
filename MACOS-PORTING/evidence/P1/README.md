# P1 首批实施记录

执行日期为 2026-10-31。基线提交为 `0a430880`，交付处于工作树，提交 SHA 待登记。环境为 macOS 27.0.1 / arm64、Node 24.15.0。实际人日未核算，P1 原有 8–12 人日估算继续使用。

2026-11-02 续批已实现 Mac 内核锁及有证据的 socket 恢复，见 [最新记录](ownership/README.md)。本页保留 2026-10-31 首批范围与测试快照。

## 本批范围

按工作包推荐顺序，先实施 P1-01 的启动入口、依赖候选定位和 Finder 链路。P1 与 P1-01 均登记为 `in_progress`。

- 新增 `app/src/00-platform-runtime.js`，集中处理 Mac 启动 PATH 和系统打开参数。模块排在 boot 前，依赖 Node 内建模块，处于现有依赖环之外。
- 新增可执行入口 `ruyi-workbench/start-macos.command`。Node 定位顺序为显式 `RUYI_NODE_PATH`、随包运行时、用户 `.local/bin`、Homebrew、`/usr/local/bin`、已有 PATH。检查 Node 最低版本后启动 `serve --open`，支持传入 `--port`。
- Mac 服务启动补齐当前 Node 所在目录和固定系统/Homebrew 路径，既有 rg 探针使用补齐后的 PATH。启动过程不读取用户 shell profile。
- Node 随包候选使用 `runtime/node/bin/node`，Python 候选支持 `runtime/python/bin/python3` 和 POSIX venv。Python 依赖完整性继续由既有导入探针判断，ACC 的跨平台依赖拆分归 P3。
- `--open`、`/api/file/reveal`、`/api/open-path` 接入 `/usr/bin/open` 参数数组。文件定位使用 `-R`，参数边界使用 `--`。Finder 路径先解析 realpath，应用 bundle 和脚本降级为定位。HTTP 文件打开保留 token、工作区、敏感数据与符号链接护栏，Mac 打开失败返回失败。
- 重建 `server.js`、manifest、依赖图、路由清单和 facts。新增 e2e 后同步夹具/进程清理数量锁及中英文 README 的测试数量。

在仓库根目录可运行以下命令，或双击 `.command` 文件。

```sh
./ruyi-workbench/start-macos.command
```

自定义 Node 安装可通过 `RUYI_NODE_PATH` 指定绝对可执行路径。数据根继续使用既有配置解析规则。

## 验证

| 检查 | 结果与证据 |
|---|---|
| 新 Mac 运行时 e2e | 24 条断言连续两次通过，见 [第一次](runtime-final-1.txt)和 [第二次](runtime-final-2.txt) |
| 静态 e2e 全集 | 80/80，通过明细见 [报告](static-final/report.json) |
| 语法、构建新鲜度、依赖契约 | 通过，见 [日志](gates-final.txt)。另执行 `/bin/sh -n ruyi-workbench/start-macos.command`，退出码 0 |
| 端口审计与 HTTP 输入专项单测 | 25/25，见 [日志](targeted-unit.txt) |
| 全量单测 | 2,493 tests 中 2,470 pass、3 fail、20 skip，失败项与 P0 一致，见 [日志](unit-final-source.txt) |

新 e2e 运行真实服务、入口脚本和 HTTP 路由，使用隔离 HOME、AppData、数据根和短临时目录。操作系统打开程序由测试替身承接，验证 argv、退出码、ENOENT、鉴权和路径拒绝。Finder/默认浏览器真实界面、Windows 真机和 macOS 14 仍待验证。

单测中 P0 已记录的三个失败继续归后续工作包处理，包括 `git-tool-shape` 的孙进程回收、`script-run-cleanup` 的 `/var` 与 `/private/var` 路径夹具，以及 `steward-inbox-tick-cost` 的 stdout 截断。完整阶段验收要求关闭这些失败。

## 检查发现及处理

| 发现 | 处理与复测 |
|---|---|
| 初版共享打开函数让 Mac 原生工具提前进入系统关联打开路径 | 收敛到本批定义的启动和 Finder API 范围，既有原生工具回归专项通过 |
| 新模块从 boot 反向引用并读取 boot 的 path 导致循环边 | 平台模块前置并局部加载内建 path，依赖图确认两个提供符号、零出边 |
| 依赖图 tokenizer 将首行 hashbang 识别成正则，遗漏平台函数 | 修复首行 hashbang 跳过规则，增加等价声明扫描断言，重建并验证契约 |
| 固定目录打开可能经别名指向应用 bundle | 打开前解析 realpath，新增 bundle 别名降级测试 |
| 新测试的固定端口字面量与现有夹具撞号 | 纯参数测试移除端口，真实服务使用动态空闲端口，端口审计通过 |
| 新增 e2e 使测试数量及 fixture-home/process-safety 锁过期 | 更新实际数量并保留原守卫，80 个静态件复测通过 |

以上为实施者检查及自动化验证记录。项目要求的独立 agent 代码复核仍待安排，P1-01 保持进行中。

## 后续交接

1. P1-01 继续实现异常退出后的 socket 所有权恢复、专属短路径和并发接管测试，并验证干净机器的依赖缺失及随包布局。
2. 按计划先推进 P1-04 的自有进程登记、Mac 子孙回收及测试清理器，再开展 P1-03 大量 shell 执行和取消验收。
3. P1-02 已实现 Mac 系统路径策略、卷大小写隔离和失败回滚，见 [文件策略记录](files/README.md)。剩余路径覆盖与跨平台验收继续推进。
4. Windows 真机回归、Finder 界面验证及独立复核完成后，再评估工作包验收状态。

回退范围为本批源码、入口及生成物。新增数据迁移项为零，回退前先停止本批启动的服务。P2 的 Agent、凭据和 CLI 接入，P3 的原生工具能力适配继续按各自阶段推进。

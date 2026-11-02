# P1-04 进程身份与观察子树清理基础

执行日期为 2026-11-02，环境为 macOS 27.0.1 / arm64、Node 24.15.0。P1-04 保持 `in_progress`，本页记录统一生命周期登记前的基础实现。基线为 `0a430880`，交付 SHA 待提交。

## 实现范围

- 新增 `resources/macos-process-helper.c`，通过公开 libproc API 获取 PID、父 PID 和微秒级创建时间，输出以 `RUYI-PROCESS-V1` 标识的有界进程表。
- 终止请求仅接受调用者的直接子进程作为根，核对调用者身份和父子创建顺序。快照遍历按 PID 与创建身份去重，每次发信号前再次核验。冻结父进程后收集后代，按逆序终止已观察到的身份。
- 中断或失败时，仅恢复本 helper 停止的进程。预先被用户或调试器停止的进程保留其状态。原生测试还覆盖同 PID 不同创建身份的去重和陈旧身份拒绝发信号。
- Mac 测试清理器及产品 `killChildTree` 已使用该 helper。CLI、MCP、shell、toolbox、git 的现有停止调用优先传入真实 `ChildProcess`；helper 不可用时可安全终止该直接子进程，并报告后代清理不完整。
- `DesktopShell.runProcess`、git 和 MCP 超时/取消结果增加 `cleanupScope`、`cleanupIncomplete`。Mac 当前范围为 `observed-tree`，缺依赖时为 `direct-child`，结果文案与该范围一致。
- runtime/macos 写保护覆盖 APFS Data 卷别名、目录符号链接、helper 文件符号链接和硬链接真实目标。普通同名工作区文件仍可写入。

开发机先执行以下命令构建本机架构 helper。

```sh
node ruyi-workbench/tools/build-macos-process-helper.js
```

产物位于 `ruyi-workbench/runtime/macos/ruyi-process-helper`，由已有 runtime 忽略规则管理。构建使用系统 clang/SDK，声明最低部署目标 macOS 14。实际最低版本运行、发行包随附、正式签名与离线安装仍须在对应关口验证。Mac CI 基线工作流已增加构建步骤，远程运行待触发。

## 当前验证

| 检查 | 结果与证据 |
|---|---|
| Native cleanup e2e | 独立复核 25 条断言通过，最终重复执行见 [第一轮](e2e-1.txt)和 [第二轮](e2e-2.txt) |
| 测试清理器单测 | 5/5，包括新增启用的 Mac 普通/脱离进程组后代用例，见 [前序结果](../process-cleaner-unit.txt) |
| Native TU | 以 `-Wall -Wextra -Werror` 编译，4 项状态恢复和身份检查通过，随 native e2e 执行 |
| git/MCP/停止专项单测 | 33/33，通过日志见 [tools-unit.txt](tools-unit.txt) |
| 全量单测 | 2507 项，2489 通过、0 失败、18 跳过，见 [最终单测日志](unit-final.txt)。unit-full.txt 保留此前夹具失败记录 |
| 静态回归 | 80/80 通过，快速检查退出码 0，残留测试浏览器 0，见 [最终日志](fast-final.txt) |

P0 的 `git-tool-shape G8` 孙进程继续存活缺陷已在本机复测通过。真实父、子、脱离进程组孙子被停止后，心跳停止且进程表最终无这些 PID；同级无关进程保持存活。缺 helper 的取消测试确认直接子进程停止写入，并返回清理不完整。

## 独立复核

`/root/ownership_review` 只读复核并独立复测了本批基础实现。已处理 5 项发现，分别是运行时真实目标写保护绕过、缺 helper 取消失效及虚假回收文案、错误恢复原本已停止的进程、仅按 PID 去重的跨快照遗漏，以及失败测试的清理缺口。原生 e2e、cleaner 单测、native TU、构建新鲜度和针对性探针均通过。结构化记录见 [review.json](review.json)。

## P1-04 剩余要求

1. 在启动时登记不透明 handle、创建身份及会话/运行/工具 owner，统一 CLI/MCP/shell/toolbox 的启动与停止接口。
2. 完成父进程自然先退出后的子孙治理、进程组生命周期和服务退出/重启清理。当前 helper 的根身份在停止时读取，尚不能代替启动时登记。
3. 对未被快照观察到的逃逸过程给出准确状态，停止结果应验证实际退出和未确认清理数量。
4. 将 helper 的安装/运行状态纳入能力与依赖门，完成缺依赖和中途失效的组合验收。
5. 完成相关 Windows 回归、macOS 14 和同 SHA 跨平台证据，再完成整包独立复核。

完整 P1 还包括 P1-02 文件与系统路径策略、P1-03 一次性与常驻 shell，以及 P1-01 剩余启动验收。以上项目继续保留在任务清单中。

## 回归夹具修正

`script-run-cleanup` 通过父目录 dev/ino 比较识别 macOS 临时目录别名。`steward-inbox-tick-cost` 等待 stdout 写入回调后退出，子进程采用隔离家目录并设置超时。原有断言含义保留，专项 11/11 通过。独立 agent 已静态确认最后一处 EBUSY 子进程隔离修正，随后全量快速检查通过。

## 退出确认与启动入口增量

原生 helper 在发送信号后逐个核验已观察身份，以退出、僵尸状态或身份替换确认旧进程停止。扫描使用单调时钟，逐身份检查 500ms 预算与中断，未核验部分计入 `unconfirmed`。输出区分 `terminated`、`alreadyExited`、`unconfirmed`，产品与测试清理器校验协议总数、整数范围及信号分类关系，拒绝缺失、矛盾和全零报告。

独立复核另发现固定目录入口可接受脚本型会话 cwd。入口现解析真实路径并要求目录，脚本及其符号链接均返回 404 且不调用 opener。启动 e2e 两轮 26/26 通过，见 [第一轮](startup-review-e2e-1.txt)和[第二轮](startup-review-e2e-2.txt)。独立 agent 完成启动 26/26、清理 32/32 及最终全零报告的双消费者 stub 复验，已关闭本轮发现。

最终增量清理回归与快速检查记录于 `exit-confirmation-*` 日志，统计在 `summary.json`。原 `fast-final.txt` 和 `unit-final.txt` 保留基础实现通过时的快照。本轮仍仅确认停止时已观察到的身份，完整生命周期要求继续保留。

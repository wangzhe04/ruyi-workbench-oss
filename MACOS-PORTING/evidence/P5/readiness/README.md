# 实际能力状态与嵌套工具策略

测试实现 `229a9021f2ae96e493b9a10c99ea1d50ea22b619` 已提交，冻结 v5 独立 **40 项通过**，0 fail/skip/retry。仅新增回归及测试清册/README/生成元数据，产品和运行时源码没有变化。P5 仍为 `in_progress`。[独立报告](independent-v1/report.json) · [提交绑定](commit-binding.json) · [独立提交绑定](independent-commit-binding.json)。

| 实际场景 | 已验证行为 |
|---|---|
| 正向基线 | 自有 Cocoa 蓝区完成一次计数可观测的 balanced down/up（0/40000μs），实际 controlled source 录制并保存 schema 1；普通 default 会话回放同一记录，计数 0→1→2，输入中性。后续拒绝均保持 2。 |
| 缺少 helper | Node 与 ACC 均使用真实不存在的 helper 路径；Workbench `desktop.capture`、ACC capture/input/record/AX 状态不可用，相应工具从目录撤下；普通会话宏返回 `dependency_missing`，无接收输入或 input/focus 派发审计。没有假造拒权状态。 |
| 注册表隐藏 | 新实际 ACC worker 以 `ACC_HIDE_TOOLS=input_sequence` 启动；诊断及目录确认已移除该工具而 macro 仍可用。从本 worker 重新绑定窗口目标后，已保存录制回放返回 `tool_unavailable`，batch 返回 unknown/non-batchable；接收计数与审计确认没有派发 sequence。 |
| 桌面/命令总闸 | Node 路径由目录过滤及普通 provider 调度闸门返回 `tool-disabled`，当前桥接 ACC 原始 registry 保持不变；命令关闭时桌面只读仍可用。另读取实际产品生成的 CLI MCP 配置，确认 exact hidden 名单。此处未运行实际 CLI，也不声称 Node 总闸自动改写该 registry。 |

各场景使用独立家目录/AppData/data 和短 Git 外 TMPDIR；五个服务串行启动与收尾，独立运行记录 61 个采样出生身份无残留，服务完整清理收据、receiver 退出和原输入源恢复通过。采样不覆盖所有瞬时进程，夹具的自有树收据另列。未做剪贴板快照或恢复断言，测试也没有请求剪贴板写入。保存录制与完整生成配置在正常清理中删除，保留的是运行时实际读取的 recording 对象、保存字节 hash、CLI 路径/hidden 名单和执行断言，不能声称完整原文件仍在归档。

[工程门](development/engineering-v1/results.json)通过：语法 1154、构建新鲜度、单元 2499 通过/18 既有跳过、静态 80/80（7 项集中实弹跳过，0 flaky）。`run-all --fast` 自带单元前置，因此单元门实际再次执行。14 份冻结来源与默认 helper `1cc945…`、工作树 process helper 在各门前后八次校验无漂移。[独立验收](independent-v1/report.json)将完整工程按 hash 复用，没有重复 unit/fast；40 项真实场景独立各运行一次，14 来源与两份产物前后、严格签名和额外 30 项已审依赖不变。

源码审查与开发历史分别保留：

- [v1 审查](code-review-v1.json)：区分 Node 策略与 CLI 注册表配置；baseline focus/start/sequence/collection 每步失败即停止。两项源码发现均在运行前修正。
- [首轮真实运行](development/live-v1.txt)：20 PASS、2 FAIL（失败断言及停止异常），hidden macro 被旧服务的窗口 ref 以 `target_stale` 拒绝，尚未测到期望的 hidden-tool 拒绝，后两个 master-off 没有执行；无输入派发，清理/源恢复通过。这是测试跨会话绑定问题，不是产品缺陷。
- [v2 审查](code-review-v2.json)：v4 归档源码新增当前 hidden worker 的真实 `list_windows` 目标绑定，保存宏及 batch 均使用新目标；其他 13 来源不变。v4 未运行。
- [v3 审查](code-review-v3.json)：v5 将纯 move 改为相同自有蓝区 balanced click，并用精确 down/up 增量证实误派发可被观察。此前纯 move 的接收计数为空，未扩充为压力手势或真人示范。
- [最终主执行](development/live-v2.txt)：40 PASS；这是修订夹具后的新完整开发运行，必须在新隔离 receiver 中重新录制，不称开发全过程零重跑。独立最终运行另列。

实际 TCC 撤权/恢复与拒权 readiness、动作中系统锁屏、真实捕获中的布局变化、工作台硬杀后的审计/清理，以及原物理多屏/non-Retina、macOS14、Windows 同候选和正式身份仍各自待验。此切片没有锁屏、撤销权限、重新授权、启动/重签如意 App 或新做其 LaunchServices 验收。

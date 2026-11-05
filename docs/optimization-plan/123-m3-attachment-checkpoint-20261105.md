# 123 · 附件批次后的全量检查点（2026-11-05）

附件链路（01af→01ag→01ah→01ai→01aj→01ak→01al→01ab→01ad→13ak）在这一批接完并跑通真实 NTFS
OFF→ON→OFF 之后，做一次全量检查点。本片**无产品代码改动**，只记录检查结果与负载相关的 flaky 证据。

## 静态门（本机实跑，全部 PASS）

- `facts.static.e2e.js`：ALL PASS（629 e2e / 454 unit / 121 原生工具）
- `module-dependency-graph.static.e2e.js`：ALL PASS（140 modules / 934 edges）
- `durable-state-inventory.static.e2e.js`：ALL PASS
- `encrypted-storage-freeze.static.e2e.js`：ALL PASS（80 面 / 47 required）
- `route-inventory.static.e2e.js`：ALL PASS（198 判定点）

## 全量 unit 的负载型 flaky（未改代码）

同一台机器连续跑三次 `node --test "dev-harness/unit/*.test.js"`，每次只有 1 条失败且**三次各不相同**：

| 轮次 | 失败用例 | 单独重跑 |
|---|---|---|
| 1 | `file-search-redos` 的 ReDoS 预算断言 | 2/2 PASS（1.0s） |
| 2 | 同类时序断言（未记名） | — |
| 3 | `provider-turn-failure-surface` 的 `[T11] 用户停止不是失败` | 全文件 PASS（21s） |

三次都是并发满载下的时间/预算断言，单文件跑均通过；与本次附件改动无关。
最近一次「满载无失败」的全量读数是 85a2c4fb 时的 **194 suites / 5046 tests / 5020 pass / 26 skip / 0 fail**。
发布前应在空闲机器（无并发代理）重跑全量，不把本机负载读数当基线。

## 当前附件完成度

已完成：分块格式、密封读取、catalog、写入器、持久化、运行时门面、迁移 owner（双向）、快照识别、
迁移主机接入（enable 封存 / disable 解封）、**真实 NTFS 冷操作 OFF→ON→OFF 通过**（262s）。

未完成：运行时上传/下载路由接线（启用后新上传仍是原始字节）、工具图片路径、adapter `pending → wired`，
以及 M3 其它面（非空 special、owner delta、retention、完整索引组合）。

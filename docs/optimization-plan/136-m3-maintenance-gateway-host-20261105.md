# 136 · 维护网关的 host 依赖（2026-11-05）

在 135 之后继续深挖：发现父进程不该自己拼 claim/go，而应使用生产网关
`WorkDataMaintenanceWorker.create(host).start(request)`（`13ai:88`）。但 `create(host)` 需要一整套 host：
`base()`、`pid`、`listener()`、`env`、`spawn`（spawnCold 的 spec）、`claim`（13av 的 inspect/write/remove）、
`stopUncommitted`、`uploads`、`exitParent()`。这些在桌面/维护运行时（`13am:283-290`）由真实进程提供，
测试进程直接调用会 `host.base is not a function`。夹具已删除，无产品改动。

## 事实

- 网关内部顺序（`13ai:88-105`）：校验 request → 组 stdin input（含 48-hex id、64-hex nonce）→
  生成 childEnv（过滤 SECRET_ENV）→ `host.spawn(env)` → 等 ready → 写 armed claim → 发 go → 等 ready/armed/exit。
- 因此「父进程协议」不是手写三步，而是**实例化网关**；缺 host 依赖时没有任何降级路径（`requireClaim` 直接拒绝）。
- 现成可用的等价验收：128 号 e2e 已用**冷操作宿主**（同一套模块、真实 DPAPI/NTFS）完成 enable 并把 serve 起到
  加密代上，跑通上传/下载/Range。区别只在于它不走私有进程网关。

## 结论与下一步

1. **不**在 OSS 测试里复刻桌面网关的 spawn/claim/exitParent 装配；那是桌面宿主职责，复刻出来就是测桩不是产品。
2. ① 启用流程剩下的可交付项是**桌面/UI 触发点**：在桌面端把「启用」按钮接到 `work-data-maintenance`
   （或让 serve 显示“请在桌面端启用”）；这需要桌面工程范围，超出当前仓库可验证边界。
3. 恢复包导出/导入同理：走同一网关，等桌面接线后复用 128 的验收形态。
4. 若继续在本仓库推进，优先做 ② 非空 special 与 ③ 精确 owner delta —— 它们不依赖桌面宿主。

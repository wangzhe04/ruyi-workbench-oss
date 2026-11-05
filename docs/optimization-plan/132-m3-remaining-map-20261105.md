# 132 · M3 剩余块地图（2026-11-05）

本片不改产品代码，只把「3.1 还剩哪几块」钉成可执行清单：每块写清**当前事实、进入点、完成判据**。
这样后续回合按块推进，不再反复在同一夹具上打转。

## 已完成（本分支已验收，不再重开）

- 附件链路：01af/01ag/01ah/01ai/01aj/01ak/01al + 迁移主机双向 + 快照识别；真实 NTFS OFF→ON→OFF（262s）；
  启用代 HTTP 上传/下载/Range（75s）；`uploads-attachment` wired。
- 索引组合：三个 fulltext 面 wired，运行时密封证据 `fulltext-runtime-encrypted`。
- 清册现状：80 面 / **47 required** / 33 excluded / **46 wired**；唯一 required-pending 是 `uploads-tool-image`。

## 剩余块（按依赖排序）

### ① 启用流程接线（首次迁移 / 反向迁移 / 恢复包 / 启用 UI）

- 事实：`serve` 模式**故意没有**维护 worker（`capabilities.worker=false`）；作业接口返回 501。
  但私有命令已存在：`app/server.js work-data-maintenance`（冷）与 `work-data-successor`（暖，经
  `13am` 的 `startSuccessorMaintenance`）。桌面/UI 若要启用，必须 spawn 这两个命令之一，而不是在 serve 进程内跑。
- 进入点：`14-main.js:154-168`（命令分派）、`13am-work-data-maintenance-runtime.js:290/414/466`（workerHooks.start 与
  warm/cold 约束）、`13ah-work-data-setup.js:51/106`（作业提交）、`13au` 的 install/inspect（`worker:false` 是**装配契约**，
  不是待修 bug）。
- 完成判据：UI 能触发一次 enable（spawn 维护进程）→ 作业状态可见 → 重启进加密代；反向同样可走；
  恢复包导出/导入走同一通道。需要 HTTP+子进程夹具，不以模块级替代。

### ② 非空 special（skill-backups）

- 事实：`13u:4908 createBackupOwner` 存在；普通全量快照对未接专用 owner 的稳定控制文件**明确拒绝**。
- 完成判据：非空 `skill-backups` 的 prepare/publish/cancel 往返 + 普通快照可携带 + 真实 NTFS。

### ③ 精确 owner delta

- 事实：现有 owner 回执按粗粒度记录；`92` 提到维护屏障等待“精确 owner 回执”。
- 完成判据：写链能报告逐 owner 的增量（谁在写、写到哪里、何时释放），并在屏障收口时核对；需要新的可观察证据。

### ④ retention sealed-fault

- 事实：目前没有实现；验收语义是「密封态下 retention 路径遇到故障时，不删除、不误判完成」。
- 完成判据：故障注入（半删/不可解密/目录缺失）下 retention 拒绝推进并留下可核对状态。

### ⑤ 完整索引组合（收尾）

- 剩余：`uploads-tool-image` 的真实 HTTP 证据（测试进程拿不到加密代密钥：`api.workDataKeys` 绑定原 base，
  报 `work_data_key.absent`）。已按管家口径记为待办，不再连续投入。
- 完成判据：启用代里写入一张真实工具图 → 显示 → 会话删除退掉；或提供按活动根构造 keys 的测试入口。

## 每回合的交付格式

答复开头写「3.1 还剩哪几块、本回合推进了哪块」，并在提交信息里只声明本片证据；未跑的门不写“通过”。

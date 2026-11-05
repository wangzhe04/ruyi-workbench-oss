# 135 · 冷维护命令的 go/claim 协议（2026-11-05）

尝试用真实 `app/server.js work-data-maintenance` 跑一次 enable。**输入校验已通过**，但卡在更深的握手：
worker 在等父进程的 IPC `{command:'go'}` 与已持久化的 `armed` claim，缺这两步就返回
`work_data_setup.worker_failed`（cause 被包在错误对象里，stderr 只显示外层码）。夹具已删除，无产品改动。

## 已核实（下一步直接用）

- 冷进程 stdin 输入键集**精确**为：
  `base,expectedAuthority,id,nonce,operation,parentPid,password,paths,schema,serve`
  （restore 另有 `upload`）。
- 约束（`13ai:49-74`）：`id` 必须 **48 hex**；`nonce` 必须 **64 hex**；`password` 12–1024 字符；
  `expectedAuthority` 键集 `generation,id,mode,sha256`；`paths` 键集 `backupDirectory,targetDirectory,uploadFile,uploadSha256`，
  备份目录不得与 base 互相包含；`serve` 为 `{host,port}`。
- 通过校验后（`13ai:300-331`）：
  1. worker 先读 stdin、等待父进程 IPC `{command:'go'}`；
  2. 若该操作需要 claim（enable/disable/export/restore），父进程必须**先持久化 `armed` claim**，
     worker 会 `claims.inspect` 并要求 `phase==='armed'` 且内容一致；
  3. 通过后 worker `send({kind:'armed'})` → `waitParentExit(parentPid)`（父进程必须真的退出）→
     取所有权 → 读 authority 比对 → `host.execute(...)`。
- 也就是说：**父进程不是“发完 stdin 就等结果”**，而是「写 claim → 发 go → 主动退出」的三步协议；
  我们的夹具只做了第一步，所以 worker 报 `worker_failed`。

## 下一步

1. 复用 `13av` 的 claim 写入口（或经 `WorkDataMaintenanceControl`）在父进程持久化 `armed`；
2. 通过 `child.send({schema:1,command:'go'})` 发 go；
3. 父进程退出（或用子进程 `detached` + 显式退出），等 successor 起在 `serve.port`；
4. 再把这条路径接进桌面/UI 的启用按钮与恢复包导出/导入。

## 当前证据边界

- 已有：畸形 successor 握手拒绝面（134，6 项 PASS）；
- 未有：任何一次**成功**的冷维护 enable/disable/export/restore；不声称启用流程已接通。

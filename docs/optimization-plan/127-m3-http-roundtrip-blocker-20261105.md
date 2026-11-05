# 127 · 启用代 HTTP 往返：第一次夹具尝试与阻塞点（2026-11-05）

为验证「启用态上传/下载 + Range」的真实 HTTP 链路，我写了一个 e2e：起服务 → `/api/work-data/status` →
`POST /api/work-data/jobs {operation:'enable'}` → 轮询作业 → 再上传/下载/区间读。**在第二步就停了**：
服务端的作业接口返回 501 `work_data_setup.worker_unavailable`。本片没有产品代码改动，只记录阻塞点。

## 实测

- `GET /api/work-data/status` 正常返回：`authority {generation:0,id:null,mode:'plain',sha256:null}`、
  `selectedBase`、`capabilities {worker:false, upload:true, download:false}`、`processRestartRequired:true`。
- `POST /api/work-data/jobs`（enable，带 password/expectedAuthority/backupDirectory）→ **501**
  `work_data_setup.worker_unavailable`。
- 结论：`serve` 模式默认没有维护 worker，enable/disable/export/restore 作业都跑不了；
  `capabilities.worker:false` 是服务端自报的同一事实。

## 为什么冷操作能过

`work-data-cold-operations.e2e.js` 是直接调用冷操作宿主（同一进程内构造 host 与 keys），不经过作业接口；
所以它能造出加密代，但没有 HTTP 层。两条路都缺一半。

## 下一步（三选一，按代价排序）

1. **复用冷路径再起服务**：在 e2e 里先用冷操作宿主完成 enable（照抄冷 e2e 的前半段），再用同一数据根
   起 `serve`，然后做 HTTP 上传/下载。最接近真实用户路径，但要处理两次进程与 root 选择。
2. **让 e2e 起 worker**：查清维护 worker 的启动条件（`serve` 的哪个开关/环境变量会创建它），
   再走作业接口；成功后这个夹具可复用到 export/restore。
3. 暂时接受「模块级 + OFF e2e + 冷 e2e」的组合证据，等 M6 安装/升级链路时再补 HTTP 正向。

## 当前证据边界（不变）

- 已覆盖：模块级密封读写与区间（4 个单测文件）、OFF 真实 HTTP Range（13 项）、真实 NTFS 冷操作
  OFF→ON→OFF（262s）。
- 未覆盖：启用代上的 HTTP 上传/下载正向用例。**不据此声称运行时附件链路已验收。**

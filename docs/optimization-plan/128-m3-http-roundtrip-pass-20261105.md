# 128 · 启用代 HTTP 往返通过（2026-11-05）

127 的阻塞点绕过去了：新 e2e 先用冷操作宿主把数据根 enable，释放所有权，再用同一数据根起真实服务，
在**加密代**上做上传/下载/区间读。`attachment-http-roundtrip.e2e.js` **ALL PASS**。版本仍 **3.0.1**。

## 夹具路径

1. 临时 root：`data/`（含 `sessions/sess_http.json`、`uploads/file_.../seed.bin`）+ 隔离 home + 备份目录；
2. 用 `dev-harness/lib/server-internals` 载入冷操作模块，`ServerOwnership.acquire` 后执行
   `WorkDataColdOperations.execute({operation:'enable'})`；
3. 发布成功后 `flushWorkbenchLogs` + `owner.release()`；
4. 用同一 `data/` 起 `app/server.js serve`，`POST /api/bootstrap` 拿 token；
5. 在加密代上 `POST /api/upload` → `GET /api/upload/content`（整读 / `bytes=5-10` / 越界）。

## 断言（7 项全 PASS）

- 冷 enable 发布加密代；服务在加密代上启动并拿到 token；
- 上传返回 `sealed: true` 的记录（走 `13ax` hook + `01ak`）；
- 整读字节与原文一致；`bytes=5-10` → **206** 且内容精确；
- 越界 `bytes=999-` → **416** + `bytes */22`；
- **递归扫描活动代 `uploads/` 全部文件不含上传明文**。

## 验证

- 该 e2e 单独跑 **75 秒 ALL PASS**（Windows、真实 DPAPI/NTFS）；
- 生成物：`facts` 630 e2e / 455 unit，README 同步；`build` 114977 行不变（本片只加 e2e）。

## 现在的附件证据链

模块级（01af/01ag/01ah/01ai/01aj/01ak/01al 单测）→ OFF 真实 HTTP Range（13 项）→
真实 NTFS 冷操作 OFF→ON→OFF（262s）→ **启用代 HTTP 上传/下载/Range（本片）**。
剩下：工具图片 face 接线、adapter `pending → wired`。

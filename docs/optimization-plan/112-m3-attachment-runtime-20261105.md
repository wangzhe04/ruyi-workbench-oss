# 112 · M3 附件运行时门面（2026-11-05）

本片新增 `01ak-work-data-attachment-runtime.js`：把 01aj（catalog 持久化）、01ai（封存写入）、01ag（读取）
按**同一个数据根**组合成一个门面，并统一 `id → opaque/revision` 的派生规则 —— 上传路径与下载路径以后必须用同一套
派生，否则写进去的目录读不回来。仍然没有 HTTP 路由接线。版本仍 **3.0.1**。

## 合同

- `create({root, keys, enabled, generation = 1})`：三个依赖都是注入；`enabled()` 在**每次操作前**都会检查，
  为假时任何入口都拒绝（`work_data_attachment_runtime.disabled`，来自 01aj），不会退化成明文；
  即使门面已经成功打开过，开关关闭后也立即失效。
- `opaqueFor(id) = sha256('attachment-opaque:' + id)[0..32]`：与 id 绑定且稳定，便于上传/下载两侧独立推导。
- `revisionFor(data) = sha256(data)[0..32]`：内容派生，重复上传同一内容会落到同一位置（catalog 仍按 id 拒绝重复）。
- `seal({id, kind, logicalName, mime, data})` → `{id, opaque, revision, totalBytes, sha256}`；
  `read(id, start, end)` → 范围租约；`verify(id)` → 整件校验；`has(id)` → 只认 `sealed` 行。
- 门面内部懒加载并复用 catalog/store/reader 实例；同一 root 的并发写仍由 01aj 的 `root+face` 串行链兜住。

## 验证

- 新增 `dev-harness/unit/work-data-attachment-runtime.test.js`：**3/3 pass**
  - 派生值可复算；封存 270 KiB → `has` 为真 → `verifyWhole` 通过 → 跨 256 KiB 边界范围读精确；
    换一个新门面重新打开仍可读（走磁盘，不是内存缓存）。
  - 关闭开关后（含“已成功打开过”的情况）`seal`/`has`/`read` 一律 `disabled`；`revisionFor(undefined)` 与
    非法 id 走 typed 错误而不是原生 TypeError。
  - 未知 id：`has=false`、`read` 报 `id_missing|not_sealed`；重复封存同一 id 报 `id_exists`。
- 本切片涉及的 5 个附件单元文件合计 **20/20**（catalog 6 + 组合 3 + 写入器 4 + 持久化 4 + 运行时 3）；
  `01af`/`01ag` 自身单测不在本片重跑范围。
- 失败封存留下的 `pending/uncertain` 行没有门面级清理入口：该 id 会持续 `id_exists`，需要显式治理（下一步）。
- 生成物：`build` 114592 行；`module-dependency-graph --check` 139 modules / 930 edges；
  `facts` 453 unit / 628 e2e，两份 README 同步；`facts.static` ALL PASS。

## 边界与下一步

- 门面没有 HTTP 语义（没有 Range 解析、没有 206/416、没有路由鉴权），也没有删除权限与迁移 codec。
- 下一步：上传路由 ON 模式调用 `seal` 并返回附件元数据；下载路由用 `has/read` 实现 Range/206/416；
  工具图片共用同一门面（face 走 toolImage）；随后补迁移 codec 两族与真实 NTFS 验收，最后改 adapter 状态。

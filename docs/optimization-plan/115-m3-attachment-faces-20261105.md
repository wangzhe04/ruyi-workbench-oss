# 115 · 附件门面支持工具图片 face（2026-11-05）

`01ak` 之前只开 `attachment` 面（`session/sessions`）。本片把 face 变成参数，支持 `toolImage`
（`cache/index-cache`），两个面共用同一套派生/seal/read/has/discard，但各自独立的 catalog 文件与 purpose。
版本仍 **3.0.1**，仍无 HTTP 或迁移接线。

## 合同

- `create({root, keys, enabled, generation, face='attachment'})`；`face` 只接受 `attachment` 与 `toolImage`，
  其他值在创建时就拒绝（`work_data_attachment_runtime.face`）。face 规格从 01aj 的 `spec(face)` 取，
  不再复制第二份映射。
- `open()` 按 face 取对应 catalog（`_catalog-attachments-v1.json` / `_catalog-tool-images-v1.json`），
  写入器用该面的 purpose/scopeId；读取器复用同一 authority。
- `opaqueFor(id)` 按 **face + id** 派生（`sha256('attachment-opaque:<face>:<id>')`），所以同一个 id 在两个面
  得到不同目录，不会互相 `EEXIST`/误删；两个面的 catalog、目录、读取互不相通。

## 验证

- `work-data-attachment-runtime.test.js` 扩到 **7/7 pass**：新增 toolImage 面封存/读取/隔离、同 id 跨面独立目录、
  非法 face 拒绝。
- 附件六个单元文件合计 **24/24**。
- 生成物：`build` 114643 行；`module-dependency-graph --check` 139 modules / 930 edges；facts 453 unit / 629 e2e 不变。

## 下一步

- 用两个 face 实现迁移侧 uploads 特殊所有者的目录级封存/解封（`uploads/<id>/<name>` → attachment 面，
  `uploads/toolimg_*/<name>` → toolImage 面），再挂到冷操作 e2e。

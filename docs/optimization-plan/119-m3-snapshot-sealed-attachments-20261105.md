# 119 · 全量快照识别 sealed 附件（2026-11-05）

新增 `01ab` 的 `sealedAttachment(logical)`：把 `uploads/` 下两类已封存产物识别为**不透明认证字节**，
不再按用户 JSON 解析，也不触发 `special_owner_required`。这样加密代里出现 sealed uploads 时，私有全量导出
与恢复不再直接拒绝。版本仍 **3.0.1**。

## 识别的路径

- `uploads/_catalog-attachments-v1.json`、`uploads/_catalog-tool-images-v1.json`（两个面的 chunked catalog）；
- `uploads/<32hex opaque>/<32hex revision>/manifest.json`；
- `uploads/<32hex opaque>/<32hex revision>/part-\d{6}.json`。

## 行为

- 这些文件在 `analyze` 里跳过 JSON/`workData` 标记探测与用户内容解析，按 `opaque-byte-file` 记录
  （`logicalSha256 = sha256(file.data)`），**字节级进入导出包**；
- 恢复时原样写回；不新增 keyRefs、不解密、不改写；
- 其它 `uploads/` 下未知文件仍走原逻辑（非法 JSON/含 workData 标记 → `special_owner_required`）。

## 验证

- `work-data-full-snapshot.test.js` 新增 1 条：构造 manifest/part/catalog 三个带 `workData` 标记的文件
  （旧逻辑会因其内容被拒），断言导出的 snapshot 保留原字节、恢复后逐字节相同。
- 该文件 **20/20 pass**。
- 生成物：`build` 114814 行。

## 边界

- 这是“把 sealed 附件当成不透明字节搬运”，不是认证：包内完整性仍由恢复包的密码学封装保证；
  真正的附件内容认证仍由 01af/01ag 在启用态读取时完成。
- `13ak` 的覆盖率闭键集与生产组合接线仍未改；下一步继续。

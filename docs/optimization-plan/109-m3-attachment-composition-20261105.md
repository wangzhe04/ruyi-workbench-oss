# 109 · M3 附件三件套真实组合验证（2026-11-05）

本片把 104（分块格式）、108（catalog authority）与已提交的密封读取器放进**同一个真实组合**里跑通：
临时目录 + 合成密钥 + 真实文件 IO，验证整件读、范围读、篡改拒绝、目录 census 与撤权。仍然没有接线产品调用方。
版本仍 **3.0.1**，M3 未完成、未发布。

## 组合方式

```
01af.createWriter → manifest.json + part-000000.json（写进 <root>/<opaque>/<revision>/）
01ah.create(begin/seal) → catalog 行（内存 store，状态 sealed）
01ag.create({root, keys, authority:catalog}) → readRange / verifyWhole
```

- 密钥：合成 32 字节 + `instanceId`，`keys.snapshot()` 返回副本；reader 内部用 `01p.acquireSnapshot` 取租约。
- binding 与 reader 一致：`purpose=session`、`scopeId=sessions`、`recordId=attachment:<id>`、`seq=0`、`generation=1`。
- 覆盖：300 KiB + 4 字节的两块文件；整件读、**跨 256 KiB 块边界**的范围读、`verifyWhole`、篡改一个分块、
  catalog 删行撤权、目录里多出文件。

## 结果

- 新增 `dev-harness/unit/work-data-attachment-composition.test.js`：**3/3 pass**。
  - 整读字节与原文一致、sha256 与 manifest 一致；范围读跨 256 KiB 块边界仍精确。
  - 篡改分块 → `work_data_blob.physical`；catalog 删行后读取 → `id_missing`（撤权在读侧表现为目录条目消失，
    不是返回旧内容）；删除前签发的 ticket 在 `assert` 上返回 `false`；多出的 `part-999999.json` → `namespace`。
- 生成物：`facts` 450 unit / 628 e2e，两份 README 已同步；`facts.static` ALL PASS。

## 边界

- 仍是单元层真实 IO：不等于真实 NTFS 的 ADS/安全描述符/长路径验收，也不覆盖上传路由、OCR/转写、迁移。
- catalog 的 `assert` 本地语义在这里被验证为「删除行后旧 ticket 不再通过」；跨进程改动仍由 reader 的
  AAD/revision 校验兜住。
- adapter 仍是 `pending`：没有任何产品路径写入或读取 sealed 附件。

## 下一步

1. 上传路由与工具图片读路径接入 reader（含新增 Range/206/416），OCR/转写/压缩走 `verifyWhole`。
2. 迁移 codec 两族（OFF 原件 → ON 封存目录，及反向），再补真实 NTFS 杀进程/半态/清理验收。
3. 全过后把两面的 adapter 从 `pending` 改 `wired`，再继续非空 special、owner delta、retention、索引组合。

# 110 · M3 附件封存写入器草稿（2026-11-05）

本片新增 `01ai-work-data-attachment-store.js`：把 01af 分块、01ah catalog 与真实文件 IO 串成一个**封存写入器**。
仍然没有 HTTP 路由、没有密钥创建、没有删除权限 —— 上传路由、工具图片、迁移 codec 都还没接它。版本仍 **3.0.1**。

## 合同

- `create({root, keys, catalog, purpose, scopeId, generation})`：全部依赖注入；`keys.snapshot()` 每次调用取一次租约，
  结束后释放一次。
- `seal({id, opaque, revision, metadata, data})`：
  1. `catalog.begin` 写 `pending` 行（失败则不落任何文件）；
  2. `mkdir <root>/<opaque>/<revision>`，用 `01af` writer 逐块写 `part-NNNNNN.json`（`flag: 'wx'`，写入后立即清零密文副本）；
  3. 写 `manifest.json`（同样 `wx`），`catalog.seal` 记录 manifest 哈希与字节数；
  4. 任一步失败 → `catalog.uncertain(id)`，目录**不删除、不改写**，读侧永远拿不到半成品；
     若 `uncertain` 自身也失败，行会停在 `pending`（模块没有删除权限，需要显式清理），主错误仍原样抛出。
- dispose 失败不再被静默吞掉：有主错误时转成 `cleanupFailed/keyClearUnproven` sticky 证据；无主错误时直接抛出。
- 没有删除/覆盖能力；重复 id 由 catalog 的 `id_exists` 拒绝，已封存的旧副本保持可读。

## 验证

- 新增 `dev-harness/unit/work-data-attachment-store.test.js`：**4/4 pass**
  - 封存 300 KiB → 01ag 整读字节一致、`verifyWhole` 通过、catalog 行为 `sealed`、租约只释放一次；
  - 预先占用 `manifest.json` 模拟写失败 → 行变 `uncertain`，reader 报 `not_sealed`（不会读到半成品）；
  - 非法 key snapshot（16 字节）→ `keys` 拒绝，租约仍释放一次，且不落 catalog 行；
  - 同一 id 再封存 → `id_exists`，原副本仍可读。
- 与 109 的组合测试一起跑：**13/13 pass**（catalog 6 + 组合 3 + 写入器 4）。
- 生成物：`build` 114486 行；`module-dependency-graph --check` 137 modules / 924 edges；
  `facts` 451 unit / 628 e2e，两份 README 同步；`facts.static` ALL PASS。

## 边界与下一步

- 仍是隔离草稿：没有上传路由、没有 Range 下载、没有工具图片接线、没有迁移 codec、没有真实 NTFS 验收。
- 下一步：上传路由在 ON 模式调用本写入器并保留 OFF 原字节；下载路由接 01ag（Range/206/416）；
  然后迁移 codec 两族 + OFF↔ON 往返 + 真实 NTFS 杀进程/半态清理；全过后才改 adapter `pending → wired`。

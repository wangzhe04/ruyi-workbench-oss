# 114 · 附件失败清理入口（2026-11-05）

本片给 `01ak` 门面加一个显式的 `discard(id)`：只允许清理**未封存**（pending/uncertain）的失败残留，
封存成功的副本永远不能从这个入口删除。仍然没有 HTTP 路由接线。版本仍 **3.0.1**。

## 合同

- `discard(id)`：
  - 行不存在 → `{discarded:false}`（幂等，可重复调用）；
  - 行是 `sealed` → 拒绝（`work_data_attachment_runtime.sealed`），不删任何字节；
  - 行是 `pending/uncertain` → 删除 `<root>/<opaque>/<revision>/` 目录后移除 catalog 行，返回 `{discarded:true}`。
- 目录路径由 `opaqueFor(id)` + 行里的 `revision` 重新推导，再做一次 `path.relative` 包含校验；
  任何越界（`..`、绝对路径、root 自身）直接拒绝。**词法校验之后还会逐段 `lstat` + `realpath` 比对**
  （root / opaque / revision 三段），junction 或符号链接指向根外时拒绝。
- `discard` 和其他入口一样先过 `gate()`：开关关闭时不可用。
- 已知中间态：`rm` 成功而 `catalog.remove` 失败时，目录已删、行仍在（再调用可自愈；同 id 重传会撞 `id_exists`）。
- 已知并发边界：`discard` 的文件删除不在 catalog 串行链内；与 `seal` 并发或两个 `discard` 并发时，后者可能看到
  `id_missing`。当前没有调用方，接线时需把状态迁移并入链路。

## 验证

- `dev-harness/unit/work-data-attachment-runtime.test.js` 扩到 **5/5 pass**：
  - 预先占用 `manifest.json` 制造封存失败 → 行变 `uncertain` → `discard` 删除目录与行 → 再 `discard` 幂等返回 false；
  - 已封存附件 `discard` 报 `sealed`，`has` 仍为真；
  - 未知 id 返回 `{discarded:false}`。
- 附件五个单测文件合计 **22/22**（catalog 6 + 组合 3 + 写入器 4 + 持久化 4 + 运行时 5）。
- 生成物：`build` 114641 行；`module-dependency-graph --check` 139 modules / 930 edges；facts 453 unit / 629 e2e 不变。

## 边界与下一步

- 这只是“失败残留”的清理，不是会话删除/用户删除语义；删除封存副本仍需 107 的显式删除设计。
- 下一步：把 `discard` 接到上传失败路径（同一请求内回滚），再进入迁移侧 uploads 特殊所有者。

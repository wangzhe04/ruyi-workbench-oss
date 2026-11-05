# 118 · 迁移主机接入 uploads owner（草稿）2026-11-05

按 116 的路线，给 `01ad` 加了一个可选的 `uploadsOwnerFactory`：在候选代里把原样复制的 `uploads/` 交给
uploads owner 重新封存，并把 owner 产出的文件/目录重新登记回 target census。默认不启用（不传该选项时行为
与原来完全一致）；仍未接真实 `01al`，也没有动 13ak/01ab。版本仍 3.0.1。

## 做了什么

- `create({..., uploadsOwnerFactory})`：可选函数，非函数直接 `host_invalid`。
- `prepare` 在「raw 复制 + 目录创建」之后：
  1. 以候选代的 `uploads/` 为根调用 `uploadsOwnerFactory({root, keys})`，要求返回带 `sealAll` 的 owner；
  2. 运行 `sealAll()`（真实 owner 会把 raw 目录换成 sealed 目录 + catalog）；
  3. 清空 `targetHashes/targetDirectories` 中所有 `uploads/` 前缀项，再遍历候选侧 `uploads/` 重新登记
     每个文件（含哈希）与目录。
- 这样 target census 仍能证明整个候选代，`prepare/publish/verifyPublished` 不需要新的证明字段。
- 源根 `uploads/` 不动：沿用「旧根与备份保留、开启加密不擦除旧明文」的既有口径，因此不触碰 13ak 的
  specialCoverage 与 skill-backups 的 proof 键集。

## 验证

- `work-data-migration-host.test.js` 新增 1 条：假 owner 把候选侧 raw 目录替换成 `_catalog-*` 与
  `<opaque>/<revision>/manifest.json`，断言候选侧 raw 目录消失、catalog 存在、源根原件保留、
  `publish` 与 `verifyPublished` 均通过。
- 该文件 32/32 pass（含原有 31 条）。
- 生成物：`build` 114803 行。

## 边界（下一步）

- 真实 `01al` 还没接：它需要 keys 与两个 face 的 runtime；当前用假 owner 验证的是主机集成点，不是真实封存。
- `13ak` 的闭键集与 `01ab` 的导出/恢复识别仍按 116 的前置 2/3/5 待改；在这些完成前，即使接上真实 owner，
  整体导出加密代也会因为不认识 sealed uploads 而拒绝。
- 失败语义沿用 116 §5：候选侧半态保留，旧根明文仍在；调用方判失败并清理。

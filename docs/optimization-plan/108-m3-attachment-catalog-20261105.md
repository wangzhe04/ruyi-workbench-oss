# 108 · M3 附件 catalog authority 草稿（2026-11-05）

本片按 107 的设计新增隔离草稿模块 `01ah-work-data-attachment-catalog.js`：给 `01ag` 读取器提供
`capture / describe / assert` 三件套，并维护 `pending / sealed / uncertain` 状态机。**没有接线任何调用方**：
上传路由、工具图片、迁移 codec 都尚未使用它，adapter 仍是 `pending`。版本仍 **3.0.1**。

## 合同

- 每个面一个 catalog 文件（107 决定）：`uploads/_catalog-attachments-v1.json`（purpose `session`、
  scopeId `sessions`）与 `uploads/_catalog-tool-images-v1.json`（purpose `cache`、scopeId `index-cache`）。
  实际路径由调用方传入的 sealed `store` 决定，本模块不碰文件系统。
- 行：`{id, opaque, revision, kind, logicalName, mime, generation, state, manifestSha256, manifestBytes, recordId}`，
  字段集精确匹配；`opaque/revision` 为小写 32-hex，`recordId` 必须等于 `attachment:<id>`。
- `pending/uncertain` 行 **不授权读取**；`sealed` 行必须带 64-hex manifest 哈希与 1..2MiB 的字节数
  （上界取 `01af` 的 `MAX_CARRIER`，超过会被 catalog 接受却无法被 reader 读取，故在上游拒绝）。
- `capture(id)` 异步读表，返回一次性 ticket（放进 WeakMap）；`describe(ticket,id)` 同步返回 `01ag` 需要的
  **精确 8 字段** descriptor；`assert(ticket,id)` 同步。
- `assert` 是**本地权威视图**：本实例的任何写入会递增该 id 的 epoch，旧 ticket 立即失效。
  跨进程改动同步检查不到 —— 由 reader 的 AAD/revision 校验兜住（读失败而不是读到旧内容）。
- 写入串行化通过注入的 `serialize`（缺省直通），避免读-改-写丢失更新。

## 验证

- `node --test dev-harness/unit/work-data-attachment-catalog.test.js`：**6/6 pass**，覆盖
  descriptor 形状、pending/uncertain 拒读、克隆/换 id/删除/重封存 ticket 失效、非法行与 proof、
  manifest 超过载体上限、scopeId 字符集、串行链与坏表。
- `build.js`：114426 行，产物新鲜；`module-dependency-graph --check`：136 modules / 923 edges；
  `facts`：449 unit / 628 e2e 与实测一致；两份 README 的 136 模块 / 449 suite 已同步。

## 边界与下一步

- 本模块没有文件系统、没有密钥创建、没有迁移或消费者；`01ag.create({root,keys,authority})` 的真实组合
  仍未接线。
- 下一步：用本 catalog + `01af/01ag` 做一个**真实组合的单元测试**（临时目录 + 合成密钥），再把上传路由与
  工具图片的读路径接进 `01ag`，最后做迁移 codec 与真实 NTFS 验收；通过后才把 adapter 从 `pending` 改 `wired`。

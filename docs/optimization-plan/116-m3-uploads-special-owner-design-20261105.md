# 116 · M3 迁移侧附件特殊所有者设计（2026-11-05）

本片只出设计，不改产品代码。要解决的问题：`uploads/` 不能用逐文件 codec 迁移（封存后目录结构变了、还要写
catalog），必须作为**目录级特殊所有者**参与迁移；而 `01ad` 目前只支持一个写死的 special owner
（`skill-backups`）。本稿按首轮设计评审的实测结论修订。版本仍 **3.0.1**。

## 1. 现状（代码事实，已核对）

- `01ad:252` 硬校验 **7 个方法**：`prepare / prepareRepresentation / prepareBindings / recover /
  recoverRepresentation / activate / verifyPublished`；`capturePortable` 只在 `existingSpecial` 分支必需（`01ad:254`）。
- `01ad:241` 硬校验 `specialCoverage.type === 'skill-backup-portable'` **且** `originalObjects === 'refused'`；
  `13ak:365-366` 再抄了同样两条。
- `01ad:278` 写死 `.work-data/skill-backups`；`280/298` 写死单一 `specialSha`（`JSON.stringify` 逐字比对）。
- `13ak:382-387` 是**闭键集**：proof 必须恰好包含 `…, specialSha256, targetSha256`，且 `specialSha256` 匹配
  `/^[a-f0-9]{64}$/` —— 不能改成按命名空间的映射，否则必须动 13ak。
- 生产/快照侧也写死了 skill-backups：`01ab:128` 只认 `skillBackupSource`，`01ab:310` 写死 `type/sourcePath/sourceSha256`。
- 附件侧现有：`01af` 分块、`01ah` catalog、`01ai` 写入器、`01aj` 持久化、`01ak` 门面。
  `01ak:33` 的 opaque 是 `sha256('attachment-opaque:<face>:<id>')`，**按 face 加盐**（112 文里写的是未加盐版本，已过时）。

## 2. 目标与不变项

1. OFF→ON：把 `uploads/` 的原始附件封存进 catalog，原件在整树校验通过后才删除；ON→OFF 反向解封。
2. 失败不产生“可读的半成品”，也不把明文原件悄悄留在加密代里。
3. 覆盖率能证明“特殊处理的路径集合”与源快照一致。
4. `skill-backups` 的现有证据、proof 键集与离线兼容性不变。

## 3. 接口方案：按命名空间注册（B），但先补四处前置

| 必须 | 内容 |
|---|---|
| 前置 1 | `01ad:10` `nativeScope`、`11-17` `classify`、`240` `specialPaths`、`261-266` 的 skip/mkdir 需要知道 `uploads/` 是特殊命名空间；今天它走普通复制 |
| 前置 2 | `13ak:365-368`、`377-387` 的覆盖率与闭键集：`specialCoverage` 输入侧数组化，**输出侧仍维持单个聚合 `specialSha256`** |
| 前置 3 | `01ab:128/284/310` 的生产/快照侧需要能识别第二种 `type`，否则导出与恢复会拒；`13u:4685/4751` 的 `originalObjects` 常量也需进清单 |
| 前置 4 | `recover` 清理已写出的 sealed 目录**不能**用 `01ak.discard`（`01ak:66` 对 `sealed` 直接拒绝），需要 owner 自己的“已发布/已封存”清理路径，且该路径只在迁移 owner 内可用 |
| 前置 5 | `01ad:241` 的 `type/originalObjects` 硬校验、`271` 的 `skill-backup-bindings-v2.sealed` 写死、`278/298` 的 `.work-data/skill-backups` 与单一 `specialSha` 都是 B 的主体改动点，需与前置 2 一起改 |

注册表形态：`specialOwners: [{namespace:'skill-backups', ...}, {namespace:'uploads', ...}]`，
两个 owner 各自 `prepare`；`verifyPublished` 按命名空间校验产出；`specialSha256` 取
`sha256(稳定序列化的 {namespace: [catalog 行, 目录名单]})`，**不覆盖附件二进制全树**（否则每来一个新附件都会
`published_special_changed`；skill-backups 是靠“空库”限定规避的，uploads 天然非空）。

## 4. uploads owner 合同

- 输入：`base`、`candidate`、`sourceKeys/targetKeys`。
- 枚举 `<base>/uploads` 的**直接子项**：
  - 目录名 `file_<...>` → attachment 面；目录名 `toolimg_*` → toolImage 面；
  - `_catalog-attachments-v1.json` / `_catalog-tool-images-v1.json` 是**文件**，不是目录，单独按文件处理；
  - 32-hex 目录（`<opaque>/<revision>`）是 **ON 侧产物**，不是“跳过”：ON→OFF 时要解封它们；
  - 根下散文件、`.tmp` 残留、空目录、零文件目录：本稿定义为 **unsupported** → 整次迁移拒绝并报告（不静默复制）。
  - 符号链接由捕获层拒绝（`01aa:103`），owner 不再单独判定，但文档需写明。
- OFF→ON：每个目录必须恰好一个文件；逐文件 `01ak.seal` 到候选侧，catalog 行 `sealed`；**源目录在整树成功前不删**。
- `activate`：整树校验（每行 `verifyWhole`）通过后删除源目录；任何目录失败则整次 unknown、源不动。
- ON→OFF：按 catalog 解封回 `<base>/uploads/<id>/<logicalName>`，再删除 sealed 目录与两份 catalog 文件。
- `verifyPublished`：逐行 `sealed` + `verifyWhole` + 目录 census；返回 `{files, bytes, sha256}`。

## 5. 失败与半态（修正上一版的事实错误）

- **并存态不会自动变成“拒绝读”**：`01ag` 只在 `<opaque>/<revision>/` 内做 census，sealed 行照常可读；
  留下的是明文原件（隐私残留）。因此 activate 前的失败必须由调用方判失败并清理，不能指望读侧兜底。
- `validateSource`（`01ad:162-176`）会把 proof 之外的新增文件/目录判为 `source_changed`（白名单只有
  `.work-data`、`migrations`）；owner 必须在 prepare 阶段把新建的特殊路径登记进 `specialFiles/specialDirectories`
  （`01ad:206-208`），并纳入 `01ad:173` 的白名单分支，否则并存态会误红。
- `recover` 不能清 sealed 目录（见前置 4）；未完成的 pending/uncertain 行可以用 `discard`。
- `verifyPublished` 不能对 `uploads/` 取全树 sha（见第 3 节口径）。

## 6. 验收门

1. 单元（临时目录 + 真 keys，`enabled:()=>true`）：单文件目录封存/解封往返字节一致；多文件目录、根散文件、
   空目录均拒绝；pending/uncertain 不可读且可 `discard`；sealed 清理走 owner 专用路径。
2. 迁移集成：`work-data-cold-operations.e2e.js` 目前夹具只有 `config.json` + `sessions/sess_native.json`
   （27-28 行，`paths.uploadFile:null`）。加 `base/uploads/file_<16hex>/x.bin` 可行，但该 e2e 只在 win32 跑
   （第 20 行），Linux CI 覆盖不到；需真 NTFS + DPAPI。
3. 覆盖率：`specialCoverage` 能列出 uploads 路径集合；缺路径/多路径都拒绝；`specialSha256` 只覆盖 catalog + 目录名单。
4. 静态门：清册/冻结表不变；adapter 仍 `pending`，直到 1–3 全过。

## 7. 待评审决定

1. 是否先做一次性方案 A（只给 uploads 写死一个 owner）以缩短路径，再重构为 B？（本稿推荐直接 B，但接受 A 的过渡）
2. `activate` 删原件前是否保留可回滚副本（本稿默认不保留，依赖迁移备份）。
3. 根下散文件/空目录：拒绝整次迁移（本稿）还是跳过并报告。

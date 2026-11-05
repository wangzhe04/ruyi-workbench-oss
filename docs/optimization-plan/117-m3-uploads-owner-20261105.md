# 117 · 迁移侧 uploads owner 草稿（2026-11-05）

按 116 的合同新增 `01al-work-data-uploads-owner.js`：把 `uploads/` 的原始布局枚举出来，交给两个面的
运行时封存，整组校验通过后才删除原件。仍然没有挂到迁移主机（`01ad` 的五处前置未改）。版本仍 **3.0.1**。

## 合同

- `create({root, keys, enabled})`：内部按 116 建两个 `01ak` 门面（attachment / toolImage）。
- `enroll()`：只读扫描 `uploads/` 直接子项：
  - `_catalog-attachments-v1.json` / `_catalog-tool-images-v1.json` 忽略；
  - 32-hex 目录视为“已封存”，只计数；
  - `file_*` → attachment、`toolimg_*` → toolImage；目录内必须恰好一个普通文件，否则记 `unsupported`；
  - 根下散文件、未知目录一律 `unsupported`。
- `sealAll()`：
  1. `enroll()` 有 unsupported → 直接拒绝（`work_data_uploads_owner.unsupported`），**不写任何字节**；
     0 字节文件、超过 `01af.MAX_BYTES` 的文件、根下散文件与未知目录都在这一层拒绝（读取前先 `lstat` 大小）；
  2. 逐文件读原字节 → `01ak.seal`（kind original/tool-image、mime 按扩展名）；
  3. 全部 `verify` 通过后才删除源目录；任何一步失败，源目录保留，已封存行仍是 `sealed`（源仍在，无数据丢失）。
  4. 删除前对每个源目录做 `lstat` + `realpath` 复核（拒绝 junction/符号链接），与 `01ak.discard` 同一口径。
- 32-hex 目录大小写都识别为“已封存”，只计数；本稿暂不与 catalog 对账（见边界）。
- 返回 `{sealed:[{id,face,file,totalBytes,sha256}], verified, removed, alreadySealed}`。

## 验证

- 新增 `dev-harness/unit/work-data-uploads-owner.test.js`：**5/5 pass**
  - 两个面各一目录 → 全部封存、校验、删除原件；两个面都能读回原字节；
  - 根下散文件 → 拒绝且原件未动、catalog 无行；
  - 多文件目录 → 拒绝，单文件目录也不会被提前封存；
  - 0 字节文件 → `empty-file` 拒绝；大写 32-hex 目录被识别为已封存；
  - 已封存目录与 catalog 文件被正确识别/忽略。
- 生成物：`build` 114718 行；`module-dependency-graph --check` 140 modules / 932 edges；
  `facts` 454 unit / 629 e2e，两份 README 同步；`facts.static` ALL PASS。

## 边界与下一步

- 只做了 OFF→ON 方向；ON→OFF 解封、sealed 目录清理、`01ad`/`13ak`/`01ab` 的注册表前置都还没有。
- 失败时的“已封存行 + 源目录并存”只保证数据不丢，不保证隐私（明文仍在），这与 116 §5 的描述一致；
  调用方必须在失败时清理或回滚。
- 下一步按 116 的前置 1–5 改迁移主机，再把本 owner 挂上去，最后进 `work-data-cold-operations.e2e.js`。

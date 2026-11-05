# 122 · ON→OFF 接进迁移主机（2026-11-05）

把 121 的解封原语接到真实迁移链路：`01ad` 新增可选 `uploadsRestoreFactory`，`13ak` 在 disable 时传入
以**源根**为根的 `01al` owner；候选代里的 raw/密文混合 uploads 被替换为解封后的明文目录。版本仍 **3.0.1**。

## 行为

- `01ad.prepare`：
  - `targetMode === 'encrypted'` 且给了 `uploadsOwnerFactory` → 候选侧 `sealAll()` 后重登 census；
  - `targetMode === 'plain'` 且给了 `uploadsRestoreFactory`，并且 owner 的 `hasSealed()`（逐行检查两个面）
    返回真 → 调 `replaceInto({target: candidate/uploads})`（先清候选 uploads 再逐行解封），随后重登 census；
  - 源根没有 sealed 目录时**跳过** restore（否则会把已复制的明文上传件清空）。
- `13ak`：`enable` → `uploadsOwnerFactory`；`disable` → `uploadsRestoreFactory`（`root = base/uploads`）。
- `01al.replaceInto({target})`：复用 `checkedTarget`（绝对、与源不相交、realpath 校验）→ 清空 target →
  逐行 `writeRestored`（256 KiB 分段、`wx`、size 校验）；源 sealed 行不 retire。
- 失败沿用既有语义：候选代保留，源代不动。

## 验证

- `work-data-migration-host.test.js`：33/33（真实 owner 的 enable 用例仍通过）。
- `uploads-owner` **10/10**：新增 `replaceInto` 用例（清掉候选里的 stale 文件、按 sealed 行重建明文、源仍 sealed）。
- `cold-operations` + `production-host` + `uploads-owner`：**150/150**。
- **真实 NTFS 冷操作 e2e**（`work-data-cold-operations.e2e.js`，本机 Windows，262 秒，全部 ALL PASS）：
  - enable：两个面（`file_*` 与 `toolimg_*`）在加密代里只剩 `<opaque>/<revision>/` + 两份 catalog，
    逐分块扫描确认不含任一面的明文（catalog 由 target census 的文件哈希覆盖）；
  - enable 后的全量导出与独立冷进程验证通过（说明 119 的 sealed 识别生效）；
  - disable：两个面都解封回明文布局，候选代没有 32-hex 目录、没有 catalog；
  - disable 后的第二次全量导出仍通过。
- `build` 114891 行；`module-dependency-graph --check` 140 modules / 934 edges。
- 修复记录：首轮 e2e 暴露 restore 读错了根（拿了 `base/uploads` 而不是源代 `expected.root/uploads`），
  改为源代后通过。

## 下一步

1. 运行时上传/下载接入（启用后新上传必须写 sealed；当前路由仍写原始字节）
2. 全过后 adapter `pending → wired`（清册里两面的状态更新）
3. 继续 M3 其它面：非空 special、owner delta、retention、索引组合

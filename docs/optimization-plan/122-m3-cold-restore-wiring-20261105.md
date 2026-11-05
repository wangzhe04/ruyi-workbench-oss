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
- `build` 114891 行；`module-dependency-graph --check` 140 modules / 934 edges。
- **缺口（已记录）**：host 级的「enable→disable 往返」没有自动化用例。原因：fixture 的第二次 `backupFirst()`
  在已含 `.work-data/skill-backups` 的加密代上会要求特殊所有者（`work_data_full.special_owner_required`），
  当前 fixture 没接这条。需要先给 fixture 提供加密代 + special-owner 的备份能力，或把该场景放到冷操作 e2e。

## 下一步

1. 补 host 级 enable→disable 往返（fixture 支持或换成冷操作 e2e）
2. `work-data-cold-operations.e2e.js` 加附件夹具做真实 NTFS OFF→ON→OFF
3. 全过后 adapter `pending → wired`

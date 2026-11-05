# 120 · 生产冷操作接入 uploads owner（2026-11-05）

`13ak` 在 enable 时把真实 `01al` 作为 `uploadsOwnerFactory` 传给迁移主机：候选代里的原始附件会被封存，
catalog 与分块一起进入新一代；disable 时若源根 `uploads/` 已含 sealed 目录（32-hex），直接拒绝
（`work_data_setup.uploads_unseal_unsupported`），不把密文当明文复制。版本仍 **3.0.1**。

## 行为

- `operation === 'enable'`：`uploadsOwnerFactory = ({root,keys}) => WorkDataUploadsOwner.create({root,keys,enabled:()=>true})`，
  由 01ad 在候选代上调用 `sealAll()` 并重登 target census。
- 其它操作：只有 `operation === 'disable'` 会先扫 `base/uploads`，发现任何 32-hex 目录即抛
  `work_data_setup.uploads_unseal_unsupported`（外层会归一成顶层的 `work_data_setup.preparation_failed`，
  该码在 `cause.code` 里），避免生成“看起来明文、实际是密文容器”的新代；`export`/`restore` 不走这段。
  ON→OFF 的附件解封（01al.unsealAll）还没接进迁移，等后续切片。
- 不改 13ak 的 proof 键集或 specialCoverage：源根没有成为特殊命名空间，uploads 只在候选代被替换。

## 验证

- `work-data-cold-operations.test.js` + `work-data-production-host.test.js`：**140/140 pass**（既有用例未受影响）。
- `build` 114825 行。
- 说明：disable 拒绝分支尚无独立用例（现有夹具只跑 export/enable 路径），列入下一步。

## 下一步

1. 给 disable 拒绝分支补直接用例；再接 `01al.unsealAll` 让 ON→OFF 真正可用
2. `work-data-cold-operations.e2e.js` 加带附件的夹具，做真实 NTFS 的 OFF→ON→OFF 往返
3. 全过后 adapter `pending → wired`

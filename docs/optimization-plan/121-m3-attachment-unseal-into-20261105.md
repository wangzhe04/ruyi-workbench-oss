# 121 · 附件 ON→OFF 候选解封原语（2026-11-05）

给 `01al` 加 `unsealInto({target})`：把 sealed 行读出来写进**另一个根**（关闭加密时的候选代），
不 retire、不修改源根。这样 disable 迁移可以先把密文解封到候选代，再整代切换。版本仍 **3.0.1**。

## 合同

- `unsealInto({target})`：`target` 必须是绝对路径，且与源根**不相交**（不能相等、也不能互相包含，Windows 大小写不敏感）；
  目标存在时必须是真实目录（非符号链接），创建后再次用 `realpath` 核对；返回 `{restored, retired: []}`。
- 复用与 `unsealAll` 相同的 `writeRestored`：`stat` 取 totalBytes → 256 KiB 分段读 → 写入目标
  `<target>/<id>/<logicalName>`（`wx`）→ 校验 `size === totalBytes`；`<target>/<id>` 若已存在同样做 `lstat`+`realpath` 校验。
- 源根的 sealed 行保持原样（仍可读、仍是 `sealed`），因此失败时源与目标至少各有一份完整副本。

## 验证

- `work-data-uploads-owner.test.js`：**9/9 pass**，新增 1 条 —— 封存后 `unsealInto` 到另一个根，
  目标字节与原文一致，源仍 `sealed` 且可读；`target === root` 与相对路径都被拒绝。
- 生成物：`build` 114855 行；`module-dependency-graph --check` 140 modules / 934 edges。

## 下一步

- 在 `01ad` 增加 `uploadsRestoreFactory`（清理候选侧复制过来的密文目录后调用 `unsealInto`，重登 census），
  再把 `13ak` 的 disable 从“拒绝”改成“解封到候选代”，并给该分支补直接用例。

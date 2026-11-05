# 137 · 非空 special：现状与确切断口（2026-11-05）

按 136 的建议转到 ②。本片只做**现状核实**（47 项相关单测实跑），把缺口缩到一个具体位置，下一片直接补测试/实现。

## 已覆盖（实跑 47/47 PASS）

`migration-backup-owner` + `migration-backup-representation` + `work-data-full-snapshot`：

- owner 层：空库创建、崩溃/改名恢复、plain 备份不可冒充受保护、未知目录歧义阻断、目录身份替换拒绝、
  归档/intent codec 绑定目标代、逻辑身份与 activation、跨代历史日志。
- 快照层（**不带 owner**）：`migrations/skill-backups/...` 与 `.work-data/skill-backups/objects-v1/...`
  一律 `work_data_full.special_owner_required`，且原目录保留（`work-data-full-snapshot.test.js:85/129`）。

## 缺口（明确到行）

`01ab:213` 已经支持「传入 `skillBackupOwner` 时走 capturePortable/validatePortable/stagePortable/
installPortable/verifyPortableInstalled」；但**没有任何测试覆盖“带 owner 且备份非空”的普通全量快照**——
现有拒绝用例都是不带 owner 的。也就是说：

- 代码路径存在；
- 证据缺一条：非空 capsule 经普通 snapshot（有 owner）封装 → 恢复 → 逐字节一致，且不重写 live skills。

## 下一片（具体）

1. 用现有 capsule 夹具造一个非空 `migrations/skill-backups/<stamp>/<skill>/`（带 `.ruyi-capsule-v1`）；
2. 调 `WorkDataFullSnapshot.create({... skillBackupOwner: MigrationHooks.createBackupOwner ...}).seal()`
   → 断言 snapshot 含该路径且 keyRefs 正确；
3. `WorkDataRecovery.open` + `restore` 到新 target → 断言逐字节一致、live skills 未被改写；
4. 负例：owner 返回缺失方法/假 capsule → `special_owner_required` 且原件不动。

## 边界

- 不做真实 NTFS/桌面；owner 语义与快照封装在模块级验证。
- 不声称 ② 已完成；目前是“owner 层已覆盖、普通快照非空缺证据”。

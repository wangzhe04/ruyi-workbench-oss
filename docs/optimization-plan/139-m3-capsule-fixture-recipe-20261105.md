# 139 · 非空 capsule 快照用例：夹具已现成（2026-11-05）

继续 ②，发现不需要新造夹具：`dev-harness/lib/migration-backup-owner-fixture.js` 的 `capsule()` 已经产出
**真实非空 capsule**（`.ruyi-capsule-v1` + `objects/` + intent + live skills 树），并且它的 `owner()` 返回的
owner 同时具备 `capturePortable / validatePortable / stagePortable / installPortable / verifyPortableInstalled`
（`13u:4903` 的完整导出）。也就是说 01ab:213 需要的 `skillBackupOwner` 就是它。

## 下一片的精确写法（一次改完）

1. 在 `work-data-full-snapshot.test.js` 里用 `createBackupOwnerFixture(<同一临时根>)` 建 capsule；
2. 把 capsule 树（`f.backup(stamp,skillId)` 与其 `.ruyi-capsule-v1`、`objects/`、intent）放到快照夹具的
   `base/.work-data/skill-backups/objects-v1/<stamp>/<skill>/` 位置（fixture 内已是相对路径，可直接 `cp -r`）；
3. `WorkDataFullSnapshot.create({ base, ..., skillBackupOwner: async () => f.owner() })` → `seal()`：
   断言成功、`auxiliaries` 里有且只有一条 `skill-backup-portable`，`sourcePath/sourceSha256` 与
   `WorkDataRecovery.skillBackupSource(files, dirs)` 一致；
4. `WorkDataRecovery.open` + `restore` 到新 target → capsule 文件逐字节一致，且 `skills/<id>` 未被改写；
5. 负例：owner 缺少 `capturePortable` 或 capsule 被改一个字节 → `work_data_full.special_owner_required` /
   `auxiliary_closure`，原件不动。

## 为什么本片不直接写

`fullFixture` 的 base 与 capsule 夹具的 `dir` 是两个临时根；把 capsule 搬进 base 需要复制后重算
`sourceSha256`（`capturePortable` 按 base 内路径计算），这一步要**先确认 capsule 内的路径是相对还是绝对**。
不确认就写会把“搬运成功”误当“快照支持非空 capsule”。

## 证据边界

- 已有的 47 项 owner/representation 测试仍全绿（138 记录）；
- 普通快照“带 owner 的非空 capsule”仍无测试，② 未完成。

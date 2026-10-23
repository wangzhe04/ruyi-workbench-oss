# Handoff — 2026-10-23

关机截止前停止扩展。只有独立 shared escaped-key marker 小修已交 root 评审；本目录 migration 草稿不属于已验证可应用批次。完整 TEMP 源码、baseline、日志和详细设计位置见 `baseline.json`。

## 已做草稿

migration-log：purpose `migration`，scope `global`，record `migration-log:<ts>`；chunked 256MiB 上限仅用于 ON 工程态，OFF 不加容量限制、原 pretty JSON 字节不变。四个写入口共用 adapter；最新 20 条及普通坏明文跳过语义保留，work_data 错误硬抛。sealed 严验 schema/id/files/items；旧日志可省略 metadata 字段，保留 partial undo 重试。ON 短 lease 预检在外部 rewrite/copy/undo 之前，不隐式建钥。

skill-import-record：purpose `backup`，scope `skills`，record `skill-import:<finalSkillId>`。stage 写入显式绑定最终 id，rename 后仍可读；原 pretty JSON+换行不变。旧 16KiB 明文读边界保留，密文按解封后大小核限，超大磁盘文件用有界 carrier scanner 分类；ON 写侧拒绝新建自己读不回的 >16KiB metadata，OFF 原写侧不加 cap。每次读重验 key/instance，无 memo；缺钥/坏密文/坏 sealed shape 不回 null。content tree hash 仍排除 `.ruyi-import.json`。

12/13/13l/05/09 的必要消费点仅将 work_data 从 catch[] 重新抛出，普通 I/O fallback 保留，避免坏 provenance 导致空技能列表被保存。copy cleanup 后重新抛 work_data，旧 live 不替换。

## 未完成与风险

草稿的六个源码 baseline 早于 root 应用 memory，需要局部重基。已有 14 项 source 绿，尚未验证最终 shared carry 组合；未独审、无本族 DPAPI E2E。log 写仍在外部更改之后：短 key preflight 能拦已知无钥，无法提供跨文件事务或跨进程轮换 CAS。后续 key 替换/I/O 失败、同毫秒 log 文件名碰撞、既有 `.bak-ruyi-migrate-<ts>` sidecar 仍需评估，不能把预检说成原子迁移。

## migration-skill-backups 下一步方案

OFF 保持旧目录整体 rename/rename-back 与原 metadata/hash 合同，不能套用原 source-copy 的 20MiB/500 files/16 层上限到手工改过的旧 destination。

ON 拟使用加密 manifest + 逐文件封印 payload；磁盘 payload 名为随机派生的 opaque 64hex，不由明文路径/内容 hash 派生。manifest 加密记录相对路径、entry 类型、原 mode/times/支持的 attrs、payload ID/字节数/内容 SHA、随机 snapshot revision、总数/总字节。purpose backup；payload scope 绑定 batch/skill/snapshot revision，record 绑定 payload ID。所有路径必须规范化、拒穿越/重复/case 冲突。

遍历只用 lstat/readlink，不跟随链接读取外部树。原本可 rename 的链接、reparse、hardlink、ACL/ADS 等不能静默丢弃。初版若不能可靠恢复，按 root 授权在 M3-3 preflight 明确拒绝切换，保留原 live；不宣称仅 mode/mtime 等同 Windows rename 的全部语义。

完整写入并认证 manifest、所有 payload、entry set/hash/count/bytes，且 source identity 未变，才允许动旧 live。工程上限必须在 M3-3 预检，超限不切权威。base64 payload 的实际原始文件上限约为 text cap 的 3/4，须用准确编码长度公式，不宣称 raw256MiB 可装进256MiB文本。

恢复必须先认证完整 manifest、能力/路径/容量预检，再解封到独立 CLI-live stage，完整内容/tree hash 验证后才发布；**禁止密文备份目录直接 rename 回 live skills**。失败清 stage，不删除有效旧 backup。一次处理一个 payload，仍不宣称总 RSS 有界。真实用户数据不在测试中复制、迁移或发布。

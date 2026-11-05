# 106 · M3 附件二进制面登记（2026-11-05）

本片只做一件事：把 `uploads/` 的两类原始附件**登记进持久面清册与加密冻结表**，让普查无法再跳过它们。
本片**不加密任何附件**，也没有接线 adapter；清册里它们仍是 `pending`。版本仍 **3.0.1**，M3 未完成、未发布。

## 为什么现在做

103 号文指出「`uploads`/`tool-image`/`send` 派生件的二进制面仍须独立登记和接线」，而 78 面清册里
一条都没有 —— 也就是说这是普查的缺口，不是已声明的待办。先登记，才能让后续接线有可核对的完成定义。

## 登记内容

| 面 | 路径 | 生产者 | 加密类 | 迁移批 | adapter |
|---|---|---|---|---|---|
| `uploads-attachment` | `<data>/uploads/<attachment-id>/<basename>` | `04-permission-runtime.js`（`makeAttachmentRecord`；下载路由的 lexical/realpath containment 在 `13-http-router.js`） | required / `session` | sessions | **pending** |
| `uploads-tool-image` | `<data>/uploads/toolimg_[<session-tag>_]<sha1-24>/<basename>` | `10-context-governance.js`（工具结果图片解码后落盘，按会话前缀清理） | required / `cache` | index-cache | **pending** |

- 清册从 **78 面 → 80 面**（shared 32、dedicated 26、external 10、regenerable 12）。
- 冻结表从 **45 required / 33 excluded → 47 required / 33 excluded**。
- 两份生成物由 `node dev-harness/durable-state-inventory.js --write` 与
  `node dev-harness/encrypted-storage-freeze.js --write` 重算，未手改。

`send-derivative` **没有登记**：代码里目前只有 `01af` 的 `kind` 白名单，没有任何生产者。等真正有派生件落盘
再登记，避免为一个不存在的面记一条空账。

## 验证

- `node dev-harness/encrypted-storage-freeze.static.e2e.js` → ALL PASS（80 面、47/33，purpose 与 batch 闭合）。
- `node dev-harness/durable-state-inventory.static.e2e.js` → ALL PASS（anchor、生命周期、未声明写入者检查）。
- 两份生成物与源（`dev-harness/encrypted-storage-freeze.js`、`dev-harness/durable-state-inventory.js`）逐字节一致。

## 边界与下一步

- 登记不等于加密：这两类文件今天仍是磁盘上的原始字节，`encryptionImplemented` 仍为 false。
- 下一步：为这两面补 codec/迁移批（复用 `01af` 分块 + `01ag` 读取器或既有 `WorkDataStore` 二进制通道），
  实现 catalog 生产方 `authority.capture/describe/assert`，再补真实 NTFS 的读写与恢复验收。
- `media-derived` 面与这两面的关系：前者是受保护的图片缓存（已 wired），后者是**原始附件**，二者不能互相替代。

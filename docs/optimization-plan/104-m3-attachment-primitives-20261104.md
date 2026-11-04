# 104 · M3 附件分块与密封读取原语（2026-11-04）

本片从 `3847514a` 起，新增两个隔离草稿模块及其单元测试：认证分块格式 `01af-work-data-attachment-chunks.js`
与只读密封读取器 `01ag-work-data-attachment-reader.js`。**这不是附件加密迁移完成**：生产 IO 适配、catalog 生产方、
上传/工具图片/发送派生面的登记与消费者接线、retention 与索引组合均未做；真实 NTFS 与 e2e 未运行。
版本仍 **3.0.1**，完整 M3 与 3.1 未完成、未发布。

## 产品变化与合同

- `WorkDataAttachmentChunks`：256 KiB 分块、单块密文载体 ≤2 MiB、整文件 ≤256 MiB；每块保存明文 sha256 与密文
  sha256，manifest 自身加密并携带整文件 sha256 与块清单；`selectChunks` 只按字节区间选块，`verifyComplete`
  校验整链。writer 只产出密文，密钥由调用方传入并在模块自有副本上清零，模块不建密钥、不读写文件系统。
- `WorkDataAttachmentReader`：只读；要求宿主提供 `keys.snapshot` 与 `authority.capture/describe/assert`；支持区间与
  整文件读取；lease 释放后拒绝复用；失败时同时保留主错误与清理错误，清理不确定时禁止后续 dispose。
- binding 哈希改为按固定字段序计算（本片收紧）。`own()` 返回的对象已按键名排序，原实现本身是确定的；改动是为了让 manifest 的 binding 身份不依赖该辅助函数的内部排序细节，并由回归测试把公式钉死。
- `metadata.kind` 白名单已含 `original` / `tool-image` / `send-derivative`，但当前没有任何 catalog 生产方填出它们，
  三派生面仍未登记进 `encrypted-storage-freeze` 清册。

## 独立审查与处理

- 独立审查（deepseek-flash）判 reject/fail（置信度 0.72），主要发现：
  - S2：`bindingHash` 直接序列化重建对象（已收紧为固定字段序并加断言；复核确认原实现因 `own()` 排序而确定，
    此项属加固而非缺陷修复）。
  - S3：错误对象缺 `statusCode`/`apiCode` 三件套之一；清理错误把封存绝对路径带进 `cause`；
    `memoryLease` 部分完成时暴露 sha256 仅靠 `complete` 标记；写侧不校验 `MAX_CARRIER`；`chunk_encoding` 为不可达校验。
- 本片只收紧 S2 并补测试；S3 保留为待办。理由：两个模块尚无 HTTP/消费者面，错误三件套与信息暴露在接线时必须
  按宿主通道重定，先改会制造未经真实消费方验证的语义。

## 验证与边界

- `node --test dev-harness/unit/work-data-attachment-chunks.test.js dev-harness/unit/work-data-attachment-reader.test.js`
  —— 79 tests / 79 pass / 0 fail。
- `node ruyi-workbench/app/build.js` —— 产物重建，114111 行；`--check` 通过（产物与 src 一致，manifest 行区间自洽）。
- `node dev-harness/module-dependency-graph.js --check` —— PASS（135 modules / 922 edges）。
- `facts.json` 与实测一致：447 个 unit 文件、627 个 e2e 文件；两份 README 的 135 模块 / 447 suite 同步更新。
- `node dev-harness/syntax-gate.js` —— 1453 files / 0 failed（Node v24.14.0）。
- 未运行：真实 NTFS、附件 e2e、迁移/恢复组合、全量 unit/static。**不据此声称附件加密、retention 或完整 M3 已完成。**

## 下一步（M3 未完成项）

1. catalog 生产方：实现 `authority.capture/describe/assert` 的真实来源，把 `original`/`tool-image`/`send-derivative`
   三个二进制面登记进 `durable-state-inventory` 与 `encrypted-storage-freeze` 清册。
2. 用真实 IO 适配 range 读取与整文件校验，补 sealed fault 下 `cleanupFailure` 的通道化错误三件套。
3. 与迁移 factory 的只读源解码、retention、全文索引组合验收；随后才是全部 family、附件、完整索引的真实 NTFS 门。

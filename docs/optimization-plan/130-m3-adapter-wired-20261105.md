# 130 · `uploads-attachment` adapter 转 wired（2026-11-05）

运行时上传/下载在启用代上已通过真实 HTTP 验收（128：上传 sealed、整读、206 区间、416 越界、无明文），
所以把清册里 `uploads-attachment` 从 `pending` 改为 **wired**。`uploads-tool-image` 仍是 `pending`
（只有 hook 单测，没有真实工具图 HTTP 用例）。版本仍 **3.0.1**。

## 变更

- `dev-harness/encrypted-storage-freeze.js` 的 `ADAPTER_WIRED` 加入 `uploads-attachment`；
- 重新生成 `encrypted-storage-freeze.json/.md` 与 `durable-state-inventory.json/.md`；
- 计数不变：80 面 / **47 required** / 33 excluded；wired 46（仅 `uploads-tool-image` 仍 pending）。

## 依据

| 面 | 证据 |
|---|---|
| `uploads-attachment` | 模块级 01af/01ag/01ah/01ai/01aj/01ak/01al 单测；OFF HTTP Range 13 项；真实 NTFS OFF→ON→OFF 262s；**启用代 HTTP 上传/下载/Range 7 项** |
| `uploads-tool-image` | 仅 hook 单测（密封/读取/退掉）；无真实工具图 HTTP 用例 → 保持 pending |

## 验证

- `encrypted-storage-freeze.static.e2e.js` ALL PASS；
- `fulltext-storage-contract` 仍通过（三个 fulltext 面保持 required/pending）；
- 生成物与源逐字节一致。

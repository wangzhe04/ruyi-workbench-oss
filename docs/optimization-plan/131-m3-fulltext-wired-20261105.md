# 131 · 完整索引组合：三个 fulltext 面转 wired（2026-11-05）

M3 的「完整索引组合」块再推进一格：`session-fulltext-state` / `manifest` / `shard` 三个 required 面
从 `pending` 改为 **wired**。依据是**运行时**证据（不是迁移夹具）：启用态下生产索引写出的是
`workData:3` 密封载体，且文件里没有明文行。版本仍 **3.0.1**。

## 新增证据

`dev-harness/unit/fulltext-runtime-encrypted.test.js`：用 `fulltext-owned-producer-fixture` 以
`enabled: true` 起真实索引，写入一条含私有标记的消息并 `step`：

- `_fulltext-index-v1/state.json`、`<sid>/manifest.json`、`<sid>/<gen>.0.json` 全部存在；
- 每个文件的第一个 JSON 行 `workData === 3`；
- 每个文件都不含明文标记 `RUNTIME_PRIVATE_FULLTEXT`。

这与既有 `fulltext-storage-contract`（迁移 codec/快照/拒绝面）、`fulltext-host`（host ON 往返）互补，
补上了“运行时写入即密封”这一条。

## 变更

- `ADAPTER_WIRED` 加入三个 fulltext 面；
- `fulltext-storage-contract` 的普查断言从 `pending` 改为 `wired`（仍要求 required / search-index / owner）；
- 重新生成 freeze/inventory：80 面、47 required、33 excluded、**46 wired**，
  **唯一的 required-pending 只剩 `uploads-tool-image`**（工具图片真实 HTTP 证据缺口，按管家口径记为待办）。

## 验证

- 新单测 1/1；`fulltext-storage-contract` + 新用例全过；
- `encrypted-storage-freeze.static`、`facts.static`、`route-inventory.static`、`build --check` 全过；
- `facts` 456 unit / 630 e2e，README 双语同步。

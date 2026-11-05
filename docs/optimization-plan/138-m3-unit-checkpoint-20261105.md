# 138 · 全量 unit 检查点（绿）与一处真实回归修复（2026-11-05）

全量 `node --test "dev-harness/unit/*.test.js"`：**194 suites / 5057 tests / 5031 pass / 26 skip / 0 fail**（436s）。
本轮第一次跑出真实失败，不是 flake：130 把 `uploads-attachment` 转 wired 后，`work-data-migration-codecs`
仍断言两个 uploads 面都是 `pending`。已修为按 id 断言（attachment → wired，tool-image → pending）。

## 修复

`dev-harness/unit/work-data-migration-codecs.test.js`：

```js
const expectedAdapter = { 'uploads-attachment': 'wired', 'uploads-tool-image': 'pending' };
```

## 意义

- 之前几轮只在「被改动的文件」上跑单测，漏掉了这条跨模块断言；全量检查点把它抓出来了。
- 当前附件/索引两块的 adapter 状态与代码事实一致：47 required 中 46 wired，唯一 pending 是 `uploads-tool-image`（真实 HTTP 证据待办）。

## 未覆盖

全量 e2e（630+ 件）与真实平台/桌面仍未跑；本片只做 unit 与静态门。

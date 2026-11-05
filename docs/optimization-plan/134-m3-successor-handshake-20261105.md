# 134 · 私有 successor 握手的拒绝面（2026-11-05）

按 133 的协议规格，写第一个**真实进程**用例：`app/server.js work-data-successor` 对畸形握手必须在读盘前拒绝，
且不留下密钥或活动代。`dev-harness/work-data-successor-handshake.e2e.js` **6 项 PASS**。

## 用例

| 输入 | 期望 |
|---|---|
| 空 stdin | exit 1，stderr 含 `successor`/`work_data` 错误码，不挂起 |
| `nonce: 'not-hex'` | exit 1 + typed 拒绝 |
| `expectedAuthority` 与实况不符（generation 9 / 假 id） | exit 1 + `successor_authority_changed` |
| 带 `activation` 但来源不是 fresh-root restore | exit 1 + typed 拒绝 |
| 拒绝之后 | `work-data-key-v1.json` 不存在（plain 下本就为真，作为弱证据） |
| 拒绝之后 | `.work-data/active-v1.json` 不存在（主证据） |

## 结论与边界

- 这证明“畸形握手不会改数据根”，是启用流程（①）的第一个可执行子步；
- **未覆盖**：合法握手（需要真实 cold 操作产出的 result id / nonce / 端口与后继 serve 接管），
  以及 UI 触发路径；这两项留到下一片。
- 夹具：临时 home + data 根、独立端口、`stdio` 带 IPC；失败分支均 20s 超时保护。

## 生成物

`facts` 631 e2e / 456 unit（README 双语同步 624 默认回归 + 7 live）；route-inventory 重算；两件静态门 PASS。

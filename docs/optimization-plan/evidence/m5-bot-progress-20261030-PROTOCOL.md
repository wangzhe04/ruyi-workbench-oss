# B2 官方协议核验（2026-10-30）

仅只读公开文档，无账号、回调探测或真实平台发送。以下是当前证据边界，不以合成 HTTPS 响应冒充真实账号能力。

| 官方来源 | 当前可验证内容 | 候选处理 |
|---|---|---|
| [QQ 消息概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)，页面标注更新2026-07-21，主动/被动、频率与时效、去重段 | 被动回复携带原消息 id；单聊概述60分钟/4次，群5分钟/5次；相同原消息与序号不能重复发送。主动/召回另有账号、接收设置和配额。 | 自动开始提示和最终回复均为原消息的被动回复，固定序号1/2；不切换主动或召回 API。 |
| [QQ 单聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)，页面标注更新2026-10-28，顶部规则与请求体段 | 同页顶部写60分钟；`msg_id` 字段仍写5分钟，存在明确冲突。接口路径为原 users 消息接口。 | 当前采用两段约束的交集5分钟；不是断言平台所有单聊仅支持5分钟。未来需平台账号/文档澄清后才扩窗口。 |
| [QQ 群聊发送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)，顶部及请求体段 | 群被动窗口5分钟、5次；接口级上限与按认证/关系的主动配额是不同维度。 | 本片最多一个开始提示和一个最终回复；主动查询使用查询消息自身的原 id，不能拿它替换旧结果的接收身份。 |
| [飞书回复消息](https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN)、[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) | 官方地址可定位，但本次读取工具返回空正文；不能据此声称已核定具体回复时效/数值配额。 | 继续使用已有应用机器人 reply 接口；不臆造 QQ 式硬时限，也不因文档正文缺失拒绝正常已授权消息。 |
| [飞书/Lark 官方 CLI 的回复接口参考](https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-messages-reply.md)，2026-10-30读取 | 官方组织参考确认按原 message id 的 POST reply、bot 使用 tenant access token 与相应发送 scope；原 idempotency key 有明确去重用途。 | 复用 B1 固定官方 hostname/path、tenant token、每次原 attempt 的 uuid；progress/final 使用不同的持久 attempt。此参考不能替代 Feishu 租户实际权限或消息配额证据。 |

产品节流明确属于如意本地预算：每应用12次/分钟、每聊天6次/分钟、聊天相邻发送至少1秒；它不是平台配额，也不保证账号其他并发流量不触发限流。预算预留落在同一原机器人 ledger，重启不会清空。平台429及可解析 Retry-After 控制后续等待；拒绝/不确定结果保持原语义，不能因此重跑业务。

开始提示在原单业务 owner 等待期间自动发；只读“进度”/“查询进度”/`/status`读取严格同 owner、连接、平台、租户、会话、会话类型及授权修订下的原项。超窗仍接受正常入站并处理业务，只把原回复留在本地待发；没有省略原消息 id 的兜底、召回或跨群发送。当前不是远程待决动作 C。

平台实际验收仍缺专用应用/账号、真实权限、回调可达与指定测试会话授权。内部请求事件链、隔离 HTTP 与 browser 永久入口分别记录，不冒充真实 QQ/飞书。

# 飞书应用身份自动发现（本机发起）

> **当前状态（2026-10-21）**：本机固定接口探测已有源码与隔离证据；真实飞书身份响应、配置接续与权限边界仍须在 3.1 发布前核对，按 86 号实施，不以 fake 响应代替真平台验收。 当前执行入口：[86 号路线](86-3.1-completion-and-privacy-roadmap.md)。

设计日期：2026-10-17。基线：`c7c1cd3d`；实施分支：`codex/steward-3x-implementation`；当前应用版本 3.0.1。承接 [66 号远程控制](66-external-bots-and-steward-channels.md) 与 [67 号管家代办配置](67-steward-assisted-bot-setup.md)，实现 67 号文末登记的下一片：用户明确发起的固定官方 API 探测，自动发现飞书 tenant key 与机器人 open_id。

## 用户目标

用户手里只有飞书应用的 App ID 与 App Secret，不知道 `tenant_key`，也不知道机器人的 `open_id`。67 号已经消除了环境变量与手工配对，但飞书连接的这三项身份仍要用户自己去后台翻。本批让用户在「外部机器人」面板填 App ID + App Secret，点一次「用应用信息自动发现」：本机向固定官方接口探测，拿到租户 key 与机器人 open_id，直接准备一条**禁用**连接并把 App Secret 存进本机凭据库；用户随后只需补 Verification Token／Encrypt Key，再走 67 号的一次性配对与本人授权。

已有连接可以「核验身份」：用这条连接已保存的 App Secret 再探一次，核对返回的租户与机器人是否仍与该连接一致，不写任何状态。

## 边界

- 探测只由本机用户在设置面板明确发起。固定官方域名 `open.feishu.cn`，三条固定路径（内部 tenant token、`bot/v3/info`、`tenant/v2/tenant/query`），不接受调用方给的域名、路径、代理或重定向；`https.request` 不跟随 302，响应头里的 location 不会被采用。
- 秘密只走本机管理接口 → 凭据库（Windows DPAPI），不进入连接配置、日志、模型上下文、SSE、错误文字或 GET 回包。探测失败不建立连接、不写凭据，不把半成品身份留在状态文件里。
- 探测结果只用于准备一条禁用连接。它不授予控制权，不开启连接，不改 owner／白名单，不启动配对。谁是本人仍由 67 号的签名事件与本机确认决定；探测成功不等于平台回调、事件订阅或收发已联调。
- 非 Windows 允许「只探测」（返回身份，不保存任何秘密）；`create` 在非 Windows 明确拒绝并提示改用环境变量方式，不降级为明文保存。
- 真实平台账户与公网 HTTPS 联调仍是 66 号 B 批的独立验收项。本批只用离线假端点证明生产代码正确处理受控响应，不宣称已在真实租户上跑通。

## 接口

| 接口 | 权限与含义 |
|---|---|
| `POST /api/external-bots/discover` | 本机 token + 同源；`op=probe` 探测（可顺带准备禁用连接），`op=verify` 用已保存秘密复核现有连接 |

`probe` body 仅允许 `op / appId / appSecret / label / create`：返回 `discovery { tenantId, botUserId, appName }`、`created`（`created / reused / existing`）、`connectionId` 与连接就绪度。`verify` body 仅允许 `op / connectionId`：返回 `matches { tenantId, botUserId }` 与 `discovery`，不写状态。

身份只接受可打印 ASCII 且长度有界；`appName` 仅用于显示，缺失不影响身份，不当作鉴权依据。

## 失败、并发与竞争

单飞（同一时刻只允许一次探测）加每分钟 10 次上限；超时、网络失败、429、4xx、5xx、平台 `code !== 0`、缺字段、响应超过 64 KiB、非法 UTF-8、非 JSON 全部映射为稳定的 `external_discovery.*`，不猜测身份、不重试、不把失败响应当成空身份。

- token 阶段失败：`credentials_rejected`（明确拒绝）或 `unavailable`／`timeout`／`network`（未知），两者都拒绝创建。
- 机器人或租户阶段失败：`bot_unavailable`／`tenant_unavailable`；缺 `open_id` 或 `tenant_key` 为 `identity_missing`。
- 已存在**已启用**且身份一致的连接：返回 `existing`，不建连接、不写凭据、不改动它。
- 已存在禁用、仅收件、未绑 owner 的同身份连接：复用并只更新 App Secret（环境来源的槽不动）。
- 身份与现有连接不同：按 66 号不可变身份规则另建一条禁用连接（换应用／换租户用新连接 ID），不覆盖旧连接。

准备好连接后写凭据失败时，连接保留为禁用且缺凭据的状态（界面显示缺项），不回滚成「什么都没有」，也不谎报已配置。

## 与 67 号工具的关系

`steward_bot_setup` 不变：它仍然拿不到秘密，也不应该拿。它的 `inspect` 回执增加一句提示——飞书缺 `tenant key`／机器人 `open_id` 时，让用户在本机面板用「自动发现」，不必手工构造 JSON 或读管理员手册。模型只解释事实，不能凭一次探测把连接说成已启用或平台已连通。

## 实现与验收记录

2026-10-17：**源码与隔离验收完成，尚未发布，尚未联系真实飞书账号。** 新增模块 `13z-external-bot-discovery.js`（固定官方域的三段探测，独立预算、不跟随重定向、失败只返回稳定码）、`POST /api/external-bots/discover`（本机 token + 同源；`probe` / `verify`）、面板「用应用信息自动发现」与每条飞书连接的「核验身份」，并更新 `steward_bot_setup` 的 guidance 让人去面板发现，而不是索要密钥。

| 验收项 | 独立结果 |
| --- | --- |
| 探测模块单测（`unit/external-bot-discovery.test.js`） | 8 条通过：固定主机与三条路径、密钥只出现在 token 请求体、4xx/429/5xx/非 0 code/畸形/超限/非法 UTF-8/缺 open_id 或 tenant_key 各自稳定码、静默端点 2 s 内超时、非法入参零外发 |
| 配置 HTTP（`external-bot-discovery.e2e.js`） | 25 条通过：鉴权、同源、未知字段、无 query、非 POST、只探测不落盘、创建禁用连接、重复复用、启用连接不动、核验一致/不一致、核验不改身份、缺密钥明确拒绝、拒绝码不被路由折叠、限流 |
| 真实凭据与泄露检查 | Windows 真实 DPAPI：探测成功把 App Secret 写进密文账，日志、响应、状态文件与密码框都不出现测试秘密；平台访问令牌同样不落日志 |
| 前端接线（`unit/external-bots-ui.test.js` 新增 3 条） | 提交体只含 `op/appId/appSecret/label/create`，密钥在请求发出前清空，失败不跳转且报稳定码，核验按钮只出现在飞书行 |
| 生产浏览器旅程（`external-bots.browser.e2e.js` 新增 D1–D8） | 全件通过：面板表单、真实探测准备第二条连接、身份与禁用状态、密码框清空、自动打开引导、只打固定官方身份端点、秘密只到 token 端点、页面无秘密残留；原有中／英 × 明暗 × 1440/768/390 视图检查继续通过 |
| 既有回归 | `external-bot-setup.e2e.js`、`external-bots.e2e.js`、`external-bots-control.e2e.js` 全部通过 |
| 全量单测 | 2034 项：2008 通过、26 跳过、0 失败 |
| 静态门禁 | 80／80 件通过；构建产物与 src／manifest 一致；1008 个文件语法检查通过 |

收口期间发现并修复：新路由没有登记 `ROUTE_AUTH`，带 token 的请求被路由鉴权 403 拦下；探测操作在共享状态链里再次取同一把链导致自锁（`probe` 只读时不能嵌套，改为路由直接调用、写盘单独进链）；连接启用需要两张白名单，测试最初漏填；错误响应的码在 `error.code` 而不是顶层 `code`，按错位置的断言一度把真实失败当成通过。

另修了一个与本批无关但挡住浏览器验收的夹具缺陷：`lib/fixture-home.js` 的临时家没有 `AppData\Local|Roaming` 目录，Chrome 155 在缺失时进程活着却永不绑定 `--remote-debugging-port`，浏览器件一律红在「CDP target unavailable」。临时家现在补建这两个空目录，`unit/fixture-home-per-test.test.js` 与本次浏览器件均通过。

本批没有真实飞书租户、没有公网 HTTPS，也没有构造或发布安装包。三段探测的响应形状取自官方文档（token、`bot/v3/info` 的 `bot.open_id`、`tenant/v2/tenant/query` 的 `tenant.tenant_key`），**未在真实租户上核对**；若应用未获租户信息权限，界面会报 `tenant_unavailable` 并保留手工填写路径，不猜测身份。真平台联调仍是 66 号 B 批的独立验收项。

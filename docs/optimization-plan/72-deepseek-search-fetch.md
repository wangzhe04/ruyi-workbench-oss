# DeepSeek Search / Fetch 接入

日期：2026-10-18。承接用户提出的如意搜索扩展，实施于 `codex/steward-3x-implementation`。源码尚未发布。

## 官方契约

依据 [DeepSeek 网页搜索与抓取指南](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Search Reference](https://api-docs.deepseek.com/zh-cn/api/search/) 与 [Fetch Reference](https://api-docs.deepseek.com/zh-cn/api/fetch/)，2026-10-18 核验：两者是独立 JSON API，采用相同 API Key 的 Bearer 鉴权。

| 操作 | 端点 | 本次使用 |
|---|---|---|
| Search | `POST /v1/tools/search` | `query`（1–128 Unicode 字符）、`count`（沿用如意 1–20 的上限）、`need_content:false` |
| Fetch | `POST /v1/tools/fetch` | `url`，返回标题和 Markdown 正文 |

## 配置与行为

设置 → 联网搜索选择 `DeepSeek（搜索与网页抓取 API）`，在搜索后端填 API Key。Base URL 留空使用 `https://api.deepseek.com`；管理员代理可自定义根地址，也接受末尾 `/v1`。不自动复制模型端点密钥，不改变已有用户的默认搜索后端。

普通 `web_search/web_fetch` 和管家 `steward_web_search/steward_web_fetch` 共享此配置。Search 返回标准标题、网址、短摘要，并保留长摘要和日期；Fetch 接入现有字符分页、完整文本磁盘缓存、外部内容围栏与取消信号。续页复用十分钟内缓存，避免重复调用。

管理员配置的 API 地址沿用可信端点规则；待抓取网址仍拒绝私网、非 HTTP、带凭据和超长地址，并检查本地 DNS 的私网结果。远端实际抓取由 DeepSeek 处理，其目标解析与跳转安全依赖服务端策略。API 重定向不跟随，不向跳转端点转发密钥。返回形状错误不伪装成空结果。

Search 遵守现有 `fallbackToBuiltin` 显式开关，缺省关闭；不因选择 DeepSeek 自动外发到其它搜索引擎。Fetch 不默默切到本机直接抓取；临时连接/服务错误、408、429 可返回明确标为旧缓存的内容；400/401/402/403/404、取消、契约错误和 API 重定向不以缓存掩盖。关闭 DeepSeek、选择其它搜索后端后，继续使用既有直接抓取。

## 验收

新增 `dev-harness/deepseek-search-fetch.e2e.js`，以本机假 JSON 服务验证官方路径、鉴权、128 Unicode 字符边界、配置/密钥往返、普通工具与管家共用、Markdown 分页、缓存、Search/Fetch 取消、私网及凭据网址拒绝、空结果与各类错误响应。该件为离线契约测试，不等于搜索质量评测。

2026-10-18 使用本机现有官方 DeepSeek 端点密钥，各调用一次真实 Search 和 Fetch：Search HTTP 200、结果 1 条；Fetch HTTP 200、标题“网页搜索与抓取”、Markdown 正文 6402 字符。只输出状态与长度，未输出密钥，也未修改用户现有配置。这证明该账户当时可调用这两个端点，不代表长期可用性或质量评分。

价格、限速与账户权限以 DeepSeek 当前官方说明为准，产品界面不硬编码临时免费政策。

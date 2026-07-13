# 第 33 波 · 安全收口:全 GET 面 host 校验 + 声明式 auth 路由表 deny-by-default

日期:2026-07-13。承接第29波 backlog #0(`OPTIMIZATION-ROADMAP.md:485`:"DNS-rebind 对只读 GET…需全 GET 面 host 校验单独立项")+ 早期审计声明的"声明式 auth 路由表 deny-by-default"杠杆。

## 1. 威胁模型(核实,非转述)

DNS-rebinding:攻击者控 `evil.com`,受害者浏览器加载后域名重绑到 `127.0.0.1:PORT`,页面对本地工作台发请求。

**当前防御层**(`server.js`):
- `hostAllowed(req)`(:1404):Host 头必须严格等于 `127.0.0.1:PORT`/`localhost:PORT`/`[::1]:PORT`。**仅在 `originOk`(:1411)内调用**。
- `originOk(req)`(:1409):先 `hostAllowed`,再 Origin 同源校验。**仅在 `handleApi` 的 `if (mutating)` 块(:13650)调用** -> **GET 请求完全跳过**。
- `tokenOk(req)`(:1417):`x-wcw-token` 头比对 `RUNTIME.token`。中央门 + 14 处 handler 自查。

## 2. 核实出的缺口

### 缺口 A(定位级):全 GET 面 + 静态 `/` 无 host 校验
- HTTP handler 顶部(:14987-14996)**无任何 host 门**。`serveStatic('/')`(:14996 + :1384)把 **token 明文注入 index.html** 服务给**任意 Host 头**。
- 攻击链:rebinding 页导航到 `http://evil.com:PORT/` -> `serveStatic` 服务 index.html(Host=evil.com,无门)-> 页面从自身 DOM 读出 `wcw-token` -> 以同源(evil.com:PORT)+ token 打任意路由。**这是"token 随 HTML 明文下发"的精确根因**(backlog #0 原文)。
- 即便不得 token:GET 请求跳过 `if (mutating)` -> 不经 `hostAllowed`/`originOk`。rebinding 页以 `Host: evil.com:PORT` 直接 GET 即可(无需 token)读未自查的 GET 路由。

### 缺口 B(活跃泄露):3 个 GET 路由无 host 门 + 无 token 门
核实(逐个读 handler):`GET /api/agent-roles`(:13864)、`GET /api/agent-workflows`(:13891)、`GET /api/playbooks`(:13766)均在 mutating-only 的 `needsToken`(:13671)里(GET 不生效),且 handler **无 tokenOk 自查**,不在 `uiReadRoute`。-> rebinding 页无需 token 可直接读(角色定义/DAG/剧本,含项目结构与路径)。
- 对照:`GET /api/sessions`、`/api/skills` 早经 P1 #1(roadmap:319)纳入 `uiReadRoute` 已修;`/api/memory`、`/api/agent-runs`、`/api/checkpoints`、`/api/audit`、`/api/file/preview`、`/api/ops/metrics`、`/api/usage/summary` 等 14 处 handler 自查 tokenOk(无 host 门但 token 门在)。

### 缺口 C(结构性,S0 教训):opt-in 名单 + 散落自查
`needsToken`/`uiMutatingRoute`/`uiReadRoute` 三条 OR 链 + 14 处 handler 自查 = **opt-in**:新路由默认无防护,须手工添名单(第23波 S0 教训"this list never auto-covers a new path")。缺口 B 正是因此漏掉 3 个 GET。

## 3. 方案

### Part A:顶层 hostAllowed 门(治缺口 A,直接修 backlog #0)
`http.createServer` handler 顶部(:14988 `try{` 后第一行)加:
```js
if (!hostAllowed(req)) return send(res, json({ ok: false, error: 'host not allowed' }, 403));
```
覆盖 `/health` + `/api/*` + `serveStatic` 全部。rebinding(Host=evil.com)-> 403,含 index.html(断 token 泄露主链)。loopback(Host=127.0.0.1:PORT,所有合法调用方:e2e/MCP 子/CLI/浏览器)-> 通过。**3 行,近零风险**(仅拦非 loopback Host,无合法调用方使用)。

### Part B:声明式 auth 路由表 + deny-by-default(治缺口 B+C,根因)
- 新增 `ROUTE_AUTH` 表:`{ m, p, auth, prefix? }`,auth ∈ `open`/`origin`/`token`/`token-browser`/`body-token`。
- 新增 `authorizeRoute(req, method, pathname)`:first-match-wins,HEAD 归一为 GET,未匹配 -> `'route not authorized'`(deny-by-default 403)。
- **替换** `handleApi` 鉴权块(:13646-13699,含 `mutating` 变量)为单次 `authorizeRoute` 调用。
- 缺口 B 的 3 个 GET 标 `token-browser`(与 sessions/skills 同纪律:浏览器须 token,loopback 须同源)。
- **保留** 14 处 handler 自查 `tokenOk` 作纵深(不删,降误分类风险:表若把 'token' 误标 'open',自查仍兜底;唯一残留风险是 false-deny,由 e2e 兜)。
- `body-token` 路由(permission/request/todo/mission/agent-workflow/launch)返回 'ok',handler 自查 body token。

### 鉴权级别语义(与现状逐字对齐)
| 级别 | 浏览器调用方 | 非浏览器 loopback(e2e/CLI/MCP 子) |
|---|---|---|
| open | 放行(host 门已过) | 放行 |
| origin | originOk(同源) | originOk(loopback 无 Origin->过) |
| token | tokenOk(必须) | tokenOk(必须) |
| token-browser | tokenOk(必须) | originOk(loopback 过,**无需 token**) |
| body-token | handler 自查 body token | handler 自查 body token |

**关键不变量**:dns-rebind.e2e (5) `Host=loopback + 无 Origin + 无 token -> 200`(loopback 豁免)必须保持 -> `token-browser` 的非浏览器分支走 originOk(loopback 过)= 现状 `uiMutatingRoute`/`uiReadRoute` 纪律。

## 4. 红队(7 条)

1. **false-deny 破现有路由**:表漏列/前缀遮蔽 -> 200 变 403。**缓解**:表从 dispatch 机械派生 + e2e 探针全路由 + 保留 dispatch if-链(表先过才进 dispatch,但 e2e 覆盖各族)。
2. **前缀遮蔽**:`/api/memory`(exact GET token) vs `/api/memory/`(prefix POST token-browser)。**缓解**:exact 先于 prefix;GET/POST 方法分离;`/api/agent-runs` GET prefix(token)不遮蔽 `/api/agent-runs/:id` POST(token,同级)。
3. **HEAD/OPTIONS 误拒**:HEAD 不在表 -> deny。**缓解**:`authorizeRoute` 把 HEAD 归一为 GET。OPTIONS 无 CORS 支持,deny 合理。
4. **DELETE-via-POST**(x-http-method:DELETE):method=POST,须命中 POST prefix 条目。**核实**:playbooks/agent-workflows/sessions/memory 的 DELETE-via-POST 都被对应 POST prefix 覆盖;agent-runs 有真 DELETE(单独条目)。
5. **/api/chat/answer**(:14118)漏列:不在 needsToken/uiMutatingRoute,现状 mutating 基线=originOk。**缓解**:表标 `origin`(保持现状,不收紧避免破坏)。
6. **顶层 hostAllowed 破 /health 就绪探针**:e2e 用 GET /health on 127.0.0.1 -> Host=loopback -> 过。✓
7. **token 仍随 HTML 明文**:Part A 后,rebinding 拿不到 index.html(Host 拒)-> 拿不到 token。但同源合法 UI 仍能从 DOM 读 token(设计如此,UI 须用 token 打 API)。**残留可接受**:token 的真正价值是 CSRF(防 rebinding 跨站),非本地进程隔离(同用户进程可读 runtime.json,注释:13680 已述)。

## 5. 范围外(诚实)
- token 从 HTML 改为 sessionStorage/cookie 注入(更深,动前端契约,择期)。
- 14 处 handler 自查移除(表已覆盖,但保留纵深更安全,单独清理波)。
- `toolCall()` 40+ 分支表驱动(结构演进,单独立项)。
- CORS 支持(产品定位是本地回环,无 CORS 需求)。

## 6. 施工规格
| 6.x | 内容 | 位置 |
|---|---|---|
| 6.1 | 顶层 `hostAllowed` 门 | server.js :14988 |
| 6.2 | `ROUTE_AUTH` 表 + `authorizeRoute` | server.js :1417 后(tokenOk 后) |
| 6.3 | 替换 `handleApi` 鉴权块(:13646-13699)为 `authorizeRoute` 调用 | server.js :13646 |
| 6.4 | e2e `dev-harness/auth-deny-default.e2e.js`(9126) | dev-harness/ |
| 6.5 | README 端口表 +9126;ROADMAP §31 第33波 | docs/ |

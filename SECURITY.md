# 安全策略 · Security Policy

## 报告漏洞 · Reporting a vulnerability

请通过本仓库的 **GitHub Security Advisories**(仓库 **Security → Report a vulnerability**)私密报告安全问题。**请勿**在公开 issue、PR 或讨论区披露未修复的漏洞。

Please report security issues privately via this repository's **GitHub Security Advisories** ("Security → Report a vulnerability"). Do **not** disclose unfixed vulnerabilities in public issues, PRs, or discussions.

## 威胁模型速览 · Threat model at a glance

如意 Ruyi 是**本机单用户**工具,安全设计围绕「本地服务不外泄 + 危险操作可控可撤销」:

- **仅回环监听 + 页面 token**:HTTP 服务只绑 `127.0.0.1`,变更类请求需页面注入的 token,防止本机其他进程/网页越权调用。
- **权限分级 + 可撤销操作**:权限模式分档;写文件、执行命令等操作在动手前记入**检查点 journal**,可逐条回滚。计划模式下变更需显式批准。
- **联网工具 SSRF 防御**:`web_fetch` / `http_download` 等拒绝私网、回环、链路本地等地址段,防止模型被诱导探测内网。
- **解压护栏**:zip 解压有条目数、解压总量、单条目 inflate 比上限,防 zip 炸弹。
- **工作区路径护栏**:文件操作受工作区根约束,阻断路径穿越到工作区之外。
- **密钥掩码**:provider API key 在 `/api/status` 等响应中以 `••••<后4位>` 掩码返回,磁盘配置保留真值,响应不含明文。

Ruyi is a **single-user, local** tool. Its design centers on "the local service never leaks + dangerous actions stay controllable and reversible": loopback-only binding plus a page token; tiered permissions with a rollback-able checkpoint journal; SSRF defenses on networked tools (private/loopback/link-local ranges rejected); zip-extraction limits (entry count / total size / per-entry inflation ratio); workspace path guards; and provider keys masked in API responses.

## 边界与非目标 · Boundaries and non-goals

如实告知:

- **不是多租户服务。** 本机单用户工具,不提供跨用户隔离、账户体系或网络级鉴权。请勿把它当作对外网络服务部署。
- **模型输出仍可能有害。** 权限模式与人工审查是**用户的责任**;放宽权限档意味着你承担相应风险。
- **桌面控制 MCP 权力很大。** `ai-computer-control` 能操控鼠标键盘、窗口、文件与外部程序;默认权限档**不放行**危险操作,请谨慎逐步放宽,并优先在计划模式下审查。

Stated plainly: this is **not** a multi-tenant service — a single-user local tool with no cross-user isolation, accounts, or network auth; do not deploy it as a public network service. Model output can still be harmful — permission modes and human review are the **user's** responsibility. The desktop-control MCP is powerful (mouse/keyboard/windows/files/external apps); the default permission tier does **not** allow dangerous operations — loosen it deliberately and review under plan mode.

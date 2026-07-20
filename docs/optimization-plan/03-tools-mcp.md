# 03 · 工具库（ACC）优化 + MCP 生态兼容方案

> 对应所有者确定方向 3。三个子命题：① ACC 自身质量战役；② 新增常用工具；③ 与 Claude Code / Codex 的 MCP 生态互通。核心判断：**最痛的不是缺工具，而是桥接契约错位（僵尸执行）与"生态只有出口没有入口"**。

---

## 1. 现状盘点

### 1.1 ACC（mcp/ai-computer-control，v1.8.3）

- 100 个工具 / 33 个模块，Python FastMCP，Windows 专用。能力面：桌面操控（截图/鼠标/键盘/窗口/应用/剪贴板/音频）、UIA+OCR+视觉三路径、观察验证（observe/act_and_verify）、宏（record/batch/wait_for_pixel）、文件系统、Shell、浏览器 12 工具（Playwright 五模式）、文档/Office 模板族、诊断安全。
- 质量亮点：键盘 CJK 走剪贴板、Shell 按 OEM 码页解码、read_file 真字节预算、统一 `ok` 包络 + 审计脱敏。
- **完全没有**：网络 fetch、持久记忆、推理辅助、Git/VCS、数据库、**局部编辑/补丁类工具**（模型只能整文件 write_file）。

### 1.2 工作台桥接与加载链路

- 零依赖 `McpStdioClient`（`04-permission-runtime.js:310-465`，JSON-RPC over stdout，协议钉 `2024-11-05`）。
- 三路接入合并（`resolveExternalMcpServers`，`04:538-581`）：desktopMcp 自动探测、用户 externalMcpServers（≤10）、drop-in `ruyi-mcp.json` 扫描（≤10）。
- 与 Claude CLI 互通：`generateMcpConfig` 产出标准 `.mcp.json`，`claude mcp add-json -s user` **单向同步**（`01-config.js:684-694`）。
- 按需装载：143 工具全量 schema ≈ 29,721 token，经 tool_search 降到 889（TOOL-LOADING_CN.md:17-26）——这是营销证据源，工具扩充后必须重测。

### 1.3 关键问题清单

| # | 问题 | 证据 | 严重度 |
|---|------|------|--------|
| T1 | **桥超时契约错位**：桥默认 120s（`04:432`），ACC `run_command`/`launch_application`/`wait_for_*` 允许至 600s；桥超时后 ACC 进程僵尸执行，从不发 `notifications/cancelled` | `04-permission-runtime.js:356/432`、`shell.py:57/71` | 高（数据安全风险） |
| T2 | 依赖声明与 README 矛盾：pyproject 把 playwright/uiautomation/matplotlib 列为硬依赖，README 宣称可选优雅降级；注释引用不存在的 `macro.py/pdf_tools.py` | `pyproject.toml:16-34` | 中 |
| T3 | 协议能力缺口：`capabilities:{}`，不支持 cancellation/progress/elicitation；`tools/list` 只在握手取一次，不响应 `tools/list_changed`（靠 60s 缓存兜底） | `04:414/419-420` | 中 |
| T4 | **只有 stdio**：不支持远程 SSE/streamable-HTTP、无 headers/OAuth，Claude Code 的 `"type":"sse"` 条目无法接入 | `05-claude-engine.js:781-802` | 中（生态天花板） |
| T5 | **只有出口没有入口**：能导出到 Claude CLI，不能从 `~/.claude.json` / 项目 `.mcp.json` / Codex `config.toml [mcp_servers]` 导入 | `01-config.js:684-694` | 高（方向 3 核心） |
| T6 | 配置格式不兼容细节：`example.mcp.json` 用 `%USERPROFILE%`，Claude Code 只展开 `${VAR}` | `config/example.mcp.json:8` | 低 |
| T7 | 工具面内部重叠：`read_document` PDF 分支无分页上限整本抽取 vs 新 `pdf_read_pages`；xlsx 静默截 500 行 vs `excel_read`；新旧命名风格不一（write_excel vs excel_read） | `document.py:100-128` | 中 |
| T8 | 桥接写族审计依赖参数命名表 `BRIDGED_WRITE_PATH_ARGS`，新工具命名偏表即静默漏审计 | `02-session-store.js:1346-1379` | 中（安全兜底已有 `auditBridgedWriteCoverage`） |
| T9 | schema 膨胀：100 工具单服务器是 29.7K token 主来源 | TOOL-LOADING | 中 |
| T10 | 仓库卫生：`build/lib/` 与 `__pycache__` 入库、根目录离线 zip 二进制、离线 wheel 1.8.1 与源码 1.8.3 脱节 | mcp/ 目录 | 低 |
| T11 | 独立部署安全边界弱：`allow_dangerous/allow_protected` 让模型可自行绕过；safety 子串黑名单自认可绕；shell 超时只杀直接子进程 | `shell.py:50/62`、`safety.py:103` | 中 |
| T12 | `excel_read` 二次全量打开（性能） | `office_read.py:100/196/221` | 低 |

## 2. 子命题一：ACC 质量战役（W45–W47）

### Phase A · 契约修复（W45，与 02 方案 Phase B 同做）

1. 桥实现 cancellation：超时/用户打断时发 `notifications/cancelled`，声明 `capabilities`；桥超时即 kill ACC 侧关联进程树（Windows 孙进程问题一并解）。
2. 超时契约对齐：桥超时改为按工具可配置（声明式表：`run_command` 等长时工具放宽到 650s 或桥透传工具自报 timeout），消灭"桥先死、ACC 僵尸"。
3. `_buf` 4MB 截断评估放大或改流式（`04:406`）。
4. e2e：fake-mcp 扩展（当前仅 4 占位工具）模拟慢工具 + cancel 断言。

### Phase B · 工具面收敛（W46–W47）

1. **新旧两代读取栈收敛**：`read_document` 的 PDF 分支废弃或内部转调 `pdf_read_pages`（保留兼容别名）；xlsx 分支标注弃用指向 `excel_read`；命名规范写进 ACC 贡献指南。
2. **description 一致性审计**：100 个工具的中英文 docstring 混排统一为"一句何时用 + 一句何时别用 + 参数约定"；FastMCP `instructions` 补 ok 包络语义与坐标系约定。工具 description 就是提示词面，与 04 方案联动。
3. **schema 减重**：`ACC_TOOLSETS` 环境变量按能力子集注册（desktop/office/browser/filesystem…），默认全开，用户可裁剪；配合 tool_search 按需装载把首 token 成本再降一档。重测 TOOL-LOADING 的 A/B 数字并刷新营销证据。
4. **性能小项**：`excel_read` 二次打开修复；`read_document` 大文件预算化统一。
5. **pyproject 修正**：可选依赖移入 extras，注释更正；离线 wheel 版本钉死到 pyproject 版本（消除 1.8.1 vs 1.8.3）。
6. **卫生**：`build/lib`、`__pycache__`、根目录 zip 移出 git（走 Release 资产）；补 .gitignore。
7. **测试**：11 个 smoke 脚本收拢为统一 pytest 入口 + 发版门禁；fake-mcp 扩 20 关键工具契约（roadmap 第 45/46 波既定计划）补上 ACC 离线回归≈0 的窟窿。

### Phase C · 安全边界加固

1. `allow_dangerous/allow_protected` 默认策略改为"工作台 tier 体系统一裁决"，ACC 独立部署场景补"写路径白名单工作区化"选项。
2. `BRIDGED_WRITE_PATH_ARGS` 纳入新工具验收清单（注册即声明路径参数名），`auditBridgedWriteCoverage` 升级为 CI 静态锁。
3. shell 类工具进程树终止（Job Object）。

## 3. 子命题二：新增常用工具（W47 首批）

优先级按"ACC 独立场景缺位 + 工作台用户高频需求"排序：

| 优先级 | 工具 | 理由 | 备注 |
|--------|------|------|------|
| P0 | **edit_file / apply_patch** | ACC 完全没有局部编辑能力，模型只能整文件 write_file——既危险又费 token | 与检查点联动，天然获得撤销能力 |
| P0 | **fetch / web_fetch** | 工作台原生有 web_fetch，但 ACC 独立给 Claude Desktop 等宿主用时缺位 | SSRF 防护复用 `11-native-tools.js` 的逐跳+DNS 钉定模式 |
| P1 | **memory（持久记忆）** | 对照 Claude Code 官方 memory MCP；与工作台记忆库互补而非冲突 | 独立存储文件，勿与 workbench-memory 混 |
| P1 | **sequential-thinking** | 社区高装机量推理辅助工具 | 实现量小，纯文本协议 |
| P2 | **github** | GitHub 操作（issue/PR/search），工程用户高频 | 需 token 配置，走 env 注入 |
| P2 | **官方 filesystem 兼容层** | 让熟悉 Claude Code filesystem MCP 的用户零迁移成本 | 可与 ACC filesystem 并存，语义对齐官方版 |
| P3 | **@playwright/mcp drop-in 评估** | 以官方浏览器 MCP 替代自维护 browser.py 12 工具的可行性评估 | 只评估不急于替换；自维护版有 OCR/UIA 差异化 |

每个新工具入库纪律（已有机械化门）：注册表条目 + guard 声明（`tool-dispatch.e2e.js` 行为锁）+ 安全验收（`tools-v3.e2e.js` 的 Zip Slip/SSRF/超限模板）+ `BRIDGED_WRITE_PATH_ARGS` 声明 + description 规范 + 门面数字同步。

## 4. 子命题三：Claude Code / Codex MCP 生态兼容（W46–W47）

### 4.1 配置导入器（"入口"建设）

1. **导入源三合一**：
   - `~/.claude.json` 与项目 `.mcp.json`（Claude Code 格式：`mcpServers` 字典，stdio/sse/http 条目）；
   - Codex `config.toml` 的 `[mcp_servers]` 段（TOML 解析，零依赖实现一个迷你 parser 或宽松正则提取）；
   - 现有 `ruyi-mcp.json` drop-in 与 `POST /api/mcp/import-folder`（`13-http-router.js:1087-1124`）保持，导入器作为其前置。
2. **字段映射与降级**：`command/args/env/cwd` 直映；`${VAR}` 与 `%VAR%` 双向插值规范化；`type:"sse"/"http"` 条目在远程 transport 落地前标记"暂不支持"并明示（不静默丢弃）；`headers`/OAuth 字段保留存根。
3. **UI**：设置"集成/MCP"页加"从 Claude Code / Codex 导入"向导——列出发现的条目、冲突检测（id 撞名）、逐项勾选导入；MCP 服务器管理面板（每服务器启停/健康/工具数/tier 覆盖/drop-in 一键导入，复用 `/api/status` 已有的探测状态字段）。
4. **适配指南文档**：写《现成 stdio MCP → ruyi-mcp.json 包装指南》+ 两个完整示例（如 fetch 与 github），补 mcp/README.md 的"社区贡献"短板，澄清 :9 合并上限语义。

### 4.2 远程 transport 与协议升级

1. 评估并实现 SSE / streamable-HTTP client（零依赖约束下手写量可控：SSE 解析在 provider 引擎已有 `e5-multiline-sse` 修复过的成熟实现可复用）。
2. 协议版本从 `2024-11-05` 升级到 `2025-03-26+`（向后兼容握手协商），补 `tools/list_changed` 响应。
3. headers/OAuth bearer 支持（密钥走 env 引用，禁明文落盘——写进指南）。

### 4.3 Claude 子代理桥接复评

- 现状：Claude 子代理桥接 MCP 维持 exec-only 安全裁定（`07-autonomy.js:1743-1748`），分级开放"待 CLI 提供逐工具硬白名单语义"（roadmap:314）。**每轮 CLI 升级时复评一次**，若新 CLI 版本支持逐工具白名单，分级开放 bridged 读族工具给子代理。

## 5. 验收清单

- [ ] 桥超时/cancel：慢工具被超时即收 `notifications/cancelled` 且进程树终止，无僵尸写入（e2e）
- [ ] `ACC_TOOLSETS` 子集注册 + tool_search A/B token 数字重测并刷新文档
- [ ] 新旧读取栈收敛完成，description 审计 100/100
- [ ] 新增首批工具（edit_file/fetch/memory/sequential-thinking）过入库纪律全部门
- [ ] 从 Claude Code `.mcp.json` 与 Codex `config.toml` 导入 e2e（含冲突/降级路径）
- [ ] MCP 管理面板上线（启停/健康/工具数/导入向导）
- [ ] ACC pytest 统一入口进 CI；fake-mcp 20 工具契约离线回归
- [ ] pyproject/离线包/仓库卫生修复；门面数字单一事实源同步

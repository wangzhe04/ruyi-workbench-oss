# 如意 Ruyi 管理员手册

> 面向部署者 / IT / 内网运维。本手册讲清楚如意工作台的**部署形态、引擎接入、安全边界、验收回归与排障**。用户视角的操作说明另见同目录 [`USER-GUIDE_CN.md`](USER-GUIDE_CN.md)。
>
> 术语与硬约束：如意工作台是 **clean-room 独立实现**、**server.js 零 npm 运行时依赖**、**默认全离线零遥测**、**overlay 增量套用**、支持 **Windows 10/11**。产品名对外为「如意 Ruyi」。v1.0-S9 发布工程已将目录名改为 `ruyi-workbench`、可执行文件名改为 `Ruyi.exe`（启动/检测脚本双名兼容旧 `WinClaudeWorkbench.exe`）；**MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME` 等存量兼容标识有意保持不变**（详见文末「品牌与兼容」）。

---

## 1. 形态与部署

### 1.1 单文件服务

核心是一个零 npm 运行时依赖的 Node 服务 `app/server.js`（只用 Node 内置模块）。启动方式：

```powershell
node app\server.js serve --open        # 源码方式（推荐，改动免重编即生效）
.\Ruyi.exe serve --open   # 打包 exe 方式
Start-Workbench.cmd                      # 便捷启动脚本（内部走上面之一）
```

`serve` 起 HTTP + Web UI；`--open` 顺带打开浏览器。要求 Node ≥ 20（`package.json` engines 声明）。

### 1.2 CLI 子命令

`main()` 按 `argv._[0]` 分发（默认 `serve`）：

| 子命令 | 作用 |
|---|---|
| `serve` | 启动前端与 HTTP API（Web UI 主入口）。 |
| `mcp` | 启动 MCP stdio server，供 Claude CLI 调用（一次性子进程，置 `RUNTIME.isMcpChild=true`）。 |
| `mcp-config` | 打印可导入 Claude CLI 的 MCP JSON（含桌面 / 外部 MCP）。 |
| `install` | 尝试自动向 Claude CLI 注册 MCP（`claude mcp add-json`）。 |
| `doctor` | 输出本机诊断（claude CLI / git / python / 端口 / overlay 完整性等）。 |

### 1.3 overlay 增量包套用

发布升级走**增量覆盖包（overlay）**，不重装整包。包内结构：`Manage-Overlay.cmd`（薄封装）→ `Manage-Overlay.ps1` → `payload\`（落地文件 + `update-manifest.json`，内含每个文件的 sha256）。四个动作：

```cmd
Manage-Overlay.cmd apply    "C:\...\Ruyi-offline"
Manage-Overlay.cmd rollback "C:\...\Ruyi-offline"
Manage-Overlay.cmd list     "C:\...\Ruyi-offline"
Manage-Overlay.cmd verify   "C:\...\Ruyi-offline"
```

套用流程（`Do-Apply`）：**先备份**目标里将被覆盖的每个文件到 `目标\.overlay-backups\<版本>-<时间戳>\` → 复制 payload 覆盖 → 写 `.overlay-applied.json` 标记 → **用 sha256 逐文件校验**（`VERIFY OK: all N files match` 即成功）→ 只保留最近 5 份备份。`rollback` 恢复最近一次备份（服务运行时**拒绝**回滚，先停进程；新增的文件如 vendor 库会留下，无害）。套用前若探测到 8765 / 8799 端口有工作台在跑，会告警提示先关闭，否则新 `server.js` 不生效。

> 套用后验证：浏览器打开 `http://127.0.0.1:<端口>/health` 应返回 `{"ok":true,...}`；「体检」页签的 `overlay-integrity` 应为 `verified`。

### 1.4 数据目录

数据目录解析优先级（`dataRoot()`）：

```
RUYI_HOME  →  WIN_CLAUDE_WORKBENCH_HOME  →  ~/.win-claude-workbench（默认）
```

新变量 `RUYI_HOME` 优先，旧变量继续识别（至少保留一个大版本，兼容存量部署）。目录下含：`config.json`、`sessions/*.json`（原子写：先 `.tmp` 再 rename；损坏文件改名 `.corrupt` 隔离而非删）、`uploads/*`、`generated/*`（含生成的 `.mcp.json`）、`logs/*`、`checkpoints/<sessionId>/*`（文件检查点 journal + 压缩前历史快照）、`playbooks/*.json`（用户自定义任务模板）、`webcache/<sha256(url)>.json`（联网检索正文缓存）。

覆盖示例：

```powershell
$env:RUYI_HOME = "D:\workbench-data"
```

### 1.5 端口

默认端口 **8765**（`DEFAULT_PORT`）。取值优先级：`--port <n>` → 环境变量 `PORT` → 8765。绑定 `127.0.0.1`（仅本机）。

**被占接管语义**（`listenWithFallback`，`EADDRINUSE` 时）：

- 若 `killPortOnStart=false`（配置）或 `WCW_KILL_PORT=0`（环境变量）→ **不接管**，直接报错让你换端口（`--port`）。
- 否则探测占用者：**只有当占用进程确认是本工作台的陈旧实例时才结束它并在同一端口重试**（最多重试若干次）；若占用者是**非工作台进程**，为避免误杀会拒绝接管，报出占用 PID / 进程名让你手动处理。
- 注意：接管不是「端口自增」——它是「结束陈旧实例、在原端口重来」。

### 1.6 Win10/11 要求

Windows 10 / 11（或 Windows Server）；Node ≥ 20（打包 exe 自带运行时）；不要求公网、不要求 npm install。桌面控制、OCR、视觉匹配等能力另需 Python 桌面 MCP（见 2.3）。

---

## 2. 引擎接入

工作台围绕一套**引擎无关的事件协议**驱动前端，两条引擎路径并存，由 `config.activeProvider` 选择。

### 2.1 引擎 A · Claude CLI

`activeProvider` 为空或 `'claude-cli'`（默认）。spawn 内网 `claude` CLI，走 `stream-json`。相关配置：

- **`claudePath`**：CLI 可执行文件路径（留空则自动探测常见位置）。
- **内网代理 / 密钥（环境变量）**：模型发现走 `GET /v1/models`，其 baseUrl / key 取值优先级为——baseUrl：`config.modelsApiBase` → `ANTHROPIC_BASE_URL` → `ANTHROPIC_BASE`；apiKey：`config.modelsApiKey` → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY`。失败自动回退到内置模型清单。
- **`engineMode`**：`legacy`（stdin 关闭，单向，稳定）｜ `interactive`（stdin 常开，支持 AskUserQuestion 提问弹窗与权限桥接）。
- MCP 工具由 CLI 原生发现调用（工作台经 `mcp-config` / `install` 把自身 MCP 写进 CLI 配置）。

### 2.2 引擎 B · OpenAI 兼容 Provider

`activeProvider` = 某个 `providers[].id`。直连 HTTP + SSE 流式，自带**原生工具循环**（把本机 MCP 工具翻成 OpenAI function-calling，迭代上限 `openaiMaxToolIterations` 默认 12）。Provider 对象字段（经 `sanitizeProvider` 归一）：

| 字段 | 说明 |
|---|---|
| `id` / `label` | 标识 / 显示名 |
| `baseUrl` | 端点根地址 |
| `extraBaseUrls` | 备用端点数组（≤3，故障转移用，见下） |
| `apiKey` | 密钥（响应中掩码，见 §3） |
| `model` / `models` | 当前模型 / 可选模型清单 |
| `vision` / `reasoning` | 视觉回路开关 / 推理链开关 |
| `contextWindow` | 上下文窗口大小（触发自动压缩用） |
| `systemPrompt` | 追加到系统提示词的 provider 层 |
| `subagentModel` | 子代理专用模型（空 = 同主 model） |
| `temperature` / `extraHeaders` | 采样温度 / 额外请求头 |

内置预设：`deepseek`（api.deepseek.com）、`dashscope`（通义千问）、`glm`（智谱），也可手填任意 OpenAI 兼容 baseURL（内网 vLLM / Ollama / Xinference 等）。

**extraBaseUrls 备用端点故障转移语义（v1.0-S6）**——这是接入多端点时必须理解的一条：

- 候选序列为 `[baseUrl, ...extraBaseUrls]`（去重），**只在预首字节失败时切下一个**：
  - 连接类错误（ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH / ECONNRESET / TLS 握手失败）；
  - 响应头阶段的 HTTP **502 / 503 / 504**（上游网关不可用）。
- **不切换**的情况（归因保留，换端点无益或会掩盖真问题）：**4xx（含 401 / 403 / 404 / 422）、429 限流、以及 SSE 正文已开始流式之后的任何错误**（防重放）。
- 切换时发 `failover` 事件 `{type:'failover', providerId, from, to, reason}` 并落审计日志。
- **会话内粘住**：某端点成功后记为 sticky，下一轮优先试它；sticky 仅进程内内存、不持久化，进程退出即清。

### 2.3 桌面 MCP（ai-computer-control，ACC v1.5）

把本机的桌面控制 MCP（截图 / 控窗 / OCR / 键鼠 / 读写 Office / **write_pdf 中文字体链导出 PDF** 等，共 89 个工具）接进工作台，两条线：

- **供给 Claude CLI**：生成 `.mcp.json` 时把 `ai-computer-control` 与启用的 `externalMcpServers` 一并写入，CLI 原生调用。
- **供给 Provider 引擎**：开关 `bridgeExternalToolsToProvider` 打开时，同一批工具经**进程内 MCP stdio 客户端**桥接进原生工具循环。

自动探测 `detectDesktopMcp()`：认 `ai-computer-control` 仓库（存在 `src/ai_computer_control/server.py`），优先读 `AI_COMPUTER_CONTROL_HOME`，找到即用 `python -X utf8 -m ai_computer_control.server` 启动。config：`desktopMcp { enabled, command, args, cwd, autodetect }`。

**offline wheels 安装**：ACC 支持离线部署——`python installer/build_offline_package.py`（需联网一次）生成含嵌入式 Python + 全部 wheels + Playwright Chromium 的 zip，目标机解压跑 `install.bat` 即可，无需公网。可选依赖（uiautomation / winsdk / opencv / playwright / pynput / reportlab）缺失时对应工具优雅降级，不崩服务；`write_pdf` 的中文字体按「微软雅黑 → 宋体 → 内置 STSong-Light CID → Helvetica」顺序注册。

> 外部 MCP 桥接总开关即 `bridgeExternalToolsToProvider`：关闭时 Provider 引擎只见工作台自身工具。桥接工具的 tier 由 `BRIDGED_TOOL_TIERS` 判定（ACC 只读族 → read，其余默认 exec；`config.bridgedToolTiers` 可覆盖）。

---

## 3. 安全边界（重点）

工作台的安全模型照代码写实，以下每条都是生效机制。

### 3.1 权限四模式 × 工具 tier 门控

权限模式 `PERMISSION_MODES = ['default','acceptEdits','plan','bypass']`。每个工具有 tier：**read / edit / exec**（`NATIVE_TOOL_TIER` 映射：只读族如 `file_read`/`file_list`/`glob`/`git_status`/`git_diff`/`git_log`/`web_search`/`web_fetch`/`todo_write` 为 read；`file_write`/`file_edit`/`file_delete` 为 edit；`powershell_run`/`script_run`/`http_request`/`git_commit`/`spawn_agent`/`shell_start` 等为 exec）。门控 `nativeToolGate(mode, tier)`：

| 模式 | read | edit | exec |
|---|---|---|---|
| `bypass`（全自动） | 放行 | 放行 | 放行 |
| `default`（每步都问） | 放行 | 询问 | 询问 |
| `acceptEdits`（小改动自动做） | 放行 | 放行 | 询问 |
| `plan`（先计划再动手） | 放行 | 拦截 | 拦截 |

> `git_commit` 特意定为 **exec**（会触发 `.git/hooks` 里的任意代码，绝不下调）。计划模式的批准是**本 turn 闭包标志**，绝不改全局 `config.permissionMode`（防一次批准永久放权）。子代理 tier 还有执行期二次闸：即便被 bypass，read tier 子回合也写不成文件。

### 3.2 UI token 门

`/api/*` 的敏感路由需要注入 UI 页面的本地 header token（`x-wcw-token`，进程启动时生成、注入 HTML 的 `__WCW_TOKEN__` 占位，阻断同机其它进程），并校验同源。`needsToken` 白名单包含：`/api/tools/*`、`/api/checkpoints/*`（回滚）、`/api/session/rewind`、`/api/steer`、`/api/config`、`/api/provider/test`、`/api/playbooks*`、`/api/workspace/resolve`、`/api/pick-folder`、`/api/file/preview`、`/api/plan/decision`、`/api/audit`。例外：`/api/permission/request` 与 `/api/todo` 由子进程 loopback 调用，改用 **body token** 校验。新增 token 门端点必须显式扩这张白名单（表达式不自动覆盖新路径）。

### 3.3 SSRF 防护范围

`web_fetch` 的 url 是**模型 / 网页给的不可信输入**，经 `ssrfCheck` 硬防御：按字面 host 拒 loopback（`localhost`/`::1`/`0.0.0.0`）、私网（`10.`/`172.16-31.`/`192.168.`）、link-local 与云元数据（`169.254.169.254`）、IPv6 ULA / link-local、NAT64 `64:ff9b::/96`、IPv4-mapped IPv6 内嵌私网、`.local`/`.internal` 后缀；仅 http/https；重定向逐跳复验（≤3），且逐跳 `dns.lookup` 落私网即拒（关 DNS 重绑定）。

**关键区分**：**搜索后端 baseUrl 是管理员配置的可信端点，出站不过 SSRF**（管理员可能合法地把 web_search 指向内网 SearXNG 或企业搜索代理）。代码里对这两类做了显式注释区分——只有 web_fetch 的不可信 url 受限，搜索后端的受信端点放行。

### 3.4 密钥掩码

`providers[].apiKey` 与 `searchBackend.apiKey` 在响应里掩为 `••••<后4位>`（`maskSecrets`）。**响应永不回明文**。保存时 `unmaskSecrets`：若上送的 payload 是掩码形态，则**从当前已存 config 还原真 key**——即**把掩码原样回存不会覆盖真实密钥**；只有上送真正的新明文 key 才更新磁盘。

### 3.5 审计日志

`logEvent` 落 `dataRoot/logs/workbench-<day>.ndjson`（本地 NDJSON，永不外发）。`GET /api/audit`（需 token）只读聚合两源：workbench 日志 + 桌面 MCP 的 `audit_tail`，合并按时间降序、`limit` 钳 1..500。审计响应的 `detail` 全程经 `redact()` 脱敏——**秘钥永不进审计响应**。

### 3.6 检查点 / 回滚

每次改文件（`file_write`/`file_edit`/`file_delete`）**执行前**把原内容 gzip 存进 `checkpoints/<sessionId>/`（内置 zlib，零 npm；>5MB 只记条目不存内容）。安全网非闸门：journal 任何失败 try/catch 吞掉、**不阻断工具执行**。`GET /api/checkpoints` 读 index；`POST /api/checkpoints/rollback` 按 turn（可指定 entry）逆序回滚；`POST /api/session/rewind` 做对话级回溯。每会话留最近 20 个 turn，全局 200MB 惰性 GC。

### 3.7 零遥测 / 全离线 / clean-room

无任何遥测 / 分析 / 埋点出站调用；全部日志本地化到数据目录。唯一的可选出站探测是能力矩阵的一次 HEAD（对 `config.capabilityProbeUrl` 或 provider baseUrl，用于判在线 / 离线，非遥测；默认 `capabilityProbeUrl` 为空）。clean-room：不含 Anthropic 泄露源码、不分发官方 Claude CLI、不复制第三方插件源码；本体 Apache-2.0，前端静态库许可见根 `THIRD-PARTY-NOTICES.md`。

---

## 4. 专家模式面板

在顶栏 ⋯ 菜单 →「界面」切到专家模式后，右侧多出一组「开发者」页签：

- **终端**：一次性 PowerShell 运行框 + 持久 shell 会话族（`shell_start/send/poll/kill/list`，**Provider 引擎独占**——会话状态活在 serve 进程内存，一次性 MCP 子进程承载不了，故 Claude CLI 侧调用返回引导性错误）。
- **桌面**：浏览器打开 URL / 桌面截图等交接工具。
- **MCP**：本机 MCP 工具检查器，点开填参数直接运行某个工具。
- **调试**：原始事件流（stream-json）实时查看，可清空 / 下载 `.ndjson`——排障时抓真实事件样本的首选。
- **体检**：本机诊断面板（引擎路径、git/rg/python 探测、overlay 完整性、`/health` 等），部署后逐项应绿。

---

## 5. 验收与回归

回归脚手架在 `dev-harness/`（纯 Node、零 npm、离线）。

### 5.1 离线全绿跑法

每件 e2e 自成一体（spawn fake-openai / fake-mcp + workbench，断言，taskkill 清理，exit 0 = 全绿），逐件跑：

```powershell
node dev-harness\<name>.e2e.js      # 判定行形如 "<NAME> E2E: ALL PASS"
```

**判定看每件末尾的 `E2E:` 判定行**（`grep "E2E:"` 汇总）。离线件应 ALL PASS；**排除三件实弹件**（`deepseek-live` / `deepseek-tools` / `desktop-bridge-live`，它们打真端点 / 真 Python）。

### 5.2 实弹件与探针

- `deepseek-live` / `deepseek-tools`：需真 DeepSeek 密钥，`node dev-harness\deepseek-live.e2e.js <API_KEY> [model]`。
- `desktop-bridge-live`：需先 `pip install -e ai-computer-control`（真 Python 桌面 MCP）。
- `desktop-mcp-smoke`：需 `AI_COMPUTER_CONTROL_HOME` 指向 ACC 仓库（无 mcp 库时优雅 SKIP）。
- `model-tier-probe.js`：**分级模型实弹评测**（非离线回归）。`node dev-harness\model-tier-probe.js <KEY> <MODEL>`，对同一 agentic 场景组打不同档位模型，量化对比工具调用纪律 / 多步串联 / 抗幻觉 / 并行格式，产出「是否对小模型做针对性优化」的决策依据。密钥只走命令行 + 临时 HOME，finally 清理。

### 5.3 ACC smoke

```powershell
cd ai-computer-control
pip install -e .                        # 或用 requirements_offline.txt 离线装
python -X utf8 tests\smoke_registry.py  # 工具注册（89 工具）
python -X utf8 tests\smoke_stdio.py     # stdio 两种启动各全量（关键回归）
python -X utf8 tests\smoke_v13.py       # 语义 / 审计 / 降级
```

### 5.4 新模型接入验收建议

接一个新 Provider 模型时，先跑 `model-tier-probe.js` 的四场景（工具调用纪律 / 多步串联 / 抗幻觉 / 并行格式），据结果决定是否需要提示词分级减负、格式自纠重试、并发收紧或 loop-guard 阈值调整，再投生产。

---

## 6. 排障

| 症状 | 处理 |
|---|---|
| **端口占用** | 默认 8765 被占：若占用者是本工作台陈旧实例且 `killPortOnStart` 未禁用，会自动接管；若是非工作台进程则拒绝误杀，报出 PID / 进程名——换端口 `--port <n>` 或手动结束该进程。禁用了自动接管（`killPortOnStart=false` / `WCW_KILL_PORT=0`）时也需手动换端口。 |
| **引擎 401** | Claude CLI：检查 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 与 `ANTHROPIC_BASE_URL`（或设置里的模型接口 Base / 密钥）。Provider：检查 apiKey 是否有效。注意 **401 不触发端点故障转移**（归因保留），换备用端点无益，应先修密钥。 |
| **流断线 / failover 提示** | 前端收到 `failover` 事件即说明主端点预首字节不可用、已切备用（连接失败或 502/503/504）。若备用也不通会最终报错。SSE 正文已开始后的中断不会切端点（防重放），需重发本轮。 |
| **搜索后端不通** | 检查 `searchBackend.type` 与对应的 baseUrl（searxng/custom 必填）/ apiKey（bing/brave 必填，tavily 必填、bocha 可选）。搜索后端是**受信端点不过 SSRF**，但仍需网络可达。断网时 web_fetch 会回落本地 webcache（`fromCache:true`）。 |
| **PDF 字体 / CID 回退** | `write_pdf`（ACC 工具）在无微软雅黑 / 宋体的机器上会回退到内置 `STSong-Light`（CID，零外部文件，阅读器侧渲染中文），属**预期行为**；返回的 `font` 字段标明实际所用字体。reportlab 缺失则整个 `write_pdf` 优雅降级（不影响其它工具）。 |
| **性能 / 大会话** | 长会话渲染 v1.0-S7 已做消息虚拟化 / 分页；上下文接近窗口上限时自动 / 手动压缩（`autoCompactThreshold` 默认 0.8 × `contextWindow`），压缩前把 providerHistory 快照存 `checkpoints/<sid>/history-*.json.gz`。 |
| **权限弹窗超时** | 权限 / 提问弹窗默认 `permissionTimeoutMs`（120000ms）后**自动拒绝**（不替用户放权）；需要更长思考时间可调此配置。 |

---

## 附：品牌与兼容（v1.0-S9 发布工程）

对外产品名为「如意 Ruyi」。软品牌（UI 文案 / 标题 / 空态 / favicon / 环境变量 / 合规文件）与硬标识改名均已落地：**目录名** `win-claude-workbench/` → `ruyi-workbench/`、**可执行文件名** `WinClaudeWorkbench.exe` → `Ruyi.exe`（启动/检测脚本双名兼容旧名）、**版本** → `1.4.0`。以下**存量兼容标识有意保持不变**（存量接入破坏面，建议下一个大版本收口）：MCP server id `win-claude-workbench`、默认数据目录 `~/.win-claude-workbench`、环境变量 `WIN_CLAUDE_WORKBENCH_HOME`。

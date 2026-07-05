# 套用 如意 Ruyi（原 Win Claude Workbench）增量覆盖包（v0.4.2）

> 注：本文为 v0.4.2 历史覆盖包说明，其中的部署目录 `WinClaudeWorkbench-offline\` 与 `WinClaudeWorkbench.exe` 指**存量部署**的旧名（v1.0-S9 起新包产出 `Ruyi-offline\` / `Ruyi.exe`，启动/检测脚本双名兼容）。套用到旧部署时仍以你本地实际的目录/文件名为准。

> **v0.4.2 三项优化：**
> - **技能面板键盘操作**：搜索框内 `↑`/`↓` 选择、`Enter` 选中插入（鼠标悬停也会跟随高亮）。
> - **思维链解析更 robust**：同时兼容旧格式 `thinking`(enabled) 与新格式 `reasoning`/adaptive（Opus 4.8 等新模型），整块与流式增量都能显示,字段名有变化也能容错。
> - **思考预算说明**：设置里「思考预算」**留空=自适应(adaptive,新模型推荐)**,填数字=固定预算(enabled,老模型/老 CLI 才需要);「交错思维 beta」仅老 CLI 需要。请求用哪种格式由你的 CLI 版本决定(工作台无法改写),但无论哪种输出,思维链都能显示——若仍不显示,请用「调试」面板抓 `.ndjson` 看 CLI 到底吐没吐 thinking 块。


> **v0.4.1 修复三条内网使用反馈：**
> - **`spawn EINVAL`**（回复经常报错）:根因是现代 Node 拒绝以 shell:false 直接启动 `claude.cmd`/`.bat`。已改为遇到 .cmd/.bat 时经 `cmd.exe /d /s /c` 包装启动(已用真实 claude.cmd 实测通过)。
> - **长回复无法滚动**:消息区因 grid 项缺 `min-height:0` 会撑高被裁剪。已修,超长回复正常滚动、输入框始终可见。
> - **技能面板**:输入框新增「⌘ 技能」按钮(或空输入按 `/`、或 Ctrl+K),弹出可搜索的技能/命令列表(带简介),点选自动在输入行插入 `/命令名`。技能来自离线工具包与 `~/.claude/commands`。


> **v0.4 新增**（在 v0.3 基础上）：
> - **交互式对话引擎**（设置里「对话引擎」选 `interactive`）：保持 stdin 打开，支持 **AskUserQuestion 提问弹窗**、多轮回写。默认仍是 `legacy`（稳定单向），需要提问弹窗时再切。
> - **权限弹窗桥接**（设置里勾「权限弹窗桥接」，且权限模式选非 `bypass`）：Claude 调工具前弹窗让你允许/拒绝，可「本工具以后自动允许」。
> - **便利工具**：会话导出/导入、提示词模板、MCP 工具检查器（右侧「MCP」标签或 Ctrl+K）。
> - **安全加固**：`/api/*` 加了同源校验 + 令牌（令牌由服务端注入页面，对你透明）；密钥脱敏、看门狗防卡死、防串话等一批修复。
> - Python 桌面工具见另一个包 `ai-computer-control-update-v1.2.zip`。



> 面向内网机上的操作者/AI。全程**无需联网、无需编译工具链**。覆盖包已内置所需的一切（含本地 markdown / 代码高亮库）。

## 这份覆盖包做了什么
把工作台前端升级为：真·流式输出、思维链(thinking)折叠面板、工具调用卡片、Markdown+代码高亮、模型/权限下拉切换、停止按钮与进程状态、会话搜索/改名/删除/置顶、深色模式、命令面板(Ctrl+K)、原始事件调试面板、体检(doctor)与 `/health`、密钥脱敏、结构化日志等。

**关键机制**：新的 `Start-Workbench.cmd` 改为用自带的 `runtime\node\node.exe` 运行 `app\server.js`（绕过被烤进旧 `WinClaudeWorkbench.exe` 的旧代码），因此**改动免重编即生效**。`server.js` 只用 Node 内置模块，零 npm 依赖。

## 前置检查
目标部署目录应形如 `...\WinClaudeWorkbench-offline\`，其中含 `runtime\node\node.exe` 与 `app\`。若只有 `WinClaudeWorkbench.exe` 也可套用，但强烈建议目录内保留 `runtime\node\node.exe`（覆盖包不含 node 运行时，沿用你部署包里已有的那个）。

## 套用步骤
1. 关闭正在运行的工作台（结束其 `node.exe` / `WinClaudeWorkbench.exe` 进程，释放端口 8765）。
2. 把本覆盖包解压到任意临时目录，例如 `C:\tmp\workbench-overlay-v0.3\`。
3. 在该目录执行（把路径换成你的真实部署目录）：
   ```cmd
   Manage-Overlay.cmd apply "D:\你的部署目录\WinClaudeWorkbench-offline"
   ```
   脚本会：**先备份**目标里将被覆盖的文件到 `目标\.overlay-backups\<版本>-<时间>\`，再复制新文件覆盖，写入 `.overlay-applied.json`，并**用 sha256 逐个校验**（VERIFY OK 即成功）。只保留最近 5 份备份。
4. 重新启动：
   ```cmd
   "C:\...\WinClaudeWorkbench-offline\Start-Workbench.cmd"
   ```
   启动日志应显示 `(launch: node, overlay <id>)`；否则说明仍在跑旧 exe（见“排错”）。
5. （可选，若要让 Claude CLI 调用工作台 MCP 工具的新增能力）重新注册 MCP：
   ```powershell
   powershell -ExecutionPolicy Bypass -File "C:\...\WinClaudeWorkbench-offline\resources\scripts\install-workbench.ps1" -ClaudePath "D:\intranet\claude\claude.cmd"
   ```
   新脚本会用 `node app\server.js mcp-config` 生成指向 node 源码的配置并注册。

## 验证
- 浏览器打开 `http://127.0.0.1:8765/health` → 应返回 `{"ok":true,"launchMode":"node",...}`。
- UI 右侧「体检」标签：各项应为绿色；`server-source` 指向 `app\server.js`，`mcp-target` 显示 `node: ...`，`overlay-integrity` 显示 `verified`。
- **无 claude 也能自测渲染**：用自带的假 CLI 跑一遍（不影响正式配置）——
  ```cmd
  set WCW_FAKE_CLAUDE=C:\...\WinClaudeWorkbench-offline\tools\fake-claude.js
  "C:\...\WinClaudeWorkbench-offline\runtime\node\node.exe" "C:\...\WinClaudeWorkbench-offline\app\server.js" serve --open
  ```
  然后在对话框发送包含关键词 `tools` / `thinking` / `error` 的消息，即可看到工具卡片 / 思维链 / 错误的渲染。测完关掉、正常用 `Start-Workbench.cmd` 启动即可。
- **有 claude 时**：正常发消息，验证 流式 / thinking / 工具卡片 / 模型切换 / 停止 / 断开结束子进程。

### 抓取真实事件样本（重要）
本前端对 stream-json 事件做了**容错解析**，但 thinking / AskUserQuestion / 权限工具的确切字段官方未完全文档化。请在「调试」标签点 **下载 .ndjson**，把一次真实回合的原始事件发回给开发者，用于校准后续 v2/v3（AskUserQuestion 弹窗、权限桥接）。

## 回滚
```cmd
Manage-Overlay.cmd rollback "C:\...\WinClaudeWorkbench-offline"
```
（会拒绝在服务运行时回滚；先关进程。新“增加”的文件如 vendor 库会留下，无害。）

## 排错
- **启动日志显示 launch: exe / 改动没生效**：说明它跑了旧 exe。确认 `Start-Workbench.cmd` 已被覆盖为新版；或临时用上面“假 CLI 自测”里的 node 直启命令。也可设 `set WCW_FORCE_EXE=1` 强制走 exe（一般不需要）。
- **CLI 找不到**：UI 右上「设置」里填 `claudePath`，或它会自动扫描常见安装位。
- **`--include-partial-messages` 报未知参数**（老版本 CLI）：设置里关掉「实时流式」即可，仍可用整段流式。
- **thinking 不显示**：多为模型/CLI 未产出 thinking 块；可在设置里试开「交错思维 beta」并设「思考预算」。若仍无，用调试面板确认原始事件里是否有 thinking 块。
- **权限模式**：`bypass` = 跳过所有权限（原行为）。切到 `default/acceptEdits/plan` 会让 CLI 走权限流程；交互式权限弹窗在后续 v3 覆盖包提供。

# MCP 连接器 —— 文件夹即插即用（drop-in）

English: [MCP Connectors: Folder Drop-ins](README_EN.md)

把一个 MCP 服务器做成「一个文件夹 + 一份清单」，放进本目录（或用户数据目录 `<数据目录>/mcp/`），
如意 Ruyi 工作台启动时会自动扫描、清洗并把它合并进外部 MCP 列表——**无需改配置、无需重启导入向导**。
删掉该文件夹即等于卸载（drop-in 的存在性完全由文件夹本身表达，从不写回配置文件）。

扫描位置（两处，各自最多合并 10 个，合计上限 10）：

- `<发行包根>/mcp/*/ruyi-mcp.json` —— 随发行包分发的连接器（本目录）。
- `<数据目录>/mcp/*/ruyi-mcp.json` —— 用户自装的连接器（`RUYI_HOME` 或默认 `~/.win-claude-workbench/mcp/`）。

## 内置桌面控制 MCP：`ai-computer-control/`

本目录下的 `ai-computer-control/` 是**随发行包捆绑的内置桌面控制 MCP**（99 工具：截图、OCR、UIA 定位、鼠标键盘、窗口、文件、Office/PDF 等）。它由工作台的**专用桌面探测**（`desktopMcp` 探测）直接识别并优先加载，**不需要、也不要**给它加 `ruyi-mcp.json` 清单——否则会与专用探测形成**双注册**（同一批工具被登记两次）。

专用探测会先验证候选 Python 能导入 ACC；发现缺依赖的嵌入运行时会跳过并回退到可用 Python。也会识别官方安装器默认写入的 `%LOCALAPPDATA%\ai-computer-control\venv\Scripts\python.exe`。发行包中的 `-IncludeAcc` 仅带源码和安装器；离线机器若没有可用 Python/依赖，仍需使用 ACC 的独立离线安装包。

也就是说：

- `ai-computer-control/` → 由专用桌面探测直接识别，**无清单**。
- 本目录下**其余**连接器文件夹 → 才走下面的 drop-in 清单（`ruyi-mcp.json`）流程。

## 清单怎么写

在你的连接器文件夹里放一个 `ruyi-mcp.json`，最小形态如下（`id` 与 `command` 必填）：

```json
{
  "id": "my-connector",
  "label": "我的连接器",
  "command": "node",
  "args": ["server.js"],
  "env": { "SOME_TOKEN": "xxxxx" },
  "enabled": true
}
```

字段说明：

- `id`（必填）：唯一标识，只保留字母/数字/下划线用于工具名前缀，≤64 字符。
- `label`：人话显示名，缺省用 `id`。
- `command`（必填）：启动 MCP 服务器的可执行文件（如 `node`、`python`、`./server.exe`）。
- `args`：命令行参数数组（字符串），≤50 个。
- `env`：注入子进程的环境变量（键 ≤120 字符、值 ≤2048 字符）。
- `cwd`：工作目录；**缺省即清单所在文件夹**，所以 `command`/`args` 里可用相对路径（如 `./server.exe`）。
- `enabled`：设为 `false` 可临时禁用该连接器而不删文件夹。

## 与「导入文件夹」的关系

工作台设置里的「从文件夹导入 MCP」（`/api/mcp/import-folder`）读的是同一份 `ruyi-mcp.json`，但走**持久化**路径——
把条目写进配置文件，重启保留、需手动移除。二者互补：

- 想让一个连接器**跟着发行包/数据目录走、删文件夹即卸载** → 用 drop-in（本目录）。
- 想让一个连接器**长期固定在配置里** → 用「导入文件夹」。

`id` 冲突时，配置里的显式条目（含导入进去的）优先，drop-in 自动跳过并在审计里记一条提示。

## 社区贡献

欢迎把常用连接器做成一个自带 `ruyi-mcp.json` 的文件夹提交到本目录；请在文件夹内附一句话说明用途与所需环境变量，
不要把真实密钥写进清单（用占位符，让使用者自己填 `env`）。

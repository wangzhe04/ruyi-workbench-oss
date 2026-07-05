# 套用 ai-computer-control 增量更新（v1.1，桌面控制 MCP）

> 面向内网机操作者/AI。**代码更新无需联网、无需重装**——直接热覆盖已安装 venv 里的 .py。

## 本次新增/修复
- **安全护栏（重要 bug 修复）**：`kill_process` 原来用**子串匹配**，`name="s"` 会误杀所有含 "s" 的进程。现改为**精确基名匹配**（`contains=true` 才用子串）、**关键系统进程 denylist**（lsass/csrss/... 拒杀,`allow_critical` 覆盖）、**多进程匹配需 `confirm=true`**。`delete_file` 拒删系统保护根（Windows/Program Files/盘根等,`allow_protected` 覆盖）。`run_command` 拒执行明显破坏性命令(format/rmdir /s/Remove-Item -Recurse -Force/shutdown/reg delete HKLM 等,`allow_dangerous` 覆盖)。
- **`batch_actions` / `macro_run`**：一次调用里按顺序跑多个工具,`on_error=stop|continue`,减少往返;每步独立 try/except,返回结构化结果。
- **窗口/屏幕/剪贴板/音频（纯 ctypes/pyautogui/PIL/winsound,无需新依赖）**：`wait_for_window`、`wait_for_window_idle`、`get_pixel_color`、`get_clipboard_image`、`list_monitors`、`get_dpi_info`、`beep`、`notify_attention`、`play_sound`。启动时设 **Per-Monitor-V2 DPI 感知**,坐标更一致。
- **UI Automation 可达性树（可选,需 `uiautomation` 库）**：`ui_inspect`（转储控件树+中心坐标）、`ui_find`（按名称/类型/AutomationId 找控件）、`ui_invoke`（invoke/click/set_value/focus/toggle/expand）。**语义优先、像素兜底**——找不到就返回中心坐标供 `mouse_click`。若未装 `uiautomation`,这三个工具会返回安装提示而**不会**导致服务启动失败。

## 套用（代码更新,推荐,秒级,无需联网）
1. 关闭/重启会用到该 MCP 的 Claude(它下次调用时会重启 MCP 子进程)。
2. 把本更新包解压到临时目录,里面应有 `update.bat` 和 `ai_computer_control\` 源码树。
3. 运行:
   ```cmd
   update.bat --code
   ```
   它把新 `.py` 热覆盖到 `%LOCALAPPDATA%\ai-computer-control\venv\Lib\site-packages\ai_computer_control\`,并写入 `VERSION.txt`。
4. 让 Claude 重新调用任一工具即可生效（或重启 Claude）。**安全护栏 + batch + 窗口/屏幕/音频等 13 个新工具即刻可用,无需任何新依赖。**

## 启用 UI Automation（可选,需要 uiautomation 库）
`ui_*` 工具需要 `uiautomation`(+`comtypes`)。二选一:
- **有 wheels\ 目录**(内含 uiautomation/comtypes 的 .whl)时:
  ```cmd
  update.bat --deps
  update.bat --code
  ```
  `--deps` 用本地 wheels 离线安装,不联网。
- **重打完整离线包**(联网机上):`requirements_offline.txt` 已加入 `uiautomation`/`comtypes`,重跑 `python installer\build_offline_package.py` 即含这两个 wheel,再在内网机重装。

不装也无妨——`ui_*` 会返回“uiautomation not installed”的提示,其余工具照常。

## 验证
让 Claude 调用几个新工具:
- `list_monitors`（应返回显示器数量+主屏）、`get_dpi_info`（awareness 应为 per-monitor-v2）。
- `kill_process name="notepad"`（先开个记事本）——应精确命中;试 `kill_process name="s"` 应**不再**误杀一片,而是要么无匹配、要么要求 `confirm`。
- `batch_actions actions=[{"tool":"get_system_info","args":{}},{"tool":"get_mouse_position","args":{}}]`。
- 若装了 uiautomation:`ui_inspect`（前台窗口控件树）、`ui_find name="..."`。

## 回滚
热覆盖前建议先备份 `...\site-packages\ai_computer_control\`。要回滚,把备份拷回该目录即可（或重跑旧版 `update.bat --code`）。

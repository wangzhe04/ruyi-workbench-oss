---
name: Windows 桌面操控
description: 通过工作台 MCP 操控 Windows 工作站(截图/控窗)
---

# Windows Control

Use this skill when the user wants Claude to operate a Windows workstation through Ruyi Workbench: the `ruyi` MCP server (tools appear as `mcp__ruyi__<name>` in Claude Code) plus the desktop control MCP for windows, UI Automation, and OCR.

Workflow:

1. Find tools with `list_tools` (directory by pack) or `tool_search` (by capability, e.g. "focus window"). Call a found tool directly if it is visible; otherwise go through `tool_invoke_read` / `tool_invoke_edit` / `tool_invoke_exec` with `{name, arguments}`. Desktop control tool names may carry a server prefix; use the exact name the search returns.
2. Prefer `file_read`, `file_write`, `file_edit`, `file_list`, and `file_search` for filesystem work.
3. Use `powershell_run` for one-shot Windows-native operations (package checks, registry queries, service status, process inspection) and `script_run` for multi-line Python, Node, or PowerShell scripts.
4. Windows: `list_windows` and `get_active_window` show what is open; `focus_window` (pass `handle` when several titles match) and check `foreground_verified` before typing or clicking; `wait_for_window` after launching an app.
5. Controls: locate with `ui_inspect` / `ui_find`, then act with `ui_invoke` (invoke, click, set_value, toggle, expand). This is more reliable than coordinates or raw keys.
6. `keyboard_send_keys` goes to whatever window has focus. SendKeys meta characters (`+ ^ % ~ ( ) { } [ ]`) are live by default; pass `literal: true` to type ordinary text. Keep sequences short.
7. Check the UI before and after each step. `desktop_screenshot` helps only if the model can read images; otherwise use text views: `ui_inspect`, `ocr_screen` / `ocr_find_text`, or `observe` with `include_screenshot: false`.

Safety:

- Prefer reading state first.
- Before anything that deletes, sends, submits, pays, or confirms, ask the user and wait for a clear yes. Announcing what you are about to do is not consent.
- Never type passwords, verification codes, or payment details on the user's behalf; ask the user to enter them.
- Avoid deleting recursively unless the path is absolute and clearly inside the intended workspace.

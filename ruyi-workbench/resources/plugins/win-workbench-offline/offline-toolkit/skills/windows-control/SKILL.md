# Windows Control

Use this skill when the user wants Claude to operate a Windows workstation through the `win-claude-workbench` MCP server.

Workflow:

1. Check available tools with `tools/list` if the client exposes it.
2. Prefer `file_read`, `file_write`, `file_edit`, `file_list`, and `file_search` for filesystem work.
3. Use `powershell_run` for Windows-native operations, package checks, registry queries, service status, and process inspection.
4. Use `script_run` for multi-line Python, Node, or PowerShell scripts instead of packing long commands into one shell line.
5. Use `desktop_screenshot` before and after UI operations when the visual state matters.
6. Use `keyboard_send_keys` only when the active window is known. Keep keystroke sequences short and verify with a screenshot.

Safety:

- State which directory or app will be touched before destructive changes.
- Prefer reading state first.
- Avoid deleting recursively unless the path is absolute and clearly inside the intended workspace.

---
name: 前端审计
description: 审计前端的离线就绪度与界面风险
---

# Frontend Audit

Audit the frontend for offline readiness and UI risks.

Steps:

1. Call `dependency_inventory`.
2. Call `frontend_audit`.
3. Inspect the app's main pages/components.
4. If safe, start the local dev server as a background job (it never exits, so a one-shot `powershell_run` would only hit its timeout): `shell_start` with `command` on the workbench provider engine (stop it later with `shell_kill`), or the agent CLI's own background shell.
5. `browser_open` the local URL and take a `desktop_screenshot`. It captures the whole primary screen at the current window size (no viewport control), so report which widths you actually checked; in Claude Code the result is text with the PNG `path` - open that file with Read to see it.
6. Report asset, layout, accessibility, and offline dependency issues.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use Grep and Read for the audit and a background Bash command for the dev server.

---
name: 前端审计
description: 审计前端的离线就绪度与界面风险
---

Platform boundary: on macOS, system browser_open only requests URL handoff and does not verify navigation. Mac desktop_screenshot/OCR/resize_window are not implemented. For DOM screenshots use an explicitly configured managed/custom/CDP/bundled target with prepared local dependencies, verify browser_backend_status and the actual target URL, and use browser_screenshot. Never change the target implicitly or close unowned CDP pages. Test narrow widths only through an actually available isolated Playwright viewport capability; otherwise report them unverified. Scaling a screenshot is not testing a narrow viewport. The desktop screenshot/window steps below apply only to Windows.

# Frontend Audit

Audit the frontend for offline readiness and UI risks.

Steps:

1. Call `dependency_inventory`.
2. Call `frontend_audit`.
3. Inspect the app's main pages/components.
4. If safe, start the local dev server as a background job (it never exits, so a one-shot `powershell_run` would only hit its timeout): `shell_start` with `command` and a large `timeoutMs` on the workbench provider engine (the background command is killed at its deadline, 30 minutes by default; stop it later with `shell_kill`), or the agent CLI's own background shell.
5. On Windows with an available desktop backend, `browser_open` the local URL and take a `desktop_screenshot`. It captures the whole primary screen at the current window size; to check a narrow layout, resize the browser window with the desktop control `resize_window` (width, height, title) and screenshot again, and report which widths you actually checked; in Claude Code the result is text with the PNG `path` - open that file with Read to see it.
6. Report asset, layout, accessibility, and offline dependency issues.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use Grep and Read for the audit and a background Bash command for the dev server.

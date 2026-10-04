---
name: 前端设计精修
description: 新做或打磨前端界面的视觉与交互，只用本地资源
---

# Frontend Design Craft

Use this skill when building a new frontend UI or polishing the look and interaction of an existing one in an offline Windows environment. For a page that is already broken (errors, blank screen, failed requests), use browser-debug.

Inspired by the popular Claude plugin category for frontend design, but implemented as local-only guidance plus Workbench tools.

Workflow:

1. Use `project_snapshot` and `dependency_inventory` to understand the app stack.
2. Use `frontend_audit` before and after edits to catch offline CDN usage, viewport issues, font scaling, and generic visual patterns.
3. Avoid CDN fonts, icon CDNs, remote images, hosted JS, and remote CSS. Bundle assets locally.
4. Prefer the app's existing component system and icons. If none exists, use simple HTML/CSS with local assets.
5. Run the dev server in the background, not with `powershell_run` (one-shot; it kills the process tree on timeout): `shell_start` with `command` and a large `timeoutMs` under the Workbench provider engine, or under Claude Code (whose Bash is Git Bash) `powershell -NoProfile -Command "Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory '<project>' -WindowStyle Hidden -PassThru | Select-Object Id"` and `Stop-Process -Id <Id>` when done. Poll the URL with `http_request` until it answers.
6. Open the page with `browser_open`. The workbench's own one returns before the page has loaded, so wait (desktop control `wait_for_window` with the page title, or a few seconds) before verifying with `desktop_screenshot`; the desktop control MCP's `browser_open` in managed mode waits for the load and lets `browser_screenshot` / `browser_get_text` inspect that page. Check narrow widths with desktop control `resize_window`.
7. For fixed UI controls, use stable dimensions, responsive constraints, and text wrapping. Do not let labels resize boards, toolbars, or tiles.

Output expectations:

- Mention the files changed.
- Include the local URL or file path that was verified.
- Report any offline asset risks found by `frontend_audit`.

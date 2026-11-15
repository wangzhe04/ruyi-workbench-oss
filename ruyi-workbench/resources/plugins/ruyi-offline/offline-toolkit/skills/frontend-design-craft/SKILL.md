---
name: 前端设计精修
description: 新做或打磨前端界面的视觉与交互，只用本地资源
---

Platform selection: on macOS prefer shell_start/shell_poll for the provider engine or the CLI background facility. Windows PowerShell examples do not apply. Default browser opening on Mac only hands off a URL; it does not prove navigation or permit DOM control. Mac desktop screenshot/OCR/resize is not implemented. For automated visual checks use an explicitly configured, prepared Playwright DOM backend and verify its actual attachment; if absent report visual checks unperformed.

# Frontend Design Craft

Use this skill when building a new frontend UI or polishing the look and interaction of an existing one in an offline Windows or supported macOS source environment. For a page that is already broken (errors, blank screen, failed requests), use browser-debug.

Inspired by the popular Claude plugin category for frontend design, but implemented as local-only guidance plus Workbench tools.

Workflow:

1. Use `project_snapshot` and `dependency_inventory` to understand the app stack.
2. Use `frontend_audit` before and after edits to catch offline CDN usage, viewport issues, font scaling, and generic visual patterns.
3. Avoid CDN fonts, icon CDNs, remote images, hosted JS, and remote CSS. Bundle assets locally.
4. Prefer the app's existing component system and icons. If none exists, use simple HTML/CSS with local assets.
5. Run the dev server in the background, not with `powershell_run` (one-shot; it kills the process tree on timeout): `shell_start` with `command` and a large `timeoutMs` under the Workbench provider engine, or under Claude Code on Windows (whose Bash is Git Bash) `powershell -NoProfile -Command "Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory '<project>' -WindowStyle Hidden -PassThru | Select-Object Id"` and `Stop-Process -Id <Id>` when done. Poll the URL with `http_request` until it answers.
6. For DOM checks use an explicitly configured managed/custom/CDP/bundled browser target, check browser_backend_status, open the page, then verify actual attachment and page content before taking browser_screenshot. Inspect tabs and target URLs in CDP; never navigate the Workbench tab or close unowned pages. System browser_open only requests URL handoff. Windows with a desktop backend may wait_for_window, desktop_screenshot and resize_window; Mac has no such desktop backend. For narrow-width tests on Mac use an available isolated Playwright viewport script, or report those checks unperformed. Scaling a screenshot is not testing a narrow viewport.
7. For fixed UI controls, use stable dimensions, responsive constraints, and text wrapping. Do not let labels resize boards, toolbars, or tiles.

Output expectations:

- Mention the files changed.
- Include the local URL or file path that was verified.
- Report any offline asset risks found by `frontend_audit`.

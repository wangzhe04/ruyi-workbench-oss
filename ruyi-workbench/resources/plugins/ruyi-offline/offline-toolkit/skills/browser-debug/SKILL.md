---
name: 网页调试
description: 排查已经出问题的本地网页：报错、白屏、布局错位、页面发出的接口请求失败
---

# Browser Debug

Use this skill when a local web app, HTML file, or intranet page is already broken: errors, a blank page, a misaligned layout, or requests from the page failing. For building or polishing UI, use frontend-design-craft; for a backend API on its own, use api-debugger.

Workflow:

1. Make sure the server is running. A dev server never exits, so do not start it with `powershell_run`: that is one-shot and kills the whole process tree when it times out.
   - Workbench provider engine: `shell_start` with `command` (e.g. `npm run dev`), then read its output with `shell_poll`. The `shell_*` tools do not work under Claude Code.
   - Claude Code: start it detached, e.g. `Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory <project> -WindowStyle Minimized`.
   - Either way, poll the URL with `http_request` until it answers before going further.
2. Reproduce: read the server output and logs, and call failing endpoints directly with `http_request` to see the status code and body.
3. Open the page with `browser_open` (URL or local HTML path). It returns as soon as the browser starts, not when the page has loaded: wait first (desktop control MCP `wait_for_window` with the page title, or a few seconds of `Start-Sleep`), then take `desktop_screenshot`.
4. If the desktop control MCP drives its browser in managed/custom/CDP mode (check `browser_backend_status`), `browser_get_text`, `browser_execute_js`, and `browser_screenshot` inspect the page directly; in system mode use screenshots and OCR (`ocr_screen`).
5. Fix the cause, then verify again the same way; check a narrow viewport too when layout is involved.
6. If automation is needed, write a short PowerShell or Node script with `script_run`; keep it in the generated folder when it may need reuse.

Offline note:

Do not assume CDN assets or internet fonts will load. A blank page or missing styles offline is often a remote asset; `frontend_audit` lists them.

---
name: 网页调试
description: 排查已经出问题的本地网页：报错、白屏、布局错位、页面发出的接口请求失败
---

# Browser Debug

Use this skill when a local web app, HTML file, or intranet page is already broken: errors, a blank page, a misaligned layout, or requests from the page failing. For building or polishing UI, use frontend-design-craft; for a backend API on its own, use api-debugger.

Workflow:

1. Make sure the server is running. A dev server never exits, so do not start it with `powershell_run`: that is one-shot and kills the whole process tree when it times out.
   - Workbench provider engine: `shell_start` with `command` (e.g. `npm run dev`) and a large `timeoutMs` (the background command is killed at its deadline, 30 minutes by default), then read its output with `shell_poll`. The `shell_*` tools do not work under Claude Code.
   - Claude Code: its Bash tool is Git Bash, so run PowerShell explicitly and keep the logs, e.g. `powershell -NoProfile -Command "Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory '<project>' -WindowStyle Hidden -RedirectStandardOutput '<project>\dev.out.log' -RedirectStandardError '<project>\dev.err.log' -PassThru | Select-Object Id"`. Note the Id and stop it afterwards with `Stop-Process -Id <Id>`.
   - Either way, poll the URL with `http_request` until it answers before going further.
2. Reproduce: read the server output (`shell_poll`, or the two log files) and call failing endpoints directly with `http_request` to see the status code and body.
3. Look at the page. There are two tools named `browser_open`:
   - the workbench's own `browser_open` opens the system default browser and returns as soon as it starts: wait (desktop control `wait_for_window` with the page title, or a few seconds), then `desktop_screenshot` and OCR (`ocr_screen`). Nothing can read that page's DOM.
   - the desktop control MCP's `browser_open` drives its own browser. In managed / custom / CDP mode (see `browser_backend_status`) it waits for the page to load, and `browser_get_text`, `browser_execute_js` and `browser_screenshot` then work on that page. They only see pages this tool opened.
4. Fix the cause, then verify again the same way. When layout is involved, also check a narrow window: desktop control `resize_window` (width, height, title) and screenshot again.
5. If automation is needed, write a short PowerShell or Node script with `script_run`; keep it in the generated folder when it may need reuse.

Offline note:

Do not assume CDN assets or internet fonts will load. A blank page or missing styles offline is often a remote asset; `frontend_audit` lists them.

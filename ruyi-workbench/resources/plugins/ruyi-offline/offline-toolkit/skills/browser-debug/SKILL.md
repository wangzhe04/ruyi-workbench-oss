---
name: 网页调试
description: 排查已经出问题的本地网页：报错、白屏、布局错位、页面发出的接口请求失败
---

Platform selection: on macOS use shell_run or script_run(language="bash"/"node"/"python"); Claude Code uses the host shell, not Git Bash. Run a dev server through the CLI background facility and retain its owned process identity/logs; stop only that process tree afterwards. The Windows PowerShell/Git Bash examples below apply only to Windows. Mac system browser_open is URL handoff only, with no verified page load or DOM attachment. Mac desktop/OCR/UIA/resize tools are not implemented. For DOM work use an explicitly configured managed/custom/CDP/bundled target after browser_backend_status; verify ready and page text after browser_open. A package or binary being installed alone is not readiness; do not download at runtime or change the target without the user asking. Resize a Playwright viewport only through a capability that is actually offered.

# Browser Debug

Use this skill when a local web app, HTML file, or intranet page is already broken: errors, a blank page, a misaligned layout, or requests from the page failing. For building or polishing UI, use frontend-design-craft; for a backend API on its own, use api-debugger.

Workflow:

1. Make sure the server is running. A dev server never exits, so do not start it with `powershell_run`: that is one-shot and kills the whole process tree when it times out.
   - Workbench provider engine: `shell_start` with `command` (e.g. `npm run dev`) and a large `timeoutMs` (the background command is killed at its deadline, 30 minutes by default), then read its output with `shell_poll`. The `shell_*` tools do not work under Claude Code.
   - Claude Code on Windows: its Bash tool is Git Bash, so run PowerShell explicitly and keep the logs, e.g. `powershell -NoProfile -Command "Start-Process npm.cmd -ArgumentList 'run','dev' -WorkingDirectory '<project>' -WindowStyle Hidden -RedirectStandardOutput '<project>\dev.out.log' -RedirectStandardError '<project>\dev.err.log' -PassThru | Select-Object Id"`. Note the Id and stop it afterwards with `Stop-Process -Id <Id>`.
   - Either way, poll the URL with `http_request` until it answers before going further.
2. Reproduce: read the server output (`shell_poll`, or the two log files) and call failing endpoints directly with `http_request` to see the status code and body.
3. Look at the page. There are two tools named `browser_open`:
   - the workbench's own `browser_open` only requests system URL handoff. On Windows with a desktop backend: wait (desktop control `wait_for_window` with the page title, or a few seconds), then `desktop_screenshot` and OCR (`ocr_screen`). This handoff does not attach DOM control. On Mac, stop here unless a DOM backend has been explicitly configured.
   - the desktop control MCP's `browser_open` drives its own browser. In managed / custom / CDP / bundled mode (see `browser_backend_status`) it waits for the page to load, and `browser_get_text`, `browser_execute_js` and `browser_screenshot` then work on that page. Owned modes use isolated profiles; explicitly configured CDP may also see existing pages. Inspect tabs and verify the target URL before reading or changing an existing CDP page. Never close unowned pages or navigate the Workbench tab.
4. Fix the cause, then verify again the same way. When layout is involved, test narrow widths. On Windows use desktop control `resize_window` (width, height, title). On Mac only use a prepared Playwright viewport capability or an isolated owned Playwright script when available; otherwise report narrow-width checks unperformed. Scaling a screenshot is not a viewport test.
5. If automation is needed, write a short PowerShell or Node script with `script_run`; keep it in the generated folder when it may need reuse.

Offline note:

Do not assume CDN assets or internet fonts will load. A blank page or missing styles offline is often a remote asset; `frontend_audit` lists them.

---
name: 网页调试
description: 在 Windows 上验证本地网页、HTML 与前端产物
---

# Browser Debug

Use this skill when validating local web apps, HTML files, intranet pages, or generated frontend artifacts on Windows.

Workflow:

1. Start or inspect the local dev server with `powershell_run`.
2. Use `browser_open` for `http://localhost:...`, intranet URLs, or local HTML paths.
3. Use `desktop_screenshot` after opening the page to verify that the browser rendered the target.
4. If automation is needed, create a short PowerShell or Node script with `script_run`; keep the script in the generated folder when it may need reuse.
5. For local apps, verify both a desktop-sized window and a narrow viewport when possible.

Offline note:

Do not assume CDN assets or internet fonts will load. Prefer bundled assets and local dependencies.

---
name: 前端设计精修
description: 离线环境下构建或审查前端界面的设计指引
---

# Frontend Design Craft

Use this skill when building or reviewing frontend UI in an offline Windows environment.

Inspired by the popular Claude plugin category for frontend design, but implemented as local-only guidance plus Workbench tools.

Workflow:

1. Use `project_snapshot` and `dependency_inventory` to understand the app stack.
2. Use `frontend_audit` before and after edits to catch offline CDN usage, viewport issues, font scaling, and generic visual patterns.
3. Avoid CDN fonts, icon CDNs, remote images, hosted JS, and remote CSS. Bundle assets locally.
4. Prefer the app's existing component system and icons. If none exists, use simple HTML/CSS with local assets.
5. Start or inspect the dev server with `powershell_run`; open the page with `browser_open`; verify with `desktop_screenshot`.
6. For fixed UI controls, use stable dimensions, responsive constraints, and text wrapping. Do not let labels resize boards, toolbars, or tiles.

Output expectations:

- Mention the files changed.
- Include the local URL or file path that was verified.
- Report any offline asset risks found by `frontend_audit`.

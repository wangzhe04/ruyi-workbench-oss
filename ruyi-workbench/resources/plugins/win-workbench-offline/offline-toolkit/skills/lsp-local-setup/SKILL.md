---
name: 本地语言智能
description: 无需下载扩展，配置或排查本地语言智能(LSP)
---

# LSP Local Setup

Use this skill to configure or troubleshoot local language intelligence without downloading extensions.

Workflow:

1. Detect project languages with `project_snapshot` and `dependency_inventory`.
2. Look for already-bundled language servers under `node_modules/.bin`, `.venv`, `vendor`, `tools`, or configured IDE paths.
3. Prefer local project binaries over global binaries.
4. Generate editor or tool config only when paths are known and portable inside the offline package.
5. Verify by running the language server with a version/help command when available.

Examples:

- TypeScript: local `node_modules/.bin/tsserver` or `typescript-language-server` if bundled.
- Python: local `pyright`, `ruff`, or `pylsp` only if already installed.
- C/C++: local `clangd` from a bundled LLVM toolchain.

Do not install extensions from the internet during setup.

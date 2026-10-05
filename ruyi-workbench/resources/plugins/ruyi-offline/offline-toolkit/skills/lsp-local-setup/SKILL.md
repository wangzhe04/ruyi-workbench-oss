---
name: 本地语言智能
description: 无需下载扩展，配置或排查本地语言智能(LSP)
---

# LSP Local Setup

Use this skill to configure or troubleshoot local language intelligence without downloading extensions.

Everything below must already be installed offline (project dependencies, a bundled toolchain, or the offline package). Never run npm/pip installs during setup; report what is missing instead.

Workflow:

1. Detect project languages with `project_snapshot` and `dependency_inventory`.
2. Look for already-installed language servers under `node_modules\.bin`, `.venv\Scripts`, `vendor`, `tools`, or configured IDE paths. On Windows, npm binaries are the `.cmd` shims (e.g. `node_modules\.bin\typescript-language-server.cmd`).
3. Prefer local project binaries over global binaries.
4. Verify a server starts before configuring it: run it (or its companion CLI) with `--version`, e.g. `typescript-language-server --version`, `pyright --version`.
5. Write editor config only when the path is known and stays valid inside the offline package; prefer project-relative paths. Example for VS Code, TypeScript (built-in support, no extension): `.vscode/settings.json` containing `{ "typescript.tsdk": "node_modules/typescript/lib" }`, then pick "Use Workspace Version" once. For a generic LSP client (Neovim, Helix, ...), set the server command to the local binary plus `--stdio`.
6. Report what was found, what config was written where, and what is still missing.

Language servers:

- TypeScript/JavaScript: `typescript-language-server --stdio`, which wraps the project's `tsserver`. `tsserver` alone speaks its own protocol, not LSP.
- Python: `pyright-langserver --stdio` from the npm `pyright` package (the PyPI `pyright` wrapper downloads that npm package on first run, so offline it only works if that download was done in advance); `pylsp` or `ruff server` only if already installed.
- C/C++: `clangd` from a bundled LLVM toolchain.

Do not install extensions from the internet during setup.

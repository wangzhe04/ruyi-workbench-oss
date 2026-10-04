---
name: 功能开发
description: 跨多个文件的功能开发：先读项目约束，再实现并验证
---

# Feature Development

Use this skill for a feature or behavior change that touches several files and needs the project's own rules read before editing and a real verification afterwards, in an offline Windows environment. A one-line fix or a question does not need it.

Workflow:

1. Read the project's rules first (CLAUDE.md, CONTRIBUTING, README), then use `project_snapshot`, `dependency_inventory`, `docs_search` (docs), and `file_search` / `codebase_symbol_search` (code) to understand the project before editing.
2. Check `git_status` so user work is visible and unrelated changes are not overwritten.
3. Make a short implementation plan tied to files and tests.
4. Edit narrowly, following local style and existing helpers.
5. Run the most relevant local tests, build, or smoke check with `powershell_run` or `script_run`.
6. Finish with changed files, verification results, and any remaining manual step.

Offline rules:

- Do not require npm, pip, cargo, or NuGet downloads at runtime unless the package cache is already bundled.
- Prefer vendored docs and local README files via `docs_search`.
- If a missing dependency blocks the work, report the exact package/runtime that must be added to the offline bundle.

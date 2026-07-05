# Feature Development

Use this skill when implementing a project change in an offline Windows Claude Code environment.

Workflow:

1. Use `project_snapshot`, `dependency_inventory`, and `docs_search` to understand the project before editing.
2. Check `git_status` so user work is visible and unrelated changes are not overwritten.
3. Make a short implementation plan tied to files and tests.
4. Edit narrowly, following local style and existing helpers.
5. Run the most relevant local tests, build, or smoke check with `powershell_run` or `script_run`.
6. Finish with changed files, verification results, and any remaining manual step.

Offline rules:

- Do not require npm, pip, cargo, or NuGet downloads at runtime unless the package cache is already bundled.
- Prefer vendored docs and local README files via `docs_search`.
- If a missing dependency blocks the work, report the exact package/runtime that must be added to the offline bundle.

# Code Simplifier

Use this skill when asked to simplify recently changed or confusing code without changing behavior.

Workflow:

1. Inspect `git_status` and read the relevant files.
2. Identify duplication, tangled conditionals, unclear names, and local abstractions that no longer pay for themselves.
3. Make small, behavior-preserving edits.
4. Keep public APIs stable unless the user explicitly asks for a refactor.
5. Run local tests or at least the narrowest available verification command.
6. Summarize what was simplified and what behavior was preserved.

Offline constraints:

- Do not add new npm/pip packages unless they are already present in the repository or bundled offline.
- Prefer built-in language/runtime features.

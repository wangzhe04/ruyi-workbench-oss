---
name: 离线代码审查
description: 仅用本地上下文审查当前仓库
---

# Offline Code Review

Review the current repository using local-only context.

Steps:

1. Collect the changes: `git_status` for the overview (untracked new files show as `??`), `git_diff` for unstaged edits, and `git_diff` with `staged: true` for staged edits - plain `git_diff` silently omits the staged side.
2. Call `code_review_scan`.
3. Read the relevant changed files, including new untracked ones.
4. Report findings first, ordered by severity, with file and line references.
5. Then list tests run or test gaps.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use the equivalent `git status --short`, `git diff`, `git diff --cached`, Grep, and Read.

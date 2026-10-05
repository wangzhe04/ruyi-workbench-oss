---
name: 生成提交信息
description: 根据当前本地改动起草提交信息
---

# Commit Message

Draft a commit message from the current local changes.

Steps:

1. Collect every side of the change: `git_status` for the overview (untracked new files show as `??`), `git_diff` for unstaged edits, and `git_diff` with `staged: true` for staged edits - plain `git_diff` silently omits the staged side. Read new untracked files with `file_read`.
2. If some changes are already staged, say whether the message covers only the staged set (what a plain `git commit` records) or everything.
3. Group changes by intent.
4. Draft one concise subject and an optional body.
5. Include a separate "Tests" line for commands already run.

Draft only; do not stage or commit unless the user asks.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use the equivalent `git status --short`, `git diff`, `git diff --cached`, and Read.

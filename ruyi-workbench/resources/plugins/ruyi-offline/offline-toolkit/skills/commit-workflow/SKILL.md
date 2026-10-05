---
name: 提交工作流
description: 无需联网，准备提交、起草提交信息与变更摘要
---

# Commit Workflow

Use this skill for local commit preparation, commit message drafting, and changelog summaries without GitHub or network access.

Workflow:

1. Run `git_status` for the overview, then read both halves of the change: `git_diff` (unstaged) and `git_diff` with `staged: true` (staged). The default call alone misses staged work. New files are untracked (listed by `git_status` and in `untracked` of the unstaged diff); read them with `file_read`.
2. Group changes by user-facing behavior, tests, docs, and infrastructure.
3. Read important changed files before summarizing risk.
4. Run the local test command if one is obvious from `dependency_inventory`.
5. Look at recent subjects with `git_log`, then draft a concise message in the same style and language.
6. Only create the commit when the user explicitly asks for it. `git_commit` commits what is already staged by default; `paths: [...]` stages and commits only those files; `addAll: true` (`git add -A`) only when the user wants everything included.

Message format:

- Follow the convention seen in `git_log`; otherwise an imperative subject line under 72 characters.
- Add a short body when the change spans multiple areas. `git_commit` passes `message` verbatim as one `-m` argument, so a subject line, a blank line, and body lines are kept.
- Mention tests run and important caveats outside the commit message if not committing.

Do not:

- Push, fetch, or open a remote.
- Stage unrelated user changes; prefer `paths` over `addAll`.
- Bypass hooks. If a hook rejects the commit, fix the problem and commit again.
- Hide generated files, lockfile changes, or skipped tests.

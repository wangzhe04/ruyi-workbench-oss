---
name: 生成提交信息
description: 根据当前本地改动起草提交信息
---

# Commit Message

Draft a commit message from the current local changes.

Steps:

1. Call `git_status` for the overview, then `git_diff` for the change content.
2. Group changes by intent.
3. Draft one concise subject and an optional body.
4. Include a separate "Tests" line for commands already run.

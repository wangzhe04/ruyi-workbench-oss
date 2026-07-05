# Offline Code Review

Review the current repository using local-only context.

Steps:

1. Call `git_status` for the overview, then `git_diff` for the change content.
2. Call `code_review_scan`.
3. Read the relevant changed files.
4. Report findings first, ordered by severity, with file and line references.
5. Then list tests run or test gaps.

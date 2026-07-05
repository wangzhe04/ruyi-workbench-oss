# Code Review Offline

Use this skill for bug-focused code review when public services are unavailable.

Workflow:

1. Run `git_status`, then `git_diff` for the change content, when reviewing uncommitted changes.
2. Run `code_review_scan` to collect lightweight security and quality signals.
3. Read the exact files and lines behind any finding before reporting it.
4. Prioritize behavioral bugs, data loss, security exposure, regressions, and missing tests.
5. Present findings first, ordered by severity, with file paths and line numbers.
6. If no issues are found, say that clearly and mention residual risk or unrun tests.

Do not:

- Report style-only comments unless they hide a real defect.
- Assume external CI, GitHub, or cloud scanners exist.
- Copy large diffs into the answer; summarize the relevant lines.

# Commit Workflow

Use this skill for local commit preparation, commit message drafting, and changelog summaries without GitHub or network access.

Workflow:

1. Run `git_status` for the overview, then `git_diff` for the change content. (`git_commit` creates the commit — step 6.)
2. Group changes by user-facing behavior, tests, docs, and infrastructure.
3. Read important changed files before summarizing risk.
4. Run the local test command if one is obvious from `dependency_inventory`.
5. Draft a concise commit message in the repository's style.
6. Only create the commit when the user explicitly asks for it.

Message format:

- Use an imperative subject line under 72 characters.
- Add a short body when the change spans multiple areas.
- Mention tests run and important caveats outside the commit message if not committing.

Do not:

- Push, fetch, or open a remote.
- Stage unrelated user changes.
- Hide generated files, lockfile changes, or skipped tests.

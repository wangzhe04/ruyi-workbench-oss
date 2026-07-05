# CLAUDE.md Management

Use this skill to create, audit, or improve project `CLAUDE.md` files for offline Claude Code use.

Workflow:

1. Run `claude_md_audit` to find existing instruction files and gaps.
2. Use `project_snapshot`, `dependency_inventory`, and local README files to identify real commands and conventions.
3. Keep `CLAUDE.md` short, project-specific, and executable.
4. Include offline constraints: no public downloads, no external services unless explicitly configured, and where vendored docs/resources live.
5. Add safe working rules for tests, generated files, secrets, and user edits.
6. Verify every command path or script before writing it.

Recommended sections:

- Project purpose
- Local setup and offline resources
- Build/test commands
- Coding conventions
- Safety boundaries
- Useful MCP tools

---
name: 项目记忆管理
description: 创建、审计并完善项目 CLAUDE.md 说明文件
---

# CLAUDE.md Management

Use this skill to create, audit, or improve project `CLAUDE.md` files for offline Claude Code use.

Workflow:

1. Run `claude_md_audit` to locate `CLAUDE.md` files (up to 5 levels deep) and see which sections look missing. It is a keyword-level check: it only knows `CLAUDE.md` and does not judge whether the content is correct. To find other instruction files (AGENTS.md, CONTRIBUTING.md, ...), use `glob` (e.g. `**/AGENTS.md`) or `file_search`.
2. Read any existing `CLAUDE.md` in full before changing it. Keep everything the user wrote; add or correct sections instead of rewriting the file.
3. Show the user the proposed changes (new sections, edited lines, anything to remove) and edit only after they agree. Never drop user-written content without explicit consent.
4. Use `project_snapshot`, `dependency_inventory`, and local README files to identify real commands and conventions.
5. Keep `CLAUDE.md` short, project-specific, and executable.
6. Include offline constraints: no public downloads, no external services unless explicitly configured, and where vendored docs/resources live.
7. Add safe working rules for tests, generated files, secrets, and user edits.
8. Verify every command path or script before writing it.

Recommended sections:

- Project purpose
- Local setup and offline resources
- Build/test commands
- Coding conventions
- Safety boundaries
- Useful MCP tools

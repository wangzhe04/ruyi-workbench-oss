---
name: 审计项目记忆
description: 审计或创建离线 Claude Code 的项目说明
---

# CLAUDE.md Audit

Audit or create project instructions for offline Claude Code use.

Steps:

1. Call `claude_md_audit`.
2. Call `dependency_inventory`.
3. Read README and existing instruction files.
4. Propose a compact `CLAUDE.md` update with offline setup, commands, conventions, and safety boundaries.
5. Show the proposed content (or the diff against the existing file) and write it only after the user approves.

The tools above are Ruyi Workbench MCP tools (in Claude Code: `mcp__ruyi__<name>`); without them, use Glob, Grep, and Read to find existing `CLAUDE.md` files, manifests, and lockfiles.

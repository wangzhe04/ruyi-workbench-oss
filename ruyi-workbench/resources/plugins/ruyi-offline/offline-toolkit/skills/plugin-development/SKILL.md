---
name: 插件开发
description: 为离线市场创建或修改本地 Claude Code 插件包
---

# Plugin Development

Use this skill when creating or modifying a local Claude Code plugin bundle for an offline marketplace.

Workflow:

1. Create a plugin directory with `.claude-plugin/plugin.json`.
2. Add one or more `skills/<name>/SKILL.md` files for reusable workflows.
3. Add `commands/*.md` for high-frequency slash-command prompts.
4. Add `agents/*.md` for role prompts that can be selected by Claude Code.
5. Register the plugin in the local marketplace `.claude-plugin/marketplace.json`.
6. Keep all content self-contained; do not point to public package downloads or remote docs.
7. Validate before handing it over: `claude plugin validate <marketplace-or-plugin-dir>` runs offline and reports
   manifest and frontmatter errors that would otherwise only surface as a failed `claude plugin install`.

Format rules that break installs when missed:

- `skills/`, `commands/` and `agents/` are discovered automatically; leave them out of `plugin.json`. If you do list
  paths there, each must start with `./`, and `agents` entries must point at `.md` files, not a directory.
- Every `SKILL.md` and every `agents/*.md` starts with a frontmatter block (`---` lines) carrying `name` and
  `description`; an agent's `description` is what Claude Code reads to decide when to delegate to it.
- An agent's optional `tools` list uses real tool names (`Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, or
  `mcp__<server>__<tool>` for MCP tools); omit it to inherit every tool.
- Installed commands, skills and agents are addressed as `<plugin>:<file-or-directory-name>` (for example
  `/offline-toolkit:api-probe`); the frontmatter `name` is only a display name.
- The marketplace entry's `source` is a `./` path relative to the marketplace root, and its `version` should match
  `plugin.json`.

Quality bar:

- Each skill states when to use it, what tools to call, output expectations, and offline rules.
- Commands should be short and task-oriented.
- Agents should define responsibilities, priorities, and handoff expectations.
- Bump the version in both `plugin.json` and the marketplace entry when changing behavior: Claude Code stores each
  install under a per-version cache directory (`plugins/cache/<marketplace>/<plugin>/<version>`).

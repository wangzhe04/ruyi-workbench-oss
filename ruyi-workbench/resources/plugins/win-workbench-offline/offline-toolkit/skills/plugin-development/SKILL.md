# Plugin Development

Use this skill when creating or modifying a local Claude Code plugin bundle for an offline marketplace.

Workflow:

1. Create a plugin directory with `.claude-plugin/plugin.json`.
2. Add one or more `skills/<name>/SKILL.md` files for reusable workflows.
3. Add `commands/*.md` for high-frequency slash-command prompts.
4. Add `agents/*.md` for role prompts that can be selected by Claude Code.
5. Register the plugin in the local marketplace `.claude-plugin/marketplace.json`.
6. Keep all content self-contained; do not point to public package downloads or remote docs.

Quality bar:

- Each skill states when to use it, what tools to call, output expectations, and offline rules.
- Commands should be short and task-oriented.
- Agents should define responsibilities, priorities, and handoff expectations.
- Version the plugin when changing behavior.

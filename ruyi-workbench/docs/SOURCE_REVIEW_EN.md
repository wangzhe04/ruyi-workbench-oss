# Early External Source Snapshot Review (Historical)

> First committed on **2026-07-05**; scope clarified during the 2026-10-16 documentation review. The observations below concern external material reviewed at that time, not the current Ruyi repository or a current security audit. Preserving this record does not newly verify the material's provenance or licensing. See [Architecture](ARCHITECTURE_EN.md) for the current implementation and [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution constraints.

This is the English companion to [源码审阅结论](SOURCE_REVIEW_CN.md).

The external material reviewed at that time was a source snapshot, not a complete buildable project. Its README described its source as
an npm sourcemap leak and attributes the original code to Anthropic. Ruyi therefore follows a clean-room approach:
it recreates useful product capabilities without copying Anthropic source, prompts, private implementation details,
the official Claude CLI, or official plugins.

## Observed product structure

The source snapshot exposes a CLI entry layer, an interactive main entry point, a query lifecycle engine, a tool
abstraction and registry, MCP configuration and synchronization services, computer-use and browser bridge entry
points, and plugin/skill/agent/command loading paths.

## Capabilities Ruyi may independently provide

- Local chats and history.
- Workspace-scoped file read, write, search, and editing.
- PowerShell and script execution under permission control.
- MCP integration that exposes local Windows capabilities to a user-provided Claude CLI.
- Clean-room offline seeds for skills, agents, and commands.
- Browser or Office opening and handoff, desktop screenshots, and limited keyboard input.
- Windows offline package deployment.

## Capabilities deliberately not copied

- Anthropic private CLI source, system prompts, model telemetry, or internal authorization classifiers.
- Official Anthropic executables and plugins requiring licensed distribution.
- OAuth, official marketplace fetching, and network-dependent web capabilities as a required product dependency.

## Ruyi's independent design

Ruyi provides serve for the local web UI, mcp for a stdio MCP server, install for MCP configuration and optional
registration, and doctor for deployment diagnostics. The user supplies an internal Claude CLI or an
OpenAI-compatible endpoint for inference; Ruyi supplies the UI, attachment handling, local tools, auditability,
and offline resource organization.

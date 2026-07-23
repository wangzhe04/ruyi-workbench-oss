# Ruyi Administrator Guide

This is the English companion to [管理员手册](ADMIN-GUIDE_CN.md). It covers local deployment, engine integration,
security boundaries, verification, and troubleshooting.

## 1. Deployment model

Ruyi is a local Windows application. The workbench server is a single Node.js program with no runtime npm
dependencies. Use Ruyi.exe serve --open for packaged deployment or node app/server.js serve --open from source.

Ruyi.exe also supports doctor, mcp-config, install, and mcp. Overlay packages can update an installation
incrementally; verify the overlay identifier and run doctor after applying one.

The data root defaults to the legacy .win-claude-workbench directory under the user profile. Set RUYI_HOME to move
it. It contains configuration, chats, uploads, checkpoints, audit logs, generated MCP configuration, skills,
memories, workflow state, and usage ledgers. Treat it as private local application data.

The default HTTP port is 8765. Use a loopback address only; Ruyi is not a multi-user or public web service.

## 2. Engine integration

### Claude CLI

Point Settings to an internal Claude CLI executable or configure it during installation. Ruyi generates and can
register its workbench MCP configuration. If PowerShell JSON quoting breaks Claude's add-json command, use the
non-JSON add form or import the file printed by mcp-config.

### OpenAI-compatible providers

Add a provider with an ID, display label, base URL, API key, and model. Ruyi supports presets and compatible
internal gateways. Test the connection in Settings before production use. API keys remain on the local machine and
are masked in ordinary API responses.

### Desktop MCP and honest metering

ai-computer-control is optional. Install its required Python environment only where desktop/Office control is
needed. Usage accounting groups token and estimated cost by engine, provider, chat, and currency; subscription-plan
traffic is labeled as plan-included instead of fabricated as a monetary charge.

ACC v1.9.0 exposes 107 tools. Browser mode defaults to `system`, which opens a new tab/window in the user's
associated browser without owning or closing it; the active Ruyi Workbench tab is never navigated, reused, or
closed. `managed`, `custom`, `cdp`, and explicitly isolated `bundled` modes are available through
`browserAutomation`. Managed Chromium is launched with renderer accessibility enabled. When an accelerated browser
surface lacks a UIA Document tree, UIA/observe results carry `accessibilityLimited` and callers should switch to
CDP/DOM, OCR, or screenshot coordinates.

Default OCR uses the offline Windows.Media.Ocr API through `winsdk`, not Tesseract. Full packages contain and
verify CPython 3.12 plus the cp312 `winsdk` wheel during both build and installation. For an overlay on an older
installation, run `update.bat --deps` before `update.bat --code` so `uiautomation`, `comtypes`, and `winsdk` are
installed from the local wheel cache.

The read-tier `mcp_list` tool returns connector metadata and environment-variable names, never secret values. The
exec-tier `mcp_configure` tool can persist external connector or browser-target changes only after an explicit user
request and the normal permission confirmation; it cannot replace the built-in ACC executable or lower tool tiers.

## 3. Security boundaries

- Ruyi binds loopback only and protects browser-originated sensitive routes with a page token.
- Permission modes gate read, edit, and exec operations. File changes are checkpointed before mutation.
- Web tools reject private, loopback, and link-local destinations to reduce SSRF exposure.
- Workspace guards constrain file access; sensitive application data is denied even when reached through links.
- Audit records are appended locally and secrets are redacted before UI delivery.
- Ruyi is offline-first, has no product telemetry, and follows clean-room provenance rules.
- Skills, memories, workflows, MCP manifests, and model output are untrusted input. Review permissions, workspace
  scope, imported manifests, and generated commands before approving them.

See the repository [Security Policy](../../../SECURITY.md) for reporting and threat-model details.

## 4. Pro-mode panels

Pro mode exposes Files, Artifacts, Changes, Agent workflows, Usage, Audit, Terminal, Desktop, MCP, Debug, and
Health panels. Simple mode deliberately hides developer-focused controls without disabling their underlying safety
checks.

## 5. Acceptance and regression

Run tests serially because fixtures use fixed local ports:

    npm.cmd test

The fast static route is:

    npm.cmd test -- --fast

Live provider and desktop tests require a real key or Python environment and are skipped by default. For a new
provider, test model listing, streaming text, tool calls, an error response, usage reporting, and a restart.

## 6. Troubleshooting

Use Ruyi.exe doctor first. Verify the selected engine, provider base URL and model, CLI path, MCP registration,
loopback port availability, data-root permissions, and desktop Python environment. Keep server logs and the audit
timeline when escalating an issue; do not paste unmasked keys or chat content into public reports.

## Brand and compatibility

Ruyi was formerly Win Claude Workbench. The runtime still recognizes old data-root and environment-variable names,
and retains the MCP server identifier win-claude-workbench to avoid breaking existing user configuration. New
documentation and UI use the Ruyi brand.

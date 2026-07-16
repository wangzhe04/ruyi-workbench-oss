# Offline Deployment

This is the English companion to [离线部署说明](OFFLINE_DEPLOYMENT_CN.md).

## Target-machine requirements

- Windows 10, Windows 11, or Windows Server.
- An available internal Claude CLI, or an OpenAI-compatible provider configured later in the UI.
- No public internet access is required.
- The offline package includes Ruyi.exe and, where practical, a Node runtime fallback. Runtime npm installation is
  not required.

## Install and start

Extract the offline package and run:

    powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-workbench.ps1

Keep the Full ACC archive name short (for example, `Ruyi-v1.6.5-full.zip`) and extract it to a short location such
as `C:\Ruyi`. Chromium and WinSDK contain deep paths, and Windows Explorer counts the archive name and temporary
directory against its legacy extraction limit. Never choose **Skip** for a long-path warning: the ACC integrity
check will correctly reject an incomplete extraction. The packaging script enforces a conservative Explorer path
budget before creating a release archive.

When Claude CLI is not on PATH, add its location with the ClaudePath argument. Start the UI with Ruyi.exe serve
--open or Start-Workbench.cmd.

## Claude CLI and MCP registration

The installer attempts to register the workbench MCP server. If JSON registration fails under PowerShell because a
cmd.exe layer strips JSON quotes, use the non-JSON Claude MCP add command or run Ruyi.exe mcp-config and add the
generated win-claude-workbench server entry to the Claude CLI configuration manually.

The legacy MCP identifier, data-directory name, and WIN_CLAUDE_WORKBENCH_HOME variable are intentionally retained
for compatibility. RUYI_HOME takes precedence for new deployments.

## Offline skills and plugins

The package includes the local win-workbench-offline marketplace and offline-toolkit. The installer attempts to
register it, but the workbench MCP tools remain usable when an internal Claude CLI does not support marketplace
commands. The bundled skills are clean-room local workflows for review, security, frontend work, API/CI diagnosis,
packaging, and document context; they do not download packages at runtime.

## Verify

Run Ruyi.exe doctor. In Claude CLI, ask the win-claude-workbench MCP server to run project_snapshot, then try
dependency_inventory or code_review_scan against a workspace.

## Boundaries

- Ruyi does not bundle Anthropic's Claude CLI or official plugins.
- Web search, OAuth, and online marketplace updates are unavailable without a network.
- The offline package does not copy third-party plugin source. It provides clean-room local alternatives.
- Browser automation is a lightweight handoff by default; advanced DOM automation requires a preinstalled internal
  Playwright environment and script_run.

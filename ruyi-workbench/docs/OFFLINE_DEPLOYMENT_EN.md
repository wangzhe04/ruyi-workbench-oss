# Offline Deployment

This is the English companion to [离线部署说明](OFFLINE_DEPLOYMENT_CN.md).

## Target-machine requirements

- Windows 10, Windows 11, or Windows Server.
- A usable model: a provider supporting Chat Completions, Responses API or Anthropic Messages (such as on-prem vLLM or local Ollama / LM Studio; select the protocol supported by the endpoint) or a Claude Code / Kimi Code CLI already installed on the machine (the CLI path can also be set later in Settings).
- No public internet access is required.
- Release archives always include a bundled Node runtime; Ruyi.exe is an optional build artifact. Runtime npm
  installation is not required.

## Install and start

Fully extract the offline package first. Do not run scripts from the ZIP preview. Then run:

    powershell -ExecutionPolicy Bypass -File .\resources\scripts\install-workbench.ps1

Keep the Full ACC archive name short (for example, `Ruyi-v<version>-full.zip`) and extract it to a short location such
as `C:\Ruyi`. Chromium and WinSDK contain deep paths, and Windows Explorer counts the archive name and temporary
directory against its legacy extraction limit. Never choose **Skip** for a long-path warning: the ACC integrity
check will correctly reject an incomplete extraction. The packaging script enforces a conservative Explorer path
budget before creating a release archive.

When Claude CLI is not on PATH, add its location with the ClaudePath argument. Start the UI with
Start-Workbench.cmd. Both variants preflight their required files. If Full desktop-control setup fails, the base
Workbench continues to start and the detailed reason is retained in
`%LOCALAPPDATA%\Ruyi\logs\acc-install-latest.log`, and the launcher window stays up for 15 seconds after the workbench
starts (any key closes it sooner) to say that it started without desktop control and where the log is.

A Full release must include CPython 3.12, the exact `winsdk==1.0.0b10`
`cp312-win_amd64` wheel, and an embedded runtime that imports
`winsdk.windows.media.ocr` plus its imaging, streams, and globalization projections. Packaging, the SHA-256 integrity
manifest, and target installation independently enforce this contract. A missing requirement prevents the archive
from being released or activated. After installation, ACC `diagnostics` must report `optional.ocr: true`.

## Claude CLI and MCP registration

The installer attempts to register the workbench MCP server. If JSON registration fails under PowerShell because a
cmd.exe layer strips JSON quotes, use the non-JSON Claude MCP add command or run
`./runtime/node/node.exe ./app/server.js mcp-config` from the extracted package root and add the
generated ruyi server entry to the Claude CLI configuration manually. Detailed steps, including a third-party
Anthropic-compatible endpoint, are in the administrator guide
([Connecting a third-party Anthropic-compatible endpoint](manuals/ADMIN-GUIDE_EN.md#connecting-a-third-party-anthropic-compatible-endpoint)).

Since 3.0 the MCP server id is ruyi (it was win-claude-workbench; the installer removes the old registration) and
the default data root is .ruyi-workbench (direct `serve` startup attempts migration from the old default only when neither home override is set and the migration conditions are met). The legacy
WIN_CLAUDE_WORKBENCH_HOME variable is still read; RUYI_HOME takes precedence.

## Offline skills and plugins

The package includes the local ruyi-offline marketplace and offline-toolkit. The installer attempts to
register it, but the workbench MCP tools remain usable when an internal Claude CLI does not support marketplace
commands. The bundled skills are clean-room local workflows for review, security, frontend work, API/CI diagnosis,
packaging, and document context; they do not download packages at runtime.

## Instance and data-root boundary

Run one `serve` instance per data root. An exclusive lease is not implemented yet: starting a second instance on another port can still rewrite pending interventions and the runtime handshake. Multi-instance tests need separate `RUYI_HOME` directories. This protection is pending in the [Steward 3.x plan](../../docs/optimization-plan/62-steward-3x-iterations.md); normal CLI `mcp` children may use the parent service’s data root.

## Verify

From the extracted package root, run `./runtime/node/node.exe ./app/server.js doctor`. If `Ruyi.exe` is included, `./Ruyi.exe doctor` is also available. In Claude CLI, ask the ruyi MCP server to run project_snapshot, then try
dependency_inventory or code_review_scan against a workspace.

## Boundaries

- Ruyi does not bundle Anthropic's Claude CLI or official plugins.
- Web search, OAuth, and online marketplace updates are unavailable without a network.
- The offline package does not copy third-party plugin source. It provides clean-room local alternatives.
- Browser automation is a lightweight handoff by default: `system` mode only hands a URL to the user's default browser
  (a new tab or window), after which Ruyi works through desktop screenshots, UIA, OCR and the keyboard. For
  element-level DOM automation, choose `managed`, `custom` or `cdp` as the browser target under Settings → Tools &
  integrations → Integrations and MCP; the Full package carries the Playwright wheels and Chromium (only `bundled`
  explicitly uses the isolated Chrome for Testing inside it). The Slim package has no desktop-control component and
  therefore none of these browser modes.

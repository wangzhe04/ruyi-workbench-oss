# MCP Connectors: Folder Drop-ins

This is the English companion to [MCP 连接器](README.md).

An external stdio MCP connector is a folder containing a ruyi-mcp.json manifest. Place the folder under mcp/ or
import it from the workbench UI. Ruyi validates and sanitizes the manifest, stores the configured connector, and
bridges its available tools into the workbench tool loop.

## Built-in desktop control

ai-computer-control is a bundled, specially detected desktop-control MCP. It is not a normal drop-in manifest,
which avoids double registration. See [its README](ai-computer-control/README.md) for installation and offline
deployment.

Specialized detection verifies that a candidate Python can import ACC before selecting it. A dependency-incomplete
embedded runtime is skipped in favor of a usable Python, and the installer default at
`%LOCALAPPDATA%\ai-computer-control\venv\Scripts\python.exe` is recognized. The `-IncludeAcc` workbench bundle
contains ACC source and its installer, not a hydrated offline Python runtime; use ACC's separate offline package
when the target has no compatible Python and dependencies.

## Manifest

Use an ID, display label, executable command, optional arguments, optional environment values, optional working
directory, and enabled flag. Keep credentials in local environment values; do not commit them. Ruyi masks secret
values in UI responses while preserving the locally configured value for the child process.

## Import and precedence

The Settings import flow reads ruyi-mcp.json from a selected folder. Explicit configured entries take precedence
over an automatically discovered drop-in with the same ID. Invalid manifests are skipped rather than preventing the
workbench from starting.

## Contributions

Contribute a self-contained folder and manifest. State required runtimes, keep network access optional where
possible, handle missing optional dependencies gracefully, and document which tools mutate files so checkpoint
coverage can be maintained.

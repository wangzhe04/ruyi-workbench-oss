# MCP Connectors: Folder Drop-ins

This is the English companion to [MCP 连接器](README.md).

An external stdio MCP connector is a folder containing a ruyi-mcp.json manifest. Place the folder under mcp/ or
import it from the workbench UI. Ruyi validates and sanitizes the manifest, stores the configured connector, and
bridges its available tools into the workbench tool loop.

## Built-in desktop control

ai-computer-control is a bundled, specially detected 108-tool desktop-control MCP (the exact count lives in the repository's `facts.json` as `accTools`). It is not a normal drop-in
manifest, which avoids double registration. Browser URLs default to a new tab/window in the user's browser, and
the Workbench tab is never navigated, reused, or closed. See [its README](ai-computer-control/README.md) for
installation and offline deployment.

Specialized detection verifies that a candidate Python can import ACC before selecting it. A dependency-incomplete
embedded runtime is skipped in favor of a usable Python, and the installer default at
`%LOCALAPPDATA%\ai-computer-control\venv\Scripts\python.exe` is recognized. The Full package (packaging switch
`-IncludeAcc`) carries a verified embedded CPython 3.12, a wheel-only offline dependency cache, Chromium and the OCR
runtime, with every file listed in a SHA-256 manifest; the packaging script refuses to produce the package if any
of these is missing. An offline target therefore **needs no Python of its own**: the first start verifies and
registers ACC, and later starts run a quick check. The Slim package does not include ACC. Only when you use ACC
directly from the source tree do you need your own Python 3.12 and `pip install -e`, or ACC's own offline package
(built by `installer/build_offline_package.py`).

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

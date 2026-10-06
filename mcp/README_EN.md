# MCP Connectors: Folder Drop-ins

This is the English companion to [MCP 连接器](README.md).

An external stdio MCP connector is a folder containing a ruyi-mcp.json manifest. Place the folder under mcp/ or
import it from the workbench UI. Ruyi validates and sanitizes the manifest, stores the configured connector, and
bridges its available tools into the workbench tool loop. A folder placed under mcp/ needs no config edit and no
import wizard, and deleting the folder uninstalls it (a drop-in's existence is expressed purely by its folder and is
never written back to the config file).

Two locations are scanned, each merging at most 10 entries (10 in total):

- `<release root>/mcp/*/ruyi-mcp.json` — connectors shipped with the release (this folder).
- `<data dir>/mcp/*/ruyi-mcp.json` — connectors you install yourself (`RUYI_HOME`, or the default `~/.ruyi-workbench/mcp/`).

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

A minimal `ruyi-mcp.json` needs `id` and `command`; everything else is optional:

- `id` (required): unique identifier; only letters, digits and underscores are kept for the tool-name prefix, at most 64 characters.
- `label`: display name (defaults to `id`).
- `command` (required): the executable that starts the MCP server (for example `node`, `python`, `./server.exe`).
- `args`: array of command-line strings, at most 50.
- `env`: environment values injected into the child process (keys up to 120 characters, values up to 2048).
- `cwd`: working directory; **defaults to the manifest's own folder**, so `command` / `args` may use relative paths.
- `enabled`: set `false` to disable the connector temporarily without deleting the folder.

Keep credentials in local environment values; do not commit them (use placeholders and let the user fill in `env`).
Ruyi masks secret values in UI responses while preserving the locally configured value for the child process.

## Import and precedence

The Settings "Import MCP from a folder" flow (`/api/mcp/import-folder`) reads the same ruyi-mcp.json, but takes the
persistent route: the entry is written into the config file, survives restarts and must be removed by hand. Use a
drop-in when a connector should travel with the release or the data directory and uninstall by deleting its folder;
use the import when it should stay fixed in the configuration.

Explicit configured entries (including imported ones) take precedence over an automatically discovered drop-in with
the same ID; the drop-in is skipped and one warning is written to the audit log. Invalid manifests are skipped rather
than preventing the workbench from starting.

## Contributions

Contribute a self-contained folder and manifest. State required runtimes, keep network access optional where
possible, handle missing optional dependencies gracefully, and document which tools mutate files so checkpoint
coverage can be maintained.

---
name: release-packager
description: Prepares and verifies an offline Windows release bundle from the staged output - contents, doctor run, MCP smoke test, static UI serving - without fetching from public package registries. Use when packaging a release or checking a built bundle.
---

Platform boundary: the workbench EXE/PowerShell packaging and install commands target Windows. macOS currently has source development startup/doctor and prepared dependency validation; signed offline Mac distribution is pending P6. Do not run Windows packaging scripts on Mac or label the development environment a Mac installer.


# Release Packager

You prepare offline Windows release bundles.

Priorities:

- Include executables, fallback source, configs, docs, scripts, plugin marketplace, and runtime dependencies.
- Verify the package from the staged output, not only the source tree.
- Run `doctor --human` from the staged folder (`.\Ruyi.exe doctor --human`, or
  `.\runtime\node\node.exe .\app\server.js doctor --human` when there is no `Ruyi.exe`; plain `doctor` prints only
  environment JSON), smoke-test MCP tools, and confirm the UI can serve static assets.
- Keep a manifest of what is included and what must be supplied internally.

Boundaries:

- Do not fetch from public package registries during release validation.
- Do not include proprietary third-party binaries unless the user confirms licensing.

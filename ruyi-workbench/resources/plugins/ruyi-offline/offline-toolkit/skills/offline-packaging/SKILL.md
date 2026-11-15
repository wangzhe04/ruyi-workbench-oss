---
name: 离线打包
description: 为隔离网或内网 Windows 机器准备项目分发包
---

Platform boundary: the repository packaging commands and installers below are Windows-only. macOS source development is not a signed offline distribution. Do not run these PowerShell/EXE packaging flows on Mac or claim they produce a Mac app. Use the MACOS-PORTING plan for later Mac packaging/signing/clean-machine validation; prepare architecture-matching wheels/browser cache before offline tests, never download during runtime acceptance.

# Offline Packaging

Use this skill when preparing a project for an air-gapped or intranet Windows machine.

Checklist:

1. Identify every runtime dependency and whether it is already bundled.
2. Avoid commands that fetch from the public internet during install.
3. Prefer vendored runtimes, local package caches, portable binaries, and explicit version manifests.
4. Generate a `doctor` or `verify` script that checks paths, versions, config files, and write permissions.
5. Produce a zip with the executable, resources, config templates, installer scripts, and human-readable deployment notes.
6. Include rollback instructions and a way to run without global installation.

For this workbench repository (PowerShell scripts, Windows only; run in `ruyi-workbench`):

- `npm run package:offline` (same as `package:offline:full`): Ruyi.exe plus the desktop control runtime. It refuses to run unless a verified runtime already exists in `mcp/ai-computer-control/build_offline`.
- `npm run package:offline:full:fresh`: rebuilds that runtime first (`-BuildAccOffline`), which needs Python and internet on the packaging machine.
- `npm run package:offline:slim`: no desktop control runtime.
- Every variant first runs `node app/build.js --check` and stops if `app/server.js` is stale. The exe build also runs `npm install` when `pkg` is not installed yet. Internet is only ever needed on the packaging machine; the resulting zip (`dist/Ruyi-<variant>.zip`) must install and run without it.
- Packaging deletes the previous `dist/Ruyi-<variant>` folder and overwrites the zip: say which variant and output you are about to produce and get the user's go-ahead before running it.
- On the target machine, use `Ruyi.exe doctor --human` and `resources/scripts/install-workbench.ps1` as the baseline verification and install flow.

# Offline Packaging

Use this skill when preparing a project for an air-gapped or intranet Windows machine.

Checklist:

1. Identify every runtime dependency and whether it is already bundled.
2. Avoid commands that fetch from the public internet during install.
3. Prefer vendored runtimes, local package caches, portable binaries, and explicit version manifests.
4. Generate a `doctor` or `verify` script that checks paths, versions, config files, and write permissions.
5. Produce a zip with the executable, resources, config templates, installer scripts, and human-readable deployment notes.
6. Include rollback instructions and a way to run without global installation.

For this workbench, use `Ruyi.exe doctor` and `resources/scripts/install-workbench.ps1` as the baseline verification and install flow.

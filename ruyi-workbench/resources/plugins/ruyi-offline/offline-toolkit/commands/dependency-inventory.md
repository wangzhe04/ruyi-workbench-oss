---
name: 依赖清单
description: 生成离线依赖与运行时清单
---

# Dependency Inventory

Create an offline dependency and runtime inventory.

Steps:

1. Call `dependency_inventory`. It only reads the top level of `root`; for sub-projects (see `nestedManifests`), call it again with `root` set to each project folder.
2. Check lockfiles, scripts, and toolchain config.
3. List bundled runtimes, package managers, missing caches, and commands that would attempt public downloads.
4. Recommend what to add to the offline bundle.

`dependency_inventory` is a Ruyi Workbench MCP tool (in Claude Code: `mcp__ruyi__dependency_inventory`); without it, use Glob and Read on the manifests and lockfiles. Do not run installs to find out.

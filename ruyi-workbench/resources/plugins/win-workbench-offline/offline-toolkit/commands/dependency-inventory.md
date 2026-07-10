---
name: 依赖清单
description: 生成离线依赖与运行时清单
---

# Dependency Inventory

Create an offline dependency and runtime inventory.

Steps:

1. Call `dependency_inventory`.
2. Check lockfiles, scripts, and toolchain config.
3. List bundled runtimes, package managers, missing caches, and commands that would attempt public downloads.
4. Recommend what to add to the offline bundle.

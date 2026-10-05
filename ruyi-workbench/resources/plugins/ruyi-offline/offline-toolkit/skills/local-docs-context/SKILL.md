---
name: 本地文档检索
description: 需要查阅本地或内网的技术文档、API 手册、依赖包自带说明时使用
---

# Local Docs Context

Use this skill when the answer should come from documentation on this machine or the intranet: vendored docs, API manuals, package READMEs, checked-in examples.

Workflow:

1. Search docs with `docs_search`. It reads doc files only (.md, .mdx, .markdown, .txt, .rst, .adoc, .org), README/CHANGELOG first, then `docs/`.
2. Dependency and build folders (`node_modules`, `.venv`, `site-packages`, `dist`, ...) are skipped by default. To read the docs a package ships with, pass `includeIgnored: true`, ideally with `root` set to that package folder.
3. Example code is not a doc file, so `docs_search` will not find it: search code with `file_search` (narrow with `glob`, e.g. `examples/**/*.py`).
4. Prefer docs under `docs`, `resources/docs`, `vendor/docs`, package READMEs, and checked-in examples.
5. Quote only the small line or API name needed, then explain in your own words.
6. When docs are missing or stale, say so and tell the user which doc set is missing; do not invent current API behavior.

Offline resource layout:

- Put mirrored docs in `resources/docs/<vendor-or-project>`.
- Put SDK examples in `resources/examples/<stack>`.
- Put licenses and source attributions beside imported material.

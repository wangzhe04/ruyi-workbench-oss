# DevOps CI Local

Use this skill to reproduce CI-like checks on an offline Windows machine.

Workflow:

1. Use `dependency_inventory` to find scripts and lockfiles.
2. Read CI config files such as `.github/workflows`, `azure-pipelines.yml`, `.gitlab-ci.yml`, or local build scripts.
3. Translate cloud CI steps into local commands that use bundled runtimes and caches.
4. Run build, lint, unit, integration, and package steps that are safe locally.
5. Capture failures with command, exit code, and the smallest useful output excerpt.

Offline rules:

- Do not call remote CI, registry, artifact, or package hosts.
- If a step needs a missing runtime, name it and add it to the offline bundle manifest.
- Prefer deterministic commands over shell aliases or profile-dependent state.

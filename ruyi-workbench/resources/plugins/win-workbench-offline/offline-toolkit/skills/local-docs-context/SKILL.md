# Local Docs Context

Use this skill as an offline replacement for documentation lookup plugins.

Workflow:

1. Search vendored docs, README files, and local examples with `docs_search`.
2. Prefer docs under `docs`, `resources/docs`, `vendor/docs`, package READMEs, and checked-in examples.
3. Quote only the small line or API name needed, then explain in your own words.
4. When docs are missing, state the exact doc set that should be added to the offline bundle.
5. Avoid inventing current API behavior when the local docs are stale or absent.

Offline resource layout:

- Put mirrored docs in `resources/docs/<vendor-or-project>`.
- Put SDK examples in `resources/examples/<stack>`.
- Put licenses and source attributions beside imported material.

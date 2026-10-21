# Claude native transport follow-up

This is an offline feasibility harness, outside the product. It uses only the already installed official Claude program and copies its complete program directory into an owned temporary projection. It does not install, patch, extract or redistribute vendor code. Each launch has a separate fixture home, AppContainer profile and Job. The parent helper supplies LPAC with `registryRead`, with no network capability. Existing user/system ACLs, firewall and loopback settings are unchanged.

Run the stages serially on Windows with Node 24. Reading a previous evidence file happens before the next result is written, so using the same path preserves earlier failures under `priorRuns`:

```powershell
node --test dev-harness/privacy-m1/cli/claude-run.test.js dev-harness/privacy-m1/cli/claude-gateway.test.js dev-harness/privacy-m1/cli/gateway.test.js
node dev-harness/privacy-m1/cli/claude-run.js --stage marker --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage runtime --prior-evidence <report.json> --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage model --prior-evidence <report.json> --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage diagnostic --prior-evidence <report.json> --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage ancestor --prior-evidence <report.json> --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage compat-model --prior-evidence <report.json> --evidence <report.json>
node dev-harness/privacy-m1/cli/claude-run.js --stage compat-audit --prior-evidence <report.json> --evidence <report.json>
```

Bun's documented `BUN_OPTIONS` mechanism is the candidate. In the observed Claude 2.1.202/Bun 1.4.0 build, a relative `--preload=./marker.mjs` reaches our original marker. The tested quoted absolute path did not reach it. `BUN_BE_BUN` did not establish a usable runtime fixture in these attempts; it must never be counted as actual Claude execution because its documented purpose replaces the application entrypoint.

The `model` stage uses the shared bounded fetch-to-LOCAL-pipe adapter with the fixed `anthropic` protocol. Only POST to the exact virtual `/v1/messages` route is accepted. Queries, other origins, methods, routes and unknown protocol values are rejected. The host holds its fixed receiver and `anthropic-version` constant; CLI headers and URLs are not forwarded. The host applies the real PrivacyCore before sending to the repository's independent local fake Anthropic provider. This fixed schema prototype does not claim arbitrary JSON fidelity or compatibility with a real external Anthropic service.

The provider response challenge is generated only in the host. It is absent from the child prompt, environment, argv and projected source. A successful model result requires a captured model request with the exact broker body hash, no original synthetic secret, a confirmed provider response, an exact nested assistant text block, an exact successful final result, exit 0, unchanged program-tree hashes and verified cleanup. Marker, echo, tool blocks and zero requests cannot satisfy the predicate. All current native model attempts remain unsuccessful.

The diagnostic stage installs an original observer around public filesystem APIs. It preserves values, callbacks and thrown errors; it does not substitute paths or suppress denials. The evidence retains only bounded operation/phase/error enums, path classifications and SHA-256 values. Diagnostic rows come from the same untrusted process, can be forged by that process, and are advisory observations, not trusted helper control or security-boundary evidence. Internal runtime filesystem operations and API references captured before the preload can remain invisible.

Observed diagnostics show that both our own cwd/entry `realpath` checks and the application's first visible `realpathSync` of its fixture home fail with `EPERM`. Public preserve-symlink flags did not change that result. Help still timed out with NUL stdin. The separate model preload connected to its target-profile LOCAL pipe, but no model request or assistant completion was observed. This narrows the next investigation to initialization and path canonicalization; it does not establish the entire cause of the timeout, supported model transport, network protection or strict filesystem isolation.

The diagnostic-only `ancestor` preload checks metadata from the volume root to its fixture home without listing directories or reading contents, then exits before the application entrypoint. The volume root and existing ancestors are denied. Within the granted projection, stat/lstat succeed, regular realpath fails, and the public `realpathSync.native` succeeds. Extended-length input has the same regular/native difference. Exit 0 in this stage is only a runtime-fixture result.

The `compat-model` candidate leaves the regular sync implementation first. Only its `EPERM`/`EACCES` for a string path within the frozen projection may fall back to one actual public `.native` call. Both the input and actual native result must remain within that projection. Reparse targets outside it retain the original denial. Other errors, outside paths, Buffer/URL inputs and unsupported encodings retain the regular implementation. Default UTF-8 and buffer return encoding are supported; async APIs are unchanged. Native canonicalization has documented differences from regular realpath, so this is a limited frozen-runtime compatibility experiment, not a filesystem security boundary.

Node unit checks update existing named ESM bindings through `syncBuiltinESMExports`. The actual Bun 1.4.0 receipt differs: the call returns, and the require binding matches the wrapper, but the previously captured named binding does not. Both compatibility help and model attempts still time out with no model request. The harness records those booleans and does not infer bundle-wide adoption from assigning the fs object property.

The final `compat-audit` stage is one short help attempt combining that shim with the bounded filesystem observer. It records separate advisory events when the regular implementation denies an owned path, when the actual native fallback succeeds/fails, and the subsequent application operations. Its own preload checks use the `compat-preflight` phase; application calls use `application`. It sends no model request and cannot improve the failed model verdict. No module proxy, vendor export replacement, drive mapping, Git asset projection or existing-directory ACL change is used.

The evidence binds each historical run to its source manifest, installed/copied program trees, Node, compiled helper and compiler. A later source edit must not rewrite a prior run's hashes. Current and historical observations remain distinct. LPAC's remaining accessible ARAP/profile resources and production M1 requirements are separate gates.

Primary references: [Bun standalone executables](https://bun.sh/docs/bundler/executables), [Bun runtime flags](https://bun.sh/docs/runtime), [Bun code-generation restrictions](https://bun.sh/docs/runtime/code-generation-from-strings), [Claude gateway environment variables](https://code.claude.com/docs/en/env-vars), [Claude network configuration](https://code.claude.com/docs/en/network-config), [Claude programmatic use](https://code.claude.com/docs/en/headless).

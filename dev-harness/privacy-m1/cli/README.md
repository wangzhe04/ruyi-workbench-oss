# M1 Windows CLI isolation experiment

This directory is an executable feasibility experiment. It is not wired into the product and does not complete roadmap 86 §5 or M1.

Run from the repository root on Windows, using Node 24 and the system .NET Framework compiler:

```powershell
node --test dev-harness/privacy-m1/cli/runner.test.js
node dev-harness/privacy-m1/cli/run.js --evidence docs/optimization-plan/evidence/privacy-m1-cli.json
```

`run.js` uses only Node builtins and existing repository builtin-only lifecycle/fake-provider helpers. It compiles the original `AppContainerHost.cs` to an owned temporary directory. The compiler, installed Node, Claude and Kimi program assets are discovered/read locally. Installed CLI programs are copied for local execution only, then deleted; no third-party executable or package is redistributed or committed. No user CLI config, credentials, OAuth state or real provider key is read.

The native helper creates a unique temporary AppContainer profile and a zero-capability token using `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`. The helper verifies `TokenIsAppContainer` before resuming the process. It grants the profile SID read/execute on the owned projection, and write on the owned low-integrity output directory only. It changes no existing system/user directory ACL, firewall setting, loopback exemption or CLI setting. Every launch has its own profile; real CLI version/help/model attempts use distinct temporary homes. No privilege elevation or installation occurs.

The allowlisted inherited handles are stdin/stdout/stderr. The broker accepts one operation, `read-project-model`, returning a fixed synthetic model view; other operations return `DENIED`. This demonstrates IPC transport and request restriction only. It is not a Claude/Kimi API gateway or a production privacy broker. The Job Object accounts for and terminates the owned process tree; it is not the isolation boundary.

Ordinary AppContainer does not establish an exclusive projection-filesystem allowlist: files elsewhere granting `ALL APPLICATION PACKAGES` can remain readable. An additional owned synthetic directory outside the projection grants that SID read access, and both probe generations attempt the file. This negative control remains visible. The staged LPAC follow-up below evaluates its opt-out and runtime grants separately.

The adversarial Node probe tests allowed reads, denied outside synthetic-secret reads, readonly-project writes, owned writes, and outside writes. A spawned Node child repeats the matrix, and a separate C# descendant reports its actual AppContainer token. Six independent owned listeners test TCP IPv4, TCP IPv6, a second TCP private-gateway target, UDP IPv4, UDP IPv6, and a syntactically valid DNS query datagram to an owned UDP receiver. Every listener first receives one uncontained positive control. The evidence records attempted operations, syscall errors/timeouts and each listener's receipt count. `NO_REPLY` is inconclusive about the denial mechanism; zero packets at a controlled reachable receiver establishes only delivery failure for that tested endpoint/time window. System DNS, public Internet and LAN destinations are explicitly untested.

The installed CLI attempts are separate from the synthetic adversarial probe. Version/help run without credentials. A further real-CLI prompt attempt uses only a synthetic noncredential and an owned synthetic HTTP provider, with a host positive HTTP control. No real model request is sent. The private gateway may remain unreachable under this AppContainer configuration; the experiment must preserve that blocker rather than add a global loopback exemption.

`prior-attempts.json` retains the first failures: Node root `realpath` denial, an incomplete Kimi dependency projection, a probe stdin lifetime bug, and Claude help timeout. `--preserve-symlinks-main` avoids Node's root-directory enumeration while preserving the OS ACL boundary. Kimi additionally uses `--preserve-symlinks`; compatibility with arbitrary dependency/native-addon layouts is not established.

Normal exit, helper timeout and errors terminate the owned Job, check the root wait result and Job active-process count, then delete the profile and verify its directory is absent. The parent has a separate watchdog using the repository's creation-time-aware `killOwnTree`, followed by deletion of the known owned profile when a normal cleanup receipt is missing. Evidence never infers successful tree cleanup just from having held a process handle. Abrupt runner/machine termination recovery is untested.

The evidence is a bounded, redacted summary: original user paths and runtime-generated temporary paths are removed, while source/program hashes and actual CLI versions bind the observations. A successful runner invocation means the experiment produced a report; inspect each status and `completedM1: false`. A real CLI read/edit/test/subtask/compact/restart chain, transcript protection, injection controls and a supported IPC-to-model transport remain required.

Implementation references: [Microsoft AppContainer launch APIs](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [Microsoft network isolation/loopback](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall), [Kimi environment variables](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html). API references informed the original implementation; no sample source was copied.

## LPAC and direct fetch-to-pipe follow-up

```powershell
node --test dev-harness/privacy-m1/cli/runner.test.js dev-harness/privacy-m1/cli/lpac.test.js dev-harness/privacy-m1/cli/gateway.test.js
node dev-harness/privacy-m1/cli/lpac.js --evidence docs/optimization-plan/evidence/privacy-m1-cli-lpac.json
```

The historical `privacy-m1-cli.json` remains bound to baseline commit `6d1e6544`. Its hashes are not refreshed to match these changed sources. The new report inventories this directory, directly loaded first-party dependencies, Node and compiler/helper bytes, complete installed Claude/Kimi program trees, and the complete temporary Kimi copy. No installed CLI configuration or credentials are read. Program copies exist only in the owned temporary directory and are removed. System DLLs are represented by the Windows build, not an exhaustive dependency inventory.

The follow-up launches three separate cases with zero **network** capabilities:

| Case | Runtime and file result | HTTP self-server |
| --- | --- | --- |
| Ordinary AppContainer, no capabilities | Node parent/child execute; AAP outside file is readable | Parent/child can listen and fetch their own server |
| LPAC, no capabilities | Node fails before JS with `WSAStartup: 10107`, exit `0x80000003` | Not reached |
| LPAC plus `registryRead` only | Parent/child execute; AAP outside file and ordinary outside secret are denied; own read/write checks pass | Parent/child `listen` fails with `EACCES` |

`registryRead` is an additional resource grant derived using `DeriveCapabilitySidsFromName`, not a network capability. The suspended root token must contain exactly the derived SID; the actual descendant must contain the same SID and package SID. The helper also verifies token classes 29, 30 and 31. Direct LPAC query class 46 returns error 87 on this machine and remains **unknown**. Successfully setting the LPAC opt-out launch attribute plus the AC/LPAC AAP behavioral difference is limited evidence; it is not a successful direct LPAC flag query, an exclusive filesystem whitelist, or a constrained registry view. No user registry secrets are inspected. Six independently reachable host receivers retain their positive controls and actual parent/child receipt counts; syscall errors and timeouts are preserved without inferring an unobserved denial mechanism.

The failed self-server route does not prevent the separate direct IPC experiment. Node's public `--import` preloads our original `gateway-preload.mjs`; `fetch-adapter.mjs` replaces the global fetch entry before the unchanged installed Kimi program starts. Read-only inspection of the frozen Kimi bundle identified the OpenAI SDK's default global fetch selection. Only `https://privacy-gateway.invalid/v1/chat/completions` (POST) and `/v1/models` (GET) are accepted. The adapter never calls an original fetch or resolves the virtual hostname. Other URLs/methods fail locally; any private/raw-network bypass still has the tested OS token restrictions. This runtime adapter is not the security boundary.

The helper creates a random named pipe in the target profile's qualified `Sessions/<session>/AppContainerNamedObjects/<SID>` pipe namespace; the child uses its `LOCAL` name. Its protected DACL grants the host user and profile SID, denies NETWORK, and its integrity label is lowered through the owned handle. Creating the pipe with a combined SACL initially failed for lack of privilege; creating the DACL and lowering only the label fixes that assembly error without enabling privileges. A global host `LOCAL` pipe initially produced child `ENOENT`; the profile-qualified name fixes that namespace error. These failures remain recorded separately in the new report. Target-profile connection succeeds; wrong-profile and remote-caller access checks are **untested**, so the report does not claim all caller isolation was behaviorally verified.

Helper control stderr is physically separate from CLI output. In broker mode the CLI inherits NUL stdin and one raw output handle for stdout/stderr; it cannot inherit helper stderr. The host's stdin belongs exclusively to the helper relay. Trusted control receipts are filtered per stage and field. The fixture writes forged stderr `broker-request`, `cleanup`, and `error` lines; they remain untrusted raw output and must neither trigger the host broker nor contaminate receipts. Raw output is hashed/counted incrementally, including bytes past the former 262 KiB capture limit; only bounded JSON assistant rows and diagnostic-code enums are inspected. No prompt, IPC body, CLI transcript, raw error body, or response challenge is persisted in gateway evidence.

The host broker independently binds recipient, purpose, method and route. It holds one in-flight request, rejects unknown fields/references, limits request/response bytes to 256 KiB and JSON depth, and applies the actual repository PrivacyCore to every outbound string before its fixed HTTP receiver. Input is projected before CLI launch; original and projected prompt hashes are recorded. It does not restore secrets or expose a general URL/command/file proxy. Full bounded SSE responses are returned as standard `Response` objects; incremental streaming, arbitrary binary payloads and long responses are not supported by this prototype. Abort is rechecked after body reading and immediately before pipe submission. Before submission failure means zero upstream requests; after submission timeout/cancellation can leave a submitted result unknown and does not retract bytes. A confirmed broker receipt means the host received the upstream response; CLI completion is checked separately.

The provider generates a fresh random response challenge held only by the host. It is absent from source, prompt, argv and child environment. A successful real Kimi observation requires an actual captured model request matching the broker body hash, no original synthetic secret in received bytes, a confirmed upstream challenge response, an exact final `role: assistant` content match, CLI exit 0, zero independent attack-receiver connections, and verified cleanup. Prompt/user/meta/log echoes and assistant tool-call rows cannot satisfy that predicate. The fixture and the actual Kimi attempt are separate evidence rows. Claude is only inventoried in this follow-up; its native executable is neither injected nor re-run through an unsupported bridge.

This establishes a narrow real Kimi model transport when its row passes. It does **not** complete M1 or prove model/tool/edit/compact/restart behavior, CLI cache/transcript protection, hooks/plugins/MCP isolation, an exclusive file/registry view, or arbitrary CLI versions. All five normal launches must delete their profiles, terminate their owned Job processes, and remove temporary files. Abrupt runner/machine termination recovery remains untested.

## Strict filesystem and native Claude continuation

The stored LPAC/Kimi report above is frozen to `3fea5af1`; changed helper/adapter sources do not retrospectively update its hashes. Save fresh reproductions to separate reports. The [filesystem contract](filesystem-contract.md), [observations](filesystem-findings.md), [Claude experiment](claude-contract.md), and [decision record 90](../../../docs/optimization-plan/90-claude-and-filesystem-feasibility.md) describe the next gates.

```powershell
node --test dev-harness/privacy-m1/cli/filesystem.test.js
$filesystemReport = Join-Path $env:TEMP ('ruyi-m1-filesystem-' + [guid]::NewGuid().ToString('N') + '.json')
node dev-harness/privacy-m1/cli/filesystem.js --evidence $filesystemReport
```

The filesystem runner deliberately retains exit 1 when its token-probe CLR failures remain. Inspect each predicate: complete parent/child observations show ARAP/profile-granted outside resources accessible, so the strict filesystem contract **failed**. An extra restricting SID is actually verified before resume, but Node then exits before JS; that candidate is blocked, not successful enforcement. The hardlink case separately demonstrates an unsafe projection maker. Validator preflight rejects reparse and multi-link fixtures before ACL mutation. No existing user/system ACL is changed.

The Claude stages distinguish native entrypoint, public Bun preload, LOCAL-pipe connection, canonicalization compatibility, model request and final assistant completion. Current native model attempts have not passed. A fixed Anthropic schema shares the bounded host PrivacyCore and transport with OpenAI; no arbitrary destination or CLI header forwarding is introduced. Runtime diagnostic metadata is untrusted advisory data and cannot satisfy a security or model-success predicate. See the Claude experiment for serial stage commands and preserved first failures.

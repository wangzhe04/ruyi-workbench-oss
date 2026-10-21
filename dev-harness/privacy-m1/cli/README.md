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

Ordinary AppContainer does not establish an exclusive projection-filesystem allowlist: files elsewhere granting `ALL APPLICATION PACKAGES` can remain readable. An additional owned synthetic directory outside the projection grants that SID read access, and both probe generations attempt the file. This negative control must remain visible in the evidence. LPAC and the runtime compatibility/resource grants it would require are a future explicit evaluation, not an implicit protection claim in this experiment.

The adversarial Node probe tests allowed reads, denied outside synthetic-secret reads, readonly-project writes, owned writes, and outside writes. A spawned Node child repeats the matrix, and a separate C# descendant reports its actual AppContainer token. Six independent owned listeners test TCP IPv4, TCP IPv6, a second TCP private-gateway target, UDP IPv4, UDP IPv6, and a syntactically valid DNS query datagram to an owned UDP receiver. Every listener first receives one uncontained positive control. The evidence records attempted operations, syscall errors/timeouts and each listener's receipt count. `NO_REPLY` is inconclusive about the denial mechanism; zero packets at a controlled reachable receiver establishes only delivery failure for that tested endpoint/time window. System DNS, public Internet and LAN destinations are explicitly untested.

The installed CLI attempts are separate from the synthetic adversarial probe. Version/help run without credentials. A further real-CLI prompt attempt uses only a synthetic noncredential and an owned synthetic HTTP provider, with a host positive HTTP control. No real model request is sent. The private gateway may remain unreachable under this AppContainer configuration; the experiment must preserve that blocker rather than add a global loopback exemption.

`prior-attempts.json` retains the first failures: Node root `realpath` denial, an incomplete Kimi dependency projection, a probe stdin lifetime bug, and Claude help timeout. `--preserve-symlinks-main` avoids Node's root-directory enumeration while preserving the OS ACL boundary. Kimi additionally uses `--preserve-symlinks`; compatibility with arbitrary dependency/native-addon layouts is not established.

Normal exit, helper timeout and errors terminate the owned Job, check the root wait result and Job active-process count, then delete the profile and verify its directory is absent. The parent has a separate watchdog using the repository's creation-time-aware `killOwnTree`, followed by deletion of the known owned profile when a normal cleanup receipt is missing. Evidence never infers successful tree cleanup just from having held a process handle. Abrupt runner/machine termination recovery is untested.

The evidence is a bounded, redacted summary: original user paths and runtime-generated temporary paths are removed, while source/program hashes and actual CLI versions bind the observations. A successful runner invocation means the experiment produced a report; inspect each status and `completedM1: false`. A real CLI read/edit/test/subtask/compact/restart chain, transcript protection, injection controls and a supported IPC-to-model transport remain required.

Implementation references: [Microsoft AppContainer launch APIs](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [Microsoft network isolation/loopback](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/troubleshooting-uwp-firewall), [Kimi environment variables](https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html). API references informed the original implementation; no sample source was copied.

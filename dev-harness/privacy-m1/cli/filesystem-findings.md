# Strict filesystem feasibility observations

The bounded 2026-10-21 experiment is in `docs/optimization-plan/evidence/privacy-m1-cli-filesystem.json`, with explicit source/program hashes and baseline `3fea5af1`. It is not wired into the product. `completedM1` remains false.

| Synthetic resource outside projection | Parent and Node child observations under LPAC + registryRead |
| --- | --- |
| Ordinary user grant | Read, enumeration and writes rejected |
| Everyone grant | Read, enumeration and writes rejected |
| ALL APPLICATION PACKAGES grant | Read, enumeration and writes rejected |
| ALL RESTRICTED APPLICATION PACKAGES grant | Read, enumeration and extended-path read succeeded; writable low-integrity fixture accepted writes |
| Target profile SID grant | Read, enumeration and extended-path read succeeded; writable low-integrity fixture accepted writes |
| Newly created profile's own storage | Synthetic marker read, enumeration and writes succeeded |

All nine outside fixtures had successful host read/enumeration/write positive controls before launch. Both Node generations executed the whole matrix, the original projected file remained unchanged, and owned output writes succeeded. The ARAP observations alone contradict an exclusive projection/output/runtime allowlist independently of any token-probe exit issue. They demonstrate the DACL authorization retained by LPAC, rather than a complete inventory of accessible host paths.

Both descendant token processes produced complete matching package/capability snapshots; direct LPAC class 46 remained unknown/error 87. Both token probes then exited with CLR exception status `0xe0434352`. The report preserves `descendantTokenProbeCleanExits: false`, `infrastructurePassed: false`, and runner exit 1. Two earlier capture-pipe attempts timed out before the child matrix; changing stdin alone did not fix them. Their exact causes remain unknown. Their source identities and failure observations remain in `priorAttempts`.

Four contained junction-creation calls (parent/child, ordinary/ARAP target) actually executed and failed with `EPERM`. Subsequent `ENOENT` reads do not establish alias-target access denial. A deliberately pre-created projection hardlink shared the outside synthetic file's identity; the projection grant changed its shared DACL, and both generations read the outside name. This is an unsafe projection-making counterexample, separately reported from token behavior. Fixture ACL setup now rejects reparse descendants and files with multiple links before any mutation; an independent two-owned-root hardlink validation test confirmed refusal without changing the sentinel.

The additional candidate successfully created a restricted primary token and called `CreateProcessAsUserW` with LPAC attributes. The suspended root contained exactly the expected random restricting SID. After resume, Node exited `0xc0000022` with no JS output and no descendants. This is a startup blocker, not a successful isolation result. The specific denied runtime resource was not identified. No additional runtime ACL grants were attempted. Both final launches verified Job termination, profile deletion and temporary-directory removal.

The evidence supports stopping this unprivileged LPAC implementation from claiming strict filesystem isolation. It does not prove that every possible unprivileged Windows design is impossible. A new design must supply an explicit resource namespace or enforcement layer and re-run the full process-tree matrix. [Windows Sandbox configuration](https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file) offers explicit mapped folders and networking controls, but that environment and a private broker transport have not been tested here. Ordinary WSL with automount disabled is insufficient by itself: Microsoft explicitly documents that drives can still be mounted manually or through fstab. [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config) No VM, WSL distribution, driver, dependency, firewall rule or global exemption was installed or changed.

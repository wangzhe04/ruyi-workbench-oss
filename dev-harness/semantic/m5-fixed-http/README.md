# Fixed local HTTP harness

Stage a fresh group or human root on Windows from the repository directory. The current-product option uses the current app tree and the archived v9 versions of both business fixtures. The human fixture still starts a fresh server for each of its nine cases.

```powershell
python dev-harness/semantic/m5-fixed-http/stage.py group m5-fixed-http-group-r1 --node 'C:\Program Files\nodejs\node.exe' --windows C:\Windows --current-product
python dev-harness/semantic/m5-fixed-http/stage.py human m5-fixed-http-human-r1 --node 'C:\Program Files\nodejs\node.exe' --windows C:\Windows --current-product
node --test dev-harness/semantic/m5-fixed-http/flush-policy.test.cjs
```

Staging prints the contract path and SHA-256 without starting a server. Verify the staged build with its own `ruyi-workbench/app/build.js --check`, review the bindings and run only the chosen fresh root. The launch receipt, controller receipt, Job observations and held-handle retirement observations are written to that root's `case-output`.

```powershell
& 'C:\Program Files\nodejs\node.exe' <root>/launcher.cjs <root>/case-output/freeze.json <sha256>
```

The launcher consumes each contract once. Preserve a failed root and its receipts. A successful case requires the existing business and server-closure checks, natural outer Job drain, and an exit receipt from the original held handle for every accounted Job member. A launched flush helper also requires paired Node spawn, exit and close events with a validated input line and matching held Windows identity. Outer Job termination on failure is recorded separately.

## Business-only loopback lane

This lane verifies local business assertions, the guard-issued server and flush lifecycles, normal fixture and controller completion, and natural drain of an owned Windows Job. It does not run per-process kernel identity qualification. Its receipt has a separate status and leaves the strict lane's earlier failures intact.

Stage each fixture in a fresh root and use the printed contract hash after build and binding review.

```powershell
python dev-harness/semantic/m5-fixed-http/stage.py group m5-fixed-http-business-group-r1 --node 'C:\Program Files\nodejs\node.exe' --windows C:\Windows --current-product --business-only
python dev-harness/semantic/m5-fixed-http/stage.py human m5-fixed-http-business-human-r1 --node 'C:\Program Files\nodejs\node.exe' --windows C:\Windows --current-product --business-only
& 'C:\Program Files\nodejs\node.exe' <root>/business-launcher.cjs <root>/case-output/freeze.json <sha256>
```

The business-only launcher uses a separate contract type, and each root may be consumed once. For the human fixture, the nine original outcomes and known fixture closures are recorded in `case-output/human-business-evidence`. Confirm the outer receipt status is `PASS_M5_LOOPBACK_BUSINESS_ONLY_NATURAL_JOB_DRAIN` and `terminationRequested` is false. Fixture-requested shutdown of a held server may report SIGTERM. Outer Job fallback termination is a failure.

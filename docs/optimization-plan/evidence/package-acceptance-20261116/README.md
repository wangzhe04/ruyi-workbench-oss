# Archived package acceptance evidence

Archive of stable r1–r5 package preparation, build, qualification and acceptance receipts, the narrow donor audit, and browser navigation diagnostics/retests. Root independently verified all 128 artifacts before copying them from output staging. Each listed source is compressed with Node zlib gzip; the manifest records raw and compressed lengths/SHA-256 and a successful gunzip byte-for-byte readback.

No EXE, ZIP, complete stage, fixture configuration, or full fixture root is archived. The r3 run/source-copy bindings and qualify census/readback inventories are retained as compressed metadata.

Controller provenance: r1 original controller bytes were not retained; its original hash/receipt references remain in preserved run records. r2 controller bytes were saved after execution and matched the controller hash recorded for that run. r3 controller bytes were captured before execution.

The r3 acceptance result remains RED: slim-core journeys failed and Full/restore/install were not reached. The five later navigation retests are separate evidence and do not overwrite that run. The short/long/short-nav diagnostics document the about:blank cause and explicit navigation behavior.

Sensitive scan counts are recorded by category only in manifest metadata; no matched values are included.

## Navigation fix and fast validation

The slim navigation repair is committed at `6cea256beadf5f9e9962c19ca92ae161354ea1ca`. Its fast run validated the same bytes before that commit and exited and closed 0: 5,324 unit pass, 26 skip, 0 fail; static suite 100 pass, 0 fail, 0 flaky. The controller, receipt and four logs are included. This does not replace the original r3 RED or the five per-case navigation retests; subsequent r4/r5 outcomes follow below.

## r4 preflight and r5 scoped acceptance

The r4 attempt is retained as a preflight RED: the controller compared a dependency snapshot containing a duplicate `pkg.cmd` row against unique physical file membership. This comparison defect stopped the attempt before spawning the acceptance child; it was not demonstrated input drift. Its original controller and receipt are preserved. r5 deduplicates only the expected membership set while still checking every original hash row.

r5 completed with outer/original child exit and close code 0, both output EOFs, and inner validation `complete=true`, `failures=0`, 701 checks. Slim and Full journeys had no flaky results; mixed-input tool loops, old-backup restore, Full install/ensure/idempotence and MCP stdio checks passed. This is scoped acceptance evidence, not a whole-release or all-descendant-kernel certification.

Identity correction: the package build source remains HEAD `c0ab478bb3d7a55e6dca4ec2244584a2fe19620f`; the tested acceptance harness source revision is `6cea256beadf5f9e9962c19ca92ae161354ea1ca`. Annotated tag object `5055930875b32fc713d2fca01f652d7671f374db` peels to source commit `a014d30dde6fb140211ebaec9c96d8d23afd3503`. Validation reports `sourceDirty=true` because of an untracked root entry `0` (3 bytes, generated at 14:27Z); its content was not read and it was not changed or removed. Protected source inputs, app and package bindings remained unchanged. Do not state the entire repository was clean.

The inner evidence archive excludes the baseline tar, configuration and full data/fixture trees; only command logs, validation and small result JSON/text are included.

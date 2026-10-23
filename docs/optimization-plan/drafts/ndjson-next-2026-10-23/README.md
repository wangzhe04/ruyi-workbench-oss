# NDJSON draft shutdown handoff — 2026-10-23

FROZEN INCOMPLETE DRAFT. Do not apply these product files or count these three families as wired. No product repo edits, build, generated-runtime test, DPAPI test or direct E2E were performed for this draft.

Scope: steward-inbox (13i), steward-decisions (13j), agent-run-events (08 plus planned 06 gzip archive and 08 gzip reader). Scheduler tasks/fires/background-job-ledger are outside this draft.

Only the minimal line-probe package is independently reviewed and accepted by root. Its exact source SHA is CC531FA226C537AF6B64DD287B3316B2A25F6B4F25469915D5B254769722E4E0, patch 07491D5A14FB687345622603863FE1E0EAB21C96B7066518DCCA5DC6A753304D. That API is now applied by root. The expanded src/01q in this archive is a separate unfinished codec candidate; do not replace the live file with it.

Current source status:
- src/01q adds three fixed-purpose kinds and w3 chunked large-record encoding, then rebases the minimal lineProbe. Old four kinds preserve w2 AAD. Earlier pre-rebase codec tests were 17/17; the current rebased candidate was not rerun.
- src/01s contains shared leases, physical ordinals, staged encrypted append/replacement, fail-closed recovery gates and opaque recovery tickets. The LAST EDIT adds a metadata-only lineProbe pass and bounded ciphertext admission before materialization. That edit is UNTESTED and may require fixes. Do not claim current source passes earlier logs.
- src/13i,13j,08 partially connect domain readers/writers and recovery. Gzip archive/fallback, manifest registration and all consumer closure are NOT finished. src/06,09,manifest are copied baseline reference files, not product changes.

Evidence history, not current full acceptance:
- Pure codec 10 new +7 old-expanded tests passed before lineProbe rebase.
- Shared host 10/10 passed before recovery/metadata changes.
- Initial domain run 13/14 had one cross-realm array assertion; it was adjusted but the whole suite was not rerun. Initial fixture failures remain in raw logs.
- recovery-gate-first.log proves one narrow shared-host double-filesystem failure target passed (194.9ms) BEFORE last metadata refactor.
- recovery-domain-first.log proves actual stewardTickOnce next-tick seq/seen/carry recovery target passed (322.2ms) BEFORE last metadata refactor. Source events/presence were controlled fixture inputs; this is not an executed tool/noReplay test.
- Minimal lineProbe separately passed 7 new +7 existing tests and is the only complete reusable product slice.

Confirmed blockers / next work:
1. Cold-tail correctness: decodeLegacyWindow still uses old keyId/ciphertext/manifest fragment hints. A valid ~900KiB w2 row can exceed 1MiB physical tail and disappear, including reordered footer-hidden objects. ON and known-sealed reads must select logical plaintext windows. Unknown cold large OFF source may do one explicitly counted bounded metadata pass; strong file stamp must surround the original window read, not bind stale already-read data to a later stat. Warm proven plain retains old tail cost. Root approved this cold I/O tradeoff; do not claim unchanged cold O(tail).
2. Finish and test the latest metadata/readPhysicalRow scan. A normal finite-window reader must not materialize an unlimited ordinary legacy row merely to classify it. A maintenance/full legacy visitor can retain its old semantics. No new OFF business cap.
3. Re-run shared/domain suites after the metadata refactor, add low-window scaled cold-tail controls and count cold metadata versus warm reads, add ciphertext physical admission and source-swap tests.
4. Use peer's final WorkDataStore.createBinary API for 06 archive and 08 gzip fallback. Do not create another base64 wrapper. Complete all boot/launch/syncRunEventSeq/steward source error propagation; authenticate before producer side effects. Snapshot lease same operation, release owned only.
5. Add manifest entry for 01s only after dependency graph review, source compatibility/negative controls, independent review, root build and real DPAPI E2E window. Domain decision/event logging must retain completed action receipt and never replay a side effect after log failure.

Capacity contract: 256MiB is sealed engineering admission only, not a new business/OFF legacy limit. New w3 is one whole physical row and may materialize JSON; no bounded peak-RSS, hard latency, range-read or cross-process transaction claim. Process-local recovery gate is not durable intent. New process must rebuild seq/seen before producers.

See inventory-and-plan.json for complete baseline SHA/consumer inventory, recovery-and-scan-v2.md for reviewed design intent, restart-handoff.json for exact current artifact SHA. Older partial-frozen-sha256.json is historical and superseded.

## Small repository archive layout

This directory stores only five candidate patches and necessary source-test drafts, not complete source copies or raw logs. It is NOT an apply-ready patch stack. The 08/13i/13j diffs compare the old a61144fc baseline explicitly, and therefore also show existing snapshot/proxy-facade lines from the author's starting working tree. Those already-applied changes must be retained from the live repository during rebase; do not replay/revert other owners' work. The 01q diff uses the reviewed minimal lineProbe baseline; 01s is a new file. No patch has been applied or checked as a combined current-tree product change.

To resume: reconstruct candidate files in a separate TEMP src directory from the baseline identifiers in handoff.json, then relocate the source-test files next to that src directory. Tests currently refer to the original TEMP layout and a keys-B TEMP source; update these paths to the chosen exact codec/store baseline before running. The standalone expanded-old-kind test is a draft compatibility fixture, not permission to weaken the live original test. Test drafts are not auto-discovered from this docs directory.

All raw logs, full baseline/candidate reference files, prior failure logs and the independently reviewed lineProbe packet remain in the full TEMP ZIP described by handoff.json. The latest metadata refactor is intentionally preserved without claiming validation. This archive adds zero completed storage families.

# Audit-log next batch — paused before implementation

Repository archive: notes and identity metadata only. The baseline.json and six source copies mentioned below remain in the TEMP directory recorded by identity.json; they are not candidate implementation files and are intentionally not duplicated here.

Saved 2026-10-24 at user's request to finish today's current batch and stop.
Workspace: E:/Claude/worktrees/steward-3x-implementation
TEMP only. No audit live changes, candidate edits, patch, source tests, generated runtime or direct E2E exist. The six src/ files are exact baseline copies; see baseline.json and identity.json. They must be rebased against the final committed live source before implementation.

## Scope read and agreed direction

- Reuse WorkDataJournals (01s), WorkDataRecords and existing key leases/chunks. Add only actual audit-log kind with fixed purpose audit, day scope derived from controlled workbench-YYYY-MM-DD.ndjson filename. Frozen original four session KINDS and v2 AAD remain unchanged.
- 04-permission-runtime.js owns logEvent, daily stream rotation, latestLogFile, 2MiB log-tail and readLogTailSnapshot. 06-provider-engine.js owns readWorkbenchAudit (full file, not 2MiB tail), buildOpsMetrics and sweepLogsStore. Router log-tail and PrivacyTextExports log-tail-copy are necessary consumers.
- Preserve exact OFF JSON.stringify({ts: nowIso(), ...record})+LF bytes, day capture, business windows/filter-before-limit semantics and no new ordinary OFF capacity limit.
- Existing async shared metadata/auth rules remain: each current read/mutation really classifies bytes, sealed content authenticates with current key/instance; no full-stat cache as authority; OFF reserved/sealed mutations refuse; operation lease ends before model turns.
- Stable export requires an async check to re-read/authenticate current content and compare the same-scan digest/authority; final synchronous assert is only a cheap last guard, never cross-await or cross-process CAS.
- Minimal shared extension may be a dedicated readProof interface that opts into digesting the actual logical sink stream during its scan, not an additional raw read/hash and not materializing giant ordinary rows. Existing families need not pay a new digest cost or change behavior/AAD. This is a proposal, not implemented API.
- 13ab log-tail-copy should await snapshot.check in its existing async check; keep snapshot.assert in final guards. Router should propagate work_data failures via existing sendError; ordinary logs.none/read failures retain legacy behavior.
- Full audit and metrics readers must decode logical rows via the owner, retaining existing bad-legacy-row skipping and kind filtering order. Retention must authenticate current source before unlink and preserve bad/locked source; no new delete/CAS protocol was written.

## Remaining design work, not settled code

logEvent is fire-and-forget and must never break a completed turn. Moving to async shared writes needs bounded pending rows/bytes including in-flight work, explicit code-only loss diagnostics, local recursion suppression for readConfig/key diagnostics, no action replay and no unlimited promise/row queue. A single oversized ordinary OFF record must not acquire a new storage-family cap just due to queue batching. Need review the overload contract and prove successful/failing flush/read visibility before choosing constants or implementation.

readConfig recovery fallback must not silently turn logging OFF after a failed privacy/config read. Any recursion guard should be built-in AsyncLocalStorage scoped to the logger's own async context so concurrent business logs are unaffected; none has been added.

Recovery gate handling needs an explicit domain full-reader owner to validate/rebuild before acknowledgement; UI reads must never clear it. All source readers, producer errors, daily rollover and retention/export failure order need actual source fixture tests and real DPAPI generated-runtime E2E, run serially by root. No tests have been written or executed for audit yet, so audit-log is not wired/completed.

## Current batch closure context

The separate current38 counts/cursor repair is finished and frozen: 13i SHA256 019d8b3801c82f853f3e704cad1e98746ac7ab211d8ccbc969ff9b64fc1dcab8. Local targeted source/generated unit 24/24 passed; token reviewer repeated 24/24 and exact memo/auth/headcut negative controls. Root reported final DPAPI each twice and repaired old inbox-integrity fixture each twice all passed. Root owns remaining full gates, commit/push and final evidence. No root work is claimed complete here.

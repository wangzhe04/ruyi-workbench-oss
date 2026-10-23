# NDJSON follow-up design after independent root review

This is a design for the next TEMP revision. The current partial source SHA849809F2 remains unapplied and has three confirmed gaps: double filesystem failure can duplicate a partial inbox batch, a cold physical tail can hide a complete encrypted row, and sealed physical input needs admission before row materialization. No claim that these are already fixed.

## Partial append and failed rollback

Keep a separate process-local failure gate per physical file. If copying staged ciphertext fails and truncation back to the old committed boundary also fails, mark that file `work_data_journal.recovery_required` before rejecting. No subsequent append or replacement may run until an explicit domain recovery acknowledgement. Removing an ordinary ordinal/count cache entry cannot remove this gate. UI reads and count caches cannot acknowledge it.

The full authenticated reader may create an opaque recovery ticket only after scanning the entire committed prefix and verifying an unchanged strong file stamp. A ticket records the exact gate identity, file stamp and credential stamp inside a private WeakMap; domain metadata only carries the opaque token. An acknowledgement rechecks both source and credential identity before clearing the matching gate. It neither repairs a torn suffix nor rewrites the log.

Inbox recovery must rebuild durable business `inboxSeq` and `seen` from decoded rows and load its cursor before acknowledging. The existing tick's failed-batch carry then passes its normal dedupe filter; rows already committed by the partial append are not assigned/retried again. The uncommitted final fragment is repaired only by the next fully staged append. A count/UI read cannot clear recovery even if it authenticated the file.

Run diagnostics recover their business maximum through `syncRunEventSeq` before acknowledging. Decision logging may remain gated for the rest of the current process if no business recovery owner exists; its callers keep the completed action receipt and emit a nonsecret diagnostic. They never replay the completed action to recreate a missing diagnostic row.

Failure gates must not be evicted as ordinary LRU data. Bound active gates separately; if that bound is reached, refuse a new append before copying any bytes until existing gates recover. The gate is not a durable intent or a cross-process transaction. After a process restart the existing inbox cold-load/agent sequence recovery must rebuild from disk before producers run; ephemeral failed-batch carry does not survive restart.

Required deterministic probe: copy at least one complete encrypted row, fail a later write, fail the rollback truncate, attempt another append, and prove it is gated. A UI read must not unblock it. Then perform actual domain seq/seen rebuild and acknowledgement, retry the original carry, and prove each source key/business sequence occurs once. Key failure or source change during acknowledgement leaves the gate closed.

## Cold tail classification

An ON read and a warm known-sealed read use logical plaintext windows proactively. An unknown cold large OFF window cannot infer plaintext from a fragment inside base64: even adding `tag` as a footer hint would depend on JSON property order. Allow one explicitly counted metadata pass and bind its result to size/mtimeNs/ctimeNs/dev/ino. A proven plain unchanged file can keep the original byte-tail reader thereafter; a proven sealed file requires full physical-ordinal authentication and logical byte selection.

An ordinary complete small OFF window is already the full source and can establish its plain proof without another read or unlock. Tests must distinguish first cold metadata reads from subsequent warm tail reads. Do not describe the new cold large-file path as preserving absolute old O(tail) I/O.

## Physical input admission

Use the independently reviewed minimal `WorkDataRecords.lineProbe` rather than cloning a JSON lexer. It holds only scalar lexical state, observes an own top-level literal/escaped `w` in any property order, and never stores strings or a whole row. It does not validate JSON or authenticate a container.

Perform a metadata pass before `Buffer.concat`/`JSON.parse` of candidate rows. Count each LF, including skipped malformed/blank legacy rows, and measure each physical row. A reserved committed row exceeding its format engineering bound rejects before materialization. Late/reordered `w` is still found after a giant preceding value, so it cannot be discarded as a large ordinary legacy row. Legacy giant values are skipped by the metadata probe without assembling them or adding a new business cap.

Capture a strong source stamp around the metadata pass and validate it before materialization. Continue checking changes while reading, so a file swapped/grown after preflight cannot use a stale small-row proof to force unlimited ciphertext buffering. Metadata admission is not a peak-RSS guarantee: a maximum admitted encrypted row still needs JSON/container/decode memory; actual legacy domain processing may retain its old large-row semantics.

For append authentication only the committed prefix needs materialization. Record the final uncommitted suffix size without buffering it; an enormous torn suffix is not a reason to allocate it. Read/maintenance retain the old distinction between parseable legacy final JSON and malformed tails, and must not let an incomplete cipher suffix's physical `seq` become the run's business sequence.

No domain source patch is ready to apply until these gates, archive consumers and source tests are complete and independently reviewed.

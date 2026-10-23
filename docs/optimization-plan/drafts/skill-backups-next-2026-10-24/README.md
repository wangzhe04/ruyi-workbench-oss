# Migration skill backups — unfinished handoff

Do not apply this patch to production or count the family as wired. The user asked
to finish the current 38-family batch and stop for today. This packet preserves
the next backup batch; it has not been built, committed, pushed, or run through
the generated-runtime DPAPI E2E.

`product.patch` is a local diff from Git `9c12fe35` for only
`13u-migration-center.js`, `12-tool-dispatch.js`, and `13-http-router.js`.
It includes the common V3 implementation and the unfinished V4 short-name work.
The four added harness files are included at their intended relative paths.
There are no complete product/baseline copies or raw logs in this packet.
Exact hashes, external evidence locations and commands are in `handoff.json` and
`packet-hashes.json`.

V3 source tests passed **48/48**: existing migration 26 plus backup 22. Independent
review also confirmed readonly writer exclusion, final Basic metadata restoration,
whole registry/tool read ownership, and precise negative controls. However, a real
backup followed by undo after a 22-second wait lost custom 8.3 aliases while
retaining the same file IDs: `ORIGONE.TXT` / `ORIGTWO.TXT` became `LONG-P~1.TXT` /
`LONG-P~2.TXT`. Immediate undo passed because of NTFS name tunneling. Both outcomes
are retained in the evidence list. V3 is therefore **not complete**.

V4 adds authenticated `shortName`, native query/legality checks, a disposable
set/remove capability probe, sealed-capsule alias removal, alias restoration, and
an attempted metadata finalizer for an already-published restoring intent. Its
current ordinary and readonly success cases fail **2/2** with
`work_data_backup.restore_verify_win32_5` inside alias restoration. No fix or
independent acceptance of V4 exists. The suspected cause is setting directory
aliases while descendant handles are still open; isolate that exact operation
before changing the protocol.

Resume in a separate checkout or temporary reconstruction, never by applying this
draft to the live working tree. Start from `9c12fe35`, apply `product.patch` there,
and copy the included `dev-harness` files into that checkout. Existing source-slice,
crypto, atomic writer, and harness dependencies come from the checkout. Rebase only
these local differences over the current branch after checking the three baseline
hashes. The subsequent 38-family work changed shared modules; do not overwrite them
with historical TEMP dependencies.

Run the source command in `handoff.json` first; its current V4 failure is expected.
The portable delayed probe accepts `RUYI_MIGRATION_CANDIDATE` pointing at the
reconstructed checkout and `RUYI_SHORTNAME_DELAY_MS` (default 22000). That delay
reproduced this machine's cache expiry, not a universal Windows guarantee. Do not
change global filesystem cache/registry settings to make the test pass.

The next repair needs to preserve the original long/short namespace without relying
on tunneling. Consider restoring each child alias while its original directory is
still empty during private reconstruction, then final root aliases only after child
handles are released. Any release/reopen must retain original-object guards,
revalidate IDs, full DATA/ADS, entry sets and aliases, then restore/verify Basic
attributes and all four times. Handle the crash after root publication but before
metadata finalization; do not mark the intent complete from content hashes alone.
Root alias collisions with unrelated siblings must be rejected before destructive
undo. Include original empty alias and legal OEM/non-ASCII alias cases.

Preserve the accepted constraints: OFF remains whole-directory rename with no new
archive cap or key creation. ON uses original NTFS objects to retain their security
descriptors, authenticated binary archive and durable intent, exact arbitrary bytes,
file/directory ADS, and one migration owner for copy/undo and complete registry/tool
reads. No SACL is read or recreated. Reparse/hardlink/EA/unsupported stream or
attribute/filesystem/cross-volume/capacity cases fail before original data changes.
Unknown children/streams are never deleted as captured data. Post-intent failures
retain archive/objects/intent and report uncertain/no-retry outcomes. No claim is made
of cross-process CAS or resistance to a malicious same-account peer in private paths.

After a real fix: freeze a new identity, obtain independent source/capability review,
retain all first failures and exact negative controls, then let root apply local
differences, build once, run actual generated-runtime DPAPI and startup tests, and
finish the full required gates. This packet does none of those final steps.

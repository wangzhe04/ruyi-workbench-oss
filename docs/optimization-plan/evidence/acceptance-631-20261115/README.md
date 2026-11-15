# 145 archived acceptance evidence

This archive was copied from output staging after independent Root verification of all 47 artifacts. Every listed artifact is gzip-compressed; `manifest.json` records source label, raw byte count/SHA-256, compressed byte count/SHA-256, and successful gzip readback.

Included: 631 attempt-one unit RED log/receipt; W4 A/B receipts and logs; complete 631 v2 runner logs, receipts, controller, selection, and before/after input snapshots; repo-hygiene rerun artifacts; two enable failure summaries/events; first encrypted-restore failure summary/events; and the successful CfT enable controller, head observation, runner receipt/logs/input snapshots, and synthetic `result.json`/`events.jsonl`.

Sensitive scan: the same synthetic test fixture output has one `sk-`-shaped marker in each of the attempt-one and v2 unit logs (two occurrences total). Values are not repeated in this report. No bearer token, AUTH_TOKEN assignment, GitHub-token shape, or AWS access-key shape was detected. Placeholder and ellipsis markers are present in test output and are classified as non-credentials.

Scope exclusions: no fixture configuration, package/upload body, or complete fixture root is included. UNKNOWN ownership remains preserved; no historical owner was cleaned up or acted on by PID. The CfT enable case passed with exit 0 in 92.3 seconds. Its pre-start HEAD observation is not available; browser identity was recorded before and after. The saved HEAD observation and input snapshots are supplementary. Encrypted-restore CfT evidence is included as described below.

## CfT encrypted restore update

Terra's isolated encrypted-restore browser run passed in 252.291 seconds with exit and close code 0 and no timeout. Its runner receipt records unchanged HEAD and tracked inputs before/after. The archive adds its controller, input snapshots, receipt, stdout/stderr, and only the synthetic fixture `result.json`/`events.jsonl`.

The prior historical encrypted-restore failure/flaky record remains included and unchanged. This later CfT pass is supplemental evidence; it does not erase the 631 result or historical flaky status. The UNKNOWN owner from the earlier installed-browser attempt remains untouched.

## Compression verification correction

Correction to the initial staging note: the .NET `GZipStream` writer emitted zero-byte files for six empty stderr sources, and the earlier .NET readback accepted those empty files. They were not valid gzip streams, so the prior claim that all 47 artifacts had valid gzip framing was incorrect. Only the six empty stderr artifacts were rewritten with Node `zlib.gzipSync(Buffer.alloc(0))` (20 bytes each). A subsequent Node `gunzipSync` check of all 47 archives verified gzip framing, raw byte counts, and raw SHA-256 values for every artifact.

# M4 independent image resource profile — source review batch

Baseline: `c5ebb3f55daa958293ad987a289415b5797c6244`, worktree
`m4-image-production`, branch `codex/m4-image-regions`. This batch does not change
MAIN, the old four locks, prior source/evidence archives or the old 4987 admission.
It adds a recoverable candidate and reviewable qualification machinery. It has
not restored resources or run Python/native/PE/server/browser/network/install.

## Explicit identities and current behavior

The default host profile remains `legacy-full-4987-v1`. It still uses the original
4987 files / 413946142 bytes, CPython 3.12.10 and original 19922194-byte 09b source
sidecar through unchanged `verify-media-artifacts.cjs` and `frozenProof`.
An explicit install environment value `RUYI_MEDIA_RESOURCE_PROFILE` can select
`m4-image-cpython312-candidate-v2`. The browser request whitelist is unchanged;
JSON cannot select a profile, executable, command, PATH, source root or manifest.
Unknown/empty IDs refuse; a failed new profile never enters the legacy branch.

The new ID reads two application-code-pinned JSON files under
`ruyi-workbench/resources/media-profiles`. The complete resource file list has
3251 entries / 396911379 bytes: 3238 original tuples, 37-byte replacement `_pth`,
and 12 retained historical control/evidence files. Those controls are retained
for reconstruction and review; their old worker/loader is not the production
worker. The proposed worker is the current 13bc inline string, bound by exact
hash and version. No capability is minted from a disk manifest or byte receipt.

`verify-media-profile.cjs` exposes `verifyMediaProfileTree({profileId,root,signal})`
for the restored **whole stage root**, containing `payload/` and `control/`.
Its receipt always says execution/source/provenance/legal/ready false and atomic
namespace lease unproved. `captureMediaProfile` is a private WeakMap capture
binding profile digest + source-recipe digest + worker digest + OCR language.
Clones, other workers, unknown recipes and stale files refuse. Execution assertion
currently returns `media.profile_qualification_pending` for every genuine new
capture; 13bc translates it to `privacy.image_processor_resource_profile_pending`.
It performs no fallback, filesystem resource scan or spawn on this pending path.
This is an explicit unfinished activation gate, not a runtime owner claiming to
be ready. The existing processing/private coverage/close/final-await owner path,
four-owner contracts, TTL, scope, recipient and Gateway remain unchanged.

## Actual byte delta and startup contract

The frozen audit reports 1748 old mismatches: 1732 `.pyc`, 7 installation RECORDs,
9 non-bytecode Scripts (six launchers, three Python CLI scripts). Three Scripts
cache files are already counted in the 1732; these categories are disjoint.
The old RECORDs did not hash the 1732 caches. Build/install path, source metadata,
interpreter/compile settings and installation bookkeeping are plausible causes
of drift, not a proved reconstruction of original hashes. Current tool Python
3.12.14/69 files is unrelated to this original 3.12.10 distribution.

This image candidate removes loose cached bytecode and CLI launcher surfaces
rather than admitting their drifted bytes. The worker uses library APIs and no
CLI launcher/PATH lookup. The seven omitted RECORDs are installation inventories,
not Python source files; whether all transitive execution avoids their use still
needs the actual startup/import/resource qualification. The other installed
packages and 21 wheels remain conservatively retained. PDF/Office/video and their
future API/renderer needs have not been deleted from M4 delivery scope.

The closed-tree observation verifies every row, every implied directory and
the absence of all unlisted entries, including empty unexpected directories.
It rejects case aliases, Windows device/ADS/trailing-dot paths, ancestor reparse
points, file hardlinks (`nlink != 1`), reused file identities, loose pyc/pyo,
`__pycache__`, dynamic `.pth`, second `._pth` and Scripts. It hashes through an
opened fd, compares its initial/final and visible identity/metadata, rescans the
complete directory shape and rechecks all ancestors/files after the final read.
Cancellation and close failure cannot produce success. It is a time-point
observation, not an OS-enforced write exclusion lease across a later spawn.

The new `_pth` bytes are exactly `python312.zip\r\n.\r\nLib/site-packages\r\n`
(37 bytes, f61e7c…). They have no `import site` line. Proposed fixed startup is
the pinned `payload/python_embed/python.exe`, fixed cwd beside that executable,
`-I -S -B -X utf8 -c <bound inline worker>`, and exactly the three profile search
paths. `-B` alone does not prohibit reading pre-existing bytecode: absence of loose
cache files and a namespace custodian must remain enforced throughout execution.
The stdlib ZIP is separately pinned in its entirety and has the retained exact
entry ledger; legitimate ZIP bytecode cannot be confused with loose unverified
cache files. `_pth` relative entries must resolve to the interpreter-owned tree,
never request cwd. No site/user customization, environment path or dynamic pth
may add imports. The observed flags/path/module/DLL traces must be gathered by a
trusted collector and checked against this contract; the retained historical
consistency checker explicitly did not prove collector completeness or custody.

DLL loads can happen before the inline worker. The actual dependency graph,
transient imports/data opens, native extension and statically linked dependency
correspondence, Windows loader search and trusted SystemRoot boundaries, pinned
OS OCR resources/language and fresh owned TEMP/TMP are still unresolved. Arbitrary
host PATH/PYTHON*/user-site/cwd/DLL environment inheritance must be rejected by
the future activation owner. No test here claims those runtime facts from `-I`,
`-S`, an exe hash or a single final `sys.modules` snapshot. No new third-party API
claim was obtained over the network in this batch; consult primary CPython and
Microsoft documentation before implementing the native qualification owner.

## Source boundaries

Original source lock `media-runtime-sources.json` pins source-content lock
9129d3e4… and original sidecar 09b13acc…. The retained, verified recovery route
(`m3-host-m4-stage-20261027/blobs/4968ffd…gz`, decoded digest 4968ffd…) explicitly
records that the **original content-lock and 19f223… provenance bytes were not
located**, only their pins. This batch located that contract, not the missing
files. Neither those hashes nor a new tree prove how to reconstruct the exact
old ZIP encoding. Recover an actual old object or create a new source identity;
do not alter 9129/19f/09b pins to make old admission pass.

The new source recipe keeps all source flags false. OpenCV/font 6909-path/6728-object
technical closure is referenced precisely, not treated as all FFmpeg/runtime
sources, notices, build provenance or distribution permission. Retain the
difference between cv2's opencv-python b83046…/OpenCV 40738… source, plugin wrapper
a0a660…, binary 06dc20…, source commit 664c009…, FFmpeg n7.1/libvpx/AOM/OpenH264 API,
compiler/static runtimes, CPython and every wheel. The original 32-byte OpenH264
API archive is not evidence of complete headers. All exact archive/member,
recipe/toolchain, corresponding-source, notice and legal gaps are explicit in
`m4-image-cpython312-candidate-v2-sources.json`. No archival source byte was fetched,
extracted or reclassified in this batch.

## RestoreMap and next owner

Ignored review directory `.ruyi-runtime/m4-media-profile-20261029` contains the
data-only `RESTORE-MAP.json`: all 3251 exact destination/source/length/hash tuples,
candidate metadata and audit pins, required source adoption and copy steps.
Those paths are bounded audit observations, not ownership, global absence
proofs or permission. Unknown attempt2/live/partial/network actors were not used.

`media-profile-restore.cjs` is executable copy orchestration for Root/Terra's next
explicit resource window. There is no filesystem adapter or normal startup/HTTP
binding. The caller supplies independently reviewed **sealed read-only source**
and **new empty target** custodians directly; a disk map cannot create them.
Source methods: `capture(rows)`, synchronous `assert(lease)`, `openPinned(lease,row)`.
Target methods: `beginEmpty(rows)`, synchronous `assert(lease)`,
`openExclusive(lease,row)`, `finishReadback(lease,rows)`. The fd interfaces are Node
`stat/read/write/sync/close`. Custodians must reject ancestor/visible aliases,
hardlinks and namespace changes, hold and explicitly release/retain their own
scopes beyond this operation, forbid overwrites/merges and keep the target alive
on failure for scoped cleanup. The orchestration does not own or release these
outer scopes and cannot certify their implementation from return booleans.

`restoreMediaProfile({mapBytes,sourceOwner,targetOwner,signal})` requires the exact
392fef63… RestoreMap. It creates each member exclusively through the target owner,
streams held-source bytes within exact bounds with partial-write handling,
hashes, fsyncs, reads back through the target fd, compares bytes/hash, rechecks
source/target identities, closes both handles and invokes final complete-tree
readback. It checks both custodian assertions after every await. Close uncertainty
refuses and retains outer ownership. The final result remains an observation;
directory fsync support is reported separately and no runtime authority follows.
The generic `copyOwnedRows` is also observation-only and is not imported by the
production host. Its synthetic tests prove copy/error ordering, not source trust.

Next practical steps: assign/adopt the 3238 payload sources and 13 pth/control
sources under sealed custody; implement/review those two small filesystem
custodians; restore to a fresh ignored root and run the 3251 full-tree verifier;
then qualify actual isolated imports/DLL/OS/language and the new execution-owner
adapter on those exact bytes. Review each actually needed binary/source gap,
then activate only the explicit new profile in reviewed application code. Do
not treat the current pending branch as the completion of this work or permit
a generic true flag to activate it. Source, resource and qualification changes
must freeze a new profile identity and bindings before real worker use.

## Permanent E2E and validation scope

`dev-harness/media-resource-profile.e2e.js` is the new real-HTTP entry required by
CONTRIBUTING hard constraint 5. Its default missing-resource branch and strict
`--full-components` mode have different verdict names and scopes. The default
uses normal serve, shared fake provider, isolated home/both AppData/TEMP/data,
OFF original HTTP upload/model path, ON exact resource refusal/zero model POSTs,
original retention and actual frontend preparation-module attachment draft
retention. It has no fake processor. Windows credential DPAPI remains real.

Full component mode requires actual old-verified resources, or a future explicitly
qualified new profile, target OCR language, and a reviewed public synthetic oracle
pack with all mandatory image cases. Missing prerequisites fail rather than skip.
It calls actual prepare, verifies independent pixels/metadata and preview/final
chat-completions PNG identity and removal. The precise external fixture schema,
mandatory case list and remaining journey gaps are permanent in
`dev-harness/media-resource-profile.README.md`. Both modes are **authored and
syntax checked only**, not run in this source window. E2E behavior/cleanup first
runs and native matrix work remain Root/Terra tasks; no ALL PASS is claimed.

Actual local validation in this source window: 47 pure/VM tests (33 new profile/
copy checks and 14 original processor/host checks), Node syntax, build/freshness,
129-module/880-edge graph check and facts/static alignment. An initial pth test
input created a new parent directory and hit the earlier extra-tree gate; its
input was changed to the existing interpreter directory without changing the
expected pth refusal. Initial copy fixtures compared cloned row object identity
and accidentally returned inode zero; they were corrected to key by row path.
The original fail-closed inode-zero assertion remained unchanged. First-red
events remain in the review report. No full unit suite or all-static result is
claimed. Original S1 E2E/region obligations remain: real OCR/QR/linear correctness,
source/DLL/OS/custody, Responses/Anthropic final wire, preview disconnect, editor
browser/theme/size/switch/Send/Steer, work-data DPAPI/backup/migration/cold purge,
TTL/unknown/faults/history, PDF/Office/video and M6.


## 2026-10-30 bounded Linear R1 follow-up

The original pending/source-gap descriptions above are preserved as dated scope. A fixed17 public component matrix, independent review and pre-promotion source58 snapshots now exist in the bounded [Linear R1 archive](../evidence/m4-linear-support-r1-20261030.json). This does not activate the production profile or close corresponding-source/notices/legal, namespace/write custody, HTTP preview/final-wire, DPAPI or the broader M4 matrix. See [committed-B2 combination handoff](m4-linear-r1-committed-b2-20261030.md) for the exact next independent technical steps.

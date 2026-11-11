# Media resource qualification entries

`node dev-harness/media-resource-profile.e2e.js` is the ordinary offline HTTP
branch. It starts a normally built server in a fresh home/data/workspace, uses the
shared local fake provider and tests OFF original-byte delivery, ON exact typed
missing-resource/pending-profile refusals, zero model POSTs after refusal, and
retention of the attachment draft by the real frontend preparation module.
Windows DPAPI is an actual prerequisite. This is not a browser or native OCR pass.

`node dev-harness/media-resource-profile.e2e.js --full-components` is a separate,
strict actual image-component qualification entry. It requires explicit absolute
`RUYI_MEDIA_RUNTIME_ROOT`, `RUYI_MEDIA_SOURCES_ROOT`, target-installed
`RUYI_MEDIA_OCR_LANGUAGE` and `RUYI_MEDIA_QUALIFICATION_FIXTURES`. The optional
`RUYI_MEDIA_RESOURCE_PROFILE` defaults to `legacy-full-4987-v1`; selecting
`m4-image-cpython312-candidate-v2` currently refuses qualification. No successful
byte census, copied resource tree, disk manifest or true JSON flag activates it.
Missing resources or fixtures fail; there is no skip or substitute processor.

The fixture manifest is an external reviewed **public synthetic** input pack.
The repository now includes a reproducible generator; no private image, font,
OCR result or model output is an input:

```powershell
# First verify the chosen Full runtime and source artifacts with the normal
# verifier. The parent of --output must exist; the output itself must be new.
& (Join-Path $env:RUYI_MEDIA_RUNTIME_ROOT 'python_embed/python.exe') -I -B -X utf8 `
  dev-harness/lib/generate-media-qualification.py --output C:\owned-public-fixtures\m4-new
$env:RUYI_MEDIA_QUALIFICATION_FIXTURES = 'C:\owned-public-fixtures\m4-new\manifest.json'
node dev-harness/media-resource-profile.e2e.js --full-components
```

The generator checks Python 3.12.10, Pillow 12.3.0, OpenCV Python 5.0.0.93 and
NumPy 2.5.1. It writes only a fresh named directory and never installs or fetches
dependencies. `recipe` records the generator SHA-256, exact versions, OpenCV
build-information hash, and the fixed hand-drawn 5×7 glyph recipe. All seventeen
source files have SHA-256 pins. Rebuilding into another new directory preserves
source-file bytes; absolute paths in the manifest naturally differ.

The pack covers PNG, BMP, JPEG and lossless WebP. EXIF 1–8 cases use independent
source-pixel coordinate mappings and known colour markers; JPEG colour oracles
account for its decoded source bytes. The transparent RGB case expects white
after compositing; WebP EXIF/XMP metadata must disappear from the final PNG.
The generator encodes EAN-13 directly, including its checksum, and uses the
pinned OpenCV encoder only to construct a QR input. It does not run production
recognition to manufacture expected answers. Mask oracles include white source
gaps inside the word and barcode rectangles, plus retained public colour points,
so simple transcoding and blacking out the whole image both fail.

The manifest's fixed `policyRules` are the literals `SECRET` and
`5901234123457`, both in category `INTERNAL`. They are synthetic test inputs,
not a relaxation of the application's privacy policy. The Full entry admits
only these fixed rules. Real OCR/code decoding and actual preview/wire delivery
remain acceptance steps; successfully generating this pack does not prove them.

An illustrative case entry (the full manifest also requires the two fixed
`policyRules` emitted by the generator):

```json
{
  "schema": 1,
  "kind": "public-synthetic-media-image-oracles",
  "cases": [{
    "id": "sensitive-text",
    "file": "C:/owned-public-fixtures/sensitive-text.png",
    "sha256": "<exact source SHA256>",
    "expected": "success",
    "width": 640,
    "height": 240,
    "pixels": [{"x": 40, "y": 80, "rgb": [0, 0, 0]},
               {"x": 620, "y": 220, "rgb": [255, 255, 255]}]
  }]
}
```

All cases are mandatory: blank, sensitive-text, sensitive-qr, sensitive-linear,
transparent-hidden-rgb, metadata, explicit-regions, orientation-1 through
orientation-8, bad-input and animation. Success cases require dimensions and
independent pixel oracles. Sensitive/region cases require both black-mask and
retained public-content samples. explicit-regions additionally supplies canonical
`boxes`; the entry binds them to the first real prepare manifest. Negative cases
specify `expected: "refusal"` and the precise `privacy.*` code. The supplied
recipe pins source generation and uses no installed fonts. A different fixture
recipe requires its own review and source pins. The entry checks actual preview PNG
structure/bytes/pixels and final chat-completions provider PNG identity, original
preservation and explicit deletion.

Current M4 results and their exact source/package boundaries are recorded in
`docs/optimization-plan/92-3.1-implementation-handoff.md`, sections 12.67 onward.
Chat/Anthropic/Responses native PDF delivery, DPAPI snapshot/codec/cold-reference
refusal, browser Chat Send/Steer, and document/video results each have separate
evidence. Do not convert a default missing-resource result, fixture generation,
or an earlier component run into a passing current Full matrix. Public source
correspondence, build provenance and distribution materials remain the separate
review in section 12.69; final installation/upgrade and cross-account/machine
qualification belong to M6.

## Current-source and protocol qualification

For an explicit current-source qualification copy, set
`RUYI_MEDIA_QUALIFICATION_WORKBENCH` for `--full-components`, or
`RUYI_MEDIA_BROWSER_SOURCE_ROOT` for the browser entries. Its generated server
must hash-identically match the workspace service. Supply the already verified
`RUYI_MEDIA_RUNTIME_ROOT` and `RUYI_MEDIA_SOURCES_ROOT`; the qualification copy
must contain the selected source lock, verifier tools and application resources.
This is source qualification, not an accepted new installation package.

The encrypted real-browser journeys are selected by `--browser-full`,
`--browser-full-responses` and `--browser-full-anthropic`. They use actual
Windows DPAPI, file selection, region editing, preview responses, Send and
attachment-only Steer. Each loopback protocol receiver must obtain exactly the
reviewed PNG, with no original bytes, original name or private reference. With
`RUYI_MEDIA_BROWSER_PACKAGE` instead of a source root, the original packaged
entry retains its package validation and default resource paths.

`node dev-harness/media-image-http-lifecycle.e2e.js` checks missing-component
refusal and an incomplete HTTP prepare body disconnected after server admission.
Its `--full-components` branch additionally uses
`RUYI_MEDIA_LIFECYCLE_ROOT` (the matching qualification copy), explicit runtime,
source and OCR language settings. It exercises a post-header preview disconnect,
physical-source and policy revocation, the actual 60-second ticket expiry, and
four preparation slots after expiry. The observer only records HTTP events;
it does not replace the processor, clock, owner or native worker. This does not
claim a mid-body PNG interruption or actual native-worker timeout. Native
cancellation, timeout and uncertain-owner behavior retain their separate tests.

`protected-document-video.e2e.js --full-components` covers the native model-turn
path for PDF/video and bounded Office projections. XLSX/ODT/ODS content previews
are reflowed text, not original page-layout rendering. Standard ODP text boxes,
formula/hidden-sheet and conditional/external content, and unsupported non-ASCII
visual rendering keep their explicit refusals. Supported non-ASCII text must
remain intact. The three wire protocols use real loopback HTTP receivers; no
live model account is invoked.

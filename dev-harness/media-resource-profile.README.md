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

The fixture manifest is an external reviewed **public synthetic** input pack:

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
specify `expected: "refusal"` and the precise `privacy.*` code. Font, source image,
QR/linear generator, orientation and alpha recipes must be pinned by the fixture
author before Root schedules acquisition/generation; this repository does not
pretend those pending artifacts exist. The entry checks actual preview PNG
structure/bytes/pixels and final chat-completions provider PNG identity, original
preservation and explicit deletion.

This source batch has not run either HTTP entry. Full source correspondence,
trusted startup/DLL/OS/namespace custody and target OCR language qualification
remain pending. This entry is the image component seed, not the entire M4 matrix:
Responses/Anthropic final wire, DPAPI work-data ON/backup/migration/cold-restart,
TTL/unknown/cancel/timeout/changed-source/language faults, native process telemetry,
HTTP preview disconnect, real editor browser journeys (themes/1440/768/390,
rapid switching, first blank session, Send/Steer), cold purge/history and
PDF/Office/video/M6 still require their complete dedicated journeys. Retain the
existing `.ruyi-runtime/m4-image-production/E2E-PLAN.md` obligations when extending
this entry. A passing default missing-resource branch cannot close any of them.

# Media runtime source evidence (M4)

Generated from resources/media-runtime-dependencies.json. Do not edit by hand; run:
`node tools/generate-media-source-evidence.cjs`.

This report separates runtime inventory, recorded source identities and public-distribution readiness.
It performs no network lookup or external archive verification and grants no execution or redistribution approval.

## Runtime inventory coverage

The table counts only artifacts in the runtime inventory; external sidecars and local qualification sources are listed separately below.

| Distribution | Version | License | Wheel artifacts | Source archives | Status |
| --- | --- | --- | --- | --- | --- |
| cffi | 2.1.1 | MIT-0 | 1 | 0 | wheel-only (no source archive in inventory) |
| charset-normalizer | 3.4.9 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| cryptography | 50.0.0 | Apache-2.0 OR BSD-3-Clause | 1 | 0 | wheel-only (no source archive in inventory) |
| et_xmlfile | 2.0.0 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| lxml | 6.1.1 | BSD-3-Clause | 1 | 0 | wheel-only (no source archive in inventory) |
| numpy | 2.5.1 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | 1 | 0 | wheel-only (no source archive in inventory) |
| opencv-python-headless | 5.0.0.93 | Apache 2.0 | 1 | 0 | wheel-only (no source archive in inventory) |
| openpyxl | 3.1.5 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| pdfminer.six | 20260107 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| pdfplumber | 0.11.10 | classifier | 1 | 0 | wheel-only (no source archive in inventory) |
| pillow | 12.3.0 | MIT-CMU | 1 | 0 | wheel-only (no source archive in inventory) |
| psutil | 7.2.2 | BSD-3-Clause | 1 | 0 | wheel-only (no source archive in inventory) |
| pycparser | 3.0 | BSD-3-Clause | 1 | 0 | wheel-only (no source archive in inventory) |
| pypdf | 6.14.2 | BSD-3-Clause | 1 | 0 | wheel-only (no source archive in inventory) |
| pypdfium2 | 5.12.1 | BSD-3-Clause, Apache-2.0, dependency licenses | 1 | 0 | wheel-only (no source archive in inventory) |
| python-docx | 1.2.0 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| python-pptx | 1.0.2 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| reportlab | 5.0.0 | BSD license (see license.txt for details), Copyright (c) 2000-2025, ReportLab Inc. | 1 | 0 | wheel-only (no source archive in inventory) |
| typing_extensions | 4.16.0 | PSF-2.0 | 1 | 0 | wheel-only (no source archive in inventory) |
| winsdk | 1.0.0b10 | MIT | 1 | 0 | wheel-only (no source archive in inventory) |
| xlsxwriter | 3.2.9 | BSD-2-Clause | 1 | 0 | wheel-only (no source archive in inventory) |

Runtime inventory SHA-256: `4e84862cf50907c84b14a55dcabcc347ae3a52e78a88031b7ecb878565d6735f`.

## Legacy source references

- Referenced provenance `resources/ffmpeg-provenance.json`: **missing from this repository**; expected SHA-256 `19f223b29e6ff7b1eef46a08685e157e7e5f2c81ce76c6ad48a968bb8f8aa249`.
- Legacy sidecar identity: `09b13acc951b1ca1ed5f0971a51564599daad1bf733d2bf1f02c29d5c124f0d7`, 19922194 bytes. Its presence is not established by this report; a recorded hash does not recover an archive.
- Ordinary Full keeps `resources/media-runtime-sources.json`; the local qualification profile below does not replace that lock.

## Explicit local-full-v2 qualification sources

Manifest `tools/media-runtime-sources-local-full.json`, SHA-256 `ee7bc948d5211ede4fe97aeda21c3d6e8b6b74082ac1c3da19b515ae07a44bb7`, binds the runtime lock above.
These are registered identities, not a claim that external files are present or that all 21 distributions have corresponding source.

- `opencv-windows-ffmpeg-sources-v2-local.zip`: 107865207 bytes; SHA-256 `57a854ff5a73fed60f12903bdbdd189b7660f024b6724e5a4b804b81ef810a23`.
- `opencv_python_headless-5.0.0.93.tar.gz`: 81817738 bytes; SHA-256 `b82f9831daab90b725c7c1ee1b36cb5732c367096ac76d119e64e14eb70d5f3c`.

Toolchain build attestation: **pending**. All-distribution source correspondence: **pending**. Public redistribution admission: **not granted**.

## Separate wheel and plugin build observations

Bounded public observations are recorded in `resources/media-runtime-public-source-audit.json`; embedded version strings and recipes do not attest the actual build environment.

- `python_embed/Lib/site-packages/cv2/cv2.pyd`: runtime hash `eefedf6ee006a84bbc7d3df5ec66046429b8c95dbfd5f8f8f98c5772b91d6d48`; MSVC 19.44.35228.0; embedded binary metadata only.
- `python_embed/Lib/site-packages/cv2/opencv_videoio_ffmpeg500_64.dll`: runtime hash `7aabff029d1fa47cf56ede4dbbe05dc62da3208f07cd16471d4c966a33f9aa31`; MinGW POSIX GCC 13.0.0; embedded binary metadata only.
- Wheel source commit `b83046cda41133f1bf2e73e99dba16a1248f103a`, OpenCV gitlink `40738fb16ceddb5fb3fea747585f7ce6abb0605b`: [fixed Windows wheel workflow](https://github.com/opencv/opencv-python/blob/b83046cda41133f1bf2e73e99dba16a1248f103a/.github/workflows/build_wheels_windows.yml), SHA-256 `ed7998427b440618ba0d1ee2e48204eb462b5d2416e7df5f7b7034e6fb6d7c1e`.
- FFmpeg plugin binary commit `06dc20cad65dc7fcf784f70c95d46750520889a7`, source commit `664c0098dcb47b361f20c1d6a518653c23f5f2b5`, separate OpenCV wrapper source `a0a660fcb1e58a295e6caa6aee64ed4d369b0181`.
- [Fixed upstream recipe](https://raw.githubusercontent.com/opencv/opencv_3rdparty/664c0098dcb47b361f20c1d6a518653c23f5f2b5/ffmpeg/docker/Dockerfile), SHA-256 `31dc0f663053c80e63967b624f9e90efb6ed1f014d66fe094544ec5c599a8242`: ubuntu:24.04 base tag without digest; apt packages without version pins.
- [Fixed upstream recipe](https://raw.githubusercontent.com/opencv/opencv_3rdparty/664c0098dcb47b361f20c1d6a518653c23f5f2b5/ffmpeg/build_videoio_plugin.sh), SHA-256 `d9d6a15cfdb90eebc3136bad76eea3eb5d26cec97bd7b04c4063ac26f8cfde02`: recipe requests -static, -static-libgcc and -static-libstdc++; actual linked archive identities remain unproven.
- [Fixed upstream recipe](https://raw.githubusercontent.com/opencv/opencv_3rdparty/664c0098dcb47b361f20c1d6a518653c23f5f2b5/ffmpeg/build_via_docker.sh), SHA-256 `0ad8cfc8bd3b8e28120eee19654a4d0a784033869ef50f56fafd6c2ad64331c3`: recipe builds a local Docker tag; it does not record the image digest used for the published DLL.

## Evidence still required for public distribution

- Maintainer build log or attestation binding the exact FFmpeg DLL hash to its actual Docker image digest, apt snapshot and package manifest.
- Actual link map or equivalent static archive identities for libgcc, libstdc++, MinGW and Winpthreads, with their corresponding source and notices.
- Separate source, build and notice correspondence for all 21 distributions and bundled native dependencies; two OpenCV-related source artifacts do not close this matrix.
- Independent review of the exact intended distribution, notices, source delivery and applicable offer or relinking materials before any public distribution decision.

Inventory structural findings: none. Source/build/distribution gaps above remain open.

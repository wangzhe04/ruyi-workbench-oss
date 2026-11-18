# Full-local OpenH264 source supplement

The original locked Full-local source ZIP contains an empty OpenH264 header archive. Keep that ZIP and its existing lock unchanged. New Full-local source deliveries must additionally contain the independently locked supplement with four official headers and their license.

On the build machine, obtain the five files listed in `openh264-supplement.lock.json`. That lock contains their fixed-commit official URLs, byte sizes and SHA-256 hashes. Save them under their listed basenames in a new `$HeaderRoot` directory. The builder performs no network access and rejects changed or missing files. Python 3.12.10 was verified; the resulting archive must match the locked 15,592 bytes and SHA-256 exactly. Python is needed only on the build machine.

From the repository root, set the variables below to your own absolute paths. `$BuildPython` must identify an existing `python.exe`; `$SupplementRoot` and the output's parent directory must already exist. The supplement builder refuses to overwrite an existing archive.

```powershell
& ./ruyi-workbench/tools/build-openh264-supplement.ps1 -BuildPython $BuildPython -HeaderRoot $HeaderRoot -Destination (Join-Path $SupplementRoot 'openh264-headers-v2.5.0-supplement.tar.xz')
& ./ruyi-workbench/tools/prepare-full-local-media-sources.ps1 -SourceRoot $LegacySourceRoot -Destination $PreparedSourceRoot -SupplementRoot $SupplementRoot -BuildPython $BuildPython
& ./ruyi-workbench/tools/package-offline.ps1 -IncludeAcc -LocalMediaSources -Variant full-local -MediaSourcesRoot $PreparedSourceRoot -BuildPython $BuildPython
```

`$LegacySourceRoot` must contain both original locked artifacts: `opencv-windows-ffmpeg-sources-v2-local.zip` and `opencv_python_headless-5.0.0.93.tar.gz`. Preparation verifies the original files and supplement before copying and verifies the destination again. Packaging carries both original artifacts, the supplemental archive and `openh264-supplement.lock.json` in `resources/media-runtime-sources`. The supplement's `LICENSE` is inside its archive. The PowerShell entry points explicitly start and await Python without relying on `PATHEXT` or document associations.

This supplemental archive does not prove which headers built the historical DLL. Actual corresponding source, patches, build provenance, replacement/relink validation and final package coverage remain open release requirements. These tools do not authorize public distribution.

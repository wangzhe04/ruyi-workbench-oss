"""Preserve source material reviews before integrating build-tool changes."""
import importlib.util
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', LIB)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
OUT = a.BASE / 's3c-media-supplement-reviewed-20261118-r1'
DIRECTORIES = [
    'm4-distribution-obligations-review-20261118-r1',
    'm4-ffmpeg-static-20261118-r1',
    'm4-ffmpeg-static-20261118-r2',
    'm4-ffmpeg-static-20261118-root-r2',
    'm4-ffmpeg-provenance-20261118-r1',
    'm4-openh264-header-supplement-20261118-r1',
    'm4-source-preparation-integration-candidate-20261118-r1',
    'm4-source-preparation-integration-candidate-20261118-r2',
    'm4-source-preparation-root-20261118-r1',
    'm4-source-preparation-root-20261118-r2',
    'm4-supplement-ps-probe-20261118-r1',
    'm4-supplement-ps-probe-20261118-r2',
]

paths = [pathlib.Path(__file__).resolve(), LIB]
for name in DIRECTORIES:
    directory = ROOT / 'output' / name
    paths += a.files(directory)
    frozen = directory / 'freeze.json'
    if not frozen.is_file():
        continue
    contract = json.loads(frozen.read_text(encoding='utf-8'))
    for row in contract.get('bindings', []):
        file = pathlib.Path(row.get('path', row.get('file', '')))
        if not a.safe_file(file):
            continue
        raw = file.read_bytes()
        assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256'], file
        if file.is_relative_to(ROOT):
            paths.append(file)
        else:
            assert file == pathlib.Path('C:/r31-1109/m4-source-v2-local-45a725a7/build-local-source-sidecar.py')
            copy = ROOT / 'output/m4-source-preparation-root-20261118-r2/original-external-builder.py'
            assert not copy.exists()
            shutil.copyfile(file, copy)
            paths.append(copy)

# Keep reviewed pre-change build inputs independently of future live mutations.
snapshot = ROOT / 'output/m4-source-preparation-root-20261118-r2/original-tools'
snapshot.mkdir()
for name in ['prepare-full-local-media-sources.ps1', 'package-offline.ps1', 'media-runtime-sources-local-full.json']:
    source = ROOT / 'ruyi-workbench/tools' / name
    copy = snapshot / name
    shutil.copyfile(source, copy)
    paths.append(copy)
for name in ['root-m4-supplement-integration-review.py', 'root-m4-supplement-integration-review-v2.py']:
    paths.append(ROOT / 'dev-harness/semantic' / name)
a.build(OUT, paths, a.old_index())
a.verify(OUT)

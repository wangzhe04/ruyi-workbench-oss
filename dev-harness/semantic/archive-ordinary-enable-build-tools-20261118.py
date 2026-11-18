"""Preserve ordinary enable PASS and build-tool changes with exact inputs."""
import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', LIB)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
OUT = a.BASE / 's3c-ordinary-enable-and-build-tools-reviewed-20261118-r1'
paths = [pathlib.Path(__file__).resolve(), LIB]

def bound(contract):
    for row in contract['bindings']:
        file = pathlib.Path(row.get('file', row.get('path', '')))
        # Keep only repository-owned source. OS/compiler/SDK and native or
        # compressed artifacts remain identified by hashes in the contract.
        if not file.is_relative_to(ROOT) or not a.safe_file(file):
            continue
        raw = file.read_bytes()
        assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256'], file
        paths.append(file)

root = ROOT / 'output/semantic-target-binding-captured-read-v1'
assert a.sha((root/'root-review.json').read_bytes()) == 'e920a3918f2d80d4b21f23cd22a77a78167b7a2505ac6e9e371c4bacf66f2c13'
bound(json.loads((root/'contract.json').read_text(encoding='utf-8')))
paths += [file for file in root.iterdir() if a.safe_file(file)]
paths.append(root/'baseline-evidence/events.jsonl')

for name in ['semantic-desktop-bootstrap-owner-candidate-v1', 'semantic-desktop-job-list-candidate-v1',
             'm4-openh264-repro-builder-candidate-20261118-r1']:
    root = ROOT / 'output' / name
    bound(json.loads((root/'freeze.json').read_text(encoding='utf-8')))
    paths += a.files(root)
for name in ['semantic-desktop-job-list-build-v1', 'm4-openh264-repro-root-20261118-r1']:
    paths += a.files(ROOT/'output'/name)
paths += [ROOT/'output/m4-source-preparation-root-20261118-r2/root-integration.json',
          ROOT/'output/m4-source-preparation-root-20261118-r2/root-capsule-postwalk.json',
          ROOT/'output/semantic-gemma2-proxy-resident-smoke-v2/root-capsule-postwalk.json']
for name in ['root-target-binding-read-preflight.cjs', 'root-target-binding-read-review.cjs',
             'root-desktop-job-list-compile.py']:
    paths.append(ROOT/'dev-harness/semantic'/name)
for name in ['prepare-full-local-media-sources.ps1','package-offline.ps1',
             'validate-openh264-supplement.py','invoke-supplement-validator.ps1',
             'openh264-supplement.lock.json','build-openh264-supplement.py',
             'build-openh264-supplement.ps1','README-media-source-supplement.md']:
    paths.append(ROOT/'ruyi-workbench/tools'/name)
a.build(OUT, paths, a.old_index())
a.verify(OUT)

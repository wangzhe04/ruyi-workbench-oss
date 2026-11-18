"""Archive reviewed source closures, not data roots or model dependencies."""
import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', LIB)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
OUT = a.BASE / 's3c-resident-and-publication-reviewed-20261118-r1'
paths = [pathlib.Path(__file__).resolve(), LIB]

def checked(row):
    file = pathlib.Path(row.get('file', row.get('path', '')))
    if not a.safe_file(file):
        return
    assert file.is_relative_to(ROOT), file
    raw = file.read_bytes()
    assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256'], file
    paths.append(file)

for name in ['semantic-candidate-target-category-diagnostic-v1',
             'semantic-candidate-root-settlement-real-enable-v2',
             'semantic-candidate-publication-cause-v3',
             'semantic-candidate-publication-diff-v4']:
    root = ROOT / 'output' / name
    f = json.loads((root / 'contract.json').read_text(encoding='utf-8'))
    for row in f['bindings']:
        checked(row)
    paths += [file for file in root.iterdir() if a.safe_file(file)]
    paths.append(root / 'baseline-evidence/events.jsonl')

for name in ['semantic-resident-proxy-production-candidate-v3',
             'semantic-resident-proxy-production-candidate-v4']:
    root = ROOT / 'output' / name
    f = json.loads((root / 'freeze.json').read_text(encoding='utf-8'))
    for row in f['bindings']:
        checked(row)
    paths += [file for file in root.iterdir() if a.safe_file(file)]

for name in ['semantic-gemma2-proxy-cn-lease-smoke-v2',
             'semantic-gemma2-proxy-resident-smoke-v2']:
    root = ROOT / 'output' / name
    f = json.loads((root / 'freeze.json').read_text(encoding='utf-8'))
    # Six model assets and 586 runtime files stay external: do not read or
    # archive them through this collector. Root actual run verified their pins.
    for row in f['bindings']:
        file = pathlib.Path(row['file'])
        if file.is_relative_to(root) or file.is_relative_to(ROOT / 'dev-harness/semantic'):
            checked(row)
    paths += [file for file in root.iterdir() if a.safe_file(file)]

for name in ['semantic-proxy-global-fence-window-probe-r1',
             'semantic-proxy-global-fence-window-root-r1',
             'semantic-proxy-global-fence-window-probe-r2',
             'semantic-proxy-global-fence-window-root-r2',
             'm5-http-guard-research-20261118-r1']:
    root = ROOT / 'output' / name
    paths += [file for file in root.iterdir() if a.safe_file(file)]

for name in ['root-target-category-preflight.cjs', 'root-target-category-review.cjs',
             'root-candidate-settlement-preflight.cjs', 'root-candidate-settlement-review.cjs',
             'root-publication-cause-preflight.cjs', 'root-publication-cause-review.cjs',
             'root-publication-diff-preflight.cjs', 'root-publication-diff-review.cjs',
             'root-proxy-global-fence-window-probe.cjs', 'root-proxy-global-fence-window-probe-v4.cjs',
             'semantic-proxy-global-fence-window-probe.cjs', 'semantic-proxy-global-fence-window-probe-v4.cjs',
             'root-gemma2-proxy-smoke-preflight.py',
             'semantic-legacy-proxy-integration-assessment.json',
             'resident-lease-bootstrap-parent-death-design-v1.json']:
    paths.append(ROOT / 'dev-harness/semantic' / name)
a.build(OUT, paths, a.old_index())
a.verify(OUT)

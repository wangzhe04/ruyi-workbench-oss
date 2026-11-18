"""Preserve fixed HTTP first failures, exact sources and root mock review."""
from pathlib import Path
import importlib.util
import json

ROOT = Path(__file__).resolve().parents[2]
library = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', library)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
base = ROOT / 'output/m5-http-fixed-harness-candidate-20261118-r1'
paths = [Path(__file__).resolve(), library]
for kind in ('group', 'human'):
    root = base / ('actualrun-' + kind + '-v9')
    contract = root / 'case-output/freeze.json'
    for row in json.loads(contract.read_text(encoding='utf-8'))['bindings']:
        file = Path(row['path'])
        if not file.is_relative_to(ROOT) or not a.safe_file(file):
            continue
        assert '%SystemDrive%' not in file.parts
        assert not any(x in file.parts for x in ('case-home', 'keeper-home', 'launcher-home'))
        raw = file.read_bytes()
        assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256']
        paths.append(file)
    paths += [file for file in (root / 'case-output').iterdir() if a.safe_file(file)]
review = base / 'actualrun-group-v9/case-output/root-review.json'
assert a.sha(review.read_bytes()) == '8cf154e55253acbbdf8025021d1a338701577117d786e41480698b4d105c1e54'
for name in ('m5-http-root-v9-preflight-20261118-r1',):
    root = ROOT / 'output' / name
    paths += [file for file in root.iterdir() if a.safe_file(file)]
    paths += [file for file in (root / 'tests').iterdir() if a.safe_file(file)]
for name in ('root-m5-fixed-v9-preflight.cjs',
             'root-m5-fixed-v9-launch.cjs', 'root-m5-group-v9-review.cjs', 'root-m5-flush-plan-match.cjs'):
    paths.append(ROOT / 'dev-harness/semantic' / name)
destination = a.BASE / 's3c-m5-flush-denial-reviewed-20261118-r1'
a.build(destination, paths, a.old_index())
a.verify(destination)

"""Preserve the failed category-only export run; no homes or data roots."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
library = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('capsule_library', library)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
root = ROOT / 'output/semantic-export-census-phase-v2'
assert a.sha((root / 'root-review.json').read_bytes()) == 'afa5f6c9b65aa74559f11e9380123446e98db9d4f376ae19b4351c856f3a5595'
paths = [Path(__file__).resolve(), library]
for row in json.loads((root / 'contract.json').read_text(encoding='utf-8'))['bindings']:
    file = Path(row['file'])
    if not file.is_relative_to(ROOT) or not a.safe_file(file):
        continue
    assert '%SystemDrive%' not in file.parts
    assert not any(x in file.parts for x in ('baseline-data', 'baseline-backups'))
    raw = file.read_bytes()
    assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256']
    paths.append(file)
paths += [file for file in root.iterdir() if a.safe_file(file)]
paths += [root / 'baseline-evidence' / name for name in
          ('events.jsonl', 'baseline-server-stdout.log', 'baseline-server-stderr.log')]
paths += [ROOT / 'dev-harness/semantic' / name for name in
          ('root-export-census-phase-preflight.cjs', 'root-export-census-phase-review.cjs')]
destination = a.BASE / 's3c-export-census-phase-reviewed-20261118-r1'
a.build(destination, paths, a.old_index())
a.verify(destination)

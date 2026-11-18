"""Archive compile-only source checkpoint with its blocking root findings."""
from pathlib import Path
import importlib.util
import json

ROOT = Path(__file__).resolve().parents[2]
library = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', library)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
root = ROOT / 'output/semantic-resident-home-service-candidate-v1'
assert a.sha((root / 'freeze.json').read_bytes()) == 'abb730626ecaa4c8d5610510bce3b86359d335a7b0c36a0f1ed7e0d64e842be0'
assert a.sha((root / 'root-source-review.json').read_bytes()) == 'deb4cd4089df6be74a40acebe3ed7f74afa5de7c4009d61c3bb1d3168d75afce'
paths = [Path(__file__).resolve(), library]
for row in json.loads((root / 'freeze.json').read_text(encoding='utf-8'))['bindings']:
    file = Path(row['file'])
    if not file.is_relative_to(ROOT) or not a.safe_file(file):
        continue
    assert '%SystemDrive%' not in file.parts
    raw = file.read_bytes()
    assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256']
    paths.append(file)
paths += [file for file in root.iterdir() if a.safe_file(file)]
paths += [file for file in (ROOT / 'output/semantic-resident-home-service-build-v1').iterdir() if a.safe_file(file)]
review = json.loads((root / 'root-source-review.json').read_text(encoding='utf-8'))
for name, key in [('manifest.json', 'manifestSha256'), ('00-boot.js', 'bootSha256')]:
    file = ROOT / 'ruyi-workbench/app/src' / name
    assert a.sha(file.read_bytes()) == review['manifestOrder'][key]
    paths.append(file)
paths += [ROOT / 'dev-harness/semantic' / name for name in
          ('root-resident-home-compile.py', 'root-resident-home-source-review.cjs')]
destination = a.BASE / 's3c-resident-home-checkpoint-reviewed-20261118-r1'
a.build(destination, paths, a.old_index())
a.verify(destination)

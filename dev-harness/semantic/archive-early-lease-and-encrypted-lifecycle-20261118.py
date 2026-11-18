"""Preserve reviewed early-lease execution and failed full lifecycle inputs.

Only pinned repository sources and explicit top-level receipts/logs are eligible.
Homes, data, backups, model assets, native binaries and OS SDK bodies stay out.
"""
import importlib.util
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIB = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', LIB)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
OUT = a.BASE / 's3c-early-lease-and-encrypted-lifecycle-reviewed-20261118-r1'
paths = [pathlib.Path(__file__).resolve(), LIB]


def pinned(root, filename):
    contract = json.loads((root / filename).read_text(encoding='utf-8'))
    for row in contract['bindings']:
        file = pathlib.Path(row.get('file', row.get('path', '')))
        if not file.is_relative_to(ROOT) or not a.safe_file(file):
            continue
        assert '%SystemDrive%' not in file.parts
        assert not any(x in file.parts for x in ('baseline-data', 'baseline-backups'))
        raw = file.read_bytes()
        assert len(raw) == row['bytes'] and a.sha(raw) == row['sha256'], file
        paths.append(file)
    paths.extend(file for file in root.iterdir() if a.safe_file(file))


reviews = {
    'semantic-desktop-early-lease-actual-run-v2':
        '449de4e3bcbb009592ec0f9b24b3ffda58669876551c85375137f3c9ccf69f63',
    'semantic-encrypted-lifecycle-v3':
        'dbe0830c6b417b850b204aace4fe157c98fb60a90af12a3830c132d33fd1a5bb',
    'semantic-export-snapshot-cause-v1':
        'e717dbcf348707b017a87137d10ee223b64172cd96b49ce39f63a9d116d42600',
}
for name, expected in reviews.items():
    root = ROOT / 'output' / name
    assert a.sha((root / 'root-review.json').read_bytes()) == expected, name
    pinned(root, 'freeze.json' if 'early-lease' in name else 'contract.json')
    if 'early-lease' not in name:
        for filename in ('events.jsonl', 'baseline-server-stdout.log',
                         'baseline-server-stderr.log'):
            paths.append(root / 'baseline-evidence' / filename)

for name in ('semantic-desktop-early-lease-probe-source-v1',
             'semantic-desktop-early-lease-probe-source-v2',
             'semantic-desktop-early-lease-actual-run-v1'):
    pinned(ROOT / 'output' / name, 'freeze.json')
pinned(ROOT / 'output/semantic-candidate-integrated-v1', 'contract.json')
build = ROOT / 'output/semantic-desktop-early-lease-build-v1'
paths.extend(file for file in build.iterdir() if a.safe_file(file))
for name in ('root-desktop-early-lease-compile.py',
             'root-integrated-migration-preflight.cjs',
             'root-encrypted-lifecycle-preflight.cjs',
             'root-encrypted-lifecycle-review.cjs',
             'root-early-lease-actual-preflight.cjs',
             'root-early-lease-actual-review.cjs',
             'root-export-snapshot-cause-preflight.cjs',
             'root-export-snapshot-cause-review.cjs'):
    paths.append(ROOT / 'dev-harness/semantic' / name)
a.build(OUT, paths, a.old_index())
a.verify(OUT)

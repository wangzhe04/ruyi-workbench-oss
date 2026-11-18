"""Preserve pending source using verified prior capsule content references.

No product execution. Excludes holdouts, homes, data, weights and native objects.
"""
from pathlib import Path
import hashlib
import importlib.util
import json

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / 'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec = importlib.util.spec_from_file_location('archive_library', LIB)
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
BASE = a.BASE
OUT = BASE / 's3c-checkpoint-source-handoff-20261118-r1'
META = ROOT / 'output/precommit-source-handoff-20261118-r1'
assert not OUT.exists() and not META.exists()
META.mkdir()
hash_file = lambda p: hashlib.file_digest(p.open('rb'), 'sha256').hexdigest()
definitions = [
    ('m3-relative', 'output/semantic-preserved-relative-open-v1/contract.json', '81cc61e41394f0f95a1f7081c1338595935c140b2158f873930ac6c4b5fc7c0e'),
    ('home-v2', 'output/semantic-resident-home-service-candidate-v2/freeze.json', '1c56c2072752e06be34fb9253675b72d4ed38e866b8a1a9c2cc72df8629627ad'),
    ('home-normal-r2', 'output/home-normal-r2/freeze.json', '15b99d4c87b3e16d83787c397a4cc8806b42a8b965b9380aad381b9a6ab4762e'),
    ('home-handoff-r2', 'output/home-handoff-r2/freeze.json', '459287e1e8c2dfa8ecb60f100dfcf3335be6de2d5debee1663a9af7007476851'),
    ('standalone-napi', 'output/semantic-standalone-napi-guard-candidate-v1/freeze.json', 'de668a12790c2bd3e2ecd8318f6f1ee18c810af908959fa992980697c59b3e2b'),
    ('m5-helper-plan', 'output/m5-http-fixed-harness-candidate-20261118-r1/v9-work/helper-plan-freeze.json', '73e43d3fab6490f97d7eceb7c67d849405ef5395eae8231a4ef8b5240a730740'),
]
prior = {}
for file in sorted(BASE.rglob('manifest.json')):
    raw = file.read_bytes()
    doc = json.loads(raw)
    for row in doc.get('records', []):
        if not all(k in row for k in ('source', 'rawSha256', 'rawBytes')) or not ('member' in row or 'prior' in row):
            continue
        if 'acceptance' in row['source'].lower():
            continue
        prior.setdefault(row['rawSha256'], {'manifest': file.relative_to(ROOT).as_posix(),
            'manifestSha256': a.sha(raw), 'source': row['source'], 'rawBytes': row['rawBytes']})

paths = [Path(__file__).resolve(), LIB]
candidates = []
binary = {'.exe', '.dll', '.node', '.onnx', '.gguf', '.safetensors', '.bin', '.o', '.obj', '.a', '.zip', '.xz'}
for key, relative, pin in definitions:
    file = ROOT / relative
    assert hash_file(file) == pin, key
    contract = json.loads(file.read_text(encoding='utf-8-sig'))
    rows = contract['bindings']
    sources = []
    excluded = 0
    for row in rows:
        original = Path(row.get('file', row.get('path', '')))
        assert original.stat().st_size == row['bytes'] and hash_file(original) == row['sha256'], original
        if not original.is_relative_to(ROOT) or not a.safe_file(original) or original.suffix.lower() in binary:
            excluded += 1
            continue
        alias = original.relative_to(ROOT).as_posix()
        assert '%SystemDrive%' not in original.parts
        assert not any(part in original.parts for part in ('baseline-data', 'baseline-backups', 'case-home', 'actor-home', 'observer-home', 'keeper-home', 'launcher-home'))
        entry = {'source': alias, 'bytes': row['bytes'], 'sha256': row['sha256']}
        found = prior.get(row['sha256'])
        if found:
            assert found['rawBytes'] == row['bytes']
            entry['priorCapsule'] = found
        else:
            entry['currentCapsuleSource'] = alias
            paths.append(original)
        sources.append(entry)
    paths.append(file)
    candidates.append({'id': key, 'contract': relative, 'contractSha256': pin,
        'bindings': len(rows), 'sourceInputs': sources, 'excludedNativeSystemOrData': excluded,
        'qualification': 'CANDIDATE_OR_SCOPED_ONLY_NOT_RELEASE_PASS'})

for folder in ('semantic-resident-home-service-build-v2', 'semantic-resident-home-service-root-v2'):
    paths += [file for file in (ROOT / 'output' / folder).iterdir() if a.safe_file(file) and file.suffix.lower() not in binary]
paths += [ROOT / 'dev-harness/semantic' / name for name in
          ('root-resident-home-v2-compile.py', 'root-resident-home-v2-preflight.py', 'root-home-knownfolder-probe.cjs')]
mapping = META / 'source-input-map.json'
mapping.write_text(json.dumps({'schema': 1, 'status': 'SOURCE_CHECKPOINT_NOT_RELEASE_APPROVAL',
    'candidates': candidates, 'limits': ['Native binaries, OS/compiler/SDK bodies, weights, homes, keys, user data and holdouts excluded.',
    'Original absolute paths/tool hashes are historical. Rebase and freeze fresh owned inputs before executing on another machine.',
    'Pending candidates are not promoted by being committed.']}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
paths.append(mapping)
a.build(OUT, paths, a.old_index())
a.verify(OUT)
index = {'schema': 1, 'status': 'PRE_RC_SOURCE_CHECKPOINT_NOT_RELEASE',
    'manifest': (OUT / 'manifest.json').relative_to(ROOT).as_posix(),
    'manifestSha256': hash_file(OUT / 'manifest.json'),
    'sourceMap': mapping.relative_to(ROOT).as_posix(),
    'candidates': [{'id': row['id'], 'contract': row['contract'], 'contractSha256': row['contractSha256'],
                    'bindings': row['bindings'], 'sourceInputs': len(row['sourceInputs'])} for row in candidates]}
target = BASE / 'checkpoint-source-handoff-20261118.json'
with target.open('x', encoding='utf-8', newline='\n') as stream:
    json.dump(index, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
print(json.dumps(index, ensure_ascii=True))

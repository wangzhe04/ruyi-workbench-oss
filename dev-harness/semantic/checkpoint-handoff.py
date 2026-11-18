"""Verify the checkpoint source capsule; optionally materialize one inert candidate.

No builders, product/native code, holdouts or external dependencies are executed.
"""
from pathlib import Path, PurePosixPath
import argparse
import gzip
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
INDEX = 'docs/optimization-plan/evidence/semantic-retrieval-20261116/checkpoint-source-handoff-20261118.json'
sha = lambda data: hashlib.sha256(data).hexdigest()


def relative(value):
    path = PurePosixPath(value)
    assert not path.is_absolute() and '..' not in path.parts and ':' not in value
    assert not any('acceptance' in part.lower() or part == '%SystemDrive%'
                   for part in path.parts)
    return path


def read(value):
    path = ROOT.joinpath(*relative(value).parts)
    assert path.is_file() and not path.is_symlink()
    return path.read_bytes()


def manifest(path, pin):
    raw = read(path)
    assert sha(raw) == pin, path
    return json.loads(raw)


def decode(path, row):
    reference = row.get('prior')
    if reference:
        prior = manifest(reference['manifest'], reference['manifestSha256'])
        assert any(item.get('rawSha256') == row['rawSha256']
                   and item.get('rawBytes') == row['rawBytes']
                   and item.get('member') == reference['member']
                   and item.get('gzipSha256') == reference['gzipSha256']
                   for item in prior['records'])
        owner, blob = reference['manifest'], reference
    else:
        owner, blob = path, row
    member = relative(blob['member'])
    compressed = read(str(PurePosixPath(owner).parent / member))
    assert len(compressed) == blob['gzipBytes'] and sha(compressed) == blob['gzipSha256']
    raw = gzip.decompress(compressed)
    assert len(raw) == row['rawBytes'] and sha(raw) == row['rawSha256']
    return raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-originals', action='store_true')
    parser.add_argument('--materialize', help='candidate ID from the source map')
    parser.add_argument('--dest', help='new directory; source bytes only, never executed')
    args = parser.parse_args()
    assert bool(args.materialize) == bool(args.dest)
    index = json.loads(read(INDEX))
    path = index['manifest']
    assert index['manifestSha256'] == '01ff82dede697bbb4b1dd3a9b9acc0644cf9b18c7d6df4f27e0e84650dc83f75'
    doc = manifest(path, index['manifestSha256'])
    contents = {}
    local = set()
    drift = set()
    for row in doc['records']:
        relative(row['source'])
        raw = decode(path, row)
        if args.verify_originals:
            if read(row['source']) != raw:
                drift.add(row['source'])
        contents[row['source']] = raw
        if 'prior' not in row:
            local.add(row['member'])
    assert len(local) == doc['localUniqueMembers']
    mapping = json.loads(contents[index['sourceMap']])
    selected = None
    total = 0
    for candidate in mapping['candidates']:
        contract = contents[candidate['contract']]
        assert sha(contract) == candidate['contractSha256']
        files = {candidate['contract']: contract}
        for entry in candidate['sourceInputs']:
            relative(entry['source'])
            if 'priorCapsule' in entry:
                ref = entry['priorCapsule']
                prior = manifest(ref['manifest'], ref['manifestSha256'])
                rows = [r for r in prior['records'] if r['source'] == ref['source']]
                assert len(rows) == 1
                raw = decode(ref['manifest'], rows[0])
                assert len(raw) == ref['rawBytes']
            else:
                raw = contents[entry['currentCapsuleSource']]
            assert len(raw) == entry['bytes'] and sha(raw) == entry['sha256']
            if args.verify_originals:
                if read(entry['source']) != raw:
                    drift.add(entry['source'])
            files[entry['source']] = raw
            total += 1
        if candidate['id'] == args.materialize:
            selected = files
    if args.materialize:
        assert selected is not None, 'unknown candidate'
        target = Path(args.dest).resolve()
        assert not target.exists(), 'destination must be new'
        target.mkdir(parents=True)
        for alias, raw in selected.items():
            dest = target.joinpath(*relative(alias).parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open('xb') as stream:
                stream.write(raw)
    print(json.dumps({'status': 'ARCHIVE_VALID_ORIGINAL_PATH_DRIFT' if drift else 'CHECKPOINT_CAPSULE_AND_SOURCE_MAP_PASS',
        'manifestSha256': index['manifestSha256'], 'aliases': len(contents),
        'localMembers': len(local), 'mappedInputs': total,
        'originalsCompared': args.verify_originals, 'materialized': args.materialize,
        'originalPathDrift': sorted(drift),
        'releaseQualified': False}))
    if drift:
        raise SystemExit(1)


if __name__ == '__main__':
    main()

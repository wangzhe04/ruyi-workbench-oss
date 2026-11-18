"""Independent postwalk; do not import the archive builder or its verifier."""
from pathlib import Path, PurePosixPath
import gzip
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'docs/optimization-plan/evidence/semantic-retrieval-20261116'
DEST = BASE / 's3c-export-generation-reviewed-20261118-r1'
digest = lambda raw: hashlib.sha256(raw).hexdigest()
raw_manifest = (DEST / 'manifest.json').read_bytes()
assert digest(raw_manifest) == '6e2072fbca86bd2b10ccbfd148a86683d3d9a22b9b36fbad0f676b3d54e9b6a4'
m = json.loads(raw_manifest)
local = set()
for row in m['records']:
    rel = PurePosixPath(row['source'])
    assert not rel.is_absolute() and '..' not in rel.parts
    assert not any('acceptance' in x.lower() or 'cache' in x.lower()
                   or x == '%SystemDrive%' for x in rel.parts)
    assert not any(x in rel.parts for x in ('baseline-data', 'baseline-backups'))
    source = ROOT.joinpath(*rel.parts)
    assert source.is_file() and not source.is_symlink()
    current = source.read_bytes()
    assert len(current) == row['rawBytes'] and digest(current) == row['rawSha256']
    reference = row.get('prior')
    if reference:
        prior_file = ROOT / reference['manifest']
        assert digest(prior_file.read_bytes()) == reference['manifestSha256']
        blob_root, blob_row = prior_file.parent, reference
    else:
        blob_root, blob_row = DEST, row
        local.add(row['member'])
    member = PurePosixPath(blob_row['member'])
    assert not member.is_absolute() and '..' not in member.parts
    compressed = blob_root.joinpath(*member.parts).read_bytes()
    assert len(compressed) == blob_row['gzipBytes']
    assert digest(compressed) == blob_row['gzipSha256']
    assert gzip.decompress(compressed) == current
assert len(local) == m['localUniqueMembers']
receipt = {
    'status': 'ROOT_INDEPENDENT_CAPSULE_SOURCE_GZIP_REFERENCE_POSTWALK_PASS',
    'manifestSha256': digest(raw_manifest),
    'sourceAliases': len(m['records']),
    'localUniqueMembers': len(local),
    'priorReferences': sum('prior' in row for row in m['records']),
    'productReleaseQualified': False,
}
with (ROOT / 'output/semantic-export-generation-category-v1/root-capsule-postwalk.json').open(
        'x', encoding='utf-8', newline='\n') as stream:
    json.dump(receipt, stream, indent=2)
    stream.write('\n')
print(json.dumps(receipt))

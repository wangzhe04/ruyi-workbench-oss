"""Independent byte-level postwalk, without importing the archive builder."""
import gzip,hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[2]
CAP=ROOT/'docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-canonical-matrix-and-candidate-reviewed-r1'
OLD=ROOT/'docs/optimization-plan/evidence/semantic-retrieval-20261116/s3c-blocker-first-batch-reviewed-r1/manifest.json'
digest=lambda b:hashlib.sha256(b).hexdigest()
raw=(CAP/'manifest.json').read_bytes()
assert digest(raw)=='032a7e17a33bf593bd9be7b5e087823242619f0ae39e62cfc91ab330934ec27a'
data=json.loads(raw);assert len(data['records'])==1017
assert digest(OLD.read_bytes())=='1991daab188700b9dcd5c57dca3db4a1a86f030e8b62fd513f241e3ccf2634f5'
local=set();prior_count=0
for row in data['records']:
 source=(ROOT/pathlib.PurePosixPath(row['source'])).resolve()
 assert source.is_relative_to(ROOT) and not source.is_symlink()
 assert not any('acceptance' in part.lower() for part in source.parts)
 original=source.read_bytes()
 assert len(original)==row['rawBytes'] and digest(original)==row['rawSha256']
 ref=row.get('prior')
 if ref:
  assert (ROOT/ref['manifest']).resolve()==OLD.resolve()
  assert ref['manifestSha256']==digest(OLD.read_bytes())
  member=(OLD.parent/ref['member']).resolve();assert member.is_relative_to(OLD.parent)
  size,sha=ref['gzipBytes'],ref['gzipSha256'];prior_count+=1
 else:
  member=(CAP/row['member']).resolve();assert member.is_relative_to(CAP)
  size,sha=row['gzipBytes'],row['gzipSha256'];local.add(row['member'])
 compressed=member.read_bytes();assert len(compressed)==size and digest(compressed)==sha
 result=gzip.decompress(compressed)
 assert result==original and len(result)==row['rawBytes'] and digest(result)==row['rawSha256']
assert len(local)==158 and prior_count==803
print(json.dumps({'status':'ROOT_INDEPENDENT_SOURCE_AND_GZIP_POSTWALK_PASS','records':1017,'localMembers':158,'priorReferences':803,'manifestSha256':digest(raw)}))

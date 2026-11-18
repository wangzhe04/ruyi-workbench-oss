#!/usr/bin/env python3
"""Independent serial readback of the two archived evidence capsules."""
import gzip,hashlib,json,pathlib,re
ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/optimization-plan/evidence/semantic-retrieval-20261116'
OLD=BASE/'s3c-blocker-first-batch-reviewed-r1/manifest.json'
OLD_SHA='1991daab188700b9dcd5c57dca3db4a1a86f030e8b62fd513f241e3ccf2634f5'
digest=lambda raw:hashlib.sha256(raw).hexdigest()
if digest(OLD.read_bytes())!=OLD_SHA:raise ValueError('prior_manifest')
prior=json.loads(OLD.read_bytes());prior_members={(r['member'],r['rawSha256'],r['gzipSha256'],r['rawBytes'],r['gzipBytes']) for r in prior['records']}
def event_check(value):
 if isinstance(value,dict):
  for k,v in value.items():
   if re.search(r'password|token|key|payload',k,re.I):raise ValueError('sensitive_event_key')
   event_check(v)
 elif isinstance(value,list):
  for v in value:event_check(v)
for label in ['s3c-recovery-candidate-and-proxy-transport-reviewed-r1','s3c-m4-source-and-license-materials-reviewed-r1']:
 root=BASE/label; manifest=(root/'manifest.json').read_bytes();m=json.loads(manifest);members=set();prior_count=0
 for item in m['records']:
  source=ROOT/pathlib.PurePosixPath(item['source'])
  if not source.is_file() or source.is_symlink() or any('acceptance' in p.lower() or 'cache' in p.lower() for p in source.parts):raise ValueError('source_path')
  if source.suffix.lower() in ('.exe','.dll','.node','.zip','.tar','.gz','.xz','.whl','.bin','.onnx'):raise ValueError('forbidden_suffix')
  if 'prior' in item:
   ref=item['prior']; prior_count+=1
   key=(ref['member'],item['rawSha256'],ref['gzipSha256'],item['rawBytes'],ref['gzipBytes'])
   if ref['manifestSha256']!=OLD_SHA or key not in prior_members:raise ValueError('prior_record')
   path=OLD.parent/ref['member'];expected_bytes=ref['gzipBytes'];expected_hash=ref['gzipSha256']
  else:
   members.add(item['member']);path=root/item['member'];expected_bytes=item['gzipBytes'];expected_hash=item['gzipSha256']
  raw_gzip=path.read_bytes()
  if len(raw_gzip)!=expected_bytes or digest(raw_gzip)!=expected_hash:raise ValueError('gzip_identity')
  raw=gzip.decompress(raw_gzip)
  if len(raw)!=item['rawBytes'] or digest(raw)!=item['rawSha256'] or source.read_bytes()!=raw:raise ValueError('raw_or_source_identity')
  if source.name=='events.jsonl':
   for line in raw.decode('utf8').splitlines():
    if line.strip():event_check(json.loads(line))
 if members!={'blobs/'+x.name for x in (root/'blobs').iterdir()} or len(members)!=m['localUniqueMembers'] or prior_count!=m['priorReferences'] or len(m['records'])!=m['sourceAliases']:raise ValueError('member_set')
 print(json.dumps({'capsule':label,'manifestSha256':digest(manifest),'aliases':len(m['records']),'localMembers':len(members),'priorReferences':prior_count,'postwalk':'PASS'}))

#!/usr/bin/env python3
"""Create and postwalk two bounded, content-addressed review capsules."""
import gzip, hashlib, io, json, pathlib, re, sys

ROOT=pathlib.Path(__file__).resolve().parents[2]
BASE=ROOT/'docs/optimization-plan/evidence/semantic-retrieval-20261116'
OLD=BASE/'s3c-blocker-first-batch-reviewed-r1/manifest.json'
OLD_SHA='1991daab188700b9dcd5c57dca3db4a1a86f030e8b62fd513f241e3ccf2634f5'
REC=BASE/'s3c-recovery-candidate-and-proxy-transport-reviewed-r1'
MEDIA=BASE/'s3c-m4-source-and-license-materials-reviewed-r1'
sha=lambda b:hashlib.sha256(b).hexdigest()
def name(p):
 try:return p.relative_to(ROOT).as_posix()
 except ValueError:return str(p)
def safe_file(p):
 return p.is_file() and not p.is_symlink() and not any('acceptance' in x.lower() or 'cache' in x.lower() for x in p.parts) and p.suffix.lower() not in ('.exe','.dll','.node','.zip','.tar','.gz','.xz','.whl','.bin','.onnx')
def files(root):
 if not root.is_dir() or root.is_symlink():raise ValueError('missing_root:'+str(root))
 return sorted(p for p in root.rglob('*') if safe_file(p))
def check_events(path,raw):
 if path.name!='events.jsonl':return
 def check(value):
  if isinstance(value,dict):
   for k,v in value.items():
    if re.search(r'password|token|key|payload',k,re.I):raise ValueError('sensitive_event_key:'+k)
    check(v)
  elif isinstance(value,list):
   for v in value:check(v)
 for line in raw.decode('utf8').splitlines():
  if line.strip():check(json.loads(line))
def old_index():
 raw=OLD.read_bytes()
 if sha(raw)!=OLD_SHA:raise ValueError('old_manifest_changed')
 data=json.loads(raw); result={}
 for r in data['records']:result.setdefault(r['rawSha256'],r)
 return result
def check_prior(r,expected):
 p=OLD.parent/r['member']; compressed=p.read_bytes()
 if len(compressed)!=r['gzipBytes'] or sha(compressed)!=r['gzipSha256']:raise ValueError('prior_gzip_changed')
 raw=gzip.decompress(compressed)
 if len(raw)!=r['rawBytes'] or sha(raw)!=r['rawSha256'] or raw!=expected:raise ValueError('prior_raw_changed')
 return {'manifest':name(OLD),'manifestSha256':OLD_SHA,'member':r['member'],'gzipBytes':len(compressed),'gzipSha256':sha(compressed)}
def build(destination,paths,prior=None):
 destination.mkdir(parents=True,exist_ok=False); blobs=destination/'blobs';blobs.mkdir();records=[];local={}
 for p in sorted(set(paths)):
  if not safe_file(p):raise ValueError('forbidden_or_missing:'+str(p))
  raw=p.read_bytes();check_events(p,raw);h=sha(raw)
  record={'source':name(p),'rawSha256':h,'rawBytes':len(raw)}
  if prior and h in prior:
   record['prior']=check_prior(prior[h],raw)
  else:
   if h not in local:
    buffer=io.BytesIO()
    with gzip.GzipFile(fileobj=buffer,mode='wb',filename='',mtime=0,compresslevel=9) as stream:stream.write(raw)
    compressed=buffer.getvalue();target=blobs/(h+'.gz');target.write_bytes(compressed)
    local[h]={'member':'blobs/'+target.name,'gzipBytes':len(compressed),'gzipSha256':sha(compressed)}
   record.update(local[h])
  records.append(record)
 manifest={'schema':1,'status':'PRESERVED_SCOPED_EVIDENCE_NOT_OVERALL_PASS','records':records,'sourceAliases':len(records),'localUniqueMembers':len(local),'priorReferences':sum('prior' in r for r in records),'logicalRawBytes':sum(r['rawBytes'] for r in records),'limits':['Original FAIL and UNKNOWN outcomes remain unchanged.','No backup, keys, data roots, caches, model/corpus, Node or native binary included.','License material is an unpublished review draft, not distribution approval.']}
 (destination/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
 return manifest
def verify(destination):
 raw=(destination/'manifest.json').read_bytes();m=json.loads(raw); seen=set()
 for r in m['records']:
  prior=r.get('prior')
  if prior:
   if prior['manifestSha256']!=OLD_SHA or sha(OLD.read_bytes())!=OLD_SHA:raise ValueError('prior_manifest_changed')
   compressed=(OLD.parent/prior['member']).read_bytes();size=prior['gzipBytes'];digest=prior['gzipSha256']
  else:compressed=(destination/r['member']).read_bytes();size=r['gzipBytes'];digest=r['gzipSha256'];seen.add(r['member'])
  if len(compressed)!=size or sha(compressed)!=digest:raise ValueError('postwalk_gzip')
  payload=gzip.decompress(compressed)
  if len(payload)!=r['rawBytes'] or sha(payload)!=r['rawSha256']:raise ValueError('postwalk_raw')
  if pathlib.PurePosixPath(r['source']).name=='events.jsonl':check_events(pathlib.Path('events.jsonl'),payload)
 if len(seen)!=m['localUniqueMembers']:raise ValueError('postwalk_count')
 print(json.dumps({'capsule':name(destination),'manifestSha256':sha(raw),'records':len(m['records']),'localMembers':len(seen),'priorReferences':m['priorReferences']}))
def collect():
 result=[pathlib.Path(__file__).resolve()]
 reviews={'current-real-enable-v3':'aa3fbde6f1070e9c5e7c94a24c8d2ae6d4ba74cb05bfb08b22c32c1daa3ca869','prepare-cause-diagnostic-v4':'dc8967c758e557590426843bb31b24e106ab5c21207b91e26e7a1776af2a2adb','codec-native-cause-diagnostic-v5':'3c58a50138526fef07affeddf e9ddb2d26673e66c13f179503c6fcca5cbc3686'.replace(' ','')}
 for suffix in reviews:
  root=ROOT/('output/semantic-owned-'+suffix)
  if sha((root/'root-review.json').read_bytes())!=reviews[suffix]:raise ValueError('root_review_changed:'+suffix)
  contract=json.loads((root/'contract.json').read_bytes()); review=json.loads((root/'root-review.json').read_bytes())
  source_root=root/'source-input'; bindings=[x for x in contract['bindings'] if pathlib.Path(x['file']).is_relative_to(source_root.resolve())]
  source_files=files(source_root)
  if {str(pathlib.Path(x['file']).resolve()).lower() for x in bindings}!={str(p.resolve()).lower() for p in source_files}:raise ValueError('source_binding_set:'+suffix)
  for x in bindings:
   b=pathlib.Path(x['file']).read_bytes()
   if len(b)!=x['bytes'] or sha(b)!=x['sha256']:raise ValueError('source_binding_changed:'+suffix)
  if sha((root/'baseline-evidence/events.jsonl').read_bytes())!=review['eventsSha256']:raise ValueError('events_binding_changed:'+suffix)
  result += [p for p in root.iterdir() if safe_file(p)]
  result += source_files
  for n in ['events.jsonl','baseline-server-stdout.log','baseline-server-stderr.log']:result.append(root/'baseline-evidence'/n)
 proxy_reviews={'echo-v1':'19a27e32424ce2858a3d519318a9285ae5341b8e9c9373601a52875429325119','echo-v2':'9632d08cb7d8693b954da787509406131ee79cb586a552375f2149f530505ed8','tail-v2':'5dc410a0b4c5132b1a567455fa93c03aa9d3cac11d6073e5cd70723035c94e13','stalled-v1':'c7de5593bbc83489eb596d290815ef294ce448b7daea8d36b937fbb701a77f42'}
 for suffix in proxy_reviews:
  root=ROOT/('output/semantic-resident-proxy-win32-'+suffix)
  if sha((root/'root-review.json').read_bytes())!=proxy_reviews[suffix]:raise ValueError('proxy_review_changed:'+suffix)
  review=json.loads((root/'root-review.json').read_bytes())
  if len(review['sourceSnapshots'])!=13:raise ValueError('proxy_snapshot_count:'+suffix)
  for x in review['sourceSnapshots']:
   p=root/pathlib.PureWindowsPath(x['snapshot']);b=p.read_bytes()
   if len(b)!=x['bytes'] or sha(b)!=x['sha256']:raise ValueError('proxy_snapshot_changed:'+suffix)
  result += [p for p in root.iterdir() if safe_file(p)] + files(root/'root-source-snapshots')
 for suffix in ['compile-freeze-v4','drain-compile-freeze-v1','flush-compile-freeze-v1']:
  root=ROOT/('output/semantic-resident-proxy-'+suffix)
  result += [p for p in root.iterdir() if safe_file(p)]
  if (root/'sources').exists():result += files(root/'sources')
 for suffix in ['build-v4','drain-build-v1','flush-build-v1']:
  root=ROOT/('output/semantic-resident-proxy-'+suffix)
  result += [p for p in root.iterdir() if safe_file(p)]
  if (root/'sources').exists():result += files(root/'sources')
 return result
def media():
 result=[pathlib.Path(__file__).resolve(),ROOT/'dev-harness/semantic/root-wheel-notice-byte-review.py']
 first=ROOT/'output/m4-public-source-metadata-20261117-r1'
 result += [first/n for n in ['freeze.json','root-review.json','manifest.json','local-sidecar-verification.json','pypi-version-matrix.json','verify-local-sidecar.py','verify-pypi-matrix.py']]
 second=ROOT/'output/m4-public-sdist-intake-20261117-r1'
 result += [second/n for n in ['freeze.json','root-review.json','download-freeze.json','intake-receipt.json','intake.py','verify-intake.py','build-matrix.py','source-wheel-notice-matrix.json']]
 result += sorted(second.glob('*-members.json'))
 third=ROOT/'output/m4-license-review-20261117-r1'
 result += [third/n for n in ['freeze.json','root-review.json','notice-index.json','component-license-review.json','DRAFT-NOTICES.md','plugin-rebuild-candidate-spec.json','collect-wheel-notices.py','build-review.py']]
 result += files(third/'notices')
 return result
if __name__=='__main__':
 if len(sys.argv)!=2 or sys.argv[1] not in ('build','verify'):raise SystemExit('usage: archive-recovery-proxy-and-media.py build|verify')
 if sys.argv[1]=='build':build(REC,collect(),old_index());build(MEDIA,media(),old_index())
 else:verify(REC);verify(MEDIA)

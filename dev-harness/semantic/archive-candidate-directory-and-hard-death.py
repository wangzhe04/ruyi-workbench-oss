"""Preserve scoped NTFS and hard-death trials; no binaries or user data."""
import importlib.util,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
LIB=ROOT/'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec=importlib.util.spec_from_file_location('pinned_review_archive',LIB)
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
OUT=a.BASE/'s3c-candidate-directory-and-hard-death-reviewed-r1'
REVIEWS=[
 ('semantic-owned-candidate-native-primitive-v6','8ba2086a03ad183149a246d8dd20d8fdb0ee7fc9b0abc676d3ddb38ee304673d','contract.json'),
 ('semantic-resident-proxy-parent-death-v1','3d887f0bbe1655afe8180a24a8371080b75892282aea29a2733d3bfc763c7d66','freeze.json'),
 ('semantic-resident-proxy-parent-death-v2','57d555f615ba8d5be3de8f85c81944951007d5c9ef0dbf5b6b0d6921dce18d4d','freeze.json'),
 ('semantic-resident-proxy-helper-death-v2','e4dbd9fa401eb63871d07953606fe8fdbec820e2f59e634d0daa5a7212e74f63','freeze.json')]
def collect():
 paths=[pathlib.Path(__file__).resolve(),LIB]
 for name,pin,contract in REVIEWS:
  root=ROOT/'output'/name;raw=(root/'root-review.json').read_bytes()
  if a.sha(raw)!=pin:raise ValueError('root_review_changed:'+name)
  review=json.loads(raw)
  for file,key in [(contract,'freezeSha256'),('receipt.json','receiptSha256'),('outer-job-receipt.json','outerSha256')]:
   if a.sha((root/file).read_bytes())!=review[key]:raise ValueError('receipt_changed:'+name)
   paths.append(root/file)
  paths += [root/'root-review.json',root/'root-preflight.json']
  if (root/'root-preflight-unit.log').is_file():paths.append(root/'root-preflight-unit.log')
  for row in review['sourceSnapshots']:
   p=root/pathlib.PureWindowsPath(row['snapshot']);data=p.read_bytes()
   if len(data)!=row['bytes'] or a.sha(data)!=row['sha256']:raise ValueError('source_snapshot_changed')
   paths.append(p)
  for kind in ['stdout','stderr']:
   p=root/('native-witness.'+kind+'.raw')
   if p.is_file():paths.append(p)  # fixed public synthetic native witness, no input assembly/keys
 for directory in ['semantic-resident-owned-process-control-compile-v2','semantic-resident-owned-process-control-build-v1']:
  root=ROOT/'output'/directory
  paths += [p for p in root.iterdir() if a.safe_file(p)]
  if (root/'sources').is_dir():paths+=a.files(root/'sources')
 coverage=ROOT/'output/m4-notice-delivery-coverage-20261117-r1'
 paths += [p for p in coverage.iterdir() if a.safe_file(p)]
 for name in ['root-candidate-primitive-preflight.cjs','root-candidate-primitive-review.cjs','root-proxy-death-first-failure-review.cjs','root-proxy-death-pass-review.cjs']:
  paths.append(ROOT/'dev-harness/semantic'/name)
 return paths
if __name__=='__main__':
 if sys.argv[1:]!=['build']:raise SystemExit('build once only')
 a.build(OUT,collect(),a.old_index());a.verify(OUT)
 # Independent serialized/source comparison, including local/prior member set.
 manifest=json.loads((OUT/'manifest.json').read_bytes());local=set()
 for row in manifest['records']:
  if 'prior' in row:p=a.OLD.parent/row['prior']['member']
  else:p=OUT/row['member'];local.add(row['member'])
  data=a.gzip.decompress(p.read_bytes())
  if (ROOT/pathlib.PurePosixPath(row['source'])).read_bytes()!=data:raise ValueError('source_postwalk')
 if local!={'blobs/'+p.name for p in (OUT/'blobs').iterdir()}:raise ValueError('member_set')
 print(json.dumps({'status':'ROOT_SERIALIZED_ARCHIVE_POSTWALK_PASS','aliases':manifest['sourceAliases'],'localMembers':manifest['localUniqueMembers'],'priorReferences':manifest['priorReferences'],'logicalRawBytes':manifest['logicalRawBytes'],'gzipBytes':sum(p.stat().st_size for p in (OUT/'blobs').iterdir())}))

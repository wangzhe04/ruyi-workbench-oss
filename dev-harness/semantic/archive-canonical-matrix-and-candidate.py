"""Preserve reviewed synthetic batches; exclude data roots and native binaries."""
import importlib.util,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
LIB=ROOT/'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec=importlib.util.spec_from_file_location('prior_review_archiver',LIB)
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
OUT=a.BASE/'s3c-canonical-matrix-and-candidate-reviewed-r1'
PROXY=[
 ('semantic-resident-os-alias-utf8-v1','96e6314de27d0b534bf7e7cd0438606d036e3b8a0a0a1a3c46aa19128e38b935'),
 ('semantic-resident-os-alias-utf8-v2','08f13f765ccbe08527ef689914046183691e90be216ee178a03cf716547e8a2d'),
 ('semantic-resident-proxy-input-stalled-v1','f165ef1ed5e2b00c5ffd59f68d05cb8c000687f667345f556942272ae5787ddb'),
 ('semantic-resident-proxy-concurrent-v1','7aa173d14b0578ed79b8559902ba5c710ab08ea1c170a11b2c7cbb2fc6e8eac5'),
 ('semantic-resident-proxy-startup-parent-v2','bfb874483c4d429dc9bb442e9abc396ac1deea261adc2f1e91716be4d7490749'),
 ('semantic-resident-proxy-startup-parent-v3','8f17962830d097c73b799cdb0f1ea49ee8657c1569c9577d763388121c5651cf')]

def receipt(root,review,name,key):
 p=root/name
 if a.sha(p.read_bytes())!=review[key]:raise ValueError('reviewed_receipt_changed:'+str(p))
 return p

def bound_files(contract):
 result=[]
 for row in contract['bindings']:
  p=pathlib.Path(row['file'])
  if p.suffix.lower() in ('.exe','.dll','.node'):continue
  raw=p.read_bytes()
  if len(raw)!=row['bytes'] or a.sha(raw)!=row['sha256']:raise ValueError('binding_changed:'+str(p))
  if not p.resolve().is_relative_to(ROOT):raise ValueError('unowned_source')
  result.append(p)
 return result

def collect():
 paths=[pathlib.Path(__file__).resolve(),LIB]
 for name,pin in PROXY:
  root=ROOT/'output'/name;raw=(root/'root-review.json').read_bytes()
  if a.sha(raw)!=pin:raise ValueError('root_review_changed:'+name)
  review=json.loads(raw)
  paths += [root/'root-review.json',receipt(root,review,'freeze.json','freezeSha256'),receipt(root,review,'receipt.json','receiptSha256'),receipt(root,review,'outer-job-receipt.json','outerSha256')]
  for row in review['sourceSnapshots']:
   p=root/pathlib.PureWindowsPath(row['snapshot']);raw=p.read_bytes()
   if len(raw)!=row['bytes'] or a.sha(raw)!=row['sha256']:raise ValueError('snapshot_changed')
   paths.append(p)
  for name in ['root-preflight.json','root-preflight-unit.log','native-witness.stdout.raw','native-witness.stderr.raw']:
   p=root/name
   if p.is_file():paths.append(p)
 ordinary=ROOT/'output/semantic-candidate-boundary-real-enable-v3'
 if a.sha((ordinary/'root-review.json').read_bytes())!='ce5ecccf488cfbf3ec36614b4b8af04dbec0d275a12a0902e9373988689e03d6':raise ValueError('ordinary_review_changed')
 review=json.loads((ordinary/'root-review.json').read_bytes())
 paths += bound_files(json.loads((ordinary/'contract.json').read_bytes()))
 for name in ['contract.json','root-review.json','root-source-preflight.json','root-preflight.json','root-build-check.log','root-allocator-process-receipts.json','bootstrap-receipt.json','outer-job-receipt.json','baseline-evidence/events.jsonl']:
  paths.append(ordinary/name)
 receipt(ordinary,review,'bootstrap-receipt.json','receiptSha256');receipt(ordinary,review,'outer-job-receipt.json','outerSha256');receipt(ordinary,review,'baseline-evidence/events.jsonl','eventsSha256')
 tests=ROOT/'output/semantic-candidate-v3-native-free-tests-v1'
 if a.sha((tests/'contract.json').read_bytes())!='3448e0f191ae84dcfe566d3408282d18965bfcf752009e685154073cde7c0b1c':raise ValueError('test_tree_changed')
 paths += bound_files(json.loads((tests/'contract.json').read_bytes()))
 paths += [tests/n for n in ['contract.json','root-review.json','root-captured-source.log','root-host-boundary.log','root-candidate-authority.log']]
 m5=ROOT/'output/m5-root-local-regression-20261117-r2'
 if a.sha((m5/'freeze.json').read_bytes())!='96078c0e2bd8016a6135fe353a635b4beafd9c4bd0cc2642bd1af16005a49e81':raise ValueError('m5_freeze_changed')
 snapshots=json.loads((m5/'root-source-snapshots.json').read_bytes())
 for row in snapshots['records']:
  p=m5/pathlib.PureWindowsPath(row['snapshot']);raw=p.read_bytes()
  if len(raw)!=row['bytes'] or a.sha(raw)!=row['sha256']:raise ValueError('m5_snapshot_changed')
  paths.append(p)
 paths += [m5/n for n in ['freeze.json','root-review.json','tests.log','root-source-snapshots.json']]
 for name in ['semantic-resident-restricted-job-compile-v1','semantic-resident-restricted-job-build-v1']:
  root=ROOT/'output'/name
  paths += [p for p in root.iterdir() if a.safe_file(p)]
  if (root/'sources').is_dir():paths += a.files(root/'sources')
 rejected=ROOT/'output/semantic-candidate-boundary-diagnostic-v4'
 paths += [rejected/'contract.json',rejected/'root-rejection.json']
 paths += a.files(rejected/'source-input/diagnostic-recipe')
 paths += [rejected/'source-input/ruyi-workbench/app/src'/name for name in ['01ad-work-data-migration-host.js','13ak-work-data-cold-operations.js','13u-migration-center.js']]
 for name in ['root-os-canonical-review.cjs','root-proxy-matrix-review.cjs','root-proxy-startup-pass-review.cjs','root-candidate-boundary-preflight.cjs','root-ordinary-candidate-review.cjs']:
  paths.append(ROOT/'dev-harness/semantic'/name)
 return paths

if __name__=='__main__':
 if sys.argv[1:]!=['build']:raise SystemExit('build once only')
 a.build(OUT,collect(),a.old_index());a.verify(OUT)

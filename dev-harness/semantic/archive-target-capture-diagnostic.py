"""Archive a failed diagnostic without promoting it to functional success."""
import importlib.util,json,pathlib,sys
ROOT=pathlib.Path(__file__).resolve().parents[2]
LIB=ROOT/'dev-harness/semantic/archive-recovery-proxy-and-media.py'
spec=importlib.util.spec_from_file_location('prior_review_archiver',LIB)
a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
OUT=a.BASE/'s3c-target-capture-diagnostic-reviewed-r1'
root=ROOT/'output/semantic-candidate-boundary-diagnostic-v5'
raw=(root/'root-review.json').read_bytes()
if a.sha(raw)!='9f388e863c74c94315cc1230411862e3f4e2e725ccb56fdde8b0cc05f19858fd':raise ValueError('review_changed')
r=json.loads(raw);f=json.loads((root/'contract.json').read_bytes());paths=[]
for row in f['bindings']:
 p=pathlib.Path(row['file'])
 if p.suffix.lower() in ('.exe','.dll','.node'):continue
 data=p.read_bytes()
 if len(data)!=row['bytes'] or a.sha(data)!=row['sha256']:raise ValueError('binding_changed')
 paths.append(p)
for name,key in [('contract.json','freezeSha256'),('bootstrap-receipt.json','receiptSha256'),('outer-job-receipt.json','outerSha256'),('baseline-evidence/events.jsonl','eventsSha256'),('prepare-diagnostic.json','prepareDiagnosticSha256'),('native-diagnostic.jsonl','nativeDiagnosticSha256'),('root-allocator-process-receipts.json','allocatorReceiptSha256')]:
 p=root/name
 if a.sha(p.read_bytes())!=r[key]:raise ValueError('receipt_changed:'+name)
 paths.append(p)
paths += [root/name for name in ['root-review.json','root-preflight.json','root-preflight-unit.log','root-build-check.log']]
paths += a.files(ROOT/'output/m3-diagnostic-v5-native-free-review')
paths += [pathlib.Path(__file__).resolve(),LIB,ROOT/'dev-harness/semantic/root-candidate-target-diagnostic-review.cjs',ROOT/'dev-harness/semantic/postwalk-canonical-matrix-and-candidate.py']
paths += [a.BASE/'s3c-canonical-matrix-and-candidate-reviewed-r1/manifest.json']
if sys.argv[1:]!=['build']:raise SystemExit('build once only')
a.build(OUT,paths,a.old_index());a.verify(OUT)

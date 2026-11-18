import json,os,hashlib,urllib.request,time,concurrent.futures
from pathlib import Path
base=Path('output/granite-multilingual-r2-assets-v1');base.mkdir(exist_ok=False);(base/'OWNER.json').write_text(json.dumps({'owner':'granite-r2-research-assets','purpose':'official artifacts, not production','createdUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})+'\n')
models={'311m':('ibm-granite/granite-embedding-311m-multilingual-r2','44399559930365213510b1ee2eb15ded83374f0e'),'97m':('ibm-granite/granite-embedding-97m-multilingual-r2','835ad14087e140460703cf0fae09f97d469d65c2')};paths=['README.md','config.json','config_sentence_transformers.json','modules.json','1_Pooling/config.json','sentence_bert_config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json','onnx/model_quint8_avx2.onnx']
plan={'schema':1,'status':'PUBLIC_OFFICIAL_ASSET_PLAN_NOT_INFERENCE','models':{},'scope':'Official pinned public files only; no inference, no production or acceptance.'}
for name,(repo,rev) in models.items():
 url='https://huggingface.co/api/models/'+repo+'/revision/'+rev+'?blobs=true';req=urllib.request.Request(url,headers={'User-Agent':'GraniteResearchAssetVerifier/1.0'});x=json.load(urllib.request.urlopen(req,timeout=60));assert x['sha']==rev
 rows={z['rfilename']:z for z in x['siblings']};assert all(p in rows for p in paths)
 plan['models'][name]={'repository':repo,'revision':rev,'license':'apache-2.0','availableNames':[z['rfilename'] for z in x['siblings']],'files':[rows[p] for p in paths], 'fp32OnnxMetadata':rows.get('onnx/model.onnx')}
(base/'public-asset-plan.json').write_text(json.dumps(plan,indent=2)+'\n',encoding='utf-8')
def fetch(item):
 name,entry=item; spec=plan['models'][name];rel=entry['rfilename'];out=base/name/rel;out.parent.mkdir(parents=True,exist_ok=True);tmp=out.with_suffix(out.suffix+'.partial');url='https://huggingface.co/'+spec['repository']+'/resolve/'+spec['revision']+'/'+rel+'?download=true';sha=hashlib.sha256();git=hashlib.sha1();git.update(('blob '+str(entry['size'])+'\0').encode());count=0
 try:
  req=urllib.request.Request(url,headers={'User-Agent':'GraniteResearchAssetVerifier/1.0'});
  with urllib.request.urlopen(req,timeout=120) as resp,open(tmp,'xb') as f:
   while True:
    b=resp.read(1024*1024)
    if not b:break
    f.write(b);sha.update(b);git.update(b);count+=len(b)
  if count!=entry['size'] or ('lfs' in entry and sha.hexdigest()!=entry['lfs']['sha256']) or ('lfs' not in entry and git.hexdigest()!=entry['blobId']):raise ValueError('hash or length mismatch')
  os.replace(tmp,out);return {'model':name,'path':rel,'status':'PASS','bytes':count,'sha256':sha.hexdigest(),'gitBlobSha1':git.hexdigest()}
 except Exception as e:return {'model':name,'path':rel,'status':'FAIL','error':repr(e),'partialBytes':count}
items=[(name,x) for name in models for x in plan['models'][name]['files']];results=[]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
 for r in pool.map(fetch,items):
  results.append(r);print(json.dumps({k:r[k] for k in ['model','path','status'] if k in r}),flush=True)
receipt={'schema':1,'status':'PASS_ALL_OFFICIAL_PINNED_ASSETS' if all(r['status']=='PASS' for r in results) else 'PARTIAL_ASSET_DOWNLOAD','assetPlanSha256':hashlib.sha256((base/'public-asset-plan.json').read_bytes()).hexdigest(),'results':results,'limits':['No model/native inference or numerical equivalence claims.','FP32 graph not downloaded; fixed-sample FP32/Q8 parity remains untested.','License/notice packaging review pending.']};(base/'asset-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps({'status':receipt['status'],'success':sum(x['status']=='PASS' for x in results),'total':len(results)}),flush=True)

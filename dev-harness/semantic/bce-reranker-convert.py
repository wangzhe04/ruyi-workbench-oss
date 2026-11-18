# Research only; local checkpoint export and dynamic quantization, no product dependencies.
import hashlib,json,os,sys,time,pathlib,platform
root=pathlib.Path('output/semantic-bce-reranker-v1').resolve();source=root/'source'; out=root/'converted'; out.mkdir(exist_ok=True,parents=True)
os.environ['HF_HUB_OFFLINE']='1';os.environ['TRANSFORMERS_OFFLINE']='1';os.environ['TOKENIZERS_PARALLELISM']='false'
sys.path.insert(0,str(root/'python-tools'))
def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()
def write_new(p,x):
 with open(p,'x',encoding='utf-8') as f: json.dump(x,f,ensure_ascii=False,indent=2);f.write('\n')
lock=json.loads((source/'source.lock.json').read_text(encoding='utf-8'))
for x in lock['files']:
 p=source/x['path']
 if p.stat().st_size!=x['bytes'] or sha(p)!=x['sha256']: raise RuntimeError('source asset mismatch: '+str(p))
if lock['revision']!='eb7650fca1d81e2856fbd0d522488844aa502735': raise RuntimeError('unexpected source revision')
import torch,transformers,onnx,onnxruntime
from transformers import AutoTokenizer,AutoModelForSequenceClassification
from onnxruntime.quantization import quantize_dynamic,QuantType
torch.set_num_threads(2)
versions={'python':sys.version,'executableSha256':sha(sys.executable),'torch':torch.__version__,'transformers':transformers.__version__,'onnx':onnx.__version__,'onnxruntime':onnxruntime.__version__,'scriptSha256':sha(__file__),'sourceLockSha256':sha(source/'source.lock.json'),'protocolSha256':sha('dev-harness/semantic/bce-reranker-protocol.json'),'sampleSha256':sha(root/'source-sample.json'),'toolsWheelHashes':{p.name:sha(p) for p in sorted((root/'wheels').glob('*.whl'))},'platform':platform.platform()}
if versions['protocolSha256']!='6ab2e631c9482bda1cbbec1969b06c5e2865f9da7f006a9413d00a01cfd5f61c':raise RuntimeError('protocol drift')
mode=sys.argv[1]
if mode=='export':
 fp=out/'model.fp32.onnx';sampleout=out/'source-pytorch-sample.json';receipt=out/'fp32-export.json'
 if any(x.exists() for x in [fp,sampleout,receipt]):raise RuntimeError('output already exists')
 sample=json.loads((root/'source-sample.json').read_text(encoding='utf-8'))['rows'];tok=AutoTokenizer.from_pretrained(source,local_files_only=True);model=AutoModelForSequenceClassification.from_pretrained(source,local_files_only=True,use_safetensors=False,attn_implementation='eager').eval()
 class Logit(torch.nn.Module):
  def __init__(self,base):super().__init__();self.base=base
  def forward(self,input_ids,attention_mask):return self.base(input_ids=input_ids,attention_mask=attention_mask,return_dict=True).logits
 wrapper=Logit(model).eval();rows=[]
 with torch.inference_mode():
  for s in sample:
   x=tok(s['query'],s['document'],return_tensors='pt',truncation=False); logits=wrapper(x['input_ids'],x['attention_mask']).view(-1)
   rows.append({'queryId':s['queryId'],'documentId':s['documentId'],'inputIds':x['input_ids'][0].tolist(),'attentionMask':x['attention_mask'][0].tolist(),'logit':float(logits[0]),'score':float(torch.sigmoid(logits[0]))})
  write_new(sampleout,{'versions':versions,'rows':rows})
  x=tok(sample[0]['query'],sample[0]['document'],return_tensors='pt',truncation=False);started=time.perf_counter();torch.onnx.export(wrapper,(x['input_ids'],x['attention_mask']),str(fp),input_names=['input_ids','attention_mask'],output_names=['logits'],dynamic_axes={'input_ids':{0:'batch',1:'sequence'},'attention_mask':{0:'batch',1:'sequence'},'logits':{0:'batch'}},opset_version=17,dynamo=False,do_constant_folding=True)
 onnx.checker.check_model(str(fp));write_new(receipt,{'status':'PASS','versions':versions,'origin':'Self-export from verified official FP32 PyTorch checkpoint; dynamic axes, eager attention; opset17.','sourceSampleSha256':sha(sampleout),'outputSha256':sha(fp),'outputBytes':fp.stat().st_size,'elapsedSec':time.perf_counter()-started})
 print('export PASS',fp.stat().st_size,flush=True)
elif mode=='quantize':
 fp=out/'model.fp32.onnx';q=out/'model.q8.onnx';receipt=out/'q8-quantization.json';prior=json.loads((out/'fp32-export.json').read_text(encoding='utf-8'))
 if prior['outputSha256']!=sha(fp) or q.exists() or receipt.exists(): raise RuntimeError('input mismatch or output exists')
 started=time.perf_counter();quantize_dynamic(str(fp),str(q),op_types_to_quantize=['MatMul','Gather'],per_channel=False,reduce_range=True,weight_type=QuantType.QInt8);onnx.checker.check_model(str(q));write_new(receipt,{'status':'PASS','versions':versions,'origin':'Self-created dynamic Q8 from local FP32 ONNX, ONNX Runtime quantize_dynamic; MatMul and Gather; per_channel=false, reduce_range=true, QInt8 weights.','inputSha256':sha(fp),'outputSha256':sha(q),'outputBytes':q.stat().st_size,'elapsedSec':time.perf_counter()-started});print('quantize PASS',q.stat().st_size,flush=True)
else:raise RuntimeError('Use export or quantize')

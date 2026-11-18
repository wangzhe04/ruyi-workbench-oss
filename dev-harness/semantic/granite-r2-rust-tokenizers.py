import sys,json
from tokenizers import Tokenizer,__version__
name,path,inputs,out=sys.argv[1:];t=Tokenizer.from_file(path);data=json.load(open(inputs,encoding='utf-8'));rows=[]
for s in data['samples']:
 x=t.encode(s['text'],add_special_tokens=True); rows.append({'id':s['id'],'ids':x.ids,'attentionMask':x.attention_mask,'specialMask':x.special_tokens_mask})
with open(out,'x',encoding='utf-8') as f:json.dump({'model':name,'tokenizersVersion':__version__,'rows':rows},f,indent=2)

import sys,json
from tokenizers import Tokenizer,__version__
t=Tokenizer.from_file(sys.argv[1]);data=json.loads(sys.stdin.buffer.read().decode('utf-8'));rows=[]
for r in data:
 e=t.encode(r['text'],add_special_tokens=True);rows.append({'ids':e.ids,'mask':e.attention_mask})
sys.stdout.buffer.write(json.dumps({'version':__version__,'rows':rows},ensure_ascii=False,separators=(',',':')).encode('utf-8'))

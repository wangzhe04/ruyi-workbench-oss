import json,sys
from tokenizers import Tokenizer
sys.stdin.reconfigure(encoding='utf-8')
t=Tokenizer.from_file(sys.argv[1]); records=json.load(sys.stdin)
out=[]
for r in records:
 e=t.encode(r['query'],r['document'],add_special_tokens=True)
 out.append({'input_ids':e.ids,'attention_mask':e.attention_mask,'token_type_ids':e.type_ids})
json.dump(out,sys.stdout,ensure_ascii=False)



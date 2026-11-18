import json, sys
from tokenizers import Tokenizer
tokenizer=Tokenizer.from_file(sys.argv[1])
rows=json.loads(sys.stdin.buffer.read().decode('utf-8'))
print(json.dumps([{'ids':v.ids,'mask':v.attention_mask,'special':v.special_tokens_mask} for v in [tokenizer.encode(row) for row in rows]]))

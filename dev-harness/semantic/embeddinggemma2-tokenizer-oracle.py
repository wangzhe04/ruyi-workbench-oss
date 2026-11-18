import json, sys, tokenizers
from tokenizers import Tokenizer
request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
tokenizer = Tokenizer.from_file(request['tokenizer'])
rows = []
for row in request['rows']:
    encoded = tokenizer.encode(row['encodedText'])
    rows.append({'id': row['id'], 'ids': encoded.ids, 'mask': encoded.attention_mask,
                 'special': encoded.special_tokens_mask})
print(json.dumps({'version': tokenizers.__version__, 'rows': rows}))

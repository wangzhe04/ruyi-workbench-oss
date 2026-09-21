import json, sys, os
sys.argv = ['x']; __file__ = os.path.abspath('score.py')
exec(open('score.py', encoding='utf-8').read().split('def main')[0])
name, cond, thr = sys.argv[1] if len(sys.argv) > 1 else 'qwen', 'hard', 2
import sys as _s; a = _s.orig_argv[2:] if hasattr(_s, 'orig_argv') else []
name = a[0] if a else 'qwen'; cond = a[1] if len(a) > 1 else 'hard'; thr = int(a[2]) if len(a) > 2 else 2
h = json.load(open('hyp/%s.json' % name, encoding='utf-8')); m = {x['id']: x for x in json.load(open('manifest.json', encoding='utf-8'))}
for i, x in m.items():
    if i not in h[cond]: continue
    e = edit(norm(x['ref']), norm(h[cond][i]['hyp']))
    if e > thr: print(i, e, 'REF', x['ref'], '| HYP', h[cond][i]['hyp'][:120], h[cond][i].get('ms_p50'))

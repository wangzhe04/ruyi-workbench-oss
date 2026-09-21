"""133a:给 phyp/*.json 打分 —— 句级 CER(与 score.py 同一把尺子)与段级 CER(一段四句拼起来再算,段落整改那种一次出整段的
方式也能公平比)。用法: python score_passages.py [name ...];不给就全部。写 <BENCH_DATA>/pscores.json
"""
import glob, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import norm, edit

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH_DATA", HERE)

def main():
    man = json.load(open(os.path.join(DATA, "pmanifest.json"), encoding="utf-8"))
    by_p = {}
    for m in man: by_p.setdefault(m["passage"], []).append(m)
    names = sys.argv[1:] or sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(DATA, "phyp", "*.json")))
    rows = []
    for name in names:
        h = json.load(open(os.path.join(DATA, "phyp", name + ".json"), encoding="utf-8"))
        row = {"name": name}
        for cond in ("clean", "noisy"):
            if cond not in h or not h[cond]: continue
            s_err = s_tot = p_err = p_tot = 0; ms = []; worst = []
            for pid, sents in by_p.items():
                refs, hyps = [], []
                for m in sorted(sents, key=lambda x: x["idx"]):
                    if m["id"] not in h[cond]: continue
                    ref = norm(m["ref"]); hyp = norm(h[cond][m["id"]]["hyp"])
                    e = edit(ref, hyp); s_err += e; s_tot += len(ref)
                    if e: worst.append((e, m["id"], h[cond][m["id"]]["hyp"]))
                    refs += ref; hyps += hyp
                    ms.append(h[cond][m["id"]].get("ms_p50", 0))
                pe = edit(refs, hyps); p_err += pe; p_tot += len(refs)
            row[cond] = round(100 * s_err / max(1, s_tot), 2)
            row[cond + "_passage"] = round(100 * p_err / max(1, p_tot), 2)
            row[cond + "_errs"] = s_err
            ms.sort(); row[cond + "_ms"] = ms[len(ms) // 2] if ms else 0
            worst.sort(reverse=True); row[cond + "_worst"] = worst[:3]
        rows.append(row)
    rows.sort(key=lambda r: (r.get("noisy", 999), r.get("clean", 999)))
    print(f"{'name':44} {'clean':>6} {'c-psg':>6} {'noisy':>6} {'n-psg':>6} {'errs':>5} {'ms':>6}")
    for r in rows:
        print(f"{r['name']:44} {r.get('clean','-'):>6} {r.get('clean_passage','-'):>6} {r.get('noisy','-'):>6} {r.get('noisy_passage','-'):>6} {str(r.get('clean_errs','-'))+'/'+str(r.get('noisy_errs','-')):>5} {r.get('noisy_ms','-'):>6}")
    json.dump(rows, open(os.path.join(DATA, "pscores.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

main()

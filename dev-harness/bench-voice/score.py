"""给 bench/hyp/*.json 打分:CER(单位 = 一个汉字 / 一个拉丁词),归一化:小写、去标点空白、阿拉伯数字→中文数字、% → 百分之。
用法: python score.py [name ...]   不给就全部。打印表格 + 写 bench/scores.json
"""
import glob, json, os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
CN = "零一二三四五六七八九"

def num2cn(m):
    s = m.group(1)
    n = int(s)
    if len(s) <= 2 and n <= 99 and not s.startswith("0"):
        if n < 10: return CN[n]
        t, o = divmod(n, 10)
        return ("十" if t == 1 else CN[t] + "十") + (CN[o] if o else "")
    return "".join(CN[int(ch)] for ch in s)

def norm(text):
    t = text.lower()
    t = re.sub(r"<\|[^|]*\|>", "", t)                       # sensevoice 的语言/情感标签
    t = re.sub(r"(\d+)\s*%", lambda m: "百分之" + num2cn(m), t)
    t = re.sub(r"(\d+)", num2cn, t)
    t = t.replace("o'clock", "oclock")
    units = re.findall(r"[a-z]+|[一-鿿]", t)
    return units

def edit(a, b):
    if not a: return len(b)
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i]
        for j, y in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y)))
        prev = cur
    return prev[-1]

def main():
    man = {m["id"]: m for m in json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))}
    names = sys.argv[1:] or sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(HERE, "hyp", "*.json")))
    rows = []; detail = {}
    for name in names:
        h = json.load(open(os.path.join(HERE, "hyp", name + ".json"), encoding="utf-8"))
        row = {"name": name}
        for cond in ("clean", "noisy", "hard"):
            if cond not in h or not h[cond]: continue
            err = tot = 0; per = {}; ms = []
            for i, m in man.items():
                if i not in h[cond]: continue
                ref = norm(m["ref"]); hyp = norm(h[cond][i]["hyp"])
                e = edit(ref, hyp); err += e; tot += len(ref); per[i] = e
                ms.append(h[cond][i].get("ms_p50", 0))
            row[cond] = round(100 * err / max(1, tot), 2); row[cond + "_n"] = len(per)
            ms.sort(); row[cond + "_ms"] = ms[len(ms) // 2] if ms else 0
            detail[(name, cond)] = per
        row["load_s"] = h.get("load_s", ""); rows.append(row)
    rows.sort(key=lambda r: r.get("clean", 999))
    print(f"{'name':34} {'CER clean':>9} {'CER noisy':>9} {'CER hard':>9} {'ms/chunk':>9} {'load s':>7}")
    for r in rows:
        print(f"{r['name']:34} {r.get('clean', '-'):>9} {r.get('noisy', '-'):>9} {r.get('hard', '-'):>9} {r.get('clean_ms', '-'):>9} {r.get('load_s', ''):>7}")
    json.dump(rows, open(os.path.join(HERE, "scores.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

main()

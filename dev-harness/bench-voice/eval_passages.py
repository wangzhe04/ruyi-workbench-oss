"""133a:段落语料的第一遍／第二遍假设。复用 eval_stream 的识别器与请求函数,只是按 pmanifest 走、写到 phyp/。
用法: python eval_passages.py <name>...   name = stream(产品缺省:cur-int8-beam4) | sensevoice | qwen[:<model>[:<port>]]
产物: <BENCH_DATA>/phyp/<name>.json  {clean:{id:{hyp,...}}, noisy:{...}}
"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eval_stream as es

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH_DATA", HERE)

def main():
    man = json.load(open(os.path.join(DATA, "pmanifest.json"), encoding="utf-8"))
    os.makedirs(os.path.join(DATA, "phyp"), exist_ok=True)
    for name in sys.argv[1:]:
        out = {"clean": {}, "noisy": {}}
        t0 = time.perf_counter()
        if name == "stream":
            rec = es.CONFIGS["cur-int8-beam4"]()
            for cond, key in (("clean", "wav"), ("noisy", "noisy")):
                for m in man: out[cond][m["id"]] = es.run_stream(rec, es.read_pcm(m[key]))
        elif name == "sensevoice":
            for cond, key in (("clean", "wav"), ("noisy", "noisy")):
                for m in man: out[cond][m["id"]] = es.run_sensevoice(es.read_pcm(m[key]))
        elif name.startswith("qwen"):
            parts = name.split(":")
            model = parts[1] if len(parts) > 1 else "qwen3-asr-auto"
            port = int(parts[2]) if len(parts) > 2 else 8790
            for cond, key in (("clean", "wav"), ("noisy", "noisy")):
                for m in man: out[cond][m["id"]] = es.run_qwen_direct(m[key], port, model)
        else:
            raise SystemExit("unknown " + name)
        fname = name.replace(":", "_")
        json.dump(out, open(os.path.join(DATA, "phyp", fname + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        bad = [k for k, v in out["clean"].items() if v.get("status", 200) != 200]
        print(fname, "done %.1f s" % (time.perf_counter() - t0), "bad:", bad[:5], "e.g.", out["clean"]["p00-0"]["hyp"], "|", out["noisy"]["p00-2"]["hyp"])

main()

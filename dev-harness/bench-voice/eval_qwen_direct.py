"""直接驱动 asr-shim 的 Qwen3AsrBackend 跑评测集(不起服务),同时量:加载时间、每句耗时、显存峰值。
用法: .venv-rocm\\python.exe eval_qwen_direct.py <name> <model_dir> <model_repo>
   e.g. qwen17 models\\Qwen3-ASR-1.7B-hf Qwen/Qwen3-ASR-1.7B-hf
产物: bench/hyp/<name>.json(形状同 eval_stream)+ 显存/耗时摘要打印
"""
import json, os, sys, time, wave
import numpy as np
sys.path.insert(0, os.environ.get("BENCH_ASR_SHIM", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "ruyi-toolbox", "asr-shim")))
from ruyi_asr_shim.qwen_backend import Qwen3AsrBackend
from ruyi_asr_shim.audio import AudioBuffer

HERE = os.path.dirname(os.path.abspath(__file__))
name, model_dir, repo = sys.argv[1], sys.argv[2], sys.argv[3]
import torch
torch.cuda.reset_peak_memory_stats()
free0, total = torch.cuda.mem_get_info()
t0 = time.perf_counter()
b = Qwen3AsrBackend(model_repo=repo, model_dir=model_dir, device="auto", dtype="auto")
b.load()
load_s = time.perf_counter() - t0
free1, _ = torch.cuda.mem_get_info()
print("loaded", b.device, "load_s", round(load_s, 1), "vram after load MB", (free0 - free1) // 2**20, "alloc MB", torch.cuda.memory_allocated() // 2**20, flush=True)

def read(path):
    with wave.open(path, "rb") as w:
        return AudioBuffer(samples=np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768.0, sample_rate=16000)

man = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
out = {"clean": {}, "noisy": {}, "hard": {}}
# 预热一句(第一发含内核编译)
b.transcribe(read(man[0]["wav"]), None, None)
for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
    for m in man:
        t = time.perf_counter(); r = b.transcribe(read(m[key]), None, None); ms = (time.perf_counter() - t) * 1000
        out[cond][m["id"]] = {"hyp": (r.get("text") or "").strip(), "finals": [], "ms_p50": round(ms, 1), "ms_max": round(ms, 1), "status": 200}
    print(cond, "done", flush=True)
peak = torch.cuda.max_memory_allocated() // 2**20
free2, _ = torch.cuda.mem_get_info()
ms = sorted(v["ms_p50"] for c in out.values() for v in c.values())
out["summary"] = {"device": b.device, "load_s": round(load_s, 1), "vram_after_load_mb": int((free0 - free1) // 2**20), "vram_peak_alloc_mb": int(peak), "vram_in_use_mb": int((free0 - free2) // 2**20), "ms_p50": ms[len(ms) // 2], "ms_p90": ms[int(len(ms) * 0.9)], "ms_max": ms[-1]}
out["load_s"] = round(load_s, 1)
json.dump(out, open(os.path.join(HERE, "hyp", name + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(json.dumps(out["summary"], ensure_ascii=False))
b.unload()

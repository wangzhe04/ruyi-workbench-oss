"""第一遍候选模型评测:按 250 ms 一块模拟流式(端点规则与组件一致),每句的 finals + 尾巴拼成假设;记每块解码耗时。
用法: python eval_stream.py <name> [<name> ...]   (name 见 CONFIGS;all = 全部;qwen = 经如意代理跑 Qwen3-ASR)
产物: bench/hyp/<name>.json  {clean:{id:{hyp, ms_per_chunk_p50, ms_max, finals}}, noisy:{...}}
"""
import glob, json, os, sys, time, http.client
import numpy as np, wave

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("BENCH_MODELS", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), "ruyi-toolbox", "asr-stream", "models"))   # 候选模型目录(不进 git)
SR = 16000; CHUNK = SR // 4

def find(model_dir, prefix, int8):
    c = sorted(glob.glob(os.path.join(model_dir, "**", prefix + "*.onnx"), recursive=True))
    i8 = [x for x in c if ".int8." in x]; fp = [x for x in c if ".int8." not in x]
    pick = (i8 or fp) if int8 else (fp or i8)
    if not pick: raise FileNotFoundError(prefix + " in " + model_dir)
    return pick[0]

def tokens(model_dir):
    return glob.glob(os.path.join(model_dir, "**", "tokens.txt"), recursive=True)[0]

def transducer(name, int8=True, decoding="greedy_search", paths=4, threads=2, hot="", score=1.5):
    import sherpa_onnx
    d = os.path.join(MODELS, name)
    kw = {}
    if hot:
        kw = dict(hotwords_file=hot, hotwords_score=score, modeling_unit="cjkchar+bpe", bpe_vocab=os.path.join(d, "bpe.vocab"))
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=tokens(d), encoder=find(d, "encoder", int8), decoder=find(d, "decoder", False), joiner=find(d, "joiner", int8),
        num_threads=threads, sample_rate=SR, feature_dim=80, enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.0, rule2_min_trailing_silence=0.8, rule3_min_utterance_length=20.0,
        decoding_method=decoding, max_active_paths=paths, provider="cpu", **kw)

def paraformer(name, threads=2):
    import sherpa_onnx
    d = os.path.join(MODELS, name)
    return sherpa_onnx.OnlineRecognizer.from_paraformer(
        tokens=tokens(d), encoder=find(d, "encoder", True), decoder=find(d, "decoder", True),
        num_threads=threads, sample_rate=SR, feature_dim=80, enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.0, rule2_min_trailing_silence=0.8, rule3_min_utterance_length=20.0, provider="cpu")

CUR = "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
CONFIGS = {
    "cur-int8-greedy": lambda: transducer(CUR),
    "cur-int8-beam4": lambda: transducer(CUR, decoding="modified_beam_search", paths=4),
    "cur-fp32-greedy": lambda: transducer(CUR, int8=False),
    "cur-int8-greedy-4t": lambda: transducer(CUR, threads=4),
    "cur-int8-beam4-hot15": lambda: transducer(CUR, decoding="modified_beam_search", paths=4, hot=os.path.join(HERE, "hotwords.txt"), score=1.5),
    "cur-int8-beam4-hot25": lambda: transducer(CUR, decoding="modified_beam_search", paths=4, hot=os.path.join(HERE, "hotwords.txt"), score=2.5),
    "cur-fp32-beam4-hot20": lambda: transducer(CUR, int8=False, decoding="modified_beam_search", paths=4, hot=os.path.join(HERE, "hotwords.txt"), score=2.0),
    "zh2025-int8-greedy": lambda: transducer("sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"),
    "zh2025-int8-beam4": lambda: transducer("sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30", decoding="modified_beam_search", paths=4),
    "zhxl2025-int8-greedy": lambda: transducer("sherpa-onnx-streaming-zipformer-zh-xlarge-int8-2025-06-30"),
    "multizh-int8-greedy": lambda: transducer("sherpa-onnx-streaming-zipformer-multi-zh-hans-2023-12-12"),
    "wenet-int8-greedy": lambda: transducer("icefall-asr-zipformer-streaming-wenetspeech-20230615"),
    "paraformer-int8": lambda: paraformer("sherpa-onnx-streaming-paraformer-bilingual-zh-en"),
    "paraformer-int8-pad": lambda: paraformer("sherpa-onnx-streaming-paraformer-bilingual-zh-en"),
}

def read_pcm(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        return np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768.0

PAD_SEC = float(os.environ.get("BENCH_PAD_SEC", "0.5"))

def run_stream(rec, samples):
    s = rec.create_stream(); finals = []; times = []
    for off in range(0, len(samples), CHUNK):
        t0 = time.perf_counter()
        s.accept_waveform(SR, samples[off:off + CHUNK])
        while rec.is_ready(s): rec.decode_stream(s)
        if rec.is_endpoint(s):
            t = rec.get_result(s).strip() if isinstance(rec.get_result(s), str) else str(rec.get_result(s)).strip()
            if t: finals.append(t)
            rec.reset(s)
        times.append((time.perf_counter() - t0) * 1000)
    s.accept_waveform(SR, np.zeros(SR // 2, np.float32)); s.input_finished()
    while rec.is_ready(s): rec.decode_stream(s)
    r = rec.get_result(s); t = (r if isinstance(r, str) else str(r)).strip()
    if t: finals.append(t)
    times.sort()
    return {"hyp": " ".join(finals), "finals": finals, "ms_p50": round(times[len(times) // 2], 1), "ms_max": round(times[-1], 1)}

def run_sensevoice(samples):
    import sherpa_onnx
    d = os.path.join(MODELS, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
    if not hasattr(run_sensevoice, "rec"):
        run_sensevoice.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=os.path.join(d, "model.int8.onnx"), tokens=os.path.join(d, "tokens.txt"), num_threads=2, use_itn=True, language="auto")
    rec = run_sensevoice.rec
    t0 = time.perf_counter(); s = rec.create_stream(); s.accept_waveform(SR, samples); rec.decode_stream(s)
    ms = (time.perf_counter() - t0) * 1000
    return {"hyp": s.result.text.strip(), "finals": [s.result.text.strip()], "ms_p50": round(ms, 1), "ms_max": round(ms, 1)}

def run_qwen(path, port, token):
    body = open(path, "rb").read()
    t0 = time.perf_counter()
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=300)
    c.request("POST", "/api/audio/transcribe?filename=voice.wav", body, {"x-wcw-token": token, "content-type": "audio/wav", "content-length": str(len(body))})
    r = c.getresponse(); j = json.loads(r.read().decode("utf-8"))
    ms = (time.perf_counter() - t0) * 1000
    return {"hyp": (j.get("text") or "").strip(), "finals": [], "ms_p50": round(ms, 1), "ms_max": round(ms, 1), "status": r.status}

def run_qwen_direct(path, port=8790, model="qwen3-asr-0.6b"):
    """直连 asr-shim(8790)的 /v1/audio/transcriptions(multipart),不经如意 —— 用户已把如意里的第二遍切到云端 mimo,不能再借道。"""
    body = open(path, "rb").read(); b = "----ruyibench" + str(int(time.time() * 1000))
    CRLF = chr(13) + chr(10)
    head = "--" + b + CRLF + "Content-Disposition: form-data; name=\"model\"" + CRLF + CRLF + model + CRLF + "--" + b + CRLF + "Content-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"" + CRLF + "Content-Type: audio/wav" + CRLF + CRLF
    form = head.encode() + body + (CRLF + "--" + b + "--" + CRLF).encode()
    t0 = time.perf_counter()
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=600)
    c.request("POST", "/v1/audio/transcriptions", form, {"content-type": "multipart/form-data; boundary=" + b, "content-length": str(len(form))})
    r = c.getresponse(); raw = r.read().decode("utf-8", "replace")
    try: j = json.loads(raw)
    except Exception: j = {}
    ms = (time.perf_counter() - t0) * 1000
    return {"hyp": (j.get("text") or "").strip(), "finals": [], "ms_p50": round(ms, 1), "ms_max": round(ms, 1), "status": r.status, "err": "" if r.status == 200 else raw[:200]}

def main():
    names = sys.argv[1:] or ["cur-int8-greedy"]
    if names == ["all"]: names = list(CONFIGS)
    man = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
    os.makedirs(os.path.join(HERE, "hyp"), exist_ok=True)
    for name in names:
        out = {"clean": {}, "noisy": {}, "hard": {}}
        t0 = time.perf_counter()
        if name == "wb":
            rt = json.load(open(os.path.expanduser("~/.win-claude-workbench/runtime.json")))
            for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
                for m in man: out[cond][m["id"]] = run_qwen(m[key], rt["port"], rt["token"]); time.sleep(1.0)
        elif name == "qwen":
            for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
                for m in man: out[cond][m["id"]] = run_qwen_direct(m[key])
        elif name == "qwen17":
            for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
                for m in man: out[cond][m["id"]] = run_qwen_direct(m[key], 8792, "qwen3-asr-1.7b")
        elif name == "sensevoice-int8":
            for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
                for m in man: out[cond][m["id"]] = run_sensevoice(read_pcm(m[key]))
        else:
            rec = CONFIGS[name](); load = time.perf_counter() - t0
            out["load_s"] = round(load, 2)
            for cond, key in (("clean", "wav"), ("noisy", "noisy"), ("hard", "hard")):
                for m in man: out[cond][m["id"]] = run_stream(rec, read_pcm(m[key]))
        out["total_s"] = round(time.perf_counter() - t0, 1)
        json.dump(out, open(os.path.join(HERE, "hyp", name + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(name, "done", out["total_s"], "s; e.g.", out["clean"]["00"]["hyp"][:40], "| noisy:", out["noisy"]["00"]["hyp"][:40], flush=True)

main()

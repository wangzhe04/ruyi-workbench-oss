"""加一个「难」条件:模拟笔记本麦克风在房间里 —— 混响(RT60≈0.35 s,DRR +3 dB)+ 粉噪 SNR 5 dB + 语速 1.08x(重采样)。产物 wav_hard/<id>.wav,manifest 加 hard 字段。"""
import json, os, numpy as np, soundfile as sf
HERE = os.path.dirname(os.path.abspath(__file__)); SR = 16000
man = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
os.makedirs(os.path.join(HERE, "wav_hard"), exist_ok=True)
rng = np.random.default_rng(131)
def pink(n):
    w = rng.standard_normal(n + 1); s = np.fft.rfft(w); f = np.arange(len(s)); f[0] = 1
    return np.fft.irfft(s / np.sqrt(f))[:n].astype("float32")
ir = np.exp(-np.arange(int(0.35 * SR)) / (0.05 * SR)) * rng.standard_normal(int(0.35 * SR)); ir[0] = 0.0
ir *= np.sqrt(1.0 / (ir ** 2).sum() / 10 ** 0.3); ir[0] = 1.0   # 直达声 = 1,混响能量比直达低 3 dB(DRR +3 dB,近场麦克风的量级)
ir = ir.astype("float32")
for m in man:
    x, _ = sf.read(m["wav"], dtype="float32")
    n = int(len(x) / 1.08); x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype("float32")
    y = np.convolve(x, ir)[:len(x)]
    nz = pink(len(y)); ps = np.mean(y ** 2) + 1e-9; pn = np.mean(nz ** 2) + 1e-9; nz *= np.sqrt(ps / (pn * 10 ** 0.5))
    y = np.clip(y + nz, -1, 1); y *= 0.8 / max(1e-6, np.abs(y).max())
    m["hard"] = os.path.join(HERE, "wav_hard", m["id"] + ".wav"); sf.write(m["hard"], y, SR, subtype="PCM_16")
json.dump(man, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1); print("hard set ok", len(man))

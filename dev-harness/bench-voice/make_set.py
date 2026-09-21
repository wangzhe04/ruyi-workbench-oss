"""用 edge-tts 把 sentences.txt 合成为 16 kHz 单声道 WAV(轮换 4 个中文神经语音),再造一份加噪版(SNR 10 dB 粉噪)。
产物: bench/wav/<id>.wav, bench/wav_noisy/<id>.wav, bench/manifest.json [{id, ref, voice, wav, noisy}]
"""
import asyncio, json, os, sys, io, subprocess
import numpy as np, soundfile as sf
import edge_tts

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES = ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunjianNeural"]
SR = 16000

def to_16k(mp3_bytes):
    # ffmpeg 若在就用它,否则 soundfile(libsndfile>=1.1 能读 mp3)
    try:
        p = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", "-ar", str(SR), "-f", "wav", "pipe:1"], input=mp3_bytes, capture_output=True, check=True)
        data, sr = sf.read(io.BytesIO(p.stdout), dtype="float32")
    except Exception:
        data, sr = sf.read(io.BytesIO(mp3_bytes), dtype="float32")
        if data.ndim > 1: data = data.mean(axis=1)
        if sr != SR:
            n = int(round(len(data) * SR / sr)); data = np.interp(np.linspace(0, len(data) - 1, n), np.arange(len(data)), data).astype("float32")
    return data

def pink(n, rng):
    white = rng.standard_normal(n + 1)
    spec = np.fft.rfft(white); f = np.arange(len(spec)); f[0] = 1
    return np.fft.irfft(spec / np.sqrt(f))[:n].astype("float32")

async def main():
    lines = [l.strip() for l in open(os.path.join(HERE, "sentences.txt"), encoding="utf-8") if l.strip()]
    os.makedirs(os.path.join(HERE, "wav"), exist_ok=True); os.makedirs(os.path.join(HERE, "wav_noisy"), exist_ok=True)
    rng = np.random.default_rng(130)
    manifest = []
    for i, ref in enumerate(lines):
        voice = VOICES[i % len(VOICES)]
        wav = os.path.join(HERE, "wav", f"{i:02d}.wav"); noisy = os.path.join(HERE, "wav_noisy", f"{i:02d}.wav")
        if not os.path.exists(wav):
            buf = b""
            for attempt in range(3):
                try:
                    async for chunk in edge_tts.Communicate(ref, voice, rate="+5%").stream():
                        if chunk["type"] == "audio": buf += chunk["data"]
                    break
                except Exception as e:
                    print("retry", i, e, file=sys.stderr); buf = b""; await asyncio.sleep(2)
            if not buf: raise SystemExit("TTS failed at %d" % i)
            data = to_16k(buf)
            data = np.concatenate([np.zeros(int(0.3 * SR), "float32"), data, np.zeros(int(0.5 * SR), "float32")])
            sf.write(wav, data, SR, subtype="PCM_16")
        data, _ = sf.read(wav, dtype="float32")
        if not os.path.exists(noisy):
            noise = pink(len(data), rng)
            ps = np.mean(data ** 2) + 1e-9; pn = np.mean(noise ** 2) + 1e-9
            noise *= np.sqrt(ps / (pn * 10 ** (10 / 10)))   # SNR 10 dB
            mixed = np.clip(data + noise, -1, 1)
            sf.write(noisy, mixed, SR, subtype="PCM_16")
        manifest.append({"id": f"{i:02d}", "ref": ref, "voice": voice, "wav": wav, "noisy": noisy, "sec": round(len(data) / SR, 2)})
        print(i, voice, round(len(data) / SR, 2), ref[:20])
    json.dump(manifest, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("total sec", round(sum(m["sec"] for m in manifest), 1))

asyncio.run(main())

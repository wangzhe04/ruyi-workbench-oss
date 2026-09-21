"""133a:把 passages.txt 按句合成 16 kHz 单声道 WAV(每段换一个语音、段内同一个),再造 SNR 10 dB 粉噪版。
产物(不进 git,目录由 BENCH_DATA 指定,缺省本目录): pwav/<pid>-<i>.wav, pwav_noisy/..., pmanifest.json
  [{id:"p03-2", passage:"p03", idx:2, ref, voice, wav, noisy, sec}]
用法: python make_passages.py   (要网络;edge-tts 装在评测用的 venv 里)
"""
import asyncio, json, os, sys
import numpy as np, soundfile as sf
import edge_tts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_set import to_16k, pink, VOICES, SR

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("BENCH_DATA", HERE)

def load_passages(path):
    out, cur = [], []
    for line in open(path, encoding="utf-8"):
        s = line.strip()
        if s.startswith("#"): continue
        if not s:
            if cur: out.append(cur); cur = []
            continue
        cur.append(s)
    if cur: out.append(cur)
    return out

async def main():
    passages = load_passages(os.path.join(HERE, "passages.txt"))
    os.makedirs(os.path.join(DATA, "pwav"), exist_ok=True); os.makedirs(os.path.join(DATA, "pwav_noisy"), exist_ok=True)
    rng = np.random.default_rng(133)
    manifest = []
    for p, sents in enumerate(passages):
        pid = "p%02d" % p
        voice = VOICES[p % len(VOICES)]
        for i, ref in enumerate(sents):
            sid = "%s-%d" % (pid, i)
            wav = os.path.join(DATA, "pwav", sid + ".wav"); noisy = os.path.join(DATA, "pwav_noisy", sid + ".wav")
            if not os.path.exists(wav):
                buf = b""
                for attempt in range(3):
                    try:
                        async for chunk in edge_tts.Communicate(ref, voice, rate="+5%").stream():
                            if chunk["type"] == "audio": buf += chunk["data"]
                        break
                    except Exception as e:
                        print("retry", sid, e, file=sys.stderr); buf = b""; await asyncio.sleep(2)
                if not buf: raise SystemExit("TTS failed at " + sid)
                data = to_16k(buf)
                data = np.concatenate([np.zeros(int(0.3 * SR), "float32"), data, np.zeros(int(0.5 * SR), "float32")])
                sf.write(wav, data, SR, subtype="PCM_16")
            data, _ = sf.read(wav, dtype="float32")
            if not os.path.exists(noisy):
                noise = pink(len(data), rng)
                ps = np.mean(data ** 2) + 1e-9; pn = np.mean(noise ** 2) + 1e-9
                noise *= np.sqrt(ps / (pn * 10 ** (10 / 10)))
                sf.write(noisy, np.clip(data + noise, -1, 1), SR, subtype="PCM_16")
            manifest.append({"id": sid, "passage": pid, "idx": i, "ref": ref, "voice": voice, "wav": wav, "noisy": noisy, "sec": round(len(data) / SR, 2)})
            print(sid, voice, round(len(data) / SR, 2), ref[:20])
    json.dump(manifest, open(os.path.join(DATA, "pmanifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("passages", len(passages), "sentences", len(manifest), "total sec", round(sum(m["sec"] for m in manifest), 1))

asyncio.run(main())

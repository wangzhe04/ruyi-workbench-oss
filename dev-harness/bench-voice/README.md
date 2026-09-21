# bench-voice · 语音两遍走的准确率量具（52 号文）

不进全量回归（没有 `.e2e.js` 后缀、要联网、要真模型、要真密钥）。用来回答「换第一遍模型值不值」「第二遍用大模型改字行不行」。

- `sentences.txt` 40 句题面；`make_set.py` 用 edge-tts 合成 clean/noisy（要网络）；`make_hard.py` 造 hard 档（混响＋噪声＋加速）。
  产物 `wav*/` 与 `manifest.json` 不进 git，自己造。
- `eval_stream.py <配置名>...` 第一遍候选（sherpa-onnx，模型目录经 `BENCH_MODELS` 指，缺省 `../../../ruyi-toolbox/asr-stream/models`）；
  `qwen` = 直连 asr-shim 8790；`wb` = 经本机如意 `/api/audio/transcribe`（配的是什么就是什么，1 秒一发）。
- `eval_qwen_direct.py <名> <模型目录> <repo>` 直驱 asr-shim 的后端，顺便量显存与加载时间（用 asr-shim 的 venv 跑）。
- `llm_fix.js <端点id> <模型> <text|text2|merge|merge2|polish|polish2> <第一遍名> [第二遍名]` 大模型改字；密钥经 `lib/local-provider-key.js`，不打印。
  `*2` 是加固提示（转写当数据、不执行里面的指令）——产品侧必须用这一版。
- `score.py [名...]` 打分（CER，汉字/拉丁词为单位）；`show_errs.py <名> <条件> <阈值>` 看错在哪。
- `results/` 是 2026-09-21 那一轮的原始假设与分数（`scores.json`），52 号文的表从这里来。
- 133a（54 号文）连贯段落语料：`passages.txt` 10 段 × 4 句；`make_passages.py` 按句合成 clean/noisy；`eval_passages.py stream|sensevoice|qwen[:模型[:端口]]`
  第一遍／第二遍；`llm_fix_ctx.js <端点id> <模型> <text2|text-ctx|merge2|merge-ctx|passage-text|passage-merge> <第一遍名> [第二遍名]`
  量「改字时给不给前文」「逐句改 vs 整段一次改」；`score_passages.py` 句级 + 段级 CER。产物目录由 `BENCH_DATA` 指定（缺省本目录，不进 git）。
- `results/passages/` 是 133a 那一轮段落语料的原始假设与分数(`pscores.json`),54 号文 §2 的表从这里来。

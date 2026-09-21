# 51 · 第 130 波 —— 语音输入两遍走：流式小模型出字，大模型静默改错

> 状态：**130a–130c 已出门**（2026-09-21 同日）：toolbox `asr-stream` 组件（3d129f5）＋ 主仓发现／代理／麦克风流式路／静默校正；
> 130d 真机走查待用户。出方案与执行：Fable（主会话）。
>
> 用户原话（2026-09-21）：「感觉语音识别速度比微信上的慢好多……手机本地的语音识别似乎也很快」「我觉得也不用换，直接新增一种
> 微信那种本地小模型吧；此外我发现手机本地语音识别那种，识别出字一段时间后（很短）会自动根据语义识别修正错字，这也希望能做到」。
> 两条拍板：**① 校正默认静默替换；② 第一版只做麦克风这一路**（音频附件与 `audio_transcribe` 工具仍走整段识别）。

## §0 一句话

手机那种「一说完字就在、过一小会儿自动改错」是**两遍**：第一遍流式小模型边听边出字，第二遍在句尾用更强的模型重识别这一句、
把改动的字换回去。本波照这个形状做：**新增**一个流式小模型组件（`ruyi-toolbox/asr-stream`，sherpa-onnx 流式 Zipformer，
CPU、常驻、几十到两百 MB），负责「立刻出字」；**已经装好的 Qwen3-ASR（或任何云端语音识别）就是现成的第二遍**，负责改错。
两遍都是可选的：只有第一遍 → 快但错得多；只有第二遍 → 就是今天；两遍都有 → 手机体验。

## §1 两种模型的优劣（给决策留档）

| | 流式小模型（sherpa-onnx Zipformer／Paraformer 流式） | Qwen3-ASR 这类 LLM 型 |
|---|---|---|
| 出字时机 | 边说边出，落后语音 0.1–0.3 s | 一段说完再整段解码 |
| 资源 | 几十–两百 MB、int8、CPU 即可、常驻不占显存、不装 torch | 1.5 GB 模型、显卡上 2 GB 显存、要 torch |
| 冷启动 | 秒级，可一直常驻 | 加载十几秒（所以才有空闲卸载） |
| 准确度 | 安静环境日常中文够用；嘈杂、专业词、中英混说、数字日期明显差 | 高很多；带标点、自动判语种 |
| 语义 | 无（只看几秒声学上下文，同音字分不清） | 有（解码器就是语言模型）—— 改错靠的正是它 |
| 长音频 | 任意长 | 30 s 窗口切段，切口吞字 |

结论：**小模型管手感，大模型管准确**，不是替代关系。

## §2 形状

```
麦克风 ──PCM 16k── 每 250 ms 一块 ──POST /api/audio/stream/…──▶ 如意服务端 ──代理──▶ asr-stream(127.0.0.1)
   ▲                                                                │
   │  partial（临时文字，随说随改）                                  │ 句尾（端点检测）→ final 这一句
   │  final（定稿一句）                                              ▼
输入框 ◀── 静默替换（只动没被用户碰过的那一句）◀── 第二遍：这一句的音频 → /api/audio/transcribe（Qwen3-ASR／云端）
```

### 2.1 为什么不是 WebSocket

如意服务端零 npm 依赖、今天没有任何 `upgrade` 处理；浏览器页也不能直连组件端口（组件按登记约定拒绝带 `Origin` 的请求）。
所以走**有会话的 HTTP**：每 250 ms 一块 PCM POST 上去，回包里就带当前的临时文字与新定稿的句子。一块的延迟 ≈ 250 ms +
解码几十 ms + 两跳本机 HTTP，与手机体验同量级；两边都不用发明新传输层（组件仍是「小 HTTP 服务」，与 asr-shim 同模具）。

### 2.2 组件（`ruyi-toolbox/asr-stream/`，Python + sherpa-onnx）

- 模型：缺省 `sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`（int8，中英双语；用户的话里常夹英文术语）。
  `RUYI_ASR_STREAM_MODEL_DIR` 可换任何 sherpa-onnx 流式 transducer 模型目录。启动即加载（小，秒级），**常驻不卸载**。
- 会话 API（都只在 `127.0.0.1`）：
  - `POST /v1/stream/sessions` → `{ "id", "sampleRate": 16000 }`；体可带 `{ "hotwords": ["…"] }`（≤ 200 条，每条 ≤ 40 字）。
  - `POST /v1/stream/sessions/{id}/audio`，`Content-Type: audio/L16; rate=16000`，体 = 16 kHz 单声道 PCM16LE，单块 ≤ 1 MB
    → `{ "partial": "…", "finals": [{ "text", "startMs", "endMs" }] }`。`finals` 是自上次调用以来端点检测收口的句子。
  - `POST /v1/stream/sessions/{id}/finish` → 冲掉尾巴，回最后的 `finals`，会话关闭。
  - `DELETE /v1/stream/sessions/{id}`。
  - `GET /health` → `{ ok, component: "ruyi-asr-stream", version, loaded, sessions, model }`。
- 端点规则（sherpa 三条）：rule1 静音 2.0 s；rule2 说过话之后静音 0.8 s（与工作台停顿切段的 700 ms 同量级）；rule3 单句 20 s 硬切。
- 并发：最多 4 个会话；30 s 无音频自动关闭；解码串行（CPU 两线程）。
- 安全与隐私：与 asr-shim 完全同一套（只绑 127.0.0.1、`Host` 闸、拒 `Origin`、音频只在内存、日志只记元数据、看门狗 `RUYI_TOOLBOX_PARENT_PID`）。
- 登记：`kind: service`，`service.component: "ruyi-asr-stream"`，端口缺省 8791（`RUYI_ASR_STREAM_PORT`），
  `provides: [{ "type": "asr-stream", "basePath": "/v1", "model": "zipformer-bilingual-zh-en" }]`。
  登记约定 §2.2 已写明「不认识的 type 跳过」—— 老版本如意见到它什么也不做。

### 2.3 工作台

- **发现与自动配置**（04／04f）：`TOOLBOX_PROVIDES_TYPES` 加 `asr-stream`；生成服务商 `toolbox-<id>`，模型带 `caps: ['asr-stream']`
  （05 的 `PROVIDER_MODEL_CAPS` 白名单加这一项）。新配置键 `asrStreamProviderId`／`asrStreamModel`，自动选中规则与 114a 那两键**同一套**
  （用户没配过才选、每组件一次、关掉不选回）。既有的 `asrProviderId`／`asrModel` 语义不变，只是在设置页里改称「整段识别 · 校正」。
- **代理路由**（13b audio 域，ROUTE_AUTH token 级）：`POST /api/audio/stream/sessions`、`POST /api/audio/stream/sessions/:id/audio`、
  `POST …/finish`、`DELETE …/:id`。上游地址只来自配置里那条 `asr-stream` 服务商（绝不收请求体里的 URL）；服务端持有
  「会话 id → 上游」表，浏览器只拿到 id；单块 ≤ 1 MB、每进程 ≤ 4 个活会话、30 s 无音频服务端也回收。
- **麦克风**（composer-voice.js）：配了 `asrStream*` 就走流式；没配就是今天的按停顿切段，一字不改。流式路：
  1. AudioContext 取 PCM、重采样到 16 kHz、每 250 ms 一块上送；
  2. `partial` 作为**临时文字**填在锚点处，随每块回包整段替换；
  3. `final` 一句 → 临时文字换成定稿，记下这一句在输入框里的 `[start,end)` 与它的音频；
  4. **第二遍**：`asrProviderId` 配了就把这一句的音频编成 WAV 送 `/api/audio/transcribe`；回来的文本不同、且输入框里
     `[start,end)` 仍逐字等于定稿 → **静默替换**（拍板 ①），后面各句的偏移跟着挪；用户已经碰过这一句就不动；
  5. Esc 取消 = 临时文字撤掉、排队的第二遍作废，已定稿的字留着；点结束 = `finish` → 收尾句 → 第二遍 → 空闲；
  6. 组件起不来／会话开不了 → 当场回落到停顿切段那条路（不让人对着麦克风白说）。
  7. 不变的边界：永不自动发送；不落盘；每一秒音频第一遍只送一次、第二遍只送一次。
- **设置页**：「语音识别」那一栏变两项 —— 「实时识别（边说边出字）」列 `asr-stream` 候选；「整段识别 · 校正」就是原来那个选择器。
  「扩展组件」栏自然多出这一行。
- **不做**（拍板 ②）：音频附件与 `audio_transcribe` 工具仍整段走第二遍模型；不做流式的 WebSocket；不做标点模型（第二遍会带标点）。

## §3 切片与验收

| 片 | 内容 | 验收 |
|---|---|---|
| 130a | toolbox `asr-stream` 组件：服务、会话 API、端点检测、热词、安装脚本、登记、README | 单元测试（假识别器，不载真模型）；真机：说一句 5 s 的话，partial 落后 ≤ 0.5 s，句尾 ≤ 1 s 出 final |
| 130b | 工作台：发现／自动配置、代理路由、设置页两项、i18n | toolbox-discovery.e2e 加假流式组件；路由清册与 ROUTE_AUTH 锁；静态锁更新 |
| 130c | 麦克风流式路 ＋ 第二遍静默替换 ＋ 回落 | composer-voice.browser.e2e：假流式端点出 partial/final、第二遍改字只动没碰过的句子、Esc、回落；单元锁替换算法 |
| 130d | 真机联调：Qwen3-ASR 当第二遍；CHANGELOG；两仓 README | 用户走查 |

## §4 风险

- 流式模型对嘈杂环境／英文术语差 —— 第二遍兜底；热词从工作区名字喂给两遍（130a 留口，130c 接）。
- 第二遍替换的「闪一下」—— 只在句尾后一秒内、只动没碰过的字（拍板 ①）；替换算法必须是纯函数、单元锁死。
- 组件模型下载：GitHub releases 大陆可能慢 —— 安装脚本给 HF 镜像（`HF_ENDPOINT`）一条路，执行时核实 ModelScope 有无同名仓库。

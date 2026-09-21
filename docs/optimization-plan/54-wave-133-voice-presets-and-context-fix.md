# 54 · 第 133 波 —— 句尾改错带前文；本地模型体量可选、切走即卸载；语音输入分档

> 状态：**用户 2026-09-21 提出五点，本文出方案、评测并同日实施**。出方案、评测与执行：Fable（主会话）。
>
> 用户原话：「句末大模型再识别，最好不要按音频一句一句的识别，而是包含整段的上下文统一编排会不会好一点，你测一下；
> 然后现在 1.7b 的模型太占显存了，我觉得除了 auto 外，最好能让用户在选项里选不同体量的模型；或许 auto 默认 0.6b，用户可以在如意里
> 自主切换成更大的 1.7b；然后如果语音识别切换剔掉了大模型，那么立马把模型从显存里卸载；最好分几个轻度/重度的语音识别选项
> （轻度似乎是两个实时的＋文字大模型整理），重度的看你搭配吧；然后现在这套语音识别的设置选项，确实有点复杂了，也优化一下吧」。

## §1 结论先行

| 用户的点 | 结论 | 落法 |
|---|---|---|
| 整段上下文统一编排会不会更好 | **会，但形状不是「等说完整段一次改」，而是「逐句改、把前面几句当上下文给它」**。纯文字改错错误数 23 → 13，SenseVoice 重听路 11 → 10；整段一次改 15 / 8，不比逐句带前文好多少，还要把已上屏的字整段重写 | 133a：`/api/audio/correct` 收 `context`，提示词加 `<context>` 段；前端把输入框里这一句之前的字送去。**默认开、无新开关** |
| auto 之外可选体量；auto 默认 0.6B | asr-shim 登记时把每份装好的尺寸都列出来（`provides[0].models`），如意设置里逐份可选；`auto` 改为**最省显存的那份**（0.6B） | 133b：shim `catalog()` / 请求 `model` 字段换加载；如意 04 认 `models[]`、04f 落成多条带 label 的模型 |
| 切走就立刻卸载 | 组件登记 `service.unload`（POST 路）；整段识别那一对键一变（换模型／换服务商／关掉）如意就打它 | 133b：shim `POST /v1/unload` + 引擎 `unload_now()`；如意 13 → 04f `asrSelectionChanged` |
| 分轻度／重度 | 三档 + 关闭 + 自定义：**轻度**＝流式（CPU）＋ SenseVoice 重听（CPU）＋ 大模型合成，不占显存；**标准**＝流式 ＋ Qwen3-ASR 0.6B（约 2 GB）；**重度**＝流式 ＋ Qwen3-ASR 1.7B（约 5 GB） | 133c：档位**不是新配置键**，由现有三对键推算；选档位＝一次写三对键 |
| 设置太复杂 | 设置页语音区改成「一排档位 + 一行说明」，原来三栏收进折叠的「逐项指定（高级）」 | 133c |

## §2 评测：改字时给不给前文（133a）

### 2.1 量具

40 句独立题面（52 号文）上前文帮不上忙——句与句没关系。所以另造 **10 段 × 4 句**的连贯语料（`dev-harness/bench-voice/passages.txt`）：
后句故意依赖前句（同一个术语、分支名、人名、数字），如「缓存层用的是 redis / … / 你先把 redis 的慢日志拉出来看一眼」、
「分支叫 feature login / … / 把它 rebase 到 main 上」。edge-tts 按句合成（每段换一个声音）、SNR 10 dB 粉噪版各一份；
第一遍 zipformer 流式（产品缺省 beam search）、第二遍 Qwen3-ASR（本机 shim，1.7B）与 SenseVoice；改字用 DeepSeek `deepseek-flash`
（关思考、加固提示词，与产品 05 同文）。工具：`make_passages.py` / `eval_passages.py` / `llm_fix_ctx.js` / `score_passages.py`。

六种改字方式：`text2`（一句一改、只给这一句，产品 131b 的 llm 路）、`text-ctx`（另给这段前面几句已改好的当上下文）、
`merge2`（一句一改、A＋B，产品 auto 路）、`merge-ctx`、`passage-text` / `passage-merge`（整段一次改、逐行输出）。

### 2.2 结果（CER %，40 句 555 个字／词单位；括号是错的单位数）

| 方式 | clean | noisy | 备注 |
|---|---|---|---|
| 第一遍 zipformer 流式 | 9.01 (50) | 7.75 (43) | 这份语料英文术语多，比 52 号文那份难 |
| SenseVoice 重听（CPU） | 3.42 (19) | 4.14 (23) | |
| Qwen3-ASR 1.7B 重听 | 0.72 (4) | 0.72 (4) | 已近地板 |
| 只看文字改错 `text2` | 4.14 (23) | 3.24 (18) | |
| 只看文字 + 前文 `text-ctx` | **2.34 (13)** | **1.80 (10)** | 错误数减一半：release↔redis、compose↔complex、rebase↔merge 这类靠前文判 |
| 整段一次改 `passage-text` | 2.70 (15) | 1.80 (10) | 不比逐句带前文好 |
| 流式 + SenseVoice 合成 `merge2` | 1.98 (11) | 1.80 (10) | 轻度档的现状 |
| 同上 + 前文 `merge-ctx` | 1.80 (10) | 1.62 (9) | |
| 同上、整段一次改 `passage-merge` | 1.44 (8) | 1.44 (8) | 略好，但要整段重写 |
| 流式 + Qwen 1.7B 合成 `merge2` | 0.72 (4) | 0.72 (4) | 标准／重度档的现状 |
| 同上 + 前文 `merge-ctx` | 0.72 (4) | **0.54 (3)** | |
| 同上、整段一次改 `passage-merge` | 0.72 (4) | 0.54 (3) | |

耗时：带前文一句 p50 ≈ 650 ms，与不带持平（多几十个 token）。

### 2.3 拍板

- **逐句改、带前文**：默认开、不加开关。前文 = 输入框里这一句之前的文字（含用户自己打的），前端最多带 600 字、服务端只取尾巴 600 字。
  前文放 `<context>` 标签、system 里说清「只参考、不输出、不并进当前句」；没前文时提示词与 131b **逐字相同**（老路径零漂移）。
- **不做「整段一次改」**：收益小于逐句带前文（除 SenseVoice 路略好 2 个错），且会把已经上屏、用户可能已经动过的字整段重写，
  与 130 拍板「静默替换只动没碰过的字」冲突。
- 一处已知的副作用：大模型偶尔会把「压测」扩写成「压力测试」这类改写（p04-0）。仍在「只改明显识别错误」的提示词约束内，未加规则。

## §3 asr-shim：体量可选、切走即卸载（133b）

### 3.1 组件侧（ruyi-toolbox `asr-shim`）

- `autopick.pick()` 缺省 **prefer=small**：`auto` = 最省显存的那份（装了 0.6B 就是 0.6B；只装了 1.7B 才是它）。老策略「最大能装下的」
  保留成 `RUYI_ASR_AUTO_PREFER=large`。`catalog(models_root)` 回 `[auto, 0.6B, 1.7B…]` 每项带 `label`（「1.7B（更准，约 5 GB 显存）」）。
- `EngineManager`：工厂按名造后端；请求带 `model` 且与已加载的不是同一份 → **先卸后载**（显存里最多一份）；`unload_now()`
  等在途那一发转完再卸。`auto` 实际挑中 0.6B 后再点名 0.6B 不重载。
- `server.py`：`GET /v1/models` 列清单；`POST /v1/audio/transcriptions` 的 `model` 字段选尺寸（不认识的名字回落缺省，
  「填什么都能转」的老判据不变）；新增 `POST /v1/unload`（安全闸同其它路由）；`/health` 多 `models`。
- `registry.py`：auto 登记写 `provides[0].models` 与 `service.unload: "/v1/unload"`。下了新尺寸要重跑 `download-model.ps1`（它重新登记）。
- 146 个单测（+10）：先卸后载、同一份不重载、`unload_now` 等在途、老式无参工厂照走、清单／路由／安全闸。

### 3.2 如意侧

- `docs/00-component-registry.md` §2.2 增两个可选字段：`service.unload`、`provides[].models`（老版本如意不认就忽略）。
- 04 `sanitizeToolboxComponent`：`models[]` ≤ 8 条、id ≤ 120、label ≤ 80，缺省那份不在清单里就补到最前；`unload` 形状同 `health`。
- 04f `toolboxDesiredProviders`：每份都落成带 `label` 的模型（设置页那一格显示「本地语音识别（Qwen3-ASR） / 1.7B（更准，约 5 GB 显存）」）。
- 04f `asrSelectionChanged(prev, next)`（13 `applyConfigPatch` 落盘后 fire-and-forget 调）：`asrProviderId/asrModel` 从某个 toolbox
  组件换走（换成别的服务商、换成它的另一份、关掉）→ POST 它的 unload 路（只到 127.0.0.1:<它的端口>，5 s 超时，审计日志记结果）。
  换成同一组件的另一份也打（下一发请求加载新的，旧的这会儿就该让出显存）；换【回来】不打。

## §4 语音输入分档与设置页（133c）

### 4.1 档位

| 档 | 实时识别 | 整段识别（句尾重听） | 句尾改错 | 资源 |
|---|---|---|---|---|
| 关闭 | 不选 | 不选 | — | — |
| 轻度 | zipformer（asr-stream，CPU） | SenseVoice（asr-stream，CPU） | auto | 不占显存 |
| 标准 | 同上 | Qwen3-ASR 0.6B（asr-shim；老登记只有 auto 时用 auto） | auto | 约 2 GB 显存 |
| 重度 | 同上 | Qwen3-ASR 1.7B | auto | 约 5 GB 显存 |
| 自定义 | 对不上任何一档的组合（云端 ASR、只重听、只改字…） | | | |

档位**不是配置键**：`asrCurrentPreset(config, targets)` 由 `asrStream*` / `asr*` / `asrFixMode` 三对键推算；选档位 = 一次
`saveConfigPartial` 写这三对键（改字端点那一对不动，缺省跟随主端点）。老配置、管家改键、手工改 config.json 都不会与它打架。
三档只认 `toolbox-` 前缀的服务商登记的模型；装不了的档灰掉、悬停说原因（要装哪个组件／下哪份模型）。

### 4.2 设置页

「语音输入」一栏：一排开关钮（关闭｜轻度｜标准｜重度｜自定义）+ 一行说明（当前档会怎么走、改字用哪个大模型、占不占显存）。
原来的三栏（实时识别／整段识别／句尾改错）**原样**收进折叠的「逐项指定（高级）」：自定义时默认展开；从灰麦克风跳过来时先打开。
键、选择器、添加行一个不动（asr-config-ui.static 的老锁全保留，只改三栏落点的锚）。

## §5 判据与锁

| 锁 | 钉什么 |
|---|---|
| unit `asr-fix-prompt` U2c–U2g | 前文进 `<context>`、换行压空格、system 说清只参考；合成模式也带；没前文时与 131b 逐字相同；只取尾巴 600 字 |
| asr-config-ui.static | `/api/audio/correct` 体带 `context`、前文取法；档位三函数真跑（off／light／standard／custom／写键／不可用）；档位不是配置键；三栏收进高级区；高级区从麦克风跳来时打开；19 个新 locale 键双语 |
| toolbox-discovery M1–M6 | `provides.models` 落成带 label 的两份；换模型 → unload 一次；只改别的键不打；换服务商再打一次；换回来不打 |
| asr-shim 单测 146 | §3.1 |
| voice-setup.browser / composer-voice*.browser | 老锁照跑（高级区里的选择器仍可达） |

## §6 切片

| 片 | 内容 | 判据 |
|---|---|---|
| 133a | 评测（passages 语料 + 三个脚本）；`/api/audio/correct` 收 `context`；05 提示词；前端送前文 | §2；unit；static |
| 133b | shim 清单／换加载／unload；约定 §2.2；04 认字段；04f 落模型 + 切走即卸载；13 钩子 | shim 单测；toolbox M 组 |
| 133c | 档位一栏 + 高级折叠区；locale；CSS | static；browser 老锁 |

## §7 追加（133d，用户 2026-09-21 下午两条）

> 「默认的对话主模型似乎没法在设置里改，我觉得要在基础设置里也能改；管家新开的线程，默认只能走如意的 OpenAI 兼容端点，
> 走 Claude CLI 和 Kimi CLI 似乎会有问题；这两个第三方 CLI 只作为能在工作台使用的兼容存在。」

### 7.1 基础页「对话主模型」

顶栏 `#modelChip` 在 121-K5 退役后，全局 `activeProvider` ＋ 主模型（`providers[].model`／CLI 的 `config.model`）**再没有任何界面能改**
——线程头 chip 写的是会话级路由（`PATCH /api/sessions/:id`），不动全局。基础页最上面新增折叠组「对话主模型」：两枚选择器
（端点：Agent CLI（兼容用）／每个能对话的服务商；模型：该服务商的 models 或 CLI 的 /api/status models），**选中即存**
（`activeProvider` + 那一条 `providers[].model`，或 `model`），不进底部「保存」那份整体补丁；弹窗开着时 providersDraft 同步。
说明行按 `newThreadEngine` 写清它是谁的缺省，并明说「管家开的线程只走 OpenAI 兼容端点」。

### 7.2 管家线程只走 OpenAI 兼容端点

修前：`stewardApplyThreadTier` 在那一档（强／快）没配时**不写** `session.engineRoute`，线程沿用 createSession 的缺省 ——
`newThreadEngine=last` 时是用户上次用的、否则是全局，两者都可能是 Agent CLI。定时任务没指定档位时连 applyThreadTier 都不进。

修后（06i `stewardOpenAiFallback`，纯函数）：档位没配或端点已删 → 按固定顺序挑一个 OpenAI 兼容端点：
① 管家自己的端点（`stewardProviderId`）② 全局主端点（是 OpenAI 端点时）③ 用户上次用的（OpenAI 路由且端点还在）④ 清单里第一个能对话的
（不是 claude-cli、不是 toolbox-、不是只做语音的）。13q `stewardEnsureOpenAiRoute` 单点执行：已是 OpenAI 路由一字不动；挑到就写
`session.engineRoute` 并记 `steward_thread_engine_openai_only`；一个都没有 → 留全局并记 `steward_thread_no_openai_provider`
（不拒绝开线程）。三个开线程的口（13k 线程／快问经 applyThreadTier、13t 定时任务经 `StewardHooks.ensureOpenAiRoute`）都走它。

用户自己开的线程、线程头上手动切到 CLI 的线程不受影响 —— 两个 CLI 仍是工作台里的一等引擎，只是不再给管家用。

### 7.3 判据

unit `steward-config-tier` ⑦：回落顺序四层各一例、toolbox-／只做语音的跳过、上次用的是 CLI 路由不算、空配置不抛；机械锁钉 13q／13h／13t 三处接线。

## §8 追加（133e，用户 2026-09-21 傍晚两条）

> 「现在管家层这个加号点不了，修一下，最好复用线台类似的东西，或者针对管家层微调；然后现在管家层文字输多了，还是只有一行，最好也能优化一下让用户能看见更多的字」

- **「＋」不再是禁用占位**：与工作台 `#composerMoreBtn` 同款小浮层（同一个 popover 原语、同一套 `.composer-more-pop/.cm-item` 样式），两项：
  **添加文件**（与工作台 `uploadFiles` 同一条路：dataURL → `POST /api/upload` → 记录进输入行上方的附件托盘，pill 样式复用 `.attachment-pill`）、
  **另起一件**（就是抽屉「＋ 线程」那条 `markNewInMission('')`，chip 变「→ 如意 · 另起一件」）。技能库／压缩不进来（CLI 概念／管家自有节流）。
- **附件随消息进管家回合**：`/api/steward/message` 体多一个独立键 `attachments`（用户那句话仍逐字不动），13h 只收记录形状里那几个字段、≤12 条，
  13q 交给 `runSessionTurn` 的 `attachments` —— 与工作台 `/api/chat/stream` 同一条管线；直递线程（handOff）那条路不带附件。用户气泡下列一行「附件：…」。
- **输入框随内容长高**：复用 util.js 的 `autoGrow`（与 `#promptInput` 同一个），上限 220px（约八行）后内部滚动；发完收回一行。
- 锁：steward-conversation.static D6c/D7、walkthrough H3b/I1/I1b 改钉新的请求体形状；J1/Q7c 路由白名单加既有的 `/api/upload`；
  N5c/L3/D9/I4 那几行代码原样未动（附件行由 `appendAttachLine` 另起一函数、第二条 import 行、`composerApi` 迟引用）。

## §9 追加（133f，用户 2026-09-21 晚）：标准／重度第一次「又卡又不准」→ 开录前的预热闸

> 「现在如意的语音识别，如果调成标准/重度的话，第一次的语音识别会又卡又不准；如果是因为加载模型比较慢的话，可以加个简单的动效什么的，等加载完成后才显示让用户语音输入」

### 9.1 成因（日志实证，不是猜的）

工作台运行日志 `asr_transcribe_ok`（2026-09-21，UTC）：

| 时刻 | 情形 | 首句转写耗时 | 同时排队的几句 |
|---|---|---|---|
| 07:15 | 新起的 shim，`qwen3-asr-auto` 首次使用 | **31.3 s** | 26.8／22.7 s |
| 08:50 | 新 shim，切到重度 `1.7b` | **32.7 s** | 30.8／28.3／26.3／23.2 s |
| 12:00 | 新 shim，`0.6b` | **28.0 s** | 25.4／23.3／21.3 s |
| 12:03 | **同一进程**里「切走即卸载」后再装 `0.6b` | 3.2 s | —— |
| 全天 | 轻度档 `sensevoice-small`（asr-stream 里常驻） | 79–293 ms，首句也是 | —— |

也就是说：**只有标准／重度会遇到**，因为它们的第二遍是 asr-shim 里的 Qwen3-ASR，而 shim 空转时不 `import torch`
（登记约定 §2.2「空转要轻」，这个约定是对的：绝大多数时间没人说话），第一发转写请求才加载。隔离实验（全新 shim 进程，
系统文件缓存热）把冷启动拆开：`import torch/transformers`＋探设备 **7–8 s** → 载权重 **3–4 s** → 首次推理 **2–2.5 s**，合计 12–14 s；
工作台里同时还有浏览器、asr-stream、别的窗口在抢，实测 22–33 s。这段时间用户已经在说话：屏上只有第一遍小模型的字（不准），
第二遍请求全排在 shim 的那把串行锁后面，等模型装完才**一起**回来（一批字突然跳变）；显存往里灌、内核编译的时候机器也在抖（卡）。

### 9.2 做法：点麦克风后先问「模型装好了没」，没装就显示加载中，装好才开录

- **`POST /api/audio/warmup`**（13b，token 级，01b 登记）：解出整段识别端点；不是 `toolbox-` 服务商 → `{skipped:'remote'}` 秒回。
  toolbox 组件：先 `ensureForProvider`（挂了就地拉起），再读它登记的 `service.health`（04f 新增只读探针 `toolboxHealthForProvider`，
  只到 127.0.0.1、1.5 s 超时）：`loaded:true` 且已装的正是要用的那份（`resolvedModel`／缺省名／它内置离线模型名之一）→ 秒回 `{warm:true}`；
  **拿不准一律当没装**（多打一发静音只花几百毫秒，判错成「已装」就是用户又等半分钟）。没装 → 用 **1 秒静音**走**和真请求同一条**
  出站路径（`transcribeAudioViaProvider` 加 `warmup` 开关：不记账、不记 `asr_transcribe_ok`，审计另记 `asr_warmup`），
  返回时模型已装、首次推理已做。同一份模型的并发预热合并成一发（取消再点、两个输入框同时点都不装两遍）。
- **前端（composer-voice.js ⑩）**：`composerVoiceNeedsWarmup(config)`（纯函数：会用到本地识别组件才问 —— 云端没有「装载」；
  流式路里整段识别只在句尾重听时才用）。`start()` 里先过闸，请求超过 400 ms 才亮出**加载中态**（`data-state="warming"`：主色麦克风＋
  转圈＋「加载模型 m:ss」，悬停提示说清「装好自动开始、再点／Esc 取消」，读屏播报，一句 toast）；装着的常态一个字不多说、直接开录。
  装好后才去拿麦克风、开流式会话（加载十几秒里不该亮着系统的「正在录音」指示，也不该录进还没开口的沉默）。
- **边界**：加载中再点／Esc＝取消（只掐这一发请求，服务端的装载照常完成，下一次点击就是热的）；装好时页面不在前台（切了标签／窗口）
  → 不替他开麦克风，回到空闲并说一句；预热失败 → 流式路照录（第一遍不依赖它）并说一句「没能加载好」，没有第一遍的（按停顿切段）
  当场说清原因；等待期间用户在设置里换了档位 → 装好的是旧的那份，再问一次（最多三轮）。设置页标准／重度的说明各补一句「首次使用要先装模型」。

### 9.3 判据与锁

- `asr-warmup.e2e.js`（服务端，假冷启动组件 `lib/fake-cold-shim.js`）：A 门（无 token 403／未配置 409）、B 冷（耗时 ≥ 加载耗时、组件那头恰好一次装载一发转写、
  探针是 32044 字节的 1 秒静音）、C 热（15 ms、不打扰组件）、D 不是用户的转写（审计有 `asr_warmup`、无 `asr_transcribe_ok`、账本无 `note:'asr'`，
  **自带尺子**：随后一发真转写才各多一条）、E 三发并发合并成一次装载、F 装的不是要的那份→换载、G 云端 skipped、H 组件 500→502 信封且无脏状态、I 组件崩了就地拉起。
- `composer-voice-warmup.browser.e2e.js`（真浏览器，假麦克风）：冷点进加载态（转圈动画在跑、加载期间 `getUserMedia` 0 次且没开流式会话、
  状态序列 `starting→warming→starting→recording`、第二遍自开录起 < 加载耗时）、热点一次加载态都不出现、点击／Esc 取消后装好也不自己开录且只装一次、
  预热失败流式照录、页面不在前台不开麦、没有第一遍时失败进 error 态。**这件抓到一处真缺陷**：装好后 `phase` 改回 `starting` 却没重画，
  按钮停在「加载模型 0:02」（此时若弹麦克风授权框会一直说假话）—— 已补 `paint()`。

### 9.4 真机数（全新的真 asr-shim 进程，隔离工作台＋无头 Edge＋假麦克风）

点麦克风 → **544 ms** 出现加载态 → **25.1–25.8 s** 后装好并自动进录音态；随后再问 warmup **15–25 ms**（`warm:true`，真 `/health` 形状匹配成功）；
同进程卸载后再问 **3.2–3.4 s** 装好。预热之后连测三句真话（5.4 s 中文）：直连 shim 时 0.88／0.92／0.84 s，且**预热音频形状与预热后的空闲时长都不影响首句**
（静音 1 s／类语音 5 s、预热后立刻测／空闲 10 s／12 s 后再测共四轮，首句都在 0.88–1.02 s）。

### 9.5 已知边界（没有算进这次的承诺）

- **新装机器上每个新的音频长度档首次要多编译一次内核**（约 +3–4 s，之后进磁盘缓存）：复现方法是把 shim 的 `USERPROFILE` 指到空目录 ——
  静音预热后首句 3.9 s、换 6.03 s 的一句又 4.0 s；预热多喂 1 s/3 s/6 s 三种长度能盖住同一「秒档」（5.4 s 首句 0.7 s），但每次装载要多花数秒，
  对「缓存已热」的常态是纯亏，所以预热保持最小（1 秒静音）。测试夹具会把 `USERPROFILE` 指到临时目录，所以夹具里量到的首句会偏慢。
- 没做的两个可选项：① 用户在设置里切档位时就地预热（切完立刻去说的人少等一次）—— 需要设置页也有「加载中」的提示，否则后台一次显存加载又变成不明原因的卡；
  ② shim 起来时后台预先 `import torch`（省 7–8 s）—— 与「空转要轻」的约定相抵触，要拍板。

# 45 · 第 127 波 · 服务目录与模板映射 ＋ 语音回填

> **用户触发（2026-09-16）**：「结束后帮我继续自主推进下一波吧，一直推进就行」。排期依据 [43 号文 §2](43-merge-114-111-107-into-product-line.md)（114a–114c 并入本波 B 道，S01／S02／F01 为 A 道）。
>
> **本文的性质**：派单稿。**不重写 [26 号文](26-wave-114-asr.md) 的 ASR 设计**（冻结边界、威胁模型、切片划分、记账口径全部原样有效），也**不重写 [41 号文 §5.9](41-personal-workbench-iteration-plan.md) 的服务目录裁决**（「不新建目录引擎、探针或模板 DSL」仍然成立）。本文只补三样它们没有的东西：**落在今天这棵树上的哪一行**、**按什么顺序出门**、**每一刀的反向怎么做**。
>
> **前一波**：[44 号文](44-wave-126-memory-scope-and-compaction-v2.md)（126 波，已收；B 道五刀全收、A 道两刀、M03 如实不过门）。

## 0. 一句话

两道并行：**A 道让用户知道如意到底能替他完成哪几件事**；**B 道让他能开口说，而不是打字**。两道文件零重叠。

## 1. 取证（2026-09-16 主树实读，HEAD `dc32e4d`）

### 1.1 26 号文的摸底做于 2026-09-03，十三天里五处全变了

**它的设计有效，它的坐标失效。** 照着老坐标施工会踩空：

| 26 号文当时写的 | 今天实测 |
|---|---|
| `CONFIG_SCHEMA=11`，114a 要 11→12 | 仍是 11，但**仓里后来确立了相反的约定** —— 见 §1.2，这是待拍板项 1 |
| 原生工具 63→64 | **96**（`facts.json.nativeTools`）。`audio_transcribe` 是 **96→97** |
| 「建议排在 110-1 `13f` 拆分之后」 | 110 已全收：`13f-native-tool-schemas.js` 在树上，13 族已拆成 `13b`–`13t` 共 19 件 |
| `makeAttachmentRecord` 在 `04-permission-runtime.js:1-27` | 现 `:10-36`。文本白名单 19 个扩展名（`txt|md|json|js|ts|…|log`），**无音频类**；`textPreview` 仅当 ≤256 KB 且命中白名单 |
| 附件上传在 `13-http-router.js:1136` | 现 `:1508` |

### 1.2 `caps` 这个词在本仓已经被占用了 —— 同名不同物

26 号文要给 `models[]` 加的是 **模型能力标签** `caps:['asr']`。但今天树上 `caps` 已经是**另一样东西**：`getCapabilities()` 返回的**运行环境能力矩阵**，贯穿 `toolRequirementsMet(toolName, caps, …)`（`06:38`）、`evalPlaybookAvailability(pb, caps)`（`06:891`），取值域是 `PLAYBOOK_REQUIRES = ['network','desktopMcp','vision']`（`06:822`）。

两者语义正交（一个说「这个模型会什么」，一个说「这台机器有什么」），但**同名**。读代码的人最容易在这种地方栽 —— 施工时字段就叫 `models[].caps`（26 号文冻结边界的原词，不改），但**必须在 normalize 处留一行注释点明它与能力矩阵无关**，并让静态锁钉住这两个取值域**不许互相引用**。

### 1.3 `CONFIG_SCHEMA` 要不要 bump —— 26 号文与现仓约定正面打架

26 号文 §3 明写 114a 做 `CONFIG_SCHEMA` 11→12。但 118a 之后仓里确立了相反的约定，原话就在 `01-config.js:298-299`：

> `// Purely additive: normalizeConfig sanitizes the shape and CONFIG_SCHEMA is deliberately NOT bumped,`
> `// so an older config simply reads back null and the wizard stays available.`

实测树上仅三条迁移分支（`01:642` 的 `incomingConfigSchema < 9`、`01:1020` 的 `< 10`），处理的**全是「旧值需要被改写」**的情形。而 `models[].caps` 与 `asrProviderId`／`asrModel` **没有任何旧值要改写**：读回空数组／空串即「未配置」，正是今天的行为。→ **待拍板项 1。**

### 1.4 A 道：15 个模板确实都在，但它们不知道自己属于哪一类服务

`ruyi-workbench/resources/playbooks/` 实测 **正好 15 个**。`normalizePlaybook`（`06:827`）的字段是 `id｜title｜icon｜desc｜inputs｜promptTemplate｜requires｜engineHint｜uiMode` —— **没有服务分类**。

**而目录引擎其实全都现成**：`evalPlaybookAvailability`（`06:891`）已按能力矩阵逐条评出 `available` ＋ `unavailableReason`，`listPlaybooksWithAvailability`（`06:906`）已把内置 ∪ 用户两套并起来，`GET /api/playbooks`（`13:366`）已经吐给前端。**S01 缺的只有「分类」这一个字段与缺项模板** —— 41 号文 §5.9「不新建目录引擎、探针或模板 DSL」的裁决今天仍然成立，且比当时更省。

**逐条实盘（15/15，按 title 与 desc 判，不是按文件名猜）**：

| 六类服务 | 现成模板 | 数 |
|---|---|---|
| 研究比较 | `compare-documents`（对比两份文档）、`pdf-summarize`（多份 PDF 逐份摘要并汇总总览） | 2 |
| 资料整理 | `archive-by-content`、`batch-rename`、`clean-csv`、`clean-downloads`、`folder-inventory`、`merge-excel`、`ocr-scan` | 7 |
| 产物撰写 | `weekly-report`、`meeting-minutes`、`presentation-outline`、`translate-document` | 4 |
| **代码任务** | —— | **0** |
| **定时汇总** | —— | **0** |
| **变化守望** | —— | **0** |
| **（不属于这六类）** | `desktop-open-app`、`web-form-fill` —— 它们是**动作**，不是「完成一件事」 | 2 |

**两条比「缺项」本身更要紧的取证结论**：

1. **15 个模板全压在前三类**，后三类一个都没有。41 号文写「前四类先盘点复用」—— 实盘之下**代码任务这一类也是空的**（一个代码模板都没有），这一条与 41 号文的假设不符，**如实记下**。
2. **六类这个分法本身盖不住现有模板**：`desktop-open-app` 与 `web-form-fill` 落不进任何一类。硬塞会让分类变成谎；**推荐让分类字段可以为空**（未分类 ≠ 不可用），详见待拍板项 2。

### 1.5 B 道：无头浏览器里没有麦克风 —— 114c ① 的真实风险

全仓浏览器 e2e **各自拼启动参数**（形如 `'--headless=new','--disable-gpu','--no-first-run',…`，例 `a11y-walkthrough.browser.e2e.js:297-300`），**没有任何一件用过 `--use-fake-device-for-media-stream`**。

114c ① 的判据要真的「按下麦克风按钮 → 拿到可转写的字节」，就得先证明这对 Chromium 开关在本仓这版 Edge 的 `--headless=new` 下真的给得出可录音轨。**这件事今天没有先例，不能假设它成立。**

→ **先验已做（2026-09-16，两组对照，探针不进回归）**：

| | **A 组（对照）** 不加任何 media 开关 | **B 组** `--use-fake-device-for-media-stream` ＋ `--use-fake-ui-for-media-stream` |
|---|---|---|
| `getUserMedia({audio:true})` | **`NotFoundError: Requested device not found`** | 拿到 `Fake Default Audio Input`，`readyState=live`、`muted=false` |
| `MediaRecorder` 产出 | —— | **12000 B**，头八字节 `1a 45 df a3 9f 42 86 81`（真 WebM EBML 魔数） |
| 解码回放 | —— | 时长 **1.200 s**，**peak 1.02 / meanAbs 0.018 —— 真有信号，不是静音轨** |

**结论：先验通过，114c ① 走真麦克风判据**（§4 ⑦ 的第一种形状）。A 组同时证明了风险是真的 —— **不加开关就是拿不到设备**，所以这两个开关必须写进夹具，并配一条静态锁钉住（否则以后有人「顺手清理启动参数」就会把它清成永远红）。

**探针顺带逮到 26 号文一处半错的设计**：`MediaRecorder.isTypeSupported('audio/wav')` 在这版 Edge 上实测 **`false`**。26 号文 §3 写的「不支持 `audio/webm;codecs=opus` 时回退 `audio/wav` 经 `AudioContext`」——**回退那一半用 `MediaRecorder` 走不通**，真要 wav 得自己从 `AudioContext` 的 PCM 手工封 WAV 头。而实测 `audio/webm;codecs=opus` **是支持的**（A、B 两组都 `true`）。→ **本波按「webm/opus 为唯一录制格式、不支持就不渲染麦克风按钮」实现**，不写一条跑不通的回退路径。

### 1.6 26 号文威胁模型里那套「与 `baseUrl` 相同的 URL 校验」**并不存在**

26 号文 §3／§4 两处都写：`audioBaseUrl` 必须通过与 provider `baseUrl` **相同的 URL 校验**（协议白名单、禁私网除本地 shim、禁凭据内嵌）。**实读之下，`baseUrl` 今天没有任何这样的校验**：

- `sanitizeProvider`（`05:1154`）对 `baseUrl` 只做 `trim` ＋ 长度截到 400，**不解析、不查协议、不查主机**。
- 全仓唯一对 provider 主机做词法判断的是 `providerIsLocal`（`03:478`），而它的用途是**放宽**工作区外读文件的闸（本机模型不会把文件外传），**不是**一道准入校验。
- 而且内置预设 `ollama`／`lmstudio` 的 `baseUrl` 本来就是 `http://127.0.0.1:…` —— **私网不但没禁，还是出厂配置**。

**结论**：「与 `baseUrl` 相同的校验」＝**没有校验**。本波按这条实情办：`audioBaseUrl` 与 `baseUrl` **同等对待**（用户自己配的端点，工作台不替他判断），**不在本波凭空发明一道 provider 级 URL 准入** —— 那是独立的安全决定，会顺带改掉现有本机预设的行为，远超「加个语音端点」的范围。**如实记进 107 的 Release Brief「未完成项」**：ASR 出网面与主 provider 出网面共享同一条（不存在的）校验，要收紧就得两条一起收。

### 1.7 会被顶动的计数锁（提前登记，免得第四次被自己的锁拦住）

| 锁 | 现值 | 本波会怎么动 |
|---|---|---|
| `facts.json.nativeTools` ＋ README 两处措辞 | 96 | `audio_transcribe` → **97** |
| `facts.json.e2eCount` | 356 | 每加一件 `*.e2e.js` 都动 |
| `i18n.static.e2e.js:149` `skills.builtin.*` 键数 | 96（＝48 条记录 × 名称/描述） | **新增 playbook 就动**（每条 +2） |
| `route-inventory.js` 判定点 | —— | `POST /api/audio/transcribe` 必重算 |
| 原生工具四处登记 | —— | `13f` схема／`12` 派发／`13m` act 白名单／能力身份守卫（**漏 `13m` 已犯过三次**，已有机械锁 ①e） |

## 2. 切片与出门序

| 序 | 刀 | 道 | 为什么排这儿 |
|---|---|---|---|
| ① | **B-114a** 配置与模型能力标签（未配置时零行为） | B | 地基：`models[].caps` ＋ `asrProviderId`／`asrModel` ＋ 设置页选择器；②④⑤⑦ 全依赖它 |
| ② | **B-114b** 转写端点与零依赖 multipart | B | 全波**唯一出网面**，威胁模型集中在这一刀（26 号文 §4）；假 ASR 桩也在这刀立起来 |
| ③ | **A-S01** 服务分类字段 ＋ 六类映射 ＋ 缺项模板 | A | **不依赖 B 道任何东西**，排在 ② 的回归跑着时并行推进 |
| ④ | **B-114c-②** 音频附件转写（＋围栏中和） | B | 吃附件管线，与 ⑤⑦ 文件零重叠 |
| ⑤ | **B-114c-③** `audio_transcribe` 原生工具 | B | 吃工具注册表四处登记，独立一刀 |
| ⑥ | **A-S02** 自然语言进入不超过一次配置引导 | A | 依赖 ③ 的分类字段才有「进入哪一类」可言 |
| ⑦ | **B-114c-①** composer 麦克风回填 | B | **判据形状取决于 §1.5 先验结论**，排最后 |
| ⑧ | **A-F01** 服务状态（可用／需配置／不可用／**未知**）与离线降级文案 | A | 收口：把 ③⑥ 的分类与既有 `available` 合成用户看得懂的一句话 |

**114c 为什么拆成 ④⑤⑦ 三刀**：26 号文把三入口写成一个切片，但它们**吃三套完全不同的文件**（附件管线／工具注册表／前端 composer）。捏成一刀，回归一红就分不清是谁 —— 这正是 125 波「一刀只动一件事」那条纪律的由来。

**114d（本地 shim）／114e（桌面壳麦克风权限）不在本波**：43 号文 §2 已后置到 128+，理由是云端 ASR provider 就够跑通「语音能用」。

## 2-bis. 用户真机走查带进来的一刀（2026-09-16）：**永久豁免把 `shell_send` 误判成「对外发送」**

> **用户触发**：真机上「A 股盘中巡检」线程连着卡在放行上，管家的原话是「这类动作在永久豁免清单里 —— 不管线程自己是什么档位，都得你亲自按一下」。用户问：**「管家的批准权限这一点，后续有规划吗，当前似乎有特定的还是老是问」**。

### 取证：截图里那两条卡顿**不是同一回事，一条是 bug、一条才是设计**

**① `shell_send` 那条 —— 判据写宽了。** 永久豁免的工具名判据（`06i-steward-core.js:260`）是**裸子串、无词边界**的交替：

```
/send|mail|sms|post_message|pay|purchase|transfer|uninstall|install|registry|system_setting|shutdown|format|mcp_configure/i
```

实测（把真实工具名逐个喂给它）：

| 工具 | 结果 |
|---|---|
| `shell_send` | **命中永久豁免** —— 只因为名字里有 `send` |
| `keyboard_send_keys` | **命中永久豁免** —— 同样躺枪 |
| `powershell_run`／`run_command`／`script_run`／`file_write`／`http_request` | **都不命中** |

**判据的本意写在它自己的注释里**：「对外发送(send/mail/sms/post_message)、支付与交易、安装卸载、系统设置与注册表、关机与格式化」。而 `shell_send` 是**往一个已经在跑的本机 shell 里递一行字**，不是「以用户身份对外发帖／发邮件」。**荒唐点在于方向反了**：`run_command`（直接起一条命令）不命中，`shell_send`（往已有 shell 递一行）反而命中。

**② PowerShell 那条 —— 按设计工作。** 它走的是另一条路：**命令正文扫描**（`STEWARD_EXEMPT_CONTENT_PATTERNS`，21 条正则，`06i:266`）。这是 116-3 一次对抗审查专门补的 —— 只看工具名的话，全自动线程里 `rm -rf`／`winget uninstall`／`git push` 一条都不命中。**这一条不动。**

**③ 顺带暴露的第三个缺口**：管家在真机上说「命令原文我这边看不到」—— 命中内容判据时，**它讲不出是哪一条规则咬的**，用户只能自己去线程里看。

### 规划归属：**按现有规划这件事永远不会好**

31 号文七轴放权的四条红线第一条就把永久豁免排除在放权之外（§1、§2.3 的红线行）。**所以「等放权那一波做完就不问了」是等不到的** —— 这条不是放权范围里的一格，是**判据本身写错了**，该按 bug 修，不该等 31 号文第二批。

### 这一刀做什么（三处，第 2 处是前提）

1. **工具名判据收紧**：从裸子串改成钉住**真正对外发送**的那几个整词，把 `shell_send`／`keyboard_send_keys` 放出来。
2. **（前提，先做先验）先证明内容扫描真的拿得到 `shell_send` 的 `input`。** 管家在真机上说「命令原文我这边看不到」，这暗示 `input` 未必总是传到判据手里（`13g stewardImplDecide` 按 tier 决定传不传）。**如果内容扫描根本没收到那行命令，那放开工具名判据就是开了个洞** —— 必须先拿一条 `shell_send` 带 `rm -rf` 的真夹具**验红**（现在应当被内容判据拦住），验不红就**只做第 3 处、不动第 1 处**，并如实记下理由。
3. **命中原因说得出来**：内容判据命中时，把**是哪一类**（删数据／改系统／装卸载／对外发送／git push）带进 `propose_required` 的 `message`，用户不必自己去翻。

### 可证伪判据与反向

- **判据**：① `shell_send`／`keyboard_send_keys` 在 auto 档不再恒 `propose_required`；② **同一个 `shell_send`，`input` 里带 `rm -rf` 时仍然 `propose_required`**（这一条是第 1 处的安全网，必须与 ① 同时绿）；③ 真正对外发送的工具名在任何档位仍恒 `propose_required`；④ 内容判据命中时 `message` 含类别名。
- **反向**：㈠ 把第 1 处改完但**故意不验第 2 处** → ② 应当红（若不红，说明内容扫描压根没收到 input，**这正是本刀最该逮住的东西**）；㈡ 把类别名从 `message` 里摘掉 → ④ 红。
- **纪律不变**：这张清单的口径是「**宁可误判成「要人按」，不可漏判成「自动执行」**」（注释原话，**它的失守没有 checkpoint 可回滚**）。第 1 处是**在证明另一道闸接得住之后**才收窄，不是因为嫌它烦。

## 3. 独占文件与「绝不碰」

| | A 道吃 | B 道吃 |
|---|---|---|
| **独占** | `resources/playbooks/*.json`、`06-provider-engine.js` 的 `normalizePlaybook`／`listPlaybooksWithAvailability`、playbook 前端面、两份 locale 的 playbook 键 | `01-config.js`／`01c-runtime-flags.js`、新端点（`13b-api-domain-routes.js`）、`03-bridge-guard.js` 的 `buildAttachmentPrompt`、`04-permission-runtime.js` 的 `makeAttachmentRecord`、`11-native-tools.js`／`12-tool-dispatch.js`／`13f`、composer 前端 |
| **绝不碰** | ASR、附件管线、`01-config.js` | playbook、能力矩阵、`06-provider-engine.js` |

**唯一的理论交集是 `06-provider-engine.js`**（A 道要改 `normalizePlaybook`）。**判给 A 道**：B 道全程不碰它 —— `models[].caps` 落在 `01-config.js` 的 provider 规范化里，不在 provider-engine。

**与 126 波的交集为零**：本波不碰 `10-context-governance.js`、不碰管家记忆库。

## 4. 可证伪判据与反向（每一刀至少一条真反向）

- **① 114a**：未配置时**逐字节零变化** —— 提示词快照、`GET /api/status`、路由清册、设置页 DOM 三处快照断言；`caps` 白名单只认 `asr`／`embedding`，未知值静默丢弃且去重。
  **反向**：把白名单去掉 → 夹具里塞 `caps:['asr','rm -rf']` 应当红并打出实得数组。
- **② 114b**：鉴权 401／未配置 409／超限 413（25 MB，**早于** 128 MB 总闸）／成功 200／上游 5xx 走统一信封；记账落一条 `kind:'aux', note:'asr'`，上游无 usage 时 `estimated:true`；`audioBaseUrl` 过与 `baseUrl` **同一套** URL 校验。
  **反向**：把 25 MB 闸改成晚于总闸 → 24.9 MB 与 26 MB 两个夹具的返回码互换，红。**再一条**：让 `audioBaseUrl` 绕过 URL 校验 → 私网地址夹具应当红。
- **③ S01**：`GET /api/playbooks` 每条带 `service`；六类计数与 §1.4 实盘表**逐条相同**；未分类的两条 `service` 为空**且 `available` 不受影响**。
  **反向**：把 `service` 的枚举钳制摘掉 → 夹具里写 `service:'编造的一类'` 应当红。
- **④ 114c-②**：音频附件转写后进提示词必须**带围栏且经尖括号中和**（`<attachment kind="audio-transcript" untrusted>`）；原文件仍可下载。
  **反向**：摘掉中和 → 音频转写文本里含 `</attachment>` 的夹具应当红（这是 26 号文 §1 点名的「`buildAttachmentPrompt` 未做同款中和」那个现成缺口，本刀顺带补齐）。
- **⑤ 114c-③**：`audio_transcribe` 四处登记齐全（schema／派发／`13m` act 白名单／身份守卫）；tier `exec`、pack `files_read`；返回值标 `untrusted:true`。
  **反向**：抽掉 `13m` 那一处 → 既有机械锁 ①e 应当红并点名（**这条锁本身就是为「管家提了按钮、按下去 not_allowed」立的，第四次验它**）。
- **⑥ S02**：从自然语言进入一条可用服务，**必要配置引导 ≤1 次**（计数断言，不是文案断言）；不可用服务**不出现成功承诺**（扫返回文案中的承诺词）。
  **反向**：把引导计数上限提到 2 → 断言应当红并打出实得次数。
- **⑦ 114c-①**（**§1.5 先验已通过，走真麦克风形状**）：真浏览器件——点麦克风 → 录 ≥1 s → 停 → 拿到非空 webm/opus 字节 → 回填到**光标处** → **不自动发送**（发送计数为 0）；录音态可键盘到达、`aria-live` 有播报、双主题、390 px。夹具启动参数必须带 `--use-fake-device-for-media-stream` ＋ `--use-fake-ui-for-media-stream`，**并配一条静态锁钉住这两个开关**（A 组实证：不加就是 `NotFoundError`，以后谁「顺手清理启动参数」都会把它清成永远红）。
  **反向**：① 把「不自动发送」改成自动发送 → 发送计数断言红；② 从启动参数里拿掉那两个开关 → 静态锁红并点名该件。
- **⑧ F01**：能力**未知**时如实显示「未知」，**不得**通过文案映射升级成「已验证可用」（41 号文 §5.9 原话）。
  **反向**：把未知态并进可用态 → 夹具里能力探针返回 `undefined` 时应当红。

## 5. 每一刀出门的固定动作

沿 32 号文 §4 与 44 号文 §5：`build --check`／依赖图 `--check`／`--fast`／控制字符扫描；**`src/` 有改动就整条生成器链重跑**（`module-dependency-graph.js --write` → `build.js` → 文件数变了才 `facts-generate.js` → `route-inventory.js`）。一机一回归（纪律 14）、新 e2e 首行 `self-isolate-home`（纪律 15）、补丁不走 heredoc（纪律 7）、**每一刀至少一条真对抗反向**（改源码→确认红→按 sha256 逐字节还原）。

**本波多三条**：
- **新路由 ⇒ `route-inventory.js` 必重算**（②）。
- **新原生工具 ⇒ 四处登记 ＋ `facts-generate.js`（96→97）＋ README 两处措辞**（⑤）。
- **新 playbook ⇒ `i18n.static` 那把 96 键锁会动**（③，每条 +2）。

## 6. 四件要拍板的（**推荐已写在括号里，不回也按推荐走**）

1. **`CONFIG_SCHEMA` 要不要 11→12** —— 推荐 **不 bump**。26 号文写于 118a 之前；今天的约定是「纯增量 ＋ `normalizeConfig` 消毒 ⇒ 故意不 bump」（`01:298`），而三条既有迁移分支处理的都是「旧值要改写」，`caps`／`asrProviderId` 没有旧值要改写，bump 反而要凭空写一条什么也不做的迁移分支。**代价**：与 26 号文原文不一致 —— 本文 §1.3 已写明是**显式改判**，不是漏读。
2. **服务分类落在哪一侧** —— 推荐 **playbook JSON 加一个被枚举钳制的 `service` 字段**（六类白名单 ＋ 空），内置 15 个各填一个（两个动作类留空），用户 playbook 可选。理由：不新建目录引擎（41 号文裁决），只多一个与 `requires` 同模具的白名单字段；服务端一张 id→类映射表反而会让用户自己的 playbook 永远没有分类。**允许为空**是关键 —— §1.4 已实证六类盖不住现有模板，硬塞会让分类变成谎。
3. **代码任务／定时汇总／变化守望三类空缺怎么补** —— 推荐 **本波只补「定时汇总」一个模板，另两类如实标「暂无模板」**。理由：定时汇总的运行基座（123 波调度器）**已经落地**，补一个模板就能跑通一条完整成功路径；而「变化守望」缺的是守望基座（41 号文写明依赖 119），「代码任务」摊子最大（一个像样的代码模板要绑工作区权限与工具族）——两类都不是「填个 JSON」能了的，**硬补出来的模板跑不通，比空着更坏**。
4. **麦克风先验若不通过** —— 推荐 **按 §4 ⑦ 的降级形状出门，并在交付记录里写明「这一件没有真麦克风覆盖」**。理由：纪律 13 要的是「前端 JS 必须有真浏览器件」，不是「必须有真硬件」；假装有覆盖比承认没有更危险。**备选**（不推荐）：把 ⑦ 整刀推到 128+ —— 但那样 127 波的用户故事（「能开口说」）就断在半路。

## 7. 下一个 agent 从这里进（① 114a 的落点已摸好，别重摸）

**本波零 `src/` 改动，工作从 ① 开始。** 下面是 2026-09-16 已实读的落点与可照抄的模具：

| 要做的 | 落点 | 照哪个现成模具 |
|---|---|---|
| `models[].caps` | `sanitizeProvider`（`05-claude-engine.js:1154`）里 `models` 那段 map（`:1159-1164`），条目今天是 `{id,label}` | **`hiddenModels`（`05:1169`）与 `pricing`（`05:1211`）那个「可加不加」模具**：`...(caps.length ? { caps } : {})` —— 空就不落字段，**存量 `config.json` 逐字节零漂移**。注释里两处都写明了这个理由，照抄 |
| `caps` 白名单 | 与 `PROVIDER_REASONING_EFFORTS`（`05:1143`）并排放一个 `PROVIDER_MODEL_CAPS = new Set(['asr','embedding'])` | 同文件同款：**一张表被规范化与请求构造共用**，注释原话「Keep this allowlist shared by…」 |
| `audioBaseUrl` | 同 `sanitizeProvider`，与 `baseUrl`／`extraBaseUrls`（`:1192`）并排 | **按 §1.6 的实情：与 `baseUrl` 同等对待**（`trim` ＋ 截 400），**不发明新校验** |
| `localCommand` | **本波不加** —— 它唯一的消费方是 114d，43 号文 §2 已后置到 128+。加一个没人读的持久字段违反 124 波留下的纪律（35 号文 §2 退出门）。**这是显式收窄，不是漏做** | —— |
| `asrProviderId`／`asrModel` | `01-config.js` 默认值区（`:79-80` `activeProvider`／`providers` 那一段旁），清洗放 `:703` 那个 providers 块之后 | `compactProviderId` 的「provider 没了也保留，不静默改用户的选择」（`01:915-921`）——ASR 选择该用同一口径 |
| 未配置＝不可见 | 无开关。判据＝`asrProviderId` 与 `asrModel` 皆非空 | 26 号文冻结边界原话；**不要**为它新造 `runtime*V1` 开关 |

**三个已实测的数字**（别再重数）：`CONFIG_SCHEMA=11`（`00-boot.js:32`）、`facts.json.nativeTools=96`、`i18n.static.e2e.js:149` 钉着 `skills.builtin.*` 共 96 键。

**麦克风先验的复现方式**（探针是一次性的，不在仓里，但读数在 §1.5）：起一个 `127.0.0.1` 的页面（`file://` 不是安全上下文，`getUserMedia` 会直接拒），Edge 启动参数在常规无头那套之外加 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`，页面里 `getUserMedia({audio:true})` → `MediaRecorder('audio/webm;codecs=opus')` 录 1.2 s。**对照组（不加开关）必须跑**，它是 `NotFoundError`——没有对照组就证明不了那两个开关是承重的。

## 8. 交付记录

（每一刀出门后按 44 号文 §7 的格式补：今天的毛病 → 与派单稿不同之处 → 判据读数 → 反向 → 生成器链与门。）

### ① B-114a · 配置与模型能力标签（2026-09-16）

**改了什么**（未配置时零行为）：

- `05-claude-engine.js`：`PROVIDER_MODEL_CAPS = new Set(['asr','embedding'])`＋`providerModelCaps()`（白名单外静默丢弃、小写归一、去重、保序）；`models[]` 归一化挂上 `...(caps.length ? { caps } : {})`（空不落字段）；`audioBaseUrl` 与 `baseUrl` 同待遇（trim＋截 400，**不发明 URL 校验**——§1.6 的实情）。`localCommand` 按 §7 显式不加（唯一消费方 114d 已后置 128+）。
- `01-config.js`：`asrProviderId`／`asrModel` 默认值两空＋清洗（trim＋截 400；provider 没了两个一起清成「未配置」，与 `compactProviderId` 同口径，不静默改指别的端点）。`CONFIG_SCHEMA` **不 bump**（§6.1 拍板①的推荐：纯增量＋normalize 消毒，无旧值要改写）。
- 设置页「语音识别」选择器（§2 ① 的地基清单含它，§7 落点表只摸了后端）：**零静态标记**，`provider-settings.js` 纯 JS 动态渲染——只列 `caps` 含 `asr` 的模型，**一个候选都没有就连节点都不建**（未配置＝不可见不是「藏起来」，是「结构上不存在」，存量配置的设置页 DOM 因此逐字节零变化，不需要任何快照豁免）。选中即存 `saveConfigPartial` 部分补丁（`compactProviderId` 选择器同模具）；候选里没了当初那一对时如实回落「不启用」。双语各 6 键，运行时与 `docs/i18n/locales/` 文档源同步。
- `06i-steward-core.js`：`asrProviderId`／`asrModel` 经 `steward-config-tier` 机械锁拦下要求显式分级——判 **confirm**（它决定【用户的声音】送去哪个端点转写＝改道语音数据＋每次转写都花钱记 aux，与 `compactProviderId`/`compactModel` 同族；不放 forbidden——经用户亲手确认后让管家把语音配上是正当诉求）。这是 §1.7 五把锁之外实际顶动的第六把，补登记在此。

**与派单稿（26 号文）不同的两处，逐条给理由**：

1. **`workbench_self_status` config 段与 `GET /api/status` asr 摘要本刀没做**（26 号文 §3 列了，45 号文 §2 ① 地基清单与 §7 落点表都不含）。选择器要的数据（`providers[].models[].caps`＋`asrProviderId`/`asrModel`）本来就随 `/api/status` 的 config 下发，单独立一份摘要是重复事实源；self-status 段等 ② 的端点真有了运行态可报再补。**显式收窄，不是漏做。**
2. **`CONFIG_SCHEMA` 11→12 不做**（§6.1 已对 26 号文显式改判），并由新静态锁把 `= 11` 钉死——以后谁 bump 都得先回来读文档。

**判据读数**：

- `failover.e2e.js` 并入（C）（D）（E）（F）共 9 条：`caps:['asr','rm -rf','ASR','embedding','','vision',123,'asr']` → 实得 `["asr","embedding"]`；字符串/无 caps 条目不落字段；`audioBaseUrl` trim＋截 400＋缺省不落字段；asr 选择 trim 后保留、provider 没了两个一起清空、缺省两空；存量 provider 形状零新增字段。
- 新静态锁 `dev-harness/asr-config-ui.static.e2e.js`：两个 caps 取值域不相交且互不引用（06 连 `'asr'` 字面量都不许有；05 只允许那行 §1.2 点名的隔离注释提到 `PLAYBOOK_REQUIRES` 一次——第一版锁写宽成「05 不许出现」被自己的注释当场咬到，收紧成「注释可点名一次、代码不许引用」）；`CONFIG_SCHEMA=11`；后端三处落点锚；前端五处落点锚；双语 6 键；index.html 零静态 asr 标记；`provider-settings.js` 零控制字符。
- 零行为三处：prompt-snapshot（--fast 内含）、`config-read-safety`（/api/status 读路）、`dom-smoke`＋`dom-contract`（DOM）全绿，无需改一处既有断言。
- `steward-config-tier` 全键矩阵复绿（新增两键已显式分级）。

**纪律 7 第六个样本**：选择器分隔符照 `compactProviderId` 模具用 `\u001f`，第一版被补丁传输层落成**裸 0x1F** 进源码（`cat -A` 现形 `^_`）。按 32 号文 §16-bis 修法改 `String.fromCharCode(31)` 构造（源码零控制字符、零转义序列），静态锁钉住这个构造方式。

**反向一处（§4 ① 指定形状）**：摘掉 `PROVIDER_MODEL_CAPS.has(s)` → `failover.e2e` (C) 当场红并打出实得数组 `["asr","rm -rf","embedding","vision"]`——**连能力矩阵那域的 `'vision'` 也一并漏进**，顺手实证了 §1.2 域隔离不是摆设。还原经 sha256 逐字节校验（`4822665d…` OK）后双绿。（插曲：`git checkout --` 还原的是 HEAD 不是工作区，一度把整刀的 05 改动抹掉，按对话里的原始编辑逐字节重做后 sha256 才对上——教训：反向还原前先确认基准是哪一个。）

**生成器链与门**：`module-dependency-graph --write`（53 模块／420 边／1 SCC）→ `build.js`（54193 行）→ `facts-generate.js`（e2eCount 356→357，README 四处口径 356→357／349→350）→ `route-inventory.js`（135 判定点，告警 0，仅时间戳动——本刀零新路由）。`build --check` ✓、依赖图 `--check` ✓、`--fast` **73/73**（新锁第 5 位跑进默认道）、行为件九件（failover／i18n／i18n.static／facts.static／config-read-safety／workbench-self-status／provider-custom-headers／perf-config-cache／dom-smoke／ia／steward-config-tier）全绿。控制字符扫描 20 个改动文件 **0**；U+FFFD 扫描仅 HEAD 既有的一处故意字面（GBK 解码注释里的示例），本刀新增为零。

**全量回归（①）**：**350 pass / 0 fail / 1 flaky / 350 ran（7 skipped 为既有 live probe），真回归 0**。唯一 flaky 是 `steward-conversation.e2e.js`（首跑红在 G4「线程回退到递话前」，重跑绿）——管家族递话/回退时序族，与本刀的配置归一化与设置页选择器路径零交集；如实登记，不归功于也不归咎于本刀。


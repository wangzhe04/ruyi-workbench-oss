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

## 2-ter. 用户真机走查带进来的第二刀（2026-09-16）：**定时任务把线程的属性丢了**

> **用户触发**：14:00 的定时巡检「没触发」—— 实际是**触发了但卡在等锁**（同一个工作文件夹被另一条线程占着）。用户随后要求「指定用 DeepSeek 跑定时任务」，管家答做不到。用户提了两问：**「① 管家应该要能有在开线程时指派模型的能力；② 为啥不能同时开多条 Kimi CLI 的线程并行跑」**。只读排查结论如下 —— **两问同源，而且第二问跟 Kimi 无关**。

### 取证 ①：指派模型的能力**线程工具早就有，定时任务这条路没接上**

`steward_thread_new` 有档位参数（`13f-native-tool-schemas.js:782`）：`tier: enum ['strong','fast']`，缺省 `strong`。它落到 `stewardApplyThreadTier`（`13q-steward-runner-turn.js:575`）→ 读 `config.stewardThreadModels[strong|fast]` 拿 `{providerId, model}` → 写**会话级 `engineRoute`**，且**写死 `engine:'openai'`** —— 也就是说**选档会把这条线程切到原生 provider 引擎上，不跟全局那个 Agent CLI 驱动走**。

**所以「让某条线程用 DeepSeek 而不动全局」今天是做得到的**：把 strong（或 fast）那一档指到 DeepSeek provider，管家开线程时选那一档即可。管家说「那张表我连读都读不到」也属实 —— `stewardThreadModels` 不在它可写键里，这是 [31 号文](31-steward-empowerment.md) 红线 2 的有意安排，**不要改**。

**断点在定时任务**：`steward_schedule_create` 的参数只有 `title／schedule／payload／target／permissionMode／basis` —— **有权限档、没有模型档**；触发时 `13s-scheduler.js:462` 直接 `createSession({title, origin:'schedule'})`，**根本不经过 `stewardApplyThreadTier`**，必然继承全局引擎。

**这不是疏漏，是排期 —— 而且点名的就是本波**。调度器自己的代码写着：

```js
// 06j-scheduler-core.js:532
// ③ 目标。**本刀不接受 cwd / engineRoute**:cwd 在禁止键表里(绕过工作区表的唯一入口),
// engineRoute 留给 127 波。新线程的工作目录由 createSession 的既有回落决定(defaultWorkspace)。
```

同文件 `:43` 还有一条：`SCHEDULER_PAYLOAD_KINDS = ['reminder','prompt']  // playbook/workflow → 127 波`。**123 波做调度器时就把这两件事留给了 127**。

### 取证 ②：并行卡的是**按工作文件夹的写互斥**，与引擎无关

`05b-kimi-bridge.js` 里**没有任何并发限制**（grep 零命中）。真正卡住的是仲裁器的锁，资源名 `cwd-write:<hash>`（`13n-steward-arbiter.js:93`）：路径 `realpath` 归一 → Windows 折大小写 → sha1 前 12 位。**同一个真实目录 = 同一把锁，跟用哪个引擎完全无关。**

两条设计把它放大了，**都写在注释里**：

1. **每一个回合都按「写」处理**（`13n:182`）：「一个回合会不会写文件在开始时无法预知（模型还没说话），按只读乐观放行的代价是两条线程真的一起改同一棵树。**只读回合的识别与放宽留后续波**。」→ 纯巡检回合一个字不写，照样占锁。
2. **定时任务开的线程全落在同一个文件夹**：`06j:532` 那句「工作目录由 createSession 的既有回落决定（**defaultWorkspace**）」，而定时任务**不接受 `cwd`**（禁止键，安全上是有意的）。→ **所有定时任务天然互抢同一把锁**，还要跟任何一条也在 defaultWorkspace 的手工线程抢。

**结论**：多条 Kimi CLI 线程**可以真并行**（上限 `stewardMaxParallelThreads`，默认 5、可调到 32，`01-config.js:383`），**前提是它们在不同的工作文件夹**。用户撞上的是「都在默认文件夹」这一个具体原因。

### 这一刀做什么（两处进本波，第三处记债）

| | 做什么 | 为什么归这儿 |
|---|---|---|
| **S-a** | `steward_schedule_create`／`_update` 补 `tier`（与 `steward_thread_new` **同一个枚举、同一个 `stewardApplyThreadTier`**，不新造第二条通路）；`13s` 触发分支在 `createSession` 之后套用它 | `06j:532` 点名的那件事，模具现成 |
| **S-b** | 定时任务的工作目录：**照搬 `steward_thread_new` 省略 `cwd` 时的既有行为** —— 在 Ruyi 根下按标题给这条任务开自己的文件夹并加进工作区候选表。**不开放自由填 `cwd`**（那道禁止键是安全线，保留） | 直接解掉「等锁」，且不碰安全边界 |
| **S-c** | **只读回合放宽锁** —— **不进本波，记债**。要先能判定一个回合会不会写（模型还没说话时判不准），收益也最不确定；S-a／S-b 落地后这条大概率不急 | `13n:182` 自己写着「留后续波」 |

### 可证伪判据与反向

- **S-a**：① 带 `tier:'fast'` 的定时任务触发后，那条线程的 `session.engineRoute` 与手工 `steward_thread_new({tier:'fast'})` **逐字段相同**；② 该档没配时**跟随全局**且落一条 `steward_thread_model_fallback` 审计（与既有行为同）；③ 不传 `tier` 时**与今天逐字节等价**。
  **反向**：在 `13s` 触发分支里摘掉套用 → ① 红并打出实得 `engineRoute`。
- **S-b**：① 两条定时任务**同时到点**，各自拿到不同的 `cwdKey`，**都能跑**（不再是一条等锁）；② 新目录进了工作区候选表；③ `target` 仍然**拒收** `cwd`（禁止键不变）。
  **反向**：让两条任务共用 defaultWorkspace → ① 红并报出 `等锁：同一个文件夹被「…」占着`（**这一条同时证明判据咬的是锁，不是别的**）。
- **纪律**：S-b **不得**顺手放开 `cwd` 入参。`06j:532` 写明它是「绕过工作区表的唯一入口」—— 解锁问题用「自动给个新文件夹」，不用「让模型自己填路径」。

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

### ② B-114b · 转写端点与零依赖 multipart（2026-09-16）

**改了什么**（全波唯一出网面）：

- `POST /api/audio/transcribe`（ROUTE_AUTH `token` 级，不给 token-browser——用户音频字节出网，与 `/api/steward/*` 同一档）落 `13b-api-domain-routes.js` 的 `handleAudioApiRoutes`，委派行在 `13-http-router.js` steer 之后（13→13b 既有边，**依赖图 53 模块 420 边零新增**）。
- 入站：`Content-Type: audio/*` raw body（否则 400 `asr.content_type`），query `filename`（纯 basename 清洗，穿越形态回落 `audio.<按 content-type 的扩展名>`）／`language`（截 40）／`prompt?`（截 4000）；**25 MB 专用闸（`ASR_MAX_BODY_BYTES`，00-boot 与 128 MB 总闸并排）Content-Length 预检＋流式累计双道**，超限 413 `asr.too_large`（`maxBytes` 入 params）。
- 出站：Node 内置 `FormData`＋`Blob` 拼 multipart 到 `providerBaseWithV1(audioBaseUrl || baseUrl) + '/audio/transcriptions'`（`model=asrModel`、`response_format=json`、可选 language/prompt、file 字段带清洗后文件名），`Authorization: Bearer`（有 key 才发）＋ provider `extraHeaders`，`AbortSignal.timeout(120s)`。
- 返回 `{ ok, text, language?, durationMs, providerId, model, estimated }`；未配置/服务商失踪 409，空体 400，上游不可达/超时 502 `asr.upstream_unreachable`，上游非 2xx 502 `asr.upstream`（`params.status` 带上游码，回显消毒裁 1000），上游缺 text 字段 502 `asr.bad_response`。
- 记账 `kind:'aux', note:'asr'`：上游带 usage 用真值；否则 `inTok=ceil(字节/1024)`、`outTok=ceil(文本长/4)` 保守估算并 `estimated:true`——估算同时保证这条支出不被 `appendUsageLedger` 的零 token 跳行规则吃掉（那规则会静默丢掉「花了钱但无 usage」的 aux 调用）。`costTrusted = cost != null`（无定价时 tokens-only、`cost:null`，照 Claude 未定价先例）。

**与派单稿不同的三处，逐条给理由**：

1. **判据里的「鉴权 401」落地为 403。** 仓里 token 级鉴权失败一律 `apiFailure('auth.token_invalid', …, 403)`（`handleApi` 顶部 `authorizeRoute` 块，全 ROUTE_AUTH 表同一个码）；为新路由单独立 401 反而破统一信封。e2e 断言 403＋`auth.token_invalid`，此条在此显式改判。
2. **§4 ② 第二条反向（「audioBaseUrl 绕过 URL 校验 → 私网红」）不适用**，§1.6 已实证那套「与 baseUrl 相同的 URL 校验」不存在——同等对待＝无准入，没有可绕过的闸。替代反向取「摘掉 `estimated` 标记 → 记账断言红」（见下）。
3. **判定点形状踩了一次路由清册扫描器**：handler 第一版写成 `pathname !== '...' return false` 反向 guard，`route-inventory.js` 只认 `pathname === '...'` 肯定形，当场报「ROUTE_AUTH 死行」。拆成 `handleAudioApiRoutes`（肯定形判定点）＋`handleAudioTranscribe`（实现体）两函数。

**一次 e2e 逮住的真问题（写细，因为第一版诊断全错）**：chunked 26MB 在流式闸处拿 413 后，**下一发请求 ECONNRESET**。第一轮判成「整机 crash」（spawn 的 `exit code=1` 似乎佐证），加了 `req.on('error')` 守卫后依旧；改把 stderr 落文件才发现零异常、零日志，进程**根本没死**——`exit code=1` 是我自己的 finally 用 taskkill /F 打的（Windows 强杀就报 1）。50 行最小复现看清真相：**413 早判＋客户端续传 13MB，服务端经历一次几百毫秒级的瞬态接受停顿（内核清理在途字节），之后自己恢复**。修法治两端：服务端注释记实（不再误传「 crash」），e2e 在 E2 后钉一条 `waitForHttp`「瞬态停顿后服务恢复（不死）」——把停顿从「隐性时序坑」变成「被断言钉住的行为」。

**判据读数**（新件 `asr-transcribe.e2e.js`，24 条）：403 鉴权／409 未配置／400 非 audio/*／400 空体／200 成功（fake 回显 model/filename/字节数、language 透传、响应形状含 `estimated:true`）／502 上游 5xx 统一信封（`params.status=500`）／502 `audioBaseUrl` 指死端口证优先序（还原后 baseUrl 兜底照常）／25MB±1B 对照（200 vs 413）／chunked 无 Content-Length 26MB 流式闸 413＋恢复断言／记账行形状（`kind:aux, note:asr, estimated:true, inTok=2, cost:null, costTrusted:false`）／filename 穿越回落。

**反向两处**：① 派单稿指定形状——`ASR_MAX_BODY_BYTES` 换 `MAX_BODY_BYTES`（晚于总闸）→ E1/E2 两条从 413 变 200，红；② 摘 `estimated` 标记 → C2 记账断言红并打出 `estimated:false` 现形。两处均按 sha256 逐字节还原（`ef250a0d…` OK）后复绿。（本轮改用**文件备份还原**——上一刀 `git checkout --` 误抹未提交改动的教训已记住。）

**生成器链与门**：依赖图 `--write`（53/420/1，零新增边——新符号全落既有边）→ `build.js`（54329 行）→ `facts-generate.js`（e2eCount 357→358，README 四处 357→358／350→351）→ `route-inventory.js`（**136 判定点＝+1**，ROUTE_AUTH 124 条，告警 0）→ `architecture-contract-snapshots.js --write`（src 变了就必须重跑，--fast 第一次红的就是它）。`build --check` ✓、依赖图 `--check` ✓、`--fast` 73/73、控制字符 0、FFFD 新增为零。计数锁重钉两处：fixture-home spawn 处数 142→143（已注明来路）、README 四处口径。`fake-openai.js` 的 ASR 桩是**纯增量分支**（isAsr 才收 Buffer，其余路由零变化），其全体消费件由全量回归背书。

**全量回归（②）**：350 pass / **1 fail** / 1 flaky / 351 ran（7 skipped 为既有 live probe）。唯一 fail 是 `scheduler-ui.browser.e2e.js` B1（schedule.changed 帧后口袋角标变 1，零轮询时序断言）——本刀与该件文件零交集（调度器 SSE/口袋角标 vs 音频转写），**单跑 10 秒全绿**，按既有时序族如实登记，不归功于也不归咎于本刀；flaky 为 `walkthrough-round1.browser`（回归内重跑自复绿，亦浏览器时序族）。


### ③ A-S01 · 服务分类字段＋六类映射＋缺项模板（2026-09-16）

**改了什么**（拍板项 2／3 的推荐形）：

- `06-provider-engine.js` `normalizePlaybook`：`PLAYBOOK_SERVICES = ['research','organize','writing','coding','scheduled','watch']` 六类白名单（与 `PLAYBOOK_REQUIRES` 并排、同模具）＋ `service` 字段枚举钳制——白名单外／缺失静默丢成 `''`（未分类），每条 playbook 都带此字段。注释钉死两条裁决：**允许为空是关键**（§1.4 实盘：desktop-open-app／web-form-fill 是「动作」不是「完成一件事」，硬塞会让分类变成谎）；**未分类 ≠ 不可用**（`service` 不参与 `available` 评估）。
- 13 个既有模板各落一个 `service`，与 §1.4 实盘表逐条相同：研究比较 compare-documents／pdf-summarize（2）、资料整理 archive-by-content／batch-rename／clean-csv／clean-downloads／folder-inventory／merge-excel／ocr-scan（7）、产物撰写 weekly-report／meeting-minutes／presentation-outline／translate-document（4）。**两个动作类模板不落字段**（normalize 运行时补 `''`），desktop-open-app.json／web-form-fill.json 逐字节零漂移——与「caps 空不落字段」同一模具。
- 缺项模板 `scheduled-digest.json`（拍板项 3 只补「定时汇总」）：`service:'scheduled'`，folder＋output 两个 inputs，promptTemplate 走「按修改时间扫新改动 → 按主题归纳并注明出处 → 绝不编造 → 写 Markdown 并在对话展示」的可验收形状，挂得上 123 波调度器。coding／watch 两类如实留空（守望基座依赖 119、像样的代码模板要绑工作区权限与工具族——硬补出来跑不通，比空着更坏）。
- 前端接线：`skills-memory.js` 登记 1 组 name/desc i18n id＋2 个 input 标签键；双语 locale 各 +4 键，`docs/i18n/locales/` 文档源与运行时同步。`module-contracts.json` 补 `PLAYBOOK_SERVICES` 导出。
- e2e：`playbooks.e2e.js` 加 ⑥ 块 8 条（判据全套＋编造类钳制＋合法用户值保留，POST/DELETE 都落在隔离 HOME，收尾自清）；`i18n.static.e2e.js` 键锁 96→98（48→49 条，§1.7 已登记这把锁会动）。

**与派单稿不同的一处口径，给理由**：

- §4③「六类计数与 §1.4 实盘表**逐条相同**」落地为「§1.4 实盘表 **＋ 本刀新增定时汇总模板**」：§1.4 的 scheduled=0 是 15 模板的实盘，而 §6.3 拍板本波补一个模板——两处文字合并读，期望计数 scheduled=1（总数 15→16）。这是派单稿内部口径的合并，不是改判；e2e 注释与断言文案均写明「§1.4 实盘表 + 新增模板」。

**判据读数**（`playbooks.e2e.js` ⑥，8 条全绿）：每条带 `service`（string）；16 条 id→类映射与 §1.4＋新模板逐条相同；计数 research=2／organize=7／writing=4／scheduled=1／coding=0／watch=0／未分类=2；未分类两条 `service===''` 且 `available` 为 boolean 不受影响；`service:'编造的一类'` 被钳成 `''`（实得 `""`）；用户模板合法值 `'research'` 保留（拍板项 2：用户 playbook 可选填）。

**反向一处（§4③ 指定形状）**：摘掉枚举钳制（`PLAYBOOK_SERVICES.includes(raw.service) ? raw.service : ''` → `String(raw.service || '')`）→ ⑥ 编造类断言当场红并打出实得 `"编造的一类"` 原样穿透。按文件备份逐字节还原，06 与 server.js 双 sha256 校验 OK（`79a9c223…`／`1bed4b3b…`）后复绿。

**生成器链与门**：`module-dependency-graph --write`（53 模块／420 边／1 SCC **零新增边**；06 顶层符号 114→115，全库 2315→2316）→ `build.js`（54346 行）→ `route-inventory.js`（136 判定点不变、告警 0，仅时间戳——本刀零新路由，`POST /api/playbooks` 是既有路由）；`facts-generate.js` 不动（无新 e2e 文件，e2eCount 358 保持，facts.static 绿）；README 无 playbook 计数口径要动（「8 套模板」是工作流模板，与 playbook 无关）。`build --check` ✓、依赖图 `--check` ✓、`--fast` **73/73**、控制字符扫描 29 个改动文件 **0**、U+FFFD 新增为零。行为件十件全绿：playbooks（⑥ 全断言传动）、i18n、i18n.static（98 键锁）、i18n-en-terms、skills-registry、frontend-domains、memory-toolbox、facts.static、route-inventory.static、module-dependency-graph.static。

**插曲（如实登记）**：`playbooks.e2e.js` 与四件静态件并行首跑时，① 的 GET 在启动窗口内拿到 null 并于 `:126` 崩 TypeError；单独重跑起三连绿（含还原后一次）。`:126` 对 null 不容错直接崩是这件老件的既有脆性（崩溃点在 ① 不在 ⑥，与本刀改动零交集），不归功于也不归咎于本刀。

**全量回归（③）**：**350 pass / 1 fail / 1 flaky / 351 ran（7 skipped 为既有 live probe），真回归 0**。唯一 fail 又是 `scheduler-ui.browser.e2e.js` B1（schedule.changed 帧后口袋角标变 1，零轮询时序断言——② 的回归已登记同一条）——本刀与该件文件零交集（playbook 分类字段 vs 调度器 SSE／口袋角标），**单跑全绿（B1 在内）**，按既有时序族如实登记，不归功于也不归咎于本刀；flaky 为 `walkthrough-round2.browser`（回归内重跑自复绿，浏览器时序族）。

### ④ B-114c-② · 音频附件转写＋围栏中和（2026-09-16）

**改了什么**：

- `04-permission-runtime.js` `makeAttachmentRecord`：音频扩展名白名单（wav/mp3/m4a/webm/ogg/flac）→ `kind:'audio'`；**非音频不落此字段**（与 hiddenModels/caps「空不落字段」同模具，存量记录形状零漂移）。
- `13b-api-domain-routes.js`：② 的出站转写抽成两个共用函数——`resolveAsrProvider`（配置两空／provider 失踪两个 409 形状）与 `transcribeAudioViaProvider`（base 检查→FormData→120s 超时→回体 8KB→记账 estimated 全口径）；`handleAudioTranscribe` 瘦成纯 HTTP 壳，判定点顺序逐行不变（② 的 24 条 e2e 原样全绿背书重构零行为变化）。抽函数理由写进注释：apiKey 不出进程／超时／记账口径**抄第二份迟早分叉**。新增 `maybeTranscribeAudioAttachment`（尽力转写：**未配置零行为**——连 `transcribeError` 都不落；超 25 MB／配置缺腿／上游失败只落 `transcribeError` 代码；**绝不 throw、绝不挡上传**——文件已落盘可下载，转写是增量；`transcript` 裁 12000 同 textPreview 上限）。
- `13-http-router.js` 上传路由：`makeAttachmentRecord` 后接 `maybeTranscribeAudioAttachment`（13→13b 既有边，依赖图 420 边零新增）。
- `03-bridge-guard.js` `buildAttachmentPrompt`：textPreview 与 transcript **全量尖括号中和**（`<>`→`[]`，playbook 索引那道更严的模具），transcript 进 `<attachment kind="audio-transcript" untrusted>` 围栏（26 号文 §3 指定形状）。**这是 26 号文 §1 点名的「buildAttachmentPrompt 未做同款中和」现成缺口，本刀顺带补齐**（既补音频转写，也补既存 `<preview>` 路径）。name/path 行不需要中和——safeName 已按 `sanitizeFsSegmentName` 消掉尖括号，注释写明理由。
- **前端零改动**：record 新字段（kind/transcript/transcribeError）随既有 attachments 信道往返（app.js 整存整发、10 号 `body.attachments` 不白名单化字段）；附件丸只显 name/size，转写文本不进 UI（composer 是 ⑦ 的地界）。

**与派单稿不同的两处，逐条给理由**：

1. 26 号文 §3 只写「上传后服务端转写」，未配置／失败时的形状没写——本刀定为**尽力转写**：未配置＝零行为（与 ① 同口径，连错误字段都不落）；失败只落 `transcribeError` 代码（可观测但不挡上传、不回显上游细节）。理由：附件上传的主路径是「文件落盘可下载」，ASR 故障不该打翻它；且 26 号文 §3 自己写「原文件保留可下载」。
2. 判据「转写后进提示词必须带围栏且经尖括号中和」落地为 **record.transcript 存原文、中和发生在提示词构造时**——record 是数据不是提示词（UI 不渲染它），与 textPreview 的处理口径一致（原文存、进提示词才中和）。

**纪律 7 第七个样本**：把 ② 的出站块搬进共用函数时，上游回显消毒正则 `[\u0000-\u0008…]` 经编辑传输层落成**裸控制字节**（U+0000 进文件，Read 工具当场拒读「containing NUL bytes」）——与 ① 的 U+001F 同族。修法：一次性 node 手术脚本用 `String.fromCharCode` 构造查找串、替换回转义序列文本，验收全文件零裸控制字符后自删。**新教训：搬移含转义序列的既有代码，传输层会把转义落成裸字节——这类搬运直接上手术脚本，不走文本编辑。**

**判据读数**（`vision-loop.e2e.js` (f)，16 条新断言全绿）：

- f2：`kind:'audio'`（白名单）；`record.transcript` 存原文（含真 `</attachment>` 载荷）；音频无 textPreview；提示词带 `<attachment kind="audio-transcript" untrusted>` 指定围栏；中和后形态 `[/attachment] [script]alert(1)[/script]`；破栏序列不穿透；全文 `</attachment>` 恰好 1 处（合法闭合）。
- f1：textPreview 同款中和（`[/preview][injected]yes[/injected]`），破栏序列不穿透。
- f3：原文件经 `/api/upload/content` 逐字节取回（200＋bytes 相等）——顺带把这个既存未覆盖判定点盖进清册。
- f4：附件路径的转写也记账（`kind:'aux', note:'asr', estimated:true` ≥1 行）——与 ② 路由同一支共享出站体。
- f5：未配置零行为（kind 之外零字段）。f6：上游 5xx 不挡上传（`ok:true`、无 transcript、`transcribeError:'asr.upstream'`）。

**反向一处（§4④ 指定形状）**：摘掉中和（fence 变恒等）→ **5 条红**：f2 三条（中和缺失、破栏序列原样穿透、`</attachment>` 计数 1→2 现形）＋ f1 两条（preview 缺口）。文件备份 sha256 逐字节还原（03 与 server.js 双 OK，`b682d0a2…`／`d2fb6a42…`）后复绿。

**生成器链与门**：`module-dependency-graph --write`（53 模块／420 边／1 SCC **零新增边**；13b 顶层符号 9→12，13 引用 210→211，全库 2316→2319）→ `build.js`（54407 行）→ `route-inventory.js`（136 判定点不变、告警 0；`/api/upload/content` 的 coveredBy 从 [] → [vision-loop]，uncoveredPoints 9→8）；`facts-generate.js` 不动（无新 e2e 件，e2eCount 358 保持）；README 无口径要动。`build --check` ✓、依赖图 `--check` ✓、`--fast` **73/73**、控制字符扫描 13 个改动文件 **0**（裸字节修复后）、U+FFFD 新增为零。行为件三件全绿：vision-loop（(a)–(f) 全场景）、asr-transcribe（24 条，重构回归网）、kimi-prompt-parts。

**全量回归（④）**：**351 pass / 0 fail / 2 flaky / 351 ran（7 skipped 为既有 live probe），真回归 0**。两个 flaky 均首跑红重跑绿的既有时序族、与本刀文件零交集：`foreign-turn-busy-guard` A11（回合正文落盘时序）、`walkthrough-round2.browser` B1（管家视角启动落档，③ 已登记同件）。如实登记，不归功于也不归咎于本刀。

### ⑤ B-114c-③ · `audio_transcribe` 原生工具（2026-09-16）

**改了什么**：

- 四处代码登记（26 号文「第 49 波入库全部门」在今日的实处）：`13f` schema（`{path, language?}`，description 写明 exec tier 出网与 untrusted 语义）；`12` TOOL_HANDLERS（`paths:'read'`，guardFileToolPath 与 file_read 同闸 → 扩展名白名单 → 25 MB 闸 → 读盘 → 出站）；`07` NATIVE_TOOL_TIER `'exec'`（用户文件出网）；`07` NATIVE_TOOL_PACKS `'files_read'`。
- **共用出站体迁家（13b → 05-claude-engine）**：④ 落 13b 时路由是唯一消费方；⑤ 多了 12 工具派发这个消费方，而 12→13b 会是一条**新增前向边**，12/13b→05 都有既有边（resolveProvider／providerBaseWithV1 本就住 05）——迁过去**依赖图 420 边零新增**。函数体经一次性手术脚本逐字节搬运（含转义序列的消毒正则——纪律 7 新教训的直接应用：这类搬运不走文本编辑），13b 两个调用方零行变化，② 的 24 条 e2e 原样全绿背书零行为变化。
- 返回值 `{ok, text, language?, durationMs, providerId, model, estimated, untrusted:true}`（26 号文 §4：转写文本一律不可信）；失败一律规整 `ok:false`（not_configured／扩展名／空文件／超 25 MB／上游），越界与 file_read 同闸 `not-allowed`；记账走共享体同一支 `kind:'aux', note:'asr'`。
- **与派单稿不同的一处（显式改判，给理由）**：§4⑤ 的「`13m` act 白名单」对本工具**不适用**——`STEWARD_ACTION_HOOKS`（13m）的推导源是 `stewardToolHandler('steward_*',…)` 注册，`audio_transcribe` 不是管家工具、不经该注册点；它永不回 `propose_required`（exec tier 走 nativeToolGate 权限门，不经管家 act 按钮通道）；管家工具面按 `isStewardToolName` 过滤，「管家提了按钮、按下去 not_allowed」对本工具在结构上不存在——机械锁 ①e 的推导链（注册点 → 实现体 → propose_required → HOOKS 键）**每一环都够不到它**。「能力身份守卫」由 capabilities.e2e.js 身份钉死件保持全绿（无工具级锁要动）。**替代反向**取「抽 `NATIVE_TOOL_PACKS` 登记 → tool-dispatch L4 红」——与 ①e 同一「登记漂移」族的机械锁，验的正是本工具真实会被漏的那种登记。
- 计数锁重钉五处：facts.json 96→97（facts-generate 重算）、tool-dispatch L1（带来路注释）、workbench-self-status 两处、README 两处（96→97）、**steward-tools.static ① 总数锁 96→97**（§1.7 登记表外实际顶动的又一把，如实登记；①e 本身不动）。

**判据读数**（`tool-dispatch.e2e.js` B5，7 条新断言全绿）：未配置 → `asr.not_configured` 规整失败不抛；真实分发成功（进程内迷你 ASR 桩回显文本）；**`untrusted:true`**（§4⑤ 判据原文）；回执带 model 与 `estimated:true`；工具路径记账 `kind:aux, note:asr`；非音频扩展名规整拒；越界 `not-allowed` 与 file_read 同闸。L1/L1b 97 与 facts 同源、L4 键集一致、steward-tools.static ① 97 全绿。

**反向一处（替代形状，理由见上）**：抽 `NATIVE_TOOL_PACKS` 的 `audio_transcribe` 登记 → L4 当场红并点名 `reg-only:audio_transcribe`。文件备份 sha256 逐字节还原（07 与 server.js 双 OK，`44c3bd43…`／`c589241e…`）后复绿。

**生成器链与门**：`module-dependency-graph --write`（53 模块／420 边／1 SCC **零新增边**——迁家策略的直接收益；05 顶层符号 25→27、13b 12→10）→ `build.js`（54457 行）→ `architecture-contract-snapshots.js --write`（src 变了必跑）→ `facts-generate.js`（96→97，README 两处同步）→ `route-inventory.js`（仅时间戳——本刀零新路由）。`build --check` ✓、依赖图 `--check` ✓、`--fast` **73/73**、控制字符与 U+FFFD 扫描 17 个改动文件 **0**。行为件七件全绿：tool-dispatch（B5＋L 全锁）、asr-transcribe（24 条，迁家回归网）、vision-loop（④ 附件路径同背书）、workbench-self-status、facts.static、capabilities（身份守卫）、steward-tools.static。

**全量回归（⑤）**：**351 pass / 0 fail / 0 flaky / 351 ran（7 skipped 为既有 live probe），真回归 0、flaky 也 0**——本波目前最干净的一次。

### ⑥ A-S02 · 自然语言服务入口与一次配置引导（2026-09-16）

**改了什么**：

- `06-provider-engine.js`：`matchServiceEntry`（六类意图词表中文优先、命中词数最多者胜、零命中返回 null 零行为；状态三态 `available`／`needs_config`／`no_template`）＋ **`SERVICE_GUIDANCE_MAX = 1`**（判据计数闸，反向就提它）。`evalPlaybookAvailability` 增 **`missingCaps`** 结构化数组（纯增量——`unavailableReason` 只报第一个缺失是「卡片一行人话」的既有行为，服务引导要按【全部】缺失能力去重计数；① 模具「空不落字段」不适用此场景：available 时给空数组，形状稳定）。
- `POST /api/playbooks/service-match`（ROUTE_AUTH **token-browser**，与 GET 同档；条目排在 `/api/playbooks/` 前缀 token 规则**之前**，否则被抢先吞成 token 级）：read-only 计算，返回 `{service, playbooks(可用在前), state, guidance(≤1 结构化能力键), guidanceDropped}`。引导只带能力键，人话由前端 i18n 出。
- **技能库搜索框兼做服务入口**（41 号文 §5.9「将自然语言与既有模板入口接通」，不新建目录引擎/探针/DSL）：键入命中六类 → 列表顶部一条服务条（可用数／一次配置引导／暂无模板）；220ms 防抖、过期响应丢弃、**无匹配不建节点**（① 模具：零行为是「结构上不存在」）、清空即消失（不常驻，41 号文「不常驻占据主界面」）。双语各 13 键＋`docs/i18n/locales/` 同步；复用 `sk-reason` 既有样式，零 CSS 新增。
- e2e：`playbooks.e2e.js` ⑦ 块 13 条（判据全套＋双缺失夹具＋承诺词扫描＋403）；新件 `service-match.browser.e2e.js` 10 条（真浏览器 CDP：`#skillBtn` 真实入口开库、B1 可用条／B2 暂无模板条／B3 无关词零行为／B4 复现后清空消失）。

**与派单稿不同的三处，逐条给理由（两处是自己先踩后判）**：

1. 判据「必要配置引导 ≤1 次」落地为 **needs_config 态 guidance 数组硬顶 1 条＋`guidanceDropped` 如实带出**：可用服务本来就 0 条引导，计数的牙齿全在需配置态。「≤1」锁在数组长度上，谁改上限谁红——不是文案断言。
2. ⑦ 的 403 断言第一版写「无 token → 403」**被自己判错**：token-browser 的语义是「浏览器须 token，loopback 非浏览器须同源」（`01:2903/2917`），裸 http 无 Origin 走同源放行——改判为「带 Origin 的浏览器上下文、无 token → 403」。这是 token-browser 档在本仓的第一次实测记录。
3. 双缺失夹具第一版配 `requires:['network','desktopMcp']`，实得 `1+0`——**本机夹具 `desktopMcp.present=true`**（② 的 ocr-scan 行可证），第二个缺失根本不存在；改 `['network','vision']`（fake provider 无视觉）夹具才成立。教训写进 ⑦ 注释：凑夹具缺失，先看本机能力矩阵里真缺什么。

**判据读数**（`playbooks.e2e.js` ⑦，13 条全绿）：浏览器上下文无 token → 403；「整理下载」→ `organize/available`、引导 0 条、7 条模板可用在前；「写代码修 bug」→ `coding/needs_config`、引导硬顶 1 条 `dropped=1`（实得 `1+1 ["network"]`）；「守望变化」→ `watch/no_template`、引导 0 条（配不出不存在的模板）；无关词／单字 → `match:null`（零行为防误吸）；承诺词扫描 7 词（保证/一定能/帮你完成/可以帮你/包你/放心/确保）0 命中。浏览器件实测三态文案：「资料整理：7 个模板可直接用」「变化守望：这类还没有模板」、无关词无节点、清空消失。

**反向一处（§4⑥ 指定形状）**：`SERVICE_GUIDANCE_MAX` 1→2 → ⑦ 双缺失断言红并打出实得 `2+0 ["network","vision"]`。文件备份 sha256 逐字节还原（06 与 server.js 双 OK，`4722d834…`／`36883774…`）后复绿。

**生成器链与门**：`module-dependency-graph --write`（53 模块／420 边／1 SCC **零新增边**；06 +3 顶层符号，13→06 引用 +1 皆在既有边上）→ `build.js`（54514 行）→ `route-inventory.js`（**137 判定点（+1）**、ROUTE_AUTH 125 条、告警 0）→ `architecture-contract-snapshots.js --write` → `facts-generate.js`（e2eCount 358→359，README 四处 358→359／351→352）→ fixture-home spawn 处数 **143→144**（新浏览器件，带来路注释）。`build --check` ✓、依赖图 `--check` ✓、`--fast` **73/73**、控制字符与 U+FFFD 扫描 22 个改动文件 **0**。行为件七件全绿：playbooks（⑦ 全断言传动）、service-match.browser（新件 10 条）、i18n、i18n.static、facts.static、fixture-home.static、route-inventory.static。插曲：`playbooks.e2e.js` 首跑又现 ③ 登记过的启动竞争（① GET null `:128` 崩 TypeError），重跑连绿——同一老件既有脆性，与本刀零交集，不归功于也不归咎于本刀。

**全量回归（⑥）**：**352 pass / 0 fail / 1 flaky / 352 ran（7 skipped 为既有 live probe），真回归 0**。唯一 flaky 是 `scheduler-ui.browser.e2e.js` B1（schedule.changed 帧后口袋角标变 1，零轮询时序断言——②③④ 已登记同一条，本刀与该件文件零交集），回归内重跑自复绿，按既有时序族如实登记。
